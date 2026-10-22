import * as l10n from "@vscode/l10n";
import type { BridgeConnection, RemoteControlView } from "./protocol";
import { extensionContext, output, store } from "./host-context";
import { sessionRecordId } from "./session-record";
import type { ClaudeConversation } from "./claudeHost";
import type { Session } from "./session";
import {
  INITIAL_REMOTE_CONTROL_LANE,
  REMOTE_CONTROL_POLICY_OFF,
  REMOTE_CONTROL_SESSIONS_KEY,
  REMOTE_CONTROL_TIMEOUT_MS,
  remoteControlAtLaunch,
  remoteControlRecordOf,
  stepRemoteControlLane,
  withRemoteControlRecord,
  type RemoteControlCli,
  type RemoteControlLaneInput,
  type RemoteControlRecord,
  type RemoteControlRequest,
  type RemoteControlSession,
  type RemoteControlStep,
} from "./remote-control";

function storedRecord(s: Session): RemoteControlRecord | undefined {
  const sessionId = sessionRecordId(s);
  return (sessionId === undefined ? undefined : remoteControlRecordOf(extensionContext?.globalState.get<unknown>(REMOTE_CONTROL_SESSIONS_KEY), sessionId)) ?? s.remoteControl.unsaved;
}

function knownBridgeSessionId(s: Session): string | undefined {
  return s.remoteControl.bridgeSessionId ?? storedRecord(s)?.bridgeSessionId;
}

function storeRecord(s: Session, bridgeSessionId: string): void {
  s.remoteControl.unsaved = { bridgeSessionId };
  flushRemoteControlRecord(s);
}

export function flushRemoteControlRecord(s: Session): void {
  const record = s.remoteControl.unsaved;
  const sessionId = sessionRecordId(s);
  const state = extensionContext?.globalState;
  if (record === undefined || sessionId === undefined || state === undefined) return;
  s.remoteControl.unsaved = undefined;
  void Promise.resolve(state.update(REMOTE_CONTROL_SESSIONS_KEY, withRemoteControlRecord(state.get<unknown>(REMOTE_CONTROL_SESSIONS_KEY), sessionId, record)))
    .then(undefined, (error: unknown) => output.appendLine(`[${s.title}] Remote Control: could not save the state: ${String(error)}`));
}

function cliOf(s: Session): RemoteControlCli | undefined {
  const conv = s.conversation;
  const cli = s.remoteControl.cli;
  return conv !== null && !conv.isClosed && cli?.conversation === conv ? cli : undefined;
}

function cliFor(s: Session, conv: ClaudeConversation): RemoteControlCli {
  if (s.remoteControl.cli?.conversation !== conv) s.remoteControl.cli = { conversation: conv, lane: INITIAL_REMOTE_CONTROL_LANE };
  return s.remoteControl.cli;
}

export function remoteControlView(s: Session): RemoteControlView {
  const conv = s.conversation;
  const available = conv !== null && !conv.isClosed;
  const cli = cliOf(s);
  return {
    available,
    pending: cli?.lane.busy === true,
    ...(cli?.sessionUrl === undefined ? {} : { sessionUrl: cli.sessionUrl }),
    ...(cli?.sessionUrl === undefined || cli.connection === undefined ? {} : { connection: cli.connection }),
  };
}

export function postRemoteControl(s: Session): void {
  if (!s.closed) store?.post({ type: "remoteControlState", tabId: s.tabId, state: remoteControlView(s) });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(s: Session, enabled: boolean, reason: string): void {
  s.pushEvent({
    kind: "error",
    message: enabled ? l10n.t("Remote Control could not be turned on: {0}", reason) : l10n.t("Remote Control could not be turned off: {0}", reason),
    fatal: false,
  });
}

function stuckText(): string {
  return l10n.t("Remote Control may not switch in this tab until Claude Code answers or the conversation restarts (after the current reply ends: /clear, or close the tab and reopen it from history).");
}

type Settled = { ok: true; session: RemoteControlSession | null } | { ok: false; error: unknown };

function apply(s: Session, cli: RemoteControlCli, input: RemoteControlLaneInput, settled?: Settled): RemoteControlStep {
  const before = cli.lane;
  const step = stepRemoteControlLane(before, input);
  cli.lane = step.lane;
  const request = before.busy ? before.request : undefined;
  const reason = settled?.ok === false ? errorText(settled.error) : undefined;
  if (reason !== undefined && step.verdict !== "ignored") output.appendLine(`[${s.title}] Remote Control ${request?.enabled ? "on" : "off"}${request?.reattach === undefined ? "" : " (reattach)"} failed: ${reason}`);
  switch (step.verdict) {
    case "adopt":
    case "adoptThenOff": {
      const session = settled?.ok === true ? settled.session : null;
      if (session !== null) {
        cli.sessionUrl = session.sessionUrl;
        s.remoteControl.bridgeSessionId = session.bridgeSessionId;
        storeRecord(s, session.bridgeSessionId);
      }
      if (step.verdict === "adoptThenOff") output.appendLine(`[${s.title}] Remote Control: the request turned on after it was abandoned; turning it off`);
      break;
    }
    case "timedOut":
      if (request!.enabled) s.remoteControl.choice = false;
      reportFailure(s, request!.enabled, l10n.t("Claude Code did not answer the Remote Control request in time. {0}", stuckText()));
      break;
    case "timedOutForced":
      output.appendLine(`[${s.title}] Remote Control: Claude Code did not answer the off request LAISORA sent on its own in time`);
      break;
    case "enableFailed":
      s.remoteControl.choice = false;
      reportFailure(s, true, reason!);
      break;
    case "off":
      cli.sessionUrl = undefined;
      cli.connection = undefined;
      break;
    case "disableFailed":
      if (request!.forced) {
        s.pushEvent({ kind: "error", message: l10n.t("Remote Control is still on: it could not be turned off ({0}).", reason!), fatal: false });
      } else {
        s.remoteControl.choice = true;
        reportFailure(s, false, reason!);
      }
      break;
    case "silentFailure":
      if (request?.enabled === false && !request.forced) s.remoteControl.choice = true;
      break;
    default:
      break;
  }
  postRemoteControl(s);
  return step;
}

async function drive(s: Session, cli: RemoteControlCli, first: RemoteControlRequest): Promise<void> {
  for (let request: RemoteControlRequest | undefined = first; request !== undefined;) {
    const seq = cli.lane.seq;
    if (request.enabled) cli.connection = undefined;
    postRemoteControl(s);
    const timer = setTimeout(() => {
      if (s.remoteControl.cli === cli) apply(s, cli, { type: "timeout", seq });
    }, REMOTE_CONTROL_TIMEOUT_MS);
    let settled: Settled;
    try {
      settled = { ok: true, session: await cli.conversation.setRemoteControl(request.enabled, request.reattach) };
    } catch (error) {
      settled = { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
    if (s.remoteControl.cli !== cli) return;
    request = apply(s, cli, { type: "settled", seq, ok: settled.ok }, settled).send;
  }
}

export async function setRemoteControl(s: Session, requested: boolean | undefined, origin: "user" | "launch"): Promise<void> {
  const conv = s.conversation;
  if (conv === null || conv.isClosed || s.closed) {
    if (origin === "user") s.pushEvent({ kind: "error", message: l10n.t("Remote Control needs a running conversation. Send a message first, then try again."), fatal: false });
    return;
  }
  const cli = cliFor(s, conv);
  const on = cli.sessionUrl !== undefined;
  const enabled = requested ?? !on;
  const reattach = enabled ? knownBridgeSessionId(s) : undefined;
  const step = apply(s, cli, { type: "request", request: { enabled, ...(reattach === undefined ? {} : { reattach }) }, on });
  if (step.verdict === "refused" || step.verdict === "refusedStuck") {
    const text = step.verdict === "refused" ? l10n.t("Remote Control is still switching. Try again when it has finished.") : stuckText();
    if (origin === "user") store?.post({ type: "tabNotice", tabId: s.tabId, text });
    return;
  }
  if (origin === "user") s.remoteControl.choice = enabled;
  if (step.send !== undefined) await drive(s, cli, step.send);
}

export async function startRemoteControlAtLaunch(s: Session, conv: ClaudeConversation): Promise<void> {
  postRemoteControl(s);
  const autoEnable = await conv.remoteControlAutoEnable();
  if (s.conversation !== conv || conv.isClosed) return;
  if (remoteControlAtLaunch(s.remoteControl.choice, autoEnable)) await setRemoteControl(s, true, "launch");
}

export function noteBridgeState(s: Session, conv: ClaudeConversation, connection: BridgeConnection): void {
  if (s.conversation !== conv || conv.isClosed) return;
  const cli = cliFor(s, conv);
  cli.connection = connection;
  if (connection !== REMOTE_CONTROL_POLICY_OFF) {
    postRemoteControl(s);
    return;
  }
  const step = apply(s, cli, { type: "policyOff", on: cli.sessionUrl !== undefined });
  if (step.verdict !== "sent" && step.verdict !== "offQueued") return;
  s.remoteControl.choice = false;
  s.pushEvent({ kind: "error", message: l10n.t("Remote Control was turned off: your organization's policy does not allow it."), fatal: false });
  if (step.send !== undefined) void drive(s, cli, step.send);
}

export function noteRemoteControlClosed(s: Session, conv: ClaudeConversation): void {
  if (s.conversation !== conv) return;
  const cli = s.remoteControl.cli;
  if (cli?.conversation === conv) apply(s, cli, { type: "exit" });
  else postRemoteControl(s);
}
