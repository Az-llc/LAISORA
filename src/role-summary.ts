import * as l10n from "@vscode/l10n";
import type { ExternalRunRecord } from "./orchestration-external";
import { EXECUTORS } from "./orchestration-roster";
import type { WorkAgentNode, WorkPhaseView } from "./protocol";
import { attributeSubagent, type RosterEvidence } from "./roster-evidence";
import { externalTokens } from "./webview/plan-view";

export const ROLE_SHADE_MAX = 3;

export type RoleValueSource = "measured" | "requested";

export interface RoleRunView {
  source: "subagent" | "external";
  name: string;
  executor: string;
  model: string | null;
  modelSource: RoleValueSource | null;
  effort: string | null;
  effortSource: RoleValueSource | null;
  variantLabel: string;
  shade: number;
  startedAt: number | null;
  running: boolean;
  outcome: ExternalRunRecord["outcome"] | null;
  durationMs: number | null;
  tokens: number | null;
  timePercent: number | null;
  tokenPercent: number | null;
}

export interface RoleView {
  role: string | null;
  label: string;
  count: number;
  totalMs: number | null;
  totalMsPartial: boolean;
  totalTokens: number | null;
  totalTokensPartial: boolean;
  running: boolean;
  timeWidthPercent: number | null;
  tokenWidthPercent: number | null;
  runs: RoleRunView[];
}

export interface RoleSummaryView {
  roles: RoleView[];
  omittedSubagentCount: number;
  externalRunsCoverage?: ExternalRunsCoverage;
}

export interface ExternalRunsCoverage {
  unreadableLines: number;
  readError: boolean;
}

interface RunDraft extends Omit<RoleRunView, "shade" | "timePercent" | "tokenPercent" | "variantLabel"> {
  role: string | null;
}

function flattenAgents(nodes: readonly WorkAgentNode[], out: WorkAgentNode[]): void {
  for (const node of nodes) {
    out.push(node);
    flattenAgents(node.children, out);
  }
}

function subagentRun(agent: WorkAgentNode, evidence: RosterEvidence): RunDraft {
  const attributed = attributeSubagent(evidence, agent);
  const variant = attributed?.definition;
  const measuredModel = agent.modelMeasured ?? attributed?.start?.model;
  const measuredEffort = agent.effortMeasured ?? attributed?.start?.effort;
  const requestedModel = agent.modelDeclared ?? variant?.model ?? null;
  const requestedEffort = agent.effortDeclared ?? variant?.effort ?? null;
  const finished = agent.origin === "live" && (agent.status === "completed" || agent.status === "failed");
  return {
    role: variant?.role ?? null,
    source: "subagent",
    name: agent.agentType ?? agent.description,
    executor: "claude",
    model: measuredModel ?? requestedModel,
    modelSource: measuredModel !== undefined ? "measured" : requestedModel !== null ? "requested" : null,
    effort: measuredEffort ?? requestedEffort,
    effortSource: measuredEffort !== undefined ? "measured" : requestedEffort !== null ? "requested" : null,
    startedAt: agent.startedAt ?? null,
    running: agent.status === "running",
    outcome: null,
    durationMs: finished ? agent.elapsedMs : null,
    tokens: agent.tokens ?? null,
  };
}

function externalRun(run: ExternalRunRecord): RunDraft {
  const definition = EXECUTORS[run.executor];
  const startedAt = Date.parse(run.startedAt);
  const tokens = externalTokens(run.usage ?? null);
  return {
    role: run.role,
    source: "external",
    name: run.model !== undefined && (run.effort !== undefined || run.executor !== "codex")
      ? definition.targetKey(run.role, run.model, run.effort)
      : `${run.role}/${run.executor}`,
    executor: run.executor,
    model: run.model ?? null,
    modelSource: run.model !== undefined ? "requested" : null,
    effort: run.effort ?? null,
    effortSource: run.effort !== undefined ? "requested" : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    running: false,
    outcome: run.outcome,
    durationMs: Number.isFinite(run.durationMs) && run.durationMs >= 0 ? run.durationMs : null,
    tokens: tokens?.tokens ?? null,
  };
}

function sumOf(values: readonly (number | null)[]): { total: number | null; partial: boolean } {
  let total: number | null = null;
  let partial = false;
  for (const v of values) {
    if (v === null) partial = true;
    else total = (total ?? 0) + v;
  }
  return { total, partial };
}

const percentOf = (part: number | null, whole: number | null): number | null =>
  part === null || whole === null || whole <= 0 ? null : (part / whole) * 100;

const byStart = (a: { startedAt: number | null }, b: { startedAt: number | null }): number =>
  a.startedAt === null ? (b.startedAt === null ? 0 : 1) : b.startedAt === null ? -1 : a.startedAt - b.startedAt;

export function deriveRoleSummary(input: {
  phases: readonly WorkPhaseView[];
  unlinkedAgents: readonly WorkAgentNode[];
  externalRuns: readonly ExternalRunRecord[];
  rosterEvidence: RosterEvidence;
  externalRunsCoverage?: ExternalRunsCoverage;
}): RoleSummaryView {
  const agents: WorkAgentNode[] = [];
  let rollupAgentCount = 0;
  for (const phase of input.phases) {
    if (phase.kind === "rollup") rollupAgentCount += phase.agentCount;
    flattenAgents(phase.agents, agents);
  }
  flattenAgents(input.unlinkedAgents, agents);
  const recoveredCount = agents.filter((a) => a.origin === "restored").length;
  const omittedSubagentCount = Math.max(0, rollupAgentCount - recoveredCount);
  const drafts: RunDraft[] = [
    ...agents.map((a) => subagentRun(a, input.rosterEvidence)),
    ...input.externalRuns.map(externalRun),
  ].sort(byStart);

  const groups = new Map<string | null, RunDraft[]>();
  for (const d of drafts) {
    const list = groups.get(d.role) ?? [];
    list.push(d);
    groups.set(d.role, list);
  }
  const roles: RoleView[] = [...groups].map(([role, list]) => {
    const time = sumOf(list.map((r) => r.durationMs));
    const tokens = sumOf(list.map((r) => r.tokens));
    const shades: string[] = [];
    const runs: RoleRunView[] = list.map(({ role: _role, ...r }) => {
      const key = `${r.executor}\u0000${r.model ?? ""}\u0000${r.effort ?? ""}`;
      if (!shades.includes(key)) shades.push(key);
      return {
        ...r,
        variantLabel: [r.executor, r.model, r.effort].filter((v): v is string => v !== null).join(" · "),
        shade: Math.min(shades.indexOf(key), ROLE_SHADE_MAX),
        timePercent: percentOf(r.durationMs, time.total),
        tokenPercent: percentOf(r.tokens, tokens.total),
      };
    });
    return {
      role,
      label: role ?? l10n.t("other"),
      count: runs.length,
      totalMs: time.total,
      totalMsPartial: time.partial,
      totalTokens: tokens.total,
      totalTokensPartial: tokens.partial,
      running: list.some((r) => r.running),
      timeWidthPercent: null,
      tokenWidthPercent: null,
      runs,
    };
  });
  const maxMs = Math.max(0, ...roles.map((r) => r.totalMs ?? 0));
  const maxTokens = Math.max(0, ...roles.map((r) => r.totalTokens ?? 0));
  for (const r of roles) {
    r.timeWidthPercent = percentOf(r.totalMs, maxMs);
    r.tokenWidthPercent = percentOf(r.totalTokens, maxTokens);
  }
  const coverage = input.externalRunsCoverage;
  return coverage !== undefined && (coverage.unreadableLines > 0 || coverage.readError)
    ? { roles, omittedSubagentCount, externalRunsCoverage: { unreadableLines: coverage.unreadableLines, readError: coverage.readError } }
    : { roles, omittedSubagentCount };
}
