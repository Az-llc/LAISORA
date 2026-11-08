import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { claudeConfigDir, claudeGlobalConfigFile } from "./claude-env";
import { getLaisoraConfiguration } from "./claude-settings";
import { sendLaisoraInput } from "./conversation-lifecycle";
import { output, store } from "./host-context";
import { exportMigration, importMigration, MigrationError, migrationFailureOf, previewMigration, rebindMigratedFolder, rebindRefusal, scanMigration,
  type MigrationExportResult, type MigrationImportResult, type MigrationPlace, type MigrationProgressReport, type MigrationScan } from "./migration";
import { formatBytes, isMigrationCategory, MIGRATION_CATEGORIES, migrationCategoryTitle, type MigrationCategory, type MigrationOperation, type MigrationProgress } from "./migration-categories";
import { folderHolds, MIGRATION_README, normalizedWorkFolder, type MigrationManifest } from "./migration-plan";
import { PORTABLE_CONFIGURATION_KEYS } from "./configuration-defaults";
import type { MigrationNotice } from "./protocol";
import { openTitledConversationTab } from "./store-surfaces";
import { hostTodoStore, todoFeatureEnabled } from "./todo-surface";

function migrationPlace(): MigrationPlace {
  return { configDir: claudeConfigDir(), globalConfigFile: claudeGlobalConfigFile(), home: homedir(), platform: process.platform, env: process.env, todoStore: hostTodoStore() };
}

function laisoraUserSettings(): Record<string, unknown> {
  const cfg = getLaisoraConfiguration();
  return Object.fromEntries(PORTABLE_CONFIGURATION_KEYS.flatMap(key => {
    const value = cfg.inspect(key)?.globalValue;
    return value === undefined ? [] : [[key, value]];
  }));
}

async function writeLaisoraUserSettings(values: Record<string, unknown>): Promise<string[]> {
  const cfg = getLaisoraConfiguration();
  const failed: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!PORTABLE_CONFIGURATION_KEYS.includes(key)) { failed.push(key); continue; }
    try { await cfg.update(key, value, vscode.ConfigurationTarget.Global); }
    catch (error) { failed.push(key); output.appendLine(`[migration] could not write laisora.${key}: ${String(error)}`); }
  }
  return failed;
}

let busy = false;
const listeners = new Set<() => void>();
const progressListeners = new Set<(progress: MigrationProgress) => void>();

export function onMigrationBusyChange(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

export function onMigrationProgress(listener: (progress: MigrationProgress) => void): { dispose(): void } {
  progressListeners.add(listener);
  return { dispose: () => progressListeners.delete(listener) };
}

export function migrationBusy(): boolean {
  return busy;
}

const PROGRESS_INTERVAL_MS = 250;

const progressStops = new Set<() => void>();

function progressReporter(operation: MigrationOperation): MigrationProgressReport {
  const startedAt = Date.now();
  let stopped = false;
  let sentAt = 0, sentPhase: MigrationProgress["phase"] | undefined, trailing: ReturnType<typeof setTimeout> | undefined, latest: MigrationProgress | undefined;
  const send = () => {
    if (trailing !== undefined) { clearTimeout(trailing); trailing = undefined; }
    if (!latest || stopped) return;
    sentAt = Date.now();
    sentPhase = latest.phase;
    const progress = latest;
    latest = undefined;
    progressListeners.forEach(listener => listener(progress));
  };
  progressStops.add(() => {
    stopped = true;
    if (trailing !== undefined) { clearTimeout(trailing); trailing = undefined; }
  });
  return update => {
    if (stopped) return;
    latest = { operation, startedAt, ...update };
    const complete = update.done !== undefined && update.total !== undefined && update.done >= update.total;
    const wait = PROGRESS_INTERVAL_MS - (Date.now() - sentAt);
    if (update.phase !== sentPhase || complete || wait <= 0) send();
    else trailing ??= setTimeout(send, wait);
  };
}

async function exclusive<T>(work: () => Promise<T>): Promise<T | "busy"> {
  if (busy) return "busy";
  busy = true;
  listeners.forEach(listener => listener());
  try { return await work(); }
  finally {
    progressStops.forEach(stop => stop());
    progressStops.clear();
    busy = false;
    listeners.forEach(listener => listener());
  }
}

export async function scanMigrationForPage(): Promise<MigrationScan> {
  return scanMigration(migrationPlace(), Object.keys(laisoraUserSettings()).length);
}

function migrationErrorText(error: unknown): string {
  return migrationFailureText(migrationFailureOf(error));
}

function migrationFailureText(failure: NonNullable<MigrationImportResult["error"]>): string {
  output.appendLine(`[migration] ${failure.code ?? failure.fsCode ?? "error"}: ${failure.detail}`);
  if (failure.code) {
    const error = new MigrationError(failure.code, failure.detail);
    switch (error.code) {
      case "archiverMissing":
        return process.platform === "linux"
          ? l10n.t("zip and unzip are not installed. Installing zip and unzip enables migration.")
          : l10n.t("The archiver that creates and reads ZIP files was not found: {0}", error.detail);
      case "notMigration": return l10n.t("This file is not a LAISORA migration ZIP.");
      case "exists": return l10n.t("A file already exists at {0}.", error.detail);
      case "brokenLink": return l10n.t("A link under the Claude config folder points to a missing folder or back into a folder that contains it: {0}. Fix or remove that link and export again.", error.detail);
      default: return l10n.t("The archiver failed: {0}", error.detail);
    }
  }
  return failure.fsCode ? l10n.t("A file could not be read or written ({0}). Details are in the LAISORA output.", failure.fsCode) : l10n.t("Something went wrong. Details are in the LAISORA output.");
}

function categoryCounts(manifest: MigrationManifest): string[] {
  const { counts } = manifest;
  const lines: Record<MigrationCategory, string> = {
    todo: l10n.t("ToDo: {0} items", counts.todo ?? 0),
    laisoraSettings: l10n.t("LAISORA settings: {0} values", counts.laisoraSettings ?? 0),
    claudeEnv: l10n.t("Claude environment: {0} files, {1} MCP servers", counts.claudeEnv ?? 0, counts.mcpServers ?? 0),
    conversations: l10n.t("Conversations: {0} in {1} work folders", counts.conversations ?? 0, manifest.folders.filter(folder => folderHolds(folder, "conversations")).length),
    memory: l10n.t("Memory: {0} files in {1} work folders", counts.memory ?? 0, manifest.folders.filter(folder => folderHolds(folder, "memory")).length),
  };
  return manifest.categories.map(category => lines[category]);
}

async function confirmImport(manifest: MigrationManifest): Promise<boolean> {
  const proceed = l10n.t("Import");
  const detail = [
    l10n.t("Exported at {0} from {1}.", new Date(manifest.exportedAt).toLocaleString(), manifest.home),
    ...categoryCounts(manifest),
    l10n.t("ToDo is replaced and the previous ToDo is saved to a backup folder, settings are written to your user settings, and existing Claude files with different content are moved to that backup folder first. Files already in the conversation folders are kept as they are."),
  ].join("\n");
  return await vscode.window.showWarningMessage(l10n.t("Import this migration ZIP?"), { modal: true, detail }, proceed) === proceed;
}

async function confirmExport(target: string, categories: readonly MigrationCategory[]): Promise<boolean> {
  const proceed = l10n.t("Export");
  const detail = [l10n.t("Claude asks to write a migration ZIP to {0}.", target), categories.map(migrationCategoryTitle).join(" · ")].join("\n");
  return await vscode.window.showWarningMessage(l10n.t("Export a migration ZIP?"), { modal: true, detail }, proceed) === proceed;
}

async function runExport(categories: readonly MigrationCategory[], target: string): Promise<MigrationExportResult | "busy"> {
  return exclusive(() => exportMigration(migrationPlace(), { categories, output: target, laisoraSettings: laisoraUserSettings() }, progressReporter("export")));
}

async function runImport(archive: string): Promise<MigrationImportResult | "cancelled" | "busy"> {
  return exclusive(async () => {
    const place = migrationPlace();
    const manifest = await previewMigration(place, archive);
    if (!await confirmImport(manifest)) return "cancelled" as const;
    return importMigration(place, archive, manifest, writeLaisoraUserSettings, progressReporter("import"));
  });
}

const BUSY_TEXT = () => l10n.t("Another migration is running. Try again when it finishes.");

export async function exportMigrationFromPage(categories: readonly MigrationCategory[]): Promise<MigrationNotice | undefined> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(homedir(), `laisora-migration-${stamp}.zip`)), filters: { ZIP: ["zip"] }, saveLabel: l10n.t("Export") });
  if (!uri) return undefined;
  try {
    const result = await runExport(categories, uri.fsPath);
    if (result === "busy") return { ok: false, text: BUSY_TEXT() };
    return { ok: true, text: l10n.t("Exported to {0}. Keep it somewhere safe and import it from this tab on the new PC.", result.output) };
  } catch (error) {
    output.appendLine(`[migration] export failed: ${String(error)}`);
    return { ok: false, text: migrationErrorText(error) };
  }
}

export function migrationImportPrompt(): string {
  return l10n.t("Please help me import a LAISORA migration ZIP that I exported on my old PC, step by step.\n1. Ask me only for the path of the ZIP file. Accept the path as I paste it, with or without quotes.\n2. Call the import_migration tool with that path. VS Code asks me to confirm. Then tell me in plain words what was placed and what was kept as it was.\n3. Read the LAISORA-MIGRATION.md whose path is in the tool result (guide).\n4. If the result lists work folders not found on this PC (unresolved), ask me once, listing all of them, where each project is now; I may answer that one is not needed. For each folder I give, call the rebind_migrated_folder tool with its dirName and cwd from the result as dirName and oldCwd and that folder as newCwd (VS Code asks me to confirm), then tell me what it moved and whether its check passed.\n5. Do not delete or overwrite anything without asking me first.");
}

let importStarting = false;

const VIEW_ATTACH_WAIT_MS = 2000;

async function revealSettingsStartView(): Promise<vscode.Webview | null> {
  const target = store?.settingsStartTarget() ?? null;
  if (target !== null && store?.panel?.webview === target) {
    store.panel.reveal();
    return target;
  }
  await vscode.commands.executeCommand("laisora.home.focus");
  for (const deadline = Date.now() + VIEW_ATTACH_WAIT_MS; store?.settingsStartTarget() == null && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
  const shown = store?.settingsStartTarget() ?? null;
  if (shown !== null) return shown;
  await vscode.commands.executeCommand("laisora.open");
  return store?.panel?.webview ?? null;
}

export async function startMigrationImport(): Promise<MigrationNotice | undefined> {
  if (!todoFeatureEnabled()) return { ok: false, text: l10n.t("Importing uses Claude's ToDo tools. Turn on ToDo in General first.") };
  if (importStarting) return { ok: false, text: BUSY_TEXT() };
  importStarting = true;
  try {
    const target = await revealSettingsStartView();
    const session = store ? openTitledConversationTab(store, l10n.t("Migration import"), target) : undefined;
    if (!session) return { ok: false, text: l10n.t("The conversation could not be started.") };
    session.awaitingLaisoraInput = true;
    try {
      if (!await sendLaisoraInput(session, { kind: "migrationImport" }, migrationImportPrompt())) return { ok: false, text: l10n.t("The conversation could not be started.") };
    } finally { session.awaitingLaisoraInput = false; }
    return { ok: true, text: l10n.t("A conversation for the import has started in LAISORA.") };
  } finally { importStarting = false; }
}

async function confirmRebind(dirName: string, newCwd: string): Promise<boolean> {
  const proceed = l10n.t("Move");
  return await vscode.window.showWarningMessage(l10n.t("Move the imported conversations to {0}?", newCwd), { modal: true,
    detail: l10n.t("Claude asks to move the conversation records and memory under ~/.claude/projects/{0} to the place of {1}, add the new work folder to their records and change ToDo groups bound to the old folder. Files already there are kept.", dirName, newCwd) }, proceed) === proceed;
}

export interface MigrationToolInput {
  readonly categories?: readonly string[];
  readonly output: string;
}

export const migrationTools = {
  async export(input: MigrationToolInput): Promise<{ text: string; isError: boolean }> {
    const categories = input.categories?.length ? input.categories.filter(isMigrationCategory) : [...MIGRATION_CATEGORIES];
    if (!isAbsolute(input.output) || !/\.zip$/i.test(input.output)) return { text: "output must be an absolute path ending in .zip.", isError: true };
    if (existsSync(input.output)) return { text: `A file already exists at ${input.output}; choose another output path.`, isError: true };
    try {
      if (!await confirmExport(input.output, categories)) return { text: "The user declined the export; nothing was written.", isError: true };
      const result = await runExport(categories, input.output);
      if (result === "busy") return { text: "Another migration is running in LAISORA; try again when it finishes.", isError: true };
      const keyHolders = [...result.mcpKeyServers.map(name => `MCP server ${name}`), ...result.settingsKeyFiles];
      return { isError: false, text: JSON.stringify({
        output: result.output, categories: result.manifest.categories, counts: result.manifest.counts, workFolders: result.manifest.folders.length,
        ...(categories.includes("conversations") ? { conversationBytes: formatBytes(result.projects.conversations.bytes) } : {}),
        ...(categories.includes("memory") ? { memoryBytes: formatBytes(result.projects.memory.bytes) } : {}),
        ...(keyHolders.length ? { warning: `${keyHolders.join(", ")} have env names, headers, arguments, URLs, values or an apiKeyHelper that look like keys; any keys written there are in the ZIP.` } : {}),
      }) };
    } catch (error) {
      output.appendLine(`[migration] export tool failed: ${String(error)}`);
      return { text: migrationErrorText(error), isError: true };
    }
  },
  async rebind(input: { dirName: string; newCwd: string; oldCwd?: string }, runningCwd?: string): Promise<{ text: string; isError: boolean }> {
    if (!isAbsolute(input.newCwd) && !/^[\\/]/.test(input.newCwd)) return { text: `newCwd must be an absolute path: ${input.newCwd}`, isError: true };
    const newCwd = normalizedWorkFolder(input.newCwd);
    if (!(await stat(newCwd).catch(() => undefined))?.isDirectory()) return { text: `newCwd must be an existing folder: ${input.newCwd}`, isError: true };
    try {
      const place = migrationPlace();
      const refusal = await rebindRefusal(place, input.dirName, runningCwd, newCwd);
      if (refusal) return { text: refusal, isError: true };
      if (!await confirmRebind(input.dirName, newCwd)) return { text: "The user declined; nothing was moved.", isError: true };
      const result = await exclusive(() => rebindMigratedFolder(place, input.dirName, newCwd, input.oldCwd));
      if (result === "busy") return { text: "Another migration is running in LAISORA; try again when it finishes.", isError: true };
      return { isError: !result.complete, text: JSON.stringify(result) };
    } catch (error) {
      output.appendLine(`[migration] rebind tool failed: ${String(error)}`);
      return { text: migrationErrorText(error), isError: true };
    }
  },
  async import(archive: string): Promise<{ text: string; isError: boolean }> {
    if (!isAbsolute(archive) || !existsSync(archive)) return { text: `No file at ${archive}; give the absolute path of the ZIP.`, isError: true };
    try {
      const result = await runImport(archive);
      if (result === "busy") return { text: "Another migration is running in LAISORA; try again when it finishes.", isError: true };
      if (result === "cancelled") return { text: "The user declined the import; nothing was placed.", isError: true };
      return { isError: result.error !== undefined, text: JSON.stringify({ ...result, ...(result.error ? { error: migrationFailureText(result.error) } : {}),
        ...(result.guide ? { next: `${MIGRATION_README} is at ${result.guide}. ${result.unresolved.length ? "unresolved lists the work folders not found on this PC; their records and memory are under ~/.claude/projects/<dirName>. Ask the user where each project is now, then call rebind_migrated_folder with its dirName and that folder." : "Every work folder was found on this PC."}` } : {}) }) };
    } catch (error) {
      output.appendLine(`[migration] import tool failed: ${String(error)}`);
      return { text: migrationErrorText(error), isError: true };
    }
  },
};
