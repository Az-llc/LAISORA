import { getLaisoraConfiguration } from "./claude-settings";
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { configuredClaudeExecutablePath, inheritedProfile, resolveSessionCwd } from "./claude-settings";
import { claudeConfigDir } from "./claude-env";
import { resolveHandoffRuntime, type ClaudeConversation } from "./claudeHost";
import { openResumedSession, openSessionById } from "./resume-hydration";
import type { Session, StartMeasurement } from "./session";
import {
  handoffDecisionCounts,
  handoffDecisionLineCount,
  handoffContextUsageKey,
  handoffUnreadableLinesKey,
  type HandoffContextMeasurement,
  type HandoffContextUsage,
} from "./handoff-envelope";
import {
  HANDOFF_DETAIL_MAX_BYTES,
  HandoffRunner,
  buildHandoffDetailParts,
  extractHandoffDetail,
  parseHandoffRecords,
  shouldActivateForkTab,
  type HandoffDetail,
  type HandoffOutcome,
  type HandoffRecordsRead,
  COMPACT_HEARTBEAT_GRACE_MS,
} from "./handoff-runner";
import { extensionContext, output, store } from "./host-context";
import { liveBackgroundTasks, runningDelegationIds } from "./background-activity";
import { pendingAttachments } from "./pending-attachments";
import { buildHandoffNoticeEnvelope, handoffNoticeTitle } from "./steering-envelope";
import {
  CACHE_EXPIRY_MIN_TOTAL_TOKENS,
  HANDED_OFF_SOURCES_KEY,
  autoHandoffPermitted,
  handedOffSourcesOf,
  handoffOriginOf,
  postTurnMeasurement,
  rememberHandedOffSource,
  autoHandoffMemoryFor,
  currentAutoStart,
  noticedTurnEndCandidate,
  noteNoticeFromEvents,
  noteNoticeTurnInterrupted,
  cacheExpiryAutoStart,
  cacheExpiryDeadline,
  decisionPendingSinceUserSend,
  noteAutoHandoffRefused,
  activeNotice,
  autoStartDisplay,
  noteTurnEndAfterNotice,
  noticeTrigger,
  noteHandoffNoticeSent,
  handoffNoticeFactsOf,
  noteAutoHandoffStarted,
  heldCandidateStep,
  quietAutoRefusal,
  noteHandoffSettled,
  noteTurnCompleted,
  noteUserSend,
  planHasUnfinishedStep,
  resolveHandoffAutoSettings,
  sizeAutoStart,
  type AutoHandoffGateInput,
  type AutoHandoffMemory,
} from "./handoff-auto";
import {
  normalizeApiKeyPolicy,
  restoredHandoffRunId,
  type AssistantUsage,
  type HandoffAutoSettings,
  type HandoffAutoNotice,
  type HandoffAutoStart,
  type HostToWebview,
  type NormalizedEventBody,
  type WebviewToHost,
} from "./protocol";
import { lookupSessionFile } from "./session-files";
import { sessionRecordId } from "./session-record";
import { handoffForkStateOf, postSessionListChanged, sessionDisplayTitleOf } from "./session-list-wiring";
import type { SessionStore } from "./store-surfaces";
import { linkedTodoItemIdOf, relinkTodoConversation, todoHandoffMemo } from "./todo-surface";

export const handoffDetailSources = new Map<string, { runId: string; detail: HandoffDetail }>();

const handoffRuns = new Map<string, { runId: string; runner: HandoffRunner | null }>();

export function handoffPersist(): { get(k: string): unknown; update(k: string, v: unknown): Promise<void> } {
  return {
    get: (k) => extensionContext?.globalState.get(k),
    update: async (k, v) => {
      await extensionContext?.globalState.update(k, v);
    },
  };
}

export const handoffFs = {
  unlink: (p: string) => unlink(p),
  readFile: (p: string) => readFile(p, "utf8"),
};

async function writeHandoffDiagnostic(name: string, text: string): Promise<string> {
  const dir = join(claudeConfigDir(), "laisora-handoff-diagnostics");
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, text, "utf8");
  return p;
}

export async function readHandoffRecords(filePath: string): Promise<HandoffRecordsRead> {
  return parseHandoffRecords(await readFile(filePath, "utf8"));
}

async function runHandoff(st: SessionStore, sender: vscode.Webview | null, target: Session, auto?: HandoffAutoStart | HandoffAutoNotice): Promise<boolean | undefined> {
  const runId = randomUUID();
  const profile = inheritedProfile(target);
  const source = { sessionId: sessionRecordId(target) ?? "", title: target.title };
  const fail = (reason: string, detail?: string, tabId: string = target.tabId): void => {
    st.post({
      type: "handoffStatus",
      tabId,
      runId,
      state: "failed",
      reason,
      detail,
      message:
        reason === "tab_failed"
          ? l10n.t("The handoff was already created. You can open it from the history.")
          : l10n.t("Handoff aborted ({0})", `${reason}${detail === undefined ? "" : `: ${detail}`}`),
      source,
    });
  };
  const busy = (): boolean => (target.conversation?.state ?? "idle") !== "idle";
  const sourceConversation = target.conversation;
  const sourceGeneration = target.logicalGeneration;
  const contextUsage: HandoffContextUsage = { before: null, after: "pending" };
  let snapshotWrite: Promise<void> = Promise.resolve();
  let snapshotPending = false;

  const refuse = (reason: string): undefined => {
    if (quietAutoRefusal(auto !== undefined, reason)) output.appendLine(`[${target.title}] automatic handoff not started: ${reason}`);
    else fail(reason);
    return undefined;
  };
  if (busy()) return refuse("source_busy");
  if (handoffRuns.has(target.tabId)) return refuse("already_running");
  const reservation: { runId: string; runner: HandoffRunner | null } = { runId, runner: null };
  handoffRuns.set(target.tabId, reservation);
  try {
    if (source.sessionId.length === 0) {
      fail("fork_failed", "no_session_id");
      return false;
    }
    const cfg = getLaisoraConfiguration();
    const cwd = resolveSessionCwd(target);
    if (cwd === undefined) {
      fail("fork_failed", "no_cwd");
      return false;
    }
    let runtime: Awaited<ReturnType<typeof resolveHandoffRuntime>>;
    try {
      runtime = await resolveHandoffRuntime(
        configuredClaudeExecutablePath(cfg),
        normalizeApiKeyPolicy(cfg.get<string>("claude.apiKeyPolicy")!)
      );
    } catch (e) {
      fail("fork_failed", String(e));
      return false;
    }

    const runner = new HandoffRunner({
      sdk: runtime.sdk,
      cwd,
      claudeExecutablePath: runtime.claudeExecutablePath,
      env: runtime.env,
      model: profile.model ?? undefined,
      effort: profile.effort ?? undefined,
      settingSources: cfg.get<Array<"user" | "project" | "local">>("claude.settingSources")!,
      lookupSessionFileById: async (id) => lookupSessionFile(id),
      readRecords: readHandoffRecords,
      fs: handoffFs,
      writeDiagnostic: writeHandoffDiagnostic,
      persist: handoffPersist(),
      now: () => Date.now(),
      timeoutMs: COMPACT_HEARTBEAT_GRACE_MS,
      log: (line) => output.appendLine(`[${target.title}] ${line}`),
      onPhase: (phase) => {
        st.post({
          type: "handoffStatus",
          tabId: target.tabId,
          runId,
          state: "running",
          phase,
          message: l10n.t("Handing off"),
          source,
          ...(auto === undefined ? {} : { auto }),
        });
      },
      onForkCreated: (forkSessionId) => {
        snapshotPending = true;
        snapshotWrite = handoffPersist().update(handoffContextUsageKey(forkSessionId), { ...contextUsage }).catch((error) =>
          output.appendLine("[handoff] context snapshot could not be saved: " + String(error))).finally(() => { snapshotPending = false; });
      },
      onProgress: (info) => {
        st.post({
          type: "handoffStatus",
          tabId: target.tabId,
          runId,
          state: "running",
          phase: info.phase,
          progress: { heartbeats: info.heartbeats, elapsedMs: info.elapsedMs, since: info.since },
          message: l10n.t("Handing off"),
          source,
          ...(auto === undefined ? {} : { auto }),
        });
      },
    });
    reservation.runner = runner;
    try {
      source.title = (await sessionDisplayTitleOf(source.sessionId)) ?? source.title;
    } catch (error) {
      output.appendLine(`[${target.title}] handoff source title unresolved; using tab title: ${String(error)}`);
    }
    const sourceUnchanged = (): boolean =>
      !target.closed && target.conversation === sourceConversation && target.logicalGeneration === sourceGeneration;
    const before = sourceUnchanged() ? await sourceConversation?.captureHandoffContextUsage() ?? null : null;
    contextUsage.before = sourceUnchanged() ? before : null;
    const workMemo = await todoHandoffMemo(source.sessionId);
    if (busy()) return refuse("source_busy");
    const outcome: HandoffOutcome = await runner.run({
      sourceSessionId: source.sessionId,
      sourceTitle: source.title,
      runId,
      sourceBusy: busy,
      ...(workMemo !== undefined ? { workMemo } : {}),
    });
    if (!outcome.ok && quietAutoRefusal(auto !== undefined, outcome.reason)) return undefined;
    if (!outcome.ok) {
      const forkSessionId = outcome.forkSessionId;
      if (forkSessionId !== undefined && handoffForkStateOf(forkSessionId, Date.now()) === "cleanup_failed") postSessionListChanged();
      if (forkSessionId !== undefined && (await lookupSessionFile(forkSessionId)).reason === "not_found") {
        void snapshotWrite.then(() => handoffPersist().update(handoffContextUsageKey(forkSessionId), undefined)).catch((error) =>
          output.appendLine("[handoff] context snapshot could not be removed: " + String(error)));
      }
      fail(outcome.reason, outcome.detail);
      return false;
    }
    const contextUsageKey = handoffContextUsageKey(outcome.forkSessionId);
    if (outcome.unreadableLineCount > 0) {
      void handoffPersist().update(handoffUnreadableLinesKey(outcome.forkSessionId), outcome.unreadableLineCount).catch((error) =>
        output.appendLine("[handoff] unreadable line count could not be saved: " + String(error)));
    }
    await rememberHandedOff(source.sessionId);
    await relinkTodoConversation(source.sessionId, outcome.forkSessionId);
    const startMeasurement = createStartMeasurement();
    const opened = await openResumedSession(st, {
      sessionId: outcome.forkSessionId,
      filePath: outcome.forkFilePath,
      activate: shouldActivateForkTab(sender === null ? undefined : st.activeTabIdOf(sender), target.tabId),
      inherit: profile,
      knownCwd: cwd,
      startMeasurement,
    });
    if (!opened.tabPosted || opened.session === undefined) {
      startMeasurement.abandon();
      fail("tab_failed");
      return false;
    }
    const forkSession = opened.session;
    const decisions = outcome.detail?.decisions;
    forkSession.handoffSource = {
      contextUsage,
      sessionId: source.sessionId,
      title: source.title,
      ...(outcome.compact !== undefined ? { compact: outcome.compact } : {}),
      utteranceCount: outcome.utteranceCount,
      ...(outcome.unreadableLineCount > 0 ? { unreadableLineCount: outcome.unreadableLineCount } : {}),
      ...(decisions !== undefined
        ? { decisionCount: handoffDecisionLineCount(decisions), decisions: handoffDecisionCounts(decisions) }
        : {}),
      detailRunId: restoredHandoffRunId(outcome.forkSessionId),
    };
    if (outcome.unreadableLineCount > 0) {
      output.appendLine(`[handoff] ${runId} F の ${outcome.unreadableLineCount} 行を JSON として読めなかった（逐語が欠けている可能性）`);
    }
    const done = {
      type: "handoffStatus",
      runId,
      state: "done",
      contextUsage,
      ...(decisions !== undefined ? { decisions: handoffDecisionCounts(decisions) } : {}),
      message:
        outcome.unreadableLineCount > 0
          ? l10n.t(
              "Handoff complete ({0} lines of the record could not be read; some messages may be missing)",
              outcome.unreadableLineCount
            )
          : l10n.t("Handoff complete"),
      source,
      fork: { sessionId: outcome.forkSessionId, tabId: forkSession.tabId, title: forkSession.title },
      ...(outcome.compact !== undefined ? { compact: outcome.compact } : {}),
      utteranceCount: outcome.utteranceCount,
      ...(outcome.unreadableLineCount > 0 ? { unreadableLineCount: outcome.unreadableLineCount } : {}),
    } as const;
    if (outcome.detail !== undefined) {
      handoffDetailSources.set(forkSession.tabId, { runId, detail: outcome.detail });
    }
    st.post({ ...done, tabId: target.tabId });
    st.post({ ...done, tabId: forkSession.tabId });
    const generation = forkSession.logicalGeneration;
    void settleHandoffContextUsage(startMeasurement, contextUsage).then(async () => {
      if (!target.closed) st.post({ ...done, tabId: target.tabId });
      if (forkSession.logicalGeneration === generation && !forkSession.closed) st.post({ ...done, tabId: forkSession.tabId });
      const saveFinal = async (): Promise<void> => {
        await handoffPersist().update(contextUsageKey, { ...contextUsage });
      };
      if (snapshotPending) {
        void snapshotWrite.then(saveFinal).catch((error) =>
          output.appendLine("[handoff] context snapshot could not be saved: " + String(error)));
      }
      await saveFinal();
    }).catch((error) => {
      output.appendLine("[handoff] context snapshot could not be saved: " + String(error));
      if (forkSession.logicalGeneration === generation && !forkSession.closed) st.post({ ...done, tabId: forkSession.tabId });
    });
    return true;
  } catch (e) {
    fail("commit_failed", String(e));
    return false;
  } finally {
    if (handoffRuns.get(target.tabId)?.runId === runId) handoffRuns.delete(target.tabId);
  }
}

const handoffDetailRestores = new Map<string, Promise<{ runId: string; detail: HandoffDetail } | undefined>>();

async function restoreHandoffDetailSource(
  st: SessionStore,
  tabId: string,
  runId: string,
  cachedRunId: boolean
): Promise<{ runId: string; detail: HandoffDetail } | undefined> {
  const session = st.sessions.get(tabId);
  const forkSessionId = session?.resumeSessionId;
  if (session === undefined || forkSessionId === undefined || session.resumeFilePath === undefined) return undefined;
  if (!cachedRunId && runId !== restoredHandoffRunId(forkSessionId)) return undefined;
  const key = `${tabId}\u0000${runId}`;
  const inFlight = handoffDetailRestores.get(key);
  if (inFlight !== undefined) return inFlight;
  const filePath = session.resumeFilePath;
  const started = (async () => {
    let detail: HandoffDetail | undefined;
    try {
      detail = extractHandoffDetail((await readHandoffRecords(filePath)).records, forkSessionId);
    } catch (error) {
      output.appendLine(`[handoff] detail restore failed: ${forkSessionId}: ${String(error)}`);
      return undefined;
    }
    if (detail === undefined) return undefined;
    const entry = { runId, detail };
    handoffDetailSources.set(tabId, entry);
    output.appendLine(`[handoff] detail restored from record: ${forkSessionId}`);
    return entry;
  })().finally(() => {
    handoffDetailRestores.delete(key);
  });
  handoffDetailRestores.set(key, started);
  return started;
}

async function sendHandoffDetailPart(
  st: SessionStore,
  sender: vscode.Webview,
  tabId: string,
  runId: string,
  part: number,
  refresh: boolean
): Promise<void> {
  const empty: Extract<HostToWebview, { type: "handoffDetail" }> = {
    type: "handoffDetail",
    tabId,
    runId,
    part,
    total: 0,
    utterances: [],
  };
  const cached = handoffDetailSources.get(tabId);
  const hit = cached?.runId === runId ? cached : undefined;
  const sourceRef = hit !== undefined && !refresh
    ? hit
    : await restoreHandoffDetailSource(st, tabId, runId, hit !== undefined) ?? hit;
  if (sourceRef === undefined) {
    await st.postTo(sender, empty);
    return;
  }
  const base = jsonByteLength({ type: "handoffDetail", tabId, runId, part, total: 0, utterances: [] });
  const parts = buildHandoffDetailParts(
    sourceRef.detail.summary,
    sourceRef.detail.utterances,
    HANDOFF_DETAIL_MAX_BYTES - base,
    sourceRef.detail.decisions
  );
  const chunk = parts[part];
  if (chunk === undefined) {
    await st.postTo(sender, { ...empty, total: parts.length });
    return;
  }
  await st.postTo(sender, {
    type: "handoffDetail",
    tabId,
    runId,
    part,
    total: parts.length,
    ...(chunk.summary !== undefined ? { summary: chunk.summary } : {}),
    ...(chunk.decisions !== undefined ? { decisions: chunk.decisions } : {}),
    utterances: chunk.utterances,
  });
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function openHandoffSourceSession(
  st: SessionStore,
  sender: vscode.Webview,
  origin: Session,
  sourceSessionId: string
): Promise<void> {
  const opened = await openSessionById(st, sender, sourceSessionId);
  if (opened === "not_found") {
    output.appendLine(`[handoff] source not found: ${sourceSessionId}`);
    origin.pushEvent({
      kind: "error",
      message: l10n.t("LAISORA: The previous conversation was not found ({0}).", sourceSessionId),
      fatal: false,
    });
  } else if (opened === "scan_failed") {
    origin.pushEvent({
      kind: "error",
      message: l10n.t("LAISORA: Could not check the previous conversation's record. Please try again."),
      fatal: false,
    });
  }
}

export async function handleHandoffMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "startHandoff" | "getHandoffDetail" | "cancelHandoff" | "openHandoffSource" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "startHandoff": {
      const generation = target!.logicalGeneration;
      const completed = await runHandoff(st, sender, target!);
      if (completed !== undefined) noteAutoHandoffSettled(target!, completed, generation);
      break;
    }
    case "getHandoffDetail":
      await sendHandoffDetailPart(st, sender, target!.tabId, msg.runId, msg.part, msg.refresh === true);
      break;
    case "cancelHandoff": {
      const active = handoffRuns.get(target!.tabId);
      if (active?.runId === msg.runId && active.runner?.cancel()) {
        st.post({
          type: "handoffStatus",
          tabId: target!.tabId,
          runId: msg.runId,
          state: "failed",
          reason: "cancelled",
          message: l10n.t("Cancelled"),
          source: { sessionId: sessionRecordId(target!) ?? "", title: target!.title },
        });
      }
      break;
    }
    case "openHandoffSource":
      await openHandoffSourceSession(st, sender, target!, msg.sourceSessionId);
      break;
  }
}

const INITIAL_CONTEXT_USAGE_WAIT_MS = 10_000;

export async function initialContextUsageWithin(
  conversation: Pick<ClaudeConversation, "initialContextUsage">
): Promise<HandoffContextMeasurement | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      conversation.initialContextUsage,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), INITIAL_CONTEXT_USAGE_WAIT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createStartMeasurement(): StartMeasurement {
  let pending = true;
  let resolve!: (value: HandoffContextMeasurement | null | undefined) => void;
  const result = new Promise<HandoffContextMeasurement | null | undefined>((r) => { resolve = r; });
  const settle = (value: HandoffContextMeasurement | null | undefined): void => {
    if (!pending) return;
    pending = false;
    resolve(value);
  };
  return {
    get pending() { return pending; },
    result,
    async measure(conversation) {
      void initialContextUsageWithin(conversation).then(settle);
      await result;
    },
    abandon: () => settle(undefined),
  };
}

export async function settleHandoffContextUsage(measurement: StartMeasurement, usage: HandoffContextUsage): Promise<void> {
  const after = await measurement.result;
  if (after === undefined) delete usage.after;
  else usage.after = after;
}

interface AutoHandoffTab {
  memory: AutoHandoffMemory;
  turnEnded: boolean;
  candidate?: HandoffAutoStart;
  heldByBackground: boolean;
  response?: { at: number; usage: AssistantUsage };
  lastUserSendAt?: number;
  usage?: { totalTokens: number; autoCompactThreshold?: number };
  noticeTurn?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const NOTICE_TURN_PENDING = "";
const autoHandoffTabs = new WeakMap<Session, AutoHandoffTab>();
const composerDraftTabs = new Map<vscode.Webview, ReadonlySet<string>>();

function autoHandoffTab(s: Session): AutoHandoffTab {
  const current = autoHandoffTabs.get(s);
  if (current !== undefined && current.memory.generation === s.logicalGeneration) return current;
  if (current !== undefined) clearAutoHandoffWait(current);
  const fresh: AutoHandoffTab = { memory: autoHandoffMemoryFor(undefined, s.logicalGeneration), turnEnded: false, heldByBackground: false };
  autoHandoffTabs.set(s, fresh);
  return fresh;
}

function clearAutoHandoffWait(tab: AutoHandoffTab): void {
  if (tab.timer !== undefined) clearTimeout(tab.timer);
  tab.timer = undefined;
  tab.candidate = undefined;
  tab.heldByBackground = false;
}

export function clearAutoHandoff(s: Session): void {
  const tab = autoHandoffTabs.get(s);
  if (tab === undefined) return;
  clearAutoHandoffWait(tab);
  tab.turnEnded = false;
}

function readAutoHandoffSettings(): HandoffAutoSettings {
  const cfg = getLaisoraConfiguration();
  return resolveHandoffAutoSettings((key) => cfg.get<unknown>(key));
}

function composerHasText(tabId: string): boolean {
  for (const tabIds of composerDraftTabs.values()) if (tabIds.has(tabId)) return true;
  return pendingAttachments.count(tabId) > 0;
}

function handedOffSources(): string[] {
  return handedOffSourcesOf(handoffPersist().get(HANDED_OFF_SOURCES_KEY));
}

async function rememberHandedOff(sessionId: string): Promise<void> {
  try {
    const { list, dropped } = rememberHandedOffSource(handoffPersist().get(HANDED_OFF_SOURCES_KEY), sessionId);
    if (dropped.length > 0) output.appendLine(`[handoff] handed-off source list is full; dropped ${dropped.length} oldest: ${dropped.join(", ")}`);
    await handoffPersist().update(HANDED_OFF_SOURCES_KEY, list);
  } catch (error) {
    output.appendLine(`[handoff] handed-off source could not be saved: ${String(error)}`);
  }
}

function autoHandoffPermittedFor(s: Session, tab: AutoHandoffTab): boolean {
  return autoHandoffPermitted(tab.memory, sessionRecordId(s), handedOffSources());
}

function autoHandoffGateOf(s: Session): AutoHandoffGateInput {
  const conv = s.conversation;
  return {
    idle: conv !== null && !conv.isClosed && conv.state === "idle" && s.starting === null && !s.closed && !s.clearing
      && s.hydration?.buffering !== true,
    runningAgents: runningDelegationIds(s.backgroundActivity).length,
    runningBackgroundTasks: liveBackgroundTasks(s.backgroundActivity).length,
    runningExternalRuns: conv?.runningExternalRunCount ?? 0,
    queuedMessages: (conv?.queuedInputCount ?? 0) + s.unsentSends.size,
    composerHasText: composerHasText(s.tabId),
    handoffRunning: handoffRuns.has(s.tabId),
  };
}

function unfinishedWorkOf(s: Session): boolean {
  return planHasUnfinishedStep(s.evidenceIndex.timeBuckets.blocks) || decisionPendingSinceUserSend(s.events);
}

function tryAutoHandoff(s: Session): void {
  const tab = autoHandoffTab(s);
  const candidate = tab.candidate;
  const st = store;
  if (candidate === undefined || st === null) return;
  tab.memory = noteNoticeFromEvents(tab.memory, s.events);
  const now = Date.now();
  const notice = activeNotice(tab.memory, now);
  const start = autoHandoffPermittedFor(s, tab)
    ? currentAutoStart(candidate, {
      settings: readAutoHandoffSettings(),
      usage: tab.usage ?? {},
      origin: handoffOriginOf(s.handoffSource),
      noticeSent: notice !== undefined,
      now,
    })
    : undefined;
  if (start === undefined) {
    clearAutoHandoffWait(tab);
    return;
  }
  const step = heldCandidateStep(tab.heldByBackground, autoHandoffGateOf(s));
  if (step.action === "hold") {
    tab.heldByBackground = step.heldByBackground;
    return;
  }
  if (step.action === "drop") {
    output.appendLine(`[${s.title}] automatic handoff deferred to the next turn end: background work finished`);
    clearAutoHandoffWait(tab);
    return;
  }
  clearAutoHandoffWait(tab);
  if (notice === undefined) {
    sendAutoHandoffNotice(s, tab, start);
    return;
  }
  tab.memory = noteAutoHandoffStarted(tab.memory);
  output.appendLine(`[${s.title}] automatic handoff: ${JSON.stringify(start)}`);
  const generation = s.logicalGeneration;
  void runHandoff(st, st.activeWebview, s, autoStartDisplay(start, notice, handoffNoticeTitle)).then((completed) => {
    if (completed !== undefined) noteAutoHandoffSettled(s, completed, generation);
    else if (s.logicalGeneration === generation) autoHandoffTab(s).memory = noteAutoHandoffRefused(autoHandoffTab(s).memory);
  }).catch((error: unknown) => output.appendLine(`[${s.title}] automatic handoff failed: ${String(error)}`));
}

function sendAutoHandoffNotice(s: Session, tab: AutoHandoffTab, start: HandoffAutoStart): void {
  const conv = s.conversation;
  const facts = handoffNoticeFactsOf(start, linkedTodoItemIdOf(s));
  if (facts === undefined) {
    output.appendLine(`[${s.title}] automatic handoff notice not sent: no cache expiry time`);
    return;
  }
  tab.noticeTurn = NOTICE_TURN_PENDING;
  const result = conv === null || conv.isClosed
    ? { ok: false as const, reason: "closed", message: "handoff notice: the conversation is not connected" }
    : conv.sendHandoffNotice(buildHandoffNoticeEnvelope(facts, Date.now()), facts);
  if (!result.ok) {
    tab.noticeTurn = undefined;
    output.appendLine(`[${s.title}] automatic handoff notice not sent: ${result.reason} ${result.message}`);
    return;
  }
  tab.memory = noteHandoffNoticeSent(tab.memory, facts, Date.now());
  output.appendLine(`[${s.title}] automatic handoff notice sent: ${JSON.stringify(facts)}`);
}

function noteAutoHandoffSettled(s: Session, completed: boolean, generation: number): void {
  if (s.logicalGeneration !== generation) return;
  const tab = autoHandoffTab(s);
  clearAutoHandoffWait(tab);
  tab.memory = noteHandoffSettled(tab.memory, completed);
}

function evaluateAutoHandoff(s: Session, tab: AutoHandoffTab, usage: Extract<NormalizedEventBody, { kind: "context_usage" }>): void {
  clearAutoHandoffWait(tab);
  tab.usage = { totalTokens: usage.totalTokens, ...(usage.autoCompactThreshold === undefined ? {} : { autoCompactThreshold: usage.autoCompactThreshold }) };
  tab.memory = noteNoticeFromEvents(tab.memory, s.events);
  if (!autoHandoffPermittedFor(s, tab)) return;
  const notice = activeNotice(tab.memory, Date.now());
  if (notice !== undefined) {
    tab.candidate = noticedTurnEndCandidate(noticeTrigger(notice), usage, cacheExpiryDeadline(tab.response)?.expiresAt);
    tryAutoHandoff(s);
    if (tab.candidate === undefined && autoHandoffPermittedFor(s, tab)) armCacheExpiryTimer(s, tab, usage.totalTokens);
    return;
  }
  const settings = readAutoHandoffSettings();
  const size = sizeAutoStart(settings, usage, handoffOriginOf(s.handoffSource));
  if (size !== undefined) {
    tab.candidate = size;
    tryAutoHandoff(s);
    return;
  }
  armCacheExpiryTimer(s, tab, usage.totalTokens);
}

function armCacheExpiryTimer(s: Session, tab: AutoHandoffTab, totalTokens: number): void {
  const settings = readAutoHandoffSettings();
  const deadline = cacheExpiryDeadline(tab.response);
  if (!settings.cacheExpiryEnabled || deadline === undefined || totalTokens < CACHE_EXPIRY_MIN_TOTAL_TOKENS || tab.timer !== undefined) return;
  tab.timer = setTimeout(() => {
    tab.timer = undefined;
    if (s.closed || autoHandoffTabs.get(s) !== tab || s.logicalGeneration !== tab.memory.generation) return;
    const start = cacheExpiryAutoStart({
      settings: readAutoHandoffSettings(),
      totalTokens: tab.usage?.totalTokens,
      response: tab.response,
      lastUserSendAt: tab.lastUserSendAt,
      unfinishedWork: unfinishedWorkOf(s),
      now: Date.now(),
    });
    if (start === undefined) return;
    tab.candidate = start;
    tryAutoHandoff(s);
  }, Math.max(0, deadline.at - Date.now()));
}

function noteNoticeTurnEnded(s: Session, tab: AutoHandoffTab, turnId: string | undefined, interrupted: boolean): void {
  if (tab.noticeTurn === undefined || (turnId !== undefined && tab.noticeTurn !== turnId)) return;
  tab.noticeTurn = undefined;
  if (!interrupted) return;
  tab.memory = noteNoticeTurnInterrupted(tab.memory);
  output.appendLine(`[${s.title}] automatic handoff off for this conversation: the notice turn did not complete`);
}

export function noteAutoHandoffEvent(s: Session, ev: NormalizedEventBody): void {
  const tab = autoHandoffTab(s);
  switch (ev.kind) {
    case "assistant_usage":
      if (ev.parentToolUseId === null) {
        const at = s.conversation?.lastRootMessageStartedAt;
        tab.response = at === undefined ? undefined : { at, usage: ev.usage };
      }
      return;
    case "turn_started":
      if (tab.noticeTurn === NOTICE_TURN_PENDING) tab.noticeTurn = ev.turnId;
      tab.turnEnded = false;
      clearAutoHandoffWait(tab);
      return;
    case "turn_completed":
      noteNoticeTurnEnded(s, tab, ev.turnId, false);
      tab.memory = noteTurnEndAfterNotice(tab.memory, Date.now());
      tab.turnEnded = true;
      tab.memory = noteTurnCompleted(tab.memory);
      return;
    case "turn_failed":
    case "turn_interrupted":
      noteNoticeTurnEnded(s, tab, ev.turnId, true);
      tab.turnEnded = false;
      clearAutoHandoffWait(tab);
      return;
    case "conversation_opened":
    case "conversation_closed":
      noteNoticeTurnEnded(s, tab, undefined, true);
      tab.turnEnded = false;
      clearAutoHandoffWait(tab);
      return;
    case "context_usage": {
      const conv = s.conversation;
      if (tab.turnEnded && conv !== null && conv.state === "idle") {
        if (!postTurnMeasurement(conv.contextUsageTurnsEnded, conv.turnsEnded)) return;
        tab.turnEnded = false;
        evaluateAutoHandoff(s, tab, ev);
      } else {
        tryAutoHandoff(s);
      }
      return;
    }
    default:
      tryAutoHandoff(s);
  }
}

export function noteAutoHandoffUserSend(s: Session): void {
  const tab = autoHandoffTab(s);
  tab.lastUserSendAt = Date.now();
  tab.memory = noteUserSend(tab.memory);
  tab.turnEnded = false;
  clearAutoHandoffWait(tab);
}

export function noteComposerDrafts(sender: vscode.Webview, tabIds: readonly string[] | null): void {
  if (tabIds === null) composerDraftTabs.delete(sender);
  else composerDraftTabs.set(sender, new Set(tabIds));
  for (const s of store?.sessions.values() ?? []) tryAutoHandoff(s);
}
