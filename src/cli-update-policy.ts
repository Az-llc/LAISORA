import { win32 } from "node:path";
import { envKeysOf, envValueOf } from "./claude-env";
import { EXECUTORS, type ExecutorId, type ExternalExecutorId } from "./orchestration-executors";
import { cliVersionNumber, compareSemVer, parseSemVer } from "./semver";

export { cliVersionNumber, compareSemVer, parseSemVer } from "./semver";

export const CLI_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
export const CLI_UPDATE_LOCK_STALE_MS = 15 * 60 * 1000;
export const EXTERNAL_RUN_MARKER_STALE_MS = 3 * 60 * 1000;
export const EXTERNAL_RUN_MARKER_HEARTBEAT_MS = EXTERNAL_RUN_MARKER_STALE_MS / 3;
export const CLI_UPDATE_ORDER: readonly ExecutorId[] = ["claude", "codex", "agy"];
export const CLI_AUTO_UPDATE_SETTINGS: Readonly<Record<ExecutorId, string>> = {
  claude: "claude.autoUpdate",
  codex: "codex.autoUpdate",
  agy: "antigravity.autoUpdate",
};

export function cliAutoUpdateEnabled(cfg: { get<T>(key: string): T | undefined }, id: ExecutorId): boolean {
  return cfg.get<boolean>(CLI_AUTO_UPDATE_SETTINGS[id]) !== false;
}

export type CliUpdateSkip = "notInstalled" | "notStandalone" | "notNative" | "disabled" | "locked" | "wouldDowngrade" | "latestUnknown";

export function cliUpdateSkipIsTransient(reason: CliUpdateSkip): boolean {
  return reason === "locked";
}

export function cliUpdateVersionGate(installed: string | undefined, latest: string | undefined, latestLookup: boolean): CliUpdateSkip | undefined {
  const current = parseSemVer(installed);
  if (latestLookup && latest === undefined) return "latestUnknown";
  const next = parseSemVer(latest);
  if (current && next) return compareSemVer(next, current) < 0 ? "wouldDowngrade" : undefined;
  return current?.prerelease.length ? "wouldDowngrade" : undefined;
}

export interface CliUpdateMoment {
  chatReady: boolean;
  turnRunning: boolean;
  externalRunActive: boolean;
}

export interface CliUpdateCandidate {
  id: ExecutorId;
  autoUpdate: boolean;
  lastAttemptAt?: number;
}

export interface CliUpdatePlan {
  run: ExecutorId[];
  waiting: ExecutorId[];
}

function withinWindow(now: number, since: number | undefined, windowMs: number): boolean {
  return since !== undefined && now >= since && now - since < windowMs;
}

export function cliUpdateThrottled(now: number, lastAttemptAt: number | undefined): boolean {
  return withinWindow(now, lastAttemptAt, CLI_UPDATE_INTERVAL_MS);
}

export function latestLookupFresh(now: number, lookedUpAt: number | undefined): boolean {
  return withinWindow(now, lookedUpAt, CLI_UPDATE_INTERVAL_MS);
}

export function cliUpdateLockFresh(now: number, lockModifiedAt: number | undefined): boolean {
  return withinWindow(now, lockModifiedAt, CLI_UPDATE_LOCK_STALE_MS);
}

export function externalRunMarkerFresh(now: number, markerModifiedAt: number | undefined): boolean {
  return markerModifiedAt !== undefined && Math.abs(now - markerModifiedAt) < EXTERNAL_RUN_MARKER_STALE_MS;
}

export function planCliUpdates(moment: CliUpdateMoment, candidates: readonly CliUpdateCandidate[], now: number): CliUpdatePlan {
  const due = candidates.filter((candidate) => candidate.autoUpdate && !cliUpdateThrottled(now, candidate.lastAttemptAt)).map(({ id }) => id);
  if (!moment.chatReady || moment.turnRunning) return { run: [], waiting: due };
  const blocked = (id: ExecutorId) => moment.externalRunActive && EXECUTORS[id].kind === "external";
  return { run: due.filter((id) => !blocked(id)), waiting: due.filter(blocked) };
}

export function isStandaloneExternalInstall(executor: ExternalExecutorId, executablePath: string, localAppData: string | undefined, platform: NodeJS.Platform): boolean {
  if (platform !== "win32" || !localAppData) return false;
  const fold = (value: string) => win32.resolve(value).toLowerCase();
  return fold(executablePath) === fold(win32.join(localAppData, ...EXECUTORS[executor].localPath!, `${executor}.exe`));
}

export function windowsStandardEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const system32 = win32.join(envValueOf(env, "SYSTEMROOT", platform) || "C:\\Windows", "System32");
  const front = [system32, win32.join(system32, "WindowsPowerShell", "v1.0")];
  const fold = (dir: string) => win32.normalize(dir.trim()).replace(/\\+$/, "").toLowerCase();
  const pathKeys = envKeysOf(env, "PATH", platform);
  const seen = new Set(front.map(fold));
  const rest = pathKeys.flatMap((key) => (env[key] ?? "").split(";")).filter((dir) => {
    if (!dir.trim() || fold(dir).endsWith("\\usr\\bin") || seen.has(fold(dir))) return false;
    seen.add(fold(dir));
    return true;
  });
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!pathKeys.includes(key)) result[key] = value;
  result[pathKeys[0] ?? "Path"] = [...front, ...rest].join(";");
  return result;
}

export function updatedFromVersion(before: string | undefined, after: string | undefined, ok: boolean, known: string | undefined): string | undefined {
  const [from, to, last] = [before, after, known].map(cliVersionNumber);
  if (!to) return undefined;
  if (from && from !== to) return from;
  return (!ok || !from) && last && last !== to ? last : undefined;
}
