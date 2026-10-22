import * as l10n from "@vscode/l10n";
import { conductorModelAtEnd, PLAN_UNPLANNED_ROW_KEY, planConductorRunning, splitByConductorModel, planFrame, planItemRowKey, planLive, planNow, planPlacedStep, planBlockConductorMs, PLAN_CONDUCTOR_BUCKETS, planRowConductorParts, planRowPeriod, planRowProvisional, planRowsAt, planRowTime, UNMEASURED_LABEL } from "./plan-steps";
import { attestedExternalRun, type ExternalRunRecord } from "./orchestration-external";
import { EXECUTORS, isOrchestrationEffort } from "./orchestration-roster";
import { flattenAgents, type WorkAgentNode, type WorkPhaseView } from "./protocol";
import { attributeSubagent, type RosterEvidence } from "./roster-evidence";
import { externalTokens, summarizeMainTokens, type PlanTokenTotal, type PlanUsageAccumulator } from "./plan-usage";
import { keyedGet, keyedValues, largestRemainder, type ConductorModel, type KeyedLog, type RequestBlockView,
  type TimeBucketView } from "./time-buckets";
import { memberRunTimes, runSpans, unionMs, type Span } from "./spans";
import type { AnalysisToolRecord, ExternalRunCall } from "./session-facts";
import { parseExternalTargetKey } from "./orchestration-executors";
import { deriveExecLogFindings, deriveFailureSummary, type FailureSummaryView } from "./exec-log-marks";
import { CACHE_HIT_TERM, claudeModelPrices, roleCacheTtl, runCacheTtlCost, type RoleCacheTtlView } from "./cache-ttl-cost";
import type { CacheTtl } from "./claude-prices";

export const ROLE_SHADE_MAX = 3;

export interface TokenDisplay {
  total: number | null;
  cacheRead: number | null;
  outputTokens: number | null;
  label: string;
  newPercent: number | null;
  cachePercent: number | null;
  cacheBarPercent: number | null;
}

export function tokenDisplay(total: number | null, cacheRead: number | null, outputTokens: number | null = 0): TokenDisplay {
  const amount = total === null ? "?" : total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(Math.round(total));
  const context = total === null || cacheRead === null || outputTokens === null ? null : total + cacheRead - outputTokens;
  // No context means no hit ratio, not a 0% hit.
  const cachePercent = context === null || context <= 0 ? null : cacheRead! / context * 100;
  const whole = total === null ? null : total + (cacheRead ?? 0);
  const cacheBarPercent = whole === null || cacheRead === null ? null : whole > 0 ? cacheRead / whole * 100 : 0;
  return { total, cacheRead, outputTokens, label: cachePercent === null ? amount : `${amount} (${CACHE_HIT_TERM} ${Math.round(cachePercent)}%)`,
    newPercent: whole === null ? null : whole === 0 ? 0 : total! / whole * 100, cachePercent, cacheBarPercent };
}

export interface AnalysisTimeView {
  totalMs: number | null;
  partial: boolean;
  parts: { ms: number | null; percent: number | null; partial?: boolean }[];
}

export interface AnalysisPlanView {
  key: string;
  blockId: string;
  stepKey?: string;
  title: string;
  number: string;
  // null: nothing started; start, end, running and provisional come from src/plan-steps.ts#planRowPeriod at the view's last
  // observation. A running row's end is shown with src/plan-steps.ts#planPeriodEnd at the screen's clock, as GRAPH does.
  start: number | null;
  end: number | null;
  running: boolean;
  provisional: boolean;
  time: AnalysisTimeView;
  timeWidthPercent: number | null;
  tokens: TokenDisplay;
  tokenWidthPercent: number | null;
  tokensPartial: boolean;
  roles: RoleSummaryView;
  failures: FailureSummaryView;
}

export interface AnalysisPlansView {
  plans: AnalysisPlanView[];
  time: AnalysisTimeView;
  mainTokens: number | null;
  tokens: TokenDisplay;
  roles: RoleSummaryView;
  failures: FailureSummaryView;
}

export type RoleValueSource = "measured" | "requested";

export interface RoleRunView {
  source: "subagent" | "external" | "conductor";
  toolUseId?: string;
  blockId: string | null;
  cacheRead: number | null;
  outputTokens: number | null;
  tokenDisplay: TokenDisplay;
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
  durationPartial?: boolean;
  tokens: number | null;
  tokensPartial?: boolean;
  timePercent: number | null;
  tokenPercent: number | null;
  count?: number;
}

export interface RoleView {
  role: string | null;
  label: string;
  count: number;
  totalMs: number | null;
  totalMsPartial: boolean;
  totalTokens: number | null;
  totalTokensPartial: boolean;
  tokenDisplay: TokenDisplay;
  running: boolean;
  timeWidthPercent: number | null;
  tokenWidthPercent: number | null;
  runs: RoleRunView[];
  cacheTtl?: RoleCacheTtlView;
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

interface RunDraft extends Omit<RoleRunView, "shade" | "timePercent" | "tokenPercent" | "variantLabel" | "tokenDisplay"> {
  role: string | null;
}

function subagentRun(agent: WorkAgentNode, evidence: RosterEvidence, usage?: PlanUsageAccumulator, blockId: string | null = null): RunDraft {
  const attributed = attributeSubagent(evidence, agent);
  const variant = attributed?.definition;
  const measuredModel = agent.modelMeasured ?? attributed?.start?.model;
  const measuredEffort = agent.effortMeasured ?? attributed?.start?.effort;
  const requestedModel = agent.modelDeclared ?? variant?.model ?? null;
  const callEffort = attributed?.perCallEffort && variant?.effort && isOrchestrationEffort(agent.intentInput?.effort) ? agent.intentInput.effort : undefined;
  const requestedEffort = callEffort ?? agent.effortDeclared ?? variant?.effort ?? null;
  const finished = agent.origin === "live" && agent.status !== "running";
  const measured = summarizeMainTokens(usage);
  const cacheMeasured = usage !== undefined && [...usage.values()].every(value => value.usage.cacheReadInputTokens !== undefined);
  return {
    blockId,
    toolUseId: agent.toolUseId,
    cacheRead: measured && cacheMeasured ? measured.cacheRead : null,
    outputTokens: measured?.outputTokens ?? null,
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
    tokens: measured ? measured.tokens : agent.tokens ?? null,
    tokensPartial: measured?.partial ?? false,
  };
}

// An external run starts when its tool call started, else at its record's start.
export function externalRunStart(run: Pick<ExternalRunRecord, "toolUseId" | "startedAt">, tools: KeyedLog<AnalysisToolRecord> | undefined): number {
  return (run.toolUseId && tools ? keyedGet(tools, run.toolUseId)?.startedAt : undefined) ?? Date.parse(run.startedAt);
}

function externalRun(run: ExternalRunRecord, tools: KeyedLog<AnalysisToolRecord> | undefined, blockId: string | null = null): RunDraft {
  const definition = EXECUTORS[run.executor];
  const startedAt = externalRunStart(run, tools);
  const tokens = externalTokens(run.usage ?? null);
  const attested = attestedExternalRun(run);
  const model = attested?.model ?? run.model ?? null;
  const effort = attested?.effort ?? run.effort ?? null;
  return {
    blockId,
    toolUseId: run.toolUseId,
    cacheRead: run.usage && ["cache_read_input_tokens", "cache_read_tokens", "cached_input_tokens"].some(key => run.usage![key] !== undefined) ? tokens?.cacheRead ?? null : null,
    outputTokens: tokens?.outputTokens ?? null,
    role: run.role,
    source: "external",
    name: run.model !== undefined && (run.effort !== undefined || run.executor !== "codex")
      ? definition.targetKey(run.role, run.model, run.effort)
      : `${run.role}/${run.executor}`,
    executor: run.executor,
    model,
    modelSource: attested ? "measured" : model !== null ? "requested" : null,
    effort,
    effortSource: attested ? "measured" : effort !== null ? "requested" : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    running: false,
    outcome: run.outcome,
    durationMs: Number.isFinite(run.durationMs) && run.durationMs >= 0 ? run.durationMs : null,
    tokens: tokens ? tokens.tokens : null,
  };
}

function externalCallRun(call: ExternalRunCall & { running: boolean }, blockId: string | null = null): RunDraft {
  const target = call.target === undefined ? undefined : parseExternalTargetKey(call.target);
  return {
    blockId,
    toolUseId: call.toolUseId,
    cacheRead: null,
    outputTokens: null,
    role: target?.role ?? null,
    source: "external",
    name: call.target ?? "",
    executor: target?.executor ?? "",
    model: target?.model ?? null,
    modelSource: target === undefined ? null : "requested",
    effort: target?.effort ?? null,
    effortSource: target?.effort === undefined ? null : "requested",
    startedAt: call.startedAt,
    running: call.running,
    outcome: call.outcome ?? null,
    durationMs: call.outcome !== undefined && call.endedAt !== undefined ? Math.max(0, call.endedAt - call.startedAt) : null,
    tokens: null,
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
  generationBoundaryAt?: number;
  subagentUsage?: ReadonlyMap<string, PlanUsageAccumulator>;
  timeBuckets?: TimeBucketView;
  analysisTools?: KeyedLog<AnalysisToolRecord>;
  externalRunCalls?: readonly (ExternalRunCall & { running: boolean })[];
}): RoleSummaryView {
  const agents = flattenAgents(input.phases, input.unlinkedAgents);
  let rollupAgentCount = 0;
  for (const phase of input.phases) {
    if (phase.kind === "rollup") rollupAgentCount += phase.agentCount;
  }
  const currentAgents = agents.filter(a => input.generationBoundaryAt === undefined || a.startedAt !== undefined && a.startedAt >= input.generationBoundaryAt);
  const recoveredCount = currentAgents.filter((a) => a.origin === "restored").length;
  const omittedSubagentCount = Math.max(0, rollupAgentCount - recoveredCount);
  const blockByToolUseId = spanBlockIds(input.timeBuckets);
  const drafts: RunDraft[] = [
    ...currentAgents.map((a) => subagentRun(a, input.rosterEvidence, input.subagentUsage?.get(a.toolUseId),
      blockByToolUseId.get(a.toolUseId) ?? null)),
    ...externalRunDrafts(input.externalRuns, input.generationBoundaryAt, input.analysisTools,
      toolUseId => blockByToolUseId.get(toolUseId) ?? null),
    ...(input.externalRunCalls ?? []).map(call => externalCallRun(call, blockByToolUseId.get(call.toolUseId) ?? null)),
  ].sort(byStart);

  return summarizeRoleRuns(drafts, omittedSubagentCount, input.externalRunsCoverage);
}

function externalRunDrafts(runs: readonly ExternalRunRecord[], generationBoundaryAt: number | undefined,
  tools: KeyedLog<AnalysisToolRecord> | undefined, blockOf: (toolUseId: string) => string | null = () => null): RunDraft[] {
  return runs.filter(run => generationBoundaryAt === undefined || Date.parse(run.startedAt) >= generationBoundaryAt)
    .map(run => externalRun(run, tools, run.toolUseId ? blockOf(run.toolUseId) : null));
}

function spanBlockIds(view: Pick<TimeBucketView, "agents" | "backgroundTasks"> | undefined): Map<string, string | undefined> {
  return new Map([...view?.agents ?? [], ...view?.backgroundTasks ?? []].map(span => [span.toolUseId, span.blockId]));
}

function summarizeRoleRuns(drafts: RunDraft[], omittedSubagentCount = 0, coverage?: ExternalRunsCoverage): RoleSummaryView {
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
        tokenDisplay: tokenDisplay(r.tokens, r.cacheRead, r.outputTokens),
        variantLabel: [r.executor, r.model, r.effort].filter((v): v is string => v !== null).join(" · "),
        shade: Math.min(shades.indexOf(key), ROLE_SHADE_MAX),
        timePercent: percentOf(r.durationMs, time.total),
        tokenPercent: percentOf(runTokenWhole(r), list.reduce((sum, run) => sum + (runTokenWhole(run) ?? 0), 0)),
      };
    });
    return {
      role,
      label: role ?? l10n.t("other"),
      count: runs.length,
      totalMs: time.total,
      totalMsPartial: time.partial || list.some(r => r.durationPartial),
      totalTokens: tokens.total,
      totalTokensPartial: tokens.partial || list.some(r => r.tokensPartial),
      tokenDisplay: tokenDisplay(tokens.total, list.every(r => r.tokens !== null && r.cacheRead !== null)
        ? list.reduce((sum, r) => sum + r.cacheRead!, 0) : null,
        list.every(r => r.outputTokens !== null) ? list.reduce((sum, r) => sum + r.outputTokens!, 0) : null),
      running: list.some((r) => r.running),
      timeWidthPercent: null,
      tokenWidthPercent: null,
      runs,
    };
  });
  const maxMs = Math.max(0, ...roles.map((r) => r.totalMs ?? 0));
  const maxTokens = Math.max(0, ...roles.map((r) => (r.totalTokens ?? 0) + (r.tokenDisplay.cacheRead ?? 0)));
  for (const r of roles) {
    r.timeWidthPercent = percentOf(r.totalMs, maxMs);
    r.tokenWidthPercent = percentOf(r.totalTokens === null ? null : r.totalTokens + (r.tokenDisplay.cacheRead ?? 0), maxTokens);
  }
  return coverage !== undefined && (coverage.unreadableLines > 0 || coverage.readError)
    ? { roles, omittedSubagentCount, externalRunsCoverage: { unreadableLines: coverage.unreadableLines, readError: coverage.readError } }
    : { roles, omittedSubagentCount };
}

const runTokenWhole = (run: Pick<RoleRunView, "tokens" | "cacheRead">): number | null => run.tokens === null ? null : run.tokens + (run.cacheRead ?? 0);

function mergeRoleRuns(role: RoleView): RoleView {
  const groups = new Map<string, RoleRunView[]>();
  for (const run of role.runs) {
    const key = JSON.stringify([run.name, run.executor, run.model, run.modelSource, run.effort, run.effortSource]);
    const list = groups.get(key);
    if (list) list.push(run);
    else groups.set(key, [run]);
  }
  const tokenWhole = role.runs.reduce((sum, run) => sum + (runTokenWhole(run) ?? 0), 0);
  const runs = [...groups.values()].map((list): RoleRunView => {
    const [first] = list;
    if (list.length === 1) return first;
    const { toolUseId: _toolUseId, ...shared } = first;
    const time = sumOf(list.map(run => run.durationMs));
    const tokens = sumOf(list.map(run => run.tokens));
    const measured = list.filter(run => run.tokens !== null);
    const cacheRead = measured.length > 0 && measured.every(run => run.cacheRead !== null) ? measured.reduce((sum, run) => sum + run.cacheRead!, 0) : null;
    const outputTokens = measured.length > 0 && measured.every(run => run.outputTokens !== null) ? measured.reduce((sum, run) => sum + run.outputTokens!, 0) : null;
    const starts = list.flatMap(run => run.startedAt === null ? [] : [run.startedAt]);
    return { ...shared, count: list.length,
      blockId: list.every(run => run.blockId === first.blockId) ? first.blockId : null,
      startedAt: starts.length === 0 ? null : Math.min(...starts),
      running: list.some(run => run.running),
      outcome: list.every(run => run.outcome === first.outcome) ? first.outcome : null,
      durationMs: time.total, durationPartial: time.partial || list.some(run => run.durationPartial),
      tokens: tokens.total, tokensPartial: tokens.partial || list.some(run => run.tokensPartial),
      cacheRead, outputTokens, tokenDisplay: tokenDisplay(tokens.total, cacheRead, outputTokens),
      timePercent: percentOf(time.total, role.totalMs),
      tokenPercent: percentOf(sumOf(list.map(runTokenWhole)).total, tokenWhole) };
  });
  return { ...role, runs };
}


const spanTotal = (intervals: readonly { start: number; end: number }[]): number => unionMs(intervals.map(({ start, end }) => [start, end]));

function analysisTime(values: (number | null)[]): AnalysisTimeView {
  const sum = sumOf(values);
  return { totalMs: sum.total, partial: sum.partial, parts: values.map(ms => ({ ms, percent: percentOf(ms, sum.total) })) };
}

function blockAt(blocks: readonly RequestBlockView[], at: number | null): RequestBlockView | undefined {
  if (at === null) return undefined;
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (blocks[middle].start <= at) low = middle + 1;
    else high = middle;
  }
  const block = blocks[low - 1];
  return block && (at < (block.closedAt ?? block.end) || block.closedAt === undefined && at === block.end) ? block : undefined;
}

// The ANALYSIS rows with their routed time, tokens and runs; the PLAN panel's placement reads the same rows
// (src/role-summary.ts#derivePlanPlacement).
function analysisRows(view: TimeBucketView | undefined, roles: RoleSummaryView, tools?: KeyedLog<AnalysisToolRecord>) {
  const blocks = view?.blocks ?? [];
  const frame = view === undefined ? undefined : planFrame(view);
  const rows = (frame?.rows ?? []).map(frame => ({ key: frame.key, frame, block: frame.block, step: frame.item,
    values: Array<number | null>(6).fill(null), tokens: null as PlanTokenTotal | null,
    runs: [] as RunDraft[], toolCount: 0, failCount: 0, marks: [] as AnalysisToolRecord["marks"] }));
  type Row = typeof rows[number];
  const byKey = new Map(rows.map(row => [row.key, row]));
  // Work whose own row is not in the frame goes to the 00; without one it stays in the header only.
  const frameBlocks = frame === undefined ? [] : blocks;
  const frameBlockIds = new Set(frameBlocks.map(block => block.blockId));
  const rowOf = (blockId: string | undefined | null, stepKey?: string): Row | undefined => blockId == null ? undefined
    : (stepKey === undefined ? undefined : byKey.get(planItemRowKey(blockId, stepKey)))
      ?? (frameBlockIds.has(blockId) ? byKey.get(PLAN_UNPLANNED_ROW_KEY) : undefined);
  const memberRow = new Map<string, Row>();
  for (const row of rows) for (const member of [...row.frame.members.agents, ...row.frame.members.bgTasks]) memberRow.set(member.toolUseId, row);
  const ownerRow = (owner: { toolUseId: string; blockId?: string; stepKey?: string; start: number }): Row | undefined =>
    memberRow.get(owner.toolUseId) ?? rowOf(owner.blockId ?? blockAt(blocks, owner.start)?.blockId, owner.stepKey);
  const routes = frame?.routes ?? [];
  const live = view !== undefined && planLive(view);
  const now = view === undefined ? -Infinity : planNow(view);
  const rowsAt = (at: number): Row[] => planRowsAt(routes, at).map(key => byKey.get(key)).filter((row): row is Row => row !== undefined);
  // A usage slice is a whole second; only its routed part (moments the view observed) is shared out, so a slice that runs
  // past the last observation is not lost.
  const routedShare = (start: number, end: number): Map<Row, number> => {
    const routed = planRowTime(routes, start, end);
    return new Map([...routed.rows].flatMap(([key, ms]) => { const row = byKey.get(key); return row === undefined ? [] : [[row, ms / routed.covered] as const]; }));
  };
  const blockValues = (block: RequestBlockView): (number | null)[] =>
    [...planBlockConductorMs(block), block.metrics === undefined ? null : block.metrics.subagentOnlyMs ?? null];
  for (const row of rows) {
    const values = blockValues(row.block);
    // Without subagent-only spans a block measured at zero is zero on every row.
    if (values[5] === 0) row.values[5] = 0;
    if (row.block.metrics?.tokens != null) row.tokens = { tokens: 0, cacheRead: 0, outputTokens: 0 };
  }
  for (const block of frameBlocks) for (const slice of block.usageSlices ?? []) {
    const shares = slice.end > slice.start ? routedShare(slice.start, slice.end) : new Map<Row, number>();
    const allocation = shares.size > 0 ? shares : new Map(rowsAt(slice.start).map(row => [row, 1]));
    for (const [row, ratio] of allocation) {
      const tokens = row.tokens ??= { tokens: 0, cacheRead: 0, outputTokens: 0 };
      tokens.tokens += slice.tokens * ratio;
      tokens.cacheRead += slice.cacheRead * ratio;
      tokens.outputTokens = (tokens.outputTokens ?? 0) + (slice.outputTokens ?? 0) * ratio;
    }
  }
  if (view?.subagentOnlySpans !== undefined) {
    for (const row of rows) row.values[5] = 0;
    const activeOwners = [...view.agents, ...view.backgroundTasks.filter(task => task.subagent)]
      .map(owner => ({ owner, runs: runSpans(memberRunTimes(owner)) }));
    const runsDuring = (runs: readonly Span[], start: number, end: number) => runs.some(([runStart, runEnd]) => runStart < end && runEnd > start);
    for (const [start, end] of view.subagentOnlySpans) {
      const active = activeOwners.filter(({ runs }) => runsDuring(runs, start, end));
      const points = [...new Set([start, end, ...active.flatMap(({ runs }) => runs.flatMap(([runStart, runEnd]) =>
        runStart < end && runEnd > start ? [Math.max(start, runStart), Math.min(end, runEnd)] : []))])]
        .sort((a, b) => a - b);
      for (let i = 0; i + 1 < points.length; i++) {
        const owners = new Set(active.filter(({ runs }) => runsDuring(runs, points[i], points[i + 1])).map(({ owner }) => ownerRow(owner)));
        for (const row of owners) if (row) row.values[5] = (row.values[5] ?? 0) + (points[i + 1] - points[i]);
      }
    }
  }
  const owners = new Map([...view?.agents ?? [], ...view?.backgroundTasks ?? []].map(owner => [owner.toolUseId, owner]));
  const headerRuns: RunDraft[] = [];
  const seenRuns = new Set<string>();
  // A run without a span (a foreground external run) goes to the item its description number names, the same placement as
  // a run with a span (src/plan-steps.ts#planPlacedStep), else to the 00.
  type RunRef = Pick<RoleRunView, "toolUseId" | "startedAt" | "blockId">;
  const runPlace = (run: RunRef): { owner?: NonNullable<ReturnType<typeof owners.get>>; blockId?: string | null; stepKey?: string } => {
    const owner = run.toolUseId === undefined ? undefined : owners.get(run.toolUseId);
    if (owner) return { owner, blockId: owner.blockId ?? blockAt(blocks, owner.start)?.blockId };
    const at = run.startedAt;
    const number = run.toolUseId === undefined || tools === undefined ? undefined : keyedGet(tools, run.toolUseId)?.itemNumber;
    const numbered = number === undefined || at === null ? undefined : planPlacedStep(blocks, number, at);
    if (numbered !== undefined) return { blockId: blocks[numbered.blockIndex].blockId, stepKey: numbered.step.key };
    return { blockId: run.blockId ?? blockAt(blocks, at)?.blockId };
  };
  const runRow = (run: RunRef): Row | undefined => {
    const place = runPlace(run);
    if (place.owner) return ownerRow(place.owner);
    return rowOf(place.blockId, place.stepKey)
      ?? (place.stepKey !== undefined || run.startedAt === null ? undefined : rowsAt(run.startedAt)[0]);
  };
  // The work block a run belongs to, by the same decision as its ANALYSIS row; the 00 row's block is not the run's.
  const runBlockId = (run: RunRef): string | undefined => runPlace(run).blockId ?? runRow(run)?.block.blockId;
  for (const role of roles.roles) for (const run of role.runs) {
    const row = runRow(run);
    if (!row || run.toolUseId !== undefined && seenRuns.has(run.toolUseId)) continue;
    if (run.toolUseId !== undefined) seenRuns.add(run.toolUseId);
    const draft = { ...run, blockId: runBlockId(run) ?? row.block.blockId, role: role.role };
    row.runs.push(draft);
    headerRuns.push(draft);
  }
  return { frameBlocks, rows, rowsAt, ownerRow, owners, runRow, runBlockId, headerRuns, now, live, blockValues };
}

export interface PlanPlacement {
  tokens: Map<string, PlanTokenTotal | null>;
  placements: Array<{ toolUseId: string; agentId?: string; stepKey: string | null }>;
  // The block's ROLES external runs, null when there are none or one is unmeasured.
  external: PlanTokenTotal | null;
}

const NO_ROLES: RoleSummaryView = { roles: [], omittedSubagentCount: 0 };

// Each lane sits on the ANALYSIS row a run with its id and start would take (src/role-summary.ts#analysisRows runRow);
// only rows of the asked block name a step. Step tokens are those rows' routed tokens. Lanes start as their ANALYSIS
// runs do: an external run by src/role-summary.ts#externalRunStart.
export function derivePlanPlacements(view: TimeBucketView | undefined, tools: KeyedLog<AnalysisToolRecord> | undefined,
  lanes: ReadonlyArray<{ toolUseId: string; start: number | null }>,
  external: { runs: readonly ExternalRunRecord[]; generationBoundaryAt?: number } = { runs: [] }): (blockId: string) => PlanPlacement {
  const { rows, owners, runRow, runBlockId } = analysisRows(view, NO_ROLES, tools);
  const spanBlocks = spanBlockIds(view);
  const externalByBlock = new Map<string, RunDraft[]>();
  for (const run of externalRunDrafts(external.runs, external.generationBoundaryAt, tools, toolUseId => spanBlocks.get(toolUseId) ?? null)) {
    const blockId = runBlockId(run);
    if (blockId !== undefined) externalByBlock.set(blockId, [...externalByBlock.get(blockId) ?? [], run]);
  }
  const externalOf = (blockId: string): PlanTokenTotal | null => {
    const runs = externalByBlock.get(blockId) ?? [];
    if (runs.length === 0 || runs.some(run => run.tokens === null)) return null;
    return { tokens: runs.reduce((sum, run) => sum + run.tokens!, 0), cacheRead: runs.reduce((sum, run) => sum + (run.cacheRead ?? 0), 0) };
  };
  const routed = new Map<string, { agentId?: string; row: (typeof rows)[number] | undefined }>();
  for (const [toolUseId, owner] of owners) {
    const agentId = "transcriptAgentId" in owner ? owner.transcriptAgentId : undefined;
    routed.set(toolUseId, { ...(agentId === undefined ? {} : { agentId }), row: runRow({ toolUseId, startedAt: owner.start, blockId: null }) });
  }
  for (const lane of lanes) if (!routed.has(lane.toolUseId)) routed.set(lane.toolUseId, { row: runRow({ toolUseId: lane.toolUseId, startedAt: lane.start, blockId: null }) });
  return blockId => ({
    tokens: new Map(rows.filter(row => row.block.blockId === blockId && row.step !== undefined).map(row => [row.step!.key, row.tokens])),
    placements: [...routed].map(([toolUseId, { agentId, row }]) => ({ toolUseId, ...(agentId === undefined ? {} : { agentId }),
      stepKey: row?.block.blockId === blockId ? row.step?.key ?? null : null })),
    external: externalOf(blockId),
  });
}

export function derivePlanPlacement(view: TimeBucketView | undefined, tools: KeyedLog<AnalysisToolRecord> | undefined,
  blockId: string, lanes: ReadonlyArray<{ toolUseId: string; start: number | null }>): PlanPlacement {
  return derivePlanPlacements(view, tools, lanes)(blockId);
}

export interface AnalysisCacheTtlInput {
  usage: ReadonlyMap<string, PlanUsageAccumulator> | undefined;
  settings: ReadonlyMap<string, CacheTtl>;
}

function withCacheTtl(summary: RoleSummaryView, input: AnalysisCacheTtlInput): RoleSummaryView {
  return { ...summary, roles: summary.roles.map((role) => {
    const setting = role.role === null || role.role === "conductor" ? undefined : input.settings.get(role.role);
    if (setting === undefined) return role;
    const costs = role.runs.filter((run) => run.source === "subagent").map((run) => {
      const usage = run.toolUseId === undefined ? undefined : input.usage?.get(run.toolUseId);
      return usage === undefined || run.modelSource !== "measured" ? null : runCacheTtlCost([...usage.values()], claudeModelPrices(run.model));
    });
    const cacheTtl = roleCacheTtl(costs, setting);
    return cacheTtl === undefined ? role : { ...role, cacheTtl };
  }) };
}

export function deriveAnalysisPlans(view: TimeBucketView | undefined, roles: RoleSummaryView,
  tools?: KeyedLog<AnalysisToolRecord>, cacheTtl?: AnalysisCacheTtlInput): AnalysisPlansView {
  const { frameBlocks, rows, rowsAt, headerRuns, now, live, blockValues } = analysisRows(view, roles, tools);
  const allMarks: AnalysisToolRecord["marks"] = [];
  let headerToolCount = 0, headerFailCount = 0;
  for (const tool of tools ? keyedValues(tools) : []) {
    const counted = tool.bookkeeping !== true;
    const calls = !counted || tool.startedAt === undefined ? [] : rowsAt(tool.startedAt);
    for (const row of calls) row.toolCount++;
    if (calls.length) headerToolCount++;
    const failures = tool.failed && tool.finishedAt !== undefined ? rowsAt(tool.finishedAt) : [];
    for (const row of failures) { if (counted) row.failCount++; row.marks.push(...tool.marks); }
    if (failures.length) { if (counted) headerFailCount++; allMarks.push(...tool.marks); }
  }
  const conductorRun = (blockId: string | null, startedAt: number, time: AnalysisTimeView, mainTokens: PlanTokenTotal | null, running: boolean,
    model: ConductorModel | null | undefined): RunDraft => {
    const conductorTime = sumOf(time.parts.slice(0, 5).map(part => part.ms));
    return { role: "conductor", source: "conductor", blockId, name: "Conductor", executor: "claude",
      model: model?.model ?? null, modelSource: model ? "measured" : null, effort: model?.effort ?? null,
      effortSource: model?.effort === undefined ? null : "measured", startedAt,
      running,
      outcome: null, durationMs: conductorTime.total, durationPartial: conductorTime.partial, tokens: mainTokens ? mainTokens.tokens : null,
      cacheRead: mainTokens?.cacheRead ?? null, outputTokens: mainTokens?.outputTokens ?? (mainTokens ? 0 : null) };
  };
  const plans = rows.map(({ key, frame, block, step, values, tokens: mainTokens, runs: rowRuns, toolCount, failCount, marks }): AnalysisPlanView => {
    const span = planRowPeriod(frame, now, live);
    const unmeasured = span === undefined;
    const empty = unmeasured && rowRuns.length === 0;
    const rowValues = [...planRowConductorParts(frame, span), values[5]];
    const time = analysisTime(empty ? rowValues.map(() => null) : rowValues);
    time.partial = !empty && time.partial;
    const planRoles = summarizeRoleRuns(unmeasured ? rowRuns : [conductorRun(block.blockId, step?.startedAt ?? block.start, time, mainTokens,
      planConductorRunning(frame, span), conductorModelAtEnd(view?.mainModelSpans, frame.conductorWork)), ...rowRuns]);
    const tokenTotal = sumOf(planRoles.roles.map(role => role.totalTokens));
    const runs = planRoles.roles.flatMap(role => role.runs);
    const counted = tokenDisplay(tokenTotal.total, runs.every(run => run.tokens !== null && run.cacheRead !== null)
      ? runs.reduce((sum, run) => sum + run.cacheRead!, 0) : null,
      runs.every(run => run.outputTokens !== null) ? runs.reduce((sum, run) => sum + run.outputTokens!, 0) : null);
    return { key, blockId: block.blockId, ...(step ? { stepKey: step.key } : {}), title: frame.title,
      number: frame.number, start: span?.start ?? null, end: span?.end ?? null, running: span?.running ?? false,
      provisional: planRowProvisional(frame, span),
      time, timeWidthPercent: null, tokens: runs.length === 0 ? { ...counted, label: UNMEASURED_LABEL } : counted, tokenWidthPercent: null,
      tokensPartial: !empty && (unmeasured || tokenTotal.partial || planRoles.roles.some(role => role.totalTokensPartial)), roles: planRoles,
      failures: deriveFailureSummary(deriveExecLogFindings(marks), [{ toolCount, failCount, childToolCount: 0, childFailCount: 0 }]) };
  });
  const maxTime = Math.max(0, ...plans.map(plan => plan.time.totalMs ?? 0));
  const maxTokens = Math.max(0, ...plans.map(plan => (plan.tokens.total ?? 0) + (plan.tokens.cacheRead ?? 0)));
  for (const plan of plans) {
    plan.timeWidthPercent = percentOf(plan.time.totalMs, maxTime);
    plan.tokenWidthPercent = percentOf(plan.tokens.total === null ? null : plan.tokens.total + (plan.tokens.cacheRead ?? 0), maxTokens);
  }
  // Block metrics already count interval unions and usage slices once, irrespective of row attribution.
  const totals = frameBlocks.map(blockValues);
  const timeSums = Array.from({ length: 6 }, (_, i) => sumOf(totals.map(values => values[i])));
  const time = analysisTime(timeSums.map(sum => sum.total));
  time.parts.forEach((part, i) => { part.partial = timeSums[i].partial; });
  time.partial = timeSums.some(sum => sum.partial);
  if (frameBlocks.length > 0) headerRuns.unshift(...headerConductorRuns());
  function headerConductorRuns(): RunDraft[] {
    const running = rows.some(row => planConductorRunning(row.frame, planRowPeriod(row.frame, now, live)));
    const spans = view?.mainModelSpans;
    const mainIntervals = (view?.intervals ?? []).filter(interval => interval.lane === "main");
    const keyOf = (model: ConductorModel | null): string => model === null ? "" : JSON.stringify([model.model, model.effort ?? null]);
    const parts = new Map<string, { model: ConductorModel | null; startedAt: number; values: (number | null)[][]; tokens: (PlanTokenTotal | null)[] }>();
    let lastWindow = { start: 0, end: 1 };
    for (const block of frameBlocks) {
      const slices = (block.usageSlices ?? []).map(slice => ({ ...slice, end: slice.start + 1 }));
      const window = { start: block.start, end: Math.max(block.start + 1, block.closedAt ?? Math.max(block.end, ...slices.map(slice => slice.end))) };
      lastWindow = window;
      const windowParts = splitByConductorModel(spans, [window]);
      const keys = windowParts.map(part => keyOf(part.model));
      const windowWeights = windowParts.map(part => spanTotal(part.intervals));
      const share = <T extends { start: number; end: number }>(amount: number, pieces: T[], weight: (piece: T) => number): number[] => {
        const byKey = new Map(splitByConductorModel(spans, pieces).map(part => [keyOf(part.model), part.intervals.reduce((sum, piece) => sum + weight(piece), 0)]));
        const weights = keys.map(key => byKey.get(key) ?? 0);
        const total = weights.reduce((sum, value) => sum + value, 0);
        return total > 0 ? largestRemainder(weights, total, amount) : largestRemainder(windowWeights, window.end - window.start, amount);
      };
      const clipped = mainIntervals.flatMap(interval => {
        const start = Math.max(interval.start, window.start), end = Math.min(interval.end, window.end);
        return end > start ? [{ ...interval, start, end }] : [];
      });
      const values = blockValues(block);
      const bucketValues = PLAN_CONDUCTOR_BUCKETS.map((bucket, i) => values[i] === null ? null
        : share(values[i]!, clipped.filter(piece => piece.bucket === bucket), piece => piece.end - piece.start));
      const tokens = block.metrics?.tokens ?? null;
      const tokenValues = tokens === null ? null : (["tokens", "cacheRead", "outputTokens"] as const)
        .map(field => share(tokens[field] ?? 0, slices, slice => slice[field] ?? 0));
      windowParts.forEach((windowPart, index) => {
        const key = keys[index];
        let part = parts.get(key);
        if (part === undefined) parts.set(key, part = { model: windowPart.model, startedAt: windowPart.intervals[0].start, values: [], tokens: [] });
        part.values.push(bucketValues.map(value => value === null ? null : value[index]));
        part.tokens.push(tokenValues === null ? null : { tokens: tokenValues[0][index], cacheRead: tokenValues[1][index], outputTokens: tokenValues[2][index] });
      });
    }
    const current = keyOf(conductorModelAtEnd(spans, [lastWindow]));
    const runs = [...parts].map(([key, part]) => {
      const buckets = PLAN_CONDUCTOR_BUCKETS.map((_, i) => sumOf(part.values.map(values => values[i])));
      const tokens = sumOf(part.tokens.map(value => value?.tokens ?? null));
      const cacheRead = sumOf(part.tokens.map(value => value?.cacheRead ?? null));
      const outputTokens = sumOf(part.tokens.map(value => value?.outputTokens ?? null));
      const draft = conductorRun(null, part.startedAt, analysisTime(buckets.map(sum => sum.total)),
        tokens.total === null ? null : { tokens: tokens.total, cacheRead: cacheRead.total!, outputTokens: outputTokens.total! }, running && key === current, part.model);
      return { ...draft, durationPartial: draft.durationPartial || buckets.some(sum => sum.partial),
        ...(tokens.partial ? { tokensPartial: true, cacheRead: null, outputTokens: null } : {}) };
    });
    const worked = runs.filter(run => run.durationMs !== 0 || run.durationPartial || (run.tokens ?? 0) > 0);
    return worked.length > 0 ? worked : runs.slice(0, 1);
  }
  const summarized = summarizeRoleRuns(headerRuns, roles.omittedSubagentCount, roles.externalRunsCoverage);
  const withTtl = cacheTtl === undefined ? summarized : withCacheTtl(summarized, cacheTtl);
  const headerRoles = { ...withTtl, roles: withTtl.roles.map(mergeRoleRuns) };
  const totalTokens = sumOf(headerRuns.map(run => run.tokens)).total;
  const tokens = tokenDisplay(totalTokens, headerRuns.every(run => run.tokens !== null && run.cacheRead !== null)
    ? headerRuns.reduce((sum, run) => sum + run.cacheRead!, 0) : null,
    headerRuns.every(run => run.outputTokens !== null) ? headerRuns.reduce((sum, run) => sum + run.outputTokens!, 0) : null);
  return { plans, time, mainTokens: headerRoles.roles.find(role => role.role === "conductor")?.totalTokens ?? null,
    tokens, roles: headerRoles,
    failures: deriveFailureSummary(deriveExecLogFindings(allMarks), [{ toolCount: headerToolCount,
      failCount: headerFailCount, childToolCount: 0, childFailCount: 0 }]) };
}
