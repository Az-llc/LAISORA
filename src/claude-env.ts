import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyPolicy } from "./protocol";

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

export function claudeSettingsFiles(projectDir?: string): string[] {
  const directory = projectDir === undefined ? claudeConfigDir() : join(projectDir, ".claude");
  return [join(directory, "settings.json"), ...(projectDir === undefined ? [] : [join(directory, "settings.local.json")])];
}

export interface SanitizedClaudeEnv {
  env: Record<string, string | undefined>;
  removed: string[];
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

export function buildClaudeEnv(
  source: Readonly<NodeJS.ProcessEnv>,
  apiKeyPolicy: ApiKeyPolicy = "subscriptionOnly",
  mcpAutoBackground = false
): SanitizedClaudeEnv {
  const env: Record<string, string | undefined> = { ...source };
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    const name = envNameKey(key);
    if (name === "ANTHROPIC_API_KEY" && apiKeyPolicy === "inherit") continue;
    if (
      name === "ANTHROPIC_API_KEY" ||
      name === "CLAUDECODE" ||
      name === "AI_AGENT" ||
      name === "CLAUDE_AUTO_BACKGROUND_TASKS" ||
      name.startsWith("CLAUDE_CODE_") ||
      name === "CLAUDE_PID" ||
      name === "CLAUDE_EFFORT" ||
      (name === "CLAUDE_CONFIG_DIR" && env[key] === "")
    ) {
      delete env[key];
      if (!removed.includes(name)) removed.push(name);
    }
  }
  if (telemetryOptOutNeeded(env, hostTelemetryEnabled())) env.DISABLE_TELEMETRY = "1";
  if (mcpAutoBackground) {
    env.CLAUDE_AUTO_BACKGROUND_TASKS = "true";
    env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = "1000";
  }
  return {
    env,
    removed,
  };
}

export function describeSdkErrorResult(
  prefix: string,
  message: { api_error_status?: number | null; terminal_reason?: string }
): string {
  const status = message.api_error_status;
  return `${prefix}: sdk returned an error result${typeof status === "number" ? ` (api_error_status ${status})` : ""}`;
}
