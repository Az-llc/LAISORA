import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildClaudeEnv, claudeGlobalConfigFile, claudeSettingsFiles } from "./claude-env";
import { configuredClaudeExecutablePath, getLaisoraConfiguration } from "./claude-settings";
import {
  checkClaudeCodeVersion,
  decideClaudeCliUpdate,
  forgetClaudeCodeStartup,
  nativeClaudeUpdateTarget,
  resolveClaudeCodeStartup,
} from "./claudeCliResolver";
import {
  CLI_UPDATE_INTERVAL_MS,
  CLI_UPDATE_ORDER,
  cliAutoUpdateEnabled,
  cliUpdateLockFresh,
  cliUpdateSkipIsTransient,
  cliUpdateVersionGate,
  latestLookupFresh,
  cliUpdateThrottled,
  cliVersionNumber,
  isStandaloneExternalInstall,
  planCliUpdates,
  updatedFromVersion,
  windowsStandardEnv,
  type CliUpdateMoment,
  type CliUpdateSkip,
} from "./cli-update-policy";
import { sdkClaudeCodeVersion } from "./claudeHost";
import { detectedExecutorVersion, noteExecutorVersion } from "./gateway-host-actions";
import { output, store } from "./host-context";
import { EXECUTORS, type ExecutorId, type ExternalExecutorId } from "./orchestration-executors";
import { detectExternalExecutor, externalRunActive, externalRunActiveAnywhere, holdExternalRunsDuring, markExternalExecutorUpdating, resolveExternalExecutable, setExternalRunMarkerDirectory } from "./orchestration-external";
import { normalizeApiKeyPolicy, type ApiKeyPolicy } from "./protocol";
import { postSettingsState } from "./settings-panel";

const LOCK_FILE = "cli-update.lock";
const EXTERNAL_RUN_MARKER_DIRECTORY = "external-runs";
const SETTLE_DELAY_MS = 10_000;
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const CHANGELOG_URLS: Partial<Record<ExecutorId, string>> = {
  claude: "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  codex: "https://github.com/openai/codex/releases",
};
const LATEST_VERSION_SOURCES: Partial<Record<ExecutorId, readonly string[]>> = {
  codex: ["https://releases.openai.com/codex/channels/latest", "https://api.github.com/repos/openai/codex/releases/latest"],
};
const LATEST_LOOKUP_TIMEOUT_MS = 15_000;
const lastAttemptKey = (id: ExecutorId) => `laisora.cliUpdate.${id}.lastAttemptAt`;

interface UpdateTarget {
  executable: string;
  env: NodeJS.ProcessEnv;
  knownVersion?: string;
  readVersion(): Promise<string | undefined>;
  afterVersionChange?(): void;
}

let updateContext: vscode.ExtensionContext | undefined;
let chatReady = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let attempting = false;
const lastLogged = new Map<ExecutorId | "all", string>();
const latestLookups = new Map<ExecutorId, { version: string; at: number }>();

function managedSettingsFile(): string {
  if (process.platform === "win32") return join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json");
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function settingsEnv(settings: unknown): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const env = (settings as Record<string, unknown>).env;
  return env && typeof env === "object" ? (env as Record<string, unknown>) : undefined;
}

async function modifiedAt(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function createLock(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function takeOverStaleLock(lockPath: string): Promise<boolean> {
  const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await rename(lockPath, aside);
  } catch {
    return false;
  }
  if (cliUpdateLockFresh(Date.now(), await modifiedAt(aside))) {
    await link(aside, lockPath).catch(() => undefined);
    await rm(aside, { force: true });
    return false;
  }
  await rm(aside, { force: true });
  return createLock(lockPath);
}

function runCliUpdate(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolveRun) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(ok);
    };
    let child;
    try {
      child = spawn(executable, ["update"], { windowsHide: true, stdio: "ignore", env, shell: false });
    } catch {
      resolveRun(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, UPDATE_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

export function scheduleCliUpdates(context: vscode.ExtensionContext): void {
  updateContext = context;
  setExternalRunMarkerDirectory(join(context.globalStorageUri.fsPath, EXTERNAL_RUN_MARKER_DIRECTORY), (line) => output.appendLine(line));
  context.subscriptions.push({
    dispose: () => {
      updateContext = undefined;
      chatReady = false;
      setExternalRunMarkerDirectory(undefined);
      clearTimeout(settleTimer);
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
    },
  });
}

export function noteCliUpdateOpportunity(modelListReady = false): void {
  if (!updateContext) return;
  if (modelListReady && !chatReady) {
    chatReady = true;
    interval = setInterval(() => noteCliUpdateOpportunity(), CLI_UPDATE_INTERVAL_MS);
  }
  if (!chatReady) return;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => void attemptCliUpdates().catch((e) => output.appendLine(`[cli-update] ${String(e)}`)), SETTLE_DELAY_MS);
}

function turnRunning(): boolean {
  return [...(store?.sessions.values() ?? [])].some((session) => session.starting !== null || (session.conversation !== null && session.conversation.state !== "idle"));
}

function planFor(context: vscode.ExtensionContext, ids: readonly ExecutorId[], externalRunActive: boolean, ignoreThrottle = false) {
  const cfg = getLaisoraConfiguration();
  const moment: CliUpdateMoment = { chatReady, turnRunning: turnRunning(), externalRunActive };
  return planCliUpdates(moment, ids.map((id) => ({
    id,
    autoUpdate: cliAutoUpdateEnabled(cfg, id),
    lastAttemptAt: ignoreThrottle ? undefined : context.globalState.get<number>(lastAttemptKey(id)),
  })), Date.now());
}

function logOnChange(id: ExecutorId | "all", line: string): void {
  if (lastLogged.get(id) === line) return;
  lastLogged.set(id, line);
  output.appendLine(line);
}

async function attemptCliUpdates(): Promise<void> {
  const context = updateContext;
  if (!context || attempting) return;
  attempting = true;
  try {
    const plan = planFor(context, CLI_UPDATE_ORDER, await externalRunActiveAnywhere());
    logOnChange("all", `[cli-update] wait: ${plan.waiting.join(",") || "-"}`);
    for (const id of plan.run) {
      if (updateContext !== context) return;
      await updateCli(context, id);
    }
  } finally {
    attempting = false;
  }
}

function apiKeyPolicy(): ApiKeyPolicy {
  return normalizeApiKeyPolicy(getLaisoraConfiguration().get<string>("claude.apiKeyPolicy")!);
}

async function claudeUpdateTarget(): Promise<UpdateTarget | CliUpdateSkip> {
  const startup = await resolveClaudeCodeStartup(configuredClaudeExecutablePath(getLaisoraConfiguration()), sdkClaudeCodeVersion());
  const executable = await nativeClaudeUpdateTarget(startup.executable.path);
  const childEnv = buildClaudeEnv(process.env, apiKeyPolicy()).env;
  const settings = await Promise.all([...claudeSettingsFiles(), managedSettingsFile()].map(readJson));
  const inputs = {
    platform: process.platform,
    nativeInstall: executable !== undefined,
    envSources: [process.env, childEnv, ...settings.map(settingsEnv)],
    globalConfig: undefined as unknown,
  };
  let decision = decideClaudeCliUpdate(inputs);
  if (decision.run) decision = decideClaudeCliUpdate({ ...inputs, globalConfig: await readJson(claudeGlobalConfigFile()) });
  if (!decision.run || executable === undefined) return decision.run ? "notNative" : decision.reason;
  return {
    executable,
    env: windowsStandardEnv(childEnv, process.platform),
    knownVersion: startup.version.cliVersion,
    readVersion: async () => (await checkClaudeCodeVersion(executable)).cliVersion,
    afterVersionChange: forgetClaudeCodeStartup,
  };
}

function externalUpdateTarget(id: ExternalExecutorId): UpdateTarget | CliUpdateSkip {
  const executable = resolveExternalExecutable(id);
  if (!executable) return "notInstalled";
  if (!isStandaloneExternalInstall(id, executable, process.env.LOCALAPPDATA, process.platform)) return "notStandalone";
  const policy = apiKeyPolicy();
  return {
    executable,
    env: windowsStandardEnv(buildClaudeEnv(process.env, policy).env, process.platform),
    knownVersion: detectedExecutorVersion(id),
    readVersion: async () => {
      const detected = await detectExternalExecutor(id, policy, { resolve: () => executable });
      return detected.state === "found" ? detected.version : undefined;
    },
  };
}

async function latestReleaseVersion(id: ExecutorId, sources: readonly string[]): Promise<string | undefined> {
  const cached = latestLookups.get(id);
  if (cached && latestLookupFresh(Date.now(), cached.at)) return cached.version;
  const version = await fetchLatestReleaseVersion(sources);
  if (version) latestLookups.set(id, { version, at: Date.now() });
  return version;
}

async function fetchLatestReleaseVersion(sources: readonly string[]): Promise<string | undefined> {
  for (const url of sources) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "laisora" }, signal: AbortSignal.timeout(LATEST_LOOKUP_TIMEOUT_MS) });
      if (!response.ok) continue;
      const tag = ((await response.json()) as { tag_name?: unknown }).tag_name;
      if (typeof tag === "string" && tag) return tag;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function skipCli(context: vscode.ExtensionContext, id: ExecutorId, reason: CliUpdateSkip): Promise<void> {
  logOnChange(id, `[cli-update] ${id} skip: ${reason}`);
  if (!cliUpdateSkipIsTransient(reason)) await context.globalState.update(lastAttemptKey(id), Date.now());
}

function startUpdate(id: ExecutorId, target: UpdateTarget): Promise<boolean> {
  const run = () => runCliUpdate(target.executable, target.env);
  return id === "claude" ? run() : holdExternalRunsDuring(id, run);
}

async function updateCli(context: vscode.ExtensionContext, id: ExecutorId): Promise<void> {
  const lockDir = context.globalStorageUri.fsPath;
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, LOCK_FILE);
  const lockModifiedAt = await modifiedAt(lockPath);
  if (cliUpdateLockFresh(Date.now(), lockModifiedAt)) return skipCli(context, id, "locked");
  const target = id === "claude" ? await claudeUpdateTarget() : externalUpdateTarget(id);
  if (typeof target === "string") return skipCli(context, id, target);
  const locked = lockModifiedAt === undefined ? await createLock(lockPath) : await takeOverStaleLock(lockPath);
  if (!locked) return skipCli(context, id, "locked");
  const external = EXECUTORS[id].kind === "external";
  let before: string | undefined;
  let after: string | undefined;
  let ok = false;
  let releaseUpdatingMarker: (() => Promise<void>) | undefined;
  try {
    if (cliUpdateThrottled(Date.now(), context.globalState.get<number>(lastAttemptKey(id)))) return;
    before = await target.readVersion();
    const sources = LATEST_VERSION_SOURCES[id];
    const versionGate = cliUpdateVersionGate(before, sources ? await latestReleaseVersion(id, sources) : undefined, sources !== undefined);
    if (versionGate) return skipCli(context, id, versionGate);
    releaseUpdatingMarker = id !== "claude" ? await markExternalExecutorUpdating(id) : undefined;
    const elsewhere = external && await externalRunActiveAnywhere();
    if (!planFor(context, [id], elsewhere || (external && externalRunActive()), true).run.length) {
      logOnChange(id, `[cli-update] ${id} wait`);
      return;
    }
    const update = startUpdate(id, target);
    await context.globalState.update(lastAttemptKey(id), Date.now());
    ok = await update;
    after = await target.readVersion();
  } finally {
    await releaseUpdatingMarker?.();
    await rm(lockPath, { force: true });
  }
  lastLogged.delete(id);
  output.appendLine(`[cli-update] ${id} ${ok ? "ok" : "failed"}: ${before ?? "?"} -> ${after ?? "?"} (known ${target.knownVersion ?? "?"})`);
  const from = updatedFromVersion(before, after, ok, target.knownVersion);
  const to = cliVersionNumber(after);
  if (!from || !to || !after) return;
  target.afterVersionChange?.();
  noteExecutorVersion(id, after);
  postSettingsState();
  await showCliUpdatedNotice(id, from, to);
}

async function showCliUpdatedNotice(id: ExecutorId, from: string, to: string): Promise<void> {
  const url = CHANGELOG_URLS[id];
  const openChangelog = l10n.t("Open changelog");
  const text = EXECUTORS[id].kind === "agent"
    ? l10n.t(
      "Updated Claude Code from {0} to {1}. Conversations you start or resume from now on use the new version. Reopening a conversation that is open now may stop its cache from taking effect, so reopen it at a good stopping point.",
      from,
      to
    )
    : l10n.t("Updated {0} from {1} to {2}. External runs started from now on use the new version.", EXECUTORS[id].displayName, from, to);
  const choice = await (url ? vscode.window.showInformationMessage(text, openChangelog) : vscode.window.showInformationMessage(text));
  if (url && choice === openChangelog) await vscode.env.openExternal(vscode.Uri.parse(url));
}
