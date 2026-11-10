import * as l10n from "@vscode/l10n";
import { plainAskFormat } from "./ask-plain-form";
import { resolveSettingGroup } from "./configuration-defaults";
import { WAIT_NOTIFY_SETTING_KEYS, isWaitNotifySettingValue, type WaitNotifySettings, type WaitReportItem } from "./protocol";
import type { RemoteControlState } from "./remote-control";

export const PUSH_NOTIFICATION_TOOL = "PushNotification";
export const TOOL_SEARCH_TOOL = "ToolSearch";
export const PUSH_MESSAGE_MAX = 200;
export const PUSH_REQUESTED_RESULT = "Mobile push requested.";
export const WAIT_NOTIFY_REWAKE_HEAD = "LAISORA wait notice:";
export const WAIT_NOTIFY_MAX_ATTEMPTS = 2;
export const WAIT_NOTIFY_PUSH_OUTSIDE_WAKE_REASON = "PushNotification is reserved for LAISORA's wait notifications. Do not call it.";
const WAIT_NOTIFY_WAKE_REPLY = "restate in the plain Markdown form given in this turn's wake notice each decision or real-machine check that the notice lists by title as waiting, exactly those and in that order, and write nothing else for the notice; if you cannot find any of them, reply with only OK.";
export const WAIT_NOTIFY_ALREADY_SENT_REASON = `LAISORA's notification for this wait was already sent. Now ${WAIT_NOTIFY_WAKE_REPLY}`;
export const WAIT_NOTIFY_WAKE_ONLY_REASON = `This turn only sends LAISORA's mobile notification. Call PushNotification, then ${WAIT_NOTIFY_WAKE_REPLY}`;
export const WAIT_NOTIFY_BELL_POLL_SECONDS = 3;
export const WAIT_NOTIFY_ARM_GRACE_SECONDS = 30;
export const WAIT_NOTIFY_HOOK_TIMEOUT_SECONDS = 86_400;
export const WAIT_NOTIFY_WAKE_WATCHDOG_MS = (2 * WAIT_NOTIFY_BELL_POLL_SECONDS + 10) * 1000;
export const WAIT_NOTIFY_WAKE_TURN_CAP_MS = 5 * 60_000;
export const WAIT_NOTIFY_WAKE_FILE = "wake";
export const WAIT_NOTIFY_EPOCH_FILE = "epoch";
export const WAIT_NOTIFY_ARMED_FILE = "armed";
export const WAIT_NOTIFY_ALIVE_PREFIX = "alive-";
export const WAIT_NOTIFY_HEARTBEAT_FRESH_MS = 3 * WAIT_NOTIFY_BELL_POLL_SECONDS * 1000;
export const WAIT_NOTIFY_CONNECT_MS = 30_000;
export const WAIT_NOTIFY_INPUT_GRACE_MS = 30_000;

export function resolveWaitNotifySettings(read: (key: string) => unknown): WaitNotifySettings {
  return resolveSettingGroup<WaitNotifySettings>(WAIT_NOTIFY_SETTING_KEYS, isWaitNotifySettingValue, read);
}

export interface HumanMark { readonly generation: number; readonly seq: number; readonly at: number }
export interface WaitReport { readonly generation: number; readonly seq: number; readonly items: readonly WaitReportItem[] }

export function freshWaitItems(report: WaitReport | undefined, human: HumanMark): WaitReportItem[] {
  if (report === undefined || report.generation !== human.generation || report.seq < human.seq) return [];
  return report.items.filter((item) => item.createdAt >= human.at).sort((a, b) => a.createdAt - b.createdAt);
}

export interface WaitEpisode {
  readonly human: HumanMark;
  readonly notified: boolean;
  readonly openCount: number;
  readonly attempts: number;
  readonly since?: number;
  readonly connect?: WaitConnect;
}

export interface WaitConnect { readonly asked: boolean; readonly connectingSince?: number }

export function waitEpisodeAfterHuman(human: HumanMark): WaitEpisode {
  return { human, notified: false, openCount: 0, attempts: 0 };
}

export function waitEpisodeOnLaunch(episode: WaitEpisode): WaitEpisode {
  const { connect: _connect, ...rest } = episode;
  return rest;
}

export interface WaitNotifyFacts {
  readonly now: number;
  readonly settings: WaitNotifySettings;
  readonly launchedWithPush: boolean;
  readonly remoteControl: RemoteControlState;
  readonly quiet: boolean;
  readonly lastTurnCompleted: boolean;
  readonly autoResumePending: boolean;
  readonly hookAlive: boolean;
  readonly items: readonly WaitReportItem[];
}

export type WaitNotifyAction =
  | { readonly kind: "none" }
  | { readonly kind: "arm"; readonly at: number }
  | { readonly kind: "awaitHook" }
  | { readonly kind: "connect" }
  | { readonly kind: "notSent" }
  | { readonly kind: "ring" };

function withoutStarts(episode: WaitEpisode): WaitEpisode {
  const { since: _since, ...rest } = waitEpisodeOnLaunch(episode);
  return rest;
}

export function waitNotifyStep(episode: WaitEpisode, facts: WaitNotifyFacts): { episode: WaitEpisode; action: WaitNotifyAction } {
  const openCount = facts.items.length;
  const counted: WaitEpisode = openCount < episode.openCount
    ? { ...episode, openCount, notified: false, attempts: 0 }
    : { ...episode, openCount };
  const waiting = facts.settings.enabled && facts.launchedWithPush && facts.remoteControl !== "refused" && openCount > 0 && !counted.notified;
  if (!waiting) return { episode: withoutStarts(counted), action: { kind: "none" } };
  const ready = facts.quiet && facts.lastTurnCompleted && !facts.autoResumePending;
  if (!ready) return { episode: counted, action: { kind: "none" } };
  const since = counted.since ?? facts.now;
  const at = since + facts.settings.minutes * 60_000;
  if (facts.now < at) return { episode: { ...counted, since }, action: { kind: "arm", at } };
  if (!facts.hookAlive) return { episode: { ...counted, since }, action: { kind: "awaitHook" } };
  const attempted: WaitEpisode = { ...withoutStarts(counted), notified: true, attempts: counted.attempts + 1 };
  const notSent = { episode: noteWaitNotifyResult(attempted, false), action: { kind: "notSent" } } as const;
  if (facts.remoteControl === "connected") return { episode: attempted, action: { kind: "ring" } };
  const asked = counted.connect?.asked === true;
  if (facts.remoteControl === "off") return asked ? notSent : { episode: { ...counted, since, connect: { asked: true } }, action: { kind: "connect" } };
  if (facts.remoteControl === "switching") return { episode: { ...counted, since, connect: { asked } }, action: { kind: "none" } };
  const connectingSince = counted.connect?.connectingSince ?? facts.now;
  const deadline = connectingSince + WAIT_NOTIFY_CONNECT_MS;
  if (facts.now >= deadline) return notSent;
  return { episode: { ...counted, since, connect: { asked, connectingSince } }, action: { kind: "arm", at: deadline } };
}

export type InputNeed = { readonly kind: "none" } | { readonly kind: "arm"; readonly at: number } | { readonly kind: "connect" };

export function inputNeedStep(pendingSince: readonly number[], laisoraInputAt: number | undefined, now: number, remoteControl: RemoteControlState): InputNeed {
  if (pendingSince.length === 0 || remoteControl !== "off") return { kind: "none" };
  const at = Math.max(Math.min(...pendingSince), laisoraInputAt ?? -Infinity) + WAIT_NOTIFY_INPUT_GRACE_MS;
  return now >= at ? { kind: "connect" } : { kind: "arm", at };
}

export function noteWaitNotifyResult(episode: WaitEpisode, pushSent: boolean): WaitEpisode {
  return pushSent || episode.attempts >= WAIT_NOTIFY_MAX_ATTEMPTS ? episode : { ...episode, notified: false };
}

export function pushOutcome(resultText: string, isError: boolean): boolean {
  return !isError && resultText.trim().startsWith(PUSH_REQUESTED_RESULT);
}

export function pushMessageOf(inputJson: string): string | undefined {
  try {
    const message = (JSON.parse(inputJson) as { message?: unknown } | null)?.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const CLIP_MARK = "...";

function codePoints(text: string): number {
  return Array.from(text).length;
}

function clip(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max <= CLIP_MARK.length ? CLIP_MARK.slice(0, Math.max(0, max)) : `${points.slice(0, max - CLIP_MARK.length).join("")}${CLIP_MARK}`;
}

export function waitNotificationMessage(conversation: string, items: readonly WaitReportItem[]): string {
  const name = oneLine(conversation);
  const title = oneLine(items[0]?.title ?? "");
  const more = Math.max(0, items.length - 1);
  const format = (n: string, t: string): string => more > 0
    ? l10n.t("\"{0}\" is waiting for you: {1} (+{2} more)", n, t, more)
    : l10n.t("\"{0}\" is waiting for you: {1}", n, t);
  let shownName = name;
  let shownTitle = title;
  let message = format(shownName, shownTitle);
  if (codePoints(message) > PUSH_MESSAGE_MAX) {
    shownTitle = clip(title, Math.max(1, codePoints(title) - (codePoints(message) - PUSH_MESSAGE_MAX)));
    message = format(shownName, shownTitle);
  }
  if (codePoints(message) > PUSH_MESSAGE_MAX) {
    shownName = clip(name, Math.max(1, codePoints(name) - (codePoints(message) - PUSH_MESSAGE_MAX)));
    message = format(shownName, shownTitle);
  }
  return clip(message, PUSH_MESSAGE_MAX);
}

export function waitNotifyRewakeText(message: string, titles: readonly string[]): string {
  return `${WAIT_NOTIFY_REWAKE_HEAD} call the PushNotification tool once. Its message is the whole last line of this notice after the "Message: " label that starts that line; send it unchanged, even if it contains that label again. Then ${WAIT_NOTIFY_WAKE_REPLY}\n\nWaiting, as JSON strings in order: ${titles.map((title) => JSON.stringify(oneLine(title))).join(", ")}\n\n${plainAskFormat()}\n\nMessage: ${message}`;
}

export const STOP_HOOK_FEEDBACK_PREFIX = "Stop hook blocking error from command \"Stop\": ";

export function isWaitNotifyRewake(text: string): boolean {
  const at = text.indexOf(`${STOP_HOOK_FEEDBACK_PREFIX}${WAIT_NOTIFY_REWAKE_HEAD}`);
  return at >= 0 && !text.slice(0, at).includes("<task-id>");
}

export function waitNotifyLine(message: string | undefined, pushSent: boolean): string {
  if (message === undefined) return pushSent ? l10n.t("LAISORA sent a mobile notification.") : l10n.t("LAISORA could not send a mobile notification.");
  return pushSent
    ? l10n.t("LAISORA sent a mobile notification: {0}", message)
    : l10n.t("LAISORA could not send a mobile notification: {0}", message);
}

export function wakeMessageMismatchReason(message: string): string {
  return `Send LAISORA's notification with exactly this message, unchanged: ${message}`;
}

export interface WakeGate { readonly message: string; readonly sent: boolean }

export type WakeToolDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "allow" };

export function wakeToolDecision(toolName: string, input: Record<string, unknown> | undefined, agentId: string | undefined, wake: WakeGate | undefined): WakeToolDecision {
  if (toolName === PUSH_NOTIFICATION_TOOL) {
    if (wake === undefined || agentId !== undefined) return { kind: "deny", reason: WAIT_NOTIFY_PUSH_OUTSIDE_WAKE_REASON };
    if (wake.sent) return { kind: "deny", reason: WAIT_NOTIFY_ALREADY_SENT_REASON };
    return input?.message === wake.message ? { kind: "allow" } : { kind: "deny", reason: wakeMessageMismatchReason(wake.message) };
  }
  if (wake === undefined || agentId !== undefined || toolName === TOOL_SEARCH_TOOL) return { kind: "pass" };
  return { kind: "deny", reason: WAIT_NOTIFY_WAKE_ONLY_REASON };
}

export interface WakeLine { readonly message?: string; readonly sent: boolean }

export function wakeLineAfterCall(line: WakeLine | undefined, inputJson: string | undefined, resultText: string, isError: boolean): WakeLine {
  if (line?.sent === true) return line;
  const message = inputJson === undefined ? undefined : pushMessageOf(inputJson);
  return { message: message ?? line?.message, sent: pushOutcome(resultText, isError) };
}

export type WakeVisibility = ReadonlyMap<string, boolean>;

export interface WakeVisibilityEvent { readonly kind: string; readonly turnId?: string | null; readonly laisoraWake?: true; readonly absorbedInto?: string }

export function foldWakeVisibility(state: WakeVisibility, ev: WakeVisibilityEvent): { state: WakeVisibility; revealed?: string } {
  if (ev.kind === "turn_started" && ev.laisoraWake === true && typeof ev.turnId === "string" && !state.has(ev.turnId)) {
    return { state: new Map(state).set(ev.turnId, false) };
  }
  if (ev.kind !== "user_message") return { state };
  const turnId = ev.absorbedInto ?? ev.turnId;
  if (turnId === null || turnId === undefined || state.get(turnId) !== false) return { state };
  return { state: new Map(state).set(turnId, true), revealed: turnId };
}

export function wakeTurnHidden(state: WakeVisibility, turnId: string | null): boolean {
  return turnId !== null && state.get(turnId) === false;
}

export interface WaitNotifyStopHook {
  readonly type: "command";
  readonly command: string;
  readonly args: string[];
  readonly asyncRewake: true;
  readonly timeout: number;
}

export interface WaitNotifyBell { readonly file: string; readonly text: string; readonly command: string; readonly args: (script: string, dir: string) => string[] }

export function waitNotifyStopHook(bell: WaitNotifyBell, script: string, dir: string): WaitNotifyStopHook {
  return { type: "command", command: bell.command, args: bell.args(script, dir), asyncRewake: true, timeout: WAIT_NOTIFY_HOOK_TIMEOUT_SECONDS };
}

export function waitNotifyFlagSettings(stopHook: WaitNotifyStopHook) {
  return { inputNeededNotifEnabled: true, agentPushNotifEnabled: true, hooks: { Stop: [{ hooks: [stopHook] }] } };
}

export function waitNotifyBell(platform: NodeJS.Platform): WaitNotifyBell {
  if (platform === "win32") {
    return {
      file: "wait-notify-bell.ps1",
      command: "powershell.exe",
      args: (script, dir) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, dir],
      text: [
        "param([string]$Dir)",
        `$epochFile = Join-Path $Dir '${WAIT_NOTIFY_EPOCH_FILE}'`,
        `$wakeFile = Join-Path $Dir '${WAIT_NOTIFY_WAKE_FILE}'`,
        `$armedFile = Join-Path $Dir '${WAIT_NOTIFY_ARMED_FILE}'`,
        `$alive = Join-Path $Dir ('${WAIT_NOTIFY_ALIVE_PREFIX}' + $PID)`,
        "function Leave([int]$code) { Remove-Item -LiteralPath $alive -ErrorAction SilentlyContinue; exit $code }",
        "$parent = (Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\").ParentProcessId",
        "$started = Get-Date",
        "$start = if (Test-Path -LiteralPath $epochFile) { [IO.File]::ReadAllText($epochFile) } else { '' }",
        "[IO.File]::WriteAllText($alive, '')",
        "while ($true) {",
        `  Start-Sleep -Seconds ${WAIT_NOTIFY_BELL_POLL_SECONDS}`,
        "  $elapsed = ((Get-Date) - $started).TotalSeconds",
        `  if ($elapsed -ge ${WAIT_NOTIFY_HOOK_TIMEOUT_SECONDS}) { Leave 0 }`,
        "  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { Leave 0 }",
        "  $now = if (Test-Path -LiteralPath $epochFile) { [IO.File]::ReadAllText($epochFile) } else { '' }",
        "  if ($now -ne $start) { Leave 0 }",
        "  [IO.File]::WriteAllText($alive, '')",
        "  $claim = Join-Path $Dir ('claimed-' + $PID)",
        "  try { Move-Item -LiteralPath $wakeFile -Destination $claim -ErrorAction Stop } catch {",
        `    if ($elapsed -ge ${WAIT_NOTIFY_ARM_GRACE_SECONDS} -and -not (Test-Path -LiteralPath $armedFile)) { Leave 0 }`,
        "    continue",
        "  }",
        "  $bytes = [IO.File]::ReadAllBytes($claim)",
        "  Remove-Item -LiteralPath $claim -ErrorAction SilentlyContinue",
        "  $err = [Console]::OpenStandardError()",
        "  $err.Write($bytes, 0, $bytes.Length)",
        "  $err.Flush()",
        "  Leave 2",
        "}",
        "",
      ].join("\r\n"),
    };
  }
  return {
    file: "wait-notify-bell.sh",
    command: "/bin/sh",
    args: (script, dir) => [script, dir],
    text: [
      'dir="$1"',
      "parent=$PPID",
      "started=$(date +%s)",
      `alive="$dir/${WAIT_NOTIFY_ALIVE_PREFIX}$$"`,
      `trap 'rm -f "$alive"' EXIT`,
      `start=$(cat "$dir/${WAIT_NOTIFY_EPOCH_FILE}" 2>/dev/null)`,
      ': > "$alive"',
      "while :; do",
      `  sleep ${WAIT_NOTIFY_BELL_POLL_SECONDS}`,
      "  elapsed=$(( $(date +%s) - started ))",
      `  [ "$elapsed" -ge ${WAIT_NOTIFY_HOOK_TIMEOUT_SECONDS} ] && exit 0`,
      '  kill -0 "$parent" 2>/dev/null || exit 0',
      `  now=$(cat "$dir/${WAIT_NOTIFY_EPOCH_FILE}" 2>/dev/null)`,
      '  [ "$now" = "$start" ] || exit 0',
      '  : > "$alive"',
      `  if mv "$dir/${WAIT_NOTIFY_WAKE_FILE}" "$dir/claimed-$$" 2>/dev/null; then`,
      '    cat "$dir/claimed-$$" >&2',
      '    rm -f "$dir/claimed-$$"',
      "    exit 2",
      "  fi",
      `  if [ "$elapsed" -ge ${WAIT_NOTIFY_ARM_GRACE_SECONDS} ] && [ ! -e "$dir/${WAIT_NOTIFY_ARMED_FILE}" ]; then exit 0; fi`,
      "done",
      "",
    ].join("\n"),
  };
}
