import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-env";

type ClaudeCodeSettings = { model?: string; defaultMode?: string; autoContinueAtUsageLimit?: boolean };

const autoContinueListeners = new Set<() => void>();
export function onAutoContinueSettingChange(listener: () => void): () => void {
  autoContinueListeners.add(listener);
  return () => { autoContinueListeners.delete(listener); };
}

let claudeCodeSettingsCache: ClaudeCodeSettings | null = null;

export function invalidateClaudeCodeSettingsCache(): void {
  claudeCodeSettingsCache = null;
}

function readClaudeCodeSettingsUncached(): ClaudeCodeSettings {
  try {
    const raw = JSON.parse(readFileSync(join(claudeConfigDir(), "settings.json"), "utf8"));
    return {
      autoContinueAtUsageLimit: raw.autoContinueAtUsageLimit !== false,
      model: typeof raw.model === "string" ? raw.model : undefined,
      defaultMode:
        typeof raw.permissions?.defaultMode === "string" ? raw.permissions.defaultMode : undefined,
    };
  } catch {
    return {};
  }
}

export function readClaudeCodeSettings(fresh = false): ClaudeCodeSettings {
  if (fresh) return readClaudeCodeSettingsUncached();
  if (claudeCodeSettingsCache === null) claudeCodeSettingsCache = readClaudeCodeSettingsUncached();
  return claudeCodeSettingsCache;
}

export function notifyAutoContinueSettingChange(): void {
  for (const listener of autoContinueListeners) listener();
}
