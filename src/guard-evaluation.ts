import type { HookJSONOutput } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

export async function failClosedGuard(judge: () => HookJSONOutput | Promise<HookJSONOutput>, log: (message: string) => void): Promise<HookJSONOutput> {
  try { return await judge(); }
  catch (error) {
    const reason = "LAISORA guard failed to evaluate the call.";
    try { log(`${reason} ${String(error)}`); } catch {}
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  }
}
