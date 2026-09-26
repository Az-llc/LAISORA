// メインの処理は入れない。役割は実行時に記録されたものを使い、今の設定で付け替えない（R-ANL-23）。
// サブエージェントの役割の根拠は、LAISORA が注入した役割表の記録（src/roster-evidence.ts）だけ。
// agentKey の形をした名前から役割を組み立てない: 利用者が同じ形の名前で作ったエージェントにも役割が付く。
// 開始時点で有効な記録に無い委任（記録の無い過去のセッション・役割表に無い名前）は role=null。名前の語から役割を推し量らない（R-DSP-01）
import * as l10n from "@vscode/l10n";
import type { ExternalRunRecord } from "./orchestration-external";
import { EXECUTORS } from "./orchestration-roster";
import type { WorkAgentNode, WorkPhaseView } from "./protocol";
import { attributeSubagent, type RosterEvidence } from "./roster-evidence";
import { externalTokens } from "./webview/plan-view";

// shade は役割内で executor·model·effort の組が初めて現れた順。これ以上は同じ値に畳む
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
  // null = 測れていない（実行中・終了を観測していない・記録から復元しただけ・使用量の記録が無い）。0 にしない（R-DSP-11）
  durationMs: number | null;
  tokens: number | null;
  // 役割の合計に対する百分率（区切りの幅）。自分か合計が null なら null
  timePercent: number | null;
  tokenPercent: number | null;
}

export interface RoleView {
  role: string | null;
  label: string;
  count: number;
  // null = どの実行も測れていない。partial = 測れていない実行を含む
  totalMs: number | null;
  totalMsPartial: boolean;
  totalTokens: number | null;
  totalTokensPartial: boolean;
  running: boolean;
  // 役割の中で最大の合計に対する百分率（棒の長さ）
  timeWidthPercent: number | null;
  tokenWidthPercent: number | null;
  runs: RoleRunView[];
}

export interface RoleSummaryView {
  roles: RoleView[];
  // 概要の rollup へ畳まれたサブエージェントの数から、記録から復元して一覧に載せた数を引いたもの（下限 0）。
  // rollup は ID を持たないので、復元したものが rollup 由来かどうかは突き合わせられない
  omittedSubagentCount: number;
  // 保存域の外部実行の記録を読めなかった分。あれば一覧から外部実行が欠けている可能性がある（R-ANL-24 / R-DSP-01）
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

// 役割の並びは最初の実行の開始順（開始時刻の無いものは後ろ）。同時刻は出現順
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
