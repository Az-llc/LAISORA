import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { randomBytes } from "node:crypto";
import { output } from "./host-context";
import { isSettingsPageToHost } from "./protocol";
import {
  settingsStateMessage,
  writeApiKeyPolicy,
  writeComposerSendKey,
  writeFileLinkSetting,
  writeRestoreTabsOnStartup,
} from "./gateway-host-actions";

let settingsPanel: vscode.WebviewPanel | null = null;

export function openSettingsPanel(context: vscode.ExtensionContext): void {
  if (settingsPanel) {
    settingsPanel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel("laisora.settings", l10n.t("LAISORA Settings"), vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "dist"),
      vscode.Uri.joinPath(context.extensionUri, "media"),
    ],
  });
  settingsPanel = panel;
  // HTML を評価可能にする前に受信口を開く（逆順だと画面の settingsPageReady を取りこぼす）
  panel.webview.onDidReceiveMessage((raw: unknown) => void handleSettingsPageMessage(panel.webview, raw));
  panel.webview.html = settingsPageHtml({
    cspSource: panel.webview.cspSource,
    nonce: randomBytes(16).toString("base64"),
    scriptUri: String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "settings.js"))),
    cssUri: String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "settings.css"))),
    // 判定は src/webview/l10n-boot.ts#selectWebviewL10nBundle と同一（ja 前方一致だけが ja）
    lang: String(vscode.env.language ?? "").toLowerCase().startsWith("ja") ? "ja" : "en",
  });
  panel.onDidDispose(() => {
    if (settingsPanel === panel) settingsPanel = null;
  });
  context.subscriptions.push(panel);
}

export function postSettingsState(): void {
  if (settingsPanel) void settingsPanel.webview.postMessage(settingsStateMessage());
}

export async function handleSettingsPageMessage(webview: vscode.Webview, raw: unknown): Promise<void> {
  if (!isSettingsPageToHost(raw)) {
    output.appendLine(`[drop] invalid settings page message: ${JSON.stringify(raw).slice(0, 200)}`);
    return;
  }
  switch (raw.type) {
    case "openVsCodeSettings":
      await vscode.commands.executeCommand("workbench.action.openSettings", "laisora");
      return;
    case "settingsPageReady":
      break;
    case "setComposerSendKey":
      await writeComposerSendKey(raw.sendKey);
      break;
    case "setApiKeyPolicy":
      await writeApiKeyPolicy(raw.policy);
      break;
    case "setRestoreTabsOnStartup":
      await writeRestoreTabsOnStartup(raw.enabled);
      break;
    case "setFileLinkSetting":
      await writeFileLinkSetting(raw.setting, raw.enabled);
      break;
  }
  // 書込みを待つ間に閉じられた画面へは送らない（R-DSP-01）
  if (settingsPanel?.webview !== webview) return;
  // 書込みが失敗しても、上位の層が値を持っていても、画面は構成から読み直した値へ戻る（R-DSP-01）。
  // 値が変わらない書込みでは構成変更の通知が出ないことがあるので、成功時もこの返送を省かない。画面の押下ロックは replyTo でだけ解ける
  const reply = settingsStateMessage();
  if ("requestId" in raw) reply.replyTo = raw.requestId;
  void webview.postMessage(reply);
}

export function settingsPageHtml(page: { cspSource: string; nonce: string; scriptUri: string; cssUri: string; lang: "ja" | "en" }): string {
  return `<!DOCTYPE html>
<html lang="${page.lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${page.cspSource}; script-src 'nonce-${page.nonce}'; img-src data:; form-action 'none'; base-uri 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${page.cssUri}">
<title>LAISORA</title>
</head>
<body>
<main id="settings-root"></main>
<script nonce="${page.nonce}" src="${page.scriptUri}"></script>
</body>
</html>`;
}
