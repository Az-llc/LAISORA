import { configuredApiKeyPolicy, getLaisoraConfiguration } from "./claude-settings";
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { formatHandoffTokens } from "./handoff-format";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { configuredClaudeExecutablePath, inheritedProfile, launchFolderMissing, resolveSessionCwd } from "./claude-settings";
import { claudeConfigDir } from "./claude-env";
import { transcriptRetentionSettings } from "./transcript-retention";
import { resolveHandoffRuntime, type ClaudeConversation } from "./claudeHost";
import { signalWaitNotify } from "./wait-notify-signal";
import { abandonWaitNotifyCarry, dropWaitNotifyEpisode, noteWaitNotifyCarryTurn, seedWaitNotifyCarry, skipWaitNotifyCarry, waitNotifyCarryOf, waitNotifyPushToolOf } from "./wait-notify-wiring";
import { WAIT_NOTIFY_CARRY_INSTRUCTION, waitNotifyCarrySkip } from "./wait-notify";
import { requestRemoteControlAuto } from "./remote-control-wiring";
import { waitNotifySettings } from "./gateway-host-actions";
import type { LaisoraInput } from "./laisora-input";
import { openResumedSession, openSessionById } from "./resume-hydration";
import { launchingOrTurnRunning, turnRunning, type Session, type StartMeasurement } from "./session";
import {
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
  handoffSourceBusy,
  parseHandoffRecords,
  forkTabActivationTargets,
  type HandoffDetail,
  type HandoffOutcome,
  type HandoffRecordsRead,
  COMPACT_HEARTBEAT_GRACE_MS,
} from "./handoff-runner";
import { extensionContext, output, store } from "./host-context";
import { handoffInProgress, handoffRuns, type HandoffRunReservation } from "./handoff-runs";
import { judgeTranscriptWriteLock } from "./transcript-write-lock";
import { liveBackgroundTasks, runningDelegationIds } from "./background-activity";
import { pendingAttachments } from "./pending-attachments";
import { buildHandoffNoticeEnvelope, handoffContinueMessage, handoffNoticeTitle } from "./steering-envelope";
import { continuedWorkSummaryAfterSend } from "./closing-summary";
import {
  CACHE_EXPIRY_MIN_TOTAL_TOKENS,
  HANDED_OFF_SOURCES_KEY,
  autoHandoffPermitted,
  autoHandoffGateOpen,
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
  continueAfterHandoff,
  continueMissedLineShown,
  decisionPendingSinceUserSend,
  handoffContinueBlock,
  type HandoffContinueBlock,
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
  sizeAutoDecision,
  sourceTabCloseBlock,
  type AutoHandoffGateInput,
  type BackgroundWork,
  type CliActivity,
  type AutoHandoffMemory,
} from "./handoff-auto";
import {
  restoredHandoffRunId,
  type AssistantUsage,
  type HandoffAutoSettings,
  type HandoffAutoNotice,
  type HandoffAutoStart,
  type HostToWebview,
  type WaitReportItem,
  type NormalizedEventBody,
  type WebviewToHost,
} from "./protocol";
import { lookupSessionFile } from "./session-files";
import { sessionRecordId } from "./session-record";
import { handoffContextFiles, handoffRegistryFiles, type HandoffContextStore, type HandoffRegistry, type LegacyMemento } from "./state-files";
import { handoffForkStateOf, postSessionListChanged, sessionDisplayTitleOf } from "./session-list-wiring";
import { closeConversationTab, type SessionStore } from "./store-surfaces";
import { linkedTodoItemIdOf, relinkTodoConversation, todoHandoffMemo } from "./todo-surface";

export const handoffDetailSources = new Map<string, { runId: string; detail: HandoffDetail }>();

function postHandoffSendLock(st: SessionStore, tabId: string): void {
  st.post({ type: "handoffSendLock", tabId, locked: handoffInProgress(tabId) });
}

export function handoffPersist(): LegacyMemento {
  return {
    get: (k) => extensionContext?.globalState.get(k),
    update: async (k, v) => {
      await extensionContext?.globalState.update(k, v);
    },
  };
}

export function globalStorageRoot(): string | undefined {
  return extensionContext?.globalStorageUri?.fsPath;
}

export function handoffRegistry(): HandoffRegistry {
  return handoffRegistryFiles(globalStorageRoot());
}

export function handoffContextUsage(): HandoffContextStore {
  return handoffContextFiles(globalStorageRoot(), handoffPersist(), handoffContextUsageKey);
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

const autoFolderMissingShown = new WeakMap<Session, string>();
const sourceActivity = new WeakMap<Session, number>();

type DestinationSend = ({ sent: true; turnId: string | null } | { sent: false; reason: HandoffContinueBlock | "rejected" }) & { settingOn: boolean };

async function settleDestinationStart(fork: Session, firstStartSucceeded: boolean): Promise<void> {
  while (firstStartSucceeded && fork.starting) await fork.starting;
}

async function sendToHandoffDestination(fork: Session, generation: number, firstStartSucceeded: boolean, settingOn: () => boolean, compose: () => { input: LaisoraInput; text: string }): Promise<DestinationSend> {
  await settleDestinationStart(fork, firstStartSucceeded);
  const conv = fork.conversation;
  const forkSessionId = sessionRecordId(fork);
  const setting = settingOn();
  const blockOf = (): HandoffContinueBlock | undefined => handoffContinueBlock({
    firstStartSucceeded,
    settingOn: setting,
    sameGeneration: fork.logicalGeneration === generation,
    handedOff: forkSessionId !== undefined && handedOffSources().includes(forkSessionId),
    gate: autoHandoffGateOf(fork),
    turnsEnded: fork.conversation?.turnsEnded ?? 0,
  });
  const block = blockOf();
  if (block !== undefined || conv === null) return { sent: false, reason: block ?? "gate_closed", settingOn: setting };
  const message = compose();
  let lateBlock: HandoffContinueBlock | undefined;
  const sent = await conv.sendAutomatic(message.input, () => {
    lateBlock = blockOf();
    return lateBlock === undefined ? message.text : undefined;
  });
  return sent ? { sent: true, turnId: conv.runningTurnId, settingOn: setting } : { sent: false, reason: lateBlock ?? "rejected", settingOn: setting };
}

async function sendHandoffContinue(fork: Session, generation: number, firstStartSucceeded: boolean, todoItemId: string | undefined): Promise<boolean> {
  let settings: HandoffAutoSettings | undefined;
  let input: LaisoraInput | undefined;
  const result = await sendToHandoffDestination(fork, generation, firstStartSucceeded, () => (settings = readAutoHandoffSettings()).continueWork, () => {
    const message = handoffContinueMessage(todoItemId, settings ?? readAutoHandoffSettings());
    input = message.input;
    return message;
  });
  if (continuedWorkSummaryAfterSend({ sent: result.sent, sameGeneration: fork.logicalGeneration === generation, input })) fork.continuedWorkSummary = true;
  output.appendLine(result.sent
    ? `[${fork.title}] continuation after the automatic handoff sent`
    : `[${fork.title}] continuation after the automatic handoff not sent: ${result.reason}`);
  if (continueMissedLineShown({ settingOn: result.settingOn, sent: result.sent, sameGeneration: fork.logicalGeneration === generation, closed: fork.closed })) {
    fork.pushEvent({ kind: "local_command_output", text: l10n.t("LAISORA could not ask Claude to continue the unfinished work after the automatic handoff."), uuid: randomUUID() }, undefined, { timestamp: Date.now() });
  }
  return result.sent;
}

async function sendWaitNotifyCarry(fork: Session, generation: number, firstStartSucceeded: boolean, items: readonly WaitReportItem[], continued: boolean): Promise<void> {
  await settleDestinationStart(fork, firstStartSucceeded);
  const skipOf = () => waitNotifyCarrySkip({
    continued,
    settingOn: waitNotifySettings().enabled,
    pushTool: waitNotifyPushToolOf(fork),
    transcriptWriteLocked: fork.transcriptWriteLocked,
  });
  const skip = skipOf();
  if (skip !== undefined) {
    output.appendLine(`[${fork.title}] mobile notification carried over from the handoff skipped: ${skip}`);
    return;
  }
  seedWaitNotifyCarry(fork, items);
  let result: DestinationSend;
  let lateSkip: ReturnType<typeof skipOf>;
  try {
    result = await sendToHandoffDestination(fork, generation, firstStartSucceeded, () => (lateSkip = skipOf()) === undefined,
      () => ({ input: { kind: "waitNotifyCarry" }, text: WAIT_NOTIFY_CARRY_INSTRUCTION }));
  } catch (error) {
    abandonWaitNotifyCarry(fork, items, String(error));
    return;
  }
  if (!result.sent && lateSkip !== undefined) {
    skipWaitNotifyCarry(fork, lateSkip);
    return;
  }
  if (!result.sent) {
    abandonWaitNotifyCarry(fork, items, result.reason);
    return;
  }
  noteWaitNotifyCarryTurn(fork, result.turnId);
  output.appendLine(`[${fork.title}] short turn sent for the mobile notification carried over from the handoff`);
}

async function runHandoff(st: SessionStore, sender: vscode.Webview | null, target: Session, auto?: HandoffAutoStart | HandoffAutoNotice, continueWork = false): Promise<boolean | undefined> {
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
      source,
    });
  };
  const busy = (): boolean => handoffSourceBusy({ turnRunning: turnRunning(target), unsentSendCount: target.unsentSends.size });
  const sourceConversation = target.conversation;
  const sourceGeneration = target.logicalGeneration;
  const contextUsage: HandoffContextUsage = { before: null, after: "pending" };
  let snapshotWrite: Promise<void> = Promise.resolve();
  let snapshotPending = false;

  const refuse = (reason: string, detail?: string, quiet = quietAutoRefusal(auto !== undefined, reason)): undefined => {
    if (quiet) output.appendLine(`[${target.title}] automatic handoff not started: ${reason}`);
    else fail(reason, detail);
    return undefined;
  };
  if (await judgeTranscriptWriteLock(target)) return refuse("transcript_write_forbidden");
  if (busy()) return refuse("source_busy");
  if (handoffRuns.has(target.tabId)) return refuse("already_running");
  const reservation: HandoffRunReservation = { runId, runner: null };
  let handedOff = false;
  let carry: readonly WaitReportItem[] | undefined;
  handoffRuns.set(target.tabId, reservation);
  try {
    postHandoffSendLock(st, target.tabId);
    const cfg = getLaisoraConfiguration();
    const cwd = resolveSessionCwd(target);
    if (source.sessionId.length === 0) {
      fail("fork_failed", "no_session_id");
      return false;
    }
    if (cwd === undefined) {
      fail("fork_failed", "no_cwd");
      return false;
    }
    if (launchFolderMissing(cwd) !== undefined) {
      const shownForAuto = autoFolderMissingShown.get(target) === cwd;
      if (auto !== undefined) autoFolderMissingShown.set(target, cwd);
      return refuse("folder_missing", cwd, auto !== undefined && shownForAuto);
    }
    autoFolderMissingShown.delete(target);
    let runtime: Awaited<ReturnType<typeof resolveHandoffRuntime>>;
    try {
      runtime = await resolveHandoffRuntime(
        configuredClaudeExecutablePath(cfg),
        configuredApiKeyPolicy(cfg)
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
      transcriptRetention: transcriptRetentionSettings((key) => cfg.get<unknown>(key)),
      lookupSessionFileById: async (id) => lookupSessionFile(id),
      readRecords: readHandoffRecords,
      fs: handoffFs,
      writeDiagnostic: writeHandoffDiagnostic,
      registry: handoffRegistry(),
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
          source,
          ...(auto === undefined ? {} : { auto }),
        });
      },
      onForkCreated: (forkSessionId) => {
        snapshotPending = true;
        snapshotWrite = handoffContextUsage().write(forkSessionId, { ...contextUsage }).catch((error) =>
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
    const activityAtFork = sourceActivity.get(target) ?? 0;
    const outcome: HandoffOutcome = await runner.run({
      sourceSessionId: source.sessionId,
      sourceTitle: source.title,
      runId,
      sourceBusy: () => busy() || (sourceActivity.get(target) ?? 0) !== activityAtFork,
      ...(workMemo !== undefined ? { workMemo } : {}),
    });
    if (!outcome.ok && quietAutoRefusal(auto !== undefined, outcome.reason)) return undefined;
    if (!outcome.ok) {
      const forkSessionId = outcome.forkSessionId;
      if (forkSessionId !== undefined && (await handoffForkStateOf(forkSessionId)) === "cleanup_failed") postSessionListChanged();
      if (forkSessionId !== undefined && (await lookupSessionFile(forkSessionId)).reason === "not_found") {
        void snapshotWrite.then(() => handoffContextUsage().remove(forkSessionId)).catch((error) =>
          output.appendLine("[handoff] context snapshot could not be removed: " + String(error)));
      }
      fail(outcome.reason, outcome.detail);
      return false;
    }
    if (outcome.unreadableLineCount > 0) {
      void handoffPersist().update(handoffUnreadableLinesKey(outcome.forkSessionId), outcome.unreadableLineCount).catch((error) =>
        output.appendLine("[handoff] unreadable line count could not be saved: " + String(error)));
    }
    await rememberHandedOff(source.sessionId);
    await relinkTodoConversation(source.sessionId, outcome.forkSessionId);
    const startMeasurement = createStartMeasurement();
    const activateIn = (): vscode.Webview[] => forkTabActivationTargets({
      auto: auto !== undefined,
      sender,
      surfaces: (auto !== undefined ? st.attachedWebviews() : sender === null ? [] : [sender])
        .map((surface) => ({ surface, activeTabId: st.shownTabIdOf(surface) })),
      sourceTabId: target.tabId,
    });
    const opened = await openResumedSession(st, {
      sessionId: outcome.forkSessionId,
      filePath: outcome.forkFilePath,
      activate: activateIn().length > 0,
      activateIn,
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
    forkSession.handoffSource = {
      contextUsage,
      sessionId: source.sessionId,
      title: source.title,
      ...(outcome.compact !== undefined ? { compact: outcome.compact } : {}),
      utteranceCount: outcome.utteranceCount,
      ...(outcome.unreadableLineCount > 0 ? { unreadableLineCount: outcome.unreadableLineCount } : {}),
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
        await handoffContextUsage().write(outcome.forkSessionId, { ...contextUsage });
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
    const carried = waitNotifyCarryOf(target);
    carry = carried;
    if (continueWork || carried !== undefined) {
      void startMeasurement.firstStart.then(async (started) => {
        const continued = continueWork ? await sendHandoffContinue(forkSession, generation, started, workMemo?.item.id) : false;
        if (carried !== undefined) await sendWaitNotifyCarry(forkSession, generation, started, carried, continued);
      }).catch((error) => output.appendLine(`[${forkSession.title}] input after the handoff not sent: ${String(error)}`));
    }
    handedOff = true;
    return true;
  } catch (e) {
    fail("commit_failed", String(e));
    return false;
  } finally {
    if (handoffRuns.get(target.tabId)?.runId === runId) handoffRuns.delete(target.tabId);
    try {
      postHandoffSendLock(st, target.tabId);
    } catch (error) {
      output.appendLine(`[${target.title}] handoff send lock release could not be posted: ${String(error)}`);
    }
    if (handedOff) {
      target.conversation?.cancelAutoResume();
      target.guardrailRunner.abandonHeldReports();
      if (carry !== undefined) requestRemoteControlAuto(target, "handedOff");
      dropWaitNotifyEpisode(target);
      closeHandedOffSource(st, sender, target, busy());
    } else {
      target.guardrailRunner.scheduleGuardrailRefresh();
      signalWaitNotify(target);
    }
  }
}

function closeHandedOffSource(st: SessionStore, sender: vscode.Webview | null, source: Session, busy: boolean): void {
  const block = sourceTabCloseBlock({
    settingOn: readAutoHandoffSettings().closeSourceTab,
    closed: source.closed,
    gate: { composerHasText: composerHasText(source.tabId) },
    busy,
    background: backgroundWorkOf(source),
  });
  if (block === "setting_off") return;
  if (block !== undefined) {
    output.appendLine(`[${source.title}] source tab kept open after the handoff: ${block}`);
    return;
  }
  try {
    closeConversationTab(st, source, sender, { offerReopen: false });
    output.appendLine(`[${source.title}] source tab closed after the handoff`);
  } catch (error) {
    output.appendLine(`[${source.title}] source tab could not be closed after the handoff: ${String(error)}`);
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
    HANDOFF_DETAIL_MAX_BYTES - base
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
  let decideFirstStart!: (succeeded: boolean) => void;
  const firstStart = new Promise<boolean>((r) => { decideFirstStart = r; });
  const settle = (value: HandoffContextMeasurement | null | undefined): void => {
    if (!pending) return;
    pending = false;
    decideFirstStart(true);
    resolve(value);
  };
  return {
    get pending() { return pending; },
    result,
    async measure(conversation) {
      void initialContextUsageWithin(conversation).then(settle);
      await result;
    },
    abandon: () => {
      decideFirstStart(false);
      settle(undefined);
    },
    firstStart,
    startFailed: () => decideFirstStart(false),
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
  originTooLargeToldGeneration?: number;
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

function backgroundWorkOf(s: Session): BackgroundWork {
  return {
    runningAgents: runningDelegationIds(s.backgroundActivity).length,
    runningBackgroundTasks: liveBackgroundTasks(s.backgroundActivity).length,
    runningExternalRuns: s.conversation?.runningExternalRunCount ?? 0,
  };
}

export function cliActivityOf(s: Session): CliActivity {
  const conv = s.conversation;
  return {
    idle: conv !== null && !conv.isClosed && !launchingOrTurnRunning(s) && !s.closed && !s.clearing
      && s.hydration?.buffering !== true,
    ...backgroundWorkOf(s),
    queuedMessages: conv?.queuedInputCount ?? 0,
  };
}

function quietGateOf(s: Session): Omit<AutoHandoffGateInput, "composerHasText"> {
  const activity = cliActivityOf(s);
  return { ...activity, queuedMessages: activity.queuedMessages + s.unsentSends.size, handoffRunning: handoffInProgress(s.tabId) };
}

function autoHandoffGateOf(s: Session): AutoHandoffGateInput {
  return { ...quietGateOf(s), composerHasText: composerHasText(s.tabId) };
}

export function conversationQuiet(s: Session): boolean {
  return autoHandoffGateOpen({ ...quietGateOf(s), composerHasText: false });
}

export function autoHandoffDue(s: Session): boolean {
  return autoHandoffTabs.get(s)?.candidate !== undefined;
}

function planUnfinishedOf(s: Session): boolean {
  return planHasUnfinishedStep(s.evidenceIndex.timeBuckets.blocks);
}

function unfinishedWorkOf(s: Session): boolean {
  return planUnfinishedOf(s) || decisionPendingSinceUserSend(s.events);
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
  const continueWork = continueAfterHandoff({ trigger: start.trigger, planUnfinished: planUnfinishedOf(s), decisionPending: decisionPendingSinceUserSend(s.events) });
  output.appendLine(`[${s.title}] automatic handoff: ${JSON.stringify({ ...start, continueWork })}`);
  const generation = s.logicalGeneration;
  void runHandoff(st, st.activeWebview, s, autoStartDisplay(start, notice, handoffNoticeTitle), continueWork).then((completed) => {
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
  void result.handedOff.then((handedOff) => {
    if (handedOff) {
      output.appendLine(`[${s.title}] automatic handoff notice sent: ${JSON.stringify(facts)}`);
      return;
    }
    output.appendLine(`[${s.title}] automatic handoff notice not sent: withdrawn`);
    if (tab.noticeTurn === NOTICE_TURN_PENDING) noteNoticeTurnEnded(s, tab, undefined, true);
  });
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
  const size = sizeAutoDecision(settings, usage, handoffOriginOf(s.handoffSource));
  if (size?.action === "start") {
    tab.candidate = size.start;
    tryAutoHandoff(s);
    return;
  }
  if (size?.action === "origin_too_large" && tab.originTooLargeToldGeneration !== s.logicalGeneration) {
    tab.originTooLargeToldGeneration = s.logicalGeneration;
    output.appendLine(`[${s.title}] automatic handoff by size skipped: context after the previous handoff ${size.postTokens} > half the threshold ${size.threshold}`);
    store?.post({ type: "tabNotice", tabId: s.tabId, text: l10n.t(
      "Automatic handoff by context size will not start in this conversation: right after the previous handoff it already held {0} tokens, more than half the threshold ({1}). You can still hand off from the tab menu.",
      formatHandoffTokens(size.postTokens), formatHandoffTokens(size.threshold)) });
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
  if (ev.kind === "turn_started" || ev.kind === "user_message") sourceActivity.set(s, (sourceActivity.get(s) ?? 0) + 1);
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
      if (tab.turnEnded && conv !== null && !turnRunning(s)) {
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
  for (const s of store?.sessions.values() ?? []) {
    tryAutoHandoff(s);
    signalWaitNotify(s);
  }
}
