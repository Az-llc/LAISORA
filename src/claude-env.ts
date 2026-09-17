// 子の Claude Code へ渡す env はここでだけ作る（第2実装を作らない: 片方だけ更新すると
// その経路だけ防護が外れる。W4 H-3）。入れ子実行フラグが残ると子が「自分は Claude Code
// の中にいる」と誤認するので常に除去する。ANTHROPIC_API_KEY は apiKeyPolicy に従う:
// "inherit" は Claude Code 自身の優先順位（環境の API キーを使い API 課金）に任せ、
// "subscriptionOnly" は除去してサブスク認証へ寄せる。policy 未指定の呼び出しは除去側に
// 倒す。inherit へ倒すと、通知を出す経路の無い子が黙って API 課金へ切り替わる。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyPolicy } from "./protocol";

// Claude Code keeps projects/, settings.json, CLAUDE.md, rules/, agents/ under CLAUDE_CONFIG_DIR when it is set.
// Read per call: the value can change within the process and the harnesses swap HOME at runtime.
export function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return (configured ? configured : join(homedir(), ".claude")).normalize("NFC");
}

export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

// Claude Code prefers a legacy <config dir>/.config.json; otherwise .claude.json sits in CLAUDE_CONFIG_DIR, or in the home dir when unset.
export function claudeGlobalConfigFile(): string {
  const legacy = join(claudeConfigDir(), ".config.json");
  if (existsSync(legacy)) return legacy;
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return join(configured ? configured : homedir(), ".claude.json");
}

export interface SanitizedClaudeEnv {
  env: Record<string, string | undefined>;
  removed: string[];
}

// Windows の子プロセスは env 名を大小無視で読む。POSIX では別の変数なので畳まない
export function envNameKey(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

export function buildClaudeEnv(
  source: Readonly<NodeJS.ProcessEnv>,
  apiKeyPolicy: ApiKeyPolicy = "subscriptionOnly"
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
      name.startsWith("CLAUDE_CODE_") ||
      name === "CLAUDE_PID" ||
      name === "CLAUDE_EFFORT" ||
      // The CLI treats "" as a cwd-relative config dir; LAISORA (claudeConfigDir) reads ~/.claude, so drop it.
      (name === "CLAUDE_CONFIG_DIR" && env[key] === "")
    ) {
      delete env[key];
      if (!removed.includes(name)) removed.push(name);
    }
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
