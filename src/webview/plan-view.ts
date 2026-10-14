import { toolIntentLabel } from "./status-line";
import type { OrchestrationView, PlanContext, WorkAgentNode, WorkModelPayload } from "../protocol";
import { externalTokens, type PlanTokenTotal } from "../plan-usage";
import type { TaskStatus, WorkStatus } from "../work-model";
import { planItemNumber, planSpansMs, planStepKey, transitionPlanStep, type PlanSpan } from "../plan-steps";
export { normalizePlanContent, planStepKey } from "../plan-steps";

export interface PlanLane {
  id: string; agent: string; title: string; start: number | null; elapsed: number | null;
  status: WorkStatus | "stopped"; tokens: number | null; cacheRead: number; external: boolean; resumedAt?: number;
}
export interface PlanStep {
  key: string; number: number | null; title: string; activeForm?: string; status: TaskStatus;
  removed: boolean; added: boolean; addedAt: number | null; ahead: boolean;
  startedAt: number | null; endedAt: number | null; elapsed: number | null;
  // The Host's in-progress spans (src/plan-steps.ts#planStepActiveSpans); elapsed is their length when present.
  activeSpans?: PlanSpan[];
  tokens: PlanTokenTotal | null; lanes: PlanLane[];
}
export interface PlanView {
  block?: string; goal: string; steps: PlanStep[]; now: PlanLane[]; current: number | null; completed: number;
  elapsed: number | null; claude: PlanTokenTotal | null; external: PlanTokenTotal | null; partial: boolean;
}

export function planStepDone(step: { removed: boolean; status: TaskStatus }): boolean {
  return !step.removed && step.status === "completed";
}

export function planStepSettled(step: { removed: boolean; status: TaskStatus }): boolean {
  return step.removed || planStepDone(step);
}

export function planStepFolds(step: PlanStep): boolean {
  return planStepSettled(step) && !step.lanes.some(planLaneRunning);
}

export function planLaneRunning(lane: PlanLane): boolean {
  return lane.status === "running";
}

export function deriveEarlierPlanViews(model: WorkModelPayload | undefined, orchestration: OrchestrationView | undefined,
  nowMs: number): PlanView[] {
  return (model?.earlierPlans ?? []).map(context => {
    const view = derivePlanView(model, orchestration, nowMs, context);
    return { ...view, goal: view.goal || context.text };
  });
}

export function derivePlanView(model: WorkModelPayload | undefined, orchestration: OrchestrationView | undefined,
  nowMs: number, context: PlanContext | undefined = model?.planContext): PlanView {
  const view: PlanView = { block: context?.blockId, goal: context?.goal ?? "", steps: [], now: [], current: null,
    completed: 0, elapsed: context ? Math.max(0, (context.running ? Math.max(nowMs, context.end) : context.end) - context.start) : null,
    claude: null, external: null, partial: context !== undefined && model?.planHistoryLostThrough !== undefined &&
      model.planHistoryLostThrough >= context.start || model?.coverage.summary === "prefix-truncated" };
  const members = context?.steps === undefined ? undefined : new Set(context.steps.map(step => step.key));
  const unit = context ?? { start: Number.POSITIVE_INFINITY, end: nowMs, running: false, steps: [] };
  const history = (model?.planHistory ?? []).filter(entry => entry.at >= unit.start && entry.at <= unit.end);
  let hasPlan = false;
  let hasStartedPlan = false;
  let userAfterPlan = false;
  const itemKeys = (unit.steps ?? []).map(step => step.key);
  for (const entry of history) {
    if (entry.kind === "user") { if (hasPlan) userAfterPlan = true; continue; }
    if (entry.kind === "resume") continue;
    const present = new Set<string>();
    for (const item of entry.items) {
      const key = planStepKey(entry, item);
      if (members !== undefined && !members.has(key)) continue;
      if (present.has(key)) continue;
      present.add(key);
      const number = planItemNumber(itemKeys, key);
      let step = view.steps.find(value => value.key === key);
      if (entry.removed) {
        if (step) {
          transitionPlanStep(step, entry.at, step.status, true);
        }
        continue;
      }
      if (!step) {
        if (entry.source !== "tasks" && item.status === "completed") continue;
        step = { key, number, title: item.description, status: "unknown", removed: false,
          added: hasPlan && (entry.source !== "tasks" || hasStartedPlan || userAfterPlan),
          addedAt: hasPlan && userAfterPlan ? entry.at : null, ahead: false,
          startedAt: null, endedAt: null, elapsed: null, tokens: null, lanes: [] };
        view.steps.push(step);
      }
      transitionPlanStep(step, entry.at, item.status);
      step.status = item.status;
      step.activeForm = item.activeForm;
      step.removed = false;
      if (entry.source === "tasks") step.title = item.description;
    }
    for (const step of view.steps) {
      if (entry.source === "tasks" || present.has(step.key) || step.removed) continue;
      transitionPlanStep(step, entry.at, step.status, true);
    }
    hasPlan = true;
    hasStartedPlan ||= entry.items.some(item => item.status === "in_progress" || item.status === "completed");
  }
  if (unit.steps !== undefined) {
    const reconstructed = new Map(view.steps.map(step => [step.key, step]));
    view.steps = unit.steps.map(record => {
      const step = reconstructed.get(record.key) ?? { key: record.key, number: record.number, title: record.title, status: record.status,
        removed: record.removed, added: false, addedAt: null, ahead: false, startedAt: null, endedAt: null, elapsed: null, tokens: null, lanes: [] };
      Object.assign(step, { number: record.number, title: record.title, status: record.status, removed: record.removed,
        startedAt: record.startedAt, endedAt: record.endedAt, activeSpans: record.activeSpans, tokens: record.tokens ?? null });
      return step;
    });
  }
  const resumes = new Map<string, Array<{ at: number; status: WorkStatus; endedAt?: number }>>();
  if (view.steps.length) for (const entry of model?.planHistory ?? []) {
    if (entry.kind === "resume") resumes.set(entry.agentId, [...resumes.get(entry.agentId) ?? [], { at: entry.at, status: entry.status, endedAt: entry.endedAt }]);
  }
  const latest = model?.planContext;
  const runningUntil = context === undefined || latest?.running ? Math.max(nowMs, unit.end, latest?.end ?? unit.end) : latest?.end ?? unit.end;
  const shownEarlier = new Set((context?.blockId === latest?.blockId ? model?.earlierPlans ?? [] : []).flatMap(earlier =>
    (earlier.placements ?? []).filter(placement => earlier.steps?.some(step => step.key === placement.stepKey && planStepSettled(step)))
      .map(placement => placement.toolUseId)));
  const nodes = new Map<string, WorkAgentNode>();
  const index = (agent: WorkAgentNode): void => { nodes.set(agent.agentId, agent); agent.children.forEach(index); };
  for (const phase of model?.phases ?? []) phase.agents.forEach(index);
  (model?.unlinkedAgents ?? []).forEach(index);
  const segmentEnd = (agentId: string, position: number): { status: WorkStatus; endedAt?: number } => {
    const next = resumes.get(agentId)![position + 1];
    const node = nodes.get(agentId);
    return next ?? (node ? { status: node.status, endedAt: node.endedAt } : { status: "unknown" });
  };
  // The Host places every lane and allocates step tokens (src/role-summary.ts#derivePlanPlacement); a lane it did not
  // place is not on a step.
  const byToolUseId = new Map((context?.placements ?? []).map(placement => [placement.toolUseId, placement.stepKey]));
  const byAgentId = new Map((context?.placements ?? []).flatMap(placement => placement.agentId === undefined ? [] : [[placement.agentId, placement.stepKey] as const]));
  const current = view.steps.find(step => !step.removed && step.status === "in_progress");
  view.current = current?.number ?? null;
  view.goal ||= current?.title ?? "";
  for (const step of view.steps) {
    step.ahead = !step.removed && step.status === "in_progress" && current !== undefined && view.steps.indexOf(step) > view.steps.indexOf(current);
    const until = unit.running ? Math.max(nowMs, unit.end) : unit.end;
    const spans = step.activeSpans?.map((span, index, all) =>
      index === all.length - 1 && step.endedAt === null ? { start: span.start, end: Math.max(span.end, until) } : span);
    step.elapsed = step.startedAt === null ? null : spans !== undefined && spans.length > 0 ? planSpansMs(spans)
      : Math.max(0, (step.endedAt ?? until) - step.startedAt);
  }
  view.completed = view.steps.filter(planStepDone).length;
  const remaining = view.steps.filter(step => !step.removed);
  if (remaining.length && remaining.every(step => step.status === "completed")) {
    const end = Math.max(...remaining.map(step => step.endedAt ?? unit.start));
    view.elapsed = Math.max(0, end - unit.start);
  }
  view.claude = context?.tokens ?? null;
  const seen = new Set<string>();
  const inWindow = (lane: PlanLane): boolean =>
    (lane.status === "running" || context !== undefined && (lane.start === null || lane.start >= unit.start)) &&
    (lane.start === null || lane.start <= Math.max(unit.end, nowMs));
  const attach = (lane: PlanLane, owner: { toolUseId?: string; agentId?: string }): PlanLane[] | undefined => {
    if (seen.has(lane.id) || !inWindow(lane)) return undefined;
    seen.add(lane.id);
    const stepKey = (owner.toolUseId === undefined ? undefined : byToolUseId.get(owner.toolUseId))
      ?? (owner.agentId === undefined ? undefined : byAgentId.get(owner.agentId));
    const lanes = (stepKey == null ? undefined : view.steps.find(value => value.key === stepKey))?.lanes;
    if (lanes === undefined && owner.toolUseId !== undefined && shownEarlier.has(owner.toolUseId)) return undefined;
    (lanes ?? view.now).push(lane);
    return lanes ?? view.now;
  };
  const visit = (agent: WorkAgentNode): void => {
    const observed = orchestration?.agents.find(value => value.agentId === (agent.transcriptAgentId ?? agent.agentId));
    const lane: PlanLane = { id: `agent:${agent.transcriptAgentId ?? agent.agentId}`, agent: observed?.role ?? agent.agentType ?? agent.modelMeasured ?? agent.modelDeclared ?? "Claude",
      title: agent.status === "running" && agent.intentInput ? toolIntentLabel("Agent", agent.intentInput) : agent.description, start: agent.startedAt ?? null,
      elapsed: agent.status === "running" && agent.startedAt !== undefined && (context === undefined || unit.running)
        ? Math.max(agent.elapsedMs, nowMs - agent.startedAt)
        : agent.origin === "restored" && (agent.startedAt === undefined || agent.endedAt === undefined) ? null : agent.elapsedMs,
      status: agent.status, tokens: agent.tokens ?? externalTokens(observed?.usage ?? null)?.tokens ?? null,
      cacheRead: externalTokens(observed?.usage ?? null)?.cacheRead ?? 0, external: false };
    const resumed = resumes.get(agent.agentId);
    const owner = { toolUseId: agent.toolUseId, agentId: agent.transcriptAgentId ?? agent.agentId };
    if (!resumed) attach(lane, owner);
    else {
      const first = resumed[0];
      const placed = attach({ ...lane, title: agent.description, status: first.status,
        elapsed: first.endedAt === undefined || agent.startedAt === undefined ? null : Math.max(0, first.endedAt - agent.startedAt) }, owner);
      const elsewhere = placed === undefined && agent.toolUseId !== undefined && shownEarlier.has(agent.toolUseId);
      if (!elsewhere) resumed.forEach(({ at }, position) => {
        const id = `${lane.id}:resume:${at}`;
        const end = segmentEnd(agent.agentId, position);
        const until = end.status === "running" ? runningUntil : end.endedAt;
        const segment: PlanLane = { ...lane, id, title: agent.description, start: at, resumedAt: at, status: end.status,
          elapsed: until === undefined ? null : Math.max(0, until - at), tokens: null, cacheRead: 0 };
        if (seen.has(id) || placed === undefined && !inWindow(segment)) return;
        seen.add(id);
        (placed ?? view.now).push(segment);
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
      status: "unknown", tokens: tokens?.tokens ?? null, cacheRead: tokens?.cacheRead ?? 0, external: false }, { agentId: agent.agentId });
  }
  for (const [index, run] of (orchestration?.runs ?? []).entries()) {
    const tokens = externalTokens(run.usage);
    attach({ id: `external:${run.startedAt}:${index}`, agent: run.role, title: [run.executor, run.model, run.effort].filter(Boolean).join(" · "),
      start: Date.parse(run.startedAt), elapsed: run.durationMs, status: run.outcome === "ok" ? "completed" : run.outcome === "stopped" ? "stopped" : "failed",
      tokens: tokens?.tokens ?? null, cacheRead: tokens?.cacheRead ?? 0, external: true }, { toolUseId: run.toolUseId });
  }
  for (const tool of model?.planTools ?? []) attach({ id: `tool:${tool.id}`, agent: "Claude", title: toolIntentLabel(tool.name, tool.intentInput),
    start: tool.startedAt, elapsed: Math.max(0, (unit.running ? Math.max(nowMs, unit.end) : unit.end) - tool.startedAt),
    status: "running", tokens: null, cacheRead: 0, external: false }, { toolUseId: tool.id });
  const external = [...view.now, ...view.steps.flatMap(step => step.lanes)].filter(lane => lane.external);
  if (external.length && external.every(lane => lane.tokens !== null)) view.external = {
    tokens: external.reduce((sum, lane) => sum + lane.tokens!, 0), cacheRead: external.reduce((sum, lane) => sum + lane.cacheRead, 0) };
  return view;
}
