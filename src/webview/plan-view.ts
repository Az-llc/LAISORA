import * as l10n from "@vscode/l10n";
import { toolIntentLabel } from "./status-line";
import type { OrchestrationView, PlanContext, WorkAgentNode, WorkModelPayload } from "../protocol";
import type { PlanUsage, PlanTokenTotal } from "../plan-usage";
import type { TaskStatus, WorkStatus } from "../work-model";

export interface PlanLane {
  id: string; agent: string; title: string; start: number | null; elapsed: number | null;
  status: WorkStatus; tokens: number | null; cacheRead: number; external: boolean;
}
export interface PlanStep {
  key: string; number: number; title: string; activeForm?: string; status: TaskStatus;
  removed: boolean; added: boolean; addedAt: number | null; ahead: boolean;
  startedAt: number | null; endedAt: number | null; elapsed: number | null;
  tokens: PlanTokenTotal | null; lanes: PlanLane[]; resumeOf?: string;
}
export interface PlanView {
  goal: string; steps: PlanStep[]; now: PlanLane[]; current: number | null; completed: number;
  elapsed: number | null; claude: PlanTokenTotal | null; external: PlanTokenTotal | null; partial: boolean;
}

export function normalizePlanContent(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " "); }

export function externalTokens(usage: OrchestrationView["runs"][number]["usage"]): PlanTokenTotal | null {
  if (usage === null) return null;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const creation = usage.cache_creation_input_tokens;
  if (input === undefined && output === undefined && creation === undefined) return null;
  const cached = usage.cached_input_tokens ?? 0;
  return { tokens: Math.max(0, (input ?? 0) - cached) + (creation ?? 0) + (output ?? 0),
    cacheRead: usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? cached };
}

export function derivePlanView(model: WorkModelPayload | undefined, orchestration: OrchestrationView | undefined,
  usage: PlanUsage | undefined, nowMs: number, context: PlanContext | undefined = model?.planContext): PlanView {
  const declaration = model?.planDeclaration;
  // R-DSP-43: nothing recorded before the handoff enters the window; the Host already dropped the older declaration.
  const floor = model?.planBoundaryAt ?? Number.NEGATIVE_INFINITY;
  if (context) {
    const start = Math.max(context.start, floor);
    context = { ...context, start: declaration?.at ?? Math.min(start,
      model?.planHistory?.find(entry => entry.kind === "todos" && entry.at >= floor)?.at ?? start) };
  }
  const view: PlanView = { goal: declaration?.goal ?? "", steps: [], now: [], current: null,
    completed: 0, elapsed: context ? Math.max(0, (context.running ? Math.max(nowMs, context.end) : context.end) - context.start) : null,
    claude: null, external: null, partial: model?.planHistoryLostThrough !== undefined &&
      model.planHistoryLostThrough >= Math.max(floor, declaration?.at ?? Number.NEGATIVE_INFINITY) || model?.coverage.summary === "prefix-truncated" };
  if (!context) return view;
  const history = (model?.planHistory ?? []).filter(entry => entry.at >= context.start && entry.at <= context.end);
  const transitions = new Map<string, Array<{ at: number; active: boolean; order: number }>>();
  let hasPlan = false;
  let hasStartedPlan = false;
  let userAfterPlan = false;
  let order = 0;
  const created = new Set<string>();
  const resumes = new Map<string, Array<{ step: PlanStep; status: WorkStatus; endedAt?: number }>>();
  for (const entry of history) {
    if (entry.kind === "user") { if (hasPlan) userAfterPlan = true; continue; }
    if (entry.kind === "resume") {
      if (!view.steps.length) continue;
      const key = `resume\n${entry.agentId}\n${entry.at}`;
      const step: PlanStep = { key, number: view.steps.length + 1, title: l10n.t("Resumed: {0}", entry.description), status: "in_progress",
        removed: false, added: true, addedAt: entry.at, ahead: false, startedAt: entry.at, endedAt: null, elapsed: null, tokens: null,
        lanes: [], resumeOf: entry.agentId };
      view.steps.push(step);
      transitions.set(key, []);
      resumes.set(entry.agentId, [...resumes.get(entry.agentId) ?? [], { step, status: entry.status, endedAt: entry.endedAt }]);
      continue;
    }
    const present = new Set<string>();
    for (const item of entry.items) {
      if (entry.created) created.add(item.taskKey);
      if (declaration && entry.source === "tasks" && !created.has(item.taskKey)) continue;
      const key = planStepKey(entry, item);
      if (present.has(key)) continue;
      present.add(key);
      let step = view.steps.find(value => value.key === key);
      if (entry.removed) {
        if (step) {
          step.removed = true;
          if (step.startedAt !== null && step.endedAt === null) step.endedAt = entry.at;
          transitions.get(key)!.push({ at: entry.at, active: false, order: ++order });
        }
        continue;
      }
      if (!step) {
        step = { key, number: view.steps.length + 1, title: item.description, status: "unknown", removed: false,
          added: hasPlan && (entry.source !== "tasks" || hasStartedPlan || userAfterPlan),
          addedAt: hasPlan && userAfterPlan ? entry.at : null, ahead: false,
          startedAt: null, endedAt: null, elapsed: null, tokens: null, lanes: [] };
        view.steps.push(step);
        transitions.set(key, []);
      }
      if (step.status !== item.status || step.removed) {
        transitions.get(key)!.push({ at: entry.at, active: item.status === "in_progress", order: ++order });
        if (item.status === "in_progress") {
          step.startedAt ??= entry.at;
          step.endedAt = null;
        } else if (item.status === "completed") step.endedAt = entry.at;
      }
      step.status = item.status;
      step.activeForm = item.activeForm;
      step.removed = false;
      if (entry.source === "tasks") step.title = item.description;
    }
    for (const step of view.steps) {
      if (entry.source === "tasks" || present.has(step.key) || step.removed || step.resumeOf !== undefined) continue;
      step.removed = true;
      if (step.startedAt !== null && step.endedAt === null) step.endedAt = entry.at;
      transitions.get(step.key)!.push({ at: entry.at, active: false, order: ++order });
    }
    hasPlan = true;
    hasStartedPlan ||= entry.items.some(item => item.status === "in_progress" || item.status === "completed");
  }
  const nodes = new Map<string, WorkAgentNode>();
  const index = (agent: WorkAgentNode): void => { nodes.set(agent.agentId, agent); agent.children.forEach(index); };
  for (const phase of model?.phases ?? []) phase.agents.forEach(index);
  (model?.unlinkedAgents ?? []).forEach(index);
  const segmentEnd = (agentId: string, position: number): { status: WorkStatus; endedAt?: number } => {
    const next = resumes.get(agentId)![position + 1];
    const node = nodes.get(agentId);
    return next ?? (node ? { status: node.status, endedAt: node.endedAt } : { status: "unknown" });
  };
  for (const [agentId, list] of resumes) list.forEach(({ step }, position) => {
    const end = segmentEnd(agentId, position);
    step.status = end.status === "running" ? "in_progress" : end.status === "unknown" ? "unknown" : "completed";
    step.endedAt = end.status === "running" ? null : end.endedAt ?? null;
    const description = nodes.get(agentId)?.description;
    if (description) step.title = l10n.t("Resumed: {0}", description);
  });
  const stepAt = (at: number): PlanStep | undefined => {
    let winner: PlanStep | undefined;
    let latest = -1;
    for (const step of view.steps) {
      const change = transitions.get(step.key)!.filter(value => value.at <= at).at(-1);
      if (change?.active && change.order > latest) { winner = step; latest = change.order; }
    }
    return winner;
  };
  const current = view.steps.find(step => !step.removed && step.status === "in_progress");
  view.current = current?.number ?? null;
  view.goal ||= current?.title ?? "";
  for (const step of view.steps) {
    step.ahead = !step.removed && step.status === "in_progress" && current !== undefined && step.number > current.number;
    step.elapsed = step.startedAt === null ? null : Math.max(0, (step.endedAt ?? (context.running ? Math.max(nowMs, context.end) : context.end)) - step.startedAt);
  }
  view.completed = view.steps.filter(step => !step.removed && step.status === "completed").length;
  const remaining = view.steps.filter(step => !step.removed);
  if (remaining.length && remaining.every(step => step.status === "completed")) {
    const end = Math.max(...remaining.map(step => step.endedAt ?? context!.start));
    view.elapsed = Math.max(0, end - context.start);
  }
  const slices = usage?.blocks.flatMap(block => block.slices).filter(slice => slice.end > context!.start && slice.start <= context!.end) ?? [];
  if (slices.length) {
    view.claude = { tokens: 0, cacheRead: 0 };
    for (const original of slices) {
      const start = Math.max(original.start, context.start);
      const ratio = (original.end - start) / Math.max(1, original.end - original.start);
      const slice = { ...original, start, tokens: original.tokens * ratio, cacheRead: original.cacheRead * ratio };
      view.claude.tokens += slice.tokens;
      view.claude.cacheRead += slice.cacheRead;
      const boundaries = [slice.start, slice.end, ...[...transitions.values()].flat().map(value => value.at)
        .filter(at => at > slice.start && at < slice.end)].sort((a, b) => a - b);
      for (let i = 0; i < boundaries.length - 1; i++) {
        const step = stepAt(boundaries[i]);
        if (!step) continue;
        const ratio = (boundaries[i + 1] - boundaries[i]) / Math.max(1, slice.end - slice.start);
        step.tokens ??= { tokens: 0, cacheRead: 0 };
        step.tokens.tokens += slice.tokens * ratio;
        step.tokens.cacheRead += slice.cacheRead * ratio;
      }
    }
  }
  const seen = new Set<string>();
  const attach = (lane: PlanLane): void => {
    if (seen.has(lane.id)) return;
    if (lane.start !== null && lane.start < context.start && lane.status !== "running") return;
    if (lane.start !== null && lane.start > Math.max(context.end, nowMs)) return;
    seen.add(lane.id);
    const step = lane.start === null ? undefined : stepAt(lane.start);
    (step?.lanes ?? view.now).push(lane);
  };
  const visit = (agent: WorkAgentNode): void => {
    const observed = orchestration?.agents.find(value => value.agentId === (agent.transcriptAgentId ?? agent.agentId));
    const lane: PlanLane = { id: `agent:${agent.transcriptAgentId ?? agent.agentId}`, agent: observed?.role ?? agent.agentType ?? agent.modelMeasured ?? agent.modelDeclared ?? "Claude",
      title: agent.status === "running" && agent.intentInput ? toolIntentLabel("Agent", agent.intentInput) : agent.description, start: agent.startedAt ?? null,
      elapsed: agent.status === "running" && agent.startedAt !== undefined && context.running
        ? Math.max(agent.elapsedMs, nowMs - agent.startedAt)
        : agent.origin === "restored" && (agent.startedAt === undefined || agent.endedAt === undefined) ? null : agent.elapsedMs,
      status: agent.status, tokens: agent.tokens ?? externalTokens(observed?.usage ?? null)?.tokens ?? null,
      cacheRead: externalTokens(observed?.usage ?? null)?.cacheRead ?? 0, external: false };
    const resumed = resumes.get(agent.agentId);
    if (!resumed) attach(lane);
    else {
      const first = resumed[0];
      attach({ ...lane, status: first.status,
        elapsed: first.endedAt === undefined || agent.startedAt === undefined ? null : Math.max(0, first.endedAt - agent.startedAt) });
      resumed.forEach(({ step }, position) => {
        const id = `${lane.id}:resume:${step.startedAt}`;
        if (seen.has(id)) return;
        seen.add(id);
        const end = segmentEnd(agent.agentId, position);
        const until = end.status === "running" ? (context.running ? Math.max(nowMs, context.end) : context.end) : end.endedAt;
        step.lanes.push({ ...lane, id, start: step.startedAt, status: end.status,
          elapsed: until === undefined ? null : Math.max(0, until - step.startedAt!), tokens: null, cacheRead: 0 });
      });
    }
    for (const child of agent.children) visit(child);
  };
  for (const phase of model?.phases ?? []) for (const agent of phase.agents) visit(agent);
  for (const agent of model?.unlinkedAgents ?? []) visit(agent);
  for (const agent of orchestration?.agents ?? []) {
    const tokens = externalTokens(agent.usage);
    attach({ id: `agent:${agent.agentId}`, agent: agent.role ?? agent.agentType ?? "Claude", title: agent.model ?? "",
      start: Date.parse(agent.firstSeenAt), elapsed: Math.max(0, Date.parse(agent.lastActivityAt) - Date.parse(agent.firstSeenAt)),
      status: "unknown", tokens: tokens?.tokens ?? null, cacheRead: tokens?.cacheRead ?? 0, external: false });
  }
  for (const [index, run] of (orchestration?.runs ?? []).entries()) {
    const tokens = externalTokens(run.usage);
    attach({ id: `external:${run.startedAt}:${index}`, agent: run.role, title: [run.executor, run.model, run.effort].filter(Boolean).join(" · "),
      start: Date.parse(run.startedAt), elapsed: run.durationMs, status: run.outcome === "ok" ? "completed" : "failed",
      tokens: tokens?.tokens ?? null, cacheRead: tokens?.cacheRead ?? 0, external: true });
  }
  for (const tool of model?.planTools ?? []) attach({ id: `tool:${tool.id}`, agent: "Claude", title: toolIntentLabel(tool.name, tool.intentInput),
    start: tool.startedAt, elapsed: Math.max(0, (context.running ? Math.max(nowMs, context.end) : context.end) - tool.startedAt),
    status: "running", tokens: null, cacheRead: 0, external: false });
  const external = [...view.now, ...view.steps.flatMap(step => step.lanes)].filter(lane => lane.external);
  if (external.length && external.every(lane => lane.tokens !== null)) view.external = {
    tokens: external.reduce((sum, lane) => sum + lane.tokens!, 0), cacheRead: external.reduce((sum, lane) => sum + lane.cacheRead, 0) };
  return view;
}

// PLAN の手順の同一性。TaskCreate / TaskUpdate は task id（改名しても同じ手順）、TodoWrite は正規化した文面。
// "\n" は normalizePlanContent を通らないので、task id と TodoWrite の文面は衝突しない
export function planStepKey(entry: { source?: "tasks" }, item: { taskKey: string; description: string }): string {
  return (entry.source === "tasks" || item.taskKey.startsWith("task:")) ? `task\n${item.taskKey}` : normalizePlanContent(item.description);
}
