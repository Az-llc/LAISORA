import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import * as l10n from "@vscode/l10n";
import { envValueOf } from "./claude-env";

export interface ResolvedClaudeCodeExecutable {
  path: string;
  source: "configuration" | "PATH";
  shimPath?: string;
}

export interface ClaudeVersionCheck {
  cliVersion?: string;
  sdkVersion?: string;
  warning?: string;
}

export interface ResolvedClaudeCodeStartup {
  executable: ResolvedClaudeCodeExecutable;
  version: ClaudeVersionCheck;
}

interface ResolverEnvironment {
  platform: NodeJS.Platform;
  pathValue?: string;
  cwd: string;
}

const CLI_PACKAGE = ["node_modules", "@anthropic-ai", "claude-code"];
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".ps1"]);
const WINDOWS_PATH_CANDIDATES = ["claude.exe", "claude.cmd", "claude.ps1", "claude"];
const VERSION_TIMEOUT_MS = 10_000;

function cliNotFoundError(detail?: string): Error {
  return Object.assign(new Error(
    l10n.t(
      "Claude Code CLI was not found. Install Claude Code and add it to PATH, or set laisora.claude.executablePath to the absolute path of the executable."
    ) + (detail ? ` (${detail})` : "")
  ), { code: "CLAUDE_CLI_NOT_FOUND" });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(pathValue: string | undefined): Promise<string | undefined> {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const candidate of WINDOWS_PATH_CANDIDATES) {
      const file = join(directory, candidate);
      if (await exists(file)) return file;
    }
  }
  return undefined;
}

async function resolveShimTarget(shimPath: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(shimPath, "utf8");
  } catch (error) {
    throw cliNotFoundError(l10n.t("Cannot read the shim: {0} ({1})", shimPath, String(error)));
  }

  const shimDirectory = dirname(shimPath);
  const knownTargets = [
    join(shimDirectory, ...CLI_PACKAGE, "cli.js"),
    join(shimDirectory, ...CLI_PACKAGE, "bin", "claude.exe"),
  ];
  for (const target of knownTargets) {
    if (await exists(target)) return target;
  }

  const embeddedTarget = content.match(
    /["']([^"']*@anthropic-ai[\\/]claude-code[\\/](?:cli\.js|bin[\\/]claude\.exe))["']/i
  )?.[1];
  if (embeddedTarget) {
    const target = resolve(shimDirectory, embeddedTarget.replace(/^[\\/]+/, ""));
    if (await exists(target)) return target;
  }

  throw cliNotFoundError(
    l10n.t(
      "Unsupported or broken script shim: {0}. Set laisora.claude.executablePath to the absolute path of the actual Claude Code executable",
      shimPath
    )
  );
}

async function resolveCandidate(
  candidate: string,
  source: ResolvedClaudeCodeExecutable["source"],
  platform: NodeJS.Platform
): Promise<ResolvedClaudeCodeExecutable> {
  const extension = extname(candidate).toLowerCase();
  if (platform === "win32" && WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    return { path: await resolveShimTarget(candidate), source, shimPath: candidate };
  }
  return { path: candidate, source };
}

function createCacheThatForgetsFailures<T>(): ((key: string, create: () => Promise<T>) => Promise<T>) & { forget(): void } {
  let cached: { key: string; promise: Promise<T> } | undefined;
  const get = (key: string, create: () => Promise<T>): Promise<T> => {
    if (cached?.key === key) return cached.promise;
    const promise = create();
    cached = { key, promise };
    promise.catch(() => {
      if (cached?.promise === promise) cached = undefined;
    });
    return promise;
  };
  return Object.assign(get, { forget: () => { cached = undefined; } });
}

export function createClaudeCodeExecutableResolver(environment?: Partial<ResolverEnvironment>) {
  const env: ResolverEnvironment = {
    platform: environment?.platform ?? process.platform,
    pathValue: environment?.pathValue ?? process.env.PATH,
    cwd: environment?.cwd ?? process.cwd(),
  };
  const cache = createCacheThatForgetsFailures<ResolvedClaudeCodeExecutable>();

  return (configuredPath?: string): Promise<ResolvedClaudeCodeExecutable> => {
    const configured = configuredPath?.trim() ?? "";
    return cache(configured, async () => {
      if (configured) {
        if (!isAbsolute(configured)) {
          throw cliNotFoundError(l10n.t("The configured executablePath must be an absolute path"));
        }
        if (!(await exists(configured))) {
          throw cliNotFoundError(l10n.t("The configured executablePath does not exist: {0}", configured));
        }
        return resolveCandidate(configured, "configuration", env.platform);
      }

      if (env.platform !== "win32") return { path: "claude", source: "PATH" as const };

      const candidate = await findOnPath(env.pathValue);
      if (!candidate) throw cliNotFoundError();
      return resolveCandidate(candidate, "PATH", env.platform);
    });
  };
}

const resolveForProcess = createClaudeCodeExecutableResolver();

export function resolveClaudeCodeExecutable(configuredPath?: string): Promise<ResolvedClaudeCodeExecutable> {
  return resolveForProcess(configuredPath);
}

function minorVersion(version: string): string | undefined {
  const match = /\b(\d+)\.(\d+)(?:\.\d+)?\b/.exec(version);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

export function checkClaudeCodeVersion(
  executablePath: string,
  sdkVersion?: string,
  timeoutMs = VERSION_TIMEOUT_MS
): Promise<ClaudeVersionCheck> {
  return new Promise((resolveVersion) => {
    const isJavaScript = extname(executablePath).toLowerCase() === ".js";
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (failure?: string) => {
      if (settled) return;
      settled = true;
      const output = `${stdout}\n${stderr}`.trim();
      const cliVersion = /\b\d+\.\d+(?:\.\d+)?\b/.exec(output)?.[0];
      const sdkMinor = sdkVersion ? minorVersion(sdkVersion) : undefined;
      const cliMinor = cliVersion ? minorVersion(cliVersion) : undefined;
      let warning: string | undefined;
      if (!cliVersion) {
        warning = l10n.t("Could not read the Claude Code CLI version, so compatibility is unverified") + (failure ? ` (${failure})` : "");
      } else if (!sdkVersion || !sdkMinor || !cliMinor) {
        warning = l10n.t("Could not parse the version formats of the Claude Code CLI and the SDK, so compatibility is unverified");
      }
      resolveVersion({ cliVersion, sdkVersion, warning });
    };

    let child;
    try {
      child = spawn(isJavaScript ? process.execPath : executablePath, isJavaScript ? [executablePath, "--version"] : ["--version"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(String(error));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => finish(String(error)));
    child.on("close", () => finish());
    const timer = setTimeout(() => {
      child.kill();
      finish(l10n.t("timeout ({0}ms)", timeoutMs));
    }, timeoutMs);
    child.on("close", () => clearTimeout(timer));
  });
}

const startupCache = createCacheThatForgetsFailures<ResolvedClaudeCodeStartup>();

export function resolveClaudeCodeStartup(
  configuredPath: string | undefined,
  sdkVersion?: string
): Promise<ResolvedClaudeCodeStartup> {
  const cacheKey = `${configuredPath?.trim() ?? ""}\u0000${sdkVersion ?? ""}`;
  return startupCache(cacheKey, async () => {
    const executable = await resolveClaudeCodeExecutable(configuredPath);
    const version = await checkClaudeCodeVersion(executable.path, sdkVersion);
    return { executable, version };
  });
}

export function forgetClaudeCodeStartup(): void {
  startupCache.forget();
}

const TRUTHY_ENV_VALUES = ["1", "true", "yes", "on"];

export type ClaudeCliUpdateDecision =
  | { run: true }
  | { run: false; reason: "notNative" | "disabled" };

export interface ClaudeCliUpdateInputs {
  platform: NodeJS.Platform;
  nativeInstall: boolean;
  envSources: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>;
  globalConfig: unknown;
}

function envDisablesUpdates(env: Readonly<Record<string, unknown>> | undefined, platform: NodeJS.Platform): boolean {
  if (!env || typeof env !== "object") return false;
  return envTruthy(envValueOf(env, "DISABLE_UPDATES", platform))
    || envTruthy(envValueOf(env, "DISABLE_AUTOUPDATER", platform))
    || !!envValueOf(env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", platform);
}

function envTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return !!value && TRUTHY_ENV_VALUES.includes(String(value).toLowerCase().trim());
}

function globalConfigDisablesUpdates(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const record = config as Record<string, unknown>;
  return record.autoUpdates === false && (record.installMethod !== "native" || record.autoUpdatesProtectedForNative !== true);
}

export function decideClaudeCliUpdate(inputs: ClaudeCliUpdateInputs): ClaudeCliUpdateDecision {
  if (!inputs.nativeInstall) return { run: false, reason: "notNative" };
  if (inputs.envSources.some((env) => envDisablesUpdates(env, inputs.platform)) || globalConfigDisablesUpdates(inputs.globalConfig)) {
    return { run: false, reason: "disabled" };
  }
  return { run: true };
}

function isInside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const rel = paths.relative(fold(parent), fold(child));
  return rel !== "" && !rel.startsWith("..") && !paths.isAbsolute(rel);
}

export function isNativeClaudeInstall(
  executablePath: string,
  realExecutablePath: string,
  home: string,
  platform: NodeJS.Platform
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const launcher = paths.join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude");
  if (fold(paths.resolve(executablePath)) !== fold(launcher)) return false;
  if (platform === "win32") return true;
  return isInside(paths.join(home, ".local", "share", "claude", "versions"), paths.resolve(realExecutablePath), platform);
}

async function findUnixClaude(pathValue: string | undefined): Promise<string | undefined> {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory) continue;
    const file = join(directory, "claude");
    if (await exists(file)) return file;
  }
  return undefined;
}

export async function nativeClaudeUpdateTarget(
  executablePath: string,
  environment?: Partial<ResolverEnvironment> & { home?: string }
): Promise<string | undefined> {
  const platform = environment?.platform ?? process.platform;
  const home = environment?.home ?? homedir();
  const located = isAbsolute(executablePath)
    ? (platform === "win32" ? win32 : posix).resolve(executablePath)
    : await findUnixClaude(environment?.pathValue ?? process.env.PATH);
  if (!located) return undefined;
  let real: string;
  try {
    real = await realpath(located);
  } catch {
    return undefined;
  }
  return isNativeClaudeInstall(located, real, home, platform) ? located : undefined;
}
