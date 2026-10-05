import type { NormalizedEvent } from "./protocol";
import { redactAbsolutePaths } from "./path-redaction";
import { isPureCommandWrapper, INJECTED_TAG_RE, STEER_TAG_RE } from "./human-input-vocabulary";
import { isBookkeepingTool, foldPlanDeclarationText, parseTaskIntentFromRawInput, taskCreateKeyFromResult, type TaskIntent, type WorkModelState } from "./work-model";
import { planStepKey, planStepAt, transitionPlanStep, type PlanStepTiming, type PlanStepTransition } from "./plan-steps";
import type { PlanUsage, PlanTokenTotal } from "./plan-usage";
import { isExternalRunTool } from "./orchestration-executors";
import * as l10n from "@vscode/l10n";

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
export const MAX_BLOCK_TEXT = 600;
export const MAX_MODEL_MARKS = 4096;
export const MAIN_MODEL_TOP_COUNT = 3;
const TASK_NOTIFICATION_MARKER = "A task-notification fires each time this agent stops";

export function isRequestMessageText(text: string): boolean {
  const human = text.trim();
  return human.length > 0 && !isPureCommandWrapper(human) && (!INJECTED_TAG_RE.test(human) || STEER_TAG_RE.test(human)) && !human.includes(TASK_NOTIFICATION_MARKER);
}

export interface TurnSpan {
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

function keyedSet<V>(log: KeyedLog<V>, key: string, value: V): KeyedLog<V> {
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
}

export interface DelegationSpan {
  toolUseId: string;
  turnId: string;
  startedAt: number;
  ackEndedAt?: number;
  notifiedEndedAt?: number;
  isBackground: boolean;
  firstChildAt?: number;
  lastChildAt?: number;
  transcriptAgentId?: string;
  description: string;
  subagentType?: string;
  model?: string;
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
  taskKey: string;
  transitions: PlanStepTransition[];
}
export interface PlanBlockMetrics {
  provisional?: boolean;
  generateMs: number | null; toolMs: number | null; subagentWaitMs: number | null; subagentOnlyMs: number | null;
  decisionWaitMs: number | null; replyWaitMs: number | null; tokens: PlanTokenTotal | null;
}
export interface PlanBlockStepView extends PlanStepTiming, PlanBlockMetrics {
  end: number | null; durationMs: number | null; longest: boolean; parallel: boolean;
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
  userMessages?: { at: number; text: string }[];
}

export interface TimeBucketState {
  fidelity: TimeFidelity;
  inheritedBoundaryCount: number;
  firstAt?: number;
  lastAt?: number;
  turnSpans: AppendList<TurnSpan>;
  openTurn?: { turnId: string; startedAt: number };
  openTools: Record<string, { at: number; toolName: string; lane: TimeLane; parentToolUseId: string | null; turnId: string; description?: string; taskIntent?: TaskIntent }>;
  planText?: WorkModelState["planText"];
  planDeclarationBlockId?: string;
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
}

type NumberedRequests = readonly { turnIds: readonly string[]; number: string }[];
interface RequestNumberEntry {
  number: string;
  next: string;
}

function requestNumberOf(log: KeyedLog<RequestNumberEntry>, turnId: string): string | undefined {
  let entry = keyedGet(log, turnId);
  let id = turnId;
  for (let hops = 0; entry !== undefined && entry.next !== id && hops < log.keyCount; hops++) {
    const following = keyedGet(log, entry.next);
    if (following === undefined) break;
    id = entry.next;
    entry = following;
  }
  return entry?.number;
}

export function attachTimeBucketRequestNumbers(state: TimeBucketState, requests: NumberedRequests): TimeBucketState {
  const numbers = new Map(requests.flatMap(request => request.turnIds.map(id => [id, request.number] as const)));
  const seen = new Set(state.numberedRequests ?? []);
  let requestNumbers = state.requestNumbers;
  let renumbered = false;
  for (const request of requests) {
    if (seen.has(request)) continue;
    request.turnIds.forEach((id, i) => {
      const cached = keyedGet(requestNumbers, id);
      const next = i + 1 < request.turnIds.length ? request.turnIds[i + 1] : id;
      if (cached === undefined) requestNumbers = keyedSet(requestNumbers, id, { number: request.number, next });
      else if (cached.number !== request.number || cached.next === id && next !== id) {
        if (cached.number !== request.number) renumbered = true;
        requestNumbers = keyedSet(requestNumbers, id, { number: request.number, next: cached.next === id ? next : cached.next });
      }
    });
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

function appendWorkBlock(state: TimeBucketState, block: Omit<RequestBlockRecord, "blockId">): TimeBucketState {
  const blocks = [...state.blocks, { ...block, requestNumber: block.requestNumber ?? (block.turnId === null ? undefined : requestNumberOf(state.requestNumbers, block.turnId)),
    blockId: `block:${state.blocks.length + state.droppedBlockCount + 1}` }];
  const dropped = Math.max(0, blocks.length - MAX_TIME_BLOCKS);
  return { ...state, blocks: dropped ? blocks.slice(dropped) : blocks, droppedBlockCount: state.droppedBlockCount + dropped };
}

function applyPlanTask(state: TimeBucketState, intent: TaskIntent, at: number, turnId: string, result: string): TimeBucketState {
  let index = state.blocks.length - 1;
  if (intent.kind === "update") {
    while (index >= 0 && !state.blocks[index].steps?.some(step => step.taskKey === intent.taskKey)) index--;
    if (index < 0) return state;
  } else if (state.blocks[index]?.kind !== "plan" || state.blocks[index].closedAt !== undefined) {
    const title = intent.kind === "todo" ? intent.items.find(item => item.status !== "completed")?.description : intent.subject;
    if (!title?.trim()) return state;
    const declared = state.blocks.find(block => block.blockId === state.planDeclarationBlockId);
    const goal = declared?.closedAt === undefined && declared?.steps?.length === 0 ? declared.goal : undefined;
    state = appendWorkBlock(state, { kind: "plan", goal, text: goal ?? redactAbsolutePaths(title), start: at, turnId, steps: [], userMessages: [] });
    index = state.blocks.length - 1;
    if (goal) state = { ...state, planDeclarationBlockId: state.blocks[index].blockId };
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
  for (const item of items) {
    const key = planStepKey(source, item);
    if (present.has(key)) continue;
    present.add(key);
    let step = steps.find(value => value.key === key);
    if (!step) {
      if (intent.kind === "todo" && item.status === "completed") continue;
      step = { key, taskKey: item.taskKey, title: redactAbsolutePaths(item.description), status: "unknown", removed: false, startedAt: null, endedAt: null, transitions: [] };
      steps.push(step);
    }
    const removed = intent.kind === "update" && intent.deleted === true;
    if (transitionPlanStep(step, at, item.status, removed)) step.transitions.push({ at, active: !removed && item.status === "in_progress", order: ++order });
    step.title = redactAbsolutePaths(item.description);
  }
  if (intent.kind === "todo") for (const step of steps) {
    if (present.has(step.key) || step.removed) continue;
    transitionPlanStep(step, at, step.status, true);
    step.transitions.push({ at, active: false, order: ++order });
  }
  const blocks = [...state.blocks];
  blocks[index] = { ...block, steps, text: block.goal ?? steps.find(step => !step.removed && step.status !== "completed")?.title ?? block.text };
  return { ...state, blocks };
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

export function foldTimeBuckets(state: TimeBucketState, event: NormalizedEvent): TimeBucketState {
  const ts = typeof event.timestamp === "number" && event.timestamp > 0 ? event.timestamp : undefined;
  let next: TimeBucketState = state;
  const touch = (): TimeBucketState => (next === state ? (next = { ...state }) : next);
  if (ts !== undefined && isWindowKind(event.kind)) {
    if (state.firstAt === undefined || ts < state.firstAt) touch().firstAt = ts;
    if (state.lastAt === undefined || ts > state.lastAt) touch().lastAt = ts;
  }

  switch (event.kind) {
    case "assistant_message_uuid":
      if (state.planText?.turnId === event.turnId) touch().planText = { ...state.planText, recordEnded: true };
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
        if (current?.kind === "plan" && !current.goal && current.closedAt === undefined && !current.userMessages?.length) {
          next = { ...next, blocks: [...next.blocks.slice(0, -1), { ...current, goal, text: goal }] };
        } else next = appendWorkBlock(next, { kind: "plan", goal, text: goal, start: ts, turnId: event.turnId, steps: [], userMessages: [] });
        next = { ...next, planDeclarationBlockId: next.blocks.at(-1)!.blockId };
      }
      return next;
    }
    case "compact_boundary": {
      if (event.priorGeneration !== true || ts === undefined) return next;
      const current = state.blocks.at(-1);
      if (current?.kind === "plan" && current.closedAt === undefined) touch().blocks = [...state.blocks.slice(0, -1), { ...current, closedAt: ts }];
      touch().planText = undefined;
      touch().planDeclarationBlockId = undefined;
      touch().lastAt = Math.max(next.lastAt ?? ts, ts);
      return next;
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
      if (event.provenance?.path !== "history") {
        n.inheritedBoundaryCount = state.inheritedBoundaryCount + 1;
        n.fidelity = "inherited";
      }
      if (ts === undefined) return n;
      if (state.openTurn !== undefined) {
        n.turnSpans = appendItem(state.turnSpans, { turnId: state.openTurn.turnId, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, ts) });
      }
      const pending = n.blocks.at(-1);
      if (pending?.turnId === null) n.blocks = [...n.blocks.slice(0, -1), { ...pending, turnId: event.turnId }];
      n.openTurn = { turnId: event.turnId, startedAt: ts };
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
      n.turnSpans = appendItem(state.turnSpans, { turnId: state.openTurn.turnId, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, ts) });
      n.openTurn = undefined;
      return n;
    }
    case "user_message": {
      if (ts === undefined) return next;
      if (!isRequestMessageText(event.text)) return next;
      const current = state.blocks.at(-1);
      if (current?.kind === "plan" && current.closedAt === undefined && (current.steps ?? []).some(step => !step.removed && step.status !== "completed")) {
        touch().blocks = [...state.blocks.slice(0, -1), { ...current, userMessages: [...current.userMessages ?? [],
          { at: ts, text: redactAbsolutePaths(event.text.trim().split(/\r?\n/, 1)[0]).slice(0, MAX_BLOCK_TEXT) }] }];
        return next;
      }
      const n = touch();
      const text = redactAbsolutePaths(event.text.trim()).slice(0, MAX_BLOCK_TEXT);
      const block: RequestBlockRecord = {
        blockId: `block:${state.blocks.length + state.droppedBlockCount + 1}`,
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
      let taskIntent = event.taskIntentStructured;
      if (!taskIntent && lane === "main" && ["TodoWrite", "TaskCreate", "TaskUpdate"].includes(event.toolName)) {
        try { taskIntent = parseTaskIntentFromRawInput(event.toolName, JSON.parse(event.inputPreview), event.toolUseId); }
        catch { taskIntent = undefined; }
      }
      n.openTools = {
        ...state.openTools,
        [event.toolUseId]: {
          at: ts,
          toolName: event.toolName,
          lane,
          parentToolUseId: event.parentToolUseId,
          turnId: event.turnId,
          ...(taskIntent ? { taskIntent } : {}),
          ...(event.inputSummary !== undefined ? { description: redactAbsolutePaths(event.inputSummary).slice(0, 200) } : {}),
        },
      };
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
            firstChildAt: d.firstChildAt === undefined ? ts : Math.min(d.firstChildAt, ts),
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
      const open = state.openTools[event.toolUseId];
      if (open === undefined || ts === undefined) return next;
      const n = touch();
      const { [event.toolUseId]: _, ...rest } = state.openTools;
      n.openTools = rest;
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
      };
      if (open.lane === "main") n.mainTools = pushBounded(state.mainTools, interval, n);
      else n.subTools = pushBounded(state.subTools, interval, n);
      const parentKey = open.lane === "main" ? event.toolUseId : open.parentToolUseId;
      const d = parentKey !== null ? (keyedGet(n.delegations, parentKey) ?? keyedGet(state.delegations, parentKey)) : undefined;
      if (d !== undefined) {
        const updated: DelegationSpan = { ...d };
        if (open.lane === "main") {
          updated.ackEndedAt = interval.end;
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
        ? applyPlanTask(n, open.taskIntent, ts, open.turnId, event.resultPreview) : n;
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

export interface MainModelTimeEntry {
  kind: "model" | "other" | "unknown";
  label: string;
  model: string | null;
  foldedModelCount: number | null;
  generateMs: number;
  share: number | null;
  percent: number | null;
}

export interface MainTimeByModelView {
  totalMs: number;
  generateMs: number;
  models: MainModelTimeEntry[];
  toolMs: number;
  toolShare: number | null;
  toolPercent: number | null;
}

export interface TimeBucketView {
  fidelity: TimeFidelity;
  inheritedBoundaryCount: number;
  firstAt: number | null;
  lastAt: number | null;
  spanMs: number | null;
  main: TimeBucketTotals;
  sub: { generateMs: number; toolMs: number; spanMs: number };
  bars: { totalMs: number | null; mainMs: number | null; toolMs: number | null; subMs: number };
  mainByModel: MainTimeByModelView | null;
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

export function deriveMainByModel(
  turns: readonly TurnSpan[],
  generate: readonly Span[],
  toolMs: number,
  marks: readonly ModelMark[]
): MainTimeByModelView {
  const sortedMarks = [...marks].sort((a, b) => a.at - b.at);
  const byModel = new Map<string, number>();
  let unknownMs = 0;
  let covered = -Infinity;
  let gi = 0;
  const credit = (model: string | undefined, s0: number, s1: number): void => {
    const start = Math.max(s0, covered);
    if (s1 <= start) return;
    covered = s1;
    while (gi < generate.length && generate[gi][1] <= start) gi++;
    let ms = 0;
    for (let j = gi; j < generate.length && generate[j][0] < s1; j++) {
      ms += Math.max(0, Math.min(s1, generate[j][1]) - Math.max(start, generate[j][0]));
    }
    if (ms <= 0) return;
    if (model === undefined) unknownMs += ms;
    else byModel.set(model, (byModel.get(model) ?? 0) + ms);
  };
  let mi = 0;
  let current: string | undefined;
  for (const t of [...turns].sort((a, b) => a.start - b.start)) {
    while (mi < sortedMarks.length && sortedMarks[mi].at <= t.start) current = sortedMarks[mi++].model;
    let cursor = t.start;
    while (mi < sortedMarks.length && sortedMarks[mi].at <= t.end) {
      const mark = sortedMarks[mi++];
      credit(mark.model, cursor, mark.at);
      cursor = mark.at;
      current = mark.model;
    }
    credit(current, cursor, t.end);
  }
  const generateMs = measureSpans(generate);
  const totalMs = generateMs + toolMs;
  const ranked = [...byModel].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const models: MainModelTimeEntry[] = ranked.slice(0, MAIN_MODEL_TOP_COUNT).map(([model, ms]) => ({
    kind: "model",
    label: model.replace(/^claude-/, ""),
    model,
    foldedModelCount: null,
    generateMs: ms,
    share: null,
    percent: null,
  }));
  const folded = ranked.slice(MAIN_MODEL_TOP_COUNT);
  if (folded.length > 0) {
    models.push({
      kind: "other",
      label: l10n.t("Other {0} models", folded.length),
      model: null,
      foldedModelCount: folded.length,
      generateMs: folded.reduce((acc, [, v]) => acc + v, 0),
      share: null,
      percent: null,
    });
  }
  if (unknownMs > 0) {
    models.push({
      kind: "unknown",
      label: l10n.t("Model not observed"),
      model: null,
      foldedModelCount: null,
      generateMs: unknownMs,
      share: null,
      percent: null,
    });
  }
  if (totalMs <= 0) return { totalMs, generateMs, models, toolMs, toolShare: null, toolPercent: null };
  const parts = [...models.map((m) => m.generateMs), toolMs];
  const percents = largestRemainderPercents(parts, totalMs);
  models.forEach((m, i) => {
    m.share = m.generateMs / totalMs;
    m.percent = percents[i];
  });
  return { totalMs, generateMs, models, toolMs, toolShare: toolMs / totalMs, toolPercent: percents[parts.length - 1] };
}

function largestRemainderPercents(parts: readonly number[], total: number): number[] {
  const raw = parts.map((p) => (p / total) * 100);
  const floors = raw.map((r) => Math.floor(r));
  let rest = 100 - floors.reduce((acc, v) => acc + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]++;
    rest--;
  }
  return floors;
}

export function deriveTimeBuckets(
  state: TimeBucketState,
  options?: {
    childSpans?: readonly ChildTranscriptSpan[];
    streamOpen?: boolean;
    liveDelegationAgentIds?: ReadonlySet<string>;
    modelMarks?: readonly ModelMark[];
  }
): TimeBucketView {
  const firstAt = state.firstAt ?? null;
  const lastAt = state.lastAt ?? null;
  const spanMs = firstAt !== null && lastAt !== null ? Math.max(0, lastAt - firstAt) : 0;
  const end = lastAt ?? 0;
  const inherited = state.inheritedBoundaryCount > 0;

  const turnSpansAll: TurnSpan[] = appendListItems(state.turnSpans);
  if (state.openTurn !== undefined && lastAt !== null) {
    turnSpansAll.push({ turnId: state.openTurn.turnId, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, end) });
  }
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
    .filter((t) => !isSubagentWaitTool(t.toolName))
    .map((t) => [t.start, t.end] as Span);
  for (const open of Object.values(state.openTools)) {
    if (open.lane !== "main" || lastAt === null || isSubagentWaitTool(open.toolName)) continue;
    nonDelegationToolSpans.push([open.at, Math.max(open.at, end)]);
  }
  const toolUnion = subtractSpans(unionSpans(nonDelegationToolSpans), confirmUnion);
  const subagentWaitUnion = subtractSpans(callUnion, toolUnion);

  const childByToolUseId = new Map<string, ChildTranscriptSpan>();
  for (const c of options?.childSpans ?? []) childByToolUseId.set(c.toolUseId, c);
  const subToolsByAgent = new Map<string, ToolInterval[]>();
  for (const t of state.subTools) {
    if (t.agentId === undefined) continue;
    const list = subToolsByAgent.get(t.agentId) ?? [];
    list.push(t);
    subToolsByAgent.set(t.agentId, list);
  }
  const agents: AgentSpanView[] = [];
  for (const d of keyedValues(state.delegations)) {
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
      toolCount: tools.length,
      failCount: tools.filter((t) => t.isError).length,
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
  const subActiveUnion = unionSpans([...agentSpans, ...subagentBackgroundSpans]);

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
  const mainByModel =
    inherited || options?.modelMarks === undefined
      ? null
      : deriveMainByModel(turnSpansAll, intersectSpans(generateSpans, whole), toolMs, options.modelMarks);
  const subGenerate = agents.reduce((acc, a) => acc + a.generateMs, 0);
  const subTool = agents.reduce((acc, a) => acc + a.toolMs, 0);
  const subSpan = agents.reduce((acc, a) => acc + Math.max(0, a.end - a.start), 0);
  const subBarMs = subagentBackgroundSpans.reduce((acc, [s0, s1]) => acc + (s1 - s0), subSpan);

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

  const allSteps = state.blocks.flatMap(block => (block.steps ?? []).map(step => ({ ...step, closedAt: block.closedAt, blockId: block.blockId, key: `${block.blockId}\n${step.key}`, stepKey: step.key })));
  const allTransitions = new Map(allSteps.map(step => [step.key, step.transitions]));
  const attribute = (agent: AgentSpanView | BackgroundTaskSpanView, launchedAt: number, blockId: string) => {
    const step = planStepAt(allSteps.filter(value => value.closedAt === undefined || launchedAt < value.closedAt), allTransitions, launchedAt);
    agent.blockId = step?.blockId ?? blockId;
    agent.stepKey = step?.stepKey;
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
      return { key: step.key, title: redactAbsolutePaths(step.title), status: step.status, removed: step.removed,
        startedAt: step.startedAt, endedAt: step.endedAt, end: stop,
        durationMs: inherited || stop === null ? null : Math.max(0, stop - step.startedAt!), longest: false, parallel: false,
        ...metrics(step.startedAt, stop ?? bEnd), provisional: running };
    });
    const activeSpans = (step: PlanBlockStepRecord): Span[] => step.transitions.flatMap((change, index) => change.active
      ? [[change.at, Math.min(step.transitions[index + 1]?.at ?? end, b.closedAt ?? end)] as Span] : []);
    const stepSpans = (b.steps ?? []).map(activeSpans);
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
      ...(b.kind === "plan" ? { goal: b.goal, ...(b.closedAt === undefined ? {} : { closedAt: b.closedAt }), steps, userMessages: b.userMessages ?? [], metrics: { ...metrics(b.start, bEnd), provisional: running } } : {}),
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
    mainByModel,
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
    }
    return result;
  };
  const byId = new Map(usage.blocks.map(block => [block.blockId, block]));
  const allSlices = usage.blocks.flatMap(block => block.slices);
  return { ...view, blocks: view.blocks.map(block => {
    if (block.kind !== "plan") return block;
    const observed = byId.get(block.blockId);
    const slices = observed?.slices ?? [];
    return { ...block, metrics: { ...block.metrics!, tokens: slices.length && observed
      ? { tokens: observed.tokens, cacheRead: observed.cacheRead } : null },
      steps: block.steps?.map(step => ({ ...step, tokens: total(allSlices, step.startedAt, step.end ?? block.end) })) };
  }) };
}

export function currentWorkBlock(state: TimeBucketState): RequestBlockRecord | undefined { const block = state.blocks.at(-1); return block?.closedAt === undefined ? block : undefined; }

function retainObserved<T extends object>(measured: T, live: T): T {
  return { ...measured, ...Object.fromEntries(Object.entries(live).filter(([, value]) => value !== null && value !== undefined)) };
}

function refreshCurrentPlan(measured: RequestBlockView, live: RequestBlockView, provisional: boolean): RequestBlockView {
  const steps = new Map(measured.steps?.map(step => [step.key, step]));
  for (const step of live.steps ?? []) {
    const previous = steps.get(step.key);
    steps.set(step.key, { ...(previous ? { ...retainObserved(previous, step), longest: step.durationMs === null ? previous.longest : step.longest } : step), provisional });
  }
  const messages = new Map([...measured.userMessages ?? [], ...live.userMessages ?? []].map(message => [`${message.at}:${message.text}`, message]));
  return { ...retainObserved(measured, live),
    metrics: { ...(measured.metrics && live.metrics ? retainObserved(measured.metrics, live.metrics) : live.metrics ?? measured.metrics!), provisional },
    steps: [...steps.values()].map(step => ({ ...step, provisional })), userMessages: [...messages.values()].sort((a, b) => a.at - b.at) };
}

export function overlayLiveTimeBucketState(measured: TimeBucketView, live: TimeBucketView): TimeBucketView {
  const liveAgents = new Map(live.agents.map((a) => [a.toolUseId, a]));
  const agents: AgentSpanView[] = measured.agents.map((a) => {
    const l = liveAgents.get(a.toolUseId);
    if (l === undefined) return a;
    const attributed = { ...a, blockId: l.blockId, stepKey: l.stepKey };
    if (l.open === a.open) return attributed;
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
    if (l.open === t.open) return attributed;
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
  const blocks: RequestBlockView[] = measured.blocks.map(block => ({ ...block, running: false }));
  const liveLast = live.blocks[live.blocks.length - 1];
  if (liveLast !== undefined && (liveLast.running || (live.lastAt ?? 0) > (measured.lastAt ?? 0))) {
    const currentLast = blocks.at(-1);
    const sameOpening = currentLast !== undefined && currentLast.kind === liveLast.kind
      && (currentLast.goal !== undefined ? currentLast.goal === liveLast.goal
        : liveLast.goal === undefined && (currentLast.text === liveLast.text
          || currentLast.kind === "plan" && currentLast.steps?.some(step => liveLast.steps?.some(value => value.key === step.key))))
      && liveLast.start <= (measured.lastAt ?? currentLast.end) && liveLast.end >= currentLast.start;
    const at = currentLast?.blockId === liveLast.blockId && (currentLast.start === liveLast.start || sameOpening) ? blocks.length - 1 : -1;
    if (at >= 0 && at === blocks.length - 1 && blocks[at].closedAt === undefined) {
      const current = blocks[at];
      const refresh = liveLast.kind === "plan" && current.kind === "plan"
        && (live.lastAt ?? 0) >= (measured.lastAt ?? 0);
      const provisional = liveLast.running || (live.lastAt ?? 0) > (measured.lastAt ?? 0);
      blocks[at] = { ...(refresh ? refreshCurrentPlan(current, liveLast, provisional) : current), start: current.start, anchorAt: current.anchorAt,
        requestNumber: current.requestNumber ?? liveLast.requestNumber, running: liveLast.running, end: Math.max(current.end, liveLast.end) };
    } else if (blocks.length === 0 || liveLast.start > blocks[blocks.length - 1].start) {
      blocks.push(liveLast.kind === "plan" ? refreshCurrentPlan(liveLast, liveLast, true) : { ...liveLast, durationMs: null, generateMs: null, replyMs: null, processingMs: null, strip: null, running: liveLast.running });
    }
  }
  return {
    ...measured,
    agents,
    backgroundTasks,
    blocks,
    agentCount: agents.length,
    currentParallel: mergedParallel,
    maxConcurrency: Math.max(measured.maxConcurrency, sweepMax(mergedSpans), mergedParallel),
    turnOpen: live.turnOpen,
    tail: live.tail,
  };
}
