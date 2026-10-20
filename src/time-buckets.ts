import { isObservedTime, type NormalizedEvent } from "./protocol";
import { redactAbsolutePaths } from "./path-redaction";
import { isPureCommandWrapper, INJECTED_TAG_RE, STEER_TAG_RE } from "./human-input-vocabulary";
import { isBookkeepingTool, foldPlanDeclarationText, parseTaskIntentFromRawInput, taskCreateKeyFromResult, type TaskIntent, type PlanTextState } from "./work-model";
import { planItemNumber, planItemNumberOf, planNumberedStep, planStepActiveSpans, planStepKey, transitionPlanStep, type PlanSpan, type PlanStepTiming, type PlanStepTransition } from "./plan-steps";
import type { PlanUsage, PlanTokenTotal } from "./plan-usage";
import { isExternalRunTool } from "./orchestration-executors";
import { isRejectedBeforeRun } from "./tool-result-signals";
import { conductorStopTarget } from "./tool-intent";

export type TimeBucket = "generate" | "tool" | "delegation" | "confirm" | "reply";
export type TimeLane = "main" | "sub";
export type TimeFidelity = "record" | "inherited";

export const HUMAN_INPUT_WAIT_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion"]);
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);
export function isSubagentWaitTool(toolName: string): boolean {
  return DELEGATION_TOOL_NAMES.has(toolName) || isExternalRunTool(toolName);
}
export const MAX_TIME_TOOL_INTERVALS = 8192;
export const MAX_TIME_BLOCKS = 500;
const MAX_STOPPED_TASK_IDS = 256;
export const MAX_BLOCK_TEXT = 600;
export const MAX_MODEL_MARKS = 4096;
const TASK_NOTIFICATION_MARKER = "A task-notification fires each time this agent stops";

export function isRequestMessageText(text: string): boolean {
  const human = text.trim();
  return human.length > 0 && !isPureCommandWrapper(human) && (!INJECTED_TAG_RE.test(human) || STEER_TAG_RE.test(human)) && !human.includes(TASK_NOTIFICATION_MARKER);
}

interface TurnOrigin {
  effort?: string;
}

export interface TurnSpan extends TurnOrigin {
  turnId: string;
  start: number;
  end: number;
}

export interface AppendList<T> {
  readonly buffer: T[];
  readonly size: number;
}

export function emptyAppendList<T>(): AppendList<T> {
  return { buffer: [], size: 0 };
}

function appendItem<T>(list: AppendList<T>, item: T): AppendList<T> {
  const buffer = list.buffer.length === list.size ? list.buffer : list.buffer.slice(0, list.size);
  buffer.push(item);
  return { buffer, size: list.size + 1 };
}

export function appendListItems<T>(list: AppendList<T>): T[] {
  return list.buffer.slice(0, list.size);
}

export interface KeyedLog<V> {
  readonly entries: { key: string; value: V }[];
  readonly size: number;
  readonly positions: Map<string, number[]>;
  readonly keys: string[];
  readonly keyCount: number;
}

export function emptyKeyedLog<V>(): KeyedLog<V> {
  return { entries: [], size: 0, positions: new Map(), keys: [], keyCount: 0 };
}

export function keyedGet<V>(log: KeyedLog<V>, key: string): V | undefined {
  const at = log.positions.get(key);
  if (at === undefined) return undefined;
  for (let i = at.length - 1; i >= 0; i--) if (at[i] < log.size) return log.entries[at[i]].value;
  return undefined;
}

export function keyedSet<V>(log: KeyedLog<V>, key: string, value: V): KeyedLog<V> {
  let { entries, positions, keys } = log;
  if (entries.length !== log.size) {
    entries = entries.slice(0, log.size);
    keys = keys.slice(0, log.keyCount);
    positions = new Map();
    entries.forEach((entry, i) => {
      const at = positions.get(entry.key);
      if (at === undefined) positions.set(entry.key, [i]);
      else at.push(i);
    });
  }
  let keyCount = log.keyCount;
  const at = positions.get(key);
  if (at === undefined) {
    positions.set(key, [entries.length]);
    keys.push(key);
    keyCount++;
  } else at.push(entries.length);
  entries.push({ key, value });
  return { entries, size: log.size + 1, positions, keys, keyCount };
}

export function keyedValues<V>(log: KeyedLog<V>): V[] {
  return log.keys.slice(0, log.keyCount).map(key => keyedGet(log, key)!);
}

export interface ModelMark {
  at: number;
  model: string;
}

export function pushModelMark(marks: ModelMark[], at: number, model: string, sameTurn = false): ModelMark[] {
  const last = marks[marks.length - 1];
  if (sameTurn && last !== undefined && last.model === model && at >= last.at) {
    last.at = at;
    return marks;
  }
  marks.push({ at, model });
  return marks.length > MAX_MODEL_MARKS ? marks.slice(marks.length - MAX_MODEL_MARKS) : marks;
}

export interface ToolInterval {
  toolUseId: string;
  toolName: string;
  start: number;
  end: number;
  isError: boolean;
  turnId: string;
  agentId?: string;
  rejectedBeforeRun?: true;
}

export interface DelegationSpan {
  toolUseId: string;
  turnId: string;
  startedAt: number;
  ackEndedAt?: number;
  notifiedEndedAt?: number;
  isBackground: boolean;
  lastChildAt?: number;
  transcriptAgentId?: string;
  description: string;
  subagentType?: string;
  model?: string;
  rejectedBeforeRun?: true;
}

export interface BackgroundTaskSpan {
  toolUseId: string;
  toolName: string;
  turnId: string;
  startedAt: number;
  ackAt: number;
  taskId: string;
  description: string;
  notifiedEndedAt?: number;
  staleAt?: number;
  pendingStale?: true;
}

export interface BackgroundTaskSpanView {
  toolUseId: string;
  taskId: string;
  turnId: string;
  blockId?: string;
  stepKey?: string;
  description: string;
  subagent: boolean;
  start: number;
  end: number;
  open: boolean;
  endSource: "notification" | "stale" | "open";
}

export type RequestBlockKind = "say" | "command" | "interrupt" | "plan";

export interface PlanBlockStepRecord extends PlanStepTiming {
  number: number;
  taskKey: string;
  transitions: PlanStepTransition[];
}
export interface PlanBlockMetrics {
  provisional?: boolean;
  generateMs: number | null; toolMs: number | null; subagentWaitMs: number | null; subagentOnlyMs: number | null;
  decisionWaitMs: number | null; replyWaitMs: number | null; tokens: PlanTokenTotal | null;
}
export interface PlanBlockStepView extends PlanStepTiming, PlanBlockMetrics {
  conductorIntervals?: TimeBucketInterval[];
  conductorTail?: number | null;
  number: number; end: number | null; durationMs: number | null; longest: boolean; parallel: boolean;
  activeSpans?: PlanSpan[];
}

export interface RequestBlockRecord {
  blockId: string;
  requestNumber?: string;
  kind: RequestBlockKind;
  text: string;
  start: number;
  turnId: string | null;
  goal?: string;
  closedAt?: number;
  steps?: PlanBlockStepRecord[];
  seenSteps?: string[];
  // requestId: the request's message uuid, so a request absorbed into a later block names that block.
  userMessages?: { at: number; text: string; requestId?: string }[];
}

export interface TimeBucketState {
  modelMarks?: ModelMark[];
  generationBoundaryAt?: number;
  // Blocks of earlier generations; only keeps block IDs unique across a handoff.
  earlierBlockCount?: number;
  fidelity: TimeFidelity;
  inheritedBoundaryCount: number;
  firstAt?: number;
  lastAt?: number;
  turnSpans: AppendList<TurnSpan>;
  openTurn?: TurnOrigin & { turnId: string; startedAt: number };
  openTools: Record<string, { at: number; toolName: string; lane: TimeLane; parentToolUseId: string | null; turnId: string; messageId?: string; description?: string;
    taskIntent?: TaskIntent; stopTarget?: string }>;
  // The assistant message of the latest main-lane call (src/time-buckets.ts#withMessagePlanCalls).
  mainMessageId?: string;
  // Task ids a successful conductor TaskStop ended, until their notification or a resume (src/time-buckets.ts#laneRunning).
  stoppedTaskIds?: string[];
  planText?: PlanTextState;
  mainTools: ToolInterval[];
  subTools: ToolInterval[];
  delegations: KeyedLog<DelegationSpan>;
  delegationsByAgent: KeyedLog<string[]>;
  backgroundTasks: KeyedLog<BackgroundTaskSpan>;
  backgroundByTask: KeyedLog<string[]>;
  unsettledBackground: string[];
  blocks: RequestBlockRecord[];
  numberedRequests?: NumberedRequests;
  requestNumbers: KeyedLog<RequestNumberEntry>;
  droppedIntervalCount: number;
  droppedBlockCount: number;
  // The latest request's message uuid and how many blocks its goal declarations have opened (src/time-buckets.ts#openPlanBlock).
  request?: { id: string; openings: number };
}

type NumberedRequests = readonly { requestId: string; mergedRequestIds?: readonly string[]; turnIds: readonly string[]; number: string }[];
interface RequestNumberEntry {
  number: string;
  next: string;
}

function requestNumberRoot(log: KeyedLog<RequestNumberEntry>, id: string): { id: string; entry: RequestNumberEntry } | undefined {
  let entry = keyedGet(log, id);
  for (let hops = 0; entry !== undefined && entry.next !== id && hops < log.keyCount; hops++) {
    const following = keyedGet(log, entry.next);
    if (following === undefined) break;
    id = entry.next;
    entry = following;
  }
  return entry === undefined ? undefined : { id, entry };
}

function requestNumberOf(log: KeyedLog<RequestNumberEntry>, turnId: string): string | undefined {
  return requestNumberRoot(log, `turn:${turnId}`)?.entry.number;
}

function compactRequestNumbers(log: KeyedLog<RequestNumberEntry>, state: TimeBucketState, requests: NumberedRequests): KeyedLog<RequestNumberEntry> {
  const keys = new Set<string>();
  for (const request of requests) {
    keys.add(`request:${request.requestId}`);
    for (const id of request.mergedRequestIds ?? []) keys.add(`request:${id}`);
    for (const id of request.turnIds) keys.add(`turn:${id}`);
  }
  for (const block of state.blocks) if (block.turnId !== null) keys.add(`turn:${block.turnId}`);
  if (state.openTurn !== undefined) keys.add(`turn:${state.openTurn.turnId}`);
  if (state.planText !== undefined) keys.add(`turn:${state.planText.turnId}`);
  for (const tool of Object.values(state.openTools)) keys.add(`turn:${tool.turnId}`);
  let compacted = emptyKeyedLog<RequestNumberEntry>();
  for (const key of keys) {
    const root = requestNumberRoot(log, key);
    if (root === undefined) continue;
    if (keyedGet(compacted, root.id) === undefined) compacted = keyedSet(compacted, root.id, root.entry);
    if (key !== root.id) compacted = keyedSet(compacted, key, { number: root.entry.number, next: root.id });
  }
  return compacted;
}

export function attachTimeBucketRequestNumbers(state: TimeBucketState, requests: NumberedRequests): TimeBucketState {
  if (state.numberedRequests === requests) return state;
  const numbers = new Map(requests.flatMap(request => request.turnIds.map(id => [id, request.number] as const)));
  const seen = new Set(state.numberedRequests ?? []);
  let requestNumbers = state.requestNumbers;
  let renumbered = false;
  for (const request of requests) {
    if (seen.has(request)) continue;
    const target = `request:${request.requestId}`;
    const keys = [target, ...(request.mergedRequestIds ?? []).map(id => `request:${id}`), ...request.turnIds.map(id => `turn:${id}`)];
    for (const key of keys) {
      const cached = keyedGet(requestNumbers, key);
      if (cached?.number === request.number && cached.next === target) continue;
      if (cached !== undefined) renumbered = true;
      requestNumbers = keyedSet(requestNumbers, key, { number: request.number, next: target });
    }
  }
  if (requestNumbers.size > Math.max(512, (numbers.size + requests.length + state.blocks.length) * 4)) {
    requestNumbers = compactRequestNumbers(requestNumbers, state, requests);
  }
  let changed = state.numberedRequests !== requests || requestNumbers !== state.requestNumbers;
  const blocks = state.blocks.map(block => {
    const number = block.turnId === null ? undefined
      : numbers.get(block.turnId) ?? (renumbered ? requestNumberOf(requestNumbers, block.turnId) : undefined);
    if (number === undefined || number === block.requestNumber) return block;
    changed = true;
    return { ...block, requestNumber: number };
  });
  return changed ? { ...state, blocks, numberedRequests: requests, requestNumbers } : state;
}

export function createTimeBucketState(): TimeBucketState {
  return {
    fidelity: "record",
    inheritedBoundaryCount: 0,
    turnSpans: emptyAppendList(),
    openTools: {},
    mainTools: [],
    subTools: [],
    delegations: emptyKeyedLog(),
    delegationsByAgent: emptyKeyedLog(),
    backgroundTasks: emptyKeyedLog(),
    backgroundByTask: emptyKeyedLog(),
    unsettledBackground: [],
    blocks: [],
    requestNumbers: emptyKeyedLog(),
    droppedIntervalCount: 0,
    droppedBlockCount: 0,
  };
}

function isWindowKind(kind: string): boolean {
  return kind.startsWith("tool_call_") || kind === "user_message" || kind.startsWith("turn_");
}

function isLiveEvent(event: NormalizedEvent): boolean {
  return event.provenance?.path !== "history";
}

// A block's id names what opened it: the request's message uuid (the same in the transcript and the live fold, since the
// Host sends that uuid with the message), the plan tool call, or the n-th goal declaration of a request. Only an opening
// without an identity falls back to its position, and a live opening's position is kept apart from the transcript's, so
// the two views never share an id for different blocks (src/time-buckets.ts#isPositionalLiveBlockId).
const POSITIONAL_LIVE_BLOCK_PREFIX = "block:live:";

function positionalBlockId(state: TimeBucketState, live: boolean): string {
  return `${live ? POSITIONAL_LIVE_BLOCK_PREFIX : "block:"}${(state.earlierBlockCount ?? 0) + state.blocks.length + state.droppedBlockCount + 1}`;
}

function isPositionalLiveBlockId(blockId: string): boolean {
  return blockId.startsWith(POSITIONAL_LIVE_BLOCK_PREFIX);
}

function appendWorkBlock(state: TimeBucketState, block: Omit<RequestBlockRecord, "blockId">, blockId: string): TimeBucketState {
  const blocks = [...state.blocks, { ...block, requestNumber: block.requestNumber ?? (block.turnId === null ? undefined : requestNumberOf(state.requestNumbers, block.turnId)),
    blockId }];
  const dropped = Math.max(0, blocks.length - MAX_TIME_BLOCKS);
  return { ...state, blocks: dropped ? blocks.slice(dropped) : blocks, droppedBlockCount: state.droppedBlockCount + dropped };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0];
}

function openPlanBlock(state: TimeBucketState, opening: { goal?: string; text: string; start: number; turnId: string }, live: boolean, openedBy?: string): TimeBucketState {
  const plan = { kind: "plan" as const, ...opening, steps: [], userMessages: [] };
  const last = state.blocks.at(-1);
  if (last?.kind === "say") {
    const turnId = last.turnId ?? opening.turnId;
    return { ...state, blocks: [...state.blocks.slice(0, -1), { ...plan, blockId: last.blockId, start: last.start, turnId,
      requestNumber: last.requestNumber ?? requestNumberOf(state.requestNumbers, turnId),
      userMessages: [{ at: last.start, text: firstLine(last.text), ...(state.request === undefined ? {} : { requestId: state.request.id }) }] }] };
  }
  const request = last?.kind === "plan" && last.closedAt === undefined ? last.userMessages?.at(-1) : undefined;
  if (last !== undefined && request !== undefined && request.at > last.start
    && !last.steps?.some(step => step.transitions.some(change => change.at >= request.at))) {
    state = { ...state, blocks: [...state.blocks.slice(0, -1), { ...last, userMessages: last.userMessages!.slice(0, -1) }] };
    return appendWorkBlock(state, { ...plan, start: request.at, userMessages: [request] },
      request.requestId === undefined ? positionalBlockId(state, live) : `block:${request.requestId}`);
  }
  if (openedBy !== undefined) return appendWorkBlock(state, plan, `block:${openedBy}`);
  if (state.request === undefined) return appendWorkBlock(state, plan, positionalBlockId(state, live));
  const request2 = { ...state.request, openings: state.request.openings + 1 };
  return appendWorkBlock({ ...state, request: request2 }, plan, `block:${request2.id}:${request2.openings}`);
}

function applyPlanTask(state: TimeBucketState, intent: TaskIntent, at: number, turnId: string, result: string, opener: { live: boolean; toolUseId: string }): TimeBucketState {
  let index = state.blocks.length - 1;
  if (intent.kind === "update") {
    while (index >= 0 && !state.blocks[index].steps?.some(step => step.taskKey === intent.taskKey)) index--;
    if (index < 0) return state;
  } else if (state.blocks[index]?.kind !== "plan" || state.blocks[index].closedAt !== undefined) {
    const title = intent.kind === "todo" ? intent.items.find(item => item.status !== "completed")?.description : intent.subject;
    if (!title?.trim()) return state;
    state = openPlanBlock(state, { text: redactAbsolutePaths(title), start: at, turnId }, opener.live, opener.toolUseId);
    index = state.blocks.length - 1;
  }
  const block = state.blocks[index];
  const steps = (block.steps ?? []).map(step => ({ ...step, transitions: [...step.transitions] }));
  const source = intent.kind === "todo" ? {} : { source: "tasks" as const };
  const items = intent.kind === "todo" ? intent.items : intent.kind === "create"
    ? [{ taskKey: taskCreateKeyFromResult(intent.toolUseId, result), description: intent.subject, status: intent.status }]
    : [];
  if (intent.kind === "update") {
    const existing = steps.find(step => step.taskKey === intent.taskKey)!;
    items.push({ taskKey: intent.taskKey, description: intent.subject ?? existing.title, status: intent.status ?? existing.status });
  }
  let order = steps.reduce((latest, step) => step.transitions.reduce((maximum, change) => Math.max(maximum, change.order), latest), 0);
  const present = new Set<string>();
  const seen = [...block.seenSteps ?? steps.map(step => step.key)];
  for (const item of items) {
    const key = planStepKey(source, item);
    if (present.has(key)) continue;
    present.add(key);
    const number = planItemNumber(seen, key);
    let step = steps.find(value => value.key === key);
    if (!step) {
      if (intent.kind === "todo" && item.status === "completed") continue;
      step = { key, number, taskKey: item.taskKey,
        title: redactAbsolutePaths(item.description), status: "unknown", removed: false, startedAt: null, endedAt: null, transitions: [] };
      steps.push(step);
    }
    const removed = intent.kind === "update" && intent.deleted === true;
    if (transitionPlanStep(step, at, item.status, removed)) step.transitions.push({ at, active: !removed && item.status === "in_progress", order: ++order });
    // Sending in_progress again (a TaskUpdate carrying the status, a TodoWrite listing it) selects the item for the current
    // response; a TaskUpdate without a status does not.
    else if (!removed && item.status === "in_progress" && (intent.kind !== "update" || intent.status === "in_progress")) {
      step.transitions.push({ at, active: true, order: ++order });
    }
    step.title = redactAbsolutePaths(item.description);
  }
  if (intent.kind === "todo") for (const step of steps) {
    if (present.has(step.key) || step.removed) continue;
    transitionPlanStep(step, at, step.status, true);
    step.transitions.push({ at, active: false, order: ++order });
  }
  const blocks = [...state.blocks];
  blocks[index] = { ...block, steps, seenSteps: seen, text: block.goal ?? steps.find(step => !step.removed && step.status !== "completed")?.title ?? block.text };
  return { ...state, blocks };
}

function launchDescription(event: Extract<NormalizedEvent, { kind: "tool_call_started" }>): string | undefined {
  return isExternalRunTool(event.toolName) ? event.intentInput?.description ?? event.inputSummary : event.inputSummary;
}

// The item number a delegation or external run names in its description; the launch guard and ANALYSIS placement share it.
export function launchItemNumber(event: Extract<NormalizedEvent, { kind: "tool_call_started" }>): number | undefined {
  return isSubagentWaitTool(event.toolName) ? planItemNumberOf(event.delegation?.description ?? launchDescription(event)) : undefined;
}

function pushBounded(list: ToolInterval[], item: ToolInterval, state: { droppedIntervalCount: number }): ToolInterval[] {
  const next = [...list, item];
  if (next.length > MAX_TIME_TOOL_INTERVALS) {
    state.droppedIntervalCount += next.length - MAX_TIME_TOOL_INTERVALS;
    return next.slice(next.length - MAX_TIME_TOOL_INTERVALS);
  }
  return next;
}

function withoutPendingStale(span: BackgroundTaskSpan): BackgroundTaskSpan {
  const { pendingStale: _p, ...rest } = span;
  return rest;
}

function staleOpenBackground(
  state: TimeBucketState,
  n: TimeBucketState,
  ts: number,
  pick: (span: BackgroundTaskSpan) => boolean
): TimeBucketState {
  const settled = new Set<string>();
  for (const toolUseId of state.unsettledBackground) {
    const span = keyedGet(state.backgroundTasks, toolUseId)!;
    if (span.notifiedEndedAt !== undefined || span.staleAt !== undefined || !pick(span)) continue;
    n.backgroundTasks = keyedSet(n.backgroundTasks, toolUseId, { ...withoutPendingStale(span), staleAt: ts });
    settled.add(toolUseId);
  }
  if (settled.size > 0) n.unsettledBackground = n.unsettledBackground.filter(id => !settled.has(id));
  return n;
}

function putDelegation(n: TimeBucketState, from: KeyedLog<DelegationSpan>, d: DelegationSpan): void {
  const before = keyedGet(from, d.toolUseId);
  n.delegations = keyedSet(from, d.toolUseId, d);
  if (d.transcriptAgentId !== undefined && d.transcriptAgentId !== before?.transcriptAgentId) {
    n.delegationsByAgent = keyedSet(n.delegationsByAgent, d.transcriptAgentId,
      [...keyedGet(n.delegationsByAgent, d.transcriptAgentId) ?? [], d.toolUseId]);
  }
}

function delegationOfAgent(state: TimeBucketState, agentId: string, pick: (d: DelegationSpan) => boolean): DelegationSpan | undefined {
  let found: DelegationSpan | undefined;
  let foundAt = Infinity;
  for (const toolUseId of keyedGet(state.delegationsByAgent, agentId) ?? []) {
    const d = keyedGet(state.delegations, toolUseId);
    if (d === undefined || d.transcriptAgentId !== agentId || !pick(d)) continue;
    const at = state.delegations.positions.get(toolUseId)![0];
    if (at < foundAt) {
      found = d;
      foundAt = at;
    }
  }
  return found;
}

function unsettledBackgroundOfTask(state: TimeBucketState, taskId: string): BackgroundTaskSpan | undefined {
  for (const toolUseId of keyedGet(state.backgroundByTask, taskId) ?? []) {
    const b = keyedGet(state.backgroundTasks, toolUseId)!;
    if (b.notifiedEndedAt === undefined && b.staleAt === undefined) return b;
  }
  return undefined;
}

export function foldTimeBuckets(state: TimeBucketState, event: NormalizedEvent, options?: Parameters<typeof deriveTimeBuckets>[1]): TimeBucketState {
  const ts = isObservedTime(event.timestamp) ? event.timestamp : undefined;
  let next: TimeBucketState = state;
  const touch = (): TimeBucketState => (next === state ? (next = { ...state }) : next);
  if (ts !== undefined && isWindowKind(event.kind)) {
    if (state.firstAt === undefined || ts < state.firstAt) touch().firstAt = ts;
    if (state.lastAt === undefined || ts > state.lastAt) touch().lastAt = ts;
  }

  switch (event.kind) {
    case "model_observed":
      if (ts !== undefined) touch().modelMarks = pushModelMark([...(state.modelMarks ?? [])], ts, event.model);
      return next;
    case "assistant_message_uuid":
      if (state.planText?.turnId === event.turnId) touch().planText = foldPlanDeclarationText(
        state.planText, event.turnId, { text: "", uuid: event.uuid }, event.timestamp).text;
      return next;
    case "assistant_text_delta": {
      if (ts === undefined) return next;
      const folded = foldPlanDeclarationText(state.planText, event.turnId, event.text, ts);
      touch().planText = folded.text;
      if (folded.declarations.length) {
        touch().firstAt = Math.min(next.firstAt ?? ts, ts);
        touch().lastAt = Math.max(next.lastAt ?? ts, ts);
      }
      for (const declaration of folded.declarations) {
        const goal = redactAbsolutePaths(declaration.goal).trim();
        if (!goal) continue;
        const current = next.blocks.at(-1);
        if (current?.kind === "plan" && !current.goal && current.closedAt === undefined && !current.userMessages?.some(message => message.at > current.start)) {
          next = { ...next, blocks: [...next.blocks.slice(0, -1), { ...current, goal, text: goal }] };
        } else next = openPlanBlock(next, { goal, text: goal, start: ts, turnId: event.turnId }, isLiveEvent(event));
      }
      return next;
    }
    case "compact_boundary": {
      if (event.priorGeneration !== true || ts === undefined) return next;
      return { ...createTimeBucketState(), generationBoundaryAt: ts, fidelity: state.fidelity, inheritedBoundaryCount: state.inheritedBoundaryCount,
        droppedBlockCount: state.droppedBlockCount, earlierBlockCount: (state.earlierBlockCount ?? 0) + next.blocks.length,
        ...(state.request === undefined ? {} : { request: state.request }),
        requestNumbers: state.requestNumbers, ...(state.numberedRequests === undefined ? {} : { numberedRequests: state.numberedRequests }) };
    }
    case "background_tasks": {
      const alive = new Set(event.tasks.filter((t) => t.ambient !== true).map((t) => t.id));
      let n0: TimeBucketState | undefined;
      for (const toolUseId of state.unsettledBackground) {
        const span = keyedGet(state.backgroundTasks, toolUseId)!;
        if (span.notifiedEndedAt !== undefined || span.staleAt !== undefined) continue;
        const gone = !alive.has(span.taskId);
        if (gone === (span.pendingStale === true)) continue;
        n0 ??= touch();
        n0.backgroundTasks = keyedSet(n0.backgroundTasks, span.toolUseId, gone ? { ...span, pendingStale: true } : withoutPendingStale(span));
      }
      return n0 ?? next;
    }
    case "turn_started": {
      if (ts !== undefined) {
        state = staleOpenBackground(state, touch(), ts, (span) => span.pendingStale === true);
      }
      const n = touch();
      if (isLiveEvent(event)) {
        n.inheritedBoundaryCount = state.inheritedBoundaryCount + 1;
        n.fidelity = "inherited";
      }
      if (ts === undefined) return n;
      if (state.openTurn !== undefined) {
        n.turnSpans = appendItem(state.turnSpans, { ...state.openTurn, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, ts) });
      }
      const pending = n.blocks.at(-1);
      if (pending?.turnId === null) n.blocks = [...n.blocks.slice(0, -1), { ...pending, turnId: event.turnId }];
      n.openTurn = { turnId: event.turnId, startedAt: ts, ...(options?.appliedEffort ? { effort: options.appliedEffort } : {}) };
      return n;
    }
    case "conversation_closed": {
      if (ts === undefined) return next;
      return staleOpenBackground(state, touch(), ts, () => true);
    }
    case "turn_completed":
    case "turn_interrupted":
    case "turn_failed": {
      if (ts !== undefined && event.kind !== "turn_completed") {
        state = staleOpenBackground(state, touch(), ts, () => true);
      }
      if (state.openTurn === undefined || ts === undefined) return next;
      const n = touch();
      n.turnSpans = appendItem(state.turnSpans, { ...state.openTurn, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, ts) });
      n.openTurn = undefined;
      return n;
    }
    case "user_message": {
      if (ts === undefined) return next;
      if (!isRequestMessageText(event.text)) return next;
      const current = state.blocks.at(-1);
      const requestId = event.uuid;
      touch().request = requestId === undefined ? undefined : { id: requestId, openings: 0 };
      if (current?.kind === "plan" && current.closedAt === undefined) {
        next.blocks = [...state.blocks.slice(0, -1), { ...current, userMessages: [...current.userMessages ?? [],
          { at: ts, text: redactAbsolutePaths(event.text.trim().split(/\r?\n/, 1)[0]).slice(0, MAX_BLOCK_TEXT), ...(requestId === undefined ? {} : { requestId }) }] }];
        return next;
      }
      const n = touch();
      const text = redactAbsolutePaths(event.text.trim()).slice(0, MAX_BLOCK_TEXT);
      const block: RequestBlockRecord = {
        blockId: requestId === undefined ? positionalBlockId(state, isLiveEvent(event)) : `block:${requestId}`,
        kind: "say",
        text,
        start: ts,
        turnId: event.turnId ?? state.openTurn?.turnId ?? null,
      };
      let blocks = [...state.blocks, block];
      if (blocks.length > MAX_TIME_BLOCKS) {
        n.droppedBlockCount = state.droppedBlockCount + (blocks.length - MAX_TIME_BLOCKS);
        blocks = blocks.slice(blocks.length - MAX_TIME_BLOCKS);
      }
      n.blocks = blocks;
      return n;
    }
    case "tool_call_started": {
      if (ts === undefined) return next;
      const n = touch();
      const lane: TimeLane = event.parentToolUseId === null ? "main" : "sub";
      const summary = launchDescription(event);
      let taskIntent = event.taskIntentStructured;
      if (!taskIntent && lane === "main" && ["TodoWrite", "TaskCreate", "TaskUpdate"].includes(event.toolName)) {
        try { taskIntent = parseTaskIntentFromRawInput(event.toolName, JSON.parse(event.inputPreview), event.toolUseId); }
        catch { taskIntent = undefined; }
      }
      const stopTarget = lane === "main" ? conductorStopTarget(event.toolName, event.inputPreview) : undefined;
      n.openTools = {
        ...state.openTools,
        [event.toolUseId]: {
          at: ts,
          toolName: event.toolName,
          lane,
          parentToolUseId: event.parentToolUseId,
          turnId: event.turnId,
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          ...(taskIntent ? { taskIntent } : {}),
          ...(summary !== undefined ? { description: redactAbsolutePaths(summary).slice(0, 200) } : {}),
          ...(stopTarget !== undefined ? { stopTarget } : {}),
        },
      };
      if (lane === "main" && event.messageId !== undefined) n.mainMessageId = event.messageId;
      if (lane === "main" && DELEGATION_TOOL_NAMES.has(event.toolName) && keyedGet(state.delegations, event.toolUseId) === undefined) {
        putDelegation(n, state.delegations, {
          toolUseId: event.toolUseId,
          turnId: event.turnId,
          startedAt: ts,
          isBackground: event.isBackground === true || event.delegation?.isBackground === true,
          description: redactAbsolutePaths(event.delegation?.description ?? "").slice(0, 200),
          subagentType: event.delegation?.subagentType ?? event.subagentType,
          model: event.delegation?.subagentModel ?? event.subagentModel,
        });
      } else if (lane === "sub" && event.parentToolUseId !== null) {
        const d = keyedGet(state.delegations, event.parentToolUseId);
        if (d !== undefined) {
          putDelegation(n, state.delegations, {
            ...d,
            lastChildAt: d.lastChildAt === undefined ? ts : Math.max(d.lastChildAt, ts),
          });
        }
      }
      return n;
    }
    case "tool_call_finished": {
      if (ts !== undefined && event.taskNotification !== undefined) {
        const agentId = event.taskNotification.agentId;
        const n0 = touch();
        const hit = delegationOfAgent(n0, agentId, (d) => d.notifiedEndedAt === undefined);
        if (hit !== undefined) putDelegation(n0, n0.delegations, { ...hit, notifiedEndedAt: ts });
      }
      if (ts !== undefined && event.taskNotification !== undefined) {
        const n0 = touch();
        const bg = unsettledBackgroundOfTask(n0, event.taskNotification.agentId);
        if (bg !== undefined) {
          n0.backgroundTasks = keyedSet(n0.backgroundTasks, bg.toolUseId, { ...withoutPendingStale(bg), notifiedEndedAt: ts });
          n0.unsettledBackground = n0.unsettledBackground.filter(id => id !== bg.toolUseId);
        }
      }
      if (ts !== undefined && event.resumedAgentId !== undefined && event.isError !== true) {
        const n0 = touch();
        const hit = delegationOfAgent(n0, event.resumedAgentId, (d) => d.notifiedEndedAt !== undefined);
        if (hit !== undefined) putDelegation(n0, n0.delegations, { ...hit, notifiedEndedAt: undefined });
      }
      const settledStop = event.taskNotification?.agentId ?? (event.isError !== true ? event.resumedAgentId : undefined);
      if (settledStop !== undefined && next.stoppedTaskIds?.includes(settledStop)) {
        const n0 = touch();
        n0.stoppedTaskIds = n0.stoppedTaskIds!.filter(id => id !== settledStop);
      }
      const open = state.openTools[event.toolUseId];
      if (open === undefined || ts === undefined) return next;
      const n = touch();
      const { [event.toolUseId]: _, ...rest } = state.openTools;
      n.openTools = rest;
      if (open.stopTarget !== undefined && event.isError !== true && !n.stoppedTaskIds?.includes(open.stopTarget)) {
        n.stoppedTaskIds = [...n.stoppedTaskIds ?? [], open.stopTarget].slice(-MAX_STOPPED_TASK_IDS);
      }
      if (open.lane === "main" && event.backgroundTaskId !== undefined && event.isError !== true && keyedGet(n.backgroundTasks, event.toolUseId) === undefined) {
        n.backgroundTasks = keyedSet(n.backgroundTasks, event.toolUseId, {
          toolUseId: event.toolUseId,
          toolName: open.toolName,
          turnId: open.turnId,
          startedAt: open.at,
          ackAt: ts,
          taskId: event.backgroundTaskId,
          description: open.description ?? open.toolName,
        });
        n.backgroundByTask = keyedSet(n.backgroundByTask, event.backgroundTaskId,
          [...keyedGet(n.backgroundByTask, event.backgroundTaskId) ?? [], event.toolUseId]);
        n.unsettledBackground = [...n.unsettledBackground, event.toolUseId];
      }
      const interval: ToolInterval = {
        toolUseId: event.toolUseId,
        toolName: open.toolName,
        start: open.at,
        end: Math.max(open.at, ts),
        isError: event.isError === true,
        turnId: open.turnId,
        ...(open.parentToolUseId !== null ? { agentId: open.parentToolUseId } : {}),
        ...(open.lane === "main" && isRejectedBeforeRun(event) ? { rejectedBeforeRun: true as const } : {}),
      };
      if (open.lane === "main") n.mainTools = pushBounded(state.mainTools, interval, n);
      else n.subTools = pushBounded(state.subTools, interval, n);
      const parentKey = open.lane === "main" ? event.toolUseId : open.parentToolUseId;
      const d = parentKey !== null ? (keyedGet(n.delegations, parentKey) ?? keyedGet(state.delegations, parentKey)) : undefined;
      if (d !== undefined) {
        const updated: DelegationSpan = { ...d };
        if (open.lane === "main") {
          updated.ackEndedAt = interval.end;
          if (interval.rejectedBeforeRun) updated.rejectedBeforeRun = true;
          if (event.asyncLaunchedAgentId !== undefined) {
            updated.transcriptAgentId = event.asyncLaunchedAgentId;
            updated.isBackground = true;
          }
        } else {
          updated.lastChildAt = d.lastChildAt === undefined ? interval.end : Math.max(d.lastChildAt, interval.end);
        }
        putDelegation(n, n.delegations, updated);
      }
      return open.lane === "main" && open.taskIntent && !event.isError
        ? applyPlanTask(n, open.taskIntent, ts, open.turnId, event.resultPreview, { live: isLiveEvent(event), toolUseId: event.toolUseId }) : n;
    }
    case "subagent_info": {
      const d = keyedGet(state.delegations, event.toolUseId);
      if (d === undefined || (event.model === undefined || d.model === event.model) &&
        (event.agentId === undefined || d.transcriptAgentId === event.agentId)) return next;
      const n = touch();
      putDelegation(n, state.delegations, { ...d,
        model: event.model ?? d.model, transcriptAgentId: event.agentId ?? d.transcriptAgentId });
      return n;
    }
    default:
      return next;
  }
}

export type Span = [number, number];

export function unionSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s[1] > s[0]).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s[0] <= last[1]) {
      if (s[1] > last[1]) last[1] = s[1];
    } else {
      out.push([s[0], s[1]]);
    }
  }
  return out;
}

export function intersectSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (end > start) out.push([start, end]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

export function subtractSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  const bs = unionSpans(b);
  for (const [s0, s1] of unionSpans(a)) {
    let cursor = s0;
    for (const [b0, b1] of bs) {
      if (b1 <= cursor) continue;
      if (b0 >= s1) break;
      if (b0 > cursor) out.push([cursor, Math.min(b0, s1)]);
      cursor = Math.max(cursor, b1);
      if (cursor >= s1) break;
    }
    if (cursor < s1) out.push([cursor, s1]);
  }
  return out;
}

export function measureSpans(spans: readonly Span[]): number {
  let total = 0;
  for (const [s0, s1] of spans) total += Math.max(0, s1 - s0);
  return total;
}

export interface TimeBucketTotals {
  generateMs: number | null;
  toolMs: number;
  subagentWaitMs: number;
  confirmMs: number;
  replyMs: number | null;
  subOnlyMs: number | null;
  spanMs: number | null;
}

export interface TimeBucketInterval {
  bucket: TimeBucket;
  lane: TimeLane;
  start: number;
  end: number;
  turnId?: string;
  agentId?: string;
  backgroundOverlapMs?: number;
}

export interface AgentSpanView {
  toolUseId: string;
  turnId: string;
  blockId?: string;
  stepKey?: string;
  start: number;
  end: number;
  open: boolean;
  isBackground: boolean;
  description: string;
  subagentType?: string;
  model?: string;
  transcriptAgentId?: string;
  toolCount: number;
  failCount: number;
  toolMs: number;
  generateMs: number;
  endSource: "child-transcript" | "child-tools" | "ack" | "open" | "notification";
}

export interface RequestBlockView {
  blockId: string;
  requestNumber: string | null;
  processingMs: number | null;
  strip: { generatePercent: number; toolPercent: number; subagentWaitPercent: number; confirmPercent: number; replyPercent: number; remainderPercent: number } | null;
  kind: RequestBlockKind;
  text: string;
  start: number;
  end: number;
  anchorAt: number;
  durationMs: number | null;
  turnIds: string[];
  conductorAttribution?: { start: number; end: number; turnId?: string; keys: string[] }[];
  conductorIntervals?: TimeBucketInterval[];
  conductorTail?: number | null;
  usageSlices?: PlanUsage["blocks"][number]["slices"];
  toolCount: number;
  failCount: number;
  agentCount: number;
  generateMs: number | null;
  toolMs: number;
  subagentWaitMs: number;
  confirmMs: number;
  replyMs: number | null;
  running: boolean;
  goal?: string;
  closedAt?: number;
  steps?: PlanBlockStepView[];
  userMessages?: { at: number; text: string }[];
  metrics?: PlanBlockMetrics;
}

export interface ConductorModel { model: string; effort?: string }
export interface MainModelSpan extends ConductorModel { start: number; end: number }

export interface TimeBucketView {
  subagentOnlySpans?: Span[];
  mainModelSpans?: MainModelSpan[];
  generationBoundaryAt?: number;
  fidelity: TimeFidelity;
  inheritedBoundaryCount: number;
  firstAt: number | null;
  lastAt: number | null;
  spanMs: number | null;
  main: TimeBucketTotals;
  sub: { generateMs: number; toolMs: number; spanMs: number };
  bars: { totalMs: number | null; mainMs: number | null; toolMs: number | null; subMs: number };
  agentCount: number;
  maxParallelAgents: number;
  currentParallel: number;
  maxConcurrency: number;
  turnOpen: boolean;
  tail: {
    main: "generate" | "tool" | "delegation" | "confirm" | null;
    anyOpen: boolean;
  };
  intervals: TimeBucketInterval[];
  agents: AgentSpanView[];
  backgroundTasks: BackgroundTaskSpanView[];
  blocks: RequestBlockView[];
  droppedIntervalCount: number;
  droppedBlockCount: number;
}

export interface ChildTranscriptSpan {
  toolUseId: string;
  startedAt?: number;
  endedAt?: number;
}

function sweepMax(spans: readonly Span[]): number {
  const points: { at: number; delta: number }[] = [];
  for (const [s0, s1] of spans) {
    if (s1 <= s0) continue;
    points.push({ at: s0, delta: 1 }, { at: s1, delta: -1 });
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let cur = 0;
  let max = 0;
  for (const p of points) {
    cur += p.delta;
    if (cur > max) max = cur;
  }
  return max;
}

export function largestRemainder(parts: readonly number[], total: number, amount: number): number[] {
  const raw = parts.map((p) => (p / total) * amount);
  const floors = raw.map((r) => Math.floor(r));
  let rest = amount - floors.reduce((acc, v) => acc + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]++;
    rest--;
  }
  return floors;
}

function deriveMainModelSpans(turns: readonly TurnSpan[], marks: readonly ModelMark[]): MainModelSpan[] {
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const spans: MainModelSpan[] = [];
  let index = 0;
  let model: string | undefined;
  for (const turn of [...turns].sort((a, b) => a.start - b.start)) {
    while (index < sorted.length && sorted[index].at <= turn.start) model = sorted[index++].model;
    let start = turn.start;
    const add = (end: number) => {
      if (model && end > start) spans.push({ start, end, model, ...(turn.effort ? { effort: turn.effort } : {}) });
      start = end;
    };
    while (index < sorted.length && sorted[index].at <= turn.end) {
      const mark = sorted[index++];
      model = mark.model;
      add(mark.at);
    }
    add(turn.end);
  }
  return spans;
}

interface SelectedItem { blockIndex: number; key: string }

// The latest turn started at or before `at` in turns sorted by start; callers bound it by its end.
function turnStartedBy(sortedTurns: readonly TurnSpan[], at: number): TurnSpan | undefined {
  let low = 0, high = sortedTurns.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedTurns[mid].start <= at) low = mid + 1;
    else high = mid;
  }
  return sortedTurns[low - 1];
}

// The one decision of which PLAN items the conductor is working on: an item is selected when it is put in progress inside a
// response (turn) and stays selected until it leaves in progress or the next response starts, so the reply wait after a
// response belongs to what that response selected. Selected items are in selection order, latest last. Conductor time,
// unnumbered members and the PLAN panel's per-step tokens all read it.
function responseSelections(records: readonly Pick<RequestBlockRecord, "steps">[], turns: readonly TurnSpan[]): { at: number; selected: SelectedItem[] }[] {
  const sortedTurns = [...turns].sort((a, b) => a.start - b.start);
  // A change at the instant its response ends still belongs to that response.
  const inResponse = (at: number): boolean => {
    const turn = turnStartedBy(sortedTurns, at);
    return turn !== undefined && at <= turn.end;
  };
  const changes = records.flatMap((block, blockIndex) => (block.steps ?? []).flatMap(step =>
    step.transitions.map(change => ({ ...change, blockIndex, key: step.key }))))
    .sort((a, b) => a.at - b.at || a.blockIndex - b.blockIndex || a.order - b.order);
  const starts = new Set(sortedTurns.map(turn => turn.start));
  const times = [...new Set([...starts, ...changes.map(change => change.at)])].sort((a, b) => a - b);
  const selected = new Map<string, SelectedItem>();
  const timeline: { at: number; selected: SelectedItem[] }[] = [];
  let changeIndex = 0;
  for (const at of times) {
    if (starts.has(at)) selected.clear();
    while (changeIndex < changes.length && changes[changeIndex].at <= at) {
      const change = changes[changeIndex++];
      const id = `${change.blockIndex}\n${change.key}`;
      selected.delete(id);
      if (change.active && inResponse(change.at)) selected.set(id, { blockIndex: change.blockIndex, key: change.key });
    }
    timeline.push({ at, selected: [...selected.values()] });
  }
  return timeline;
}

function selectionAt(timeline: readonly { at: number; selected: SelectedItem[] }[], at: number): SelectedItem[] {
  let low = 0, high = timeline.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (timeline[mid].at <= at) low = mid + 1;
    else high = mid;
  }
  return timeline[low - 1]?.selected ?? [];
}

// Each moment goes whole to every item the conductor put in progress earlier in the same response (or, in the reply wait
// after it, in that response), in any block (also after its block's window); with none it goes to the block whose window holds it. Launch descriptions, notifications and
// human turns do not route.
export function attributeConductorIntervals(state: TimeBucketState, view: TimeBucketView, turns: readonly TurnSpan[],
  timeline = responseSelections(state.blocks, turns)): void {
  const blocks = view.blocks;
  for (const block of blocks) {
    block.conductorAttribution = [];
    block.conductorIntervals = [];
    block.conductorTail = null;
    for (const step of block.steps ?? []) { step.conductorIntervals = []; step.conductorTail = null; }
  }
  if (blocks.length === 0) return;
  const sortedTurns = [...turns].sort((a, b) => a.start - b.start);
  const turnsById = new Map(turns.map(turn => [turn.turnId, turn]));
  const turnAt = (at: number): TurnSpan | undefined => {
    const turn = turnStartedBy(sortedTurns, at);
    return turn && at < turn.end ? turn : undefined;
  };
  const first = blocks[0].start, last = blocks.at(-1)!.end;
  const points = [...new Set([...blocks.flatMap(block => [block.start, block.end]),
    ...sortedTurns.flatMap(turn => [turn.start, turn.end]), ...timeline.map(entry => entry.at)])]
    .filter(at => at >= first && at <= last).sort((a, b) => a - b);
  const segments: { start: number; end: number; turnId?: string; owners: Map<number, string[]> }[] = [];
  let windowIndex = 0;
  for (let i = 0; i < points.length; i++) {
    const start = points[i], end = points[i + 1] ?? start;
    // The final zero-width segment owns the moments at and after the last observation (a live tail, a call at lastAt).
    const turn = start === end && state.openTurn !== undefined ? turnsById.get(state.openTurn.turnId) : turnAt(start);
    while (windowIndex + 1 < blocks.length && blocks[windowIndex + 1].start <= start) windowIndex++;
    const owners = new Map<number, string[]>();
    for (const { blockIndex, key } of selectionAt(timeline, start)) owners.set(blockIndex, [...owners.get(blockIndex) ?? [], key]);
    if (owners.size === 0) owners.set(windowIndex, []);
    const segment = { start, end, ...(turn ? { turnId: turn.turnId } : {}) };
    for (const [blockIndex, keys] of owners) blocks[blockIndex].conductorAttribution!.push({ ...segment, keys });
    segments.push({ ...segment, owners });
  }
  const stepsOf = blocks.map(block => new Map((block.steps ?? []).map(step => [step.key, step])));
  let segmentIndex = 0;
  for (const interval of view.intervals) {
    if (interval.lane !== "main" || interval.bucket === "reply") continue;
    while (segmentIndex < segments.length && segments[segmentIndex].end <= interval.start) segmentIndex++;
    for (let i = segmentIndex; i < segments.length && segments[i].start < interval.end; i++) {
      const segment = segments[i];
      const from = Math.max(interval.start, segment.start), to = Math.min(interval.end, segment.end);
      if (to <= from) continue;
      for (const [blockIndex, keys] of segment.owners) {
        for (const key of keys.length ? keys : [undefined]) {
          const list = key === undefined ? blocks[blockIndex].conductorIntervals! : stepsOf[blockIndex].get(key)?.conductorIntervals;
          if (list === undefined) continue;
          const previous = list.at(-1);
          if (previous?.bucket === interval.bucket && previous.turnId === segment.turnId && previous.end === from) previous.end = to;
          else list.push({ bucket: interval.bucket, lane: "main", start: from, end: to, ...(segment.turnId ? { turnId: segment.turnId } : {}) });
        }
      }
    }
  }
  const tail = segments.at(-1);
  if (blocks.at(-1)!.running && view.tail.main !== null && view.lastAt !== null && tail !== undefined) {
    for (const [blockIndex, keys] of tail.owners) {
      if (keys.length === 0) blocks[blockIndex].conductorTail = view.lastAt;
      for (const key of keys) {
        const step = stepsOf[blockIndex].get(key);
        if (step) step.conductorTail = view.lastAt;
      }
    }
  }
}

export function deriveTimeBuckets(
  state: TimeBucketState,
  options?: {
    childSpans?: readonly ChildTranscriptSpan[];
    streamOpen?: boolean;
    liveDelegationAgentIds?: ReadonlySet<string>;
    modelMarks?: readonly ModelMark[];
    appliedEffort?: string | null;
  }
): TimeBucketView {
  const firstAt = state.firstAt ?? null;
  const lastAt = state.lastAt ?? null;
  const spanMs = firstAt !== null && lastAt !== null ? Math.max(0, lastAt - firstAt) : 0;
  const end = lastAt ?? 0;
  const inherited = state.inheritedBoundaryCount > 0;

  const turnSpansAll = turnSpansUntil(state, lastAt === null ? null : end);
  const turnUnion = unionSpans(turnSpansAll.map((t) => [t.start, t.end] as Span));

  const confirmSpans = state.mainTools.filter((t) => HUMAN_INPUT_WAIT_TOOLS.has(t.toolName)).map((t) => [t.start, t.end] as Span);
  const allMainToolSpans = state.mainTools.map((t) => [t.start, t.end] as Span);
  for (const open of Object.values(state.openTools)) {
    if (open.lane !== "main" || lastAt === null) continue;
    const span: Span = [open.at, Math.max(open.at, end)];
    allMainToolSpans.push(span);
    if (HUMAN_INPUT_WAIT_TOOLS.has(open.toolName)) confirmSpans.push(span);
  }
  const confirmUnion = unionSpans(confirmSpans);
  const callUnion = subtractSpans(unionSpans(allMainToolSpans), confirmUnion);
  const nonDelegationToolSpans = state.mainTools
    .filter((t) => t.rejectedBeforeRun || !isSubagentWaitTool(t.toolName))
    .map((t) => [t.start, t.end] as Span);
  for (const open of Object.values(state.openTools)) {
    if (open.lane !== "main" || lastAt === null || isSubagentWaitTool(open.toolName)) continue;
    nonDelegationToolSpans.push([open.at, Math.max(open.at, end)]);
  }
  const toolUnion = subtractSpans(unionSpans(nonDelegationToolSpans), confirmUnion);
  const subagentWaitUnion = subtractSpans(callUnion, toolUnion);

  const childByToolUseId = new Map<string, ChildTranscriptSpan>();
  for (const c of options?.childSpans ?? []) childByToolUseId.set(c.toolUseId, c);
  // Descendant tools belong to the displayed direct child. Roll up their
  // intervals, not their elapsed spans: concurrent work must remain a union.
  const directChildIds = new Set(keyedValues(state.delegations).map(d => d.toolUseId));
  const nestedParents = new Map<string, string | null>();
  const addNestedParent = (id: string, parent: string | undefined) => {
    if (parent === undefined) return;
    const prior = nestedParents.get(id);
    nestedParents.set(id, prior === undefined || prior === parent ? parent : null);
  };
  for (const t of state.subTools) {
    if (DELEGATION_TOOL_NAMES.has(t.toolName)) addNestedParent(t.toolUseId, t.agentId);
  }
  // A background descendant can emit tools before its launching call finishes.
  for (const [id, t] of Object.entries(state.openTools)) {
    if (t.lane === "sub" && DELEGATION_TOOL_NAMES.has(t.toolName)) {
      addNestedParent(id, t.parentToolUseId ?? undefined);
    }
  }
  const directChildOf = (id: string): string | undefined => {
    const visited = new Set<string>();
    while (!directChildIds.has(id)) {
      if (visited.has(id)) return undefined;
      visited.add(id);
      const parent = nestedParents.get(id);
      if (parent === undefined || parent === null) return undefined;
      id = parent;
    }
    return id;
  };
  const directToolCounts = new Map<string, { total: number; failed: number }>();
  const subToolsByAgent = new Map<string, ToolInterval[]>();
  for (const t of state.subTools) {
    if (t.agentId === undefined) continue;
    if (directChildIds.has(t.agentId)) {
      const counts = directToolCounts.get(t.agentId) ?? { total: 0, failed: 0 };
      counts.total++;
      if (t.isError) counts.failed++;
      directToolCounts.set(t.agentId, counts);
    }
    const directId = directChildOf(t.agentId);
    if (directId === undefined) continue;
    const tools = subToolsByAgent.get(directId) ?? [];
    tools.push(t);
    subToolsByAgent.set(directId, tools);
  }
  const agents: AgentSpanView[] = [];
  for (const d of keyedValues(state.delegations)) {
    if (d.rejectedBeforeRun) continue;
    const toolUseId = d.toolUseId;
    const child = childByToolUseId.get(toolUseId);
    let start = d.startedAt;
    let spanEnd: number | undefined;
    let endSource: AgentSpanView["endSource"];
    const liveGateIds = options?.liveDelegationAgentIds;
    const claimableRunning =
      options?.streamOpen !== false &&
      (liveGateIds === undefined || (d.transcriptAgentId !== undefined && liveGateIds.has(d.transcriptAgentId)));
    if (d.isBackground && d.notifiedEndedAt === undefined && claimableRunning) {
      if (child?.startedAt !== undefined) start = child.startedAt;
      spanEnd = undefined;
      endSource = "open";
    } else if (child?.endedAt !== undefined) {
      if (child.startedAt !== undefined) start = child.startedAt;
      spanEnd = child.endedAt;
      endSource = "child-transcript";
    } else if (d.isBackground && d.notifiedEndedAt !== undefined) {
      spanEnd = d.lastChildAt !== undefined ? Math.max(d.notifiedEndedAt, d.lastChildAt) : d.notifiedEndedAt;
      endSource = "notification";
    } else if (d.ackEndedAt !== undefined) {
      spanEnd = d.lastChildAt !== undefined ? Math.max(d.ackEndedAt, d.lastChildAt) : d.ackEndedAt;
      endSource = "ack";
    } else {
      spanEnd = d.lastChildAt;
      endSource = spanEnd !== undefined ? "child-tools" : "open";
    }
    const open = spanEnd === undefined;
    const resolvedEnd = Math.max(start, spanEnd ?? end);
    const tools = subToolsByAgent.get(toolUseId) ?? [];
    const counts = directToolCounts.get(toolUseId);
    const toolMs = measureSpans(intersectSpans(unionSpans(tools.map((t) => [t.start, t.end] as Span)), [[start, resolvedEnd]]));
    agents.push({
      toolUseId,
      turnId: d.turnId,
      start,
      end: resolvedEnd,
      open,
      isBackground: d.isBackground,
      description: d.description,
      ...(d.subagentType !== undefined ? { subagentType: d.subagentType } : {}),
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(d.transcriptAgentId !== undefined ? { transcriptAgentId: d.transcriptAgentId } : {}),
      toolCount: counts?.total ?? 0,
      failCount: counts?.failed ?? 0,
      toolMs,
      generateMs: Math.max(0, resolvedEnd - start - toolMs),
      endSource: open ? "open" : endSource,
    });
  }
  const backgroundTasks: BackgroundTaskSpanView[] = [];
  const subagentBackgroundSpans: Span[] = [];
  for (const b of keyedValues(state.backgroundTasks)) {
    const liveGateIds = options?.liveDelegationAgentIds;
    const claimableRunning =
      options?.streamOpen !== false && (liveGateIds === undefined || liveGateIds.has(b.taskId));
    let bgEnd: number | undefined;
    let endSource: BackgroundTaskSpanView["endSource"];
    if (b.notifiedEndedAt !== undefined) {
      bgEnd = b.notifiedEndedAt;
      endSource = "notification";
    } else if (b.staleAt !== undefined || !claimableRunning) {
      bgEnd = b.staleAt ?? end;
      endSource = "stale";
    } else {
      bgEnd = undefined;
      endSource = "open";
    }
    const subagent = isSubagentWaitTool(b.toolName);
    backgroundTasks.push({
      toolUseId: b.toolUseId,
      taskId: b.taskId,
      turnId: b.turnId,
      description: b.description,
      subagent,
      start: b.startedAt,
      end: Math.max(b.startedAt, bgEnd ?? end),
      open: bgEnd === undefined,
      endSource,
    });
    if (subagent) subagentBackgroundSpans.push([b.startedAt, Math.max(b.startedAt, bgEnd ?? end)]);
  }
  const agentSpans = agents.map((a) => [a.start, a.end] as Span);
  const bgSpans = backgroundTasks.map((t) => [t.start, t.end] as Span);
  const subagentSpans: Span[] = [...agentSpans, ...subagentBackgroundSpans];
  const subActiveUnion = unionSpans(subagentSpans);

  const whole: Span[] = firstAt !== null && lastAt !== null ? [[firstAt, lastAt]] : [];
  const generateSpans = subtractSpans(turnUnion, unionSpans([...callUnion, ...confirmUnion]));
  const mainActiveUnion = unionSpans([...turnUnion, ...callUnion, ...confirmUnion]);
  const activeUnion = unionSpans([...mainActiveUnion, ...subActiveUnion]);
  const replySpans = subtractSpans(whole, activeUnion);
  const subOnlySpans = intersectSpans(subtractSpans(subActiveUnion, mainActiveUnion), whole);
  const metrics = (start: number | null, stop: number): PlanBlockMetrics => {
    const interval: Span[] = start === null ? [] : [[start, stop]];
    const measured = start !== null;
    const amount = (spans: readonly Span[], available = true): number | null => measured && available ? measureSpans(intersectSpans(spans, interval)) : null;
    return { generateMs: amount(generateSpans, !inherited), toolMs: amount(toolUnion),
      subagentWaitMs: amount(subagentWaitUnion), subagentOnlyMs: amount(subOnlySpans, !inherited), decisionWaitMs: amount(confirmUnion),
      replyWaitMs: amount(replySpans, !inherited), tokens: null };
  };

  const toolMs = measureSpans(intersectSpans(toolUnion, whole));
  const subagentWaitMs = measureSpans(intersectSpans(subagentWaitUnion, whole));
  const confirmMs = measureSpans(intersectSpans(confirmUnion, whole));
  const generateMs = measureSpans(intersectSpans(generateSpans, whole));
  const replyMs = measureSpans(replySpans);
  const subOnlyMs = measureSpans(subOnlySpans);
  const mainBarMs = generateMs + toolMs;
  const subGenerate = agents.reduce((acc, a) => acc + a.generateMs, 0);
  const subTool = agents.reduce((acc, a) => acc + a.toolMs, 0);
  const subSpan = agents.reduce((acc, a) => acc + Math.max(0, a.end - a.start), 0);
  const subBarMs = subagentSpans.reduce((acc, [s0, s1]) => acc + (s1 - s0), 0);

  const intervals: TimeBucketInterval[] = [];
  if (!inherited) {
    for (const [s0, s1] of generateSpans) intervals.push({ bucket: "generate", lane: "main", start: s0, end: s1 });
  }
  for (const [s0, s1] of toolUnion) intervals.push({ bucket: "tool", lane: "main", start: s0, end: s1 });
  for (const [s0, s1] of subagentWaitUnion) intervals.push({ bucket: "delegation", lane: "main", start: s0, end: s1 });
  const bgUnion = unionSpans(bgSpans);
  const withBgOverlap = (interval: TimeBucketInterval): TimeBucketInterval => {
    const overlap = measureSpans(intersectSpans([[interval.start, interval.end]], bgUnion));
    if (overlap > 0) interval.backgroundOverlapMs = overlap;
    return interval;
  };
  for (const [s0, s1] of confirmUnion) intervals.push(withBgOverlap({ bucket: "confirm", lane: "main", start: s0, end: s1 }));
  if (!inherited) {
    for (const [s0, s1] of replySpans) intervals.push(withBgOverlap({ bucket: "reply", lane: "main", start: s0, end: s1 }));
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);

  const selections = responseSelections(state.blocks, turnSpansAll);
  // A numbered member goes to its item; an unnumbered one to the item selected last at its launch.
  const attribute = (agent: AgentSpanView | BackgroundTaskSpanView, launchedAt: number, blockId: string) => {
    const number = "subagent" in agent && !agent.subagent ? undefined : planItemNumberOf(agent.description);
    const item = launchStep(state.blocks, selections, number, launchedAt);
    agent.blockId = item === undefined ? blockId : state.blocks[item.blockIndex].blockId;
    agent.stepKey = item?.key;
  };
  const blocks: RequestBlockView[] = [];
  for (let i = 0; i < state.blocks.length; i++) {
    const b = state.blocks[i];
    const nextStart = i + 1 < state.blocks.length ? state.blocks[i + 1].start : end;
    const bEnd = Math.max(b.start, b.closedAt ?? nextStart);
    const bspan: Span[] = [[b.start, bEnd]];
    const turnIds = turnSpansAll.filter((t) => t.start >= b.start && t.start < bEnd).map((t) => t.turnId);
    if (b.turnId !== null && !turnIds.includes(b.turnId)) turnIds.unshift(b.turnId);
    const blockTools = state.mainTools.filter((t) => t.start >= b.start && t.start < bEnd);
    const tools = blockTools.filter((t) => !isBookkeepingTool(t.toolName));
    const launchedHere = (at: number) => at >= b.start && (at < bEnd || i === state.blocks.length - 1 && at === bEnd);
    const blockAgents = agents.filter((a) => launchedHere(keyedGet(state.delegations, a.toolUseId)!.startedAt));
    for (const a of blockAgents) {
      attribute(a, keyedGet(state.delegations, a.toolUseId)!.startedAt, b.blockId);
    }
    for (const t of backgroundTasks) if (launchedHere(t.start)) {
      attribute(t, t.start, b.blockId);
    }
    const firstReal = blockTools.length > 0 ? Math.min(...blockTools.map((t) => t.start)) : undefined;
    const running = state.openTurn !== undefined && b.closedAt === undefined && i === state.blocks.length - 1;
    const generate = measureSpans(intersectSpans(generateSpans, bspan));
    const tool = measureSpans(intersectSpans(toolUnion, bspan));
    const subagentWait = measureSpans(intersectSpans(subagentWaitUnion, bspan));
    const confirm = measureSpans(intersectSpans(confirmUnion, bspan));
    const reply = measureSpans(intersectSpans(replySpans, bspan));
    const processing = generate + tool + subagentWait + confirm;
    const elapsed = bEnd - b.start;
    const steps: PlanBlockStepView[] = (b.steps ?? []).map(step => {
      const stop = step.startedAt === null ? null : Math.min(step.endedAt ?? end, b.closedAt ?? end);
      return { key: step.key, number: step.number, title: redactAbsolutePaths(step.title), status: step.status, removed: step.removed,
        startedAt: step.startedAt, endedAt: step.endedAt, end: stop, activeSpans: planStepActiveSpans(step.transitions, Math.min(end, b.closedAt ?? end)),
        durationMs: inherited || stop === null ? null : Math.max(0, stop - step.startedAt!), longest: false, parallel: false,
        ...metrics(step.startedAt, stop ?? bEnd), provisional: running };
    });
    const stepSpans = steps.map(step => step.activeSpans!.map(span => [span.start, span.end] as Span));
    for (let j = 0; j < steps.length; j++) steps[j].parallel = stepSpans.some((spans, k) => k !== j && measureSpans(intersectSpans(stepSpans[j], spans)) > 0);
    const longest = steps.reduce<PlanBlockStepView | undefined>((winner, step) => step.durationMs !== null && (winner?.durationMs == null || step.durationMs > winner.durationMs) ? step : winner, undefined);
    if (longest) longest.longest = true;
    blocks.push({
      blockId: b.blockId,
      requestNumber: b.requestNumber ?? null,
      processingMs: inherited ? null : processing,
      strip: inherited || elapsed === 0 ? null : {
        generatePercent: generate / elapsed * 100,
        toolPercent: tool / elapsed * 100,
        subagentWaitPercent: subagentWait / elapsed * 100,
        confirmPercent: confirm / elapsed * 100,
        replyPercent: reply / elapsed * 100,
        remainderPercent: Math.max(0, elapsed - processing - reply) / elapsed * 100,
      },
      kind: b.kind,
      text: b.text,
      start: b.start,
      end: bEnd,
      anchorAt: inherited ? (firstReal ?? b.start) : b.start,
      durationMs: inherited ? null : bEnd - b.start,
      turnIds,
      toolCount: tools.length,
      failCount: tools.filter((t) => t.isError).length,
      agentCount: blockAgents.length,
      generateMs: inherited ? null : measureSpans(intersectSpans(generateSpans, bspan)),
      toolMs: tool,
      subagentWaitMs: subagentWait,
      confirmMs: measureSpans(intersectSpans(confirmUnion, bspan)),
      replyMs: inherited ? null : measureSpans(intersectSpans(replySpans, bspan)),
      running,
      metrics: { ...metrics(b.start, bEnd), provisional: running },
      ...(b.kind === "plan" ? { goal: b.goal, ...(b.closedAt === undefined ? {} : { closedAt: b.closedAt }), steps,
        userMessages: (b.userMessages ?? []).map(({ at, text }) => ({ at, text })) } : {}),
    });
  }

  const maxParallelAgents = sweepMax(agentSpans);
  const openMainTools = Object.values(state.openTools).filter((o) => o.lane === "main");
  const confirmOpen = openMainTools.some((o) => HUMAN_INPUT_WAIT_TOOLS.has(o.toolName));
  const turnParallel = state.openTurn !== undefined && !confirmOpen ? 1 : 0;
  const currentParallel = turnParallel + agents.filter((a) => a.open).length + backgroundTasks.filter((t) => t.open).length;
  const maxConcurrency = Math.max(sweepMax([...subtractSpans(turnUnion, confirmUnion), ...agentSpans, ...bgSpans]), currentParallel);

  const tailMain: TimeBucketView["tail"]["main"] =
    confirmOpen
      ? "confirm"
      : openMainTools.some((o) => !isSubagentWaitTool(o.toolName))
        ? "tool"
        : openMainTools.length > 0
          ? "delegation"
          : state.openTurn !== undefined
            ? "generate"
            : null;
  const tailAnyOpen = tailMain !== null || agents.some((a) => a.open) || backgroundTasks.some((t) => t.open);
  const tail = { main: tailMain, anyOpen: tailAnyOpen };

  const view: TimeBucketView = {
    ...(inherited ? {} : { subagentOnlySpans: subOnlySpans }),
    ...(state.generationBoundaryAt === undefined ? {} : { generationBoundaryAt: state.generationBoundaryAt }),
    fidelity: state.fidelity,
    inheritedBoundaryCount: state.inheritedBoundaryCount,
    firstAt,
    lastAt,
    spanMs: inherited ? null : spanMs,
    main: {
      generateMs: inherited ? null : generateMs,
      toolMs,
      subagentWaitMs,
      confirmMs,
      replyMs: inherited ? null : replyMs,
      subOnlyMs: inherited ? null : subOnlyMs,
      spanMs: inherited ? null : spanMs,
    },
    sub: { generateMs: subGenerate, toolMs: subTool, spanMs: subSpan },
    bars: {
      mainMs: inherited ? null : mainBarMs,
      toolMs: inherited ? null : toolMs,
      subMs: subBarMs,
      totalMs: inherited ? null : mainBarMs + subBarMs,
    },
    agentCount: agents.length,
    maxParallelAgents,
    currentParallel,
    maxConcurrency,
    turnOpen: state.openTurn !== undefined,
    tail,
    intervals,
    agents,
    backgroundTasks,
    blocks,
    droppedIntervalCount: state.droppedIntervalCount,
    droppedBlockCount: state.droppedBlockCount,
  };
  attributeConductorIntervals(state, view, turnSpansAll, selections);
  view.mainModelSpans = deriveMainModelSpans(turnSpansAll, options?.modelMarks ?? state.modelMarks ?? []);
  return view;
}

export function projectWorkBlockTokens(view: TimeBucketView, usage: PlanUsage): TimeBucketView {
  const total = (slices: PlanUsage["blocks"][number]["slices"], start: number | null, end: number): PlanTokenTotal | null => {
    if (start === null) return null;
    let result: PlanTokenTotal | null = null;
    for (const slice of slices) {
      const overlap = Math.max(0, Math.min(end, slice.end) - Math.max(start, slice.start));
      if (overlap <= 0) continue;
      result ??= { tokens: 0, cacheRead: 0 };
      const ratio = overlap / Math.max(1, slice.end - slice.start);
      result.tokens += slice.tokens * ratio;
      result.cacheRead += slice.cacheRead * ratio;
      if (slice.outputTokens !== undefined) result.outputTokens = (result.outputTokens ?? 0) + slice.outputTokens * ratio;
    }
    return result;
  };
  const allSlices = usage.blocks.flatMap(block => block.slices);
  const project = (block: RequestBlockView): RequestBlockView => {
    const slices = usage.blocks.filter(value => value.blockId === block.blockId).flatMap(value => value.slices)
      .filter(slice => slice.start >= block.start && (block.closedAt === undefined || slice.start < block.closedAt));
    const { usageSlices: _previousSlices, ...withoutUsageSlices } = block;
    const tokens = slices.length
      ? { tokens: slices.reduce((sum, slice) => sum + slice.tokens, 0), cacheRead: slices.reduce((sum, slice) => sum + slice.cacheRead, 0),
        ...(slices.some(slice => slice.outputTokens !== undefined) ? { outputTokens: slices.reduce((sum, slice) => sum + (slice.outputTokens ?? 0), 0) } : {}) } : null;
    return { ...withoutUsageSlices, ...(slices.length ? { usageSlices: slices } : {}), ...(block.metrics ? { metrics: { ...block.metrics, tokens } } : {}),
      ...(block.kind === "plan" ? { steps: block.steps?.map(step => ({ ...step, tokens: total(allSlices, step.startedAt, step.end ?? block.end) })) } : {}) };
  };
  return { ...view, blocks: view.blocks.map(project) };
}

export function currentWorkBlock<B extends { closedAt?: number }>(source: { blocks: readonly B[] }): B | undefined { const block = source.blocks.at(-1); return block?.closedAt === undefined ? block : undefined; }

export function planItemKeys(block: RequestBlockRecord): string[] {
  return block.seenSteps ?? (block.steps ?? []).map(step => step.key);
}

export type NumberedLaunchVerdict = { kind: "allow" } | { kind: "unnumbered"; numbers: number[] } | { kind: "not-in-progress"; number: number };
export type ResumeVerdict = { kind: "allow" } | { kind: "step-completed"; number: number };
export type CompletionVerdict = { kind: "allow" } | { kind: "running-lanes"; steps: { number: number; lanes: string[] }[] };

// Plan-tool calls observed in the same assistant message, in any order, count with the status they send, folded by the
// same rule as their results. The current assistant message is the one that issued the latest main-lane call; a plan call left open
// by a cut stream or an earlier message is not folded. `except` is the call being judged, whose own start may already be open.
function withMessagePlanCalls(state: TimeBucketState, except?: string): TimeBucketState {
  const current = state.mainMessageId;
  return Object.entries(state.openTools).reduce((next, [toolUseId, tool]) => toolUseId !== except && tool.lane === "main" && tool.taskIntent !== undefined
    && tool.taskIntent.kind !== "create" && current !== undefined && tool.messageId === current && tool.turnId === state.openTurn?.turnId
    ? applyPlanTask(next, tool.taskIntent, tool.at, tool.turnId, "", { live: true, toolUseId }) : next, state);
}

// While a PLAN has items, a delegation or external run may run only for an item the conductor itself marked in progress;
// the Host never changes item state for a launch.
export function numberedLaunchVerdict(state: TimeBucketState, description: string | undefined): NumberedLaunchVerdict {
  const planned = withMessagePlanCalls(state);
  const block = currentWorkBlock(planned);
  if (block?.kind !== "plan") return { kind: "allow" };
  const listed = (block.steps ?? []).filter(step => !step.removed).map(step => step.number);
  if (listed.length === 0) return { kind: "allow" };
  const number = planItemNumberOf(description);
  if (number === undefined) return { kind: "unnumbered", numbers: listed };
  const found = planNumberedStep(planned.blocks, number, planned.lastAt ?? Number.POSITIVE_INFINITY);
  if (found !== undefined && !found.step.removed && found.step.status === "in_progress") return { kind: "allow" };
  const keys = planItemKeys(block);
  return found !== undefined || keys.some(key => planItemNumber(keys, key) === number) ? { kind: "not-in-progress", number } : { kind: "unnumbered", numbers: listed };
}

function launchStep(blocks: readonly RequestBlockRecord[], selections: readonly { at: number; selected: SelectedItem[] }[],
  number: number | undefined, at: number): SelectedItem | undefined {
  const numbered = number === undefined ? undefined : planNumberedStep(blocks, number, at);
  return numbered !== undefined ? { blockIndex: numbered.blockIndex, key: numbered.step.key } : selectionAt(selections, at).at(-1);
}

function turnSpansUntil(state: TimeBucketState, openEnd: number | null): TurnSpan[] {
  const turns: TurnSpan[] = appendListItems(state.turnSpans);
  if (state.openTurn !== undefined && openEnd !== null) {
    turns.push({ ...state.openTurn, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, openEnd) });
  }
  return turns;
}

export function inProgressStepOfDelegation(state: TimeBucketState, dispatch: { description: string; launchedAt: number; resumedAt?: number }): number | undefined {
  const selections = responseSelections(state.blocks, turnSpansUntil(state, Number.POSITIVE_INFINITY));
  const item = (dispatch.resumedAt === undefined ? undefined : selectionAt(selections, dispatch.resumedAt).at(-1))
    ?? launchStep(state.blocks, selections, planItemNumberOf(dispatch.description), dispatch.launchedAt);
  const step = item === undefined ? undefined : state.blocks[item.blockIndex].steps?.find(value => value.key === item.key);
  return step !== undefined && !step.removed && step.status === "in_progress" ? step.number : undefined;
}

function launchPlacedStep(state: TimeBucketState, selections: readonly { at: number; selected: SelectedItem[] }[], description: string,
  launchedAt: number): { blockIndex: number; step: PlanBlockStepRecord } | undefined {
  const item = launchStep(state.blocks, selections, planItemNumberOf(description), launchedAt);
  const step = item === undefined ? undefined : state.blocks[item.blockIndex].steps?.find(value => value.key === item.key);
  return item === undefined || step === undefined ? undefined : { blockIndex: item.blockIndex, step };
}

const isCompletedStep = (step: PlanBlockStepRecord | undefined): boolean => step !== undefined && !step.removed && step.status === "completed";

// `running` is the PLAN panel's rule (src/work-model.ts#isRunningMainLane), so the guards never see a lane as running that
// the panel shows ended, or the reverse; only a successful TaskStop ends a lane earlier, so a completion can follow it.
function laneRunning(state: TimeBucketState, running: (toolUseId: string) => boolean, toolUseId: string, taskId: string | undefined): boolean {
  return running(toolUseId) && (taskId === undefined || !state.stoppedTaskIds?.includes(taskId));
}

// A resumed lane keeps the item its launch placed it on (R-DSP-42), so the placement is the launch's, not the resume's.
export function resumeVerdict(state: TimeBucketState, to: string, namedToolUseId: string | undefined, toolUseId: string,
  running: (toolUseId: string) => boolean): ResumeVerdict {
  const agentId = keyedGet(state.delegationsByAgent, to) !== undefined ? to
    : namedToolUseId === undefined ? undefined : keyedGet(state.delegations, namedToolUseId)?.transcriptAgentId;
  const resumed = agentId === undefined ? undefined : delegationOfAgent(state, agentId, d => d.isBackground);
  if (resumed === undefined || laneRunning(state, running, resumed.toolUseId, agentId)) return { kind: "allow" };
  const planned = withMessagePlanCalls(state, toolUseId);
  const placed = launchPlacedStep(planned, responseSelections(planned.blocks, turnSpansUntil(planned, Number.POSITIVE_INFINITY)), resumed.description, resumed.startedAt);
  return placed !== undefined && isCompletedStep(placed.step) && reopenable(planned, placed.blockIndex, placed.step)
    ? { kind: "step-completed", number: placed.step.number } : { kind: "allow" };
}

// A resume is denied only onto an item the denial's instruction can set back in progress, else the agent could never be
// resumed: TodoWrite reaches only its own items in the open PLAN block; TaskUpdate reaches a task item through
// applyPlanTask's own lookup, but not one whose TaskCreate result gave no id (the pending key), since no id can be sent.
function reopenable(state: TimeBucketState, blockIndex: number, step: PlanBlockStepRecord): boolean {
  const block = state.blocks[blockIndex];
  if (!step.taskKey.startsWith("task:")) return blockIndex === state.blocks.length - 1 && block.kind === "plan" && block.closedAt === undefined;
  if (step.taskKey.startsWith(taskCreateKeyFromResult("", ""))) return false;
  const reopened = applyPlanTask(state, { kind: "update", taskKey: step.taskKey, status: "in_progress" }, state.lastAt ?? 0, state.openTurn?.turnId ?? "", "",
    { live: true, toolUseId: "" });
  return reopened.blocks[blockIndex].steps?.find(value => value.key === step.key)?.status === "in_progress";
}

// A launch that has not returned yet counts only once its PreToolUse let it run (`admitted`, the hook's own decisions);
// re-judging it here would fold the call being judged and drop a launch that is already running.
export function completionVerdict(state: TimeBucketState, toolName: string, input: Record<string, unknown> | undefined, toolUseId: string,
  running: (toolUseId: string) => boolean, admitted: ReadonlySet<string>): CompletionVerdict {
  const intent = parseTaskIntentFromRawInput(toolName, input, toolUseId);
  if (intent === undefined || intent.kind === "create") return { kind: "allow" };
  const before = withMessagePlanCalls(state, toolUseId);
  const after = applyPlanTask(before, intent, before.lastAt ?? 0, before.openTurn?.turnId ?? "", "", { live: true, toolUseId });
  const completing = after.blocks.flatMap(block => (block.steps ?? [])
    .filter(step => isCompletedStep(step) && !isCompletedStep(before.blocks.find(value => value.blockId === block.blockId)?.steps?.find(value => value.key === step.key)))
    .map(step => ({ blockId: block.blockId, step })));
  if (completing.length === 0) return { kind: "allow" };
  const lanes = [
    ...keyedValues(before.delegations).filter(d => !d.rejectedBeforeRun && laneRunning(before, running, d.toolUseId, d.transcriptAgentId)
      && (d.ackEndedAt !== undefined || admitted.has(d.toolUseId)))
      .map(d => ({ description: d.description, at: d.startedAt, id: d.transcriptAgentId })),
    ...keyedValues(before.backgroundTasks).filter(b => isExternalRunTool(b.toolName) && laneRunning(before, running, b.toolUseId, b.taskId))
      .map(b => ({ description: b.description, at: b.startedAt, id: b.taskId as string | undefined })),
    ...Object.entries(before.openTools).filter(([id, tool]) => tool.lane === "main" && isExternalRunTool(tool.toolName)
      && keyedGet(before.backgroundTasks, id) === undefined && laneRunning(before, running, id, undefined) && admitted.has(id))
      .map(([, tool]) => ({ description: tool.description ?? tool.toolName, at: tool.at, id: undefined as string | undefined })),
  ];
  const selections = responseSelections(before.blocks, turnSpansUntil(before, Number.POSITIVE_INFINITY));
  const placed = lanes.map(lane => {
    const step = launchPlacedStep(before, selections, lane.description, lane.at);
    return { lane, blockId: step === undefined ? undefined : before.blocks[step.blockIndex].blockId, key: step?.step.key };
  });
  const steps = completing.map(({ blockId, step }) => ({ number: step.number,
    lanes: placed.filter(entry => entry.blockId === blockId && entry.key === step.key)
      .map(({ lane }) => lane.id === undefined ? lane.description : `${lane.description} (${lane.id})`) }))
    .filter(entry => entry.lanes.length > 0);
  return steps.length > 0 ? { kind: "running-lanes", steps } : { kind: "allow" };
}

function retainObserved<T extends object>(measured: T, live: T): T {
  return { ...measured, ...Object.fromEntries(Object.entries(live).filter(([, value]) => value !== null && value !== undefined)) };
}

// Measured routing up to the cutoff stays: item state changes only at the moment it is observed, so live events after
// the cutoff cannot reroute earlier time. The live fold supplies what came after the cutoff.
function measuredBefore<T extends { start: number; end: number }>(list: readonly T[], cutoff: number): T[] {
  return list.filter(value => value.start < cutoff).map(value => value.end > cutoff ? { ...value, end: cutoff } : value);
}

// A zero-width entry at or after the cutoff is the live tail decision and is kept.
function liveAfter<T extends { start: number; end: number }>(list: readonly T[], cutoff: number): T[] {
  return list.filter(value => value.end > cutoff || value.start === value.end && value.start >= cutoff)
    .map(value => value.start < cutoff ? { ...value, start: cutoff } : value);
}

function refreshPlan(measured: RequestBlockView, live: RequestBlockView, provisional: boolean, cutoff = measured.end): RequestBlockView {
  const steps = new Map(measured.steps?.map(step => [step.key, step]));
  const before = <T extends { start: number; end: number }>(list: readonly T[]): T[] => measuredBefore(list, cutoff);
  const after = <T extends { start: number; end: number }>(list: readonly T[]): T[] => liveAfter(list, cutoff);
  const conductorAttribution = measured.conductorAttribution === undefined || live.conductorAttribution === undefined
    ? live.conductorAttribution ?? measured.conductorAttribution
    : [...before(measured.conductorAttribution), ...after(live.conductorAttribution)];
  const mergeIntervals = (previous: readonly TimeBucketInterval[] | undefined, current: readonly TimeBucketInterval[] | undefined): TimeBucketInterval[] => {
    const conductorIntervals = previous === undefined ? current : [...before(previous), ...after(current ?? [])];
    const merged: TimeBucketInterval[] = [];
    for (const interval of [...conductorIntervals ?? []].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = merged.at(-1);
      if (last?.bucket === interval.bucket && last.turnId === interval.turnId && last.end >= interval.start) last.end = Math.max(last.end, interval.end);
      else merged.push({ ...interval });
    }
    return merged;
  };
  for (const step of live.steps ?? []) {
    const previous = steps.get(step.key);
    steps.set(step.key, { ...(previous ? { ...retainObserved(previous, step), longest: step.durationMs === null ? previous.longest : step.longest, conductorTail: step.conductorTail } : step),
      conductorIntervals: mergeIntervals(previous?.conductorIntervals, step.conductorIntervals), provisional });
  }
  const metrics = measured.metrics && live.metrics ? retainObserved(measured.metrics, live.metrics) : live.metrics ?? measured.metrics;
  return { ...retainObserved(measured, live),
    ...(conductorAttribution === undefined ? {} : { conductorAttribution }),
    conductorIntervals: mergeIntervals(measured.conductorIntervals, live.conductorIntervals),
    conductorTail: live.conductorTail,
    ...(metrics === undefined ? {} : { metrics: { ...metrics, provisional } }),
    ...(measured.kind === "plan" ? { steps: [...steps.values()].map(step => ({ ...step, provisional })),
      userMessages: live.userMessages?.length ? live.userMessages : measured.userMessages ?? [] } : {}) };
}

function provisionalBlock(block: RequestBlockView): RequestBlockView {
  return block.kind === "plan" ? refreshPlan(block, block, true)
    : { ...block, durationMs: null, generateMs: null, replyMs: null, processingMs: null, strip: null };
}

export function overlayLiveTimeBucketState(measured: TimeBucketView, live: TimeBucketView): TimeBucketView {
  const view = overlayLiveTimeBucketStateCore(measured, live);
  if ((live.generationBoundaryAt ?? 0) > (measured.generationBoundaryAt ?? 0)) return view;
  const liveSpans = live.mainModelSpans ?? [];
  const covered = unionSpans(liveSpans.map(span => [span.start, span.end]));
  const mainModelSpans = [...(measured.mainModelSpans ?? []).flatMap(span =>
    subtractSpans([[span.start, span.end]], covered).map(([start, end]) => ({ ...span, start, end }))), ...liveSpans];
  return { ...view, mainModelSpans };
}

function overlayLiveTimeBucketStateCore(measured: TimeBucketView, live: TimeBucketView): TimeBucketView {
  if ((live.generationBoundaryAt ?? 0) > (measured.generationBoundaryAt ?? 0)) return live;
  if ((measured.generationBoundaryAt ?? 0) > (live.generationBoundaryAt ?? 0)) return measured;
  const liveAgents = new Map(live.agents.map((a) => [a.toolUseId, a]));
  const agents: AgentSpanView[] = measured.agents.map((a) => {
    const l = liveAgents.get(a.toolUseId);
    if (l === undefined) return a;
    const attributed = { ...a, blockId: l.blockId, stepKey: l.stepKey };
    if (l.open === a.open) return l.open ? { ...attributed, end: Math.max(a.end, l.end) } : attributed;
    if (l.open) return { ...attributed, open: true, end: Math.max(a.end, l.end), endSource: "open" };
    return { ...attributed, open: false, end: l.end, endSource: l.endSource };
  });
  for (const l of live.agents) {
    if (measured.agents.some((a) => a.toolUseId === l.toolUseId)) continue;
    agents.push(l);
  }
  const liveBg = new Map(live.backgroundTasks.map((t) => [t.toolUseId, t]));
  const backgroundTasks: BackgroundTaskSpanView[] = measured.backgroundTasks.map((t) => {
    const l = liveBg.get(t.toolUseId);
    if (l === undefined) return t;
    const attributed = { ...t, blockId: l.blockId, stepKey: l.stepKey };
    if (l.open === t.open) return l.open ? { ...attributed, end: Math.max(t.end, l.end) } : attributed;
    if (l.open) return { ...attributed, open: true, end: Math.max(t.end, l.end), endSource: "open" };
    return { ...attributed, open: false, end: l.end, endSource: l.endSource };
  });
  for (const l of live.backgroundTasks) {
    if (measured.backgroundTasks.some((t) => t.toolUseId === l.toolUseId)) continue;
    backgroundTasks.push(l);
  }
  const mergedSpans: Span[] = [
    ...agents.map((a) => [a.start, a.end] as Span),
    ...backgroundTasks.map((t) => [t.start, t.end] as Span),
  ];
  const turnParallel = live.turnOpen && live.tail.main !== "confirm" ? 1 : 0;
  const mergedParallel = turnParallel + agents.filter((a) => a.open).length + backgroundTasks.filter((t) => t.open).length;
  let blocks: RequestBlockView[] = measured.blocks.map(block => ({ ...block, running: false }));
  // Rows route the view's intervals (src/plan-steps.ts#planFrame), so the live part after the measured data reaches them
  // from the same source as the refreshed block metrics.
  const horizon = measured.blocks.at(-1)?.end;
  let intervals = measured.intervals;
  const liveLast = live.blocks.at(-1);
  if (liveLast !== undefined && (liveLast.running || (live.lastAt ?? 0) > (measured.lastAt ?? 0))) {
    const caughtUp = (live.lastAt ?? 0) >= (measured.lastAt ?? 0);
    const provisional = liveLast.running || (live.lastAt ?? 0) > (measured.lastAt ?? 0);
    // Block ids name the opening request or call (src/time-buckets.ts#positionalBlockId), so a measured block and its live
    // fold match by id alone.
    const liveById = new Map(live.blocks.map(block => [block.blockId, block]));
    const lastIndex = blocks.length - 1;
    blocks = blocks.map((block, index) => {
      const liveBlock = liveById.get(block.blockId);
      if (liveBlock === undefined) return block;
      if (liveBlock.kind !== block.kind) return provisionalBlock(liveBlock);
      if (index === lastIndex) {
        if (block.closedAt !== undefined) return block;
        return { ...(caughtUp ? refreshPlan(block, liveBlock, provisional) : block), start: block.start, anchorAt: block.anchorAt,
          requestNumber: block.requestNumber ?? liveBlock.requestNumber, running: liveBlock.running, end: Math.max(block.end, liveBlock.end) };
      }
      // Items of earlier blocks still in progress keep receiving live work after their block's window.
      if (!caughtUp || horizon === undefined || block.kind !== "plan" || !block.steps?.length) return block;
      const selected = (liveBlock.conductorAttribution ?? []).some(segment => segment.end > horizon && segment.keys.length > 0);
      return { ...refreshPlan(block, liveBlock, selected, horizon), start: block.start, anchorAt: block.anchorAt,
        requestNumber: block.requestNumber ?? liveBlock.requestNumber, running: false, end: block.end };
    });
    // A live block the measured view lacks is new. One without an identity cannot be matched, so it is new only once it
    // starts after everything measured; before that the transcript holds it under its own id.
    const known = new Set(blocks.map(block => block.blockId));
    const added = live.blocks.filter(block => !known.has(block.blockId)
      && (!isPositionalLiveBlockId(block.blockId) || block.start > (measured.lastAt ?? Number.NEGATIVE_INFINITY))).map(provisionalBlock);
    const ordered = [...blocks, ...added].sort((a, b) => a.start - b.start);
    // A block lasts until the next one starts; only the last can still run. A block whose end moves takes the live fold's
    // numbers, which were derived with that end, or none.
    blocks = ordered.map((block, index) => {
      const next = ordered[index + 1];
      if (next === undefined) return block;
      if (block.end <= next.start) return { ...block, running: false };
      const liveBlock = liveById.get(block.blockId);
      const moved = liveBlock !== undefined && liveBlock.end <= next.start ? provisionalBlock(liveBlock) : { ...provisionalBlock(block), durationMs: null };
      return { ...moved, end: Math.min(moved.end, next.start), running: false };
    });
    if (caughtUp && horizon !== undefined) intervals = [...measuredBefore(measured.intervals, horizon), ...liveAfter(live.intervals, horizon)];
  }
  // A span the live fold placed in a block the view does not show keeps its measured placement, or is placed by time.
  const shown = new Set(blocks.map(block => block.blockId));
  const measuredSpans = new Map<string, { blockId?: string; stepKey?: string }>([...measured.agents, ...measured.backgroundTasks].map(span => [span.toolUseId, span]));
  const placed = <T extends { toolUseId: string; blockId?: string; stepKey?: string }>(span: T): T => {
    if (span.blockId === undefined || shown.has(span.blockId)) return span;
    const { blockId: _blockId, stepKey: _stepKey, ...unplaced } = span;
    const kept = measuredSpans.get(span.toolUseId);
    return { ...unplaced, ...(kept?.blockId === undefined ? {} : { blockId: kept.blockId }), ...(kept?.stepKey === undefined ? {} : { stepKey: kept.stepKey }) } as T;
  };
  return {
    ...measured,
    intervals,
    agents: agents.map(placed),
    backgroundTasks: backgroundTasks.map(placed),
    blocks,
    subagentOnlySpans: live.subagentOnlySpans ?? measured.subagentOnlySpans,
    agentCount: agents.length,
    currentParallel: mergedParallel,
    maxConcurrency: Math.max(measured.maxConcurrency, sweepMax(mergedSpans), mergedParallel),
    turnOpen: live.turnOpen,
    tail: live.tail,
  };
}
