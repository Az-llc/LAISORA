import { z } from "zod";
import type * as Sdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type { LearningResult } from "./learning-service";

export const LEARNING_TOOL_NAME = "mcp__laisora_learning__record";
const TOOL_USE_META_KEY = "claudecode/toolUseId";
const CALLER_UNVERIFIED: LearningResult = { ok: false, code: "caller-unverified", requirement: "R-LRN-12" };
const ROOT_MARK_TTL_MS = 5 * 60_000;
const ROOT_MARK_HOLD_MS = 30 * 60_000;
const ROOT_MARK_CAP = 32;

export const LEARNING_INSTRUCTION = [
  "Use mcp__laisora_learning__record for learning findings, always with a source and date.",
  "Record model-specific findings as candidate with binding model; model-independent findings about environment, tools, or verification with binding general (no model).",
  "Record model characteristics as modelProfile. A recorded candidate is not an adopted rule.",
].join("\n");

export function learningToolReply(result: LearningResult) {
  return { ...(!result.ok ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

// R-LRN-12: a call is root only when this PreToolUse hook saw it without agent_id and marked its tool_use_id, and the
// handler receives that id in the CLI-set _meta. No hook, no id or no _meta must stay caller-unverified.
export class LearningRootGate {
  private readonly marks = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  readonly hook: Sdk.HookCallback = async (input) => {
    const value = input as unknown as Record<string, unknown>;
    if (value.tool_name !== LEARNING_TOOL_NAME) return {};
    if (value.hook_event_name !== "PreToolUse") { this.revoke(value.tool_use_id); return {}; }
    if (value.agent_id !== undefined) {
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const,
        permissionDecisionReason: JSON.stringify(CALLER_UNVERIFIED) } };
    }
    if (typeof value.tool_use_id === "string" && value.tool_use_id) this.mark(value.tool_use_id);
    return {};
  };

  private mark(id: string): void {
    for (const [key, expiry] of this.marks) if (expiry <= this.now()) this.marks.delete(key);
    this.marks.delete(id);
    this.marks.set(id, this.now() + ROOT_MARK_TTL_MS);
    for (const key of this.marks.keys()) {
      if (this.marks.size <= ROOT_MARK_CAP) break;
      this.marks.delete(key);
    }
  }

  private live(id: string): boolean {
    const expiry = this.marks.get(id);
    if (expiry !== undefined && expiry > this.now()) return true;
    this.marks.delete(id);
    return false;
  }

  hold(id: unknown): void { if (typeof id === "string" && this.live(id)) this.marks.set(id, this.now() + ROOT_MARK_HOLD_MS); }
  release(id: unknown): void { if (typeof id === "string" && this.live(id)) this.marks.set(id, this.now() + ROOT_MARK_TTL_MS); }
  revoke(id: unknown): void { if (typeof id === "string") this.marks.delete(id); }
  clear(): void { this.marks.clear(); }

  consume(extra: unknown): boolean {
    const meta = extra && typeof extra === "object" ? (extra as { _meta?: unknown })._meta : undefined;
    const id = meta && typeof meta === "object" ? (meta as Record<string, unknown>)[TOOL_USE_META_KEY] : undefined;
    if (typeof id !== "string" || !this.live(id)) return false;
    this.marks.delete(id);
    return true;
  }
}

const field = (description: string) => z.unknown().optional().describe(description);
// R-LRN-06: SDK schema errors echo unrecognized keys, so every field is unknown and unknown keys pass through to
// validateLearningInput, which answers with fixed codes only.
const RECORD_INPUT = z.looseObject({
  kind: field('"candidate" or "modelProfile"'),
  requestId: field("Id for this record request; reuse it only to retry the same input"),
  domain: field('candidate: "orchestration", "tools", "environment", "verification" or "other"'),
  binding: field('candidate: "model" for a model-specific finding, "general" for a model-independent one (no model)'),
  model: field("candidate with binding model, or modelProfile: resolved model id"),
  ruleId: field("candidate: rule id"),
  text: field("candidate: one-line finding, at most 500 characters, without paths or credentials"),
  sourceAt: field("candidate: ISO 8601 UTC date of the source"),
  source: field('candidate: {"url": "https://..."} or {"ref": "<existing record id>"}'),
  evidence: field("candidate: {sessions, observations, recurrences} arrays of ids"),
  expectHash: field("candidate: current text hash when changing an existing rule"),
  executor: field('modelProfile: "claude", "codex" or "agy"'),
  sources: field("modelProfile: 1-3 {url, checkedAt} entries"),
  strengths: field("modelProfile: one line"),
  effort: field("modelProfile: one line"),
  caveats: field("modelProfile: one line"),
});

export function createLearningMcpServer(sdk: Pick<typeof Sdk, "createSdkMcpServer" | "tool">, gate: LearningRootGate,
  record: (input: unknown, rootVerified: boolean) => Promise<LearningResult>) {
  return sdk.createSdkMcpServer({ name: "laisora_learning", tools: [sdk.tool("record",
    "Record a candidate finding or model profile with source and date. Candidates are not adopted rules. Only the root conversation may write.",
    RECORD_INPUT as unknown as Record<string, z.ZodType>,
    async (input, extra) => learningToolReply(await record(input, gate.consume(extra))))] });
}
