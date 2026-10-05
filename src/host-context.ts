import * as vscode from "vscode";

import type { ArtifactServer } from "./artifactServer";
import type { SessionStore } from "./extension";

export let output: vscode.OutputChannel;
export let extensionContext: vscode.ExtensionContext | null = null;
export let activationT0 = Date.now();
export function sinceActivation(): string {
  return `t+${Date.now() - activationT0}ms`;
}
export let artifactServer: ArtifactServer | null = null;
export let store: SessionStore | null = null;

export const disposeHooked = new WeakSet<vscode.WebviewView>();

export function setActivationT0(at: number): void {
  activationT0 = at;
}

export function setExtensionContext(context: vscode.ExtensionContext | null): void {
  extensionContext = context;
}

export function setOutput(channel: vscode.OutputChannel): void {
  output = channel;
}

export function setArtifactServer(server: ArtifactServer | null): void {
  artifactServer = server;
}

export function setStore(next: SessionStore | null): void {
  store = next;
}
