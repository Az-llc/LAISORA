import { toolIntentLabel } from "./status-line";
import { agentElapsedMs, externalRunEndStatus, flattenAgents, planLaneTokens, workEndStatus, type OrchestrationView, type PlanContext, type PlanContextStep, type PlanContextTokens, type PlanContextWork, type WorkAgentNode, type WorkEndStatus, type WorkModelPayload } from "../protocol";
import type { TaskStatus } from "../work-model";
import { planHeading } from "../plan-steps";
export { normalizePlanContent, planStepKey } from "../plan-steps";

export interface PlanLane {
  id: string; agent: string; title: string; start: number | null; elapsed: number | null;
  status: WorkEndStatus; tokens: number | null; tokensPartial?: boolean; cacheRead: number | null; contextTokens?: number; external: boolean;
  resumedAt?: number; description?: string;
}
export interface PlanStep {
  key: string; number: number | null; title: string; activeForm?: string; status: TaskStatus;
  removed: boolean; added: boolean; addedAt: number | null; ahead: boolean;
  startedAt: number | null; endedAt: number | null; work: PlanContextWork | null;
  period?: PlanContextStep["period"];
  tokens: PlanContextTokens | null; lanes: PlanLane[];
}
export interface PlanView {
  block?: string; goal: string; goalDeclared: boolean; name: string; steps: PlanStep[]; now: PlanLane[]; current: number | null; completed: number;
  work: PlanContextWork | null; workProvisional: boolean; claude: PlanContextTokens | null; external: PlanContextTokens | null; externalRunCount: number; partial: boolean;
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

export function planAllStepsDone(view: PlanView, earlier: readonly PlanView[]): boolean {
  return view.steps.length > 0 && [view, ...earlier].every(plan => plan.steps.every(planStepSettled));
}

export function planStepCounted(step: { removed: boolean; number: number | null }): boolean {
  return !step.removed && step.number !== null;
}

export function planStepCount(view: PlanView, earlier: readonly PlanView[]): { position: number; total: number } | undefined {
  const steps = [...earlier, view].flatMap(plan => plan.steps.filter(planStepCounted));
  if (!steps.length) return undefined;
  const current = planCurrentStep(view, earlier);
  const index = current === undefined ? -1 : steps.indexOf(current);
  return { position: index >= 0 ? index + 1 : steps.filter(planStepDone).length, total: steps.length };
}

export function planCurrentStep(view: PlanView, earlier: readonly PlanView[]): PlanStep | undefined {
  for (const plan of [view, ...[...earlier].reverse()]) {
    const step = plan.current === null ? undefined : plan.steps.find(value => value.number === plan.current);
    if (step !== undefined) return step;
  }
  return undefined;
}

export function deriveEarlierPlanViews(model: WorkModelPayload | undefined, orchestration: OrchestrationView | undefined,
  nowMs: number): PlanView[] {
  return (model?.earlierPlans ?? []).map(context => derivePlanView(model, orchestration, nowMs, context));
}

export function derivePlanView(model: WorkModelPayload | undefined, orchestration: OrchestrationView | undefined,
  nowMs: number, context: PlanContext | undefined = model?.planContext): PlanView {
  const heading = context === undefined ? undefined : planHeading(context);
  const view: PlanView = { block: context?.blockId, goal: heading?.text ?? "", goalDeclared: heading?.declared ?? false, name: context?.text ?? "", steps: [], now: [], current: null,
    completed: 0, work: context?.work ?? null,
    workProvisional: context?.work?.provisional === true,
    claude: null, external: null, externalRunCount: 0, partial: model?.coverage.summary === "prefix-truncated" };
  const unit = context ?? { start: Number.POSITIVE_INFINITY, end: nowMs, running: false, steps: [] };
  view.steps = (unit.steps ?? []).map(record => ({ key: record.key, number: record.number, title: record.title,
    ...(record.activeForm === undefined ? {} : { activeForm: record.activeForm }), status: record.status, removed: record.removed,
    added: record.added === true, addedAt: record.addedAt ?? null, ahead: false, startedAt: record.startedAt, endedAt: record.endedAt,
    period: record.period, tokens: record.tokens ?? null, work: record.work ?? null, lanes: [] }));
  if (view.steps.length > 0 && context !== undefined && model?.planHistoryLostThrough !== undefined && model.planHistoryLostThrough >= context.start) view.partial = true;
  const resumes = new Map<string, Array<{ at: number; status: WorkEndStatus; endedAt?: number }>>();
  if (view.steps.length) for (const entry of model?.planHistory ?? []) {
    if (entry.kind === "resume") resumes.set(entry.agentId, [...resumes.get(entry.agentId) ?? [], { at: entry.at, status: entry.status, endedAt: entry.endedAt }]);
  }
  const latest = model?.planContext;
  const runningUntil = context === undefined || latest?.running ? Math.max(nowMs, unit.end, latest?.end ?? unit.end) : latest?.end ?? unit.end;
  const shownEarlier = new Set((context?.blockId === latest?.blockId ? model?.earlierPlans ?? [] : []).flatMap(earlier =>
    (earlier.placements ?? []).filter(placement => placement.stepKey !== null)
      .map(placement => placement.toolUseId)));
  const resumeSteps = new Map((context?.placements ?? []).flatMap(placement => placement.resumes === undefined ? []
    : [[placement.toolUseId, new Map(placement.resumes.map(resume => [resume.at, resume]))] as const]));
  const runTokens = new Map((context?.placements ?? []).flatMap(placement => placement.runTokens === undefined ? []
    : [[placement.toolUseId, placement.runTokens] as const]));
  const laneTokens = (tokens: PlanContextTokens | null): Pick<PlanLane, "tokens" | "tokensPartial" | "cacheRead"> =>
    ({ tokens: tokens?.tokens ?? null, ...(tokens?.partial ? { tokensPartial: true } : {}), cacheRead: tokens?.cacheRead ?? null });
  const agents = flattenAgents(model?.phases ?? [], model?.unlinkedAgents);
  const nodes = new Map(agents.map(agent => [agent.agentId, agent]));
  const segmentEnd = (agentId: string, position: number): { status: WorkEndStatus; endedAt?: number } => {
    const next = resumes.get(agentId)![position + 1];
    const node = nodes.get(agentId);
    return next ?? (node ? { status: workEndStatus(node), endedAt: node.endedAt } : { status: "unknown" });
  };
  // The Host places every lane and allocates step tokens (src/role-summary.ts#derivePlanPlacement); a lane it did not
  // place is not on a step.
  const byToolUseId = new Map((context?.placements ?? []).map(placement => [placement.toolUseId, placement.stepKey]));
  const byAgentId = new Map((context?.placements ?? []).flatMap(placement => placement.agentId === undefined ? [] : [[placement.agentId, placement.stepKey] as const]));
  const current = view.steps.find(step => !step.removed && step.status === "in_progress");
  view.current = current?.number ?? null;
  const unitUntil = unit.running ? Math.max(nowMs, unit.end) : unit.end;
  for (const step of view.steps) {
    step.ahead = !step.removed && step.status === "in_progress" && current !== undefined && view.steps.indexOf(step) > view.steps.indexOf(current);
  }
  view.completed = view.steps.filter(planStepDone).length;
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
  const counted = context?.counted === undefined ? undefined : new Set(context.counted);
  const visit = (agent: WorkAgentNode): void => {
    const measures = counted === undefined || counted.has(agent.toolUseId) ? agent.roleRun : undefined;
    const resumed = resumes.get(agent.agentId);
    const runs = agent.toolUseId === undefined ? undefined : runTokens.get(agent.toolUseId);
    const drawn = new Set<number>();
    const lane: PlanLane = { id: `agent:${agent.transcriptAgentId ?? agent.agentId}`, agent: agent.role ?? agent.agentType ?? agent.modelMeasured ?? agent.modelDeclared ?? "Claude",
      title: agent.status === "running" && agent.intentInput ? toolIntentLabel("Agent", agent.intentInput) : agent.description, start: agent.startedAt ?? null,
      elapsed: agent.status === "running" && agent.startedAt !== undefined && (context === undefined || unit.running)
        ? agentElapsedMs(agent, nowMs)
        : agent.status === "running" ? agent.elapsedMs : agent.roleRun?.elapsedMs ?? null,
      status: workEndStatus(agent), ...(runs !== undefined ? { tokens: null, cacheRead: null }
        : { tokens: measures?.tokens ?? null, ...(measures?.tokensPartial ? { tokensPartial: true } : {}), cacheRead: measures?.cacheRead ?? null }),
      ...(agent.tokens === undefined ? {} : { contextTokens: agent.tokens }), external: false,
      ...(agent.description ? { description: agent.description } : {}) };
    const owner = { toolUseId: agent.toolUseId, agentId: agent.transcriptAgentId ?? agent.agentId };
    const launch = resumed === undefined ? lane : { ...lane, title: agent.description, status: resumed[0].status,
      elapsed: resumed[0].endedAt === undefined || agent.startedAt === undefined ? null : Math.max(0, resumed[0].endedAt - agent.startedAt) };
    const placed = attach(launch, owner);
    if (resumed) {
      const elsewhere = placed === undefined && agent.toolUseId !== undefined && shownEarlier.has(agent.toolUseId);
      const own = agent.toolUseId === undefined ? undefined : resumeSteps.get(agent.toolUseId);
      resumed.forEach(({ at }, position) => {
        if (own === undefined ? elsewhere : !own.has(at)) return;
        const ownResume = own?.get(at);
        const ownKey = ownResume?.stepKey;
        const lanes = own === undefined ? placed : ownKey == null ? undefined : view.steps.find(value => value.key === ownKey)?.lanes;
        const id = `${lane.id}:resume:${at}`;
        const end = segmentEnd(agent.agentId, position);
        const until = end.status === "running" ? runningUntil : end.endedAt;
        const segment: PlanLane = { ...lane, id, title: agent.description, start: at, resumedAt: at, status: end.status,
          elapsed: until === undefined ? null : Math.max(0, until - at), tokensPartial: false, contextTokens: undefined,
          ...laneTokens(runs === undefined ? null : planLaneTokens(runs, drawn).resume(at)) };
        if (seen.has(id) || lanes === undefined && !inWindow(segment)) return;
        seen.add(id);
        drawn.add(at);
        (lanes ?? view.now).push(segment);
      });
    }
    if (runs !== undefined) Object.assign(launch, laneTokens(planLaneTokens(runs, drawn).launch));
  };
  agents.forEach(visit);
  for (const agent of orchestration?.agents ?? []) {
    attach({ id: `agent:${agent.agentId}`, agent: agent.role ?? agent.agentType ?? "Claude", title: agent.model ?? "",
      start: Date.parse(agent.firstSeenAt), elapsed: null, status: "unknown", tokens: null, cacheRead: null, external: false }, { agentId: agent.agentId });
  }
  const externalIds = new Set<string>();
  for (const [index, run] of (context?.externalRuns ?? []).entries()) {
    const id = `external:${run.toolUseId ?? index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (run.toolUseId !== undefined) externalIds.add(run.toolUseId);
    const lanes = (run.stepKey === null ? undefined : view.steps.find(value => value.key === run.stepKey))?.lanes ?? view.now;
    lanes.push({ id, agent: run.role, title: run.title, start: run.startedAt,
      elapsed: run.running && run.startedAt !== null ? Math.max(0, unitUntil - run.startedAt) : run.durationMs,
      status: externalRunEndStatus(run),
      tokens: run.tokens, cacheRead: run.cacheRead, external: true });
  }
  for (const tool of model?.planTools ?? []) if (!externalIds.has(tool.id)) attach({ id: `tool:${tool.id}`, agent: "Claude", title: toolIntentLabel(tool.name, tool.intentInput),
    start: tool.startedAt, elapsed: Math.max(0, unitUntil - tool.startedAt),
    status: "running", tokens: null, cacheRead: null, external: false }, { toolUseId: tool.id });
  view.external = context?.external ?? null;
  view.externalRunCount = context?.externalRuns?.length ?? 0;
  return view;
}
