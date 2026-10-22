import * as l10n from "@vscode/l10n";
import { BRIDGE_CONNECTIONS, isRemoteControlSessionUrl, type BridgeConnection } from "./protocol";
import type { ClaudeConversation } from "./claudeHost";

export const REMOTE_CONTROL_CARD_SETTING = "remoteControl.showCard";
export const REMOTE_CONTROL_SESSIONS_KEY = "remoteControl.sessions";
export const REMOTE_CONTROL_SESSIONS_MAX = 200;
export const REMOTE_CONTROL_TIMEOUT_MS = 30_000;
export const REMOTE_CONTROL_POLICY_OFF: BridgeConnection = "policy_disabled";

export interface RemoteControlSession { sessionUrl: string; bridgeSessionId: string }

export interface RemoteControlRecord { bridgeSessionId: string }

export interface RemoteControlRequest { enabled: boolean; reattach?: string; forced?: true }

export type RemoteControlLane =
  | { readonly seq: number; readonly busy: false }
  | { readonly seq: number; readonly busy: true; readonly request: RemoteControlRequest; readonly timedOut: boolean; readonly offAfter: boolean };

export type RemoteControlLaneInput =
  | { readonly type: "request"; readonly request: RemoteControlRequest; readonly on: boolean }
  | { readonly type: "timeout"; readonly seq: number }
  | { readonly type: "policyOff"; readonly on: boolean }
  | { readonly type: "settled"; readonly seq: number; readonly ok: boolean }
  | { readonly type: "exit" };

export type RemoteControlVerdict =
  | "sent" | "unchanged" | "refused" | "refusedStuck" | "ignored" | "offQueued" | "timedOut" | "timedOutForced"
  | "adopt" | "adoptThenOff" | "retry" | "enableFailed" | "silentFailure"
  | "off" | "disableFailed" | "abandoned";

export interface RemoteControlStep { lane: RemoteControlLane; verdict: RemoteControlVerdict; send?: RemoteControlRequest }

export const INITIAL_REMOTE_CONTROL_LANE: RemoteControlLane = { seq: 0, busy: false };

export interface RemoteControlCli { conversation: ClaudeConversation; lane: RemoteControlLane; sessionUrl?: string; connection?: BridgeConnection }

export interface TabRemoteControl {
  choice?: boolean;
  bridgeSessionId?: string;
  unsaved?: RemoteControlRecord;
  cli?: RemoteControlCli;
}

export function initialTabRemoteControl(choice?: boolean): TabRemoteControl {
  return choice === undefined ? {} : { choice };
}

function sending(lane: RemoteControlLane, verdict: RemoteControlVerdict, request: RemoteControlRequest): RemoteControlStep {
  return { lane: { seq: lane.seq + 1, busy: true, request, timedOut: false, offAfter: false }, verdict, send: request };
}

export function stepRemoteControlLane(lane: RemoteControlLane, input: RemoteControlLaneInput): RemoteControlStep {
  const idle: RemoteControlLane = { seq: lane.seq, busy: false };
  switch (input.type) {
    case "request":
      if (lane.busy) return { lane, verdict: lane.timedOut ? "refusedStuck" : "refused" };
      return input.on === input.request.enabled ? { lane, verdict: "unchanged" } : sending(lane, "sent", input.request);
    case "policyOff":
      if (lane.busy) {
        return lane.request.enabled && !lane.offAfter && !lane.timedOut ? { lane: { ...lane, offAfter: true }, verdict: "offQueued" } : { lane, verdict: "ignored" };
      }
      return input.on ? sending(lane, "sent", { enabled: false, forced: true }) : { lane, verdict: "ignored" };
    case "exit":
      return { lane: { seq: lane.seq + 1, busy: false }, verdict: lane.busy ? "abandoned" : "ignored" };
    case "timeout":
      if (!lane.busy || lane.seq !== input.seq || lane.timedOut) return { lane, verdict: "ignored" };
      return { lane: { ...lane, timedOut: true }, verdict: lane.request.forced ? "timedOutForced" : "timedOut" };
    case "settled": {
      if (!lane.busy || lane.seq !== input.seq) return { lane, verdict: "ignored" };
      const { request } = lane;
      if (!request.enabled) return { lane: idle, verdict: input.ok ? "off" : lane.timedOut && !request.forced ? "silentFailure" : "disableFailed" };
      const discarded = lane.timedOut || lane.offAfter;
      if (input.ok) return discarded ? sending(lane, "adoptThenOff", { enabled: false, forced: true }) : { lane: idle, verdict: "adopt" };
      if (discarded) return { lane: idle, verdict: "silentFailure" };
      return request.reattach !== undefined ? sending(lane, "retry", { enabled: true }) : { lane: idle, verdict: "enableFailed" };
    }
  }
}

export async function enableRemoteControl(query: unknown, enabled: boolean, reattachSessionId?: string): Promise<RemoteControlSession | null> {
  const method = (query as { enableRemoteControl?: unknown } | null)?.enableRemoteControl;
  if (typeof method !== "function") {
    throw new Error(l10n.t("This version of the Claude Agent SDK has no Remote Control method (Query.enableRemoteControl). Update LAISORA."));
  }
  const response: unknown = await method.call(query, enabled, undefined, reattachSessionId === undefined ? undefined : { reattachSessionId });
  if (!enabled) return null;
  const r = (typeof response === "object" && response !== null ? response : {}) as Record<string, unknown>;
  if (!isRemoteControlSessionUrl(r.session_url) || typeof r.bridge_session_id !== "string" || r.bridge_session_id.length === 0) {
    throw new Error(l10n.t("Claude Code did not return a Remote Control session link."));
  }
  return { sessionUrl: r.session_url, bridgeSessionId: r.bridge_session_id };
}

export function bridgeStateOf(message: unknown): BridgeConnection | undefined {
  const m = message as { type?: unknown; subtype?: unknown; state?: unknown } | null;
  if (m?.type !== "system" || m.subtype !== "bridge_state") return undefined;
  return (BRIDGE_CONNECTIONS as readonly unknown[]).includes(m.state) ? m.state as BridgeConnection : undefined;
}

export function remoteControlAtLaunch(choice: boolean | undefined, autoEnable: boolean): boolean {
  return choice ?? autoEnable;
}

function recordsOf(raw: unknown): Record<string, RemoteControlRecord> {
  const out: Record<string, RemoteControlRecord> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [sessionId, value] of Object.entries(raw)) {
    const bridgeSessionId = (value as { bridgeSessionId?: unknown } | null)?.bridgeSessionId;
    if (typeof bridgeSessionId === "string" && bridgeSessionId.length > 0) out[sessionId] = { bridgeSessionId };
  }
  return out;
}

export function remoteControlRecordOf(raw: unknown, sessionId: string): RemoteControlRecord | undefined {
  return recordsOf(raw)[sessionId];
}

export function withRemoteControlRecord(raw: unknown, sessionId: string, record: RemoteControlRecord): Record<string, RemoteControlRecord> {
  const { [sessionId]: _replaced, ...rest } = recordsOf(raw);
  const entries = [...Object.entries(rest), [sessionId, record] as const];
  return Object.fromEntries(entries.slice(-REMOTE_CONTROL_SESSIONS_MAX));
}
