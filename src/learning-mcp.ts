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
  "The LAISORA learning ledger is only for reusable findings about LLM models and how to orchestrate, execute, or verify work with LLM tools across projects. It is not a project knowledge base.",
  "Record model characteristics as modelProfile. Record model-specific behavior or orchestration findings as candidate with binding model; record model-independent LLM orchestration, tool-execution, or verification findings as candidate with binding general and no model. Always include a source and date. A recorded candidate is not an adopted rule.",
  "A candidate becomes active automatically only after it recurs in two different projects.",
  "Do not record facts or instructions specific to a company, customer, repository, application, or task, including architecture, business rules, dependencies, deployment commands, local setup, or work status. Removing names or paths does not make project knowledge reusable. Environment means the LLM executor's operating constraints, not this project's setup.",
  "Use subject llm-orchestration only when the finding remains meaningful in unrelated projects under the stated model, tool, version, or executor conditions. Project or uncertain subjects are rejected; when unsure, do not call the record tool.",
  "Keep project knowledge in the project's CLAUDE.md, .claude/rules, project-scoped Claude Code auto-memory where available, or project documentation, following project conventions and write permissions. If no destination is authorized, suggest one without writing. Do not copy project details into the ledger as evidence or examples.",
  "Use opaque references for private evidence and identifiers; do not include project names, private URLs, paths, credentials, or copied private text in any field. Record only the reusable finding and its necessary applicability limits; do not overgeneralize a single observation.",
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
  kind: field("\"candidate\" for a reusable LLM orchestration finding, or \"modelProfile\" for model characteristics; neither accepts project knowledge"),
  subject: field("Required for both kinds: \"llm-orchestration\", \"project\", or \"uncertain\". Only \"llm-orchestration\" is eligible. Choose \"project\" for company, customer, repository, application, or task knowledge; choose \"uncertain\" if the boundary is unclear. This declaration does not prove eligibility."),
  requestId: field("Opaque id for this record request; reuse only to retry identical input. Do not encode project names or private content"),
  domain: field("candidate: \"orchestration\", \"tools\", \"environment\", \"verification\", or \"other\", all limited to reusable work with LLMs. \"environment\" means LLM executor constraints, not project setup; \"other\" does not permit project knowledge"),
  binding: field("candidate: \"model\" when behavior depends on a model; \"general\" when model-independent, with no model field. \"general\" does not mean project-wide and does not authorize sharing across workspaces"),
  model: field("candidate with binding model, or modelProfile: resolved model id"),
  ruleId: field("candidate: opaque rule id without company, project, or customer names or private content"),
  text: field("candidate: one reusable finding in a single line, at most 500 Unicode code points. State relevant model, tool, version, or executor conditions. Exclude company/project facts, private text, paths, and credentials, even when used as examples"),
  sourceAt: field("candidate: ISO 8601 UTC date of the source"),
  source: field("candidate: {\"url\":\"https://...\"} for a public source without private identifiers, query, or fragment, or {\"ref\":\"<existing record id>\"} for opaque evidence. Do not include evidence text or private project URLs"),
  evidence: field("candidate: {sessions, observations, recurrences} arrays of ids"),
  expectHash: field("candidate: current text hash when changing an existing rule"),
  executor: field('modelProfile: "claude", "codex" or "agy"'),
  sources: field("modelProfile: 1-3 {url, checkedAt} entries for public model-information sources; no private project URLs or identifiers"),
  strengths: field("modelProfile: not delivered to the conductor; leave unset"),
  effort: field("modelProfile: effort behavior that changes delegation (default, supported values, quality, latency or token change across efforts), one line, at most 120 Unicode code points; no project-specific configuration"),
  caveats: field("modelProfile: model limitations or behaviors that change prompting, timeouts or verification, with relevant conditions, one line, at most 120 Unicode code points; no project facts or private examples"),
});

export function createLearningMcpServer(sdk: Pick<typeof Sdk, "createSdkMcpServer" | "tool">, gate: LearningRootGate,
  record: (input: unknown, rootVerified: boolean) => Promise<LearningResult>) {
  return sdk.createSdkMcpServer({ name: "laisora_learning", tools: [sdk.tool("record",
    "Record a reusable LLM model characteristic or a finding about orchestrating, executing, or verifying work with LLM tools across projects, with a source and date. This is not project memory: company, customer, repository, application, and task knowledge is out of scope. Use the project's own memory or documentation for that content. Project and uncertain subjects are rejected. Candidates are not adopted rules. Only the verified root conversation may request a record.",
    RECORD_INPUT as unknown as Record<string, z.ZodType>,
    async (input, extra) => learningToolReply(await record(input, gate.consume(extra))))] });
}
