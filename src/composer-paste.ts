import * as vscode from "vscode";

import type { SessionStore } from "./store-surfaces";

export const COMPOSER_FOCUS_CONTEXT = "laisora.composerFocused";

let focusedComposer: vscode.Webview | null = null;

export function setComposerFocus(webview: vscode.Webview, focused: boolean): void {
  if (focused) focusedComposer = webview;
  else if (focusedComposer === webview) focusedComposer = null;
  else return;
  void vscode.commands.executeCommand("setContext", COMPOSER_FOCUS_CONTEXT, focusedComposer !== null);
}

export async function pasteClipboardTextIntoComposer(st: SessionStore | null): Promise<void> {
  const target = focusedComposer;
  if (!st || !target) return;
  const text = await vscode.env.clipboard.readText();
  if (text) void st.postTo(target, { type: "pasteText", text });
}
