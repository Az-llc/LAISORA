import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-env";

type ClaudeCodeSettings = { model?: string; defaultMode?: string; autoContinueAtUsageLimit?: boolean };

const autoContinueListeners = new Set<() => void>();
export function onAutoContinueSettingChange(listener: () => void): () => void {
  autoContinueListeners.add(listener);
  return () => { autoContinueListeners.delete(listener); };
}

// 設定ファイルの読み値はキャッシュする。毎回ファイルを読むとホットリロードになり、
// 別ウィンドウや本体CLIの変更が実行中セッションの表示へ勝手に混ざる（表示と実体の乖離）。
// ユーザー確定方針: ファイルを読むのは拡張起動時と会話開始時だけ。実行中はメモリ値に従う。
let claudeCodeSettingsCache: ClaudeCodeSettings | null = null;

export function invalidateClaudeCodeSettingsCache(): void {
  claudeCodeSettingsCache = null;
}

// ユーザー設定の保存値。上位設定や実行中セッションの実効値ではない。
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
