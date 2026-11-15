import type { Options as ClaudeCodeOptions } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { buildClaudeEnv } from "./claude-env";
import type { ApiKeyPolicy } from "./protocol";

export function loadSdkQuery(): Pick<typeof ClaudeCodeSdk, "query"> {
  return require("@anthropic-ai/claude-agent-sdk") as typeof ClaudeCodeSdk;
}

export function toolFreeQueryOptions(cwd: string, apiKeyPolicy: ApiKeyPolicy | undefined, abortController: AbortController, maxTurns: number): ClaudeCodeOptions {
  return {
    tools: [],
    allowedTools: [],
    permissionMode: "default",
    persistSession: false,
    settingSources: [],
    maxTurns,
    cwd,
    env: buildClaudeEnv(process.env, "claudeCli", apiKeyPolicy).env,
    abortController,
  };
}
