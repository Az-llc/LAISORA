import { EXECUTORS, isExternalExecutorId, type ExternalExecutorId } from "./orchestration-executors";
import type { AgentRunRecord, TokenUsage } from "./orchestration-external";
import { orchestrationVariants, type ExternalRow, type OrchestrationRow } from "./orchestration-roster";
import type { ClaudeConversation, ClaudeHostOptions } from "./claudeHost";
import type { RosterEvidence } from "./roster-evidence";

export interface OrchestrationView {
  roster: {
    agents: Array<{ role: string; agentKey: string; model: string; effort: string | null; efforts: string[] }>;
    external: Array<{ role: string; executor: ExternalExecutorId; model: string | null; effort: string | null }>;
  };
  settingsChanged: boolean;
  agents: Array<{ agentId: string; role: string | null; agentType: string | null; model: string | null; effort: string | null;
    firstSeenAt: string; lastActivityAt: string; usage: TokenUsage | null }>;
}

export type AgentRoleOf = (agent: { agentType?: string; transcriptAgentId?: string; startedAt?: number }) => string | null;

export function orchestrationViewForConversation(conv: ClaudeConversation, current: Partial<ClaudeHostOptions>, roleOf: AgentRoleOf = (agent) => conv.attributedRole(agent)): OrchestrationView | undefined {
  if (!conv.orchestrationActive) return undefined;
  return projectOrchestrationView(conv.orchestrationRoster, conv.orchestrationExternalRoster,
    conv.orchestrationSettingsChanged(current), conv.observedAgentSettings, conv.observedAgentRuns,
    true, roleOf, conv.orchestrationAgentVariants);
}

export function orchestrationViewFromStartingRoster(evidence: RosterEvidence): OrchestrationView | undefined {
  const injection = evidence.injections.at(-1);
  if (injection === undefined || injection.agents.length === 0) return undefined;
  const variants = new Map<string, OrchestrationVariantView>();
  for (const agent of injection.agents) {
    const variant = variants.get(agent.agentKey) ?? { role: agent.role, agentKey: agent.agentKey, model: agent.model, efforts: [] };
    if (agent.effort !== null && !variant.efforts.includes(agent.effort)) variant.efforts.push(agent.effort);
    variant.effort ??= agent.effort ?? undefined;
    variants.set(agent.agentKey, variant);
  }
  return projectOrchestrationView([], [], false, new Map(), new Map(), injection.perCallEffort === true, () => null, [...variants.values()]);
}

interface OrchestrationVariantView { role: string; agentKey: string; model: string; effort?: string; efforts: string[] }

const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens",
  "cache_read_input_tokens", "cache_creation_input_tokens", "total_tokens", "thinking_tokens", "cache_read_tokens"];

function metadata(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(value);
}

function observed(value: unknown): string | null { return metadata(value) ? value : null; }

function usageView(usage: TokenUsage | undefined): TokenUsage | null {
  const entries = Object.entries(usage ?? {}).filter(([key, value]) => USAGE_KEYS.includes(key) && finite(value));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function projectOrchestrationView(
  roster: readonly OrchestrationRow[], external: readonly ExternalRow[], settingsChanged: boolean,
  settings: ReadonlyMap<string, Readonly<{ agentType?: string; model?: string; effort?: string }>>,
  agents: ReadonlyMap<string, AgentRunRecord>, perCallEffort = false,
  roleOf: AgentRoleOf = () => null, variants: readonly OrchestrationVariantView[] = orchestrationVariants(roster)
): OrchestrationView {
  return {
    roster: {
      agents: variants.map(({ role, agentKey, model, effort, efforts }) => ({ role, agentKey, model, effort: effort ?? null,
        efforts: perCallEffort ? [...efforts] : effort ? [effort] : [] })),
      external: external.map(({ role, executor, model, effort }) => ({ role, executor, model: observed(model), effort: effort ?? null })),
    },
    settingsChanged,
    agents: [...agents.values()].map((agent) => {
      const applied = settings.get(agent.agent_id);
      const agentType = observed(applied?.agentType);
      return { agentId: observed(agent.agent_id) ?? "unknown", agentType,
        role: roleOf({ agentType: agentType ?? undefined, transcriptAgentId: agent.agent_id, startedAt: Date.parse(agent.firstSeenAt) }),
        model: observed(applied?.model), effort: observed(applied?.effort),
        firstSeenAt: agent.firstSeenAt, lastActivityAt: agent.lastActivityAt, usage: usageView(agent.usage) };
    }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, 50),
  };
}

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
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
  if (!object(value, ["roster", "settingsChanged", "agents"])) return false;
  return (
    typeof value.settingsChanged === "boolean" &&
    isOrchestrationRosterView(value.roster) &&
    Array.isArray(value.agents) &&
    value.agents.every(isOrchestrationAgentView)
  );
}

export class OrchestrationViewPublisher {
  private lastPost = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly read: () => OrchestrationView | undefined, private readonly post: (view: OrchestrationView) => void) {}

  schedule(): void {
    if (this.timer !== undefined) return;
    const delay = Math.max(0, 500 - (Date.now() - this.lastPost));
    if (delay === 0) this.flush();
    else this.timer = setTimeout(() => { this.timer = undefined; this.schedule(); }, delay);
  }

  private flush(): void {
    const view = this.read();
    if (view === undefined) return;
    this.lastPost = Date.now();
    this.post(view);
  }
}

function isOrchestrationRosterView(value: unknown): boolean {
  if (!object(value, ["agents", "external"])) return false;
  return (
    Array.isArray(value.agents) &&
    value.agents.every(isOrchestrationRosterAgent) &&
    Array.isArray(value.external) &&
    value.external.every(isOrchestrationRosterExternal)
  );
}

function isOrchestrationRosterAgent(value: unknown): boolean {
  if (!object(value, ["role", "agentKey", "model", "effort", "efforts"])) return false;
  return (
    metadata(value.role) &&
    Array.isArray(value.efforts) &&
    value.efforts.length <= 6 &&
    value.efforts.every(metadata) &&
    metadata(value.model) &&
    nullableMetadata(value.effort) &&
    [EXECUTORS.claude.targetKey(value.role as string, value.model as string), ...(typeof value.effort === "string" ? [EXECUTORS.claude.targetKey(value.role as string, value.model as string, value.effort)] : [])].includes(value.agentKey as string)
  );
}

function isOrchestrationRosterExternal(value: unknown): boolean {
  if (!object(value, ["role", "executor", "model", "effort"])) return false;
  return (
    metadata(value.role) &&
    executor(value.executor) &&
    nullableMetadata(value.model) &&
    nullableMetadata(value.effort)
  );
}

function isOrchestrationAgentView(value: unknown): boolean {
  if (!object(value, ["agentId", "role", "agentType", "model", "effort", "firstSeenAt", "lastActivityAt", "usage"])) return false;
  return (
    metadata(value.agentId) &&
    nullableMetadata(value.role) &&
    nullableMetadata(value.agentType) &&
    nullableMetadata(value.model) &&
    nullableMetadata(value.effort) &&
    isoTimestampShape(value.firstSeenAt) &&
    isoTimestampShape(value.lastActivityAt) &&
    usageShape(value.usage)
  );
}
