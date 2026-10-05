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
  DECISIONS_PREAMBLE,
  ENVELOPE_PREAMBLE,
  extractDecisionLines,
  type ExtractedDecisionLine,
} from "./handoff-accept";
import {
  buildHandoffEnvelopeV2,
  parseCompactMetadata,
  parseHandoffEnvelope,
  type HandoffCompactStats,
  type HandoffDecisionEntry,
  type HandoffDecisions,
  type HandoffEnvelopeV2,
  type HandoffUtterance,
} from "./handoff-envelope";
import {
  createParseYielder,
  createRecordUuidFilter,
  extractVerbatimUserUtterances,
  isHandoffGenerationBoundary,
} from "./session-transcript";
import { claudeProjectsDir } from "./claude-env";

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
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  settingSources?: Array<"user" | "project" | "local">;
  lookupSessionFileById: (id: string) => Promise<ForkFileLookup>;
  readRecords: (filePath: string) => Promise<HandoffRecordsRead>;
  fs: { unlink(p: string): Promise<void>; readFile(p: string): Promise<string> };
  writeDiagnostic?: (name: string, text: string) => Promise<string>;
  persist: { get(k: string): unknown; update(k: string, v: unknown): Promise<void> };
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
  | "already_running";

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromRecord(record: Record<string, unknown>): string {
  const content = asRecord(record.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const value = asRecord(block);
      return value?.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("");
}

function persistedEntries(value: unknown): PersistedHandoff[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PersistedHandoff => {
    const record = asRecord(entry);
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
  const metadata = asRecord(records[boundaryIndex].compactMetadata);
  const preserved = asRecord(metadata?.preservedMessages);
  if (!Array.isArray(preserved?.uuids) || !preserved.uuids.every((id) => typeof id === "string")) return undefined;
  const byUuid = new Map(records.map((record) => [record.uuid, record]));
  const ids = new Set<string>();
  for (const uuid of preserved.uuids as string[]) {
    const record = byUuid.get(uuid);
    if (record === undefined) return undefined;
    if (record?.type !== "assistant") continue;
    const id = asRecord(record.message)?.id;
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
  const accepted = acceptCompactSummary(textFromRecord(summaries[0]));
  if (!accepted.ok) return `summary_rejected=${accepted.reason ?? "unknown"}`;

  const envelopes = records
    .filter((record, index) => index > lastBoundary && record.type === "user")
    .map((record) => parseHandoffEnvelope(textFromRecord(record)))
    .filter((parsed) => parsed.ok && parsed.version === "2");
  if (envelopes.length !== 1) return `envelope=${envelopes.length}`;
  const only = envelopes[0];
  if (!only.ok || only.version !== "2") return "envelope_unparsed";
  if (only.envelope.snapshot.forkSessionId !== forkSessionId) return "envelope_fork_mismatch";
  return undefined;
}

export interface HandoffDetail {
  summary?: string;
  utterances: HandoffUtterance[];
  decisions?: HandoffDecisions;
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
      pendingSummary = textFromRecord(record);
      continue;
    }
    if (!isHandoffGenerationBoundary(record, forkSessionId)) continue;
    const parsed = parseHandoffEnvelope(textFromRecord(record));
    if (!parsed.ok || parsed.version !== "2") continue;
    envelope = parsed.envelope;
    summary = pendingSummary;
  }
  if (envelope === undefined) return undefined;
  return {
    ...(summary !== undefined ? { summary } : {}),
    utterances: envelope.userUtterances,
    ...(envelope.decisions !== undefined ? { decisions: envelope.decisions } : {}),
  };
}

export const DECISIONS_WARN_ENTRIES = 120;
export const DECISIONS_WARN_BYTES = 24_000;

function decisionKey(tag: string, body: string): string {
  return `${tag}\0${body.replace(/\s+/g, " ").trim().replace(/\s*src=(?:user|assistant)$/i, "")}`;
}

function decisionIdNumber(id: string): number {
  const m = /^D(\d+)$/.exec(id);
  return m === null ? 0 : Number(m[1]);
}

export function mergeHandoffDecisions(
  previous: HandoffDecisions | undefined,
  lines: readonly ExtractedDecisionLine[],
  source: "hook" | "previous_only"
): HandoffDecisions {
  const carriedEntries = (previous?.entries ?? []).map((entry) => ({ ...entry }));
  const seen = [...carriedEntries, ...(previous?.removedLastGen ?? [])];
  const generation = seen.reduce((max, entry) => Math.max(max, entry.g), 0) + 1;
  let nextId = Math.max(
    previous?.nextId ?? 0,
    seen.reduce((max, entry) => Math.max(max, decisionIdNumber(entry.id)), 0) + 1
  );
  const carriedCount = carriedEntries.length;
  const entries = carriedEntries;
  const removedLastGen: HandoffDecisionEntry[] = [];
  let extracted = 0;
  let unknownIdRefs = 0;

  const ordered = [...lines].sort((a, b) => Number(b.t === "DONE") - Number(a.t === "DONE"));
  const removedIds = new Set<string>();

  for (const line of ordered) {
    if (line.t === "DONE") {
      const at = line.id === undefined ? -1 : entries.findIndex((entry) => entry.id === line.id);
      if (at < 0) {
        unknownIdRefs++;
        continue;
      }
      const gone = entries.splice(at, 1)[0];
      removedIds.add(gone.id);
      removedLastGen.push(gone);
      continue;
    }
    if (line.t === "DROPPED" && line.id !== undefined) {
      const target = entries.find((entry) => entry.id === line.id);
      if (target === undefined) {
        if (!removedIds.has(line.id)) unknownIdRefs++;
        continue;
      }
      target.t = "DROPPED";
      target.s = line.s;
      target.g = generation;
      continue;
    }
    const key = decisionKey(line.t, line.s);
    if (entries.some((entry) => decisionKey(entry.t, entry.s) === key)) continue;
    entries.push({ id: `D${nextId++}`, t: line.t, g: generation, s: line.s });
    extracted++;
  }

  const bytes = jsonBytes({ preamble: DECISIONS_PREAMBLE, entries });
  const warn =
    entries.length >= DECISIONS_WARN_ENTRIES || bytes >= DECISIONS_WARN_BYTES
      ? { entries: entries.length, bytes }
      : undefined;

  return {
    preamble: DECISIONS_PREAMBLE,
    entries,
    ...(removedLastGen.length > 0 ? { removedLastGen } : {}),
    nextId,
    carried: carriedCount,
    extracted,
    removed: removedLastGen.length,
    unknownIdRefs,
    source,
    ...(warn !== undefined ? { warn } : {}),
  };
}

function previousDecisionsOf(
  records: readonly Record<string, unknown>[],
  log: (line: string) => void
): HandoffDecisions | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type !== "user") continue;
    const parsed = parseHandoffEnvelope(textFromRecord(records[i]));
    if (!parsed.ok || parsed.version !== "2") continue;
    if (parsed.decisionsDropped) log("handoff previous decisions dropped: envelope decisions failed validation");
    return parsed.envelope.decisions;
  }
  return undefined;
}

export const HANDOFF_DETAIL_MAX_BYTES = 200_000;

const SUMMARY_KEY_BYTES = 11;
const DECISIONS_KEY_BYTES = 13;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface HandoffDetailPart {
  summary?: string;
  utterances: HandoffUtterance[];
  decisions?: HandoffDecisions;
}

export function buildHandoffDetailParts(
  summary: string | undefined,
  utterances: readonly HandoffUtterance[],
  budgetBytes: number,
  decisions?: HandoffDecisions
): HandoffDetailPart[] {
  const parts: HandoffDetailPart[] = [
    { ...(summary !== undefined ? { summary } : {}), utterances: [], ...(decisions !== undefined ? { decisions } : {}) },
  ];
  let used =
    (summary === undefined ? 0 : jsonBytes(summary) + SUMMARY_KEY_BYTES) +
    (decisions === undefined ? 0 : jsonBytes(decisions) + DECISIONS_KEY_BYTES);
  for (const utterance of utterances) {
    const current = parts[parts.length - 1];
    const cost = jsonBytes(utterance) + (current.utterances.length === 0 ? 0 : 1);
    const canSplit =
      current.utterances.length > 0 || current.summary !== undefined || current.decisions !== undefined;
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
    if (!this.started || !this.commitTerminal("cancelled")) return false;
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
  ): Promise<{ hookBody?: string; streamCompact?: HandoffCompactStats }> {
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
    let hookBody: string | undefined;
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
      hookBody = accepted.body;
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
        if (this.terminal === undefined) await this.renewLease(registryEntry);
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
          const metadata = asRecord(record.compact_metadata);
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
    return { hookBody, streamCompact };
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
        if (this.terminal === undefined) await this.renewLease(registryEntry);
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

    try {
      this.transition("forking");
      try {
        const fork = await this.deps.sdk.forkSession(input.sourceSessionId, {
          title: `⇢ ${input.sourceTitle}`,
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
        registryEntry = {
          runId: input.runId,
          sourceSessionId: input.sourceSessionId,
          forkSessionId,
          filePath: forkFilePath,
          phase: "forking",
          owner: OWNER_ID,
          leaseUntil: this.deps.now() + HANDOFF_LEASE_MS,
        };
        await this.addRegistryEntry(IN_FLIGHT_KEY, registryEntry);

        if (this.terminal === undefined) {
          this.transition("extracting");
          try {
          const read = await this.deps.readRecords(forkFilePath);
          unreadableLineCount = read.unreadableLineCount;
          const utterances = extractVerbatimUserUtterances(read.records);
          utteranceCount = utterances.length;
          const previousDecisions = previousDecisionsOf(read.records, this.deps.log);

          if (this.terminal !== undefined) return this.failureOutcome(input.runId, forkSessionId);
          let currentRecords = read.records;
          let retainedResponseCount: number | undefined;
          let decisionLines: ExtractedDecisionLine[] = [];
          let hasAcceptedHook = false;

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
                  const persistedSummary = textFromRecord(summaries[0]);
                  const accepted = acceptCompactSummary(persistedSummary);
                  if (!accepted.ok) {
                    void this.deps.writeDiagnostic?.(`${input.runId}-compact-rejected.txt`, persistedSummary)
                      .then((p) => this.deps.log(`handoff compact raw saved: ${p}`))
                      .catch((e) => this.deps.log(`handoff compact raw save failed: ${errorDetail(e)}`));
                    this.commitTerminal(accepted.reason);
                  } else {
                    if (roundResult.hookBody !== undefined) {
                      decisionLines = extractDecisionLines(roundResult.hookBody);
                      hasAcceptedHook = true;
                    } else {
                      this.deps.log("handoff compact: no PostCompact summary; keeping persisted summary");
                    }
                    const boundaryMetadata = asRecord(currentRecords[boundaryIndex].compactMetadata);
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

          if (this.terminal === undefined) {
            if (retainedResponseCount !== undefined) compact = { ...compact, retainedResponseCount };
            this.transition("appending");
            const uniqueDecisionLines = decisionLines.filter((line, index, lines) =>
              lines.findIndex((candidate) => candidate.t === line.t && candidate.id === line.id && candidate.s === line.s) === index
            );
            const decisions = mergeHandoffDecisions(
              previousDecisions,
              uniqueDecisionLines,
              hasAcceptedHook ? "hook" : "previous_only"
            );
            const carryDecisions = decisions.entries.length > 0 || (decisions.removedLastGen?.length ?? 0) > 0
              ? decisions : undefined;
            const envelope: HandoffEnvelopeV2 = {
              schema: "hb2",
              preamble: ENVELOPE_PREAMBLE,
              snapshot: {
                sourceSessionId: input.sourceSessionId,
                forkSessionId,
                capturedAt: new Date(this.deps.now()).toISOString(),
                ...(compact !== undefined ? { compact } : {}),
              },
              userUtterances: utterances,
              ...(carryDecisions !== undefined ? { decisions: carryDecisions } : {}),
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
      if (registryEntry !== undefined) {
        if (this.terminal !== "done" && forkFilePath !== undefined) {
          await this.deleteFailedFork(registryEntry);
        }
        await this.removeRegistryEntry(IN_FLIGHT_KEY, registryEntry.filePath);
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

  private async addRegistryEntry(key: string, entry: PersistedHandoff): Promise<void> {
    const entries = persistedEntries(this.deps.persist.get(key));
    entries.push(entry);
    await this.deps.persist.update(key, entries.slice(-MAX_PERSISTED_HANDOFFS));
  }

  private async renewLease(entry: PersistedHandoff): Promise<void> {
    const entries = persistedEntries(this.deps.persist.get(IN_FLIGHT_KEY));
    const index = entries.findIndex((candidate) => candidate.filePath === entry.filePath);
    if (index < 0) return;
    entries[index] = { ...entries[index], leaseUntil: this.deps.now() + HANDOFF_LEASE_MS };
    await this.deps.persist.update(IN_FLIGHT_KEY, entries);
  }

  private async removeRegistryEntry(key: string, filePath: string): Promise<void> {
    const entries = persistedEntries(this.deps.persist.get(key)).filter((entry) => entry.filePath !== filePath);
    await this.deps.persist.update(key, entries);
  }

  private async deleteFailedFork(entry: PersistedHandoff): Promise<void> {
    const projectsRoot = path.resolve(claudeProjectsDir());
    if (!isWithinProjects(entry.filePath, projectsRoot)) {
      this.deps.log(`handoff orphan outside projects root: ${entry.forkSessionId}`);
      await this.addRegistryEntry(ORPHANS_KEY, entry);
      return;
    }
    for (const delay of UNLINK_RETRY_DELAYS_MS) {
      await (this.deps.sleep ?? sleep)(delay);
      try {
        await this.deps.fs.unlink(entry.filePath);
        return;
      } catch (error) {
        this.deps.log(`handoff unlink failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    }
    await this.addRegistryEntry(ORPHANS_KEY, entry);
  }

  static async sweepOrphans(
    deps: Pick<HandoffRunnerDeps, "fs" | "persist" | "readRecords" | "log"> & { now?: () => number },
    projectsRoot: string
  ): Promise<{ deleted: string[]; kept: string[]; failed: string[]; active: string[] }> {
    const now = deps.now?.() ?? Date.now();
    const inFlight = persistedEntries(deps.persist.get(IN_FLIGHT_KEY));
    const orphans = persistedEntries(deps.persist.get(ORPHANS_KEY));
    const abandoned = new Set(orphans.map((entry) => entry.filePath));

    const active = new Map<string, PersistedHandoff>();
    for (const entry of inFlight) {
      if (abandoned.has(entry.filePath)) continue;
      if (entry.leaseUntil > now) {
        active.set(entry.filePath, entry);
        deps.log(
          `handoff sweep skipped live handoff: ${entry.forkSessionId} owner=${entry.owner} lease=${entry.leaseUntil - now}ms`
        );
      }
    }

    const entries = [...inFlight, ...orphans];
    const unique = [...new Map(entries.map((entry) => [entry.filePath, entry])).values()].filter(
      (entry) => !active.has(entry.filePath)
    );
    const deleted: string[] = [];
    const kept: string[] = [];
    const failed: string[] = [];

    for (const entry of unique) {
      try {
        await deps.fs.readFile(entry.filePath);
      } catch (error) {
        const code = asRecord(error)?.code;
        if (code === "ENOENT") {
          deleted.push(entry.filePath);
          continue;
        }
        failed.push(entry.filePath);
        deps.log(`handoff orphan read failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
        continue;
      }

      let complete = false;
      try {
        complete =
          forkIncompleteReason((await deps.readRecords(entry.filePath)).records, entry.forkSessionId) === undefined;
      } catch (error) {
        deps.log(`handoff orphan parse failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
      if (complete) {
        kept.push(entry.filePath);
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
      } catch (error) {
        failed.push(entry.filePath);
        deps.log(`handoff orphan unlink failed: ${entry.forkSessionId}: ${errorDetail(error)}`);
      }
    }

    const remaining = new Set(failed);
    await deps.persist.update(
      IN_FLIGHT_KEY,
      persistedEntries(deps.persist.get(IN_FLIGHT_KEY))
        .filter((entry) => active.has(entry.filePath) || remaining.has(entry.filePath))
    );
    await deps.persist.update(
      ORPHANS_KEY,
      persistedEntries(deps.persist.get(ORPHANS_KEY)).filter((entry) => remaining.has(entry.filePath))
    );
    return { deleted, kept, failed, active: [...active.keys()] };
  }
}
