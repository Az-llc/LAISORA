import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { readdirSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import { AccountUsageFetcher, rateLimitsViaUsageCommand } from "./account-usage";
import { claudeConfigDir, claudeProjectsDir } from "./claude-env";
import { configuredApiKeyPolicy, configuredClaudeExecutablePath, existingFolderOrHome, getLaisoraConfiguration, newSessionCwd, resolveSessionCwd } from "./claude-settings";
import { resolveClaudeCodeExecutable } from "./claudeCliResolver";
import type { ClaudeConversation } from "./claudeHost";
import type { Session } from "./extension";
import { extensionContext, output, sinceActivation, store } from "./host-context";
import {
  ACCOUNT_USAGE_TIMEOUT_MS,
  SESSION_ID_RE,
  renameUsageText,
  transcriptWriteLockedText,
  type ImageAttachment,
  type SessionListItem,
  type SessionScanDegradation,
  type WebviewToHost,
} from "./protocol";
import {
  errText,
  lookupSessionFile,
  persistChosenTitle,
  resolveSessionImage,
  sessionTranscriptRef,
} from "./session-files";
import {
  HandoffRunner,
  foldLegacyHandoffRegistries,
  handoffForkState,
  heldForkTabAction,
  heldForkTabNotice,
  heldTabInsertIndex,
  holdForkTab,
  isHandoffForkHidden,
  releaseHeldForkTab,
  withHeldForkTabs,
  type HandoffForkState,
  type HeldForkTab,
  type HeldForkTabEvent,
} from "./handoff-runner";
import { globalStorageRoot, handoffContextUsage, handoffFs, handoffPersist, handoffRegistry, readHandoffRecords } from "./handoff-wiring";
import { asObject, foldLegacyEntries, isStateFileId, usedSessionFiles, type UsedSessionStore } from "./state-files";
import { openResumedSession, readRecordedSessionCwd } from "./resume-hydration";
import { normalizeTitleValue } from "./session-display-title";
import { sessionRecordId } from "./session-record";
import type { SessionCandidate } from "./session-list";
import { SESSION_RESOLVE_BATCH, candidatePathIndex, displayTitleFromSummary, rankSessionCandidates, streamSessionRows } from "./session-list";
import { reorderSessionTabs, type SessionStore } from "./store-surfaces";
import { postTodoSnapshot } from "./todo-surface";
import { judgeTranscriptWriteLock, transcriptWriteLockedAt } from "./transcript-write-lock";

function warnImageOpenFailed(): void {
  void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
}

const USED_SESSIONS_KEY = "history.laisoraSessions";
function usedSessions(): UsedSessionStore {
  return usedSessionFiles(globalStorageRoot());
}
export function rememberSession(session: Session): Promise<void> {
  const id = sessionRecordId(session);
  if (!id) return Promise.resolve();
  const ref = sessionTranscriptRef(session);
  const written = ref ? usedSessionsFolded().then(() => usedSessions().add(ref.sessionId)).then(undefined,
    error => output.appendLine(`[history] Could not save LAISORA session index: ${String(error)}`)) : Promise.resolve();
  void persistOpenTabs();
  return written;
}
async function usedSessionIds(): Promise<Set<string>> {
  await usedSessionsFolded();
  try {
    return new Set(await usedSessions().ids());
  } catch (error) {
    output.appendLine(`[history] Could not read LAISORA session index: ${errText(error)}`);
    return new Set();
  }
}
const LEGACY_USED_SESSIONS_FOLD_PARALLEL = 16;
async function foldLegacyUsedSessions(): Promise<void> {
  const legacy = handoffPersist();
  const stored = legacy.get(USED_SESSIONS_KEY);
  if (stored === undefined) return;
  const sessionIds = Object.keys(asObject(stored) ?? {}).filter(isStateFileId);
  await foldLegacyEntries(legacy, USED_SESSIONS_KEY, sessionIds, (sessionId) => usedSessions().add(sessionId), (sessionId, error) =>
    output.appendLine(`[history] Could not move a LAISORA session index entry to its file: ${sessionId}: ${errText(error)}`),
  LEGACY_USED_SESSIONS_FOLD_PARALLEL);
}
let usedSessionsFold: Promise<void> | undefined;
function usedSessionsFolded(): Promise<void> {
  return usedSessionsFold ??= foldLegacyUsedSessions().catch((error) =>
    output.appendLine(`[startup] LAISORA session index could not be moved out of globalState: ${errText(error)}`));
}
let handoffRegistryFold: Promise<void> | undefined;
function handoffRegistriesFolded(): Promise<void> {
  const log = (line: string): void => output.appendLine(line);
  return handoffRegistryFold ??= foldLegacyHandoffRegistries(handoffPersist(), handoffRegistry(), log).catch((error) =>
    log(`[startup] handoff registries could not be moved out of globalState: ${errText(error)}`));
}

const OPEN_TABS_KEY = "history.laisoraOpenTabs";

export interface PersistedOpenTab {
  sessionId: string;
  filePath?: string;
  cwd: string;
  title?: string;
  order: number;
}

export function restoreTabsOnStartupEnabled(): boolean {
  try {
    return getLaisoraConfiguration().get<boolean>("restoreTabsOnStartup")! !== false;
  } catch {
    return true;
  }
}

function openTabEntries(): PersistedOpenTab[] {
  const entries: PersistedOpenTab[] = [];
  const seen = new Set<string>();
  for (const s of store?.sessions.values() ?? []) {
    if (s.closed) continue;
    const sessionId = sessionRecordId(s);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const filePath = s.resumeSessionId && s.resumeFilePath ? s.resumeFilePath : undefined;
    entries.push({
      sessionId,
      ...(filePath ? { filePath } : {}),
      cwd: s.cwd,
      title: s.title,
      order: entries.length,
    });
  }
  return entries;
}

function openTabsMemento(): vscode.Memento | undefined {
  return extensionContext?.workspaceState;
}

let lastPersistedOpenTabs: string | undefined;
function openTabsPersistFailed(error: unknown): void {
  lastPersistedOpenTabs = undefined;
  output.appendLine(`[history] Could not save the open tab list: ${String(error)}`);
}

export function persistOpenTabs(): Promise<void> {
  try {
    const entries = withHeldForkTabs(openTabEntries(), heldForkTabs);
    const serialized = JSON.stringify(entries);
    if (serialized === lastPersistedOpenTabs) return Promise.resolve();
    postTodoSnapshot();
    const update = openTabsMemento()?.update(OPEN_TABS_KEY, entries);
    if (!update) return Promise.resolve();
    lastPersistedOpenTabs = serialized;
    return Promise.resolve(update).then(undefined, openTabsPersistFailed);
  } catch (error) {
    openTabsPersistFailed(error);
    return Promise.resolve();
  }
}

export function readPersistedOpenTabs(): PersistedOpenTab[] {
  const raw = openTabsMemento()?.get<unknown>(OPEN_TABS_KEY);
  if (!Array.isArray(raw)) return [];
  const entries: PersistedOpenTab[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.sessionId !== "string" || !SESSION_ID_RE.test(r.sessionId) || seen.has(r.sessionId)) continue;
    seen.add(r.sessionId);
    entries.push({
      sessionId: r.sessionId,
      ...(typeof r.filePath === "string" ? { filePath: r.filePath } : {}),
      cwd: typeof r.cwd === "string" ? r.cwd : "",
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : entries.length,
    });
  }
  return entries.sort((a, b) => a.order - b.order);
}
export type HandoffForkStateIn = (sessionId: string) => HandoffForkState | undefined;
export async function handoffRegistries(): Promise<HandoffForkStateIn> {
  await handoffRegistriesFolded();
  const registry = handoffRegistry();
  const [inFlight, orphans] = [await registry.list("inFlight"), await registry.list("orphans")];
  if (inFlight.unreadable || orphans.unreadable) output.appendLine("[history] a handoff registry folder or file could not be read; the copies it names are not hidden");
  const now = Date.now();
  return (sessionId) => handoffForkState(inFlight.entries, orphans.entries, sessionId, now);
}
export async function handoffForkStateOf(sessionId: string): Promise<HandoffForkState | undefined> {
  return (await handoffRegistries())(sessionId);
}
async function hiddenHandoffForks(): Promise<(sessionId: string) => boolean> {
  const stateOf = await handoffRegistries();
  return (sessionId) => isHandoffForkHidden(stateOf(sessionId));
}
const restoreForkChecks = new Set<Promise<unknown>>();
let openForkCheckTail: Promise<unknown> = Promise.resolve();
export function handoffForkStateForOpen(sessionId: string, restoreEntry?: PersistedOpenTab): Promise<HandoffForkState | undefined> {
  const check = openForkCheckTail.then(() => handoffForkStateOf(sessionId)).then((state) => {
    if (restoreEntry !== undefined && isHandoffForkHidden(state)) holdHandoffForkTab(restoreEntry, state!);
    return state;
  });
  openForkCheckTail = check.catch(() => undefined);
  if (restoreEntry !== undefined) {
    restoreForkChecks.add(check);
    void check.finally(() => restoreForkChecks.delete(check)).catch(() => undefined);
  }
  return check;
}
export function postSessionListChanged(): void {
  store?.post({ type: "sessionListChanged" });
}

let startupSweep: Promise<void> | undefined;

export function sweepHandoffForksAtStartup(): Promise<void> {
  startupSweep ??= handoffRegistriesFolded().then(sweepHandoffForks);
  return startupSweep;
}

export async function settleHeldForkTabsAfterSweep(post: (message: string) => void = noticeInFirstTab): Promise<void> {
  await startupSweep;
  await Promise.allSettled([...restoreForkChecks]);
  await settleHeldForkTabs(post);
}

async function sweepHandoffForks(): Promise<void> {
  try {
    const result = await HandoffRunner.sweepOrphans(
      {
        fs: handoffFs,
        registry: handoffRegistry(),
        contextUsage: handoffContextUsage(),
        readRecords: readHandoffRecords,
        log: (line) => output.appendLine(line),
      },
      claudeProjectsDir()
    );
    if (result.deleted.length + result.kept.length + result.failed.length > 0) postSessionListChanged();
  } catch (error) {
    output.appendLine(`[startup] handoff の孤児回収に失敗: ${errText(error)}`);
  }
}

let heldForkTabs: HeldForkTab<PersistedOpenTab>[] = [];
const settledForkTabs = new Set<string>();
const reopeningForkTabs = new Set<string>();

export function holdHandoffForkTab(entry: PersistedOpenTab, state: HandoffForkState): void {
  const preceding = readPersistedOpenTabs()
    .filter((tab) => tab.order < entry.order && tab.sessionId !== entry.sessionId)
    .map((tab) => tab.sessionId);
  heldForkTabs = holdForkTab(heldForkTabs, entry, preceding, state);
  void persistOpenTabs();
}

export function noteHandoffForkTab(event: HeldForkTabEvent): void {
  heldForkTabs = releaseHeldForkTab(heldForkTabs, event);
}

function noticeInFirstTab(message: string): void {
  const first = store?.sessions.values().next().value;
  first?.pushEvent({ kind: "error", message, fatal: false });
}

export function unfinishedHandoffTabNotice(label: string, state: HandoffForkState | undefined): string {
  switch (state) {
    case "handing_off":
    case "stale":
      return l10n.t("The tab \"{0}\" was not restored: its handoff had not finished. LAISORA keeps it in the tab list and checks the copy at startup.", label);
    case "cleanup_failed":
      return l10n.t("The tab \"{0}\" was not restored: it is a copy left by a handoff that did not finish, and it could not be removed.", label);
    default:
      return l10n.t("The tab \"{0}\" was not restored: it was a copy left by a handoff that did not finish, and it has been removed.", label);
  }
}

function dropHeldForkTab(tab: PersistedOpenTab, message: string, post: (message: string) => void = noticeInFirstTab): void {
  noteHandoffForkTab({ kind: "settled", sessionId: tab.sessionId, action: "drop" });
  void persistOpenTabs();
  post(message);
}

async function settleHeldForkTabs(post: (message: string) => void): Promise<void> {
  const stateOf = await handoffRegistries();
  for (const held of heldForkTabs) {
    const tab = held.tab;
    if (reopeningForkTabs.has(tab.sessionId) || settledForkTabs.has(tab.sessionId)) continue;
    settledForkTabs.add(tab.sessionId);
    const state = stateOf(tab.sessionId);
    const lookup = state === undefined ? lookupSessionFile(tab.sessionId) : undefined;
    const action = heldForkTabAction(
      state,
      lookup === undefined || lookup.reason === "scan_failed" ? "unknown" : lookup.path !== null ? "present" : "missing"
    );
    const notice = heldForkTabNotice(action, state, held.state);
    const message = notice.notice ? unfinishedHandoffTabNotice(tab.title ?? tab.sessionId, notice.state) : undefined;
    if (action === "drop") dropHeldForkTab(tab, message!, post);
    else if (action === "reopen" && lookup?.path) reopenHeldForkTab(held, lookup.path);
    else if (message !== undefined) post(message);
  }
}

function reopenHeldForkTab(held: HeldForkTab<PersistedOpenTab>, filePath: string): void {
  const tab = held.tab;
  const st = store;
  if (!st) return;
  const label = tab.title ?? tab.sessionId;
  const failed = (): void => dropHeldForkTab(tab, l10n.t("Could not restore the tab \"{0}\" (session {1}).", label, tab.sessionId));
  reopeningForkTabs.add(tab.sessionId);
  void openResumedSession(st, { sessionId: tab.sessionId, filePath, activate: false, knownCwd: tab.cwd, restoreEntry: tab })
    .then((opened) => {
      if (opened.session !== undefined) {
        const others = [...st.sessions.values()].filter((s) => s !== opened.session);
        const order = others.map((s) => s.tabId);
        order.splice(heldTabInsertIndex(others.map((s) => sessionRecordId(s)), held.preceding), 0, opened.session.tabId);
        reorderSessionTabs(st, order);
      } else if (opened.handoffFork === "cleanup_failed") {
        dropHeldForkTab(tab, unfinishedHandoffTabNotice(label, opened.handoffFork));
      } else if ([...st.sessions.values()].some((s) => !s.closed && sessionRecordId(s) === tab.sessionId)) {
        noteHandoffForkTab({ kind: "opened", sessionId: tab.sessionId });
      } else if (opened.handoffFork === undefined) {
        failed();
      }
    }, (error) => {
      output.appendLine(`[restore] could not reopen the tab of a finished handoff: ${tab.sessionId}: ${errText(error)}`);
      failed();
    })
    .finally(() => reopeningForkTabs.delete(tab.sessionId));
}
const HIDDEN_SESSIONS_KEY = "history.hiddenSessions";
export function hiddenSessionIds(): Set<string> {
  const raw = extensionContext?.globalState.get<unknown>(HIDDEN_SESSIONS_KEY, []);
  return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && SESSION_ID_RE.test(id)) : []);
}
let hiddenSessionsWrite: Promise<void> = Promise.resolve();
function updateHiddenSessions(sessionId: string, hidden: boolean): Promise<void> {
  const write = hiddenSessionsWrite.then(async () => {
    const context = extensionContext;
    if (!context) throw new Error("extension context unavailable");
    const ids = hiddenSessionIds();
    if (hidden) ids.add(sessionId); else ids.delete(sessionId);
    await context.globalState.update(HIDDEN_SESSIONS_KEY, [...ids]);
  });
  hiddenSessionsWrite = write.then(undefined, () => undefined);
  return write;
}

type HistorySource = "laisora" | "claude";
interface HistoryListing {
  token: number;
  candidates: SessionCandidate[];
  knownIds: ReadonlySet<string>;
  origins: Map<string, HistoricalOrigin | "failed">;
  degradation: SessionScanDegradation;
}
const historyPages = new Map<string, HistoryListing>();

const originCache = new Map<string, { mtime: number; origin: HistoricalOrigin }>();
type HistoricalOrigin = "claude" | "claude-fork" | "unknown";
const CLAUDE_CODE_ENTRYPOINTS: ReadonlySet<string> = new Set(["cli", "claude-vscode", "claude-desktop"]);
function historySourceOf(origin: HistoricalOrigin | "failed", indexedByLaisora: boolean): HistorySource | undefined {
  if (origin === "claude") return "claude";
  if (origin === "claude-fork") return indexedByLaisora ? "laisora" : "claude";
  if (origin === "failed") return indexedByLaisora ? "laisora" : undefined;
  return "laisora";
}
const ORIGIN_READ_BYTES = 65536;
const ORIGIN_SCAN_MAX_BYTES = 32 * 1024 * 1024;
const ORIGIN_FIELD_MAX_BYTES = 64;
type OriginField = "type" | "entrypoint" | "forkedFrom";
const ORIGIN_FIELDS: ReadonlySet<string> = new Set<OriginField>(["type", "entrypoint", "forkedFrom"]);
class RecordFieldScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private phase: "key" | "colon" | "value" | "next" = "key";
  private key: string | undefined;
  private captureFor: "key" | OriginField | undefined;
  private captured: number[] = [];
  private overflow = false;
  private touched = false;
  type: string | undefined;
  entrypoint: string | undefined;
  forked = false;

  reset(): void {
    this.depth = 0; this.inString = false; this.escaped = false; this.phase = "key"; this.key = undefined;
    this.captureFor = undefined; this.captured = []; this.overflow = false; this.touched = false;
    this.type = undefined; this.entrypoint = undefined; this.forked = false;
  }

  get pending(): boolean { return this.touched; }

  get complete(): boolean { return this.touched && this.depth === 0 && !this.inString; }

  skipStringBody(buf: Buffer, from: number, end: number): number {
    if (!this.inString || this.escaped || this.captureFor !== undefined) return from;
    let i = from;
    while (i < end) {
      const c = buf[i];
      if (c === 34 || c === 92 || c === 10) break;
      i++;
    }
    return i;
  }

  push(b: number): void {
    this.touched = true;
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (b === 92) this.escaped = true;
      else if (b === 34) { this.inString = false; this.endString(); return; }
      if (this.captureFor !== undefined) {
        if (this.captured.length < ORIGIN_FIELD_MAX_BYTES) this.captured.push(b); else this.overflow = true;
      }
      return;
    }
    if (b === 32 || b === 9 || b === 13) return;
    const top = this.depth === 1;
    if (b === 34) {
      this.inString = true;
      this.captured = []; this.overflow = false;
      this.captureFor = !top ? undefined : this.phase === "key" ? "key"
        : this.phase === "value" && this.key !== undefined && ORIGIN_FIELDS.has(this.key) ? this.key as OriginField : undefined;
      if (top && this.phase === "value" && this.captureFor === undefined) this.phase = "next";
      return;
    }
    if (b === 123 || b === 91) {
      if (top && this.phase === "value") { if (this.key === "forkedFrom") this.forked = true; this.phase = "next"; }
      this.depth++;
      if (this.depth === 1) this.phase = "key";
      return;
    }
    if (b === 125 || b === 93) { this.depth--; return; }
    if (!top) return;
    if (b === 58 && this.phase === "colon") { this.phase = "value"; return; }
    if (b === 44) { this.phase = "key"; return; }
    if (this.phase === "value") {
      if (this.key === "forkedFrom") this.forked = b === 116 || (b >= 49 && b <= 57) || b === 45;
      this.phase = "next";
    }
  }

  private endString(): void {
    const field = this.captureFor;
    this.captureFor = undefined;
    if (field === undefined) return;
    const text = this.overflow ? undefined : Buffer.from(this.captured).toString("utf8");
    if (field === "key") { this.key = text; this.phase = "colon"; return; }
    this.phase = "next";
    if (field === "type") this.type = text;
    else if (field === "entrypoint") this.entrypoint = text;
    else this.forked = this.captured.length > 0;
  }
}
function originOfScannedRecord(scan: RecordFieldScanner): { conversation: boolean; origin?: HistoricalOrigin } {
  if (!scan.complete || (scan.type !== "user" && scan.type !== "assistant")) return { conversation: false };
  if (scan.entrypoint === undefined) return { conversation: true };
  return {
    conversation: true,
    origin: !CLAUDE_CODE_ENTRYPOINTS.has(scan.entrypoint) ? "unknown" : scan.forked ? "claude-fork" : "claude",
  };
}
async function scanHistoricalOrigin(
  handle: FileHandle,
  probes?: { count: number; bytes: number }
): Promise<{ origin: HistoricalOrigin; settled: boolean }> {
  const chunk = Buffer.alloc(ORIGIN_READ_BYTES);
  const scan = new RecordFieldScanner();
  let position = 0;
  let lineStart = 0;
  let scanEnd = ORIGIN_SCAN_MAX_BYTES;
  while (lineStart < scanEnd && position < ORIGIN_SCAN_MAX_BYTES) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (probes) { probes.count++; probes.bytes += bytesRead; }
    if (bytesRead === 0) {
      if (!scan.pending) return { origin: "unknown", settled: true };
      const last = originOfScannedRecord(scan);
      return { origin: last.origin ?? "unknown", settled: last.origin !== undefined };
    }
    for (let i = 0; i < bytesRead && lineStart < scanEnd; i++) {
      i = scan.skipStringBody(chunk, i, bytesRead);
      if (i >= bytesRead) break;
      const b = chunk[i];
      if (b !== 10) { scan.push(b); continue; }
      const line = originOfScannedRecord(scan);
      if (line.origin !== undefined) return { origin: line.origin, settled: true };
      scan.reset();
      lineStart = position + i + 1;
      if (line.conversation) scanEnd = Math.min(scanEnd, lineStart + ORIGIN_READ_BYTES);
    }
    position += bytesRead;
  }
  return { origin: "unknown", settled: true };
}
async function historicalOrigin(
  file: string,
  mtime: number,
  probes?: { count: number; bytes: number }
): Promise<{ origin: HistoricalOrigin | "failed"; settled: boolean }> {
  const cached = originCache.get(file);
  if (cached && cached.mtime === mtime) return { origin: cached.origin, settled: true };
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return { origin: "failed", settled: true };
  try {
    const { origin, settled } = await scanHistoricalOrigin(handle, probes);
    if (settled) originCache.set(file, { mtime, origin });
    return { origin, settled };
  } catch { return { origin: "failed", settled: true }; } finally { await handle.close(); }
}

let sessionSdk: Pick<typeof ClaudeCodeSdk, "getSessionInfo"> | undefined;
function sessionInfoSdk(): Pick<typeof ClaudeCodeSdk, "getSessionInfo"> {
  if (sessionSdk === undefined) {
    sessionSdk = require("@anthropic-ai/claude-agent-sdk") as Pick<typeof ClaudeCodeSdk, "getSessionInfo">;
  }
  return sessionSdk;
}

async function sessionInfoOf(
  sessionId: string,
  onError?: (err: unknown) => void
): Promise<ClaudeCodeSdk.SDKSessionInfo | undefined> {
  try {
    const sdk = sessionInfoSdk();
    return await sdk.getSessionInfo(sessionId);
  } catch (err) {
    onError?.(err);
    return undefined;
  }
}

export async function sessionSummaryOf(sessionId: string): Promise<string | undefined> {
  const info = await sessionInfoOf(sessionId);
  return typeof info?.summary === "string" ? info.summary : undefined;
}

export async function sessionDisplayTitleOf(sessionId: string): Promise<string | undefined> {
  const summary = await sessionSummaryOf(sessionId);
  return summary === undefined ? undefined : displayTitleFromSummary(summary, sessionId);
}

export function holdsChosenTitle(session: Session): boolean {
  return session.unpersistedChosenTitle !== null;
}

export async function refreshTabTitle(session: Session): Promise<void> {
  const sessionId = session.auth?.sessionId;
  const generation = session.logicalGeneration;
  try {
    if (!sessionId) return;
    void rememberSession(session);
    const summary = await sessionSummaryOf(sessionId);
    if (summary === undefined) return;
    if (session.logicalGeneration !== generation || session.closed) return;
    session.titleRefreshed = true;
    if (holdsChosenTitle(session)) return;
    const title = displayTitleFromSummary(summary, sessionId);
    if (title === session.title) return;
    session.title = title;
    store?.post({ type: "tabRenamed", tabId: session.tabId, title });
  } finally {
    if (session.logicalGeneration === generation) session.titleRefreshing = false;
  }
}

let sessionListRequestSeq = 0;
const accountUsageFetcher = new AccountUsageFetcher((line) => output.appendLine(line));
export function releaseAccountUsageWaiter(webview: vscode.Webview): void {
  accountUsageFetcher.release(webview);
}
export function disposeAccountUsage(): void {
  accountUsageFetcher.dispose();
}

async function listPastSessions(
  requestId: number,
  emit: (sessions: SessionListItem[], complete: boolean, degraded?: SessionScanDegradation, nextCursor?: string) => void,
  options: { source?: HistorySource; cursor?: string; showHidden?: boolean } = {}
): Promise<void> {
  const listStartT = Date.now();
  const root = claudeProjectsDir();
  const entries: SessionCandidate[] = [];
  await Promise.all([...(store?.sessions.values() ?? [])].map(rememberSession));
  const hidden = hiddenSessionIds();
  const source = options.source ?? "claude";
  const pageKey = `${source}:${options.showHidden === true}`;
  const savedPage = historyPages.get(pageKey);
  const cursorParts = options.cursor?.split(":").map(Number);
  const continuation = cursorParts && savedPage?.token === cursorParts[0] ? savedPage : undefined;
  const offset = continuation ? cursorParts![1] : 0;

  const degradation: SessionScanDegradation = continuation?.degradation ?? {
    rootFailed: false,
    unreadableProjects: 0,
    statFailed: 0,
    resolveFailed: 0,
    unresolvedCandidates: 0,
  };
  const degraded = (): SessionScanDegradation | undefined =>
    degradation.rootFailed ||
    degradation.unreadableProjects > 0 ||
    degradation.statFailed > 0 ||
    degradation.resolveFailed > 0 ||
    degradation.unresolvedCandidates > 0
      ? { ...degradation }
      : undefined;
  try {
    if (continuation) {
      entries.push(...continuation.candidates);
    } else for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = entry.name;
      try {
        for (const f of readdirSync(join(root, dir))) {
          if (!f.endsWith(".jsonl")) continue;
          const sessionId = f.slice(0, -".jsonl".length);
          const filePath = join(root, dir, f);
          try {
            entries.push({ sessionId, filePath, mtime: statSync(filePath).mtimeMs });
          } catch {
            degradation.statFailed++;
          }
        }
      } catch (err) {
        degradation.unreadableProjects++;
        output.appendLine(`[history] プロジェクトを読めません: ${dir} — ${errText(err)}`);
      }
    }
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") {
      degradation.rootFailed = true;
      output.appendLine(`[history] 保存先を読めません: ${root} — ${errText(err)}`);
    }
    emit([], true, degraded());
    return;
  }
  if (!continuation && degradation.statFailed > 0) {
    output.appendLine(`[history] stat できないファイル ${degradation.statFailed} 件（候補から除外・req ${requestId}）`);
  }
  const scanDoneT = Date.now();
  const forkHidden = continuation ? undefined : await hiddenHandoffForks();
  const candidates = continuation ? entries : rankSessionCandidates(entries).filter(c =>
    (options.showHidden === true || !hidden.has(c.sessionId)) && !forkHidden?.(c.sessionId));
  const token = continuation?.token ?? requestId;
  const known = await usedSessionIds();
  const knownIds = continuation?.knownIds ?? known;
  const origins = continuation?.origins ?? new Map<string, HistoricalOrigin | "failed">();
  if (!continuation) historyPages.set(pageKey, {token, candidates, knownIds, origins, degradation});
  const pathBySessionId = candidatePathIndex(candidates);
  const sortDoneT = Date.now();
  output.appendLine(
    `[history] ${sinceActivation()} 候補 ${candidates.length} 件（走査 ${scanDoneT - listStartT}ms・req ${requestId}）`
  );

  const originProbes = { count: 0, bytes: 0 };
  let originMs = 0;
  const matchesSource = async (c: SessionCandidate): Promise<boolean> => {
    if (!options.source) return true;
    const indexed = knownIds.has(c.sessionId);
    let origin = origins.get(c.sessionId);
    if (origin === undefined) {
      const t = Date.now();
      const read = await historicalOrigin(c.filePath, c.mtime, originProbes);
      originMs += Date.now() - t;
      origin = read.origin;
      if (read.settled) origins.set(c.sessionId, origin);
      if (origin === "failed" && historySourceOf(origin, indexed) === undefined && source === "claude") {
        degradation.statFailed++;
        output.appendLine(`[history] 由来を読めません（一覧から除外）: ${c.sessionId}・req ${requestId}`);
      }
    }
    return historySourceOf(origin, indexed) === source;
  };
  let firstRowT = 0;
  let resolveStarts = 0;
  let firstResolveMs = -1;
  let resolveMs = 0;
  let rowsSent = 0;
  let emits = 0;
  let emitMs = 0;
  const { sent, scanned, nextIndex } = await streamSessionRows(
    candidates.slice(offset),
    pathBySessionId,
    async (c) => {
      if (options.showHidden !== true && hidden.has(c.sessionId)) return undefined;
      if (!await matchesSource(c)) return undefined;
      const first = ++resolveStarts === 1;
      const t = Date.now();
      const info = await sessionInfoOf(c.sessionId, (err) => {
        degradation.resolveFailed++;
        if (degradation.resolveFailed === 1) {
          output.appendLine(`[history] 要約を解決できません: ${c.sessionId} — ${errText(err)}`);
        }
      });
      resolveMs += Date.now() - t;
      if (first) firstResolveMs = Date.now() - t;
      return info && typeof info.summary === "string" ? info : undefined;
    },
    (sessions: SessionListItem[], complete: boolean) => {
      rowsSent += sessions.length;
      if (complete && rowsSent === 0 && resolveStarts > 0) {
        degradation.unresolvedCandidates = degradation.unresolvedCandidates + resolveStarts;
        output.appendLine(
          `[history] 候補 ${resolveStarts} 件から 1 行も解決できません（req ${requestId}）`
        );
      }
      if (firstRowT === 0 && sessions.length > 0) {
        firstRowT = Date.now();
        output.appendLine(
          `[history] ${sinceActivation()} 初行到達 ${firstRowT - listStartT}ms` +
            `（解決 ${resolveStarts}件・先頭解決 ${firstResolveMs}ms・req ${requestId}）`
        );
      }
      for (const row of sessions) {
        if (source === "laisora" && !known.has(row.sessionId)) row.originUnverified = true;
        if (hidden.has(row.sessionId)) row.hidden = true;
      }
      const t = Date.now();
      emit(sessions, false, degraded());
      emitMs += Date.now() - t;
      emits++;
    }
  );
  let more = false;
  for (let i = nextIndex === undefined ? candidates.length : offset + nextIndex; i < candidates.length && !more; i += SESSION_RESOLVE_BATCH) {
    const found = await Promise.all(candidates.slice(i, i + SESSION_RESOLVE_BATCH).map(c =>
      options.showHidden !== true && hidden.has(c.sessionId) ? false : matchesSource(c)));
    more = found.includes(true);
  }
  const lastEmitT = Date.now();
  emit([], true, degraded(), more && nextIndex !== undefined ? `${token}:${offset + nextIndex}` : undefined);
  emitMs += Date.now() - lastEmitT;
  emits++;
  output.appendLine(
    `[history] ${sinceActivation()} 一覧完了 ${Date.now() - listStartT}ms（走査 ${scanDoneT - listStartT}ms / 並べ替え ${sortDoneT - scanDoneT}ms` +
      ` / 由来 ${originProbes.count}件 ${Math.round(originProbes.bytes / 1024)}KB 計 ${originMs}ms / 要約 ${resolveStarts}件 計 ${resolveMs}ms` +
      ` / 送信 ${emits}回 ${emitMs}ms / 初行 ${firstRowT === 0 ? "-" : `${firstRowT - listStartT}ms`}` +
      ` / ${sent}行・候補 ${candidates.length}件中 ${scanned}件を確認・req ${requestId}）`
  );
}

const renameQueues = new Map<string, Promise<void>>();
function queueRename<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const result = (renameQueues.get(sessionId) ?? Promise.resolve()).then(run);
  const tail = result.then(() => undefined, () => undefined);
  renameQueues.set(sessionId, tail);
  void tail.then(() => { if (renameQueues.get(sessionId) === tail) renameQueues.delete(sessionId); });
  return result;
}

export const CHOSEN_TITLE_NOTICE_FAILURES = 2;

function liveTitleCli(s: Session, ref: { sessionId: string } | null): ClaudeConversation | null {
  const conversation = s.conversation;
  if (conversation === null || conversation.isClosed) return null;
  const cliSessionId = s.auth?.sessionId;
  return ref === null || cliSessionId === undefined || cliSessionId === ref.sessionId ? conversation : null;
}

export function writeHeldChosenTitle(s: Session): Promise<void> {
  const pending = s.unpersistedChosenTitle;
  if (pending === null || s.transcriptWriteLocked) return Promise.resolve();
  const ref = sessionTranscriptRef(s);
  s.unpersistedChosenTitle = null;
  if (ref === null) return Promise.resolve();
  return persistChosenTitle(null, ref, pending.title).then(
    () => undefined,
    (error) => output.appendLine(`[${s.title}] Could not save the name: ${errText(error)}`)
  );
}

export async function flushChosenTitle(s: Session): Promise<void> {
  const pending = s.unpersistedChosenTitle;
  if (pending === null || s.transcriptWriteLocked) return;
  const ref = sessionTranscriptRef(s);
  let outcome: "cli" | "file" | "pending";
  try {
    outcome = await persistChosenTitle(liveTitleCli(s, ref), ref, pending.title);
  } catch (error) {
    output.appendLine(`[${s.title}] Could not save the name: ${errText(error)}`);
    outcome = "pending";
  }
  if (s.unpersistedChosenTitle !== pending) return;
  if (outcome !== "pending") {
    s.unpersistedChosenTitle = null;
    return;
  }
  pending.failedAttempts += 1;
  if (pending.failedAttempts === CHOSEN_TITLE_NOTICE_FAILURES) {
    s.pushEvent({
      kind: "error",
      message: l10n.t("The name could not be passed to Claude Code yet. LAISORA keeps retrying and saves it to the session record at the latest when the tab closes."),
      fatal: false,
    });
  }
}

function applyCustomTitle(st: SessionStore, s: Session, sessionId: string, title: string): void {
  s.title = displayTitleFromSummary(title, sessionId);
  s.autoTitled = true;
  s.unpersistedChosenTitle = null;
  st.post({ type: "tabRenamed", tabId: s.tabId, title: s.title });
}

interface RenameTarget {
  ref: { sessionId: string; file: string };
  generation: number;
}

function renameTargetOf(s: Session): RenameTarget | null {
  const ref = sessionTranscriptRef(s);
  return ref === null ? null : { ref, generation: s.logicalGeneration };
}

function renameTargetIsCurrent(s: Session, target: RenameTarget): boolean {
  if (s.closed || s.logicalGeneration !== target.generation) return false;
  const ref = sessionTranscriptRef(s);
  return ref !== null && ref.sessionId === target.ref.sessionId && ref.file === target.ref.file;
}

async function renameOpenSession(
  st: SessionStore,
  s: Session,
  rawTitle: string,
  target: RenameTarget | null,
  requestId?: string
): Promise<{ title: string } | { reason: string }> {
  const refuse = (reason: string) => {
    s.pushEvent({ kind: "error", message: reason, fatal: false });
    return { reason };
  };
  if (await judgeTranscriptWriteLock(s)) return refuse(transcriptWriteLockedText());
  if (target === null) return refuse(l10n.t("/rename can be used once the session file is determined (try again after the first response)."));
  if (!renameTargetIsCurrent(s, target)) {
    output.appendLine(`[history] Dropped a rename for a session the tab no longer shows: ${target.ref.sessionId}`);
    if (s.closed) return { reason: "stale-rename-target" };
    return refuse(l10n.t("/rename: The name was not saved because the tab now shows another session."));
  }
  const { ref, generation } = target;
  const title = normalizeTitleValue(rawTitle);
  if (title === null) return refuse(renameUsageText());
  const starting = s.starting;
  let outcome: "cli" | "file" | "pending" = "pending";
  if (starting === null) {
    try {
      outcome = await persistChosenTitle(liveTitleCli(s, ref), ref, title);
    } catch (error) {
      return refuse(l10n.t("/rename: Could not write to the session file ({0})", String(error)));
    }
  }
  const shown = displayTitleFromSummary(title, ref.sessionId);
  if (!s.closed && s.logicalGeneration === generation) {
    applyCustomTitle(st, s, ref.sessionId, title);
    if (outcome === "pending") s.unpersistedChosenTitle = { title, failedAttempts: starting === null ? 1 : 0 };
  }
  if (starting !== null) void starting.then(() => flushChosenTitle(s));
  st.post({ type: "sessionRenamed", sessionId: ref.sessionId, title: shown, ...(requestId !== undefined ? { requestId } : {}) });
  return { title };
}

function openSessionsOf(st: SessionStore, sessionId: string): Session[] {
  return [...st.sessions.values()].filter(s =>
    !s.closed && sessionRecordId(s) === sessionId && sessionTranscriptRef(s)?.sessionId === sessionId);
}

async function renameListedSession(st: SessionStore, msg: Extract<WebviewToHost, { type: "renameSession" }>): Promise<void> {
  const reply = msg.requestId !== undefined ? { requestId: msg.requestId } : {};
  const fail = (reason: string) => st.post({ type: "sessionListActionFailed", sessionId: msg.sessionId, action: "rename", reason, ...reply });
  const [first, ...others] = openSessionsOf(st, msg.sessionId);
  if (first) {
    const generations = new Map(others.map(s => [s, s.logicalGeneration]));
    const result = await renameOpenSession(st, first, msg.title, renameTargetOf(first), msg.requestId);
    if ("reason" in result) { fail(result.reason); return; }
    for (const [s, generation] of generations) {
      if (!s.closed && s.logicalGeneration === generation) applyCustomTitle(st, s, msg.sessionId, result.title);
    }
    return;
  }
  const recorded = await readRecordedSessionCwd(msg.filePath).catch(() => undefined);
  if (await transcriptWriteLockedAt(recorded?.cwd ?? newSessionCwd())) { fail(transcriptWriteLockedText()); return; }
  const title = normalizeTitleValue(msg.title);
  if (title === null) { fail(l10n.t("Enter a name.")); return; }
  try {
    await persistChosenTitle(null, { sessionId: msg.sessionId, file: msg.filePath }, title);
  } catch (error) {
    output.appendLine(`[history] Could not save the name: ${msg.sessionId} — ${errText(error)}`);
    fail(l10n.t("Could not save the name ({0})", errText(error)));
    return;
  }
  st.post({ type: "sessionRenamed", sessionId: msg.sessionId, title: displayTitleFromSummary(title, msg.sessionId), ...reply });
}

export async function handleSessionFileMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "renameTab" | "renameSession" | "setSessionHidden" | "listSessions" | "requestAccountUsage" | "accountUsagePanelClosed" | "sessionImageRequest" | "openSessionImage" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "renameTab": {
      const accepted = renameTargetOf(target!);
      if (accepted === null) await renameOpenSession(st, target!, msg.title, null);
      else await queueRename(accepted.ref.sessionId, () => renameOpenSession(st, target!, msg.title, accepted));
      break;
    }
    case "renameSession": {
      await queueRename(msg.sessionId, () => renameListedSession(st, msg));
      break;
    }
    case "setSessionHidden": {
      try {
        await updateHiddenSessions(msg.sessionId, msg.hidden);
      } catch (error) {
        output.appendLine(`[history] Could not save the hidden sessions: ${msg.sessionId} — ${errText(error)}`);
        st.post({
          type: "sessionListActionFailed",
          sessionId: msg.sessionId,
          action: msg.hidden ? "hide" : "unhide",
          reason: l10n.t("Could not save the hidden sessions ({0})", errText(error)),
        });
        break;
      }
      st.post({ type: "sessionHiddenChanged", sessionId: msg.sessionId, hidden: msg.hidden });
      break;
    }
    case "listSessions": {
      const requestId = ++sessionListRequestSeq;
      await listPastSessions(
        requestId,
        (sessions: SessionListItem[], complete: boolean, degraded?: SessionScanDegradation, nextCursor?: string) => {
          if (requestId !== sessionListRequestSeq) return;
          st.post({ type: "sessions", requestId, sessions, complete, degraded, source: msg.source, showHidden: msg.showHidden, nextCursor, append: msg.cursor !== undefined });
        },
        {source: msg.source, cursor: msg.cursor, showHidden: msg.showHidden}
      );
      break;
    }
    case "requestAccountUsage": {
      const conversation = target?.conversation && !target.conversation.isClosed ? target.conversation : undefined;
      const cfg = getLaisoraConfiguration();
      const apiKeyPolicy = configuredApiKeyPolicy(cfg);
      const snapshot = await accountUsageFetcher.request(sender, {
        identity: JSON.stringify([claudeConfigDir(), apiKeyPolicy, target?.auth?.credentialSource ?? null, target?.auth?.apiKeySource ?? null]),
        ...(conversation ? { viaConversation: (signal: AbortSignal) => conversation.planUsageRateLimits(ACCOUNT_USAGE_TIMEOUT_MS, signal) } : {}),
        viaUsageCommand: (signal) =>
          rateLimitsViaUsageCommand({
            cwd: existingFolderOrHome(target ? resolveSessionCwd(target) : undefined),
            apiKeyPolicy,
            signal,
            resolveExecutablePath: async () =>
              (await resolveClaudeCodeExecutable(configuredClaudeExecutablePath(cfg))).path,
          }),
      });
      if (snapshot) void st.postTo(sender, { type: "accountUsage", replyTo: msg.requestId, ...snapshot });
      break;
    }
    case "accountUsagePanelClosed": {
      accountUsageFetcher.release(sender);
      break;
    }
    case "sessionImageRequest": {
      const session = target!;
      const res = await resolveSessionImage(session, msg.ref);
      if ("error" in res) {
        await st.postTo(sender, {
          type: "sessionImageError",
          tabId: session.tabId,
          requestId: msg.requestId,
          reason: res.error,
        });
      } else {
        await st.postTo(sender, {
          type: "sessionImageResult",
          tabId: session.tabId,
          requestId: msg.requestId,
          mediaType: res.mediaType,
          data: res.data,
        });
      }
      break;
    }
    case "openSessionImage": {
      const session = target;
      if (!session || !extensionContext) {
        warnImageOpenFailed();
        break;
      }
      try {
        let imageBytes: { mediaType: ImageAttachment["mediaType"]; data: string } | undefined;
        let fileKey = "";
        if (msg.ref) {
          const res = await resolveSessionImage(session, msg.ref);
          if ("error" in res) {
            warnImageOpenFailed();
            break;
          }
          imageBytes = res;
          const refPart =
            msg.ref.kind === "record" ? msg.ref.uuid : `${msg.ref.generation}-${msg.ref.seq}`;
          fileKey = `${session.tabId}-${refPart}-${msg.ref.index}`;
        } else if (msg.inline) {
          imageBytes = msg.inline;
          fileKey = `${session.tabId}-inline-${Date.now()}`;
        }
        if (!imageBytes) {
          warnImageOpenFailed();
          break;
        }
        const extMap: Record<ImageAttachment["mediaType"], string> = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
        };
        const ext = extMap[imageBytes.mediaType] || "png";
        const imagesDir = vscode.Uri.joinPath(extensionContext.globalStorageUri, "images");
        await vscode.workspace.fs.createDirectory(imagesDir);
        const fileUri = vscode.Uri.joinPath(imagesDir, `${fileKey}.${ext}`);
        const buffer = Buffer.from(imageBytes.data, "base64");
        await vscode.workspace.fs.writeFile(fileUri, buffer);
        await vscode.commands.executeCommand("vscode.open", fileUri);
      } catch {
        warnImageOpenFailed();
      }
      break;
    }
  }
}
