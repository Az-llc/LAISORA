import * as vscode from "vscode";
import {
  normalizeApiKeyPolicy,
  normalizeComposerSendKey,
  type ApiKeyPolicy,
  type ComposerSendKey,
  type FileLinkSetting,
  type HostToSettingsPage,
  type HostToWebview,
  type WebviewToHost,
} from "./protocol";
import * as l10n from "@vscode/l10n";
import { getLaisoraConfiguration } from "./claude-settings";
import { extensionContext, output, store } from "./host-context";
import { ADDITIONAL_MODELS_KEY, CLAUDE_VERSION_ID, additionalClaudeModelIds, recomputeModelRows, modelsMessage } from "./gateway-models";
import { restoreTabsOnStartupEnabled } from "./session-list-wiring";

export function userSettingsMessage(): Extract<HostToWebview, { type: "userSettings" }> {
  return {
    type: "userSettings",
    composerSendKey: normalizeComposerSendKey(getLaisoraConfiguration().get("composer.sendKey", "enter")),
  };
}

const FILE_LINK_SETTING_KEYS: Record<FileLinkSetting, string> = {
  fileLinkInstruction: "claude.fileLinkInstruction",
  revealInExplorer: "fileLinks.revealInExplorer",
  allowOutsideWorkspace: "fileLinks.allowOutsideWorkspace",
  confirmOutsideWorkspace: "fileLinks.confirmOutsideWorkspace",
  openOutsideReadOnly: "fileLinks.openOutsideReadOnly",
};

export function settingsStateMessage(): Extract<HostToSettingsPage, { type: "settingsState" }> {
  const cfg = getLaisoraConfiguration();
  return {
    type: "settingsState",
    composerSendKey: normalizeComposerSendKey(cfg.get("composer.sendKey", "enter")),
    apiKeyPolicy: normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit")),
    restoreTabsOnStartup: restoreTabsOnStartupEnabled(),
    // 読み手（conversation-lifecycle.ts / composer-io.ts）と同じ既定と判定で読む。ずれると画面の表示と実際の動作が食い違う（R-DSP-01）
    fileLinkInstruction: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.fileLinkInstruction, true) !== false,
    revealInExplorer: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.revealInExplorer, true) !== false,
    allowOutsideWorkspace: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.allowOutsideWorkspace, false) === true,
    confirmOutsideWorkspace: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.confirmOutsideWorkspace, true) !== false,
    openOutsideReadOnly: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.openOutsideReadOnly, true) !== false,
  };
}

function reportSettingWriteFailure(key: string, error: unknown): void {
  output.appendLine(`[error] update ${key} failed: ${String(error)}`);
  void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not save the setting."));
}

// claude.apiKeyPolicy / fileLinks.allowOutsideWorkspace・confirmOutsideWorkspace・openOutsideReadOnly（machine）と composer.sendKey / claude.fileLinkInstruction / fileLinks.revealInExplorer（application）は workspace 側の値を持たない（package.json の scope）。書き先は常に user 設定
async function updateUserSetting(key: string, value: string | boolean): Promise<void> {
  try {
    await getLaisoraConfiguration().update(key, value, vscode.ConfigurationTarget?.Global ?? 1);
  } catch (error) {
    reportSettingWriteFailure(key, error);
  }
}

// 書込みの成否は返さない。呼び出し側は構成を読み直した実効値を画面へ返す（R-DSP-01）
export async function writeComposerSendKey(sendKey: ComposerSendKey): Promise<void> {
  await updateUserSetting("composer.sendKey", sendKey);
}

export async function writeApiKeyPolicy(policy: ApiKeyPolicy): Promise<void> {
  await updateUserSetting("claude.apiKeyPolicy", policy);
}

export async function writeFileLinkSetting(setting: FileLinkSetting, enabled: boolean): Promise<void> {
  await updateUserSetting(FILE_LINK_SETTING_KEYS[setting], enabled);
}

export async function writeRestoreTabsOnStartup(enabled: boolean): Promise<void> {
  try {
    const cfg = getLaisoraConfiguration();
    // scope 未指定（window）なので workspace 設定で上書きできる。Global へ書くとこのウィンドウの実効値が変わらない。
    const target = cfg.inspect?.<boolean>("restoreTabsOnStartup")?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget?.Workspace ?? 2
      : vscode.ConfigurationTarget?.Global ?? 1;
    await cfg.update("restoreTabsOnStartup", enabled, target);
  } catch (error) {
    reportSettingWriteFailure("restoreTabsOnStartup", error);
  }
}

export async function runHostActionMessage(msg: Extract<WebviewToHost, { type: "runHostAction" }>): Promise<void> {
  if (msg.action === "openSettings") await vscode.commands.executeCommand("laisora.openSettings");
  if (msg.action === "addClaudeModel") {
    const target = store?.sessions.get(msg.tabId);
    if (!target) return;
    const id = (await vscode.window.showInputBox({
      title: l10n.t("Add a Claude model version"),
      prompt: l10n.t("Enter one model ID, for example claude-fable-5 or claude-sonnet-4-6. Availability depends on your Claude account."),
      placeHolder: "claude-sonnet-4-6",
      validateInput: (value) => CLAUDE_VERSION_ID.test(value.trim()) ? undefined : l10n.t("Enter a versioned Claude model ID."),
    }))?.trim();
    if (!id || !CLAUDE_VERSION_ID.test(id) || store?.sessions.get(msg.tabId) !== target) return;
    await extensionContext?.globalState.update(ADDITIONAL_MODELS_KEY, [...new Set([...additionalClaudeModelIds(), id])]);
    for (const s of store.sessions.values()) {
      recomputeModelRows(s);
      store.post(modelsMessage(s));
    }
  }
}
