import * as vscode from "vscode";

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { claudeConfigDir } from "./claude-env";
import { normalizeDisplayName } from "./display-name";
import { extensionContext, output } from "./host-context";
import { PERMISSION_MODES, PermissionModeId } from "./protocol";
import type { ModelInfo } from "./protocol";
import type { Session } from "./extension";
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import { readClaudeCodeSettings, invalidateClaudeCodeSettingsCache, notifyAutoContinueSettingChange } from "./claude-code-settings";
export { readClaudeCodeSettings, invalidateClaudeCodeSettingsCache, onAutoContinueSettingChange } from "./claude-code-settings";

type SettingsPatch = { [key: string]: string | boolean | null | undefined | SettingsPatch };

function mergeSettingsPatch(current: Record<string, unknown>, patch: SettingsPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete current[key];
    else if (typeof value === "object") {
      const previous = current[key];
      const nested = previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...previous as Record<string, unknown> } : {};
      mergeSettingsPatch(nested, value);
      Object.defineProperty(current, key, { value: nested, enumerable: true, configurable: true, writable: true });
    } else Object.defineProperty(current, key, { value, enumerable: true, configurable: true, writable: true });
  }
}

function tmpPathNotSharedWithOtherWindows(file: string): string {
  return `${file}.laisora.${process.pid}.tmp`;
}

export type SettingsWriteResult =
  | { ok: true }
  | { ok: false; reason: "read_failed" | "write_failed"; detail: string };

export function updateClaudeCodeSettings(patch: SettingsPatch): SettingsWriteResult {
  const file = join(claudeConfigDir(), "settings.json");
  let current: Record<string, unknown> = {};
  try {
    const raw = readFileSync(file, "utf8");
    current = JSON.parse(raw) as Record<string, unknown>;
    if (typeof current !== "object" || current === null) throw new Error("not an object");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      output.appendLine(`[settings] 読み取り/解析に失敗したため書き込みを中止: ${String(e)}`);
      return { ok: false, reason: "read_failed", detail: String(e) };
    }
    current = {};
  }
  mergeSettingsPatch(current, patch);
  if (patch.modelSettings && typeof patch.modelSettings === "object") {
    const rows = current.modelSettings as Record<string, unknown>;
    for (const model of Object.keys(patch.modelSettings)) {
      const row = rows[model];
      if (row && typeof row === "object" && Object.keys(row).length === 0) delete rows[model];
    }
    if (Object.keys(rows).length === 0) delete current.modelSettings;
  }
  const tmp = tmpPathNotSharedWithOtherWindows(file);
  try {
    writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    output.appendLine(`[settings] 保存: ${JSON.stringify(patch)}`);
    invalidateClaudeCodeSettingsCache();
    if ("autoContinueAtUsageLimit" in patch) notifyAutoContinueSettingChange();
    return { ok: true };
  } catch (e) {
    output.appendLine(`[settings] 保存に失敗: ${String(e)}`);
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    return { ok: false, reason: "write_failed", detail: String(e) };
  }
}

function modelSettingsKey(resolvedModel: string): string {
  return resolvedModel.endsWith("[1m]") ? resolvedModel.slice(0, -"[1m]".length) : resolvedModel;
}

const BUILTIN_CANONICAL_MODEL = /^claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d{1,2})?$/;

function settingsKeysForModel(selected: string, models: readonly Pick<ModelInfo, "id" | "resolvedModel">[]): Set<string> {
  const keys = new Set(models.filter((row) => row.id === selected || row.resolvedModel === selected)
    .map((row) => row.resolvedModel).filter((key): key is string => typeof key === "string" && key.length > 0)
    .map(modelSettingsKey));
  if (keys.size === 0 && BUILTIN_CANONICAL_MODEL.test(modelSettingsKey(selected))) keys.add(modelSettingsKey(selected));
  return keys;
}

export function canonicalEffortModel(s: Session): string | undefined {
  const snapshot = s.configuredEffortSnapshot;
  const selected = s.modelOverride ?? s.effectiveModel ?? s.appliedModel ?? (snapshot ? snapshot.resolvedModel ?? "default" : undefined);
  if (!selected) return undefined;
  const keys = settingsKeysForModel(selected, s.models);
  const key = keys.size === 1 ? [...keys][0] : undefined;
  return key && BUILTIN_CANONICAL_MODEL.test(key) ? key : undefined;
}

export function saveClaudeModelEffort(model: string, effort: Session["effortOverride"] | null): SettingsWriteResult | null {
  if (effort === "max") return null;
  return updateClaudeCodeSettings({ modelSettings: { [model]: { effortLevel: effort } } });
}

export type ConfiguredEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ConfiguredEffortSnapshot {
  environmentSpecified: boolean;
  environmentEffort?: ConfiguredEffort;
  globalEffort?: ConfiguredEffort;
  hasModelSettings: boolean;
  modelEfforts: Record<string, ConfiguredEffort>;
  resolvedModel?: string;
}

const CONFIGURED_EFFORT_RESOLVE_TIMEOUT_MS = 3_000;

function configuredEffort(value: unknown): ConfiguredEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

export function configuredEffortFromSnapshot(
  snapshot: ConfiguredEffortSnapshot,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[]
): ConfiguredEffort | undefined {
  if (snapshot.environmentSpecified) return snapshot.environmentEffort;

  const canonicalModels = canonicalSettingsKeys(snapshot, model, models);
  if (snapshot.hasModelSettings && canonicalModels.size !== 1) return undefined;
  if (canonicalModels.size === 1) {
    const rowEffort = snapshot.modelEfforts[[...canonicalModels][0]];
    if (rowEffort !== undefined) return rowEffort;
  }
  return snapshot.globalEffort;
}

function canonicalSettingsKeys(
  snapshot: ConfiguredEffortSnapshot,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[]
): Set<string> {
  const selectedModel = model ?? snapshot.resolvedModel;
  return selectedModel === null || selectedModel === undefined ? new Set() : settingsKeysForModel(selectedModel, models);
}

export function defaultEffortFromSnapshot(
  snapshot: ConfiguredEffortSnapshot | undefined,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[],
  applied: ConfiguredEffort | null | undefined
): ConfiguredEffort | undefined {
  if (snapshot === undefined || applied === null || applied === undefined) return undefined;
  if (snapshot.environmentSpecified || snapshot.globalEffort !== undefined) return undefined;
  if (Object.keys(snapshot.modelEfforts).length === 0) return applied;
  const keys = canonicalSettingsKeys(snapshot, model, models);
  return keys.size === 1 && snapshot.modelEfforts[[...keys][0]] === undefined ? applied : undefined;
}

export function effortDisplayFromSnapshot(
  snapshot: ConfiguredEffortSnapshot | undefined,
  model: string | null | undefined,
  models: readonly Pick<ModelInfo, "id" | "resolvedModel">[],
  applied: ConfiguredEffort | null | undefined
): { configured?: ConfiguredEffort; default?: ConfiguredEffort } {
  const configured = snapshot === undefined ? undefined : configuredEffortFromSnapshot(snapshot, model, models);
  if (applied === undefined || (configured !== undefined && configured === applied)) {
    return configured === undefined ? {} : { configured };
  }
  const fallback = defaultEffortFromSnapshot(snapshot, model, models, applied);
  return fallback === undefined ? {} : { default: fallback };
}

export async function resolveConfiguredEffortSnapshot(
  cwd: string,
  settingSources: Array<"user" | "project" | "local">
): Promise<ConfiguredEffortSnapshot | undefined> {
  const sdk = require("@anthropic-ai/claude-agent-sdk") as Pick<typeof ClaudeCodeSdk, "resolveSettings">;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const resolved = await Promise.race([
      sdk.resolveSettings({ cwd, settingSources }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`resolveSettings timeout (${CONFIGURED_EFFORT_RESOLVE_TIMEOUT_MS}ms)`)),
          CONFIGURED_EFFORT_RESOLVE_TIMEOUT_MS
        );
      }),
    ]);
    const effective = resolved.effective as Record<string, unknown>;
    const env = effective.env;
    const environmentSpecified =
      typeof env === "object" &&
      env !== null &&
      Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_EFFORT_LEVEL");
    const environmentEffort = environmentSpecified
      ? configuredEffort((env as Record<string, unknown>).CLAUDE_CODE_EFFORT_LEVEL)
      : undefined;
    const rawModelSettings = effective.modelSettings;
    const hasModelSettings =
      typeof rawModelSettings === "object" &&
      rawModelSettings !== null &&
      !Array.isArray(rawModelSettings) &&
      Object.keys(rawModelSettings).length > 0;
    const modelEfforts: Record<string, ConfiguredEffort> = {};
    if (hasModelSettings) {
      for (const [model, rawRow] of Object.entries(rawModelSettings as Record<string, unknown>)) {
        if (typeof rawRow !== "object" || rawRow === null || Array.isArray(rawRow)) continue;
        const effort = configuredEffort((rawRow as Record<string, unknown>).effortLevel);
        if (effort !== undefined) modelEfforts[model] = effort;
      }
    }
    const globalEffort = configuredEffort(effective.effortLevel);
    const modelSetting = process.env.ANTHROPIC_MODEL || effective.model;
    const resolvedModel = typeof modelSetting === "string" && modelSetting.length > 0
      ? modelSetting
      : undefined;
    return {
      environmentSpecified,
      ...(environmentEffort === undefined ? {} : { environmentEffort }),
      ...(globalEffort === undefined ? {} : { globalEffort }),
      hasModelSettings,
      modelEfforts,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
    };
  } catch (error) {
    output.appendLine(`[settings] configured effort resolution failed: ${String(error)}`);
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export const PERMISSION_MODE_KEY = "laisora.permissionMode.v1";

export function resolveInitialMode(): PermissionModeId {
  const saved = extensionContext?.globalState?.get(PERMISSION_MODE_KEY);
  if (typeof saved === "string" && (PERMISSION_MODES as string[]).includes(saved)) {
    return saved as PermissionModeId;
  }
  const m = readClaudeCodeSettings().defaultMode;
  if (m && (PERMISSION_MODES as string[]).includes(m)) return m as PermissionModeId;
  return "default";
}

export function inheritedProfile(s: Session): { model: string | null | undefined; effort: Session["effortOverride"] } {
  if (s.effectiveModel !== undefined) return { model: s.effectiveModel, effort: s.effortOverride ?? s.effectiveEffort };
  return {
    model: s.modelOverride,
    effort: s.effortOverride,
  };
}

export function configuredClaudeExecutablePath(cfg: vscode.WorkspaceConfiguration): string | undefined {
  return cfg.get<string>("claude.executablePath", "").trim() || undefined;
}

export function normalizeDriveLetter(cwd: string): string {
  return /^[a-z]:/.test(cwd) ? cwd[0].toUpperCase() + cwd.slice(1) : cwd;
}

export function resolveSessionCwd(s: Session): string | undefined {
  const cfg = getLaisoraConfiguration();
  const configured = cfg.get<string>("defaultCwd") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pinnedByResume = s.resumeFilePath !== undefined && s.cwd.length > 0 ? s.cwd : undefined;
  const cwd = pinnedByResume || configured || s.cwd || homedir() || undefined;
  return cwd === undefined ? undefined : normalizeDriveLetter(cwd);
}

export function getLaisoraConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("laisora");
}

export function configuredDisplayName(): string {
  return normalizeDisplayName(getLaisoraConfiguration().get<unknown>("appearance.displayName", ""));
}
