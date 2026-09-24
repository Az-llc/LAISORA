import { DEFAULT_ACCENT_SETTINGS, isAccentColor, isAccentSettingValue, type AccentSetting, type AccentSettings } from "./accent";
import { homedir } from "node:os";
import { listClaudeModels, detectClaudeExecutor } from "./orchestration-claude";
import { EXECUTORS, executorMap, type ExecutorId } from "./orchestration-executors";
import { DEFAULT_SYSTEM_APP_EXTENSIONS, systemAppExtensions } from "./file-link-open-mode";
import { detectExternalExecutor, listExternalModels } from "./orchestration-external";
import { externalExecutorName, isExternalTimeout, type ExternalDetection, type ExternalModels, type ExternalModelsState } from "./orchestration-roster";
import { DEFAULT_ORCHESTRATION_ROSTER, isOrchestrationSettingRoster, orchestrationSettingRows, type OrchestrationSettingRow } from "./orchestration-roster";
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
import { configuredClaudeExecutablePath, getLaisoraConfiguration, readClaudeCodeSettings } from "./claude-settings";
import { extensionContext, output, store } from "./host-context";
import { ADDITIONAL_MODELS_KEY, CLAUDE_VERSION_ID, additionalClaudeModelIds, recomputeModelRows, modelsMessage } from "./gateway-models";
import { restoreTabsOnStartupEnabled } from "./session-list-wiring";

export function accentSettings(): AccentSettings {
  const cfg = getLaisoraConfiguration();
  const color = cfg.get<unknown>("appearance.accentColor", "theme");
  const light = cfg.get<unknown>("appearance.accentCustomLight", DEFAULT_ACCENT_SETTINGS.accentCustomLight);
  const dark = cfg.get<unknown>("appearance.accentCustomDark", DEFAULT_ACCENT_SETTINGS.accentCustomDark);
  return {
    accentColor: isAccentColor(color) ? color : "theme",
    accentCustomLight: typeof light === "string" ? light : "",
    accentCustomDark: typeof dark === "string" ? dark : "",
  };
}

export async function writeAccentSetting(setting: AccentSetting, value: string): Promise<void> {
  if (isAccentSettingValue(setting, value)) await updateUserSetting(`appearance.${setting}`, value);
}

export function userSettingsMessage(): Extract<HostToWebview, { type: "userSettings" }> {
  return {
    type: "userSettings",
    appearance: accentSettings(),
    composerSendKey: normalizeComposerSendKey(getLaisoraConfiguration().get("composer.sendKey", "enter")),
  };
}

const FILE_LINK_SETTING_KEYS: Record<FileLinkSetting, string> = {
  openWithSystemApp: "fileLinks.openWithSystemApp",
  fileLinkInstruction: "claude.fileLinkInstruction",
  planInstruction: "claude.planInstruction",
  revealInExplorer: "fileLinks.revealInExplorer",
  allowOutsideWorkspace: "fileLinks.allowOutsideWorkspace",
  confirmOutsideWorkspace: "fileLinks.confirmOutsideWorkspace",
  openOutsideReadOnly: "fileLinks.openOutsideReadOnly",
};

let externalDetection: Record<ExecutorId, ExternalDetection> = executorMap(() => ({ state: "checking" }));
let detectionPending: Promise<void> | undefined;
let externalModels: ExternalModels = executorMap(() => ({ state: "checking" }));
export function cachedExternalModels(): ExternalModels { return structuredClone(externalModels); }

let detectorOverride: typeof detectExternalExecutor | undefined;
let claudeListerOverride: typeof listClaudeModels | undefined;
let claudeDetectorOverride: typeof detectClaudeExecutor | undefined;
let externalListerOverride: typeof listExternalModels | undefined;
export function setExternalDetectorForTest(detect: typeof detectExternalExecutor | undefined, list?: typeof listExternalModels, claudeList?: typeof listClaudeModels, claudeDetect?: typeof detectClaudeExecutor): void {
  detectorOverride = detect;
  externalListerOverride = list;
  claudeListerOverride = claudeList;
  claudeDetectorOverride = claudeDetect;
}

export function refreshExternalDetection(detect = detectorOverride ?? detectExternalExecutor): Promise<void> {
  if (detectionPending) return detectionPending; // R-ORC-20: coalesce concurrent page requests.
  const policy = normalizeApiKeyPolicy(getLaisoraConfiguration().get("claude.apiKeyPolicy", "inherit"));
  externalDetection = executorMap(() => ({ state: "checking" }));
  externalModels = executorMap(() => ({ state: "checking" }));
  const executors = Object.values(EXECUTORS).map(({ id }) => id);
  const configuredPath = configuredClaudeExecutablePath(getLaisoraConfiguration());
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
  detectionPending = Promise.all([
    Promise.all(executors.map(async (executor): Promise<ExternalDetection> => {
      const started = Date.now();
      let detected: ExternalDetection;
      try { detected = await (executor === "claude" ? (claudeDetectorOverride ?? detectClaudeExecutor)(configuredPath) : detect(executor, policy)); }
      catch { detected = { state: "failed", path: "", reason: "spawn-error:UNKNOWN" }; }
      const reason = detected.state === "failed" ? detected.reason : detected.state === "found" ? detected.versionNote : undefined;
      if (reason) output.appendLine(`R-ORC-20: ${externalExecutorName(executor)} detection ${reason} elapsed=${Date.now() - started}ms`);
      return detected;
    })),
    Promise.allSettled(executors.map((executor) => Promise.resolve().then(() => executor === "claude"
      ? (claudeListerOverride ?? listClaudeModels)(cwd, (message) => output.appendLine(message), { apiKeyPolicy: policy, claudeCodeExecutablePath: configuredPath })
      : (externalListerOverride ?? listExternalModels)(executor, policy)))),
  ]).then(([results, lists]) => {
      externalDetection = executorMap((id) => results[executors.indexOf(id)]);
      const listed = lists.map((result, index): ExternalModelsState => {
        const list: ExternalModelsState = result.status === "fulfilled" ? result.value : { state: "failed", reason: "model-list-failed" };
        if (list.state === "failed") output.appendLine(`R-ORC-12: ${externalExecutorName(executors[index])} ${list.reason}`);
        return list;
      });
      externalModels = executorMap((id) => listed[executors.indexOf(id)]);
    }).finally(() => { detectionPending = undefined; });
  return detectionPending;
}

export function configuredSystemAppExtensions(): string[] {
  let value: unknown;
  try {
    value = getLaisoraConfiguration().get(FILE_LINK_SETTING_KEYS.openWithSystemApp, DEFAULT_SYSTEM_APP_EXTENSIONS);
  } catch (error) {
    // R-CNV-20: a failed setting read must not interrupt init. The normalizer
    // supplies defaults and shares its once-only diagnostic with invalid values.
    return systemAppExtensions(undefined, () => output.appendLine(
      `R-CNV-20: Could not read ${FILE_LINK_SETTING_KEYS.openWithSystemApp}; using defaults: ${String(error)}`));
  }
  return systemAppExtensions(value,
    () => output.appendLine(l10n.t("R-CNV-20: Invalid or blocked extensions in the default app setting were ignored.")));
}

export function settingsStateMessage(): Extract<HostToSettingsPage, { type: "settingsState" }> {
  const cfg = getLaisoraConfiguration();
  const timeout = cfg.get("orchestration.externalTimeoutMinutes", 10);
  return {
    type: "settingsState",
    appearance: accentSettings(),
    openWithSystemApp: configuredSystemAppExtensions(),
    externalTimeoutMinutes: isExternalTimeout(timeout) ? timeout : 10,
    externalDetection: structuredClone(externalDetection),
    externalModels: cachedExternalModels(),
    orchestrationEnabled: cfg.get<boolean>("orchestration.enabled", false) === true,
    learningEnabled: cfg.get<boolean>("learning.enabled", false) === true,
    orchestrationAgents: readRoster(cfg.get("orchestration.agents", DEFAULT_ORCHESTRATION_ROSTER)),
    orchestrationDefaults: readRoster(cfg.inspect("orchestration.agents")?.defaultValue ?? DEFAULT_ORCHESTRATION_ROSTER),
    conductorPolicy: cfg.get<string>("orchestration.conductorPolicy", ""),
    conductorPolicyDefault: cfg.inspect<string>("orchestration.conductorPolicy")?.defaultValue ?? "",
    composerSendKey: normalizeComposerSendKey(cfg.get("composer.sendKey", "enter")),
    apiKeyPolicy: normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit")),
    restoreTabsOnStartup: restoreTabsOnStartupEnabled(),
    autoContinueAtUsageLimit: readClaudeCodeSettings(true).autoContinueAtUsageLimit !== false,
    // 読み手（conversation-lifecycle.ts / composer-io.ts）と同じ既定と判定で読む。ずれると画面の表示と実際の動作が食い違う（R-DSP-01）
    fileLinkInstruction: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.fileLinkInstruction, true) !== false,
    planInstruction: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.planInstruction, true) !== false,
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
async function updateUserSetting(key: string, value: unknown): Promise<void> {
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

export async function writeLearningEnabled(enabled: boolean): Promise<void> {
  await updateUserSetting("learning.enabled", enabled);
}

let normalizedRosterLogged = false;
function readRoster(value: unknown) {
  return orchestrationSettingRows(value, (message) => {
    if (!normalizedRosterLogged) output.appendLine(message);
    normalizedRosterLogged = true;
  });
}

export async function writeOrchestrationSetting(setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes", value: unknown): Promise<void> {
  // R-ORC-20: reject the entire payload before any user setting write.
  if (setting === "externalTimeoutMinutes" ? !isExternalTimeout(value)
    : setting === "agents" ? !isOrchestrationSettingRoster(value)
    : setting === "enabled" ? typeof value !== "boolean" : typeof value !== "string") {
    output.appendLine("[drop] R-ORC-20: invalid orchestration setting");
    return;
  }
  await updateUserSetting(`orchestration.${setting}`, setting === "agents" ? orchestrationSettingRows(value as OrchestrationSettingRow[]) : value);
}

export async function writeFileLinkSetting(setting: FileLinkSetting, enabled: boolean | string[]): Promise<void> {
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
