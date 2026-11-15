import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyPolicy } from "./protocol";
import { SKIP_PROMPT_HISTORY_ENV } from "./skip-prompt-history-env";

export function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return (configured ? configured : join(homedir(), ".claude")).normalize("NFC");
}

export function claudeGlobalConfigFile(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return join(configured ? configured : homedir(), ".claude.json");
}

export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

export const PROJECT_DIR_ENCODE_MAX = 200;

function projectDirNameHash(cwd: string): string {
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) hash = (hash << 5) - hash + cwd.charCodeAt(index) | 0;
  return Math.abs(hash).toString(36);
}

export function normalizeDriveLetter(cwd: string): string {
  return /^[a-z]:/.test(cwd) ? cwd[0].toUpperCase() + cwd.slice(1) : cwd;
}

export function claudeProjectDirName(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return encoded.length <= PROJECT_DIR_ENCODE_MAX ? encoded : `${encoded.slice(0, PROJECT_DIR_ENCODE_MAX)}-${projectDirNameHash(cwd)}`;
}

export function claudeSettingsFiles(projectDir?: string, configDir: string = claudeConfigDir()): string[] {
  const directory = projectDir === undefined ? configDir : join(projectDir, ".claude");
  return [join(directory, "settings.json"), ...(projectDir === undefined ? [] : [join(directory, "settings.local.json")])];
}

export interface SanitizedClaudeEnv {
  env: Record<string, string | undefined>;
  removed: string[];
  nested: boolean;
}

export function envNameKey(key: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

export function envKeysOf(env: Readonly<Record<string, unknown>>, name: string, platform: NodeJS.Platform = process.platform): string[] {
  return Object.keys(env).filter((key) => envNameKey(key, platform) === name);
}

export function envValueOf<T>(env: Readonly<Record<string, T>>, name: string, platform: NodeJS.Platform = process.platform): T | undefined {
  const key = envKeysOf(env, name, platform)[0];
  return key === undefined ? undefined : env[key];
}

let hostTelemetryEnabled: () => boolean = () => true;

export function setHostTelemetrySource(source: () => boolean): void {
  hostTelemetryEnabled = source;
}

export function telemetryOptOutNeeded(env: Readonly<Record<string, unknown>>, telemetryEnabled: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return !telemetryEnabled && envKeysOf(env, "DISABLE_TELEMETRY", platform).length === 0;
}

export function claudeTelemetryDisabled(
  env: Readonly<Record<string, unknown>>,
  telemetryEnabled: boolean,
  settingsEnv: Readonly<Record<string, unknown>> | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  const value = configuredEnvValue(env, settingsEnv, "DISABLE_TELEMETRY", platform);
  if (value === undefined) return telemetryOptOutNeeded(env, telemetryEnabled, platform);
  return value !== null && String(value) !== "";
}

export function hostClaudeTelemetryDisabled(settingsEnv: Readonly<Record<string, unknown>> | undefined): boolean {
  return claudeTelemetryDisabled(process.env, hostTelemetryEnabled(), settingsEnv);
}

export function settingsEnvObject(env: unknown): Record<string, unknown> {
  return typeof env === "object" && env !== null && !Array.isArray(env) ? env as Record<string, unknown> : {};
}

function configuredEnvValue(
  source: Readonly<Record<string, unknown>>,
  settingsEnv: Readonly<Record<string, unknown>> | undefined,
  name: string,
  platform: NodeJS.Platform
): unknown {
  const configured = settingsEnv === undefined ? undefined : envValueOf(settingsEnv, name, platform);
  return configured !== undefined ? configured : envValueOf(source, name, platform);
}

export const WINDOWS_DEFAULT_LOCALE = "C.UTF-8";

export function withWindowsDefaultLocale(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): Record<string, string | undefined> {
  const isSet = (name: string) => !!envValueOf(env, name, platform);
  if (platform !== "win32" || isSet("LANG") || isSet("LC_ALL")) return { ...env };
  return { ...env, [envKeysOf(env, "LANG", platform)[0] ?? "LANG"]: WINDOWS_DEFAULT_LOCALE };
}

export type ChildEnvTarget = "claudeCli" | "externalCli";

export interface ChildEnvMode {
  target: ChildEnvTarget;
  nested: boolean;
  apiKeyPolicy: ApiKeyPolicy;
}

export const NESTED_SESSION_MARKERS: readonly string[] = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SSE_PORT"];

const MCP_AUTO_BACKGROUND_ENV: Readonly<Record<string, string>> = {
  CLAUDE_AUTO_BACKGROUND_TASKS: "true",
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "1000",
};

export const LAISORA_OWNED_ENV: ReadonlySet<string> = new Set(Object.keys(MCP_AUTO_BACKGROUND_ENV));

export const CLAUDE_SESSION_ENV: ReadonlySet<string> = new Set([...NESTED_SESSION_MARKERS, "AI_AGENT", "CLAUDE_PID", "CLAUDE_EFFORT"]);

export { SKIP_PROMPT_HISTORY_ENV };

export const TRANSCRIPT_WRITE_ENV: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_CODE_TRANSCRIPT_LOCAL_GC",
]);

const CLAUDE_CODE_ENV_PREFIX = "CLAUDE_CODE_";

export function isNestedSessionEnv(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): boolean {
  return NESTED_SESSION_MARKERS.some((name) => !!envValueOf(env, name, platform));
}

const CLI_TRUTHY_ENV_VALUES = ["1", "true", "yes", "on"];

export function cliEnvTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return !!value && CLI_TRUTHY_ENV_VALUES.includes(String(value).toLowerCase().trim());
}

export function transcriptWriteForbidden(
  source: Readonly<Record<string, string | undefined>>,
  settingsEnv: Readonly<Record<string, unknown>> | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  return cliEnvTruthy(configuredEnvValue(source, settingsEnv, SKIP_PROMPT_HISTORY_ENV, platform));
}

export function passesUserClaudeCodeEnv(mode: ChildEnvMode): boolean {
  return mode.target === "claudeCli" && !mode.nested && mode.apiKeyPolicy === "inherit";
}

export function childEnvRemoves(name: string, value: string | undefined, mode: ChildEnvMode): boolean {
  if (name === "ANTHROPIC_API_KEY") return mode.apiKeyPolicy === "subscriptionOnly";
  if (CLAUDE_SESSION_ENV.has(name) || LAISORA_OWNED_ENV.has(name) || TRANSCRIPT_WRITE_ENV.has(name)) return true;
  if (name === "CLAUDE_CONFIG_DIR") return value === "";
  return name.startsWith(CLAUDE_CODE_ENV_PREFIX) && !passesUserClaudeCodeEnv(mode);
}

export function buildClaudeEnv(
  source: Readonly<NodeJS.ProcessEnv>,
  target: ChildEnvTarget,
  apiKeyPolicy: ApiKeyPolicy = "subscriptionOnly",
  mcpAutoBackground = false
): SanitizedClaudeEnv {
  const env = withWindowsDefaultLocale(source);
  const mode: ChildEnvMode = { target, nested: isNestedSessionEnv(env), apiKeyPolicy };
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    const name = envNameKey(key);
    if (childEnvRemoves(name, env[key], mode)) {
      delete env[key];
      if (!removed.includes(name)) removed.push(name);
    }
  }
  if (telemetryOptOutNeeded(env, hostTelemetryEnabled())) env.DISABLE_TELEMETRY = "1";
  if (mcpAutoBackground) Object.assign(env, MCP_AUTO_BACKGROUND_ENV);
  return {
    env,
    removed,
    nested: mode.nested,
  };
}

export function describeSdkErrorResult(
  prefix: string,
  message: { api_error_status?: number | null; terminal_reason?: string }
): string {
  const status = message.api_error_status;
  return `${prefix}: sdk returned an error result${typeof status === "number" ? ` (api_error_status ${status})` : ""}`;
}
