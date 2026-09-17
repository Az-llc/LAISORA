import * as vscode from "vscode";

import type { ArtifactServer } from "./artifactServer";
import type { SessionStore } from "./extension";

// activate が注入するホスト単位の状態。読み手は `export let` の live binding をそのまま参照する。
// getter で包むと呼び出し側の綴りが変わり、束ね後の文字列へ変異を注入している検査の的
// （output.appendLine( など）が一斉に外れる。書き込みは import binding へ代入できないので setter を通す。
export let output: vscode.OutputChannel;
export let extensionContext: vscode.ExtensionContext | null = null;
// 起動直後の遅さを調べるための共通原点。どの処理がどの処理と重なっていたかは、
// 個々の所要時間ではなく activate からの経過でしか読めない
export let activationT0 = Date.now();
export function sinceActivation(): string {
  return `t+${Date.now() - activationT0}ms`;
}
export let artifactServer: ArtifactServer | null = null;
export let store: SessionStore | null = null;

// onDidDispose を登録済みの WebviewView（再 resolve での二重登録防止）
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
