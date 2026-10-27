import { configurationDefault, configurationRegistered, windowMissesContributedSettings } from "./configuration-defaults";
import { isAccentColor, isAccentSettingValue, type AccentSetting, type AccentSettings } from "./accent";
import { createHash } from "node:crypto";
import { redactAbsolutePaths } from "./path-redaction";
import { conductorInstruction, estimateTokens, resolveOrchestrationRoster, orchestrationExternalTargets } from "./orchestration-roster";
import { listClaudeModels, detectClaudeExecutor, relabelRememberedClaudeModels } from "./orchestration-claude";
import { EXECUTORS, executorMap, type ExecutorId } from "./orchestration-executors";
import { systemAppExtensions } from "./file-link-open-mode";
import { CLI_AUTO_UPDATE_SETTINGS, cliAutoUpdateEnabled } from "./cli-update-policy";
import { compareSemVer, parseSemVer } from "./semver";
import { detectExternalExecutor, listExternalModels } from "./orchestration-external";
import { externalExecutorName, isExternalModels, isExternalTimeout, type ExternalDetection, type ExternalModels, type ExternalModelsState } from "./orchestration-roster";
import { DEFAULT_ORCHESTRATION_ROSTER, buildRecommendedClaudeRoster, isOrchestrationSettingRoster, orchestrationSettingRows, recommendedOrchestrationRoster, recommendedRosterChanges, type OrchestrationSettingRow } from "./orchestration-roster";
import * as vscode from "vscode";
import { resolveHandoffAutoSettings } from "./handoff-auto";
import {
  HANDOFF_AUTO_SETTING_KEYS,
  isHandoffAutoSettingValue,
  normalizeApiKeyPolicy,
  normalizeComposerSendKey,
  type HandoffAutoSettingName,
  type ApiKeyPolicy,
  type ComposerSendKey,
  type FileLinkSetting,
  type HostToSettingsPage,
  isWelcomeText,
  isWelcomeTipMark,
  type WelcomeOpen,
  type WelcomeSetting,
  type WelcomeSettings,
  type WelcomeState,
  type HostToWebview,
  type SettingWriteFailure,
  type WebviewToHost,
} from "./protocol";
import * as l10n from "@vscode/l10n";
import { configuredClaudeExecutablePath, configuredDisplayName, configuredEventLimit, existingFolderOrHome, getLaisoraConfiguration, readClaudeCodeSettings } from "./claude-settings";
import { isEventLimit } from "./event-limits";
import { TRANSCRIPT_RETENTION_DAYS_KEY, configuredTranscriptRetentionDays, isTranscriptRetentionDays, transcriptRetentionFallback } from "./transcript-retention";
import { isDisplayName } from "./display-name";
import { extensionContext, output, store } from "./host-context";
import { ADDITIONAL_MODELS_KEY, CLAUDE_VERSION_ID, additionalClaudeModelIds, recomputeModelRows, modelsMessage } from "./gateway-models";
import { restoreTabsOnStartupEnabled } from "./session-list-wiring";
import { TODO_ENABLED_SETTING } from "./todo-store";
import { todoFeatureEnabled } from "./todo-surface";
import { EDIT_SUMMARY_SETTING } from "./edit-summary";
import { REMOTE_CONTROL_CARD_SETTING } from "./remote-control";
import { GUARD_ENABLED_SETTING, MEMORY_BLOCK_PROJECT_TYPE_SETTING, placementOf, placementSettingsOf } from "./placement-line";
import { welcomeNews, welcomeTips } from "./welcome-content";
import { laterWelcomeVersion, nextWelcomeTip, welcomeNewsVersion } from "./welcome-rules";

export function editSummarySettingEnabled(): boolean {
  return getLaisoraConfiguration().get<boolean>(EDIT_SUMMARY_SETTING) === true;
}

export function remoteControlCardEnabled(): boolean {
  return getLaisoraConfiguration().get<boolean>(REMOTE_CONTROL_CARD_SETTING) !== false;
}

export const WELCOME_SETTING_KEYS: Record<WelcomeSetting, string> = { showNews: "welcome.showNews", showTips: "welcome.showTips" };
export const WELCOME_DISMISSED_NEWS_KEY = "laisora.welcome.dismissedNewsVersion";
export const WELCOME_LAST_TIP_KEY = "laisora.welcome.lastTip";
const WELCOME_TIP_ID_NAMES = { menuGlyph: "", handoffItem: "", appearanceSection: "", historyButton: "" };

export function welcomeSettingChanged(affects: (key: string) => boolean): boolean {
  return Object.values(WELCOME_SETTING_KEYS).some(affects);
}

export function welcomeSettings(): WelcomeSettings {
  const cfg = getLaisoraConfiguration();
  return { showNews: cfg.get<boolean>(WELCOME_SETTING_KEYS.showNews) !== false, showTips: cfg.get<boolean>(WELCOME_SETTING_KEYS.showTips) !== false };
}

function dismissedNewsVersion(): string | undefined {
  const dismissed = extensionContext?.globalState.get<unknown>(WELCOME_DISMISSED_NEWS_KEY);
  return isWelcomeText(dismissed) ? dismissed : undefined;
}

function welcomeState(): WelcomeState {
  const dismissed = dismissedNewsVersion();
  return { ...welcomeSettings(), ...(dismissed === undefined ? {} : { dismissedNewsVersion: dismissed }) };
}

export function openWelcome(): WelcomeOpen | undefined {
  const context = extensionContext;
  if (!context) return undefined;
  const running = context.extension?.packageJSON?.version as unknown;
  const newsVersion = typeof running === "string" ? welcomeNewsVersion(running, welcomeNews(), dismissedNewsVersion()) : undefined;
  const last = context.globalState.get<unknown>(WELCOME_LAST_TIP_KEY);
  const tip = nextWelcomeTip(isWelcomeTipMark(last) ? last : undefined, welcomeTips(WELCOME_TIP_ID_NAMES).map((entry) => entry.id));
  if (tip !== undefined) void context.globalState.update(WELCOME_LAST_TIP_KEY, tip);
  return { openedAt: Date.now(), roll: Math.random(), ...(newsVersion === undefined ? {} : { newsVersion }), ...(tip === undefined ? {} : { tipId: tip.id }) };
}

export async function welcomeActionMessage(msg: Extract<WebviewToHost, { type: "welcomeAction" }>): Promise<void> {
  if (msg.action === "hideTips") {
    const failure = await updateUserSetting(WELCOME_SETTING_KEYS.showTips, false);
    if (failure === undefined) return;
    void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not save the setting."));
  } else {
    const state = extensionContext?.globalState;
    for (const session of store?.sessions.values() ?? []) {
      if (session.welcome?.newsVersion === msg.version) session.welcome = { ...session.welcome, newsVersion: undefined };
    }
    if (state && laterWelcomeVersion(msg.version, dismissedNewsVersion())) {
      await state.update(WELCOME_DISMISSED_NEWS_KEY, msg.version);
    }
  }
  store?.post(userSettingsMessage());
}

export async function writeWelcomeSetting(setting: WelcomeSetting, enabled: boolean): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(WELCOME_SETTING_KEYS[setting], enabled);
}

export function accentSettings(): AccentSettings {
  const cfg = getLaisoraConfiguration();
  const color = cfg.get<unknown>("appearance.accentColor");
  const light = cfg.get<unknown>("appearance.accentCustomLight");
  const dark = cfg.get<unknown>("appearance.accentCustomDark");
  return {
    accentColor: isAccentColor(color) ? color : "theme",
    accentCustomLight: typeof light === "string" ? light : "",
    accentCustomDark: typeof dark === "string" ? dark : "",
  };
}

export async function writeAccentSetting(setting: AccentSetting, value: string): Promise<SettingWriteFailure | undefined> {
  return isAccentSettingValue(setting, value) ? updateUserSetting(`appearance.${setting}`, value) : undefined;
}

export async function writeDisplayName(value: string): Promise<SettingWriteFailure | undefined> {
  return isDisplayName(value) ? updateUserSetting("appearance.displayName", value) : undefined;
}

export function userSettingsMessage(): Extract<HostToWebview, { type: "userSettings" }> {
  return {
    type: "userSettings",
    appearance: accentSettings(),
    displayName: configuredDisplayName(),
    composerSendKey: normalizeComposerSendKey(getLaisoraConfiguration().get<string>("composer.sendKey")!),
    askQualityCheck: getLaisoraConfiguration().get<boolean>("claude.askQualityCheck") === true,
    editSummaryEnabled: editSummarySettingEnabled(),
    remoteControlCard: remoteControlCardEnabled(),
    welcome: welcomeState(),
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
const knownVersions: Partial<Record<ExecutorId, string>> = {};
let detectionPending: Promise<void> | undefined;
const detectionListeners = new Set<() => void>();
let externalModels: ExternalModels = executorMap(() => ({ state: "checking" }));
const MODEL_LIST_CACHE_KEY = "laisora.executorModelLists.v1";
type RememberedModelList = { models: Extract<ExternalModelsState, { state: "ok" }>["models"]; fetchedAt: number };
let rememberedModelLists: Partial<Record<ExecutorId, RememberedModelList>> = {};
let modelListStorage: vscode.Memento | undefined;
let modelListSave: Promise<void> = Promise.resolve();
function saveRememberedModelLists(): Promise<void> {
  const saved = structuredClone(rememberedModelLists), storage = modelListStorage;
  modelListSave = modelListSave.then(async () => { await storage?.update(MODEL_LIST_CACHE_KEY, saved); })
    .catch(() => { output.appendLine("R-ORC-39: model-list cache could not be saved"); });
  return modelListSave;
}
function loadRememberedModelLists(): void {
  const storage = extensionContext?.globalState;
  if (!storage || modelListStorage === storage) return;
  modelListStorage = storage;
  rememberedModelLists = {};
  const saved = storage.get<Partial<Record<ExecutorId, RememberedModelList>>>(MODEL_LIST_CACHE_KEY);
  externalModels = executorMap(id => {
    const entry = saved?.[id];
    const list = entry && { state: "ok" as const, models: entry.models, fetchedAt: entry.fetchedAt };
    if (!list || !entry.fetchedAt || !isExternalModels(executorMap(() => list))) return { state: "checking" };
    if (id === "claude") list.models = relabelRememberedClaudeModels(list.models);
    rememberedModelLists[id] = { models: structuredClone(list.models), fetchedAt: entry.fetchedAt };
    return list;
  });
}
export function cachedExternalModels(): ExternalModels {
  loadRememberedModelLists();
  return structuredClone(externalModels);
}
export function knownExecutorVersion(id: ExecutorId): string | undefined {
  return knownVersions[id];
}
export function noteExecutorVersion(id: ExecutorId, version: string): void {
  knownVersions[id] = version;
  const detected = externalDetection[id];
  if (detected.state === "found") externalDetection[id] = { state: "found", path: detected.path, version };
}
export function noteRunningExecutorVersion(id: ExecutorId, version: string): void {
  const known = parseSemVer(knownVersions[id]), running = parseSemVer(version);
  if (known && running && compareSemVer(running, known) < 0) return;
  noteExecutorVersion(id, version);
}

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

export function refreshExternalDetection(detect = detectorOverride ?? detectExternalExecutor, onChange?: () => void): Promise<void> {
  if (onChange) detectionListeners.add(onChange);
  if (detectionPending) return detectionPending;
  loadRememberedModelLists();
  const policy = normalizeApiKeyPolicy(getLaisoraConfiguration().get<string>("claude.apiKeyPolicy")!);
  externalDetection = executorMap(() => ({ state: "checking" }));
  externalModels = executorMap(id => {
    const remembered = rememberedModelLists[id];
    return remembered ? { state: "ok", ...remembered, refresh: "checking" } : { state: "checking" };
  });
  const executors = Object.values(EXECUTORS).map(({ id }) => id);
  const configuredPath = configuredClaudeExecutablePath(getLaisoraConfiguration());
  const cwd = existingFolderOrHome(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  detectionPending = Promise.all(executors.map(async (executor) => {
      const started = Date.now();
      let detected: ExternalDetection;
      try { detected = await (executor === "claude" ? (claudeDetectorOverride ?? detectClaudeExecutor)(configuredPath) : detect(executor, policy)); }
      catch { detected = { state: "failed", path: "", reason: "spawn-error:UNKNOWN" }; }
      const reason = detected.state === "failed" ? detected.reason : detected.state === "found" ? detected.versionNote : undefined;
      if (reason) output.appendLine(`R-ORC-20: ${externalExecutorName(executor)} detection ${reason} elapsed=${Date.now() - started}ms`);
      externalDetection[executor] = detected;
      if (detected.state === "found" && detected.version) knownVersions[executor] = detected.version;
      for (const listener of detectionListeners) listener();
      let list: ExternalModelsState;
      try {
        list = detected.state === "notInstalled" ? { state: "failed", reason: "not-installed" } : await (executor === "claude"
          ? (claudeListerOverride ?? listClaudeModels)(cwd, (message) => output.appendLine(message), { apiKeyPolicy: policy, claudeCodeExecutablePath: configuredPath })
          : (externalListerOverride ?? listExternalModels)(executor, policy));
      } catch { list = { state: "failed", reason: "model-list-failed" }; }
      if (list.state === "ok") {
        const remembered = { models: structuredClone(list.models), fetchedAt: Date.now() };
        rememberedModelLists[executor] = remembered;
        externalModels[executor] = { state: "ok", ...remembered };
      } else {
        output.appendLine(`R-ORC-12: ${externalExecutorName(executor)} ${list.state === "failed" ? list.reason : "model-list-failed"}`);
        const remembered = rememberedModelLists[executor];
        externalModels[executor] = remembered ? { state: "ok", ...remembered, refresh: "failed", refreshReason: list.state === "failed" ? list.reason : "model-list-failed" }
          : { state: "failed", reason: list.state === "failed" ? list.reason : "model-list-failed" };
      }
      for (const listener of detectionListeners) listener();
      if (list.state === "ok") await saveRememberedModelLists();
    })).then(() => undefined).finally(() => { detectionPending = undefined; detectionListeners.clear(); });
  return detectionPending;
}

export function configuredSystemAppExtensions(): string[] {
  let value: unknown;
  try {
    value = getLaisoraConfiguration().get<unknown>(FILE_LINK_SETTING_KEYS.openWithSystemApp);
  } catch (error) {
    return systemAppExtensions(undefined, () => output.appendLine(
      `R-CNV-20: Could not read ${FILE_LINK_SETTING_KEYS.openWithSystemApp}; using defaults: ${String(error)}`));
  }
  return systemAppExtensions(value,
    () => output.appendLine(l10n.t("R-CNV-20: Invalid or blocked extensions in the default app setting were ignored.")));
}

export function projectConductorPreview(policy?: string): { text: string; tokens: number } {
  const cfg = getLaisoraConfiguration();
  const roster = resolveOrchestrationRoster(cfg.get<unknown>("orchestration.agents")).roster;
  const text = cfg.get<boolean>("orchestration.enabled")!
    ? conductorInstruction(roster, policy ?? cfg.get<string>("orchestration.conductorPolicy")!, orchestrationExternalTargets(roster, externalModels), externalModels,
      placementOf(placementSettingsOf(cfg)).line)
    : l10n.t("The agent roster is disabled, so no instruction is added.");
  return { text, tokens: estimateTokens(text) };
}

export function settingsStateMessage(): Extract<HostToSettingsPage, { type: "settingsState" }> {
  loadRememberedModelLists();
  const cfg = getLaisoraConfiguration();
  const timeout = cfg.get<number>("orchestration.externalTimeoutMinutes")!;
  const placementSettings = placementSettingsOf(cfg);
  const claudeCodeSettings = readClaudeCodeSettings(true);
  return {
    type: "settingsState",
    conductorPreview: projectConductorPreview(),
    recommendedRosterSame: recommendedRosterPlan().changes.every((change) => change.change === "same"),
    appearance: accentSettings(),
    displayName: configuredDisplayName(),
    openWithSystemApp: configuredSystemAppExtensions(),
    externalTimeoutMinutes: isExternalTimeout(timeout) ? timeout : 10,
    externalDetection: structuredClone(externalDetection),
    externalModels: cachedExternalModels(),
    orchestrationEnabled: cfg.get<boolean>("orchestration.enabled")! === true,
    guardEnabled: placementSettings.guardEnabled,
    memoryBlockProjectType: placementSettings.blockProjectType,
    todoEnabled: todoFeatureEnabled(cfg),
    reloadNeeded: settingsReloadNeeded(cfg),
    editSummaryEnabled: editSummarySettingEnabled(),
    remoteControlCard: remoteControlCardEnabled(),
    welcome: welcomeSettings(),
    handoffAuto: resolveHandoffAutoSettings((key) => cfg.get<unknown>(key)),
    orchestrationAgents: readRoster(cfg.get<unknown>("orchestration.agents")),
    orchestrationDefaults: readRoster(cfg.inspect("orchestration.agents")?.defaultValue ?? DEFAULT_ORCHESTRATION_ROSTER),
    conductorPolicy: cfg.get<string>("orchestration.conductorPolicy")!,
    conductorPolicyDefault: configurationDefault<string>("orchestration.conductorPolicy"),
    composerSendKey: normalizeComposerSendKey(cfg.get<string>("composer.sendKey")!),
    apiKeyPolicy: normalizeApiKeyPolicy(cfg.get<string>("claude.apiKeyPolicy")!),
    restoreTabsOnStartup: restoreTabsOnStartupEnabled(),
    cliAutoUpdate: executorMap((id) => cliAutoUpdateEnabled(cfg, id)),
    eventLimit: configuredEventLimit(),
    ...transcriptRetentionDaysState(cfg),
    transcriptRetentionFallback: transcriptRetentionFallback(cfg.get<string[]>("claude.settingSources")!, claudeCodeSettings.cleanupPeriodDays),
    initialModel: cfg.get<string>("claude.initialModel")!.trim(),
    autoContinueAtUsageLimit: claudeCodeSettings.autoContinueAtUsageLimit !== false,
    fileLinkInstruction: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.fileLinkInstruction)! !== false,
    planInstruction: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.planInstruction)! !== false,
    revealInExplorer: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.revealInExplorer)! !== false,
    allowOutsideWorkspace: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.allowOutsideWorkspace)! === true,
    confirmOutsideWorkspace: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.confirmOutsideWorkspace)! !== false,
    openOutsideReadOnly: cfg.get<boolean>(FILE_LINK_SETTING_KEYS.openOutsideReadOnly)! !== false,
  };
}

const UNREGISTERED_SETTING_ERROR_CODE = "ERROR_UNKNOWN_KEY";
const UNREGISTERED_SETTING_MESSAGE = /is not a registered configuration/i;

function isUnregisteredSetting(key: string, error: unknown): boolean {
  if ((error as { code?: unknown } | undefined)?.code === UNREGISTERED_SETTING_ERROR_CODE) return true;
  if (UNREGISTERED_SETTING_MESSAGE.test(error instanceof Error ? error.message : String(error))) return true;
  try {
    const cfg = getLaisoraConfiguration();
    return typeof cfg.inspect === "function" && !configurationRegistered((k) => cfg.inspect(k), key);
  } catch {
    return false;
  }
}

function settingsReloadNeeded(cfg: vscode.WorkspaceConfiguration): boolean {
  return windowMissesContributedSettings((k) => cfg.inspect(k));
}

function reportSettingWriteFailure(key: string, error: unknown): SettingWriteFailure {
  output.appendLine(`[error] update ${key} failed: ${String(error)}`);
  const text = error instanceof Error ? error.message || String(error) : String(error);
  return { kind: isUnregisteredSetting(key, error) ? "unregistered" : "other", reason: redactAbsolutePaths(text.split(/\r?\n/, 1)[0].trim()) };
}

async function updateUserSetting(key: string, value: unknown): Promise<SettingWriteFailure | undefined> {
  try {
    await getLaisoraConfiguration().update(key, value, vscode.ConfigurationTarget?.Global ?? 1);
    return undefined;
  } catch (error) {
    return reportSettingWriteFailure(key, error);
  }
}

export async function writeEventLimit(value: number): Promise<SettingWriteFailure | undefined> {
  if (!isEventLimit(value)) return undefined;
  try {
    const cfg = getLaisoraConfiguration();
    const inspected = cfg.inspect<number>("history.eventLimit");
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update("history.eventLimit", value, target);
    return undefined;
  } catch (error) {
    return reportSettingWriteFailure("history.eventLimit", error);
  }
}

function transcriptRetentionDaysState(cfg: vscode.WorkspaceConfiguration): { transcriptRetentionDays?: number } {
  const days = configuredTranscriptRetentionDays((key) => cfg.get<unknown>(key));
  return days === null ? {} : { transcriptRetentionDays: days };
}

export async function writeTranscriptRetentionDays(value: number | null): Promise<SettingWriteFailure | undefined> {
  if (value !== null && !isTranscriptRetentionDays(value)) return undefined;
  return updateUserSetting(TRANSCRIPT_RETENTION_DAYS_KEY, value ?? undefined);
}

export async function writeInitialModel(model: string): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting("claude.initialModel", model);
}

export async function writeComposerSendKey(sendKey: ComposerSendKey): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting("composer.sendKey", sendKey);
}

export async function writeApiKeyPolicy(policy: ApiKeyPolicy): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting("claude.apiKeyPolicy", policy);
}

export async function writeCliAutoUpdate(executor: ExecutorId, enabled: boolean): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(CLI_AUTO_UPDATE_SETTINGS[executor], enabled);
}

export async function writeGuardEnabled(enabled: boolean): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(GUARD_ENABLED_SETTING, enabled);
}

export async function writeMemoryBlockProjectType(enabled: boolean): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(MEMORY_BLOCK_PROJECT_TYPE_SETTING, enabled);
}

export async function writeTodoEnabled(enabled: boolean): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(TODO_ENABLED_SETTING, enabled);
}

export async function writeEditSummaryEnabled(enabled: boolean): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(EDIT_SUMMARY_SETTING, enabled);
}

export async function writeRemoteControlCard(enabled: boolean): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(REMOTE_CONTROL_CARD_SETTING, enabled);
}

export async function writeHandoffAutoSetting(setting: HandoffAutoSettingName, value: unknown): Promise<SettingWriteFailure | undefined> {
  return isHandoffAutoSettingValue(setting, value) ? updateUserSetting(HANDOFF_AUTO_SETTING_KEYS[setting], value) : undefined;
}

let normalizedRosterLogged = false;
function readRoster(value: unknown) {
  return orchestrationSettingRows(value, (message) => {
    if (!normalizedRosterLogged) output.appendLine(message);
    normalizedRosterLogged = true;
  });
}

export async function writeOrchestrationSetting(setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes", value: unknown): Promise<SettingWriteFailure | undefined> {
  if (setting === "externalTimeoutMinutes" ? !isExternalTimeout(value)
    : setting === "agents" ? !isOrchestrationSettingRoster(value)
    : setting === "enabled" ? typeof value !== "boolean" : typeof value !== "string") {
    output.appendLine("[drop] R-ORC-20: invalid orchestration setting");
    return undefined;
  }
  return updateUserSetting(`orchestration.${setting}`, setting === "agents" ? orchestrationSettingRows(value as OrchestrationSettingRow[]) : value);
}

function recommendedRosterPlan() {
  const cfg = getLaisoraConfiguration();
  const current = readRoster(cfg.get<unknown>("orchestration.agents"));
  const models = cachedExternalModels().claude;
  const recommendation = buildRecommendedClaudeRoster(
    readRoster(cfg.inspect("orchestration.agents")?.defaultValue ?? DEFAULT_ORCHESTRATION_ROSTER), models.state === "ok" ? models.models : []);
  const next = recommendedOrchestrationRoster(current, recommendation);
  const revision = createHash("sha256").update(JSON.stringify([current, recommendation, next])).digest("hex");
  return { next, revision, changes: recommendedRosterChanges(current, next) };
}

export function recommendedRosterMessage(): Extract<HostToSettingsPage, { type: "recommendedRoster" }> {
  const plan = recommendedRosterPlan();
  return { type: "recommendedRoster", revision: plan.revision, changes: plan.changes };
}

export async function applyRecommendedRoster(revision: string): Promise<{ stale: boolean; failure?: SettingWriteFailure }> {
  const plan = recommendedRosterPlan();
  if (plan.revision !== revision) {
    output.appendLine("[drop] R-ORC-43: the roster changed after the recommendation was shown");
    return { stale: true };
  }
  if (plan.changes.every((change) => change.change === "same")) return { stale: false };
  return { stale: false, failure: await writeOrchestrationSetting("agents", plan.next) };
}

export async function writeFileLinkSetting(setting: FileLinkSetting, enabled: boolean | string[]): Promise<SettingWriteFailure | undefined> {
  return updateUserSetting(FILE_LINK_SETTING_KEYS[setting], enabled);
}

export async function writeRestoreTabsOnStartup(enabled: boolean): Promise<SettingWriteFailure | undefined> {
  try {
    const cfg = getLaisoraConfiguration();
    const target = cfg.inspect?.<boolean>("restoreTabsOnStartup")?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget?.Workspace ?? 2
      : vscode.ConfigurationTarget?.Global ?? 1;
    await cfg.update("restoreTabsOnStartup", enabled, target);
    return undefined;
  } catch (error) {
    return reportSettingWriteFailure("restoreTabsOnStartup", error);
  }
}

export async function runHostActionMessage(msg: Extract<WebviewToHost, { type: "runHostAction" }>): Promise<void> {
  if (msg.action === "openSettings") await vscode.commands.executeCommand("laisora.openSettings", ...(msg.target === undefined ? [] : [msg.target]));
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
