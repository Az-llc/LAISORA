import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { randomBytes } from "node:crypto";
import { updateClaudeCodeSettings } from "./claude-settings";
import { output } from "./host-context";
import { isSettingsPageToHost, type SettingWriteFailure } from "./protocol";
import {
  settingsStateMessage,
  loadSettingsProfiles,
  projectConductorPreview,
  requestModelProfileResearch,
  refreshExternalDetection,
  writeApiKeyPolicy,
  writeAccentSetting,
  writeDisplayName,
  writeLearningEnabled,
  writeProfileSources,
  writeComposerSendKey,
  writeFileLinkSetting,
  writeOrchestrationSetting,
  writeRestoreTabsOnStartup,
  writeInitialModel,
} from "./gateway-host-actions";

let settingsPanel: vscode.WebviewPanel | null = null;
const refreshedPages = new WeakSet<vscode.Webview>();

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
  panel.webview.onDidReceiveMessage((raw: unknown) => void handleSettingsPageMessage(panel.webview, raw, detect));
  panel.webview.html = settingsPageHtml({
    cspSource: panel.webview.cspSource,
    nonce: randomBytes(16).toString("base64"),
    scriptUri: String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "settings.js"))),
    cssUri: String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "settings.css"))),
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
  if (panel) void loadSettingsProfiles().then(() => { if (settingsPanel === panel) void panel.webview.postMessage(settingsStateMessage()); });
}

export async function handleSettingsPageMessage(webview: vscode.Webview, raw: unknown, detect?: Parameters<typeof refreshExternalDetection>[0]): Promise<void> {
  if (!isSettingsPageToHost(raw)) {
    output.appendLine(`[drop] invalid settings page message: ${JSON.stringify(raw).slice(0, 200)}`);
    return;
  }
  let writeFailure: SettingWriteFailure | undefined;
  switch (raw.type) {
    case "previewConductorInstruction":
      await loadSettingsProfiles();
      void webview.postMessage({ type: "conductorPreview", requestId: raw.requestId, ...projectConductorPreview(raw.policy) });
      return;
    case "researchModelProfiles":
      await loadSettingsProfiles();
      requestModelProfileResearch(raw.targets, raw.purpose);
      break;
    case "openVsCodeSettings":
      await vscode.commands.executeCommand("workbench.action.openSettings", "laisora");
      return;
    case "settingWriteFailureAction":
      await vscode.commands.executeCommand(raw.action === "reloadWindow" ? "workbench.action.reloadWindow" : "workbench.action.openSettingsJson");
      return;
    case "settingsPageReady":
    case "recheckExternalExecutors":
      break;
    case "setAccentSetting":
      writeFailure = await writeAccentSetting(raw.setting, raw.value);
      break;
    case "setDisplayName":
      writeFailure = await writeDisplayName(raw.value);
      break;
    case "setComposerSendKey":
      writeFailure = await writeComposerSendKey(raw.sendKey);
      break;
    case "setApiKeyPolicy":
      writeFailure = await writeApiKeyPolicy(raw.policy);
      break;
    case "setAutoContinueAtUsageLimit":
      if (!updateClaudeCodeSettings({ autoContinueAtUsageLimit: raw.enabled }).ok) {
        void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not save the setting."));
      }
      break;
    case "setInitialModel":
      writeFailure = await writeInitialModel(raw.model);
      break;
    case "setRestoreTabsOnStartup":
      writeFailure = await writeRestoreTabsOnStartup(raw.enabled);
      break;
    case "setLearningEnabled":
      writeFailure = await writeLearningEnabled(raw.enabled);
      break;
    case "setProfileSources":
      writeFailure = await writeProfileSources(raw.sources);
      break;
    case "setOrchestrationSetting":
      writeFailure = await writeOrchestrationSetting(raw.setting, raw.value);
      break;
    case "setFileLinkSetting":
      writeFailure = await writeFileLinkSetting(raw.setting, raw.setting === "openWithSystemApp" ? raw.value : raw.enabled);
      break;
  }
  if (raw.type === "settingsPageReady" && settingsPanel?.webview === webview) {
    void webview.postMessage(settingsStateMessage());
  }
  if (settingsPanel?.webview !== webview) return;
  if (raw.type === "recheckExternalExecutors" || raw.type === "settingsPageReady" && !refreshedPages.has(webview)) {
    refreshedPages.add(webview);
    const pending = refreshExternalDetection(detect, () => {
      if (settingsPanel?.webview === webview) void webview.postMessage(settingsStateMessage());
    });
    void webview.postMessage(settingsStateMessage());
    void pending.then(async () => {
      await loadSettingsProfiles();
      if (settingsPanel?.webview === webview) void webview.postMessage(settingsStateMessage());
    });
  }
  await loadSettingsProfiles();
  const reply = settingsStateMessage();
  if (settingsPanel?.webview !== webview) return;
  if ("requestId" in raw) {
    reply.replyTo = raw.requestId;
    if (writeFailure) reply.writeFailure = writeFailure;
  }
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
