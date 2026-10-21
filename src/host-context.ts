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
  output = silentAfterDispose(channel);
}

function silentAfterDispose(channel: vscode.OutputChannel): vscode.OutputChannel {
  let open = true;
  const whileOpen =
    <A extends unknown[]>(write: (...args: A) => void) =>
    (...args: A): void => {
      if (open) write(...args);
    };
  return {
    name: channel.name,
    append: whileOpen((value: string) => channel.append(value)),
    appendLine: whileOpen((value: string) => channel.appendLine(value)),
    replace: whileOpen((value: string) => channel.replace(value)),
    clear: whileOpen(() => channel.clear()),
    show: whileOpen((columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean) =>
      channel.show(columnOrPreserveFocus as vscode.ViewColumn, preserveFocus)
    ) as vscode.OutputChannel["show"],
    hide: whileOpen(() => channel.hide()),
    dispose: () => {
      if (!open) return;
      open = false;
      channel.dispose();
    },
  };
}

export function setArtifactServer(server: ArtifactServer | null): void {
  artifactServer = server;
}

export function setStore(next: SessionStore | null): void {
  store = next;
}
