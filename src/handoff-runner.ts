import { randomUUID } from "node:crypto";
import path from "node:path";
import * as l10n from "@vscode/l10n";
import type {
  HookCallback,
  SDKMessage,
  SDKUserMessage,
  forkSession as sdkForkSession,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import {
  acceptCompactSummary,
  COMPACT_INSTRUCTION,
  ENVELOPE_PREAMBLE,
} from "./handoff-accept";
import {
  buildHandoffEnvelopeV2,
  handoffUtteranceAt,
  parseCompactMetadata,
  parseHandoffEnvelope,
  type HandoffCompactStats,
  type HandoffEnvelopeV2,
  type HandoffUtterance,
  type HandoffWorkMemo,
} from "./handoff-envelope";
import type { TranscriptRetentionSettings } from "./transcript-retention";
import {
  createParseYielder,
  createRecordUuidFilter,
  extractHumanUserPrompt,
  extractVerbatim,
  isHandoffGenerationBoundary,
  verbatimTextOf,
} from "./session-transcript";
import { claudeProjectsDir } from "./claude-env";
import type { OrchestrationEffort } from "./orchestration-executors";
import { asObject, foldLegacyEntries, isStateFileId, type HandoffContextStore, type HandoffRegistry, type HandoffRegistryName, type LegacyMemento } from "./state-files";
import { errorCode } from "./transient-fs";

export { handoffRegistryFiles } from "./state-files";

export type ForkSessionFn = typeof sdkForkSession;
export type QueryFn = typeof sdkQuery;

export interface HandoffRecordsRead {
  records: Record<string, unknown>[];
  unreadableLineCount: number;
}

export async function parseHandoffRecords(text: string): Promise<HandoffRecordsRead> {
  const accept = createRecordUuidFilter();
  const records: Record<string, unknown>[] = [];
  const maybeYield = createParseYielder();
  let unreadableLineCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const pendingYield = maybeYield();
    if (pendingYield) await pendingYield;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLineCount++;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      unreadableLineCount++;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (!accept(record)) continue;
    records.push(record);
  }
  return { records, unreadableLineCount };
}

export type ForkFileLookup =
  | { path: string; reason?: null }
  | { path: null; reason: "not_found" | "scan_failed"; detail?: string };

export interface HandoffRunnerDeps {
  sdk: { forkSession: ForkSessionFn; query: QueryFn };
  cwd: string;
  claudeExecutablePath: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  effort?: OrchestrationEffort;
  settingSources?: Array<"user" | "project" | "local">;
  transcriptRetention?: TranscriptRetentionSettings;
  lookupSessionFileById: (id: string) => Promise<ForkFileLookup>;
  readRecords: (filePath: string) => Promise<HandoffRecordsRead>;
  fs: { unlink(p: string): Promise<void>; readFile(p: string): Promise<string> };
  writeDiagnostic?: (name: string, text: string) => Promise<string>;
  registry: HandoffRegistry;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs: number;
  log: (line: string) => void;
  onPhase?: (phase: HandoffPhase) => void;
  onProgress?: (info: HandoffProgress) => void;
  onForkCreated?: (forkSessionId: string) => void;
}

export interface HandoffProgress {
  phase: "compacting";
  heartbeats: number;
  elapsedMs: number;
  since: "compact_start" | "result";
}

export type HandoffFailReason =
  | "fork_failed"
  | "fork_path_unresolved"
  | "fork_path_scan_failed"
  | "verbatim_extract_failed"
  | "compact_timeout"
  | "compact_failed"
  | "hook_not_fired"
  | "compact_rejected_analysis"
  | "compact_rejected_structure"
  | "compact_rejected_length"
  | "envelope_append_failed"
  | "commit_failed"
  | "cancelled"
  | "source_busy"
  | "already_running"
  | "folder_missing"
  | "transcript_write_forbidden";

export type HandoffOutcome =
  | {
      ok: true;
      runId: string;
      forkSessionId: string;
      forkFilePath: string;
      compact?: HandoffCompactStats;
      detail?: HandoffDetail;
      utteranceCount: number;
      unreadableLineCount: number;
    }
  | { ok: false; runId: string; reason: HandoffFailReason; detail?: string; forkSessionId?: string };

export type HandoffPhase =
  | "forking"
  | "extracting"
  | "compacting"
  | "accepting"
  | "appending"
  | "finishing"
  | "done"
  | "failed";

interface PersistedHandoff {
  runId: string;
  sourceSessionId: string;
  forkSessionId: string;
  filePath: string;
  phase: string;
  owner: string;
  leaseUntil: number;
}

export const IN_FLIGHT_KEY = "laisora.handoffInFlight";
export const ORPHANS_KEY = "laisora.handoffOrphans";
const MAX_PERSISTED_HANDOFFS = 20;
const UNLINK_RETRY_DELAYS_MS = [100, 1_000, 3_000];
export const COMPACT_HEARTBEAT_GRACE_MS = 120_000;

export const HANDOFF_LEASE_MS = COMPACT_HEARTBEAT_GRACE_MS * 2;

export const HANDOFF_LEASE_RENEW_INTERVAL_MS = (HANDOFF_LEASE_MS - COMPACT_HEARTBEAT_GRACE_MS) / 2;

export function leaseRenewalDue(now: number, lastStoredRenewal: number): boolean {
  return now - lastStoredRenewal >= HANDOFF_LEASE_RENEW_INTERVAL_MS;
}

const HANDOFF_TITLE_MARK = "⇢";

export function handoffSourceBusy(source: { turnRunning: boolean; unsentSendCount: number }): boolean {
  return source.turnRunning || source.unsentSendCount > 0;
}

export function handoffForkTitle(sourceTitle: string): string {
  let rest = sourceTitle.trimStart();
  while (rest.startsWith(HANDOFF_TITLE_MARK)) rest = rest.slice(HANDOFF_TITLE_MARK.length).trimStart();
  return `${HANDOFF_TITLE_MARK} ${rest}`;
}

const OWNER_ID = randomUUID();

declare const __LAISORA_SDK_CLAUDE_CODE_VERSION__: string | undefined;
function expectedCliVersion(): string | undefined {
  return typeof __LAISORA_SDK_CLAUDE_CODE_VERSION__ === "string" ? __LAISORA_SDK_CLAUDE_CODE_VERSION__ : undefined;
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error("input stream is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const item = await this.next();
      if (item.done) return;
      yield item.value;
    }
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function persistedEntries(value: unknown): PersistedHandoff[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PersistedHandoff => {
    const record = asObject(entry);
    return (
      record !== undefined &&
      typeof record.runId === "string" &&
      typeof record.sourceSessionId === "string" &&
      typeof record.forkSessionId === "string" &&
      typeof record.filePath === "string" &&
      typeof record.phase === "string"
    );
  });
}

const localRunningForks = new Map<string, string>();
const settledOwnForks = new Set<string>();

export type HandoffForkState = "handing_off" | "stale" | "cleanup_failed";

export function handoffForkState(
  inFlight: unknown,
  orphans: unknown,
  sessionId: string,
  now: number,
  ownRunning: ReadonlyMap<string, string> = localRunningForks,
  ownOwner: string = OWNER_ID,
  settledOwn: ReadonlySet<string> = settledOwnForks
): HandoffForkState | undefined {
  if ([...ownRunning.values()].includes(sessionId)) return "handing_off";
  const flight = persistedEntries(inFlight).filter((entry) => entry.forkSessionId === sessionId && !(entry.owner === ownOwner && settledOwn.has(sessionId)));
  if (flight.some((entry) => typeof entry.leaseUntil === "number" && entry.leaseUntil > now)) return "handing_off";
  if (persistedEntries(orphans).some((entry) => entry.forkSessionId === sessionId)) return "cleanup_failed";
  return flight.length > 0 ? "stale" : undefined;
}

export function isHandoffForkHidden(state: HandoffForkState | undefined): boolean {
  return state === "handing_off" || state === "stale";
}

export interface HandoffSweepPlan {
  active: PersistedHandoff[];
  candidates: PersistedHandoff[];
}

export function handoffSweepPlan(inFlight: unknown, orphans: unknown, now: number): HandoffSweepPlan {
  const flight = persistedEntries(inFlight);
  const abandoned = persistedEntries(orphans);
  const abandonedPaths = new Set(abandoned.map((entry) => entry.filePath));
  const active = new Map<string, PersistedHandoff>();
  for (const entry of flight) {
    if (!abandonedPaths.has(entry.filePath) && entry.leaseUntil > now) active.set(entry.filePath, entry);
  }
  const candidates = [...new Map([...flight, ...abandoned].map((entry) => [entry.filePath, entry])).values()]
    .filter((entry) => !active.has(entry.filePath));
  return { active: [...active.values()], candidates };
}

export interface HandoffSweepSettlement {
  moveToOrphans: PersistedHandoff[];
  removeInFlight: PersistedHandoff[];
  removeOrphans: PersistedHandoff[];
}

export function handoffSweepSettlement(
  inFlight: unknown,
  orphans: unknown,
  resolvedPaths: ReadonlySet<string>,
  failedPaths: ReadonlySet<string>
): HandoffSweepSettlement {
  const flight = persistedEntries(inFlight);
  const abandoned = persistedEntries(orphans);
  const moveToOrphans = [...new Map(
    flight
      .filter((entry) => failedPaths.has(entry.filePath) && !abandoned.some((orphan) => orphan.filePath === entry.filePath))
      .map((entry) => [entry.filePath, entry])
  ).values()];
  return {
    moveToOrphans,
    removeInFlight: flight.filter((entry) => resolvedPaths.has(entry.filePath) || failedPaths.has(entry.filePath)),
    removeOrphans: abandoned.filter((entry) => resolvedPaths.has(entry.filePath)),
  };
}

export async function foldLegacyHandoffRegistries(
  legacy: LegacyMemento,
  registry: HandoffRegistry,
  log: (line: string) => void
): Promise<void> {
  for (const [key, name] of [[IN_FLIGHT_KEY, "inFlight"], [ORPHANS_KEY, "orphans"]] as const) {
    const stored = legacy.get(key);
    if (stored === undefined) continue;
    const listing = await registry.list(name);
    if (listing.unreadable) {
      log(`handoff registry ${key}: kept in globalState because the ${name} folder could not be read`);
      continue;
    }
    const present = new Map(persistedEntries(listing.entries).map((entry) => [entry.runId, entry]));
    const moving = persistedEntries(stored).filter((entry) => {
      if (!isStateFileId(entry.runId)) {
        log(`handoff registry ${key}: dropped an entry whose run id cannot name a file: ${entry.forkSessionId}`);
        return false;
      }
      const current = present.get(entry.runId);
      return current === undefined || entry.leaseUntil > current.leaseUntil;
    });
    await foldLegacyEntries(legacy, key, moving, (entry) => registry.put(name, entry), (entry, error) =>
      log(`handoff registry ${key}: an entry could not be moved to its file: ${entry.forkSessionId}: ${errorDetail(error)}`));
  }
}

export type HeldForkTabAction = "keep" | "reopen" | "drop";

export function heldForkTabAction(
  state: HandoffForkState | undefined,
  forkFile: "present" | "missing" | "unknown"
): HeldForkTabAction {
  if (state === "handing_off" || state === "stale") return "keep";
  if (state === "cleanup_failed") return "drop";
  if (forkFile === "present") return "reopen";
  return forkFile === "missing" ? "drop" : "keep";
}

export type HeldForkTabNotice = { notice: false } | { notice: true; state: HandoffForkState | undefined };

export function heldForkTabNotice(action: HeldForkTabAction, settled: HandoffForkState | undefined, held: HandoffForkState): HeldForkTabNotice {
  if (action === "reopen") return { notice: false };
  return { notice: true, state: action === "keep" ? settled ?? held : settled };
}

export type HeldForkTabEvent =
  | { kind: "opened" | "closed"; sessionId: string }
  | { kind: "settled"; sessionId: string; action: HeldForkTabAction };

export interface HeldForkTab<T> {
  tab: T;
  preceding: readonly string[];
  state: HandoffForkState;
}

export function holdForkTab<T extends { sessionId: string }>(
  held: readonly HeldForkTab<T>[],
  tab: T,
  preceding: readonly string[],
  state: HandoffForkState
): HeldForkTab<T>[] {
  const existing = held.find((h) => h.tab.sessionId === tab.sessionId);
  return [...held.filter((h) => h !== existing), { tab, preceding: existing?.preceding ?? preceding, state }];
}

export function releaseHeldForkTab<T extends { sessionId: string }>(
  held: readonly HeldForkTab<T>[],
  event: HeldForkTabEvent
): HeldForkTab<T>[] {
  if (event.kind === "settled" && event.action !== "drop") return [...held];
  return held.filter((h) => h.tab.sessionId !== event.sessionId);
}

export function heldTabInsertIndex(liveIds: readonly (string | undefined)[], preceding: readonly string[]): number {
  let index = 0;
  liveIds.forEach((id, at) => { if (id !== undefined && preceding.includes(id)) index = at + 1; });
  return index;
}

export function withHeldForkTabs<T extends { sessionId: string; order: number }>(
  live: readonly T[],
  held: readonly HeldForkTab<T>[]
): T[] {
  const merged = [...live];
  for (const h of [...held].sort((a, b) => a.tab.order - b.tab.order)) {
    if (merged.some((tab) => tab.sessionId === h.tab.sessionId)) continue;
    merged.splice(heldTabInsertIndex(merged.map((tab) => tab.sessionId), h.preceding), 0, h.tab);
  }
  return merged.map((tab, order) => ({ ...tab, order }));
}

function isWithinProjects(filePath: string, projectsRoot: string): boolean {
  const relative = path.relative(path.resolve(projectsRoot), path.resolve(filePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function lastCompactBoundaryIndex(records: readonly Record<string, unknown>[]): number {
  let lastBoundary = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].type === "system" && records[i].subtype === "compact_boundary") lastBoundary = i;
  }
  return lastBoundary;
}

function compactSummariesAfter(
  records: readonly Record<string, unknown>[],
  lastBoundary: number
): Record<string, unknown>[] {
  return records.filter(
    (record, index) => index > lastBoundary && record.type === "user" && record.isCompactSummary === true
  );
}

function preservedResponseIds(
  records: readonly Record<string, unknown>[],
  boundaryIndex: number
): Set<string> | undefined {
  if (boundaryIndex < 0) return undefined;
  const metadata = asObject(records[boundaryIndex].compactMetadata);
  const preserved = asObject(metadata?.preservedMessages);
  if (!Array.isArray(preserved?.uuids) || !preserved.uuids.every((id) => typeof id === "string")) return undefined;
  const byUuid = new Map(records.map((record) => [record.uuid, record]));
  const ids = new Set<string>();
  for (const uuid of preserved.uuids as string[]) {
    const record = byUuid.get(uuid);
    if (record === undefined) return undefined;
    if (record?.type !== "assistant") continue;
    const id = asObject(record.message)?.id;
    if (typeof id !== "string" || id.length === 0) return undefined;
    ids.add(id);
  }
  return ids;
}

function forkIncompleteReason(
  records: readonly Record<string, unknown>[],
  forkSessionId: string
): string | undefined {
  const lastBoundary = lastCompactBoundaryIndex(records);
  if (lastBoundary < 0) return `no_boundary(records=${records.length})`;

  const summaries = compactSummariesAfter(records, lastBoundary);
  if (summaries.length !== 1) return `summary=${summaries.length}`;
  const accepted = acceptCompactSummary(verbatimTextOf(summaries[0]));
  if (!accepted.ok) return `summary_rejected=${accepted.reason ?? "unknown"}`;

  const envelopes = records
    .filter((record, index) => index > lastBoundary && record.type === "user")
    .map((record) => parseHandoffEnvelope(verbatimTextOf(record)))
    .filter((parsed) => parsed.ok && parsed.version === "2");
  if (envelopes.length !== 1) return `envelope=${envelopes.length}`;
  const only = envelopes[0];
  if (!only.ok || only.version !== "2") return "envelope_unparsed";
  if (only.envelope.snapshot.forkSessionId !== forkSessionId) return "envelope_fork_mismatch";
  return undefined;
}

export function forkHasUserTurns(records: readonly Record<string, unknown>[]): boolean {
  return records.some((record) => asObject(record.forkedFrom) === undefined && extractHumanUserPrompt(record) !== null);
}

export interface HandoffDetail {
  summary?: string;
  utterances: HandoffUtterance[];
}

export function extractHandoffDetail(
  records: readonly Record<string, unknown>[],
  forkSessionId: string
): HandoffDetail | undefined {
  let pendingSummary: string | undefined;
  let summary: string | undefined;
  let envelope: HandoffEnvelopeV2 | undefined;
  for (const record of records) {
    if (record.type === "user" && record.isCompactSummary === true) {
      pendingSummary = verbatimTextOf(record);
      continue;
    }
    if (!isHandoffGenerationBoundary(record, forkSessionId)) continue;
    const parsed = parseHandoffEnvelope(verbatimTextOf(record));
    if (!parsed.ok || parsed.version !== "2") continue;
    envelope = parsed.envelope;
    summary = pendingSummary;
  }
  if (envelope === undefined) return undefined;
  return {
    ...(summary !== undefined ? { summary } : {}),
    utterances: envelope.userUtterances,
  };
}

export const HANDOFF_DETAIL_MAX_BYTES = 200_000;

const SUMMARY_KEY_BYTES = 11;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface HandoffDetailPart {
  summary?: string;
  utterances: HandoffUtterance[];
}

export function buildHandoffDetailParts(
  summary: string | undefined,
  utterances: readonly HandoffUtterance[],
  budgetBytes: number
): HandoffDetailPart[] {
  const parts: HandoffDetailPart[] = [
    { ...(summary !== undefined ? { summary } : {}), utterances: [] },
  ];
  let used = summary === undefined ? 0 : jsonBytes(summary) + SUMMARY_KEY_BYTES;
  for (const utterance of utterances) {
    const current = parts[parts.length - 1];
    const cost = jsonBytes(utterance) + (current.utterances.length === 0 ? 0 : 1);
    const canSplit = current.utterances.length > 0 || current.summary !== undefined;
    if (canSplit && used + cost > budgetBytes) {
      parts.push({ utterances: [utterance] });
      used = jsonBytes(utterance);
      continue;
    }
    current.utterances.push(utterance);
    used += cost;
  }
  return parts;
}

export function shouldActivateForkTab(activeTabId: string | undefined, sourceTabId: string): boolean {
  return activeTabId !== undefined && activeTabId === sourceTabId;
}

export function forkTabActivationTargets<W>(input: {
  auto: boolean;
  sender: W | null;
  surfaces: ReadonlyArray<{ surface: W; activeTabId: string | undefined }>;
  sourceTabId: string;
}): W[] {
  return input.surfaces
    .filter((s) => (input.auto || s.surface === input.sender) && shouldActivateForkTab(s.activeTabId, input.sourceTabId))
    .map((s) => s.surface);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HandoffRunner {
  private readonly deps: HandoffRunnerDeps;
  private started = false;
  private phase: HandoffPhase = "forking";
  private terminal: HandoffFailReason | "done" | undefined;
  private terminalDetail: string | undefined;
  private abortController: AbortController | undefined;
  private inputQueue: InputQueue | undefined;
  private leaseStampedAt = 0;
  private renewal: Promise<void> | undefined;
  private leaseLost = false;

  constructor(deps: HandoffRunnerDeps) {
    this.deps = deps;
  }

  private transition(phase: HandoffPhase): void {
    if (this.terminal !== undefined) {
      this.deps.log(`handoff late phase ignored: ${phase}`);
      return;
    }
    this.phase = phase;
    this.deps.log(`handoff phase: ${phase}`);
    this.deps.onPhase?.(phase);
  }

  private commitTerminal(terminal: HandoffFailReason | "done", detail?: string): boolean {
    if (this.terminal !== undefined) {
      this.deps.log(`handoff late terminal ignored: ${terminal}; current=${this.terminal}`);
      return false;
    }
    this.terminal = terminal;
    this.terminalDetail = detail;
    this.phase = terminal === "done" ? "done" : "failed";
    this.deps.log(`handoff terminal: ${terminal}${detail === undefined ? "" : ` (${detail})`}`);
    return true;
  }

  cancel(): boolean {
    return this.started && this.stop("cancelled");
  }

  private stop(reason: HandoffFailReason, detail?: string): boolean {
    if (!this.commitTerminal(reason, detail)) return false;
    this.inputQueue?.close();
    this.abortController?.abort();
    this.closeQuery();
    return true;
  }

  private query: { close?: () => void } | undefined;

  private closeQuery(): void {
    try {
      this.query?.close?.();
    } catch (error) {
      this.deps.log(`handoff query close failed: ${errorDetail(error)}`);
    }
  }

  private async compactRound(
    runId: string,
    forkSessionId: string,
    registryEntry: PersistedHandoff
  ): Promise<{ streamCompact?: HandoffCompactStats }> {
    if (this.terminal !== undefined) return {};
    const queue = new InputQueue();
    const abortController = new AbortController();
    this.inputQueue = queue;
    this.abortController = abortController;
    queue.push({
      type: "user",
      message: { role: "user", content: `/compact ${COMPACT_INSTRUCTION.text}` },
      parent_tool_use_id: null,
      session_id: forkSessionId,
    });
    let hookCount = 0;
    let streamCompact: HandoffCompactStats | undefined;
    let completedBy: "hook" | "status" | "boundary" | undefined;
    let resultSuccess = false;
    let compactingHeartbeats = 0;
    const compactStartedAt = this.deps.now();
    let resultAt: number | undefined;
    let lastHeartbeatAt: number | undefined;
    let cliVersion: string | undefined;
    const abortRun = (): void => {
      queue.close();
      abortController.abort();
      this.closeQuery();
    };
    const seconds = (from: number | undefined): string => {
      if (from === undefined) return l10n.t("none");
      const total = Math.round((this.deps.now() - from) / 1000);
      return total < 60 ? l10n.t("{0}s", total) : l10n.t("{0}m {1}s", Math.floor(total / 60), total % 60);
    };
    const waitDetail = (): string => l10n.t(
      "{0} since last response, {1} since summary started, {2} responses, {3}",
      seconds(lastHeartbeatAt), seconds(resultAt), compactingHeartbeats,
      l10n.t("CLI {0} / SDK expected {1}", cliVersion ?? l10n.t("unknown"), expectedCliVersion() ?? l10n.t("unknown"))
    );
    const complete = (by: "hook" | "status" | "boundary"): void => {
      if (completedBy !== undefined) return;
      completedBy = by;
      queue.close();
      if (by !== "hook") this.deps.log(`handoff compact completed by stream ${by} without PostCompact`);
    };
    const onPostCompact: HookCallback = async (hookInput) => {
      if (this.terminal !== undefined) {
        this.deps.log("handoff late PostCompact ignored");
        return {};
      }
      if (hookInput.hook_event_name !== "PostCompact") return {};
      hookCount++;
      if (hookCount !== 1) {
        if (this.commitTerminal("commit_failed", "PostCompact fired more than once")) abortRun();
        return {};
      }
      if (completedBy !== undefined && completedBy !== "hook") {
        this.deps.log(`handoff PostCompact arrived after stream ${completedBy}; accepting before round drain`);
      }
      this.transition("accepting");
      const accepted = acceptCompactSummary(hookInput.compact_summary);
      if (!accepted.ok) {
        this.deps.log(`handoff compact rejected: headings=${accepted.headings.length} body=${accepted.body.length} chars`);
        void this.deps.writeDiagnostic?.(`${runId}-compact-rejected.txt`, hookInput.compact_summary)
          .then((p) => this.deps.log(`handoff compact raw saved: ${p}`))
          .catch((e) => this.deps.log(`handoff compact raw save failed: ${errorDetail(e)}`));
        if (this.commitTerminal(accepted.reason)) abortRun();
        return {};
      }
      complete("hook");
      return {};
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        if (this.commitTerminal("compact_timeout", waitDetail())) abortRun();
      }, this.deps.timeoutMs);
    };
    armTimeout();
    try {
      const query = this.deps.sdk.query({
        prompt: queue,
        options: {
          cwd: this.deps.cwd,
          resume: forkSessionId,
          ...(this.deps.model ? { model: this.deps.model } : {}),
          ...(this.deps.effort ? { effort: this.deps.effort } : {}),
          settingSources: this.deps.settingSources,
          ...(this.deps.transcriptRetention ? { settings: this.deps.transcriptRetention } : {}),
          permissionMode: "default",
          pathToClaudeCodeExecutable: this.deps.claudeExecutablePath,
          env: this.deps.env,
          abortController,
          canUseTool: async () => ({ behavior: "deny", message: "Handoff compaction does not allow tools" }),
          hooks: { PostCompact: [{ hooks: [onPostCompact] }] },
        },
      });
      this.query = query as unknown as { close?: () => void };
      for await (const message of query as AsyncIterable<SDKMessage>) {
        armTimeout();
        this.renewLeaseIfDue(registryEntry);
        const record = message as unknown as Record<string, unknown>;
        const isStatus = record.type === "system" && record.subtype === "status";
        if (this.terminal !== undefined) {
          const statusDetail = isStatus
            ? ` status=${String(record.status ?? "")} compact_result=${String(record.compact_result ?? "")} compact_error=${String(record.compact_error ?? "")}`
            : "";
          this.deps.log(`handoff late stream message ignored: ${String(record.type)}/${String(record.subtype ?? "")}${statusDetail}`);
          continue;
        }
        if (record.type === "system" && record.subtype === "init" && typeof record.claude_code_version === "string") {
          cliVersion = record.claude_code_version;
        }
        if (isStatus && record.compact_result === "failed") {
          const why = typeof record.compact_error === "string" && record.compact_error.length > 0
            ? record.compact_error : l10n.t("No reason given");
          if (this.commitTerminal("compact_failed", why)) abortRun();
          continue;
        }
        if (isStatus && record.compact_result === "success") {
          complete("status");
          continue;
        }
        if (isStatus && record.status === "compacting") {
          compactingHeartbeats++;
          lastHeartbeatAt = this.deps.now();
          const since = resultAt === undefined ? "compact_start" : "result";
          const elapsedMs = lastHeartbeatAt - (resultAt ?? compactStartedAt);
          this.deps.log(`handoff compacting: heartbeat #${compactingHeartbeats}, ${Math.round(elapsedMs / 1000)}s since ${since === "result" ? "result" : "start"}`);
          this.deps.onProgress?.({ phase: "compacting", heartbeats: compactingHeartbeats, elapsedMs, since });
          continue;
        }
        if (record.type === "system" && record.subtype === "compact_boundary") {
          const metadata = asObject(record.compact_metadata);
          streamCompact = parseCompactMetadata({ preTokens: metadata?.pre_tokens, postTokens: metadata?.post_tokens });
          complete("boundary");
        }
        if (record.type === "result") {
          resultAt ??= this.deps.now();
          if (record.subtype === "success") resultSuccess = true;
          else if (this.commitTerminal(completedBy === undefined ? "compact_failed" : "commit_failed",
            `result subtype=${String(record.subtype)}`)) abortRun();
          if (completedBy === undefined && record.subtype === "success")
            this.deps.log("handoff result before compact completion; waiting for status/boundary/hook");
        }
      }
    } catch (error) {
      if (this.terminal === undefined) this.commitTerminal("compact_failed", errorDetail(error));
      else this.deps.log(`handoff late iterator error ignored: ${errorDetail(error)}`);
    } finally {
      clearTimeout(timer);
      queue.close();
      if (this.inputQueue === queue) this.inputQueue = undefined;
      if (this.abortController === abortController) this.abortController = undefined;
      this.query = undefined;
    }
    if (this.terminal === undefined && completedBy === undefined) {
      this.commitTerminal("hook_not_fired", l10n.t("No compact signal until stream end (result={0}), {1}",
        resultSuccess ? "success" : "none", waitDetail()));
    }
    if (this.terminal === undefined && !resultSuccess) this.commitTerminal("compact_failed", "result=none");
    return { streamCompact };
  }

  private async appendEnvelopeOnly(
    forkSessionId: string,
    envelope: HandoffEnvelopeV2,
    registryEntry: PersistedHandoff
  ): Promise<void> {
    if (this.terminal !== undefined) return;
    const queue = new InputQueue();
    const abortController = new AbortController();
    this.inputQueue = queue;
    this.abortController = abortController;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        if (this.commitTerminal("envelope_append_failed", "append timed out")) {
          abortController.abort();
          this.closeQuery();
        }
      }, this.deps.timeoutMs);
    };
    try {
      queue.push({
        type: "user",
        message: { role: "user", content: buildHandoffEnvelopeV2(envelope) },
        parent_tool_use_id: null,
        session_id: forkSessionId,
        shouldQuery: false,
      });
      queue.close();
      this.transition("finishing");
      const query = this.deps.sdk.query({
        prompt: queue,
        options: {
          cwd: this.deps.cwd,
          resume: forkSessionId,
          ...(this.deps.model ? { model: this.deps.model } : {}),
          ...(this.deps.effort ? { effort: this.deps.effort } : {}),
          settingSources: this.deps.settingSources,
          ...(this.deps.transcriptRetention ? { settings: this.deps.transcriptRetention } : {}),
          permissionMode: "default",
          pathToClaudeCodeExecutable: this.deps.claudeExecutablePath,
          env: this.deps.env,
          abortController,
          canUseTool: async () => ({ behavior: "deny", message: "Handoff envelope append does not allow tools" }),
        },
      });
      this.query = query as unknown as { close?: () => void };
      let resultSuccess = false;
      armTimeout();
      for await (const message of query as AsyncIterable<SDKMessage>) {
        armTimeout();
        this.renewLeaseIfDue(registryEntry);
        if (this.terminal !== undefined) continue;
        if (message.type !== "result") continue;
        if (message.subtype === "success") resultSuccess = true;
        else if (this.commitTerminal("envelope_append_failed", `result subtype=${message.subtype}`)) {
          abortController.abort();
          this.closeQuery();
        }
      }
      if (this.terminal === undefined && !resultSuccess) this.commitTerminal("envelope_append_failed", "result=none");
    } catch (error) {
      if (this.terminal === undefined) this.commitTerminal("envelope_append_failed", errorDetail(error));
    } finally {
      clearTimeout(timer);
      queue.close();
      if (this.inputQueue === queue) this.inputQueue = undefined;
      if (this.abortController === abortController) this.abortController = undefined;
      this.query = undefined;
    }
  }

  async run(input: {
    sourceSessionId: string;
    sourceTitle: string;
    runId: string;
    sourceBusy: () => boolean;
    workMemo?: HandoffWorkMemo;
  }): Promise<HandoffOutcome> {
    if (this.started) return { ok: false, runId: input.runId, reason: "already_running" };
    this.started = true;
    if (input.sourceBusy()) {
      this.commitTerminal("source_busy");
      return { ok: false, runId: input.runId, reason: "source_busy" };
    }

    let forkSessionId: string | undefined;
    let forkFilePath: string | undefined;
    let registryEntry: PersistedHandoff | undefined;
    let utteranceCount = 0;
    let unreadableLineCount = 0;
    let compact: HandoffCompactStats | undefined;
    let commitRecords: Record<string, unknown>[] | undefined;
    let detail: HandoffDetail | undefined;
    const entryFor = (forkId: string, filePath: string): PersistedHandoff => ({
      runId: input.runId,
      sourceSessionId: input.sourceSessionId,
      forkSessionId: forkId,
      filePath,
      phase: "forking",
      owner: OWNER_ID,
      leaseUntil: this.deps.now() + HANDOFF_LEASE_MS,
    });

    try {
      this.transition("forking");
      try {
        const fork = await this.deps.sdk.forkSession(input.sourceSessionId, {
          title: handoffForkTitle(input.sourceTitle),
        });
        forkSessionId = fork.sessionId;
      } catch (error) {
        this.commitTerminal("fork_failed", errorDetail(error));
      }
      if (forkSessionId !== undefined) {
        try {
          this.deps.onForkCreated?.(forkSessionId);
        } catch (error) {
          this.deps.log(`handoff fork callback failed: ${errorDetail(error)}`);
        }
      }

      if (forkSessionId !== undefined) {
        let lookup: ForkFileLookup | undefined;
        try {
          lookup = await this.deps.lookupSessionFileById(forkSessionId);
        } catch (error) {
          if (this.terminal === undefined) this.commitTerminal("fork_path_unresolved", errorDetail(error));
          else this.deps.log(`handoff cancelled fork path lookup failed: ${errorDetail(error)}`);
        }
        if (lookup?.path != null) forkFilePath = lookup.path;
        else if (lookup !== undefined && this.terminal === undefined) {
          if (lookup.reason === "scan_failed") {
            this.deps.log(`handoff fork path scan failed: ${lookup.detail ?? "(no detail)"}`);
            this.commitTerminal("fork_path_scan_failed");
          } else {
            this.commitTerminal("fork_path_unresolved");
          }
        }
      }

      if (forkSessionId !== undefined && forkFilePath !== undefined) {
        registryEntry = entryFor(forkSessionId, forkFilePath);
        localRunningForks.set(forkFilePath, forkSessionId);
        await this.addRegistryEntry("inFlight", registryEntry);
        this.leaseStampedAt = registryEntry.leaseUntil - HANDOFF_LEASE_MS;

        if (this.terminal === undefined) {
          this.transition("extracting");
          try {
          const read = await this.deps.readRecords(forkFilePath);
          unreadableLineCount = read.unreadableLineCount;
          const { utterances, carriedCount, carriedFrom } = extractVerbatim(read.records);
          utteranceCount = utterances.length;
          if (carriedFrom[0]?.workMemoDropped) this.deps.log("handoff previous work memo dropped: envelope workMemo failed validation");
          if (carriedFrom.some((envelope) => envelope.imageRefsDropped)) this.deps.log("handoff previous image refs dropped: some carried image references failed validation");
          if (carriedFrom.length > 0) {
            this.deps.log(`handoff carried utterances: ${carriedCount} of ${utterances.length}`);
          }

          if (this.terminal !== undefined) return this.failureOutcome(input.runId, forkSessionId);
          let currentRecords = read.records;
          let retainedResponseCount: number | undefined;

          if (this.terminal === undefined) {
            this.transition("compacting");
            const priorBoundary = lastCompactBoundaryIndex(currentRecords);
            const roundResult = await this.compactRound(input.runId, forkSessionId, registryEntry);
            if (this.terminal === undefined) {
              const roundRead = await this.deps.readRecords(forkFilePath);
              unreadableLineCount = Math.max(unreadableLineCount, roundRead.unreadableLineCount);
              currentRecords = roundRead.records;
              const boundaryIndex = lastCompactBoundaryIndex(currentRecords);
              if (boundaryIndex <= priorBoundary) {
                this.commitTerminal("commit_failed", "compact: no new boundary");
              } else {
                const summaries = compactSummariesAfter(currentRecords, boundaryIndex);
                if (summaries.length !== 1) {
                  this.commitTerminal("commit_failed", `compact: summary=${summaries.length}`);
                } else {
                  const persistedSummary = verbatimTextOf(summaries[0]);
                  const accepted = acceptCompactSummary(persistedSummary);
                  if (!accepted.ok) {
                    void this.deps.writeDiagnostic?.(`${input.runId}-compact-rejected.txt`, persistedSummary)
                      .then((p) => this.deps.log(`handoff compact raw saved: ${p}`))
                      .catch((e) => this.deps.log(`handoff compact raw save failed: ${errorDetail(e)}`));
                    this.commitTerminal(accepted.reason);
                  } else {
                    const boundaryMetadata = asObject(currentRecords[boundaryIndex].compactMetadata);
                    const fromJsonl = parseCompactMetadata({ preTokens: boundaryMetadata?.preTokens, postTokens: boundaryMetadata?.postTokens });
                    compact = roundResult.streamCompact ?? fromJsonl;
                    const responseIds = preservedResponseIds(currentRecords, boundaryIndex);
                    if (responseIds === undefined) this.deps.log("handoff compact: preserved response IDs unavailable");
                    else if (responseIds.size > 1) retainedResponseCount = responseIds.size;
                  }
                }
              }
            }
          }

          if (this.terminal === undefined && input.sourceBusy()) this.commitTerminal("source_busy");
          if (this.terminal === undefined) {
            if (retainedResponseCount !== undefined) compact = { ...compact, retainedResponseCount };
            this.transition("appending");
            const envelope: HandoffEnvelopeV2 = {
              schema: "hb2",
              preamble: ENVELOPE_PREAMBLE,
              snapshot: {
                sourceSessionId: input.sourceSessionId,
                forkSessionId,
                capturedAt: new Date(this.deps.now()).toISOString(),
                ...(compact !== undefined ? { compact } : {}),
              },
              userUtterances: utterances.map((utterance) => ({ ...utterance, at: handoffUtteranceAt(utterance.at) })),
              ...(input.workMemo !== undefined ? { workMemo: input.workMemo } : {}),
            };
            if (this.terminal === undefined) await this.appendEnvelopeOnly(forkSessionId, envelope, registryEntry);
          }

          if (this.terminal === undefined) {
            const commitRead = await this.deps.readRecords(forkFilePath);
            commitRecords = commitRead.records;
            unreadableLineCount = Math.max(unreadableLineCount, commitRead.unreadableLineCount);
            const incomplete = forkIncompleteReason(commitRecords, forkSessionId);
            if (incomplete !== undefined) this.commitTerminal("commit_failed", `fork=${incomplete}`);
            else {
              detail = extractHandoffDetail(commitRecords, forkSessionId);
              this.commitTerminal("done");
            }
          }
          } catch (error) {
            if (this.terminal === undefined) {
              this.commitTerminal(
                this.phase === "extracting" ? "verbatim_extract_failed" : "commit_failed",
                errorDetail(error)
              );
            }
          }
        }
      }
    } catch (error) {
      if (this.terminal === undefined) {
        const reason: HandoffFailReason =
          this.phase === "forking"
            ? "fork_failed"
            : this.phase === "extracting"
              ? "verbatim_extract_failed"
              : "commit_failed";
        this.commitTerminal(reason, errorDetail(error));
      }
    } finally {
      if (this.terminal !== "done") this.abortController?.abort();
      if (forkSessionId !== undefined && forkFilePath === undefined) {
        const found = await this.findUnresolvedFork(forkSessionId);
        if (found !== undefined) {
          forkFilePath = found;
          registryEntry = entryFor(forkSessionId, found);
        }
      }
      if (registryEntry !== undefined) {
        try {
          await this.renewal;
          const settled = !this.leaseLost && (this.terminal === "done" || forkFilePath === undefined || await this.deleteFailedFork(registryEntry));
          if (settled) {
            settledOwnForks.add(registryEntry.forkSessionId);
            try {
              await this.deps.registry.remove("inFlight", registryEntry.runId);
            } catch (error) {
              this.deps.log(`handoff in-flight entry could not be removed: ${registryEntry.forkSessionId}: ${errorDetail(error)}`);
            }
          }
        } finally {
          localRunningForks.delete(registryEntry.filePath);
        }
      }
    }

    if (this.terminal === "done" && forkSessionId !== undefined && forkFilePath !== undefined) {
      return {
        ok: true,
        runId: input.runId,
        forkSessionId,
        forkFilePath,
        ...(compact !== undefined ? { compact } : {}),
        ...(detail !== undefined ? { detail } : {}),
        utteranceCount,
        unreadableLineCount,
      };
    }
    return this.failureOutcome(input.runId, forkSessionId);
  }

  private failureOutcome(runId: string, forkSessionId?: string): HandoffOutcome {
    const reason = this.terminal === undefined || this.terminal === "done" ? "compact_failed" : this.terminal;
    return {
      ok: false,
      runId,
      reason,
      ...(this.terminalDetail !== undefined ? { detail: this.terminalDetail } : {}),
      ...(forkSessionId !== undefined ? { forkSessionId } : {}),
    };
  }

  private async addRegistryEntry(name: HandoffRegistryName, entry: PersistedHandoff): Promise<void> {
    await this.deps.registry.put(name, entry);
    const count = await this.deps.registry.count(name).catch(() => undefined);
    if (count !== undefined && count > MAX_PERSISTED_HANDOFFS) {
      this.deps.log(`handoff registry ${name} holds ${count} entries; keeping all of them`);
    }
  }

  private renewLeaseIfDue(entry: PersistedHandoff): void {
    if (this.terminal !== undefined || this.renewal !== undefined) return;
    const now = this.deps.now();
    if (!leaseRenewalDue(now, this.leaseStampedAt)) return;
    this.renewal = this.renewLease(entry, now).finally(() => {
      this.renewal = undefined;
    });
  }

  private async renewLease(entry: PersistedHandoff, now: number): Promise<void> {
    try {
      if (!(await this.deps.registry.has("inFlight", entry.runId))) {
        this.leaseLost = true;
        const stopped = this.stop("commit_failed", "the handoff registration was removed by another window");
        this.deps.log(`handoff lease lost${stopped ? "" : " after the run ended"}: the in-flight entry was removed by another window, which settles the copy: ${entry.forkSessionId}`);
        return;
      }
      const renewed: PersistedHandoff = { ...entry, leaseUntil: now + HANDOFF_LEASE_MS };
      await this.deps.registry.put("inFlight", renewed);
      this.leaseStampedAt = now;
    } catch (error) {
      this.deps.log(`handoff lease renewal failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
    }
  }

  private async findUnresolvedFork(forkSessionId: string): Promise<string | undefined> {
    for (const delay of UNLINK_RETRY_DELAYS_MS) {
      await (this.deps.sleep ?? sleep)(delay);
      try {
        const lookup = await this.deps.lookupSessionFileById(forkSessionId);
        if (lookup.path != null) return lookup.path;
      } catch (error) {
        this.deps.log(`handoff fork path lookup retry failed: ${forkSessionId}: ${errorDetail(error)}`);
      }
    }
    this.deps.log(`handoff fork left without a path: ${forkSessionId}`);
    return undefined;
  }

  private async deleteFailedFork(entry: PersistedHandoff): Promise<boolean> {
    const projectsRoot = path.resolve(claudeProjectsDir());
    if (!isWithinProjects(entry.filePath, projectsRoot)) {
      this.deps.log(`handoff orphan outside projects root: ${entry.forkSessionId}`);
      return await this.recordOrphan(entry);
    }
    for (const delay of UNLINK_RETRY_DELAYS_MS) {
      await (this.deps.sleep ?? sleep)(delay);
      try {
        await this.deps.fs.unlink(entry.filePath);
        return true;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return true;
        this.deps.log(`handoff unlink failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    }
    return await this.recordOrphan(entry);
  }

  private async recordOrphan(entry: PersistedHandoff): Promise<boolean> {
    try {
      await this.addRegistryEntry("orphans", entry);
      return true;
    } catch (error) {
      this.deps.log(`handoff orphan could not be recorded; the in-flight entry stays for the startup sweep: ${entry.forkSessionId}: ${errorDetail(error)}`);
      return false;
    }
  }

  static async sweepOrphans(
    deps: Pick<HandoffRunnerDeps, "fs" | "registry" | "readRecords" | "log"> & {
      contextUsage: Pick<HandoffContextStore, "remove">;
      now?: () => number;
    },
    projectsRoot: string
  ): Promise<{ deleted: string[]; kept: string[]; failed: string[]; active: string[] }> {
    const now = deps.now?.() ?? Date.now();
    const [inFlightListing, orphansListing] = [await deps.registry.list("inFlight"), await deps.registry.list("orphans")];
    const malformed = inFlightListing.malformed + orphansListing.malformed;
    if (malformed > 0) deps.log(`handoff sweep ignored ${malformed} registry file(s) that are not valid entries`);
    if (inFlightListing.unreadable || orphansListing.unreadable) {
      deps.log("handoff sweep skipped: a registry folder or file could not be read");
      return { deleted: [], kept: [], failed: [], active: [] };
    }
    const inFlight = inFlightListing.entries;
    const orphans = orphansListing.entries;
    const { active, candidates } = handoffSweepPlan(inFlight, orphans, now);
    for (const entry of active) {
      deps.log(`handoff sweep skipped live handoff: ${entry.forkSessionId} owner=${entry.owner} lease=${entry.leaseUntil - now}ms`);
    }

    const deleted: string[] = [];
    const kept: string[] = [];
    const failed: string[] = [];
    const removeContextSnapshot = async (entry: PersistedHandoff): Promise<void> => {
      if (entry.forkSessionId === "") return;
      try {
        await deps.contextUsage.remove(entry.forkSessionId);
      } catch (error) {
        deps.log(`handoff orphan context snapshot removal failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    };

    for (const entry of candidates) {
      try {
        await deps.fs.readFile(entry.filePath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          deleted.push(entry.filePath);
          await removeContextSnapshot(entry);
          continue;
        }
        failed.push(entry.filePath);
        deps.log(`handoff orphan read failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
        continue;
      }

      let records: readonly Record<string, unknown>[] | undefined;
      try {
        records = (await deps.readRecords(entry.filePath)).records;
      } catch (error) {
        deps.log(`handoff orphan parse failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
      if (records !== undefined && forkIncompleteReason(records, entry.forkSessionId) === undefined) {
        kept.push(entry.filePath);
        continue;
      }
      if (records !== undefined && forkHasUserTurns(records)) {
        kept.push(entry.filePath);
        deps.log(`handoff orphan kept: the copy has turns the user wrote after the fork: ${entry.forkSessionId}`);
        continue;
      }
      if (!isWithinProjects(entry.filePath, projectsRoot)) {
        failed.push(entry.filePath);
        deps.log(`handoff orphan outside projects root: ${entry.forkSessionId}`);
        continue;
      }
      try {
        await deps.fs.unlink(entry.filePath);
        deleted.push(entry.filePath);
        await removeContextSnapshot(entry);
      } catch (error) {
        failed.push(entry.filePath);
        deps.log(`handoff orphan unlink failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    }

    const settlement = handoffSweepSettlement(inFlight, orphans, new Set([...deleted, ...kept]), new Set(failed));
    const unmoved = new Set<string>();
    for (const entry of settlement.moveToOrphans) {
      try {
        await deps.registry.put("orphans", entry);
      } catch (error) {
        unmoved.add(entry.filePath);
        deps.log(`handoff orphan could not be recorded; the in-flight entry stays: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    }
    const removeEntry = async (name: HandoffRegistryName, entry: PersistedHandoff): Promise<void> => {
      try {
        await deps.registry.remove(name, entry.runId);
      } catch (error) {
        deps.log(`handoff ${name} entry could not be removed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    };
    for (const entry of settlement.removeInFlight) if (!unmoved.has(entry.filePath)) await removeEntry("inFlight", entry);
    for (const entry of settlement.removeOrphans) await removeEntry("orphans", entry);
    return { deleted, kept, failed, active: active.map((entry) => entry.filePath) };
  }
}
