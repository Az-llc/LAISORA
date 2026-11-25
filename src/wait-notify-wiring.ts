import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { APPROVAL_RESOLVED_BY } from "./ask-unanswered";
import type { ClaudeHostOptions } from "./claudeHost";
import { waitNotifySettings } from "./gateway-host-actions";
import { autoHandoffDue, conversationQuiet } from "./handoff-wiring";
import { handoffInProgress } from "./handoff-runs";
import { extensionContext, output, store } from "./host-context";
import type { NormalizedEventBody, WaitReportItem, WebviewToHost } from "./protocol";
import { remoteControlStateOfTab, requestRemoteControlAuto } from "./remote-control-wiring";
import type { Session } from "./session";
import { onWaitNotifySignal } from "./wait-notify-signal";
import { bellFileExists, bellHookAlive, createBellDir, removeBellFile, retireBellDir, writeBellFile } from "./wait-notify-files";
import {
  PUSH_NOTIFICATION_TOOL,
  WAIT_NOTIFY_ARMED_FILE,
  WAIT_NOTIFY_ARM_GRACE_SECONDS,
  WAIT_NOTIFY_BELL_POLL_SECONDS,
  WAIT_NOTIFY_EPOCH_FILE,
  WAIT_NOTIFY_WAKE_TURN_CAP_MS,
  WAIT_NOTIFY_WAKE_WATCHDOG_MS,
  freshWaitItems,
  inputNeedStep,
  noteWaitNotifyResult,
  pushOutcome,
  waitEpisodeAfterHuman,
  waitEpisodeCarried,
  waitEpisodeOnLaunch,
  waitEpisodeWithoutCarry,
  waitItemsOf,
  waitNotifyCarry,
  waitNotificationMessage,
  waitNotifyBell,
  waitNotifyLine,
  waitNotifyRewakeText,
  waitNotifyStep,
  waitNotifyStopHook,
  waitNotifyWakeFile,
  waitNotifyClosed,
  waitNotifyPushTool,
  wakeTurnStart,
  type PushTool,
  type WaitEpisode,
  type WaitReport,
  type WakeGate,
} from "./wait-notify";

interface Wake {
  file: string;
  message: string;
  before: WaitEpisode;
  turnId?: string;
  sent: boolean;
  pushCalls: Set<string>;
  outcome?: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
}

interface WaitTab {
  episode: WaitEpisode;
  report?: WaitReport;
  lastTurnCompleted: boolean;
  lastTurnEndAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  bellDir?: string;
  epoch: number;
  wake?: Wake;
  pendingInputs: Map<string, number>;
  laisoraInputAt?: number;
  carryTurnId?: string;
}

const waitTabs = new WeakMap<Session, WaitTab>();

function humanMarkOf(s: Session) {
  return { generation: s.generation, seq: s.seq, at: Date.now() };
}

function waitTab(s: Session): WaitTab {
  const current = waitTabs.get(s);
  if (current !== undefined && current.episode.human.generation === s.generation) return current;
  if (current !== undefined) {
    clearTimer(current);
    clearWake(s, current);
  }
  const fresh: WaitTab = { lastTurnCompleted: false, epoch: 0, ...(current?.bellDir === undefined ? {} : { bellDir: current.bellDir, epoch: current.epoch }),
    episode: waitEpisodeAfterHuman(humanMarkOf(s)), pendingInputs: new Map() };
  waitTabs.set(s, fresh);
  return fresh;
}

export function waitNotifyPushToolOf(s: Session): PushTool {
  const conv = s.conversation;
  return waitNotifyPushTool(conv?.launchedWithWaitNotify === true, conv?.initTools);
}

function launched(s: Session): boolean {
  return s.conversation?.isClosed === false && waitNotifyPushToolOf(s) === "offered";
}

function gateClosed(s: Session): boolean {
  return waitNotifyClosed(waitNotifySettings().enabled, waitNotifyPushToolOf(s)) !== undefined;
}

function clearTimer(tab: WaitTab): void {
  if (tab.timer !== undefined) clearTimeout(tab.timer);
  tab.timer = undefined;
}

function removeTabFile(tab: WaitTab, name: string): void {
  if (tab.bellDir !== undefined && !removeBellFile(tab.bellDir, name)) output.appendLine(`[wait-notify] could not remove ${name}`);
}

function writeTabFile(tab: WaitTab, name: string, text: string): boolean {
  if (tab.bellDir === undefined) return false;
  try {
    writeBellFile(tab.bellDir, name, text);
    return true;
  } catch (error) {
    output.appendLine(`[wait-notify] could not write ${name}: ${String(error)}`);
    return false;
  }
}

function setArmed(tab: WaitTab, armed: boolean): void {
  if (tab.bellDir === undefined) return;
  if (!armed) removeTabFile(tab, WAIT_NOTIFY_ARMED_FILE);
  else if (!bellFileExists(tab.bellDir, WAIT_NOTIFY_ARMED_FILE)) writeTabFile(tab, WAIT_NOTIFY_ARMED_FILE, "1");
}

function clearWake(s: Session, tab: WaitTab): void {
  const wake = tab.wake;
  tab.wake = undefined;
  if (wake?.watchdog !== undefined) clearTimeout(wake.watchdog);
  if (wake !== undefined) removeTabFile(tab, wake.file);
  s.conversation?.expectLaisoraWake(undefined);
}

function wakeSignalTaken(tab: WaitTab, wake: Wake): boolean {
  return tab.wake === wake && tab.bellDir !== undefined && !bellFileExists(tab.bellDir, wake.file);
}

function withdrawRing(s: Session, tab: WaitTab, wake: Wake): void {
  clearWake(s, tab);
  tab.episode = waitEpisodeOnLaunch(wake.before);
  output.appendLine(`[${s.title}] mobile notification put off: another turn started before the wake hook took the signal`);
}

function retireTabBellDir(s: Session, tab: WaitTab): void {
  clearWake(s, tab);
  const dir = tab.bellDir;
  tab.bellDir = undefined;
  if (dir === undefined) return;
  try {
    retireBellDir(dir, waitNotifyBell(process.platform).file);
  } catch (error) {
    output.appendLine(`[wait-notify] could not retire ${dir}: ${String(error)}`);
  }
}

function writeEpoch(tab: WaitTab): void {
  if (writeTabFile(tab, WAIT_NOTIFY_EPOCH_FILE, String(tab.epoch + 1))) tab.epoch += 1;
}

function showNotSent(s: Session, message: string): void {
  s.pushEvent({ kind: "local_command_output", text: waitNotifyLine(message, false), uuid: randomUUID() }, undefined, { timestamp: Date.now() });
}

function waitItemsOfTab(tab: WaitTab): WaitReportItem[] {
  return waitItemsOf(tab.episode, freshWaitItems(tab.report, tab.episode.human));
}

function messageOf(s: Session, tab: WaitTab, items: readonly WaitReportItem[]): string {
  return waitNotificationMessage(s.title, items, tab.episode.carried !== undefined);
}

function evaluate(s: Session): void {
  const tab = waitTabs.get(s);
  if (tab === undefined) return;
  clearTimer(tab);
  if (handoffInProgress(s.tabId) || s.transcriptWriteLocked) return;
  if (s.closed || tab.wake !== undefined || !launched(s)) {
    if (tab.wake === undefined) setArmed(tab, false);
    return;
  }
  const conv = s.conversation!;
  const now = Date.now();
  const items = waitItemsOfTab(tab);
  const settings = waitNotifySettings();
  const remoteControl = remoteControlStateOfTab(s);
  const before = tab.episode;
  const { episode, action } = waitNotifyStep(before, {
    now,
    settings,
    launchedWithPush: true,
    remoteControl,
    quiet: conversationQuiet(s) && !autoHandoffDue(s),
    lastTurnCompleted: tab.lastTurnCompleted,
    autoResumePending: conv.pendingAutoResumeAt != null,
    hookAlive: tab.bellDir !== undefined && bellHookAlive(tab.bellDir, now),
    items,
  });
  tab.episode = episode;
  setArmed(tab, settings.enabled && items.length > 0 && !episode.notified && remoteControl !== "refused");
  const need = inputNeedStep(settings.enabled ? [...tab.pendingInputs.values()] : [], tab.laisoraInputAt, now, remoteControl);
  const wakeAts = [
    ...(action.kind === "arm" ? [action.at] : []),
    ...(need.kind === "arm" ? [need.at] : []),
    ...(action.kind === "awaitHook" && tab.lastTurnEndAt !== undefined && now - tab.lastTurnEndAt < WAIT_NOTIFY_ARM_GRACE_SECONDS * 1000 ? [now + WAIT_NOTIFY_BELL_POLL_SECONDS * 1000] : []),
  ];
  if (wakeAts.length > 0) tab.timer = setTimeout(() => evaluate(s), Math.max(0, Math.min(...wakeAts) - now));
  if (action.kind === "ring") ring(s, tab, items, before);
  else if (action.kind === "notSent") {
    output.appendLine(`[${s.title}] mobile notification not sent: Remote Control did not connect`);
    showNotSent(s, messageOf(s, tab, items));
    evaluate(s);
  } else if (action.kind === "connect" || need.kind === "connect") {
    requestRemoteControlAuto(s, "needed");
    if (action.kind === "connect" && remoteControlStateOfTab(s) === "off") evaluate(s);
  }
}

function ring(s: Session, tab: WaitTab, items: readonly WaitReportItem[], before: WaitEpisode): void {
  const message = messageOf(s, tab, items);
  const file = waitNotifyWakeFile(tab.epoch);
  if (!writeTabFile(tab, file, waitNotifyRewakeText(message, items.map((item) => item.title)))) {
    output.appendLine(`[${s.title}] mobile notification not sent: no wake hook for this conversation`);
    tab.episode = noteWaitNotifyResult(tab.episode, false);
    return;
  }
  const wake: Wake = { file, message, before, sent: false, pushCalls: new Set() };
  const giveUp = (reason: string): void => {
    if (tab.wake !== wake || wake.turnId !== undefined) return;
    output.appendLine(`[${s.title}] mobile notification not sent: ${reason}`);
    clearWake(s, tab);
    tab.episode = noteWaitNotifyResult(tab.episode, false);
    showNotSent(s, message);
    evaluate(s);
  };
  wake.watchdog = setTimeout(() => {
    if (tab.wake !== wake || wake.turnId !== undefined) return;
    if (tab.bellDir !== undefined && bellFileExists(tab.bellDir, wake.file)) {
      giveUp("no wake hook took the signal");
      return;
    }
    wake.watchdog = setTimeout(() => giveUp("Claude Code did not start the wake turn"), WAIT_NOTIFY_WAKE_TURN_CAP_MS);
  }, WAIT_NOTIFY_WAKE_WATCHDOG_MS);
  tab.wake = wake;
  s.conversation?.expectLaisoraWake(() => wakeSignalTaken(tab, wake));
  output.appendLine(`[${s.title}] waking Claude for a mobile notification`);
}

function noteHuman(s: Session, tab: WaitTab): void {
  tab.episode = waitEpisodeAfterHuman(humanMarkOf(s));
  tab.carryTurnId = undefined;
  clearWake(s, tab);
  clearTimer(tab);
  setArmed(tab, false);
}

function settleWakeTurn(s: Session, tab: WaitTab, turnId: string, failed: boolean): void {
  const wake = tab.wake;
  if (wake?.turnId !== turnId) return;
  const sent = wake.outcome === true;
  clearWake(s, tab);
  tab.episode = noteWaitNotifyResult(tab.episode, sent);
  output.appendLine(`[${s.title}] mobile notification ${sent ? "sent" : "not sent"}`);
  if (failed) s.conversation?.cancelAutoResume();
}

export function waitNotifyLaunchOptions(s: Session): ClaudeHostOptions["waitNotify"] {
  const tab = waitTab(s);
  dropPendingCarry(s, tab);
  retireTabBellDir(s, tab);
  tab.episode = waitEpisodeOnLaunch(tab.episode);
  tab.pendingInputs.clear();
  if (!waitNotifySettings().enabled) return undefined;
  const storage = extensionContext?.globalStorageUri?.fsPath;
  if (storage === undefined) return undefined;
  const root = path.join(storage, "wait-notify");
  const bell = waitNotifyBell(process.platform);
  let dir: string;
  try {
    dir = createBellDir(root, process.pid, Date.now());
  } catch (error) {
    output.appendLine(`[${s.title}] mobile notifications off for this conversation: ${String(error)}`);
    return undefined;
  }
  tab.bellDir = dir;
  if (!writeTabFile(tab, bell.file, bell.text)) {
    retireTabBellDir(s, tab);
    output.appendLine(`[${s.title}] mobile notifications off for this conversation: no wake hook script`);
    return undefined;
  }
  tab.epoch = 0;
  writeEpoch(tab);
  return {
    stopHook: waitNotifyStopHook(bell, path.join(dir, bell.file), dir),
    wakeGate: (turnId) => wakeGateOf(s, turnId),
    onWakeAllowed: () => {
      const wake = waitTabs.get(s)?.wake;
      if (wake !== undefined) wake.sent = true;
    },
  };
}

function wakeGateOf(s: Session, turnId: string | null): WakeGate | undefined {
  const wake = waitTabs.get(s)?.wake;
  return wake !== undefined && turnId !== null && wake.turnId === turnId ? { message: wake.message, sent: wake.sent } : undefined;
}

export function noteWaitNotifyEvent(s: Session, ev: NormalizedEventBody): void {
  const tab = waitTabs.get(s);
  if (tab === undefined) return;
  if (ev.kind === "conversation_closed") {
    dropPendingCarry(s, tab);
    tab.lastTurnCompleted = false;
    tab.pendingInputs.clear();
    clearTimer(tab);
    retireTabBellDir(s, tab);
    return;
  }
  if (s.conversation?.isClosed !== false) return;
  if (waitNotifyPushToolOf(s) === "missing") {
    forgetCarry(s, tab, "Claude Code has no PushNotification tool in this conversation");
    return;
  }
  switch (ev.kind) {
    case "turn_started":
      writeEpoch(tab);
      if (tab.wake !== undefined && tab.wake.turnId === undefined) {
        const start = wakeTurnStart(ev.laisoraWake === true, wakeSignalTaken(tab, tab.wake));
        if (start === "bind") tab.wake.turnId = ev.turnId;
        else if (start === "withdraw") withdrawRing(s, tab, tab.wake);
      }
      tab.lastTurnCompleted = false;
      break;
    case "tool_call_started":
      if (tab.wake?.turnId === ev.turnId && ev.toolName === PUSH_NOTIFICATION_TOOL && ev.parentToolUseId === null) tab.wake.pushCalls.add(ev.toolUseId);
      return;
    case "tool_call_finished":
      if (tab.wake?.pushCalls.has(ev.toolUseId) === true) tab.wake.outcome = tab.wake.outcome === true || pushOutcome(ev.resultPreview, ev.isError);
      break;
    case "turn_completed":
      tab.lastTurnCompleted = true;
      tab.lastTurnEndAt = Date.now();
      if (tab.carryTurnId === ev.turnId) tab.carryTurnId = undefined;
      settleWakeTurn(s, tab, ev.turnId, false);
      break;
    case "turn_failed":
    case "turn_interrupted":
      tab.lastTurnCompleted = false;
      if (ev.turnId !== null && tab.carryTurnId === ev.turnId) dropCarry(s, tab, `the short turn before it ${ev.kind === "turn_failed" ? "failed" : "was interrupted"}`);
      if (ev.turnId !== null) settleWakeTurn(s, tab, ev.turnId, ev.kind === "turn_failed");
      break;
    case "user_message":
      noteHuman(s, tab);
      break;
    case "approval_request":
      tab.pendingInputs.set(ev.requestId, Date.now());
      break;
    case "approval_resolved":
      tab.pendingInputs.delete(ev.requestId);
      if (ev.resolvedBy === APPROVAL_RESOLVED_BY.user || ev.resolvedBy === APPROVAL_RESOLVED_BY.chat) {
        noteHuman(s, tab);
        markLaisoraInput(s, tab);
      }
      break;
    case "conversation_opened":
      tab.lastTurnCompleted = false;
      clearWake(s, tab);
      break;
    default:
      return;
  }
  evaluate(s);
}

function markLaisoraInput(s: Session, tab: WaitTab | undefined): void {
  if (tab !== undefined) tab.laisoraInputAt = Date.now();
  requestRemoteControlAuto(s, "laisoraInput");
}

export function noteLaisoraWindowInput(s: Session): void {
  markLaisoraInput(s, waitTabs.get(s));
  evaluate(s);
}

function dropPendingCarry(s: Session, tab: WaitTab): void {
  if (tab.carryTurnId !== undefined) dropCarry(s, tab, "the conversation closed before the short turn before it ended");
}

function dropCarry(s: Session, tab: WaitTab, reason: string): void {
  const carried = tab.episode.carried;
  tab.carryTurnId = undefined;
  if (carried === undefined) return;
  tab.episode = waitEpisodeWithoutCarry(tab.episode);
  carryNotSent(s, carried, reason);
}

function forgetCarry(s: Session, tab: WaitTab, reason: string): void {
  tab.carryTurnId = undefined;
  if (tab.episode.carried === undefined) return;
  tab.episode = waitEpisodeWithoutCarry(tab.episode);
  output.appendLine(`[${s.title}] mobile notification carried over from the handoff skipped: ${reason}`);
}

export function skipWaitNotifyCarry(s: Session, reason: string): void {
  const tab = waitTabs.get(s);
  if (tab !== undefined) forgetCarry(s, tab, reason);
}

function carryNotSent(s: Session, items: readonly WaitReportItem[], reason: string): void {
  const closed = gateClosed(s);
  output.appendLine(`[${s.title}] mobile notification carried over from the handoff ${closed ? "withdrawn" : "not sent"}: ${reason}`);
  if (!closed && !s.closed) showNotSent(s, waitNotificationMessage(s.title, items, true));
}

export function waitNotifyCarryOf(s: Session): readonly WaitReportItem[] | undefined {
  const tab = waitTabs.get(s);
  return tab === undefined ? undefined : waitNotifyCarry(tab.episode, waitItemsOfTab(tab));
}

export function seedWaitNotifyCarry(s: Session, items: readonly WaitReportItem[]): void {
  const tab = waitTab(s);
  tab.episode = waitEpisodeCarried(humanMarkOf(s), items);
  tab.carryTurnId = undefined;
  evaluate(s);
}

export function noteWaitNotifyCarryTurn(s: Session, turnId: string | null): void {
  const tab = waitTabs.get(s);
  if (tab === undefined || tab.episode.carried === undefined) return;
  if (turnId === null) dropCarry(s, tab, "the short turn before it did not start");
  else tab.carryTurnId = turnId;
}

export function abandonWaitNotifyCarry(s: Session, items: readonly WaitReportItem[], reason: string): void {
  const tab = waitTabs.get(s);
  if (tab?.episode.carried !== undefined) {
    dropCarry(s, tab, reason);
    return;
  }
  carryNotSent(s, items, reason);
}

export function dropWaitNotifyEpisode(s: Session): void {
  const tab = waitTabs.get(s);
  if (tab !== undefined) noteHuman(s, tab);
}

export function noteWaitNotifyHumanInput(s: Session): void {
  const tab = waitTabs.get(s);
  if (tab !== undefined) noteHuman(s, tab);
  noteLaisoraWindowInput(s);
}

export function noteYouWaiting(s: Session, msg: Extract<WebviewToHost, { type: "youWaiting" }>): void {
  const tab = waitTab(s);
  tab.report = { generation: msg.generation, seq: msg.seq, items: msg.items };
  evaluate(s);
}

export function reevaluateWaitNotify(): void {
  for (const s of store?.sessions.values() ?? []) evaluate(s);
}

export function clearWaitNotify(s: Session): void {
  const tab = waitTabs.get(s);
  if (tab === undefined) return;
  clearTimer(tab);
  retireTabBellDir(s, tab);
}

onWaitNotifySignal(evaluate);
