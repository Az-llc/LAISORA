import * as l10n from "@vscode/l10n";
import type { TaskStatus } from "./work-model";
import type { PlanContext } from "./protocol";
import type { AgentSpanView, BackgroundTaskSpanView, ConductorModel, MainModelSpan, PlanBlockStepView, RequestBlockView, TimeBucketInterval, TimeBucketView } from "./time-buckets";

export interface PlanFrameMembers { agents: AgentSpanView[]; bgTasks: BackgroundTaskSpanView[] }

export interface PlanFrameRow {
  key: string;
  kind: "block" | "item";
  block: RequestBlockView;
  // Item rows carry the step with its non-reply conductor intervals, as GRAPH draws them.
  item?: PlanBlockStepView;
  number: string;
  title: string;
  members: PlanFrameMembers;
  conductorWork: TimeBucketInterval[];
  conductorModels: ConductorModel[];
  // 00 only: the moments routed to it; conductorOpenFrom is where its open tail route starts.
  conductorSpans?: PlanSpan[];
  conductorOpenFrom?: number;
  conductorTail?: number;
}

export interface PlanSpan { start: number; end: number }

// Non-overlapping, sorted by start; rows are frame row keys. The last route may end at Infinity (open tail).
export interface PlanRoute { start: number; end: number; turnId?: string; rows: string[] }

export interface PlanFrame { rows: PlanFrameRow[]; unplaced: PlanFrameMembers; routes: PlanRoute[] }

export const planItemRowKey = (blockId: string, stepKey: string): string => `item:${blockId}:${stepKey}`;
// The one 00 of the generation: moments with no item in progress and every block without items share it.
export const PLAN_UNPLANNED_ROW_KEY = "item:unplanned";
const planItemsOf = (block: Pick<RequestBlockView, "kind" | "steps">): PlanBlockStepView[] => block.kind === "plan" ? block.steps ?? [] : [];

export const UNMEASURED_LABEL = "—";

export interface ConductorModelPart<T> { model: ConductorModel | null; intervals: T[] }

export function splitByConductorModel<T extends { start: number; end: number }>(spans: readonly MainModelSpan[] | undefined,
  intervals: readonly T[]): ConductorModelPart<T>[] {
  const sorted = [...spans ?? []].sort((a, b) => a.start - b.start);
  const parts = new Map<string, ConductorModelPart<T>>();
  const put = (span: MainModelSpan | undefined, interval: T) => {
    const key = span === undefined ? "" : JSON.stringify([span.model, span.effort ?? null]);
    let part = parts.get(key);
    if (part === undefined) parts.set(key, part = { model: span === undefined ? null : { model: span.model, ...(span.effort ? { effort: span.effort } : {}) }, intervals: [] });
    part.intervals.push(interval);
  };
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    let low = 0, high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle].start <= interval.start) low = middle + 1;
      else high = middle;
    }
    let cursor = interval.start;
    for (let index = low - 1; cursor < interval.end; index++) {
      const end = Math.min(interval.end, sorted[index + 1]?.start ?? Infinity);
      if (end > cursor) put(sorted[index], { ...interval, start: cursor, end });
      cursor = Math.max(cursor, end);
    }
  }
  return [...parts.values()];
}

export function conductorModelAtEnd(spans: readonly MainModelSpan[] | undefined, intervals: readonly { start: number; end: number }[]): ConductorModel | null {
  let last: { end: number; model: ConductorModel | null } | undefined;
  for (const part of splitByConductorModel(spans, intervals)) for (const piece of part.intervals) if (last === undefined || piece.end >= last.end) last = { end: piece.end, model: part.model };
  return last?.model ?? null;
}

export function conductorModelsDuring(spans: readonly MainModelSpan[] | undefined, intervals: readonly { start: number; end: number }[]): ConductorModel[] {
  return splitByConductorModel(spans, intervals).flatMap(part => part.model === null ? [] : [part.model]);
}

// The two-digit label of a PLAN item or row number, shared by every screen and the delegation guard.
export function planItemLabel(number: number): string {
  return String(number).padStart(2, "0");
}

// The one routing decision GRAPH and ANALYSIS share: each moment belongs to the frame rows its blocks' attribution names,
// a block's empty key list naming the 00.
function planRoutes(blocks: readonly RequestBlockView[]): PlanRoute[] {
  const routes: PlanRoute[] = [];
  const segmentsOf = blocks.map(block => block.conductorAttribution ?? []);
  // A zero-width segment owns everything after the newest observation; older ones were superseded.
  const horizon = segmentsOf.reduce((latest, segments) => segments.reduce((value, segment) => Math.max(value, segment.end), latest), -Infinity);
  blocks.forEach((block, i) => {
    for (const segment of segmentsOf[i]) {
      const open = segment.start === segment.end;
      if (open && segment.start !== horizon) continue;
      routes.push({ start: segment.start, end: open ? Infinity : segment.end, ...(segment.turnId === undefined ? {} : { turnId: segment.turnId }),
        rows: segment.keys.length ? segment.keys.map(key => planItemRowKey(block.blockId, key)) : [PLAN_UNPLANNED_ROW_KEY] });
    }
  });
  const points = [...new Set(routes.flatMap(route => [route.start, route.end]))].sort((a, b) => a - b);
  const pieces: PlanRoute[] = points.slice(0, -1).map((start, i) => ({ start, end: points[i + 1], rows: [] }));
  for (const route of routes) {
    for (let i = lowerBound(points, route.start); i < pieces.length && pieces[i].start < route.end; i++) {
      const piece = pieces[i];
      for (const row of route.rows) if (!piece.rows.includes(row)) piece.rows.push(row);
      if (piece.turnId === undefined && route.turnId !== undefined) piece.turnId = route.turnId;
    }
  }
  return pieces.filter(piece => piece.rows.length > 0);
}

function lowerBound(sorted: readonly number[], at: number): number {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < at) low = mid + 1;
    else high = mid;
  }
  return low;
}

function routeIndexAt(routes: readonly PlanRoute[], at: number): number {
  let low = 0, high = routes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (routes[mid].start <= at) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

export function planRowsAt(routes: readonly PlanRoute[], at: number): string[] {
  const route = routes[routeIndexAt(routes, at)];
  return route !== undefined && at < route.end ? route.rows : [];
}

// Each row receives the whole overlap of [start, end) with the moments routed to it; covered is the routed part of the span.
export function planRowTime(routes: readonly PlanRoute[], start: number, end: number): { rows: Map<string, number>; covered: number } {
  const rows = new Map<string, number>();
  let covered = 0;
  for (let i = Math.max(0, routeIndexAt(routes, start)); i < routes.length && routes[i].start < end; i++) {
    const overlap = Math.min(end, routes[i].end) - Math.max(start, routes[i].start);
    if (overlap <= 0) continue;
    covered += overlap;
    for (const row of routes[i].rows) rows.set(row, (rows.get(row) ?? 0) + overlap);
  }
  return { rows, covered };
}

// GRAPH (src/webview/work-graph.ts#WorkGraph.buildRows) and ANALYSIS (src/role-summary.ts#deriveAnalysisPlans)
// both take their blocks, order, rows, 00, numbers, titles, members and routing from here.
export function planFrame(view: Pick<TimeBucketView, "blocks" | "agents" | "backgroundTasks" | "intervals" | "mainModelSpans">): PlanFrame {
  const rows: PlanFrameRow[] = [];
  const placed = new Set<string>();
  const take = (pick: (owner: { blockId?: string; stepKey?: string }) => boolean): PlanFrameMembers => {
    const agents = (view.agents ?? []).filter(a => !placed.has(`agent:${a.toolUseId}`) && pick(a));
    const bgTasks = (view.backgroundTasks ?? []).filter(bg => !placed.has(`bg:${bg.toolUseId}`) && pick(bg));
    for (const a of agents) placed.add(`agent:${a.toolUseId}`);
    for (const bg of bgTasks) placed.add(`bg:${bg.toolUseId}`);
    return { agents, bgTasks };
  };
  const routes = planRoutes(view.blocks);
  const conductorWork = planConductorWork(view, routes);
  const lead: PlanFrameMembers = { agents: [], bgTasks: [] };
  let leadBlock: RequestBlockView | undefined;
  let leadTail: number | undefined;
  for (const block of view.blocks) {
    const items = planItemsOf(block);
    const byItem = items.map(item => take(owner => owner.blockId === block.blockId && owner.stepKey === item.key));
    const own = take(owner => owner.blockId === block.blockId);
    lead.agents.push(...own.agents);
    lead.bgTasks.push(...own.bgTasks);
    // The 00 belongs to the latest block that sends anything to it; its liveness follows that block.
    if (items.length === 0 || own.agents.length > 0 || own.bgTasks.length > 0 || (block.conductorAttribution ?? []).some(segment => segment.keys.length === 0)) leadBlock = block;
    if (block.conductorTail != null) leadTail = block.conductorTail;
    items.forEach((step, index) => {
      const work = conductorWork.get(planItemRowKey(block.blockId, step.key)) ?? [];
      rows.push({ key: planItemRowKey(block.blockId, step.key), kind: "item", block, number: planItemLabel(step.number), title: step.title,
        item: { ...step, conductorIntervals: work.filter(interval => interval.bucket !== "reply") }, members: byItem[index], conductorWork: work,
        conductorModels: conductorModelsDuring(view.mainModelSpans, work) });
    });
  }
  // 00 exists whenever a moment routes to it (so work, usage, tool calls and runs there always have a row) or a member is placed on it.
  const unplanned = routes.filter(route => route.rows.includes(PLAN_UNPLANNED_ROW_KEY));
  const anchor = leadBlock ?? view.blocks.find(block => planItemsOf(block).length > 0);
  if (anchor !== undefined && (unplanned.length > 0 || lead.agents.length > 0 || lead.bgTasks.length > 0)) {
    const open = unplanned.find(route => route.end === Infinity);
    rows.unshift({ key: PLAN_UNPLANNED_ROW_KEY, kind: "item", block: anchor, number: "00", title: l10n.t("Unplanned work"),
      members: lead, conductorWork: conductorWork.get(PLAN_UNPLANNED_ROW_KEY) ?? [],
      conductorModels: conductorModelsDuring(view.mainModelSpans, conductorWork.get(PLAN_UNPLANNED_ROW_KEY) ?? []),
      conductorSpans: unplanned.map(route => ({ start: route.start, end: route.end === Infinity ? route.start : route.end })),
      ...(open === undefined ? {} : { conductorOpenFrom: open.start }),
      ...(leadTail === undefined ? {} : { conductorTail: leadTail }) });
  }
  return { rows, unplaced: take(() => true), routes };
}

// A view is live while a block runs or a member is still open; rows' open parts follow "now" only then.
export function planLive(view: Pick<TimeBucketView, "blocks" | "agents" | "backgroundTasks">): boolean {
  return view.blocks.some(block => block.running) || (view.agents ?? []).some(agent => agent.open)
    || (view.backgroundTasks ?? []).some(task => task.open);
}

// One "now" for GRAPH and ANALYSIS: it follows the clock while the screen's conversation turn runs (the webview learns a
// turn's state before the time view catches up), or, without a screen, while the view is live; otherwise it stops at the
// last observation.
export function planNow(view: Pick<TimeBucketView, "blocks" | "agents" | "backgroundTasks" | "lastAt">, clockMs?: number,
  running = planLive(view)): number {
  const lastAt = view.lastAt ?? -Infinity;
  return running && clockMs !== undefined && clockMs > lastAt ? clockMs : lastAt;
}

export function planMemberEnd(member: { open?: boolean; end: number }, now: number, live: boolean): number {
  return member.open && live ? Math.max(member.end, now) : member.end;
}

// spans: the merged parts at this now, sorted; GRAPH draws them, start and end bound them.
export interface PlanRowPeriod { start: number; end: number; running: boolean; spans: PlanSpan[] }

// The period and liveness both screens show for a row; undefined is "nothing started". A part is open (its end follows
// now) while the view is live and the part still runs: the running block, the 00 tail, an item in progress, an open member.
// An item's parts are its in-progress spans (src/plan-steps.ts#planStepActiveSpans), 00's the moments routed to it.
export function planRowPeriod(row: Pick<PlanFrameRow, "kind" | "block" | "item" | "members" | "conductorSpans" | "conductorOpenFrom" | "conductorTail">,
  now: number, live: boolean): PlanRowPeriod | undefined {
  const block = row.block;
  const blockOpen = live && block.running;
  const parts: { start: number; end: number; open: boolean }[] = [];
  const item = row.item;
  if (row.kind === "block") parts.push({ start: block.anchorAt, end: block.end, open: blockOpen });
  else if (item === undefined) {
    for (const span of row.conductorSpans ?? []) parts.push({ ...span, open: false });
    if (row.conductorTail !== undefined && blockOpen) parts.push({ start: row.conductorOpenFrom ?? row.conductorTail, end: block.end, open: true });
  } else if (item.startedAt !== null) {
    const inProgress = item.status === "in_progress" && item.endedAt === null && !item.removed || item.conductorTail != null;
    const spans = item.activeSpans ?? [{ start: item.startedAt, end: item.end ?? block.end }];
    spans.forEach((span, index) => parts.push({ ...span, open: live && inProgress && index === spans.length - 1 }));
  }
  // A block row is its own window: its members have their own rows, and stretching it would draw later blocks' work on it.
  if (row.kind === "item") for (const member of [...row.members.agents, ...row.members.bgTasks]) {
    parts.push({ start: member.start, end: member.end, open: live && member.open === true });
  }
  if (parts.length === 0) return undefined;
  const resolved = parts.map(part => ({ start: part.start, end: part.open ? Math.max(part.end, now) : part.end })).sort((a, b) => a.start - b.start);
  const spans = mergePlanSpans(resolved.filter(part => part.end > part.start));
  return { start: resolved[0].start, end: Math.max(...resolved.map(part => part.end)), running: parts.some(part => part.open),
    spans: spans.length > 0 ? spans : [{ start: resolved[0].start, end: Math.max(...resolved.map(part => part.end)) }] };
}

// Sorted by start; touching or overlapping spans become one.
function mergePlanSpans(sorted: readonly PlanSpan[]): PlanSpan[] {
  const merged: PlanSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

export function planSpansMs(spans: readonly PlanSpan[]): number {
  return spans.reduce((sum, span) => sum + span.end - span.start, 0);
}

export function planRowIndexAt(rows: ReadonlyArray<{ kind: string; item?: unknown; period?: Pick<PlanRowPeriod, "spans"> }>, t: number): number {
  const heads = rows.flatMap((row, k) => row.kind === "item" ? [{ row, k }] : []);
  for (const candidates of [heads.filter(({ row }) => row.item !== undefined), heads]) {
    let last = -1;
    let lastStart = Number.NEGATIVE_INFINITY;
    for (const { row, k } of candidates) {
      for (const { start, end } of row.period?.spans ?? []) {
        if (start <= t && t < end) return k;
        if (start <= t && start > lastStart) {
          lastStart = start;
          last = k;
        }
      }
    }
    if (last >= 0) return last;
  }
  return heads[0]?.k ?? 0;
}

// A step's in-progress spans from its transitions, each running to the next transition or to end; re-sent in_progress
// continues the span it is in.
export function planStepActiveSpans(transitions: readonly PlanStepTransition[], end: number): PlanSpan[] {
  return mergePlanSpans(transitions.flatMap((change, index) => change.active
    ? [{ start: change.at, end: Math.max(change.at, Math.min(transitions[index + 1]?.at ?? end, end)) }] : []));
}

// A period computed at an earlier "now", shown at a later one.
export function planPeriodEnd(period: Pick<PlanRowPeriod, "end" | "running">, now: number): number {
  return period.running ? Math.max(period.end, now) : period.end;
}

// Conductor work runs on a row now while the row is live and the conductor's open turn is attributed to it; an open
// member alone keeps the row running but not its Conductor.
export function planConductorRunning(row: Pick<PlanFrameRow, "item" | "conductorTail">, period: PlanRowPeriod | undefined): boolean {
  return period?.running === true && (row.item?.conductorTail ?? row.conductorTail) != null;
}

export function planRowProvisional(row: Pick<PlanFrameRow, "block" | "item">, period: PlanRowPeriod | undefined): boolean {
  return period?.running === true || (row.item !== undefined ? row.item.provisional === true : row.block.metrics?.provisional === true);
}

// Main-lane work per frame row key, routed from the view's intervals only (an overlay carries its live part there too).
function planConductorWork(view: Pick<TimeBucketView, "blocks" | "intervals">, routes: readonly PlanRoute[]): Map<string, TimeBucketInterval[]> {
  const result = new Map<string, TimeBucketInterval[]>();
  const add = (row: string, interval: TimeBucketInterval) => {
    const list = result.get(row) ?? [];
    list.push(interval);
    result.set(row, list);
  };
  let first = 0;
  for (const interval of (view.intervals ?? []).filter(interval => interval.lane === "main").sort((a, b) => a.start - b.start)) {
    while (first < routes.length && routes[first].end <= interval.start) first++;
    for (let i = first; i < routes.length && routes[i].start < interval.end; i++) {
      const route = routes[i];
      const start = Math.max(route.start, interval.start), end = Math.min(route.end, interval.end);
      if (end <= start) continue;
      for (const row of route.rows) add(row, { bucket: interval.bucket, lane: "main", start, end, ...(route.turnId === undefined ? {} : { turnId: route.turnId }) });
    }
  }
  return result;
}

export function normalizePlanContent(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " "); }

export function planStepKey(entry: { source?: "tasks" }, item: { taskKey: string; description: string }): string {
  return (entry.source === "tasks" || item.taskKey.startsWith("task:")) ? `task\n${item.taskKey}` : normalizePlanContent(item.description);
}

const TASK_STEP_KEY_RE = /^task\ntask:(\d+)$/;
const ITEM_NUMBER_PREFIX_RE = /^(\d{2,}) /;

export function planContextOf(block: { blockId: string; text: string; start: number; goal?: string; steps?: ReadonlyArray<PlanStepTiming & { number: number; activeSpans?: PlanSpan[] }>;
  metrics?: { tokens?: PlanContext["tokens"] } }, end: number, running: boolean): PlanContext {
  return { blockId: block.blockId, text: block.text, start: block.start, ...(block.goal === undefined ? {} : { goal: block.goal }),
    ...(block.metrics?.tokens === undefined ? {} : { tokens: block.metrics.tokens }),
    steps: (block.steps ?? []).map(({ key, number, title, status, removed, startedAt, endedAt, activeSpans }) =>
      ({ key, number, title, status, removed, startedAt, endedAt, ...(activeSpans === undefined ? {} : { activeSpans }) })),
    end: Math.max(block.start, end), running };
}

export function planItemNumber(seen: string[], key: string): number {
  if (!seen.includes(key)) seen.push(key);
  const id = TASK_STEP_KEY_RE.exec(key)?.[1];
  return id !== undefined ? Number(id) : seen.indexOf(key) + 1;
}

export function planItemNumberOf(description: string | undefined): number | undefined {
  const digits = description === undefined ? undefined : ITEM_NUMBER_PREFIX_RE.exec(description)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// The item a numbered launch names: the newest block open at the launch that holds that number.
export function planNumberedStep<S extends { number: number }>(blocks: readonly { start: number; closedAt?: number; steps?: readonly S[] }[],
  number: number, at: number): { blockIndex: number; step: S } | undefined {
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
    const block = blocks[blockIndex];
    if (block.start > at || block.closedAt !== undefined && at >= block.closedAt) continue;
    const step = block.steps?.filter(value => value.number === number).at(-1);
    if (step !== undefined) return { blockIndex, step };
  }
  return undefined;
}

export interface PlanStepTiming {
  key: string; title: string; status: TaskStatus; removed: boolean;
  startedAt: number | null; endedAt: number | null;
}
export interface PlanStepTransition { at: number; active: boolean; order: number }

export function transitionPlanStep(step: PlanStepTiming, at: number, status: TaskStatus, removed = false): boolean {
  if (removed) {
    step.removed = true;
    if (step.startedAt !== null && step.endedAt === null) step.endedAt = at;
    return true;
  }
  const changed = step.status !== status || step.removed;
  if (changed) {
    if (status === "in_progress") { step.startedAt ??= at; step.endedAt = null; }
    else if (status === "completed" || step.status === "in_progress" && !step.removed) step.endedAt = at;
  }
  step.status = status;
  step.removed = false;
  return changed;
}

