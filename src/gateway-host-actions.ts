import { DEFAULT_ACCENT_SETTINGS, isAccentColor, isAccentSettingValue, type AccentSetting, type AccentSettings } from "./accent";
import { isAbsolute, join, relative, sep } from "node:path";
import { containsAbsolutePath } from "./path-redaction";
import { LearningLedger } from "./learning-ledger";
import { sectionFromLedger, readMeasuredRuns, learningRoster } from "./learning-delivery";
import type { MeasuredRun } from "./learning-section";
import { listedProfileTargets, selectedProfileRows, profileTargetKey, resolveClaudeProfileModel, rosterEffortInstruction, type EffortSettingsLocation } from "./orchestration-profiles";
import { conductorInstruction, estimateTokens, resolveOrchestrationRoster, orchestrationExternalTargets } from "./orchestration-roster";
import { queueModelProfileResearch, flushModelProfileResearch, hasModelProfileResearch, buildEffortEvidence } from "./learning-research";
import { completedPublicClaims } from "./learning-episodes";
import { EXPERIMENT_HOLDOUT_PERCENT } from "./learning-experiment";
import { openNewConversationTab, tabLimit } from "./store-surfaces";
import { homedir } from "node:os";
import { listClaudeModels, detectClaudeExecutor, relabelRememberedClaudeModels } from "./orchestration-claude";
import { EXECUTORS, executorMap, claudeModelIdLabel, type ExecutorId } from "./orchestration-executors";
import { resolveModelDisplayName } from "./model-display-name";
import { DEFAULT_SYSTEM_APP_EXTENSIONS, systemAppExtensions } from "./file-link-open-mode";
import { detectExternalExecutor, listExternalModels } from "./orchestration-external";
import { externalExecutorName, isExternalModels, isExternalTimeout, type ExternalDetection, type ExternalModels, type ExternalModelsState } from "./orchestration-roster";
import { DEFAULT_ORCHESTRATION_ROSTER, isOrchestrationSettingRoster, orchestrationSettingRows, type OrchestrationSettingRow } from "./orchestration-roster";
import * as vscode from "vscode";
import {
  normalizeApiKeyPolicy,
  normalizeProfileSources,
  normalizeComposerSendKey,
  type ApiKeyPolicy,
  type ComposerSendKey,
  type FileLinkSetting,
  type HostToSettingsPage,
  type HostToWebview,
  type WebviewToHost,
} from "./protocol";
import * as l10n from "@vscode/l10n";
import { configuredClaudeExecutablePath, configuredDisplayName, getLaisoraConfiguration, readClaudeCodeSettings } from "./claude-settings";
import { isDisplayName } from "./display-name";
import { extensionContext, output, store } from "./host-context";
import { ADDITIONAL_MODELS_KEY, CLAUDE_VERSION_ID, additionalClaudeModelIds, recomputeModelRows, modelsMessage } from "./gateway-models";
import { restoreTabsOnStartupEnabled, setInitialTabTitle } from "./session-list-wiring";

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

export async function writeDisplayName(value: string): Promise<void> {
  if (isDisplayName(value)) await updateUserSetting("appearance.displayName", value);
}

export function userSettingsMessage(): Extract<HostToWebview, { type: "userSettings" }> {
  return {
    type: "userSettings",
    appearance: accentSettings(),
    displayName: configuredDisplayName(),
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
export function configuredProfileRoster() {
  return resolveOrchestrationRoster(getLaisoraConfiguration().get("orchestration.agents", DEFAULT_ORCHESTRATION_ROSTER)).roster;
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
  const policy = normalizeApiKeyPolicy(getLaisoraConfiguration().get("claude.apiKeyPolicy", "inherit"));
  externalDetection = executorMap(() => ({ state: "checking" }));
  externalModels = executorMap(id => {
    const remembered = rememberedModelLists[id];
    return remembered ? { state: "ok", ...remembered, refresh: "checking" } : { state: "checking" };
  });
  const executors = Object.values(EXECUTORS).map(({ id }) => id);
  const configuredPath = configuredClaudeExecutablePath(getLaisoraConfiguration());
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
  detectionPending = Promise.all(executors.map(async (executor) => {
      const started = Date.now();
      let detected: ExternalDetection;
      try { detected = await (executor === "claude" ? (claudeDetectorOverride ?? detectClaudeExecutor)(configuredPath) : detect(executor, policy)); }
      catch { detected = { state: "failed", path: "", reason: "spawn-error:UNKNOWN" }; }
      const reason = detected.state === "failed" ? detected.reason : detected.state === "found" ? detected.versionNote : undefined;
      if (reason) output.appendLine(`R-ORC-20: ${externalExecutorName(executor)} detection ${reason} elapsed=${Date.now() - started}ms`);
      externalDetection[executor] = detected;
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
    })).then(async () => {
      for (const session of store?.sessions.values() ?? []) {
        flushModelProfileResearch(session, getLaisoraConfiguration().get<boolean>("learning.enabled", false), externalModels, configuredProfileRoster());
      }
    }).finally(() => { detectionPending = undefined; detectionListeners.clear(); });
  return detectionPending;
}

export function configuredSystemAppExtensions(): string[] {
  let value: unknown;
  try {
    value = getLaisoraConfiguration().get(FILE_LINK_SETTING_KEYS.openWithSystemApp, DEFAULT_SYSTEM_APP_EXTENSIONS);
  } catch (error) {
    return systemAppExtensions(undefined, () => output.appendLine(
      `R-CNV-20: Could not read ${FILE_LINK_SETTING_KEYS.openWithSystemApp}; using defaults: ${String(error)}`));
  }
  return systemAppExtensions(value,
    () => output.appendLine(l10n.t("R-CNV-20: Invalid or blocked extensions in the default app setting were ignored.")));
}

let settingsLedger: LearningLedger | undefined;
let settingsMeasuredRuns: MeasuredRun[] = [];
export async function loadSettingsProfiles(): Promise<void> {
  const directory = extensionContext?.globalStorageUri?.fsPath;
  if (!directory) { settingsLedger = undefined; settingsMeasuredRuns = []; return; }
  try {
    if (settingsLedger?.directory !== join(directory, "laisora-learning")) settingsLedger = new LearningLedger(join(directory, "laisora-learning"));
    await settingsLedger.reload(true);
    settingsMeasuredRuns = await readMeasuredRuns(join(directory, "orchestration"), line => output.appendLine(line));
  } catch { settingsLedger = undefined; settingsMeasuredRuns = []; output.appendLine("R-LRN-07: settings ledger unavailable"); }
}
function settingsLearningState() { return settingsLedger?.state; }

export function projectConductorPreview(policy?: string): { text: string; tokens: number } {
  const cfg = getLaisoraConfiguration();
  const roster = resolveOrchestrationRoster(cfg.get("orchestration.agents", DEFAULT_ORCHESTRATION_ROSTER)).roster;
  const state = settingsLearningState();
  const conductorModel = resolveClaudeProfileModel("opus", externalModels) ?? "unknown";
  const profiles = state ? sectionFromLedger(state.records.values(), state.rules.values(), roster, externalModels, conductorModel,
    "unknown", "preview", new Date().toISOString(), settingsMeasuredRuns, {
      enabled: cfg.get<boolean>("learning.enabled", false), automaticAdoption: cfg.get<boolean>("learning.automaticAdoption", true),
      targetInjection: cfg.get<boolean>("learning.targetInjection", true), observationDelivery: cfg.get<boolean>("learning.observationDelivery", true), publicDelivery: cfg.get<boolean>("learning.publicDelivery", true), experiment: cfg.get<boolean>("learning.experiment", true), guard: cfg.get<boolean>("learning.guard", true),
    }).text : "";
  const text = cfg.get<boolean>("orchestration.enabled", false)
    ? conductorInstruction(roster, policy ?? cfg.get<string>("orchestration.conductorPolicy", ""), orchestrationExternalTargets(roster, externalModels), profiles)
    : l10n.t("The agent roster is disabled, so no instruction is added.");
  return { text, tokens: estimateTokens(text) };
}

export function researchUnavailableReason(): string {
  if (store && store.sessions.size >= tabLimit()) return l10n.t("LAISORA: The tab limit ({0}) has been reached.", tabLimit());
  return "";
}

function remoteEffortUnavailableReason(): string {
  return vscode.env.remoteName && extensionContext?.extension?.extensionKind === vscode.ExtensionKind.Workspace
    ? l10n.t("Effort proposals are unavailable because LAISORA is running in a remote extension host.") : "";
}

export function resolveRosterSettingsLocation(): EffortSettingsLocation | undefined {
  if (remoteEffortUnavailableReason()) return undefined;
  const cfg = getLaisoraConfiguration();
  const inspected = cfg.inspect("orchestration.agents");
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const workspaceFile = vscode.workspace.workspaceFile;
  const cwd = cfg.get<string>("defaultCwd") || folder?.fsPath || homedir();
  const locationFor = (file: string, scope: EffortSettingsLocation["scope"], isDefault: boolean, inWorkspaceFile: boolean): EffortSettingsLocation | undefined => {
    for (const [base, pathBase] of [[cwd, "workingFolder"], [homedir(), "home"]] as const) {
      const local = relative(base, file);
      if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) continue;
      const path = (pathBase === "home" ? "~/" : "") + local.split(sep).join("/");
      if (!containsAbsolutePath(path)) return { path, pathBase, scope, isDefault, inWorkspaceFile };
    }
    return undefined;
  };
  if (inspected?.workspaceFolderValue !== undefined && folder) {
    return locationFor(vscode.Uri.joinPath(folder, ".vscode", "settings.json").fsPath, "workspaceFolder", false, false);
  }
  if (inspected?.workspaceValue !== undefined && (workspaceFile || folder)) {
    return locationFor(workspaceFile?.fsPath ?? vscode.Uri.joinPath(folder!, ".vscode", "settings.json").fsPath,
      "workspace", false, !!workspaceFile);
  }
  const storage = extensionContext?.globalStorageUri;
  return storage ? locationFor(vscode.Uri.joinPath(storage, "..", "..", "settings.json").fsPath,
    "user", inspected?.globalValue === undefined, false) : undefined;
}

function effortUnavailableReason(): string {
  return remoteEffortUnavailableReason() || (resolveRosterSettingsLocation() ? ""
    : l10n.t("Effort proposals are unavailable because the settings file cannot be named without an absolute path."));
}

export function requestModelProfileResearch(ids: readonly string[], purpose?: "effort"): void {
  if (!store) return;
  const active = store.activeWebview ? store.sessions.get(store.activeTabIdOf(store.activeWebview) ?? "")?.conversation : undefined;
  const evidenceSource = purpose === "effort" && active ? active.durableConversationKey ?? "unknown" : undefined;
  const known = listedProfileTargets(externalModels, configuredProfileRoster());
  const targets = known.filter(target => ids.includes(profileTargetKey(target)));
  if (!ids.length || ids.some(id => !targets.some(target => profileTargetKey(target) === id))) {
    output.appendLine("R-LRN-18: rejected unknown model research targets");
    return;
  }
  if ([...store.sessions.values()].some(session => hasModelProfileResearch(session, targets, purpose === "effort"))) {
    void vscode.window.showInformationMessage(purpose === "effort" ? l10n.t("An effort proposal for these models is already running.") : l10n.t("Research for these models is already running."));
    return;
  }
  const reason = researchUnavailableReason() || (purpose === "effort" ? effortUnavailableReason() : "");
  if (reason) { void vscode.window.showInformationMessage(reason); return; }
  const location = purpose === "effort" ? resolveRosterSettingsLocation() : undefined;
  openNewConversationTab(store, session => {
    session.learningEvidenceSource = evidenceSource;
    session.learningDedicated = true;
    setInitialTabTitle(session, purpose === "effort" ? l10n.t("Roster effort proposal") : l10n.t("Model characteristics research"));
    queueModelProfileResearch(session, targets, normalizeProfileSources(getLaisoraConfiguration().get("learning.profileSources")),
      purpose === "effort" ? (models, roster, confirmed) => {
        const cfg = getLaisoraConfiguration(), state = settingsLearningState();
        const evidence = buildEffortEvidence(state ? [...state.records.values()] : [], settingsMeasuredRuns, confirmed,
          new Set(roster.filter(row => row.enabled).map(row => row.role)), evidenceSource, new Date().toISOString(), {
            enabled: cfg.get<boolean>("learning.enabled", false), automaticAdoption: cfg.get<boolean>("learning.automaticAdoption", true),
            targetInjection: cfg.get<boolean>("learning.targetInjection", true), observationDelivery: cfg.get<boolean>("learning.observationDelivery", true),
            publicDelivery: cfg.get<boolean>("learning.publicDelivery", true),
            experiment: cfg.get<boolean>("learning.experiment", true) && cfg.get<number>("learning.holdoutPercent", EXPERIMENT_HOLDOUT_PERCENT) !== 0,
            guard: cfg.get<boolean>("learning.guard", true),
          }, !!settingsLedger?.consistent && !settingsLedger.skipped && evidenceSource !== "unknown" && !state?.unavailableConversations.has(evidenceSource ?? ""), learningRoster(roster, models));
        const instruction = rosterEffortInstruction(location!, roster, models, confirmed, evidence);
        if (containsAbsolutePath(instruction)) {
          void vscode.window.showInformationMessage(l10n.t("Effort proposals are unavailable because the instruction contains an absolute path."));
          return undefined;
        }
        return instruction;
      } : undefined);
  });
}

function projectSettingsProfiles() {
  const state = settingsLearningState();
  const selected = listedProfileTargets(externalModels, configuredProfileRoster());
  const unresolved = [...new Set(selectedProfileRows(configuredProfileRoster(), externalModels)
    .filter(row => row.executor === "claude" && !resolveClaudeProfileModel(row.model, externalModels)).map(row => row.model))];
  const names = [...selected.map(target => {
    const claudeList = externalModels.claude;
    const name = target.executor === "claude"
      ? resolveModelDisplayName(claudeList.state === "ok" ? claudeList.models : [], target.model) ?? target.model
      : target.model;
    const all = state ? [...state.records.values()] : [], complete = completedPublicClaims(all);
    const profile = all.filter(record => record.kind === "claim" && complete.has(record.opId) && record.executor === target.executor
      && record.model === (target.executor === "claude" ? claudeModelIdLabel(target.model) : target.model)).sort((a, b) => a.at.localeCompare(b.at) || a.opId.localeCompare(b.opId)).at(-1);
    const checked = profile?.kind === "claim" && profile.sources?.length ? new Date(Math.max(...profile.sources.map(source => Date.parse(source.checkedAt)))) : undefined;
    const date = checked && [checked.getFullYear(), String(checked.getMonth() + 1).padStart(2, "0"), String(checked.getDate()).padStart(2, "0")].join("-");
    return l10n.t("{0} ({1})", name, date ? l10n.t("Last retrieved {0}", date) : l10n.t("Not registered"));
  }),
    ...unresolved.map(alias => l10n.t("{0} (cannot research because the version could not be retrieved)", alias))];
  return { researchTargets: selected.map(profileTargetKey),
    researchText: names.length ? l10n.t("Model characteristics: {0}", names.join(l10n.t(", "))) : "",
    researchUnavailable: researchUnavailableReason(), effortUnavailable: effortUnavailableReason(), conductorPreview: projectConductorPreview() };
}

export function settingsStateMessage(): Extract<HostToSettingsPage, { type: "settingsState" }> {
  loadRememberedModelLists();
  const cfg = getLaisoraConfiguration();
  const timeout = cfg.get("orchestration.externalTimeoutMinutes", 10);
  return {
    type: "settingsState",
    ...projectSettingsProfiles(),
    appearance: accentSettings(),
    displayName: configuredDisplayName(),
    openWithSystemApp: configuredSystemAppExtensions(),
    externalTimeoutMinutes: isExternalTimeout(timeout) ? timeout : 10,
    externalDetection: structuredClone(externalDetection),
    externalModels: cachedExternalModels(),
    orchestrationEnabled: cfg.get<boolean>("orchestration.enabled", false) === true,
    learningEnabled: cfg.get<boolean>("learning.enabled", false) === true,
    profileSources: normalizeProfileSources(cfg.get("learning.profileSources")),
    orchestrationAgents: readRoster(cfg.get("orchestration.agents", DEFAULT_ORCHESTRATION_ROSTER)),
    orchestrationDefaults: readRoster(cfg.inspect("orchestration.agents")?.defaultValue ?? DEFAULT_ORCHESTRATION_ROSTER),
    conductorPolicy: cfg.get<string>("orchestration.conductorPolicy", ""),
    conductorPolicyDefault: cfg.inspect<string>("orchestration.conductorPolicy")?.defaultValue ?? "",
    composerSendKey: normalizeComposerSendKey(cfg.get("composer.sendKey", "enter")),
    apiKeyPolicy: normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit")),
    restoreTabsOnStartup: restoreTabsOnStartupEnabled(),
    initialModel: cfg.get<string>("claude.initialModel", "").trim(),
    autoContinueAtUsageLimit: readClaudeCodeSettings(true).autoContinueAtUsageLimit !== false,
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

async function updateUserSetting(key: string, value: unknown): Promise<void> {
  try {
    await getLaisoraConfiguration().update(key, value, vscode.ConfigurationTarget?.Global ?? 1);
  } catch (error) {
    reportSettingWriteFailure(key, error);
  }
}

export async function writeInitialModel(model: string): Promise<void> {
  await updateUserSetting("claude.initialModel", model);
}

export async function writeComposerSendKey(sendKey: ComposerSendKey): Promise<void> {
  await updateUserSetting("composer.sendKey", sendKey);
}

export async function writeApiKeyPolicy(policy: ApiKeyPolicy): Promise<void> {
  await updateUserSetting("claude.apiKeyPolicy", policy);
}

export async function writeLearningEnabled(enabled: boolean): Promise<void> {
  await updateUserSetting("learning.enabled", enabled);
}

export async function writeProfileSources(value: unknown): Promise<void> {
  await updateUserSetting("learning.profileSources", normalizeProfileSources(value));
}

let normalizedRosterLogged = false;
function readRoster(value: unknown) {
  return orchestrationSettingRows(value, (message) => {
    if (!normalizedRosterLogged) output.appendLine(message);
    normalizedRosterLogged = true;
  });
}

export async function writeOrchestrationSetting(setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes", value: unknown): Promise<void> {
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
