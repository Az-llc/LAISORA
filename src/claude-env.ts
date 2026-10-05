import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyPolicy } from "./protocol";

export function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return (configured ? configured : join(homedir(), ".claude")).normalize("NFC");
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

export function envNameKey(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
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
