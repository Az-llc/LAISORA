import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import { homedir } from "node:os";
import { AccountUsageFetcher, rateLimitsViaUsageCommand } from "./account-usage";
import { claudeConfigDir, claudeProjectsDir } from "./claude-env";
import { configuredClaudeExecutablePath, getLaisoraConfiguration, resolveSessionCwd } from "./claude-settings";
import { resolveClaudeCodeStartup } from "./claudeCliResolver";
import { sdkClaudeCodeVersion } from "./claudeHost";
import type { Session } from "./extension";
import { extensionContext, output, sinceActivation, store } from "./host-context";
import {
  ACCOUNT_USAGE_TIMEOUT_MS,
  SESSION_ID_RE,
  normalizeApiKeyPolicy,
  type ImageAttachment,
  type SessionListItem,
  type SessionScanDegradation,
  type WebviewToHost,
} from "./protocol";
import {
  appendSessionRecordOnFreshLine,
  errText,
  resolveSessionImage,
  sessionTranscriptRef,
} from "./session-files";
import { formatCustomTitleRecord, normalizeTitleValue } from "./session-display-title";
import type { SessionCandidate } from "./session-list";
import { candidatePathIndex, displayTitleFromSummary, rankSessionCandidates, streamSessionRows } from "./session-list";
import type { SessionStore } from "./store-surfaces";

const USED_SESSIONS_KEY = "history.laisoraSessions";
let usedSessions: Record<string, string> | undefined;
function usedSessionPaths(): Record<string, string> {
  return usedSessions ??= extensionContext?.globalState.get<Record<string, string>>(USED_SESSIONS_KEY, {}) ?? {};
}
export function rememberSession(session: Session): void {
  const id = session.resumeSessionId ?? session.auth?.sessionId;
  if (!id) return;
  if (!usedSessionPaths()[id]) {
    const ref = sessionTranscriptRef(session);
    if (ref) {
      usedSessionPaths()[ref.sessionId] = ref.file;
      void extensionContext?.globalState.update(USED_SESSIONS_KEY, { ...usedSessionPaths() }).then(undefined,
        error => output.appendLine(`[history] Could not save LAISORA session index: ${String(error)}`));
    }
  }
  void persistOpenTabs();
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
    return getLaisoraConfiguration().get<boolean>("restoreTabsOnStartup", true) !== false;
  } catch {
    return true;
  }
}

function openTabEntries(): PersistedOpenTab[] {
  const entries: PersistedOpenTab[] = [];
  const seen = new Set<string>();
  for (const s of store?.sessions.values() ?? []) {
    if (s.closed) continue;
    const sessionId = s.resumeSessionId ?? s.auth?.sessionId;
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const filePath = s.resumeSessionId && s.resumeFilePath ? s.resumeFilePath : usedSessionPaths()[sessionId];
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
    const entries = openTabEntries();
    const serialized = JSON.stringify(entries);
    if (serialized === lastPersistedOpenTabs) return Promise.resolve();
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
const historyPages = new Map<string, { token: number; candidates: SessionCandidate[] }>();

const originCache = new Map<string, "claude" | "unknown">();
async function historicalOrigin(file: string): Promise<"claude" | "unknown"> {
  const cached = originCache.get(file);
  if (cached) return cached;
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return "unknown";
  let origin: "claude" | "unknown" = "unknown";
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.type !== "user" && record.type !== "assistant") continue;
        if (typeof record.entrypoint !== "string") continue;
        origin = record.entrypoint === "cli" || record.entrypoint === "claude-vscode" ? "claude" : "unknown";
        break;
      } catch { }
    }
    originCache.set(file, origin);
  } catch { return "unknown"; } finally { await handle.close(); }
  return origin;
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

const initialTabTitles = new WeakMap<Session, { generation: number; title: string }>();

export function setInitialTabTitle(session: Session, title: string): void {
  session.title = title;
  session.autoTitled = true;
  initialTabTitles.set(session, { generation: session.logicalGeneration, title });
}

export function persistInitialTabTitle(session: Session): void {
  const initial = initialTabTitles.get(session);
  if (initial?.generation !== session.logicalGeneration || session.closed || session.clearing || session.titleRefreshing) return;
  session.titleRefreshing = true;
  void refreshTabTitle(session);
}

export async function refreshTabTitle(session: Session): Promise<void> {
  const sessionId = session.auth?.sessionId;
  const generation = session.logicalGeneration;
  try {
    if (!sessionId) return;
    rememberSession(session);
    const initial = initialTabTitles.get(session);
    if (initial?.generation === generation) {
      const ref = sessionTranscriptRef(session);
      if (!ref) return;
      let written: boolean;
      try {
        written = await queueRename(ref.sessionId, async () => {
          if (initialTabTitles.get(session) !== initial || session.logicalGeneration !== generation || session.closed) return false;
          await writeCustomTitle(ref.file, ref.sessionId, initial.title);
          return true;
        });
      } catch (error) {
        output.appendLine(`R-LRN-18: Could not save the research tab title: ${String(error)}`);
        return;
      }
      if (!written || session.logicalGeneration !== generation || session.closed) return;
      initialTabTitles.delete(session);
      session.titleRefreshed = true;
      return;
    }
    const summary = await sessionSummaryOf(sessionId);
    if (summary === undefined) return;
    if (session.logicalGeneration !== generation || session.closed) return;
    session.titleRefreshed = true;
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
  for (const session of store?.sessions.values() ?? []) rememberSession(session);
  const known = usedSessionPaths();
  const hidden = hiddenSessionIds();
  const source = options.source ?? "claude";
  const pageKey = `${source}:${options.showHidden === true}`;
  const savedPage = historyPages.get(pageKey);
  const cursorParts = options.cursor?.split(":").map(Number);
  const continuation = cursorParts && savedPage?.token === cursorParts[0] ? savedPage : undefined;
  const offset = continuation ? cursorParts![1] : 0;

  const degradation: SessionScanDegradation = {
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
  if (degradation.statFailed > 0) {
    output.appendLine(`[history] stat できないファイル ${degradation.statFailed} 件（候補から除外・req ${requestId}）`);
  }
  if (!continuation && options.source) {
    for (let i = 0; i < entries.length; i += 4) {
      await Promise.all(entries.slice(i, i + 4).map(async c => {
        if (!known[c.sessionId]) await historicalOrigin(c.filePath);
      }));
    }
  }
  const candidates = continuation ? entries : rankSessionCandidates(entries).filter(c =>
    (options.showHidden === true || !hidden.has(c.sessionId)) &&
    (!options.source || (source === "laisora"
      ? !!known[c.sessionId] || originCache.get(c.filePath) !== "claude"
      : !known[c.sessionId] && originCache.get(c.filePath) === "claude")));
  const token = continuation?.token ?? requestId;
  if (!continuation) historyPages.set(pageKey, {token, candidates});
  const pathBySessionId = candidatePathIndex(candidates);
  const scanDoneT = Date.now();
  output.appendLine(
    `[history] ${sinceActivation()} 候補 ${candidates.length} 件（走査 ${scanDoneT - listStartT}ms・req ${requestId}）`
  );

  let firstRowT = 0;
  let resolveStarts = 0;
  let firstResolveMs = -1;
  let rowsSent = 0;
  const { sent, scanned, nextIndex } = await streamSessionRows(
    candidates.slice(offset),
    pathBySessionId,
    async (c) => {
      if (options.showHidden !== true && hidden.has(c.sessionId)) return undefined;
      const first = ++resolveStarts === 1;
      const t = first ? Date.now() : 0;
      const info = await sessionInfoOf(c.sessionId, (err) => {
        degradation.resolveFailed++;
        if (degradation.resolveFailed === 1) {
          output.appendLine(`[history] 要約を解決できません: ${c.sessionId} — ${errText(err)}`);
        }
      });
      if (first) firstResolveMs = Date.now() - t;
      return info && typeof info.summary === "string" ? info : undefined;
    },
    (sessions: SessionListItem[], complete: boolean) => {
      rowsSent += sessions.length;
      if (complete && rowsSent === 0 && resolveStarts > 0) {
        degradation.unresolvedCandidates = candidates.length;
        output.appendLine(
          `[history] 候補 ${candidates.length} 件から 1 行も解決できません（req ${requestId}）`
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
        if (source === "laisora" && !known[row.sessionId]) row.originUnverified = true;
        if (hidden.has(row.sessionId)) row.hidden = true;
      }
      emit(sessions, false, degraded());
    }
  );
  emit([], true, degraded(), nextIndex === undefined ? undefined : `${token}:${offset + nextIndex}`);
  output.appendLine(
    `[history] ${sinceActivation()} 一覧完了 ${Date.now() - listStartT}ms（${sent}行 / 候補 ${scanned}件解決 / 走査 ${scanDoneT - listStartT}ms・req ${requestId}）`
  );
}

function writeCustomTitle(file: string, sessionId: string, title: string): Promise<void> {
  return appendSessionRecordOnFreshLine(file, sessionId, formatCustomTitleRecord(sessionId, title));
}

const renameQueues = new Map<string, Promise<void>>();
function queueRename<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const result = (renameQueues.get(sessionId) ?? Promise.resolve()).then(run);
  const tail = result.then(() => undefined, () => undefined);
  renameQueues.set(sessionId, tail);
  void tail.then(() => { if (renameQueues.get(sessionId) === tail) renameQueues.delete(sessionId); });
  return result;
}

function applyCustomTitle(st: SessionStore, s: Session, sessionId: string, title: string): void {
  s.title = displayTitleFromSummary(title, sessionId);
  initialTabTitles.delete(s);
  s.autoTitled = true;
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
  if (target === null) return refuse(l10n.t("/rename can be used once the session file is determined (try again after the first response)."));
  if (!renameTargetIsCurrent(s, target)) {
    output.appendLine(`[history] Dropped a rename for a session the tab no longer shows: ${target.ref.sessionId}`);
    if (s.closed) return { reason: "stale-rename-target" };
    return refuse(l10n.t("/rename: The name was not saved because the tab now shows another session."));
  }
  const { ref, generation } = target;
  const title = normalizeTitleValue(rawTitle);
  if (title === null) return refuse(l10n.t("Usage: /rename <new name>"));
  try {
    await writeCustomTitle(ref.file, ref.sessionId, title);
  } catch (error) {
    return refuse(l10n.t("/rename: Could not write to the session file ({0})", String(error)));
  }
  const shown = displayTitleFromSummary(title, ref.sessionId);
  if (!s.closed && s.logicalGeneration === generation) applyCustomTitle(st, s, ref.sessionId, title);
  st.post({ type: "sessionRenamed", sessionId: ref.sessionId, title: shown, ...(requestId !== undefined ? { requestId } : {}) });
  return { title };
}

function openSessionsOf(st: SessionStore, sessionId: string): Session[] {
  return [...st.sessions.values()].filter(s =>
    !s.closed && (s.resumeSessionId ?? s.auth?.sessionId) === sessionId && sessionTranscriptRef(s)?.sessionId === sessionId);
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
  const title = normalizeTitleValue(msg.title);
  if (title === null) { fail(l10n.t("Enter a name.")); return; }
  try {
    await writeCustomTitle(msg.filePath, msg.sessionId, title);
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
      const apiKeyPolicy = normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit"));
      const snapshot = await accountUsageFetcher.request(sender, {
        identity: JSON.stringify([claudeConfigDir(), apiKeyPolicy, target?.auth?.credentialSource ?? null, target?.auth?.apiKeySource ?? null]),
        ...(conversation ? { viaConversation: (signal: AbortSignal) => conversation.planUsageRateLimits(ACCOUNT_USAGE_TIMEOUT_MS, signal) } : {}),
        viaUsageCommand: (signal) =>
          rateLimitsViaUsageCommand({
            cwd: (target ? resolveSessionCwd(target) : undefined) ?? homedir(),
            apiKeyPolicy,
            signal,
            resolveExecutablePath: async () =>
              (await resolveClaudeCodeStartup(configuredClaudeExecutablePath(cfg), sdkClaudeCodeVersion())).executable.path,
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
        void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
        break;
      }
      try {
        let imageBytes: { mediaType: ImageAttachment["mediaType"]; data: string } | undefined;
        let fileKey = "";
        if (msg.ref) {
          const res = await resolveSessionImage(session, msg.ref);
          if ("error" in res) {
            void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
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
          void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
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
        void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
      }
      break;
    }
  }
}
