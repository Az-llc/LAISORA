import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { randomBytes } from "node:crypto";
import { updateClaudeCodeSettings } from "./claude-settings";
import { output } from "./host-context";
import { isSettingsPageToHost } from "./protocol";
import {
  settingsStateMessage,
  refreshExternalDetection,
  writeApiKeyPolicy,
  writeAccentSetting,
  writeLearningEnabled,
  writeComposerSendKey,
  writeFileLinkSetting,
  writeOrchestrationSetting,
  writeRestoreTabsOnStartup,
} from "./gateway-host-actions";

let settingsPanel: vscode.WebviewPanel | null = null;

export function openSettingsPanel(context: vscode.ExtensionContext, detect?: Parameters<typeof refreshExternalDetection>[0]): void {
  if (settingsPanel) {
    settingsPanel.reveal();
    postSettingsState();
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
  panel.webview.onDidReceiveMessage((raw: unknown) => void handleSettingsPageMessage(panel.webview, raw, detect));
  panel.webview.html = settingsPageHtml({
    cspSource: panel.webview.cspSource,
    nonce: randomBytes(16).toString("base64"),
    scriptUri: String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "settings.js"))),
    cssUri: String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "settings.css"))),
    // 判定は src/webview/l10n-boot.ts#selectWebviewL10nBundle と同一（ja 前方一致だけが ja）
    lang: String(vscode.env.language ?? "").toLowerCase().startsWith("ja") ? "ja" : "en",
  });
  panel.onDidChangeViewState(() => { if (panel.visible) postSettingsState(); });
  panel.onDidDispose(() => {
    if (settingsPanel === panel) settingsPanel = null;
  });
  context.subscriptions.push(panel);
}

export function postSettingsState(): void {
  const panel = settingsPanel;
  if (panel) void panel.webview.postMessage(settingsStateMessage());
}

export async function handleSettingsPageMessage(webview: vscode.Webview, raw: unknown, detect?: Parameters<typeof refreshExternalDetection>[0]): Promise<void> {
  if (!isSettingsPageToHost(raw)) {
    output.appendLine(`[drop] invalid settings page message: ${JSON.stringify(raw).slice(0, 200)}`);
    return;
  }
  switch (raw.type) {
    case "openVsCodeSettings":
      await vscode.commands.executeCommand("workbench.action.openSettings", "laisora");
      return;
    case "settingsPageReady":
    case "recheckExternalExecutors":
      break;
    case "setAccentSetting":
      await writeAccentSetting(raw.setting, raw.value);
      break;
    case "setComposerSendKey":
      await writeComposerSendKey(raw.sendKey);
      break;
    case "setApiKeyPolicy":
      await writeApiKeyPolicy(raw.policy);
      break;
    case "setAutoContinueAtUsageLimit":
      if (!updateClaudeCodeSettings({ autoContinueAtUsageLimit: raw.enabled }).ok) {
        void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not save the setting."));
      }
      break;
    case "setRestoreTabsOnStartup":
      await writeRestoreTabsOnStartup(raw.enabled);
      break;
    case "setLearningEnabled":
      await writeLearningEnabled(raw.enabled);
      break;
    case "setOrchestrationSetting":
      await writeOrchestrationSetting(raw.setting, raw.value);
      break;
    case "setFileLinkSetting":
      await writeFileLinkSetting(raw.setting, raw.setting === "openWithSystemApp" ? raw.value : raw.enabled);
      break;
  }
  // 書込みを待つ間に閉じられた画面へは送らない（R-DSP-01）
  // 書込みが失敗しても、上位の層が値を持っていても、画面は構成から読み直した値へ戻る（R-DSP-01）。
  // 値が変わらない書込みでは構成変更の通知が出ないことがあるので、成功時もこの返送を省かない。画面の押下ロックは replyTo でだけ解ける
  const reply = settingsStateMessage();
  if (settingsPanel?.webview !== webview) return; // R-DSP-01
  if ("requestId" in raw) reply.replyTo = raw.requestId;
  void webview.postMessage(reply);
  if (raw.type === "settingsPageReady" || raw.type === "recheckExternalExecutors") {
    const pending = refreshExternalDetection(detect);
    void webview.postMessage(settingsStateMessage());
    void pending.then(() => {
      if (settingsPanel?.webview === webview) void webview.postMessage(settingsStateMessage()); // R-ORC-20: completion belongs to the requesting page.
    });
  }
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
