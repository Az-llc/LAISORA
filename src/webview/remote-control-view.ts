import * as l10n from "@vscode/l10n";
import type { BridgeConnection, RemoteControlView, SlashCommandInfo } from "../protocol";

export const REMOTE_CONTROL_COMMAND = "remote-control";
export const REMOTE_CONTROL_COMMAND_ALIASES: readonly string[] = ["rc"];
export const REMOTE_CONTROL_CARD_HIDDEN_CLASS = "rc-card-hidden";

export const REMOTE_CONTROL_SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: REMOTE_CONTROL_COMMAND, aliases: [...REMOTE_CONTROL_COMMAND_ALIASES], description: l10n.t("Turn Remote Control on or off for this conversation (LAISORA)") },
];

export function parseRemoteControlCommand(text: string): "toggle" | "usage" | undefined {
  const trimmed = text.trim();
  if (/[\r\n]/.test(trimmed)) return undefined;
  const [head, ...args] = trimmed.split(/\s+/);
  if (![REMOTE_CONTROL_COMMAND, ...REMOTE_CONTROL_COMMAND_ALIASES].some((name) => head === `/${name}`)) return undefined;
  return args.length === 0 ? "toggle" : "usage";
}

export function remoteControlLabel(): string {
  return l10n.t("Remote Control");
}

export function remoteControlOn(view: RemoteControlView | undefined): boolean {
  return view?.sessionUrl !== undefined;
}

export function connectionText(connection: BridgeConnection | undefined): string {
  switch (connection) {
    case "connected": return l10n.t("Connected");
    case "failed": return l10n.t("Connection to claude.ai failed");
    case "policy_disabled": return l10n.t("Not allowed by your organization's policy");
    default: return l10n.t("Connecting…");
  }
}

export type RemoteControlCardAction = "create" | "update" | "close" | "none";

export function remoteControlCardAction(cardOpen: boolean, view: RemoteControlView | undefined): RemoteControlCardAction {
  if (remoteControlOn(view)) return cardOpen ? "update" : "create";
  return cardOpen ? "close" : "none";
}

export interface RemoteControlCardState { stateText: string; sessionUrl?: string }

export function remoteControlCardState(view: RemoteControlView | undefined): RemoteControlCardState {
  return view?.sessionUrl === undefined
    ? { stateText: l10n.t("Disconnected") }
    : { stateText: connectionText(view.connection), sessionUrl: view.sessionUrl };
}

export function remoteControlCardNotes(menuGlyph: string): string[] {
  return [
    l10n.t("The session is reachable from claude.ai and the Claude app only while VS Code and LAISORA are running."),
    l10n.t("Closing this tab or VS Code takes it offline, and messages sent from there while it is offline are refused."),
    l10n.t("After VS Code restarts, Remote Control does not reconnect by itself unless \"Claude: Remote Control At Startup\" (laisora.claude.remoteControlAtStartup) is on in VS Code Settings; turn it on again from the {0} menu to get the same claude.ai link.", menuGlyph),
  ];
}
