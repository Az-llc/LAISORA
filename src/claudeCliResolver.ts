import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import * as l10n from "@vscode/l10n";

export interface ResolvedClaudeCodeExecutable {
  /** A native executable, a JavaScript entry point, or the non-Windows `claude` command. */
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
  // npm の .cmd/.ps1 シムは cli.js を指す。現行 Claude Code は bin/claude.exe を同梱するため、
  // どちらもシムのディレクトリを前提に解決してから SDK へ渡す。
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

/** Create a resolver with an isolated cache. Exported for deterministic fixture tests. */
export function createClaudeCodeExecutableResolver(environment?: Partial<ResolverEnvironment>) {
  const env: ResolverEnvironment = {
    platform: environment?.platform ?? process.platform,
    pathValue: environment?.pathValue ?? process.env.PATH,
    cwd: environment?.cwd ?? process.cwd(),
  };
  let cached: { configuredPath: string; promise: Promise<ResolvedClaudeCodeExecutable> } | undefined;

  return (configuredPath?: string): Promise<ResolvedClaudeCodeExecutable> => {
    const configured = configuredPath?.trim() ?? "";
    if (cached?.configuredPath === configured) return cached.promise;

    const promise = (async () => {
      if (configured) {
        if (!isAbsolute(configured)) {
          throw cliNotFoundError(l10n.t("The configured executablePath must be an absolute path"));
        }
        if (!(await exists(configured))) {
          throw cliNotFoundError(l10n.t("The configured executablePath does not exist: {0}", configured));
        }
        return resolveCandidate(configured, "configuration", env.platform);
      }

      // Unix 系の CLI はシムを経由せず shell: false の spawn で実行できる。
      // PATH の独自探索は Windows の .cmd/.ps1 対策に限定する。
      if (env.platform !== "win32") return { path: "claude", source: "PATH" as const };

      const candidate = await findOnPath(env.pathValue);
      if (!candidate) throw cliNotFoundError();
      return resolveCandidate(candidate, "PATH", env.platform);
    })();
    cached = { configuredPath: configured, promise };
    // 失敗はキャッシュしない: CLI 導入や PATH 修復の後、再起動なしで次の解決が再試行できるようにする
    promise.catch(() => {
      if (cached?.promise === promise) cached = undefined;
    });
    return promise;
  };
}

const resolveForProcess = createClaudeCodeExecutableResolver();

/** Resolve the SDK executable asynchronously and cache it until executablePath changes. */
export function resolveClaudeCodeExecutable(configuredPath?: string): Promise<ResolvedClaudeCodeExecutable> {
  return resolveForProcess(configuredPath);
}

function minorVersion(version: string): string | undefined {
  const match = /\b(\d+)\.(\d+)(?:\.\d+)?\b/.exec(version);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/** Read the CLI version without a shell and without blocking the extension host. */
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

let cachedStartup: { cacheKey: string; promise: Promise<ResolvedClaudeCodeStartup> } | undefined;

/**
 * Resolve and inspect the CLI once for the active executablePath setting. Replacing that
 * setting creates a new cache entry; opening tabs or running warmup does not.
 */
export function resolveClaudeCodeStartup(
  configuredPath: string | undefined,
  sdkVersion?: string
): Promise<ResolvedClaudeCodeStartup> {
  const cacheKey = `${configuredPath?.trim() ?? ""}\u0000${sdkVersion ?? ""}`;
  if (cachedStartup?.cacheKey === cacheKey) return cachedStartup.promise;
  const promise = (async () => {
    const executable = await resolveClaudeCodeExecutable(configuredPath);
    const version = await checkClaudeCodeVersion(executable.path, sdkVersion);
    return { executable, version };
  })();
  cachedStartup = { cacheKey, promise };
  // 失敗はキャッシュしない（実行ファイル解決と同じ理由。version検査失敗は警告扱いでrejectしないが、
  // 解決失敗のrejectをここで恒久化しないことが再試行可能性の条件）
  promise.catch(() => {
    if (cachedStartup?.promise === promise) cachedStartup = undefined;
  });
  return promise;
}
