import { createHash } from "node:crypto";
import type { NormalizedEvent, ProgressState } from "./protocol";
import { progressSubjectKey } from "./progress-protocol";
import type { HostArtifactAccess } from "./artifact-access";
import { PROGRESS_WIRE_TOOL_NAME } from "./artifact-access";
import type { TaskIntent, TaskStatus } from "./work-model";
import { CLAUDE_VOCABULARY, taskCreateKeyFromResult } from "./work-model";
import { isPureCommandWrapper } from "./human-input-vocabulary";
import { redactAbsolutePaths } from "./path-redaction";
import { createTimeBucketState, foldTimeBuckets, type TimeBucketState } from "./time-buckets";
import { createExecLogMarkState, foldExecLogMarks, type ExecLogMarkState } from "./exec-log-marks";

export const MAX_TODO_TRANSITIONS = 2000;
export const MAX_PROGRESS_TRANSITIONS = 2000;
export const MAX_DELEGATIONS = 500;
export const MAX_ARTIFACT_ACCESSES = 5000;
export const MAX_EFFECT_GAPS = 5000;
export const MAX_PENDING_INTENTS = 256;
export const MAX_HUMAN_MESSAGE_TIMES = 500;
export const IDLE_GAP_MS = 5 * 60_000;
export const MAX_LONG_GAPS = 500;
const MAX_OPEN_SIDECHAIN_TOOLS = 1000;

export type IdentityStability = "stable" | "content-derived" | "heuristic" | "unknown";

export interface EvidenceRef {
  toolUseId?: string;
  agentId?: string;
  seq?: number;
}

export interface TaskIdentityBinding {
  semanticTaskId: string;
  taskKeys: string[];
  stability: IdentityStability;
  evidence: EvidenceRef[];
}

export interface TodoTransition {
  taskKey: string;
  from: TaskStatus;
  to: TaskStatus;
  at: number;
  evidence: EvidenceRef;
}

export interface DelegationRecord {
  agentId: string;
  toolUseId: string;
  parentToolUseId: string | null;
  agentType?: string;
  description?: string;
  activeTaskKeyAtStart?: string;
  activeAmbiguousAtStart: boolean;
  startedAt: number;
  endedAt?: number;
  transcriptAgentId?: string;
  reopens?: { at: number }[];
  isBackground?: true;
  evidence: EvidenceRef;
}

export interface ProgressTransitionRecord {
  state: ProgressState;
  at: number;
  toolUseId: string;
  agentId?: string;
  ownershipVerified: boolean;
  resolvedAssignmentRef?: string;
  activity?: string;
  blocker?: string;
  evidenceDecl?: string[];
  next?: string;
}

export interface ArtifactAccessRecord extends HostArtifactAccess {
  toolUseId: string;
  ownerAgentId?: string;
  at: number;
}

export interface EffectGapRecord {
  toolUseId: string;
  ownerAgentId?: string;
  at: number;
  coverage: "partial" | "unavailable";
}

export interface TaskTransitionSummary {
  taskKey: string;
  reopenCount: number;
  completedCount: number;
  lastTransition?: TodoTransition;
  firstStartedAt?: number;
}

export interface EvidenceCoverage {
  todoTransitions: number;
  delegations: number;
  artifactAccesses: number;
  effectGaps: number;
  longGaps: number;
}

export interface LongGapRecord {
  at: number;
  durationMs: number;
}

export interface GapScanState {
  lastAt?: number;
  lastTurnId?: string | null;
  lastCanStart: boolean;
  openSidechainToolUseIds: readonly string[];
}

export interface SemanticEvidenceIndex {
  bindings: TaskIdentityBinding[];
  todoTransitions: TodoTransition[];
  transitionSummaries: TaskTransitionSummary[];
  delegations: DelegationRecord[];
  artifactAccesses: ArtifactAccessRecord[];
  effectGaps: EffectGapRecord[];
  coverage: EvidenceCoverage;
  hash: string;
  humanMessageTimes: number[];
  firstHumanMessageLine?: string;
  firstHumanMessageText?: string;
  timeBuckets: TimeBucketState;
  execLogMarks: ExecLogMarkState;
  longGaps: LongGapRecord[];
  droppedLongGapMs: number;
  gapScan: GapScanState;
  progressTransitions: ProgressTransitionRecord[];
  invalidProgressCount: number;
  pendingIntents: Record<string, { intent: TaskIntent }>;
}

export interface RawRefLocation {
  file: string;
  line: number;
}

export type RawRefIndex = Map<string, RawRefLocation>;

export function createEvidenceIndex(): SemanticEvidenceIndex {
  return {
    bindings: [],
    todoTransitions: [],
    transitionSummaries: [],
    delegations: [],
    artifactAccesses: [],
    effectGaps: [],
    coverage: {
      todoTransitions: 0,
      delegations: 0,
      artifactAccesses: 0,
      effectGaps: 0,
      longGaps: 0,
    },
    hash: "",
    humanMessageTimes: [],
    longGaps: [],
    droppedLongGapMs: 0,
    gapScan: { lastCanStart: false, openSidechainToolUseIds: [] },
    progressTransitions: [],
    invalidProgressCount: 0,
    pendingIntents: {},
    timeBuckets: createTimeBucketState(),
    execLogMarks: createExecLogMarkState(),
  };
}

function cloneSummaries(index: SemanticEvidenceIndex): Map<string, TaskTransitionSummary> {
  const summaryMap = new Map<string, TaskTransitionSummary>();
  for (const s of index.transitionSummaries) {
    summaryMap.set(s.taskKey, { ...s });
  }
  return summaryMap;
}

function makeTransitionRecorder(
  summaryMap: Map<string, TaskTransitionSummary>,
  newTransitions: TodoTransition[],
  timestamp: number,
  evidenceRef: EvidenceRef
) {
  return function recordTransition(taskKey: string, toStatus: TaskStatus): void {
    const existingSummary = summaryMap.get(taskKey);
    const prevStatus: TaskStatus = existingSummary?.lastTransition?.to ?? "unknown";
    if (prevStatus === toStatus) {
      return;
    }

    const transition: TodoTransition = {
      taskKey,
      from: prevStatus,
      to: toStatus,
      at: timestamp,
      evidence: evidenceRef,
    };
    newTransitions.push(transition);

    const isReopen = prevStatus === "completed" && toStatus === "in_progress";
    const isCompleted =
      toStatus === "completed" &&
      prevStatus !== "completed" &&
      !(prevStatus === "unknown" && (existingSummary?.completedCount ?? 0) > 0);

    if (existingSummary) {
      existingSummary.lastTransition = transition;
      if (isReopen) {
        existingSummary.reopenCount += 1;
      }
      if (isCompleted) {
        existingSummary.completedCount += 1;
      }
      if (toStatus === "in_progress" && existingSummary.firstStartedAt === undefined) {
        existingSummary.firstStartedAt = timestamp;
      }
    } else {
      summaryMap.set(taskKey, {
        taskKey,
        reopenCount: 0,
        completedCount: isCompleted ? 1 : 0,
        lastTransition: transition,
        firstStartedAt: toStatus === "in_progress" ? timestamp : undefined,
      });
    }
  };
}

function activeTaskState(summaryMap: Map<string, TaskTransitionSummary>): {
  activeTaskKeyAtStart?: string;
  activeAmbiguousAtStart: boolean;
} {
  const inProgress: string[] = [];
  for (const s of summaryMap.values()) {
    if (s.lastTransition?.to === "in_progress") inProgress.push(s.taskKey);
  }
  return {
    activeTaskKeyAtStart: inProgress.length === 1 ? inProgress[0] : undefined,
    activeAmbiguousAtStart: inProgress.length > 1,
  };
}

function bookkeepingStability(taskKey: string): IdentityStability {
  if (taskKey.startsWith("task:pending:")) return "heuristic";
  return taskKey.startsWith("task:") ? "stable" : "content-derived";
}

function applyIntentAtFinish(
  index: SemanticEvidenceIndex,
  event: Extract<NormalizedEvent, { kind: "tool_call_finished" }>,
  intent: TaskIntent
): SemanticEvidenceIndex {
  const toolUseId = event.toolUseId;
  const timestamp = event.timestamp;
  const evidenceRef: EvidenceRef = { toolUseId, seq: event.seq };
  const summaryMap = cloneSummaries(index);
  const newTransitions: TodoTransition[] = [];
  const recordTransition = makeTransitionRecorder(summaryMap, newTransitions, timestamp, evidenceRef);

  const taskKeysFromIntent: string[] = [];
  if (intent.kind === "todo") {
    const currentKeys = new Set(intent.items.map((i) => i.taskKey));
    for (const s of summaryMap.values()) {
      if (
        s.taskKey.startsWith("todo:") &&
        !currentKeys.has(s.taskKey) &&
        s.lastTransition !== undefined &&
        s.lastTransition.to !== "unknown"
      ) {
        recordTransition(s.taskKey, "unknown");
      }
    }
    for (const item of intent.items) {
      taskKeysFromIntent.push(item.taskKey);
      recordTransition(item.taskKey, item.status);
    }
  } else if (intent.kind === "create") {
    const taskKey = taskCreateKeyFromResult(intent.toolUseId, event.resultPreview ?? "");
    taskKeysFromIntent.push(taskKey);
    recordTransition(taskKey, intent.status);
  } else if (intent.kind === "update") {
    taskKeysFromIntent.push(intent.taskKey);
    if (intent.deleted) {
      recordTransition(intent.taskKey, "unknown");
    } else if (intent.status !== undefined) {
      recordTransition(intent.taskKey, intent.status);
    }
  }

  const updatedBindings: TaskIdentityBinding[] = index.bindings.map((b) => ({
    ...b,
    taskKeys: [...b.taskKeys],
    evidence: [...b.evidence],
  }));
  for (const k of taskKeysFromIntent) {
    const binding = updatedBindings.find((b) => b.taskKeys.includes(k));
    if (binding) {
      if (!binding.evidence.some((e) => e.toolUseId === toolUseId)) {
        binding.evidence.push(evidenceRef);
      }
    } else {
      updatedBindings.push({
        semanticTaskId: k,
        taskKeys: [k],
        stability: bookkeepingStability(k),
        evidence: [evidenceRef],
      });
    }
  }

  let todoTransitions = [...index.todoTransitions, ...newTransitions];
  let droppedTodo = 0;
  if (todoTransitions.length > MAX_TODO_TRANSITIONS) {
    droppedTodo = todoTransitions.length - MAX_TODO_TRANSITIONS;
    todoTransitions = todoTransitions.slice(droppedTodo);
  }
  const pendingIntents = { ...index.pendingIntents };
  delete pendingIntents[toolUseId];

  return {
    ...index,
    bindings: updatedBindings,
    todoTransitions,
    transitionSummaries: Array.from(summaryMap.values()),
    coverage: { ...index.coverage, todoTransitions: index.coverage.todoTransitions + droppedTodo },
    hash: "",
    pendingIntents,
  };
}

function classifyGapEvent(
  event: NormalizedEvent,
  openSidechainToolUseIds: readonly string[]
): { canEnd: boolean; canStart: boolean; turnId: string | null } | null {
  switch (event.kind) {
    case "assistant_text_delta":
      return { canEnd: true, canStart: true, turnId: event.turnId ?? null };
    case "tool_call_started":
      if (event.parentToolUseId != null) return null;
      return { canEnd: true, canStart: true, turnId: event.turnId ?? null };
    case "turn_completed":
      return { canEnd: true, canStart: false, turnId: event.turnId ?? null };
    case "turn_started":
    case "user_message":
      return { canEnd: false, canStart: true, turnId: event.turnId ?? null };
    case "tool_call_finished":
      if (openSidechainToolUseIds.includes(event.toolUseId)) return null;
      return { canEnd: false, canStart: false, turnId: event.turnId ?? null };
    case "approval_request":
      return { canEnd: false, canStart: false, turnId: event.turnId ?? null };
    case "approval_resolved":
      return { canEnd: false, canStart: false, turnId: null };
    default:
      return null;
  }
}

function nextOpenSidechain(
  open: readonly string[],
  event: NormalizedEvent
): readonly string[] {
  if (event.kind === "tool_call_started") {
    if (event.parentToolUseId == null || open.includes(event.toolUseId)) return open;
    const added = [...open, event.toolUseId];
    return added.length > MAX_OPEN_SIDECHAIN_TOOLS
      ? added.slice(added.length - MAX_OPEN_SIDECHAIN_TOOLS)
      : added;
  }
  if (event.kind === "tool_call_finished") {
    const i = open.indexOf(event.toolUseId);
    if (i < 0) return open;
    return [...open.slice(0, i), ...open.slice(i + 1)];
  }
  return open;
}

function applyGapBoundaries(scan: GapScanState, boundaries: readonly number[]): GapScanState {
  let next = scan;
  for (const at of boundaries) {
    if (next.lastAt === undefined) continue;
    next = { ...next, lastAt: Math.max(next.lastAt, at), lastCanStart: false };
  }
  return next;
}

function foldGapScan(
  index: SemanticEvidenceIndex,
  event: NormalizedEvent,
  gapBoundaries?: readonly number[]
): SemanticEvidenceIndex {
  let scan =
    gapBoundaries !== undefined && gapBoundaries.length > 0
      ? applyGapBoundaries(index.gapScan, gapBoundaries)
      : index.gapScan;

  if (event.kind === "user_message" && isPureCommandWrapper(event.text)) {
    scan = applyGapBoundaries(scan, [event.timestamp]);
    const open = nextOpenSidechain(scan.openSidechainToolUseIds, event);
    if (scan === index.gapScan && open === scan.openSidechainToolUseIds) return index;
    return { ...index, gapScan: { ...scan, openSidechainToolUseIds: open } };
  }

  const cls = classifyGapEvent(event, scan.openSidechainToolUseIds);
  const openSidechainToolUseIds = nextOpenSidechain(scan.openSidechainToolUseIds, event);
  if (cls === null) {
    if (openSidechainToolUseIds === scan.openSidechainToolUseIds && scan === index.gapScan) {
      return index;
    }
    return { ...index, gapScan: { ...scan, openSidechainToolUseIds } };
  }

  const ts = event.timestamp;
  let recorded: LongGapRecord | undefined;
  let nextScan: GapScanState;

  const sameTurn =
    cls.turnId !== null && scan.lastTurnId === cls.turnId && scan.lastAt !== undefined;
  if (sameTurn) {
    if (cls.canEnd && scan.lastCanStart && ts - scan.lastAt! >= IDLE_GAP_MS) {
      recorded = { at: scan.lastAt!, durationMs: ts - scan.lastAt! };
    }
    nextScan = {
      lastAt: ts,
      lastTurnId: scan.lastTurnId,
      lastCanStart: cls.canStart,
      openSidechainToolUseIds,
    };
  } else if (cls.turnId === null && event.kind !== "user_message" && scan.lastAt !== undefined) {
    nextScan = {
      lastAt: ts,
      lastTurnId: scan.lastTurnId,
      lastCanStart: false,
      openSidechainToolUseIds,
    };
  } else {
    nextScan = {
      lastAt: ts,
      lastTurnId: cls.turnId,
      lastCanStart: cls.canStart,
      openSidechainToolUseIds,
    };
  }

  if (gapBoundaries !== undefined && gapBoundaries.some((at) => at >= ts)) {
    nextScan = { ...nextScan, lastCanStart: false };
  }

  if (recorded === undefined) return { ...index, gapScan: nextScan };
  let longGaps = [...index.longGaps, recorded];
  let droppedMs = 0;
  let droppedCount = 0;
  if (longGaps.length > MAX_LONG_GAPS) {
    droppedCount = longGaps.length - MAX_LONG_GAPS;
    for (let i = 0; i < droppedCount; i++) droppedMs += longGaps[i].durationMs;
    longGaps = longGaps.slice(droppedCount);
  }
  return {
    ...index,
    longGaps,
    droppedLongGapMs: index.droppedLongGapMs + droppedMs,
    coverage: { ...index.coverage, longGaps: index.coverage.longGaps + droppedCount },
    gapScan: nextScan,
  };
}

export function foldEvidence(
  index: SemanticEvidenceIndex,
  event: NormalizedEvent,
  hostArtifacts?: HostArtifactAccess[],
  gapBoundaries?: readonly number[]
): SemanticEvidenceIndex {
  const folded = foldGapScan(foldEvidenceBody(index, event, hostArtifacts), event, gapBoundaries);
  const timeBuckets = foldTimeBuckets(index.timeBuckets, event);
  const execLogMarks = foldExecLogMarks(index.execLogMarks, event);
  if (timeBuckets === index.timeBuckets && execLogMarks === index.execLogMarks) return folded;
  return { ...folded, timeBuckets, execLogMarks };
}

function foldEvidenceBody(
  index: SemanticEvidenceIndex,
  event: NormalizedEvent,
  hostArtifacts?: HostArtifactAccess[]
): SemanticEvidenceIndex {
  if (event.kind === "tool_call_finished") {
    let next = index;
    const pending = index.pendingIntents[event.toolUseId];
    if (pending) {
      if (event.isError) {
        const pendingIntents = { ...index.pendingIntents };
        delete pendingIntents[event.toolUseId];
        next = { ...index, pendingIntents };
      } else {
        next = applyIntentAtFinish(index, event, pending.intent);
      }
    }
    const di = next.delegations.findIndex((d) => d.toolUseId === event.toolUseId);
    if (di >= 0) {
      if (event.asyncLaunchedAgentId !== undefined && !event.isError) {
        if (next.delegations[di].transcriptAgentId !== event.asyncLaunchedAgentId) {
          const delegations = [...next.delegations];
          delegations[di] = { ...delegations[di], transcriptAgentId: event.asyncLaunchedAgentId };
          next = { ...next, delegations, hash: "" };
        }
      } else if (
        next.delegations[di].endedAt === undefined &&
        (next.delegations[di].isBackground !== true || event.isError === true)
      ) {
        const delegations = [...next.delegations];
        delegations[di] = { ...delegations[di], endedAt: event.timestamp };
        next = { ...next, delegations, hash: "" };
      }
    }
    if (event.resumedAgentId !== undefined && !event.isError) {
      const ri = next.delegations.findIndex((d) => d.transcriptAgentId === event.resumedAgentId);
      if (ri >= 0) {
        const delegations = [...next.delegations];
        const d = delegations[ri];
        delegations[ri] = {
          ...d,
          endedAt: undefined,
          reopens: [...(d.reopens ?? []), { at: event.timestamp }],
        };
        next = { ...next, delegations, hash: "" };
      }
    }
    if (event.taskNotification !== undefined) {
      const ni = next.delegations.findIndex(
        (d) => d.transcriptAgentId === event.taskNotification!.agentId
      );
      if (ni >= 0 && next.delegations[ni].endedAt === undefined) {
        const delegations = [...next.delegations];
        delegations[ni] = { ...delegations[ni], endedAt: event.timestamp };
        next = { ...next, delegations, hash: "" };
      }
    }
    return next;
  }

  if (event.kind === "user_message") {
    if (isPureCommandWrapper(event.text)) {
      return index;
    }
    let humanMessageTimes = [...index.humanMessageTimes, event.timestamp];
    if (humanMessageTimes.length > MAX_HUMAN_MESSAGE_TIMES) {
      humanMessageTimes = humanMessageTimes.slice(humanMessageTimes.length - MAX_HUMAN_MESSAGE_TIMES);
    }
    let firstHumanMessageLine = index.firstHumanMessageLine;
    let firstHumanMessageText = index.firstHumanMessageText;
    if (firstHumanMessageLine === undefined && typeof event.text === "string" && event.text.trim() !== "") {
      firstHumanMessageText = redactAbsolutePaths(event.text.trim()).slice(0, 2000);
      firstHumanMessageLine = event.text.trim().split(/\r?\n/, 1)[0].slice(0, 200);
    }
    return { ...index, humanMessageTimes, firstHumanMessageLine, firstHumanMessageText, hash: "" };
  }

  if (event.kind !== "tool_call_started") {
    return index;
  }

  const toolUseId = event.toolUseId;
  const parentToolUseId = event.parentToolUseId ?? null;
  const timestamp = event.timestamp;
  const seq = event.seq;

  const summaryMap = cloneSummaries(index);
  const { activeTaskKeyAtStart, activeAmbiguousAtStart } = activeTaskState(summaryMap);

  let pendingIntents = index.pendingIntents;
  if (event.taskIntentStructured) {
    pendingIntents = { ...pendingIntents, [toolUseId]: { intent: event.taskIntentStructured } };
    const keys = Object.keys(pendingIntents);
    if (keys.length > MAX_PENDING_INTENTS) {
      const trimmed = { ...pendingIntents };
      for (const k of keys.slice(0, keys.length - MAX_PENDING_INTENTS)) delete trimmed[k];
      pendingIntents = trimmed;
    }
  }

  const isDelegation =
    event.delegation !== undefined ||
    event.subagentType !== undefined ||
    CLAUDE_VOCABULARY.delegate.has(event.toolName);

  let newDelegation: DelegationRecord | undefined;
  if (isDelegation) {
    newDelegation = {
      agentId: `agent:${toolUseId}`,
      toolUseId,
      parentToolUseId,
      agentType: event.delegation?.subagentType ?? event.subagentType,
      ...(event.delegation?.description !== undefined ? { description: event.delegation.description } : {}),
      activeTaskKeyAtStart,
      activeAmbiguousAtStart,
      startedAt: timestamp,
      ...(event.delegation?.isBackground === true ? { isBackground: true as const } : {}),
      evidence: {
        toolUseId,
        seq,
        agentId: `agent:${toolUseId}`,
      },
    };
  }

  const updatedBindings: TaskIdentityBinding[] = index.bindings.map((b) => ({
    ...b,
    taskKeys: [...b.taskKeys],
    evidence: [...b.evidence],
  }));

  const newArtifactAccesses: ArtifactAccessRecord[] = [];
  if (hostArtifacts && hostArtifacts.length > 0) {
    const ownerAgentId = parentToolUseId ? `agent:${parentToolUseId}` : undefined;
    for (const art of hostArtifacts) {
      newArtifactAccesses.push({
        canonicalPath: art.canonicalPath,
        artifactId: art.artifactId,
        mode: art.mode,
        toolUseId,
        ownerAgentId,
        at: timestamp,
      });
    }
  }

  const newEffectGaps: EffectGapRecord[] = [];
  if (event.effectCoverage === "partial" || event.effectCoverage === "unavailable") {
    const ownerAgentId = parentToolUseId ? `agent:${parentToolUseId}` : undefined;
    newEffectGaps.push({
      toolUseId,
      ownerAgentId,
      at: timestamp,
      coverage: event.effectCoverage,
    });
  }

  const todoTransitions = index.todoTransitions;
  let delegations = newDelegation ? [...index.delegations, newDelegation] : index.delegations;
  let artifactAccesses = [...index.artifactAccesses, ...newArtifactAccesses];
  let effectGaps = [...index.effectGaps, ...newEffectGaps];

  let droppedDelegations = 0;
  if (delegations.length > MAX_DELEGATIONS) {
    droppedDelegations = delegations.length - MAX_DELEGATIONS;
    delegations = delegations.slice(droppedDelegations);
  }

  let droppedArtifacts = 0;
  if (artifactAccesses.length > MAX_ARTIFACT_ACCESSES) {
    droppedArtifacts = artifactAccesses.length - MAX_ARTIFACT_ACCESSES;
    artifactAccesses = artifactAccesses.slice(droppedArtifacts);
  }

  let droppedGaps = 0;
  if (effectGaps.length > MAX_EFFECT_GAPS) {
    droppedGaps = effectGaps.length - MAX_EFFECT_GAPS;
    effectGaps = effectGaps.slice(droppedGaps);
  }

  const coverage: EvidenceCoverage = {
    todoTransitions: index.coverage.todoTransitions,
    delegations: index.coverage.delegations + droppedDelegations,
    artifactAccesses: index.coverage.artifactAccesses + droppedArtifacts,
    effectGaps: index.coverage.effectGaps + droppedGaps,
    longGaps: index.coverage.longGaps,
  };

  let progressTransitions = index.progressTransitions;
  let invalidProgressCount = index.invalidProgressCount;
  if (event.toolName === PROGRESS_WIRE_TOOL_NAME) {
    const pe = event.progressEmission;
    if (pe === undefined) {
      invalidProgressCount = invalidProgressCount + 1;
    } else {
      const emitter = parentToolUseId ? `agent:${parentToolUseId}` : undefined;
      const inWindow = (d: DelegationRecord) =>
        d.agentId === emitter && isAssignmentActiveAt(d, timestamp, index.progressTransitions);
      const scoped = emitter === undefined ? [] : delegations.filter(inWindow);
      const only = scoped.length === 1 ? scoped[0] : undefined;
      const reopenedBefore = only?.reopens?.some((r) => r.at <= timestamp) === true;
      const candidates: DelegationRecord[] = only !== undefined && !reopenedBefore ? [only] : [];
      const ownershipVerified = candidates.length >= 1;
      const resolvedAssignmentRef =
        candidates.length === 1 ? `${candidates[0].agentId}@${candidates[0].startedAt}` : undefined;
      const rec: ProgressTransitionRecord = {
        state: pe.state,
        at: timestamp,
        toolUseId,
        ...(emitter !== undefined ? { agentId: emitter } : {}),
        ownershipVerified,
        ...(resolvedAssignmentRef !== undefined ? { resolvedAssignmentRef } : {}),
        ...(pe.activity !== undefined ? { activity: pe.activity } : {}),
        ...(pe.blocker !== undefined ? { blocker: pe.blocker } : {}),
        ...(pe.evidence !== undefined ? { evidenceDecl: pe.evidence } : {}),
        ...(pe.next !== undefined ? { next: pe.next } : {}),
      };
      progressTransitions = [...progressTransitions, rec];
      if (progressTransitions.length > MAX_PROGRESS_TRANSITIONS) {
        progressTransitions = progressTransitions.slice(progressTransitions.length - MAX_PROGRESS_TRANSITIONS);
      }
    }
  }

  return {
    bindings: updatedBindings,
    todoTransitions,
    transitionSummaries: index.transitionSummaries,
    delegations,
    humanMessageTimes: index.humanMessageTimes,
    firstHumanMessageLine: index.firstHumanMessageLine,
    firstHumanMessageText: index.firstHumanMessageText,
    timeBuckets: index.timeBuckets,
    execLogMarks: index.execLogMarks,
    longGaps: index.longGaps,
    droppedLongGapMs: index.droppedLongGapMs,
    gapScan: index.gapScan,
    artifactAccesses,
    effectGaps,
    coverage,
    hash: "",
    progressTransitions,
    invalidProgressCount,
    pendingIntents,
  };
}

export function assignmentRefOf(d: DelegationRecord): string {
  return `${d.agentId}@${d.startedAt}`;
}

export function isAssignmentActiveAt(
  d: DelegationRecord,
  at: number,
  transitions: readonly ProgressTransitionRecord[]
): boolean {
  if (d.startedAt > at) return false;
  if (d.endedAt !== undefined && at > d.endedAt) return false;
  const ref = assignmentRefOf(d);
  for (const t of transitions) {
    if (t.state !== "done") continue;
    if (t.resolvedAssignmentRef !== ref) continue;
    if (t.at <= at) return false;
  }
  return true;
}

export type AssignmentProgressState = "active" | "blocked" | "review";

export function deriveAssignmentProgressStates(index: SemanticEvidenceIndex): Record<string, AssignmentProgressState> {
  const refOf = assignmentRefOf;
  const scoped = new Map<string, ProgressState>();
  for (const t of index.progressTransitions) {
    if (!t.ownershipVerified) continue;
    if (t.resolvedAssignmentRef === undefined) continue;
    scoped.set(t.resolvedAssignmentRef, t.state);
  }
  let horizon = 0;
  for (const t of index.progressTransitions) if (t.at > horizon) horizon = t.at;
  for (const d of index.delegations) {
    if (d.startedAt > horizon) horizon = d.startedAt;
    if (d.endedAt !== undefined && d.endedAt > horizon) horizon = d.endedAt;
  }
  const evaluatedAt = horizon + 1;
  const out: Record<string, AssignmentProgressState> = {};
  for (const d of index.delegations) {
    if (!isAssignmentActiveAt(d, evaluatedAt, index.progressTransitions)) continue;
    const st = scoped.get(refOf(d));
    if (st === "active" || st === "blocked" || st === "review") {
      out[progressSubjectKey(`attempt:${d.toolUseId}`)] = st;
    }
  }
  return out;
}

function hashProjection(index: SemanticEvidenceIndex): unknown {
  const ref = (e: EvidenceRef) => ({ toolUseId: e.toolUseId, agentId: e.agentId });
  return {
    bindings: index.bindings.map((b) => ({
      semanticTaskId: b.semanticTaskId,
      taskKeys: [...b.taskKeys].sort(),
      stability: b.stability,
      evidence: b.evidence.map(ref),
    })),
    todoTransitions: index.todoTransitions.map((t) => ({
      taskKey: t.taskKey, from: t.from, to: t.to, at: t.at, evidence: ref(t.evidence),
    })),
    transitionSummaries: [...index.transitionSummaries]
      .sort((a, b) => (a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0))
      .map((s) => ({
        taskKey: s.taskKey,
        reopenCount: s.reopenCount,
        completedCount: s.completedCount,
        lastTransition: s.lastTransition
          ? {
              taskKey: s.lastTransition.taskKey,
              from: s.lastTransition.from,
              to: s.lastTransition.to,
              at: s.lastTransition.at,
              evidence: ref(s.lastTransition.evidence),
            }
          : undefined,
        firstStartedAt: s.firstStartedAt,
      })),
    delegations: index.delegations.map((d) => ({
      agentId: d.agentId,
      toolUseId: d.toolUseId,
      parentToolUseId: d.parentToolUseId,
      agentType: d.agentType,
      description: d.description,
      activeTaskKeyAtStart: d.activeTaskKeyAtStart,
      activeAmbiguousAtStart: d.activeAmbiguousAtStart,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      transcriptAgentId: d.transcriptAgentId,
      reopens: d.reopens?.map((r) => ({ at: r.at })),
      evidence: ref(d.evidence),
    })),
    artifactAccesses: index.artifactAccesses.map((a) => ({
      canonicalPath: a.canonicalPath, artifactId: a.artifactId, mode: a.mode,
      toolUseId: a.toolUseId, ownerAgentId: a.ownerAgentId, at: a.at,
    })),
    effectGaps: index.effectGaps.map((g) => ({
      toolUseId: g.toolUseId, ownerAgentId: g.ownerAgentId, at: g.at, coverage: g.coverage,
    })),
  };
}

function canonicalizeForHash(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const canonicalItem = canonicalizeForHash(item);
      if (canonicalItem !== undefined) {
        items.push(canonicalItem);
      }
    }
    return items;
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const result: Record<string, unknown> = {};
  let hasProperties = false;

  for (const k of keys) {

    const val = source[k];
    const canonicalVal = canonicalizeForHash(val);
    if (canonicalVal !== undefined) {
      result[k] = canonicalVal;
      hasProperties = true;
    }
  }

  if (!hasProperties) {
    return undefined;
  }
  return result;
}

function stringifyCanonical(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stringifyCanonical(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) {
      entries.push(JSON.stringify(k) + ":" + stringifyCanonical(v));
    }
  }
  return "{" + entries.join(",") + "}";
}

export function evidenceIndexHash(index: SemanticEvidenceIndex): string {
  const canonical = canonicalizeForHash(hashProjection(index));
  const json = canonical !== undefined ? stringifyCanonical(canonical) : "{}";
  return createHash("sha256").update(json).digest("hex");
}
