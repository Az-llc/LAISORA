import { isExternalExecutorId, type ExternalExecutorId } from "./orchestration-executors";
import type { AgentRunRecord, ExternalRunRecord, TokenUsage } from "./orchestration-external";
import { orchestrationVariants, type ExternalRow, type OrchestrationRow } from "./orchestration-roster";
import type { ClaudeConversation, ClaudeHostOptions } from "./claudeHost";

export interface OrchestrationView {
  roster: {
    agents: Array<{ role: string; agentKey: string; model: string; effort: string | null }>;
    external: Array<{ role: string; executor: ExternalExecutorId; model: string | null; effort: string | null }>;
  };
  settingsChanged: boolean;
  agents: Array<{ agentId: string; role: string | null; agentType: string | null; model: string | null; effort: string | null;
    firstSeenAt: string; lastActivityAt: string; usage: TokenUsage | null }>;
  runs: Array<{ role: string; executor: ExternalExecutorId; model?: string; effort?: string; outcome: ExternalRunRecord["outcome"];
    startedAt: string; endedAt: string; durationMs: number; usage: TokenUsage | null }>;
}

export function orchestrationViewForConversation(conv: ClaudeConversation, current: Partial<ClaudeHostOptions>): OrchestrationView | undefined {
  if (!conv.orchestrationActive) return undefined; // R-ORC-01
  return projectOrchestrationView(conv.orchestrationRoster, conv.orchestrationExternalRoster,
    conv.orchestrationSettingsChanged(current), conv.observedAgentSettings, conv.observedAgentRuns,
    conv.orchestrationRuns.filter((run) => run.kind === "external"));
}

const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens",
  "cache_read_input_tokens", "cache_creation_input_tokens", "total_tokens", "thinking_tokens", "cache_read_tokens"];

function metadata(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(value); // R-GW-05, R-ORC-14
}

function observed(value: unknown): string | null { return metadata(value) ? value : null; }

function usageView(usage: TokenUsage | undefined): TokenUsage | null {
  const entries = Object.entries(usage ?? {}).filter(([key, value]) => USAGE_KEYS.includes(key) && finite(value));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function projectOrchestrationView(
  roster: readonly OrchestrationRow[], external: readonly ExternalRow[], settingsChanged: boolean,
  settings: ReadonlyMap<string, Readonly<{ agentType?: string; model?: string; effort?: string }>>,
  agents: ReadonlyMap<string, AgentRunRecord>, runs: readonly ExternalRunRecord[]
): OrchestrationView {
  const variants = orchestrationVariants(roster);
  const roleByAgentKey = new Map(variants.map((variant) => [variant.agentKey, variant.role]));
  return {
    roster: {
      agents: variants.map(({ role, agentKey, model, effort }) => ({ role, agentKey, model, effort: effort ?? null })),
      external: external.map(({ role, executor, model, effort }) => ({ role, executor, model: observed(model), effort: effort ?? null })),
    },
    settingsChanged,
    agents: [...agents.values()].map((agent) => {
      const applied = settings.get(agent.agent_id);
      const agentType = observed(applied?.agentType);
      return { agentId: observed(agent.agent_id) ?? "unknown", agentType,
        role: roleByAgentKey.get(agentType ?? "") ?? null, // R-ORC-22
        model: observed(applied?.model), effort: observed(applied?.effort),
        firstSeenAt: agent.firstSeenAt, lastActivityAt: agent.lastActivityAt, usage: usageView(agent.usage) };
    }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, 50), // R-ORC-23
    runs: runs.map(({ role, executor, model, effort, outcome, startedAt, endedAt, durationMs, usage }) =>
      ({ role, executor, ...(metadata(model) ? { model } : {}), ...(metadata(effort) ? { effort } : {}), outcome, startedAt, endedAt, durationMs, usage: usageView(usage) }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50), // R-ORC-23
  };
}

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)); // R-ORC-14
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isoTimestampShape(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function nullableMetadata(value: unknown): boolean { return value === null || metadata(value); }
function usageShape(value: unknown): boolean {
  return value === null || (!!value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).length > 0 && Object.entries(value).every(([key, count]) => USAGE_KEYS.includes(key) && finite(count)));
}
function executor(value: unknown): boolean { return isExternalExecutorId(value); }

export function isOrchestrationView(value: unknown): value is OrchestrationView {
  if (!object(value, ["roster", "settingsChanged", "agents", "runs"]) || typeof value.settingsChanged !== "boolean"
    || !object(value.roster, ["agents", "external"])) return false; // R-ORC-22, R-ORC-14
  return Array.isArray(value.roster.agents) && value.roster.agents.every((row) =>
    object(row, ["role", "agentKey", "model", "effort"]) && metadata(row.role) && row.agentKey === `laisora-${row.role}-${row.model}${row.effort === null ? "" : `-${row.effort}`}`
    && metadata(row.model) && nullableMetadata(row.effort))
    && Array.isArray(value.roster.external) && value.roster.external.every((row) =>
      object(row, ["role", "executor", "model", "effort"]) && metadata(row.role) && executor(row.executor)
      && nullableMetadata(row.model) && nullableMetadata(row.effort))
    && Array.isArray(value.agents) && value.agents.every((row) =>
      object(row, ["agentId", "role", "agentType", "model", "effort", "firstSeenAt", "lastActivityAt", "usage"])
      && metadata(row.agentId) && nullableMetadata(row.role) && nullableMetadata(row.agentType)
      && nullableMetadata(row.model) && nullableMetadata(row.effort) && isoTimestampShape(row.firstSeenAt)
      && isoTimestampShape(row.lastActivityAt) && usageShape(row.usage))
    && Array.isArray(value.runs) && value.runs.every((row) =>
      object(row, ["role", "executor", "outcome", "startedAt", "endedAt", "durationMs", "usage", ...(row?.model === undefined ? [] : ["model"]), ...(row?.effort === undefined ? [] : ["effort"])])
      && (row.model === undefined || metadata(row.model)) && (row.effort === undefined || metadata(row.effort))
      && metadata(row.role) && executor(row.executor) && ["ok", "failed", "timeout", "refused"].includes(row.outcome as string)
      && isoTimestampShape(row.startedAt) && isoTimestampShape(row.endedAt) && finite(row.durationMs) && usageShape(row.usage));
}

export class OrchestrationViewPublisher {
  private lastPost = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly read: () => OrchestrationView | undefined, private readonly post: (view: OrchestrationView) => void) {}

  schedule(): void {
    if (this.timer !== undefined) return; // R-ORC-23
    const delay = Math.max(0, 500 - (Date.now() - this.lastPost));
    if (delay === 0) this.flush();
    else this.timer = setTimeout(() => { this.timer = undefined; this.schedule(); }, delay);
  }

  private flush(): void {
    const view = this.read();
    if (view === undefined) return; // R-ORC-01
    this.lastPost = Date.now();
    this.post(view);
  }
}
