import { createHash } from "node:crypto";
import type { HostArtifactAccess } from "./artifact-access";
import type {
  ArtifactAccessRecord,
  DelegationRecord,
  EvidenceRef as EvidenceIndexRef,
  IdentityStability as EvidenceIdentityStability,
  ProgressTransitionRecord,
  SemanticEvidenceIndex,
  TodoTransition,
} from "./evidence-index";
import { assignmentRefOf, deriveAssignmentProgressStates } from "./evidence-index";
import { progressSubjectKey } from "./progress-protocol";
import type { TaskStatus, WorkCoverage, WorkModelState, WorkStatus } from "./work-model";
import { findToolPlacement, semanticRevision, type WorkAgent, type WorkSegment } from "./work-model";
import { deriveTimeBuckets, type ChildTranscriptSpan, type TimeBucketView } from "./time-buckets";
import { deriveExecLogFindings, execLogFindingsEmptyLabel, type ExecLogFindingView, type ExecLogMark } from "./exec-log-marks";

export const SEMANTIC_MODEL_SPEC_VERSION = 2;

export type SemanticMode = "recorded" | "fallback";

export type SemanticNodeKind = "goal" | "stage" | "task" | "attempt" | "agentRun";
export type AttemptRole = "implement" | "research" | "review" | "fix" | "verify" | "unknown";
export type IdentityStability = "stable" | "content-derived" | "unknown";

export interface EventEvidenceRef {
  kind: "event";
  toolUseId?: string;
  agentId?: string;
  seq?: number;
}

export interface AggregateEvidenceRef {
  kind: "aggregate";
  phaseId?: string;
  segmentId?: string;
  agentId?: string;
  taskKey?: string;
}

export type EvidenceRef = EventEvidenceRef | AggregateEvidenceRef;

export function deriveDrilldown(evidence: readonly EvidenceRef[]): "available" | "aggregate-only" {
  return evidence.length > 0 && evidence.every((ref) => ref.kind === "aggregate")
    ? "aggregate-only"
    : "available";
}

export type Source = "observed" | "derived" | "fallback";
export type Certainty = "confirmed" | "candidate" | "unknown";

export interface Derivation {
  source: Source;
  certainty: Certainty;
  note?: string;
}

export type Coverage = "complete" | "partial" | "unavailable";

export interface SemanticCoverage {
  base: WorkCoverage;
  timing: Coverage;
  dependency: Coverage;
  artifact: Coverage;
  identity: Coverage;
  detail: Coverage;
}

export interface ResourceFootprint {
  readSet: string[];
  writeSet: string[];
  execSet: string[];
  unknownEffects: boolean;
  coverage: Coverage;
}

export interface SemanticNodeBase {
  nodeId: string;
  kind: SemanticNodeKind;
  parentId?: string;
  title: string;
  evidence: EvidenceRef[];
  derivation: Derivation;
  drilldown: "available" | "aggregate-only";
}

export interface GoalNode extends SemanticNodeBase {
  kind: "goal";
}

export interface StageNode extends SemanticNodeBase {
  kind: "stage";
  stageState: "undetermined";
}

export interface TaskIdentity {
  semanticTaskId: string;
  taskKeys: string[];
  stability: IdentityStability;
  identityCoverage: Coverage;
}

export interface TaskExecutionSummary {
  attemptCount: number;
  failCount: number;
  tokens?: number;
  approvalPending: boolean;
  footprint?: ResourceFootprint;
}

export interface TaskExecutionWindow {
  startedAt: number;
  endedAt?: number;
  durationUnionMs: number;
  coverage: Coverage;
}

export interface TaskDefinitionNode extends SemanticNodeBase {
  kind: "task";
  identity: TaskIdentity;
  definitionState: "recorded" | "undetermined";
  definitionStatus: "planned" | "active" | "completed" | "cancelled" | "unknown";
  executionSummary?: TaskExecutionSummary;
  executionWindow?: TaskExecutionWindow;
}

export interface ExecutionAttemptNode extends SemanticNodeBase {
  kind: "attempt";
  agentTypeRole?: AttemptRole;
  observedRole?: AttemptRole;
  reconciledRole: {
    value?: AttemptRole;
    state: "consistent" | "conflict" | "declared_only" | "observed_only" | "unknown";
  };
  ownerState: "structural" | "active-task" | "undetermined";
  ordinalWithinTask?: number;
  actor?: {
    agentId?: string;
    agentType?: string;
    model?: string;
    effort?: string;
    measured: boolean;
  };
  anchors: {
    segmentIds: string[];
    agentIds: string[];
  };
  startedAt: number;
  endedAt?: number;
  elapsedMs: number;
  status: {
    scope: "work";
    value: WorkStatus;
  };
  result?: {
    failCount: number;
    childFailCount: number;
    tokens?: number;
  };
  artifacts: HostArtifactAccess[];
  footprint: ResourceFootprint;
}

export interface AgentRunNode extends SemanticNodeBase {
  kind: "agentRun";
  agentId: string;
  spawnDepth: number;
  parentAgentRunId?: string;
  elapsedMs: number;
  status: {
    scope: "work";
    value: WorkStatus;
  };
}

export type SemanticNode = GoalNode | StageNode | TaskDefinitionNode | ExecutionAttemptNode | AgentRunNode;

export type SemanticEdgeKind =
  | "contains"
  | "executes"
  | "observed_before"
  | "overlaps"
  | "observed_data_dep"
  | "resource_conflict"
  | "reviews";

export interface SemanticEdge {
  edgeId: string;
  from: string;
  to: string;
  kind: SemanticEdgeKind;
  derivation: Derivation;
  assertion: "observed" | "inferred";
  evidence: EvidenceRef[];
}

export interface TaskReopenedEvent {
  taskKey: string;
  at: number;
  from: TaskStatus;
  to: TaskStatus;
  cause: "user-change" | "unknown";
  evidence: EvidenceRef[];
}

export interface ReworkCandidate {
  taskKey: string;
  at: number;
  reason: string;
  evidence: EvidenceRef[];
}

export interface SemanticModel {
  version: number;
  mode: SemanticMode;
  revision: number;
  evidenceHash: string;
  semanticHash: string;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  coverage: SemanticCoverage;
  degraded: boolean;
  conflictCount: number;
  delegationMismatchCount: number;
  taskReopened: TaskReopenedEvent[];
  reworkCandidates: ReworkCandidate[];
  assignments: Assignment[];
  attemptProgressStates?: Record<string, string>;
  progress?: ProgressL3Input;
  timeBuckets?: TimeBucketView;
  firstPromptText?: string;
  execLogMarks?: ExecLogMark[];
  execLogFindings?: ExecLogFindingView[];
  execLogFindingsEmptyLabel?: string;
}

export interface ProgressL3Input {
  transitions: readonly ProgressTransitionRecord[];
  assignmentTaskIdByRef: Record<string, string>;
  assignmentAttemptNodeIdByRef: Record<string, string>;
  assignmentRoleByRef: Record<string, string>;
  writesByTaskId: Record<string, { canonicalPath: string; artifactId: string; at: number; ownerAgentId?: string }[]>;
  verificationsByTaskId: Record<string, number[]>;
  baseDir?: string;
  longGaps: readonly { at: number; durationMs: number }[];
}

function determineSemanticMode(state: WorkModelState, evidence: SemanticEvidenceIndex): SemanticMode {
  const hasRecorded =
    evidence.todoTransitions.length > 0 ||
    evidence.transitionSummaries.length > 0 ||
    state.tasks.length > 0;
  if (hasRecorded) return "recorded";

  return "fallback";
}

function deriveGoalNode(
  mode: SemanticMode,
  evidence: SemanticEvidenceIndex,
  conversationId?: string
): GoalNode {
  return {
    nodeId: `goal:${conversationId ?? "session"}`,
    kind: "goal",
    title: evidence.firstHumanMessageLine ?? "",
    evidence: [],
    derivation: {
      source: mode === "fallback" ? "fallback" : "derived",
      certainty: "confirmed",
    },
    drilldown: "available",
  };
}

function deriveStageNodes(goalNodeId: string): StageNode[] {
  return [
    {
      nodeId: "stage:unsegmented",
      kind: "stage",
      parentId: goalNodeId,
      title: "unsegmented",
      stageState: "undetermined",
      evidence: [],
      derivation: { source: "fallback", certainty: "confirmed" },
      drilldown: "available",
    },
  ];
}

function convertEvidenceRefs(refs: EvidenceIndexRef[]): EvidenceRef[] {
  return refs.map((ref) => ({
    kind: "event" as const,
    toolUseId: ref.toolUseId,
    agentId: ref.agentId,
    seq: ref.seq,
  }));
}

function normalizeStability(stability: EvidenceIdentityStability): IdentityStability {
  if (stability === "stable" || stability === "content-derived") {
    return stability;
  }
  return "unknown";
}

function extractTodoContent(taskKey: string): string | undefined {
  if (!taskKey.startsWith("todo:")) return undefined;
  const raw = taskKey.slice("todo:".length);
  const lastSpace = raw.lastIndexOf(" ");
  if (lastSpace > 0) {
    const suffix = raw.slice(lastSpace + 1);
    if (/^\d+$/.test(suffix)) {
      return raw.slice(0, lastSpace);
    }
  }
  return raw;
}

function deriveTaskDefinitions(
  defaultStageNodeId: string,
  state: WorkModelState,
  evidence: SemanticEvidenceIndex,
  mode: SemanticMode
): TaskDefinitionNode[] {
  if (mode === "fallback") {
    return [];
  }

  const tasks: TaskDefinitionNode[] = [];
  const coveredTaskKeys = new Set<string>();

  for (const binding of evidence.bindings) {
    for (const k of binding.taskKeys) {
      coveredTaskKeys.add(k);
    }

    const todoKeysCount = binding.taskKeys.filter((k) => k.startsWith("todo:")).length;
    const identityCoverage: Coverage = todoKeysCount >= 2 ? "partial" : "complete";

    const stability = normalizeStability(binding.stability);

    const identity: TaskIdentity = {
      semanticTaskId: binding.semanticTaskId,
      taskKeys: [...binding.taskKeys],
      stability,
      identityCoverage,
    };

    const matchingSummaries = evidence.transitionSummaries
      .filter((s) => binding.taskKeys.includes(s.taskKey))
      .sort((a, b) => (b.lastTransition?.at ?? 0) - (a.lastTransition?.at ?? 0));
    const summary = matchingSummaries[0];
    const stateTask = state.tasks.find((t) => binding.taskKeys.includes(t.taskKey));

    let definitionStatus: TaskDefinitionNode["definitionStatus"] = "unknown";
    const lastTo = summary?.lastTransition?.to;

    if (lastTo === "in_progress" || lastTo === "pending") {
      definitionStatus = "active";
    } else if (lastTo === "completed") {
      definitionStatus = "completed";
    } else if (lastTo === "unknown") {
      const hasMissingTaskKey = binding.taskKeys.some(
        (k) => k.startsWith("task:") && !state.tasks.some((st) => st.taskKey === k)
      );
      definitionStatus = hasMissingTaskKey ? "cancelled" : "unknown";
    } else if (stateTask) {
      if (stateTask.status === "in_progress" || stateTask.status === "pending") {
        definitionStatus = "active";
      } else if (stateTask.status === "completed") {
        definitionStatus = "completed";
      } else {
        definitionStatus = "unknown";
      }
    }

    let title = "";
    if (stateTask?.description) {
      title = stateTask.description;
    } else {
      const todoKey = binding.taskKeys.find((k) => k.startsWith("todo:"));
      if (todoKey) {
        title = extractTodoContent(todoKey) ?? todoKey;
      } else {
        title = binding.semanticTaskId;
      }
    }

    tasks.push({
      nodeId: `task:${binding.semanticTaskId}`,
      kind: "task",
      parentId: defaultStageNodeId,
      title,
      identity,
      definitionState: "recorded",
      definitionStatus,
      evidence: convertEvidenceRefs(binding.evidence),
      derivation: {
        source: "observed",
        certainty: "confirmed",
      },
      drilldown: "available",
    });
  }

  const additionalKeys = new Set<string>();
  for (const st of state.tasks) {
    if (!coveredTaskKeys.has(st.taskKey)) {
      additionalKeys.add(st.taskKey);
    }
  }
  for (const ts of evidence.transitionSummaries) {
    if (!coveredTaskKeys.has(ts.taskKey)) {
      additionalKeys.add(ts.taskKey);
    }
  }

  for (const key of additionalKeys) {
    coveredTaskKeys.add(key);

    const isTodo = key.startsWith("todo:");
    const isTask = key.startsWith("task:");
    const stability: IdentityStability = isTodo ? "content-derived" : (isTask ? "stable" : "unknown");
    const semanticTaskId = isTask || isTodo ? key : `task:${key}`;

    const identity: TaskIdentity = {
      semanticTaskId,
      taskKeys: [key],
      stability,
      identityCoverage: "complete",
    };

    const summary = evidence.transitionSummaries.find((s) => s.taskKey === key);
    const stateTask = state.tasks.find((t) => t.taskKey === key);

    let definitionStatus: TaskDefinitionNode["definitionStatus"] = "unknown";
    const lastTo = summary?.lastTransition?.to;

    if (lastTo === "in_progress" || lastTo === "pending") {
      definitionStatus = "active";
    } else if (lastTo === "completed") {
      definitionStatus = "completed";
    } else if (lastTo === "unknown") {
      const isMissingTaskKey = isTask && !state.tasks.some((st) => st.taskKey === key);
      definitionStatus = isMissingTaskKey ? "cancelled" : "unknown";
    } else if (stateTask) {
      if (stateTask.status === "in_progress" || stateTask.status === "pending") {
        definitionStatus = "active";
      } else if (stateTask.status === "completed") {
        definitionStatus = "completed";
      } else {
        definitionStatus = "unknown";
      }
    }

    let title = "";
    if (stateTask?.description) {
      title = stateTask.description;
    } else if (isTodo) {
      title = extractTodoContent(key) ?? key;
    } else {
      title = semanticTaskId;
    }

    const evidenceRefs: EvidenceRef[] = [];
    if (summary?.lastTransition?.evidence) {
      evidenceRefs.push({
        kind: "event",
        toolUseId: summary.lastTransition.evidence.toolUseId,
        agentId: summary.lastTransition.evidence.agentId,
        seq: summary.lastTransition.evidence.seq,
      });
    }

    tasks.push({
      nodeId: `task:${semanticTaskId}`,
      kind: "task",
      parentId: defaultStageNodeId,
      title,
      identity,
      definitionState: "recorded",
      definitionStatus,
      evidence: evidenceRefs,
      derivation: {
        source: "observed",
        certainty: "confirmed",
      },
      drilldown: "available",
    });
  }

  return tasks;
}

export function calculateIntervalUnion(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  const valid = intervals
    .filter(([s, e]) => !isNaN(s) && !isNaN(e))
    .map(([s, e]) => [s, Math.max(s, e)] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  if (valid.length === 0) return 0;

  let totalMs = 0;
  let currentStart = valid[0][0];
  let currentEnd = valid[0][1];

  for (let i = 1; i < valid.length; i++) {
    const [s, e] = valid[i];
    if (s <= currentEnd) {
      currentEnd = Math.max(currentEnd, e);
    } else {
      totalMs += currentEnd - currentStart;
      currentStart = s;
      currentEnd = e;
    }
  }
  totalMs += currentEnd - currentStart;
  return totalMs;
}

function collectAllAgents(state: WorkModelState): WorkAgent[] {
  const agentMap = new Map<string, WorkAgent>();
  for (const phase of state.phases) {
    for (const agent of phase.agents) {
      if (!agentMap.has(agent.agentId)) {
        agentMap.set(agent.agentId, agent);
      }
    }
  }
  return Array.from(agentMap.values());
}

function collectDescendantAgentIds(
  rootToolUseId: string,
  rootAgentId: string,
  delegations: readonly DelegationRecord[]
): string[] {
  const result = new Set<string>([rootAgentId]);
  const byParent = new Map<string, DelegationRecord[]>();
  for (const d of delegations) {
    if (d.parentToolUseId !== null) {
      const l = byParent.get(d.parentToolUseId) ?? [];
      l.push(d);
      byParent.set(d.parentToolUseId, l);
    }
  }
  const stack = [rootToolUseId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of byParent.get(cur) ?? []) {
      if (!result.has(child.agentId)) {
        result.add(child.agentId);
        stack.push(child.toolUseId);
      }
    }
  }
  return Array.from(result);
}

function deduplicateArtifacts(records: ArtifactAccessRecord[]): HostArtifactAccess[] {
  const artifactMap = new Map<string, HostArtifactAccess>();
  for (const record of records) {
    const existing = artifactMap.get(record.artifactId);
    if (!existing) {
      artifactMap.set(record.artifactId, {
        artifactId: record.artifactId,
        canonicalPath: record.canonicalPath,
        mode: record.mode,
      });
    } else {
      if (record.mode === "write") {
        existing.mode = "write";
      } else if (record.mode === "exec" && existing.mode === "read") {
        existing.mode = "exec";
      }
    }
  }
  return Array.from(artifactMap.values());
}

function deriveFootprintFromArtifacts(
  artifacts: ReadonlyArray<Pick<HostArtifactAccess, "artifactId" | "mode">>,
  hasUnknownEffects: boolean,
  baseCoverage?: Coverage
): ResourceFootprint {
  const readSet = Array.from(
    new Set(artifacts.filter((a) => a.mode === "read").map((a) => a.artifactId))
  ).sort();
  const writeSet = Array.from(
    new Set(artifacts.filter((a) => a.mode === "write").map((a) => a.artifactId))
  ).sort();
  const execSet = Array.from(
    new Set(artifacts.filter((a) => a.mode === "exec").map((a) => a.artifactId))
  ).sort();

  let coverage: Coverage;
  if (baseCoverage) {
    coverage = baseCoverage;
  } else if (hasUnknownEffects && artifacts.length === 0) {
    coverage = "unavailable";
  } else if (hasUnknownEffects) {
    coverage = "partial";
  } else {
    coverage = "complete";
  }

  return {
    readSet,
    writeSet,
    execSet,
    unknownEffects: hasUnknownEffects,
    coverage,
  };
}

function determineObservedRole(
  artifacts: HostArtifactAccess[],
  taskWriteSet: Set<string>,
  allPhasesVerify: boolean
): AttemptRole {
  const hasWrite = artifacts.some((a) => a.mode === "write");
  if (hasWrite) {
    return "implement";
  }
  if (allPhasesVerify) {
    return "verify";
  }
  const hasRead = artifacts.some((a) => a.mode === "read");
  const intersectsTaskWrite = artifacts.some(
    (a) => a.mode === "read" && taskWriteSet.has(a.artifactId)
  );
  if (hasRead && intersectsTaskWrite) {
    return "review";
  }
  return "unknown";
}

function agentTypeRoleOf(agentType: string | undefined): AttemptRole | undefined {
  if (!agentType) return undefined;
  const t = agentType.toLowerCase();
  if (t === "review" || t.startsWith("reviewer-")) return "review";
  if (t === "implement" || t === "research" || t === "fix" || t === "verify") return t;
  return undefined;
}

function reconcileRole(
  agentTypeRole?: AttemptRole,
  observedRole?: AttemptRole
): {
  value?: AttemptRole;
  state: "consistent" | "conflict" | "declared_only" | "observed_only" | "unknown";
} {
  const hasObserved = observedRole !== undefined && observedRole !== "unknown";
  const hasAgentTypeRole = agentTypeRole !== undefined;

  if (hasAgentTypeRole && hasObserved) {
    if (agentTypeRole === observedRole) {
      return { state: "consistent", value: agentTypeRole };
    } else {
      return { state: "conflict", value: undefined };
    }
  }
  if (hasAgentTypeRole && !hasObserved) {
    return { state: "declared_only", value: agentTypeRole };
  }
  if (!hasAgentTypeRole && hasObserved) {
    return { state: "observed_only", value: observedRole };
  }
  return { state: "unknown", value: undefined };
}

export interface Assignment {
  assignmentId: string;
  agentRunId: string;
  taskNodeId: string;
  source: "delegation";
  startedAt: number;
  endedAt?: number;
  evidence: EvidenceRef[];
  derivation: Derivation;
}

function rootDelegationOf(
  toolUseId: string,
  delByToolUseId: Map<string, DelegationRecord>
): DelegationRecord | undefined {
  let cur = delByToolUseId.get(toolUseId);
  let hops = 0;
  while (cur !== undefined && cur.parentToolUseId !== null) {
    cur = delByToolUseId.get(cur.parentToolUseId);
    if (++hops > 16) return undefined;
  }
  return cur;
}

export function deriveAssignments(
  evidence: SemanticEvidenceIndex,
  tasks: TaskDefinitionNode[],
  defaultStageNodeId: string
): Assignment[] {
  const delByToolUseId = new Map(evidence.delegations.map((d) => [d.toolUseId, d]));
  const out: Assignment[] = [];
  for (const del of evidence.delegations) {
    const rootDel = rootDelegationOf(del.toolUseId, delByToolUseId);
    const taskNodeId =
      rootDel === undefined
        ? defaultStageNodeId
        : resolveAttemptOwnership(rootDel, tasks, `attempt:${rootDel.toolUseId}`).parentId;
    out.push({
      assignmentId: `assignment:${del.agentId}:${taskNodeId}:${del.startedAt}`,
      agentRunId: `agentRun:${del.agentId}`,
      taskNodeId,
      source: "delegation",
      startedAt: del.startedAt,
      endedAt: del.endedAt,
      evidence: [{ kind: "event", toolUseId: del.toolUseId, agentId: del.agentId }],
      derivation: { source: "observed", certainty: "confirmed" },
    });
  }
  out.sort((a, b) => (a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0));
  return out;
}

function resolveAttemptOwnership(
  del: DelegationRecord,
  tasks: TaskDefinitionNode[],
  defaultParentId: string
): { parentId: string; ownerState: "structural" | "active-task" | "undetermined" } {
  if (del.activeTaskKeyAtStart && !del.activeAmbiguousAtStart) {
    const task = tasks.find((t) => t.identity.taskKeys.includes(del.activeTaskKeyAtStart!));
    if (task) {
      return { parentId: task.nodeId, ownerState: "active-task" };
    }
  }

  return { parentId: defaultParentId, ownerState: "undetermined" };
}

function assignCanonicalOrder(attempts: ExecutionAttemptNode[]): void {
  const attemptsByParent = new Map<string, ExecutionAttemptNode[]>();
  for (const a of attempts) {
    if (a.parentId && a.parentId.startsWith("task:")) {
      const list = attemptsByParent.get(a.parentId) ?? [];
      list.push(a);
      attemptsByParent.set(a.parentId, list);
    }
  }

  for (const group of attemptsByParent.values()) {
    group.sort((a, b) => {
      if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
      const seqA = a.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.seq ?? Infinity;
      const seqB = b.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.seq ?? Infinity;
      if (seqA !== seqB) return seqA - seqB;

      const toolA = a.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.toolUseId ?? "";
      const toolB = b.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.toolUseId ?? "";
      if (toolA !== toolB) return toolA.localeCompare(toolB);

      return a.nodeId.localeCompare(b.nodeId);
    });

    const overlappingNodeIds = new Set<string>();
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      const aStart = a.startedAt;
      const aEnd = a.endedAt ?? Infinity;

      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        const bStart = b.startedAt;
        const bEnd = b.endedAt ?? Infinity;

        if (Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) {
          overlappingNodeIds.add(a.nodeId);
          overlappingNodeIds.add(b.nodeId);
        }
      }
    }

    let ordinal = 1;
    for (const a of group) {
      if (overlappingNodeIds.has(a.nodeId)) {
        a.ordinalWithinTask = undefined;
      } else {
        a.ordinalWithinTask = ordinal++;
      }
    }
  }
}

function populateTaskExecutionInfo(
  tasks: TaskDefinitionNode[],
  attempts: ExecutionAttemptNode[],
  state: WorkModelState
): void {
  for (const task of tasks) {
    const taskAttempts = attempts.filter((a) => a.parentId === task.nodeId);
    if (taskAttempts.length === 0) {
      task.executionSummary = undefined;
      task.executionWindow = undefined;
      continue;
    }

    const startedAt = Math.min(...taskAttempts.map((a) => a.startedAt));
    const allEnded = taskAttempts.every((a) => a.endedAt !== undefined);
    const endedAt = allEnded ? Math.max(...taskAttempts.map((a) => a.endedAt!)) : undefined;
    const intervals = taskAttempts.map(
      (a) => [a.startedAt, a.endedAt ?? a.startedAt] as [number, number]
    );
    const durationUnionMs = calculateIntervalUnion(intervals);

    task.executionWindow = {
      startedAt,
      endedAt,
      durationUnionMs,
      coverage: allEnded ? "complete" : "partial",
    };

    const attemptCount = taskAttempts.length;
    let failCount = 0;
    for (const a of taskAttempts) {
      failCount += a.result?.failCount ?? 0;
    }

    let tokens: number | undefined = undefined;
    let totalTokens = 0;
    let hasTokens = false;
    for (const a of taskAttempts) {
      if (a.result?.tokens !== undefined) {
        totalTokens += a.result.tokens;
        hasTokens = true;
      }
    }
    if (hasTokens) {
      tokens = totalTokens;
    }

    const taskPhaseIds = new Set<string>();
    for (const a of taskAttempts) {
      for (const segId of a.anchors.segmentIds) {
        const seg = state.segments.find((s) => s.segmentId === segId);
        if (seg?.phaseId) taskPhaseIds.add(seg.phaseId);
      }
    }
    const approvalPending = state.phases.some(
      (p) => taskPhaseIds.has(p.phaseId) && p.pendingApprovalCount > 0
    );

    const readSet = Array.from(
      new Set(taskAttempts.flatMap((a) => a.footprint.readSet))
    ).sort();
    const writeSet = Array.from(
      new Set(taskAttempts.flatMap((a) => a.footprint.writeSet))
    ).sort();
    const execSet = Array.from(
      new Set(taskAttempts.flatMap((a) => a.footprint.execSet))
    ).sort();
    const unknownEffects = taskAttempts.some((a) => a.footprint.unknownEffects);
    const coverage: Coverage = taskAttempts.some((a) => a.footprint.coverage === "unavailable")
      ? "unavailable"
      : taskAttempts.some((a) => a.footprint.coverage === "partial")
      ? "partial"
      : "complete";

    task.executionSummary = {
      attemptCount,
      failCount,
      tokens,
      approvalPending,
      footprint: {
        readSet,
        writeSet,
        execSet,
        unknownEffects,
        coverage,
      },
    };
  }
}

export function deriveAttempts(
  state: WorkModelState,
  evidence: SemanticEvidenceIndex,
  tasks: TaskDefinitionNode[],
  reopenTimes: Map<string, number[]> | undefined,
  defaultStageNodeId: string,
  openAsyncStatusOf: (transcriptAgentId: string) => WorkStatus
): ExecutionAttemptNode[] {
  const allAgents = collectAllAgents(state);
  const delegationToolUseIds = new Set(evidence.delegations.map((d) => d.toolUseId));

  const delegatedAttempts: ExecutionAttemptNode[] = [];
  const delegationSegmentIds = new Set<string>();

  for (const del of evidence.delegations) {
    if (del.parentToolUseId !== null) {
      continue;
    }
    const rootAgent = allAgents.find(
      (a) => a.toolUseId === del.toolUseId || a.agentId === del.agentId
    );
    const descendantAgentIds = collectDescendantAgentIds(
      del.toolUseId,
      del.agentId,
      evidence.delegations
    );

    const placement = findToolPlacement(state, del.toolUseId);
    const segmentIds: string[] = [];
    if (placement?.segmentId) {
      segmentIds.push(placement.segmentId);
      delegationSegmentIds.add(placement.segmentId);
    }

    const matchingArtifacts = evidence.artifactAccesses.filter(
      (acc) =>
        acc.toolUseId === del.toolUseId ||
        (acc.ownerAgentId && descendantAgentIds.includes(acc.ownerAgentId))
    );
    const artifacts = deduplicateArtifacts(matchingArtifacts);

    const hasUnknownEffects = evidence.effectGaps.some(
      (gap) =>
        gap.toolUseId === del.toolUseId ||
        (gap.ownerAgentId && descendantAgentIds.includes(gap.ownerAgentId))
    );
    const footprint = deriveFootprintFromArtifacts(matchingArtifacts, hasUnknownEffects);

    const { parentId, ownerState } = resolveAttemptOwnership(del, tasks, defaultStageNodeId);
    const agentTypeRole = agentTypeRoleOf(del.agentType);

    const intervals: [number, number][] = [[del.startedAt, del.endedAt ?? del.startedAt]];
    for (const agId of descendantAgentIds) {
      const ag = allAgents.find((a) => a.agentId === agId);
      if (ag) {
        intervals.push([ag.startedAt, ag.endedAt ?? ag.startedAt]);
      }
    }
    const elapsedMs = calculateIntervalUnion(intervals);

    let totalTokens = 0;
    let hasTokens = false;
    for (const agId of descendantAgentIds) {
      const ag = allAgents.find((a) => a.agentId === agId);
      if (ag?.tokens !== undefined) {
        totalTokens += ag.tokens;
        hasTokens = true;
      }
    }

    const failCount = rootAgent?.failCount ?? 0;
    let childFailCount = 0;
    const rootAgentId = rootAgent?.agentId ?? del.agentId;
    for (const agId of descendantAgentIds) {
      if (agId === rootAgentId) continue;
      const ag = allAgents.find((a) => a.agentId === agId);
      if (ag) {
        childFailCount += ag.failCount;
      }
    }

    let statusValue: WorkStatus = "unknown";
    if (del.endedAt === undefined && (del.transcriptAgentId !== undefined || del.isBackground === true)) {
      statusValue =
        del.transcriptAgentId !== undefined ? openAsyncStatusOf(del.transcriptAgentId) : "stale";
    } else if (rootAgent?.status) {
      statusValue = rootAgent.status;
    } else if (del.endedAt !== undefined) {
      statusValue = "completed";
    } else {
      statusValue = "running";
    }

    const actor = {
      agentId: del.agentId,
      agentType: del.agentType,
      model: rootAgent?.modelMeasured ?? rootAgent?.modelDeclared,
      effort: rootAgent?.effortMeasured ?? rootAgent?.effortDeclared,
      measured: rootAgent?.modelMeasured !== undefined || rootAgent?.effortMeasured !== undefined,
    };

    delegatedAttempts.push({
      nodeId: `attempt:${del.toolUseId}`,
      kind: "attempt",
      parentId,
      title: del.description ?? del.agentType ?? del.agentId,
      evidence: [
        {
          kind: "event",
          toolUseId: del.toolUseId,
          agentId: del.agentId,
          seq: del.evidence.seq,
        },
      ],
      derivation: {
        source: "observed",
        certainty: "confirmed",
      },
      drilldown: "available",
      agentTypeRole,
      reconciledRole: { state: "unknown" },
      ownerState,
      actor,
      anchors: {
        segmentIds,
        agentIds: descendantAgentIds,
      },
      startedAt: del.startedAt,
      endedAt: del.endedAt,
      elapsedMs,
      status: {
        scope: "work",
        value: statusValue,
      },
      result: {
        failCount,
        childFailCount,
        tokens: hasTokens ? totalTokens : undefined,
      },
      artifacts,
      footprint,
    });
  }

  const nonDelegatedSegments = state.segments.filter((s) => {
    if (delegationSegmentIds.has(s.segmentId) && s.toolCount <= 1) {
      return false;
    }
    return true;
  });

  const ambiguityEvents = [...evidence.todoTransitions].sort((a, b) => a.at - b.at);
  const ambiguousAt = (ts: number): boolean => {
    const st = new Map<string, string>();
    for (const t of ambiguityEvents) {
      if (t.at > ts) break;
      st.set(t.taskKey, t.to);
    }
    let inProgress = 0;
    for (const v of st.values()) if (v === "in_progress") inProgress++;
    return inProgress >= 2;
  };

  const nonDelegatedGroups: WorkSegment[][] = [];
  let currentGroup: WorkSegment[] = [];
  let currentTaskKey: string | undefined = undefined;
  let currentTaskId: string | undefined = undefined;

  const effectiveKeyOf = (seg: WorkSegment): string | undefined =>
    seg.taskKey && !ambiguousAt(seg.startedAt) ? seg.taskKey : undefined;

  for (const seg of nonDelegatedSegments) {
    const taskKey = effectiveKeyOf(seg);
    const task = taskKey
      ? tasks.find((t) => t.identity.taskKeys.includes(taskKey))
      : undefined;
    const taskId = task?.nodeId;

    const isReopenedBreak =
      reopenTimes &&
      taskKey &&
      currentGroup.length > 0 &&
      (reopenTimes.get(taskKey) ?? []).some(
        (t) => t > currentGroup[currentGroup.length - 1].startedAt && t <= seg.startedAt
      );

    const isTaskChanged =
      currentGroup.length > 0 &&
      (taskId !== undefined || currentTaskId !== undefined
        ? taskId !== currentTaskId
        : taskKey !== currentTaskKey);

    if (isTaskChanged || isReopenedBreak) {
      nonDelegatedGroups.push(currentGroup);
      currentGroup = [seg];
      currentTaskKey = taskKey;
      currentTaskId = taskId;
    } else {
      if (currentGroup.length === 0) {
        currentTaskKey = taskKey;
        currentTaskId = taskId;
      }
      currentGroup.push(seg);
    }
  }
  if (currentGroup.length > 0) {
    nonDelegatedGroups.push(currentGroup);
  }

  const nonDelegatedAttempts: ExecutionAttemptNode[] = [];
  for (const group of nonDelegatedGroups) {
    const firstSeg = group[0];
    const segmentIds = group.map((s) => s.segmentId);
    const taskKey = effectiveKeyOf(firstSeg);
    const task = taskKey
      ? tasks.find((t) => t.identity.taskKeys.includes(taskKey))
      : undefined;

    const ownerState = task ? ("structural" as const) : ("undetermined" as const);
    const parentId = task ? task.nodeId : defaultStageNodeId;

    const groupIntervals = group.map(
      (s) => [s.startedAt, s.endedAt ?? s.startedAt] as [number, number]
    );
    const elapsedMs = calculateIntervalUnion(groupIntervals);
    const startedAt = Math.min(...group.map((s) => s.startedAt));
    const allEnded = group.every((s) => s.endedAt !== undefined);
    const endedAt = allEnded ? Math.max(...group.map((s) => s.endedAt!)) : undefined;

    let statusValue: WorkStatus = "unknown";
    if (group.some((s) => s.runningCount > 0)) {
      statusValue = "running";
    } else if (group.some((s) => s.failCount > 0 || s.childFailCount > 0)) {
      statusValue = "failed";
    } else if (group.some((s) => s.staleCount > 0)) {
      statusValue = "stale";
    } else if (allEnded) {
      statusValue = "completed";
    } else {
      statusValue = "running";
    }

    const segFailCount = group.reduce((sum, s) => sum + s.failCount, 0);

    const groupEnd = endedAt ?? Infinity;
    const inWindow = (at: number) => at >= startedAt && (endedAt === undefined ? true : at < groupEnd);
    const matchingArtifacts = evidence.artifactAccesses.filter(
      (acc) =>
        acc.ownerAgentId === undefined &&
        inWindow(acc.at) &&
        !(acc.toolUseId && delegationToolUseIds.has(acc.toolUseId))
    );
    const artifacts = deduplicateArtifacts(matchingArtifacts);

    const hasUnknownEffects = evidence.effectGaps.some(
      (gap) =>
        gap.ownerAgentId === undefined &&
        inWindow(gap.at) &&
        !(gap.toolUseId && delegationToolUseIds.has(gap.toolUseId))
    );
    const footprint = deriveFootprintFromArtifacts(matchingArtifacts, hasUnknownEffects);

    const evidenceRefs: EvidenceRef[] = group.map((s) => ({
      kind: "aggregate",
      segmentId: s.segmentId,
      taskKey: s.taskKey,
    }));

    nonDelegatedAttempts.push({
      nodeId: `attempt:${firstSeg.segmentId}`,
      kind: "attempt",
      parentId,
      title: task?.title ?? firstSeg.segmentId,
      evidence: evidenceRefs,
      derivation: {
        source: "observed",
        certainty: "confirmed",
      },
      drilldown: "available",
      ownerState,
      anchors: {
        segmentIds,
        agentIds: [],
      },
      startedAt,
      endedAt,
      elapsedMs,
      status: {
        scope: "work",
        value: statusValue,
      },
      result: {
        failCount: segFailCount,
        childFailCount: group.reduce((s, x) => s + x.childFailCount, 0),
      },
      artifacts,
      footprint,
      reconciledRole: { state: "unknown" },
    });
  }

  const allAttempts = [...delegatedAttempts, ...nonDelegatedAttempts];

  const taskWriteSets = new Map<string, Set<string>>();
  for (const a of allAttempts) {
    if (a.parentId && a.parentId.startsWith("task:")) {
      const set = taskWriteSets.get(a.parentId) ?? new Set<string>();
      for (const w of a.footprint.writeSet) {
        set.add(w);
      }
      taskWriteSets.set(a.parentId, set);
    }
  }

  for (const a of allAttempts) {
    const taskWriteSet =
      a.parentId && taskWriteSets.has(a.parentId)
        ? taskWriteSets.get(a.parentId)!
        : new Set<string>();

    const attemptPhases = new Set<string>();
    for (const segId of a.anchors.segmentIds) {
      const seg = state.segments.find((s) => s.segmentId === segId);
      if (seg?.phaseId) attemptPhases.add(seg.phaseId);
    }
    const allPhasesVerify =
      attemptPhases.size > 0 &&
      [...attemptPhases].every(
        (pid) => state.phases.find((p) => p.phaseId === pid)?.operation === "verify"
      );

    const observedRole = determineObservedRole(a.artifacts, taskWriteSet, allPhasesVerify);
    a.observedRole = observedRole;
    a.reconciledRole = reconcileRole(a.agentTypeRole, observedRole);
  }

  assignCanonicalOrder(allAttempts);

  populateTaskExecutionInfo(tasks, allAttempts, state);

  return allAttempts;
}

export function deriveAgentRuns(
  state: WorkModelState,
  evidence: SemanticEvidenceIndex,
  openAsyncStatusOf: (transcriptAgentId: string) => WorkStatus
): AgentRunNode[] {
  const allAgents = collectAllAgents(state);
  const agentByToolUseId = new Map(allAgents.map((a) => [a.toolUseId, a]));
  const delByToolUseId = new Map(evidence.delegations.map((d) => [d.toolUseId, d]));
  const runs: AgentRunNode[] = [];

  const depthOf = (toolUseId: string): number => {
    let depth = 1;
    let cur = delByToolUseId.get(toolUseId);
    while (cur && cur.parentToolUseId !== null && delByToolUseId.has(cur.parentToolUseId)) {
      depth++;
      cur = delByToolUseId.get(cur.parentToolUseId);
      if (depth > 16) break;
    }
    return depth;
  };
  const rootOf = (toolUseId: string): string => {
    let cur = delByToolUseId.get(toolUseId);
    let root = toolUseId;
    let hops = 0;
    while (cur && cur.parentToolUseId !== null && delByToolUseId.has(cur.parentToolUseId)) {
      root = cur.parentToolUseId;
      cur = delByToolUseId.get(cur.parentToolUseId);
      if (++hops > 16) break;
    }
    return root;
  };

  for (const del of evidence.delegations) {
    const agent = agentByToolUseId.get(del.toolUseId);
    const parentAgentRunId =
      del.parentToolUseId !== null && delByToolUseId.has(del.parentToolUseId)
        ? `agentRun:agent:${del.parentToolUseId}`
        : undefined;
    const root = rootOf(del.toolUseId);
    const rootDel = delByToolUseId.get(root);
    const parentId =
      rootDel !== undefined && rootDel.parentToolUseId === null ? `attempt:${root}` : undefined;

    runs.push({
      nodeId: `agentRun:${del.agentId}`,
      kind: "agentRun",
      parentId,
      parentAgentRunId,
      agentId: del.agentId,
      spawnDepth: depthOf(del.toolUseId),
      title: agent?.description || del.agentType || del.agentId,
      elapsedMs:
        agent?.elapsedMs ??
        (del.endedAt !== undefined ? Math.max(0, del.endedAt - del.startedAt) : 0),
      status: {
        scope: "work",
        value:
          del.endedAt === undefined && (del.transcriptAgentId !== undefined || del.isBackground === true)
            ? del.transcriptAgentId !== undefined
              ? openAsyncStatusOf(del.transcriptAgentId)
              : "stale"
            : agent?.status ?? (del.endedAt !== undefined ? "completed" : "unknown"),
      },
      evidence: [
        {
          kind: "event",
          toolUseId: del.toolUseId,
          agentId: del.agentId,
        },
      ],
      derivation: {
        source: "observed",
        certainty: "confirmed",
      },
      drilldown: "available",
    });
  }

  return runs;
}

function isHumanMessageBetweenLastTransitionAndReopen(
  reopenAt: number,
  humanMessageTimes: number[],
  allTransitions: TodoTransition[]
): boolean {
  const priorHumanTimes = humanMessageTimes.filter((t) => t < reopenAt);
  if (priorHumanTimes.length === 0) return false;
  const lastHumanTime = Math.max(...priorHumanTimes);

  const priorTransitions = allTransitions.filter((t) => t.at < reopenAt);
  if (priorTransitions.length === 0) {
    return true;
  }
  const lastTransitionTime = Math.max(...priorTransitions.map((t) => t.at));

  return lastHumanTime > lastTransitionTime;
}

function findTaskForTaskKey(
  taskKey: string,
  tasks: TaskDefinitionNode[],
  evidence: SemanticEvidenceIndex
): TaskDefinitionNode | undefined {
  let task = tasks.find((t) => t.identity.taskKeys.includes(taskKey));
  if (task) return task;

  task = tasks.find((t) => t.identity.semanticTaskId === taskKey);
  if (task) return task;

  const binding = evidence.bindings.find(
    (b) => b.taskKeys.includes(taskKey) || b.semanticTaskId === taskKey
  );
  if (binding) {
    task = tasks.find((t) => t.identity.semanticTaskId === binding.semanticTaskId);
    if (task) return task;
  }

  return undefined;
}

function determineReopenCause(
  reopen: { taskKey: string; at: number },
  evidence: SemanticEvidenceIndex
): "user-change" | "unknown" {
  if (
    isHumanMessageBetweenLastTransitionAndReopen(
      reopen.at,
      evidence.humanMessageTimes,
      evidence.todoTransitions
    )
  ) {
    return "user-change";
  }

  return "unknown";
}

function deriveTaskReopened(evidence: SemanticEvidenceIndex): TaskReopenedEvent[] {
  const events: TaskReopenedEvent[] = [];

  for (const trans of evidence.todoTransitions) {
    if (trans.from === "completed" && (trans.to === "in_progress" || trans.to === "pending")) {
      const cause = determineReopenCause({ taskKey: trans.taskKey, at: trans.at }, evidence);
      const evidenceRefs: EvidenceRef[] = [];
      if (trans.evidence) {
        evidenceRefs.push({
          kind: "event",
          toolUseId: trans.evidence.toolUseId,
          agentId: trans.evidence.agentId,
          seq: trans.evidence.seq,
        });
      }
      events.push({
        taskKey: trans.taskKey,
        at: trans.at,
        from: trans.from,
        to: trans.to,
        cause,
        evidence: evidenceRefs,
      });
    }
  }

  return events;
}

function deriveReviewsEdges(
  taskNodes: TaskDefinitionNode[],
  attemptNodes: ExecutionAttemptNode[],
  evidence: SemanticEvidenceIndex
): SemanticEdge[] {
  const edgeMap = new Map<string, SemanticEdge>();

  {
    const taskTransitions = evidence.todoTransitions.filter((t) => t.taskKey.startsWith("task:"));
    const todoTransitions = evidence.todoTransitions.filter((t) => t.taskKey.startsWith("todo:"));
    const timeline = taskTransitions.length > 0 ? taskTransitions : todoTransitions;
    const activeAt = (ts: number): string[] => {
      const st = new Map<string, TaskStatus>();
      for (const t of timeline) if (t.at <= ts) st.set(t.taskKey, t.to);
      return Array.from(st.entries()).filter(([, v]) => v === "in_progress").map(([k]) => k);
    };

    interface ActorAcc {
      actorId: string | undefined;
      reads: ArtifactAccessRecord[];
      writes: ArtifactAccessRecord[];
      readIds: Set<string>;
      execCount: number;
    }
    const actorMap = new Map<string, ActorAcc>();
    const actorKey = (owner: string | undefined) => owner ?? "__parent__";
    const getActor = (owner: string | undefined): ActorAcc => {
      const k = actorKey(owner);
      let a = actorMap.get(k);
      if (!a) {
        a = { actorId: owner, reads: [], writes: [], readIds: new Set(), execCount: 0 };
        actorMap.set(k, a);
      }
      return a;
    };
    for (const acc of evidence.artifactAccesses) {
      const a = getActor(acc.ownerAgentId);
      if (acc.mode === "read") {
        a.reads.push(acc);
        a.readIds.add(acc.artifactId);
      } else if (acc.mode === "write") {
        a.writes.push(acc);
      }
    }
    for (const gap of evidence.effectGaps) {
      getActor(gap.ownerAgentId).execCount++;
    }

    const actors = Array.from(actorMap.values());
    for (const r of actors) {
      if (r.writes.length > 0 || r.reads.length === 0) continue;
      if (r.actorId === undefined) continue;
      const attemptNode = attemptNodes.find(
        (a) => a.nodeId === `attempt:${r.actorId!.replace(/^agent:/, "")}`
      );
      if (!attemptNode) continue;

      const allIntersecting: Array<{ we: ArtifactAccessRecord }> = [];
      for (const w of actors) {
        if (w === r) continue;
        for (const we of w.writes) {
          if (r.readIds.has(we.artifactId)) allIntersecting.push({ we });
        }
      }
      if (allIntersecting.length === 0) continue;

      const intersecting = allIntersecting.filter(({ we }) =>
        r.reads.some((re) => re.artifactId === we.artifactId && we.at < re.at)
      );
      if (intersecting.length === 0) continue;
      if (r.execCount > 0) continue;

      const targets = new Map<string, ArtifactAccessRecord[]>();
      for (const { we } of intersecting) {
        const act = activeAt(we.at);
        if (act.length === 1) {
          const list = targets.get(act[0]) ?? [];
          list.push(we);
          targets.set(act[0], list);
        }
      }
      for (const [taskKey, evs] of targets) {
        const targetTask = findTaskForTaskKey(taskKey, taskNodes, evidence);
        if (!targetTask) continue;
        const edgeId = `reviews:${attemptNode.nodeId}:${targetTask.nodeId}`;
        if (edgeMap.has(edgeId)) continue;
        edgeMap.set(edgeId, {
          edgeId,
          from: attemptNode.nodeId,
          to: targetTask.nodeId,
          kind: "reviews",
          assertion: "inferred",
          derivation: { source: "derived", certainty: "candidate" },
          evidence: evs.slice(0, 3).map((e) => ({
            kind: "event" as const,
            toolUseId: e.toolUseId,
            agentId: e.ownerAgentId,
          })),
        });
      }
    }
  }

  return Array.from(edgeMap.values());
}

function deriveReworkCandidates(
  taskNodes: TaskDefinitionNode[],
  attemptNodes: ExecutionAttemptNode[],
  reviewsEdges: SemanticEdge[]
): ReworkCandidate[] {
  const out: ReworkCandidate[] = [];
  for (const task of taskNodes) {
    const attempts = attemptNodes
      .filter((a) => a.parentId === task.nodeId)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < attempts.length; i++) {
      out.push({
        taskKey: task.identity.taskKeys[0] ?? task.identity.semanticTaskId,
        at: attempts[i].startedAt,
        reason: "attempt-increase",
        evidence: attempts[i].evidence,
      });
    }
    const incomingReviews = reviewsEdges.filter((e) => e.to === task.nodeId);
    for (const rev of incomingReviews) {
      const reviewer = attemptNodes.find((a) => a.nodeId === rev.from);
      if (!reviewer) continue;
      for (const a of attempts) {
        if (a.footprint.writeSet.length > 0 && a.startedAt > reviewer.startedAt) {
          out.push({
            taskKey: task.identity.taskKeys[0] ?? task.identity.semanticTaskId,
            at: a.startedAt,
            reason: "write-after-review",
            evidence: a.evidence,
          });
          break;
        }
      }
    }
  }
  return out;
}

interface EdgeDerivationResult {
  edges: SemanticEdge[];
  hasEdgeLimitExceeded: boolean;
}

function buildAttemptAccessMap(
  attempts: ExecutionAttemptNode[],
  evidence: SemanticEvidenceIndex
): Map<string, ArtifactAccessRecord[]> {
  const delMap = new Map(evidence.delegations.map((d) => [d.toolUseId, d]));
  const map = new Map<string, ArtifactAccessRecord[]>();

  for (const a of attempts) {
    if (a.nodeId.startsWith("attempt:")) {
      const toolUseId = a.nodeId.slice("attempt:".length);
      const del = delMap.get(toolUseId);
      if (del) {
        const descendantAgentIds = collectDescendantAgentIds(
          del.toolUseId,
          del.agentId,
          evidence.delegations
        );
        const matching = evidence.artifactAccesses.filter(
          (acc) =>
            acc.toolUseId === del.toolUseId ||
            (acc.ownerAgentId !== undefined && descendantAgentIds.includes(acc.ownerAgentId))
        );
        map.set(a.nodeId, matching);
        continue;
      }
    }

    if (a.anchors.segmentIds.length > 0) {
      const matching = evidence.artifactAccesses.filter(
        (acc) =>
          acc.ownerAgentId === undefined &&
          acc.at >= a.startedAt &&
          (a.endedAt === undefined ? true : acc.at < a.endedAt) &&
          !(acc.toolUseId && delMap.has(acc.toolUseId))
      );
      map.set(a.nodeId, matching);
      continue;
    }

    map.set(a.nodeId, []);
  }

  return map;
}

const MAX_EDGES_PER_KIND = 2000;

function deriveEdges(
  nodes: SemanticNode[],
  evidence: SemanticEvidenceIndex,
  reviewsEdges: SemanticEdge[]
): EdgeDerivationResult {
  const taskNodes = nodes.filter((n): n is TaskDefinitionNode => n.kind === "task");
  const attemptNodes = nodes.filter((n): n is ExecutionAttemptNode => n.kind === "attempt");

  const edgeMap = new Map<string, SemanticEdge>();
  const kindCounts = new Map<SemanticEdgeKind, number>();
  let hasEdgeLimitExceeded = false;

  function addEdge(edge: SemanticEdge): boolean {
    if (edgeMap.has(edge.edgeId)) return false;
    const count = kindCounts.get(edge.kind) ?? 0;
    if (count >= MAX_EDGES_PER_KIND) {
      hasEdgeLimitExceeded = true;
      return false;
    }
    kindCounts.set(edge.kind, count + 1);
    edgeMap.set(edge.edgeId, edge);
    return true;
  }

  for (const edge of reviewsEdges) {
    addEdge(edge);
  }

  const attemptsByTask = new Map<string, ExecutionAttemptNode[]>();
  for (const a of attemptNodes) {
    if (a.parentId && a.parentId.startsWith("task:")) {
      const list = attemptsByTask.get(a.parentId) ?? [];
      list.push(a);
      attemptsByTask.set(a.parentId, list);
    }
  }

  for (const group of attemptsByTask.values()) {
    group.sort((a, b) => {
      if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
      const seqA = a.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.seq ?? Infinity;
      const seqB = b.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.seq ?? Infinity;
      if (seqA !== seqB) return seqA - seqB;
      const toolA = a.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.toolUseId ?? "";
      const toolB = b.evidence.find((e): e is EventEvidenceRef => e.kind === "event")?.toolUseId ?? "";
      if (toolA !== toolB) return toolA.localeCompare(toolB);
      return a.nodeId.localeCompare(b.nodeId);
    });

    for (let i = 0; i < group.length - 1; i++) {
      const a = group[i];
      const b = group[i + 1];
      const aStart = a.startedAt;
      const aEnd = a.endedAt ?? a.startedAt;
      const bStart = b.startedAt;
      const isOverlapping = Math.max(aStart, bStart) < Math.min(a.endedAt ?? Infinity, b.endedAt ?? Infinity);
      if (!isOverlapping && aEnd <= bStart) {
        addEdge({
          edgeId: `observed_before:${a.nodeId}:${b.nodeId}`,
          from: a.nodeId,
          to: b.nodeId,
          kind: "observed_before",
          assertion: "observed",
          derivation: { source: "observed", certainty: "confirmed" },
          evidence: b.evidence,
        });
      }
    }
  }

  const tasksByStage = new Map<string, TaskDefinitionNode[]>();
  for (const t of taskNodes) {
    if (t.parentId && t.executionWindow) {
      const list = tasksByStage.get(t.parentId) ?? [];
      list.push(t);
      tasksByStage.set(t.parentId, list);
    }
  }

  for (const group of tasksByStage.values()) {
    group.sort((a, b) => {
      if (a.executionWindow!.startedAt !== b.executionWindow!.startedAt) {
        return a.executionWindow!.startedAt - b.executionWindow!.startedAt;
      }
      return a.nodeId.localeCompare(b.nodeId);
    });

    for (let i = 0; i < group.length - 1; i++) {
      const a = group[i];
      const b = group[i + 1];
      const aStart = a.executionWindow!.startedAt;
      const aEnd = a.executionWindow!.endedAt;
      const bStart = b.executionWindow!.startedAt;
      const bEnd = b.executionWindow!.endedAt;
      const isOverlapping = Math.max(aStart, bStart) < Math.min(aEnd ?? Infinity, bEnd ?? Infinity);
      if (!isOverlapping && aEnd !== undefined && aEnd <= bStart) {
        addEdge({
          edgeId: `observed_before:${a.nodeId}:${b.nodeId}`,
          from: a.nodeId,
          to: b.nodeId,
          kind: "observed_before",
          assertion: "observed",
          derivation: { source: "observed", certainty: "confirmed" },
          evidence: b.evidence,
        });
      }
    }
  }

  for (let i = 0; i < attemptNodes.length; i++) {
    const a = attemptNodes[i];
    const aStart = a.startedAt;
    const aEnd = a.endedAt ?? Infinity;
    for (let j = i + 1; j < attemptNodes.length; j++) {
      const b = attemptNodes[j];
      const bStart = b.startedAt;
      const bEnd = b.endedAt ?? Infinity;
      if (Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) {
        const from = a.nodeId < b.nodeId ? a.nodeId : b.nodeId;
        const to = a.nodeId < b.nodeId ? b.nodeId : a.nodeId;
        addEdge({
          edgeId: `overlaps:${from}:${to}`,
          from,
          to,
          kind: "overlaps",
          assertion: "observed",
          derivation: { source: "observed", certainty: "confirmed" },
          evidence: [...a.evidence, ...b.evidence],
        });
      }
    }
  }

  const tasksWithWindow = taskNodes.filter((t) => t.executionWindow !== undefined);
  for (let i = 0; i < tasksWithWindow.length; i++) {
    const a = tasksWithWindow[i];
    const aStart = a.executionWindow!.startedAt;
    const aEnd = a.executionWindow!.endedAt ?? Infinity;
    for (let j = i + 1; j < tasksWithWindow.length; j++) {
      const b = tasksWithWindow[j];
      const bStart = b.executionWindow!.startedAt;
      const bEnd = b.executionWindow!.endedAt ?? Infinity;
      if (Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) {
        const from = a.nodeId < b.nodeId ? a.nodeId : b.nodeId;
        const to = a.nodeId < b.nodeId ? b.nodeId : a.nodeId;
        addEdge({
          edgeId: `overlaps:${from}:${to}`,
          from,
          to,
          kind: "overlaps",
          assertion: "observed",
          derivation: { source: "observed", certainty: "confirmed" },
          evidence: [...a.evidence, ...b.evidence],
        });
      }
    }
  }

  const attemptAccessMap = buildAttemptAccessMap(attemptNodes, evidence);

  for (let i = 0; i < attemptNodes.length; i++) {
    const a = attemptNodes[i];
    if (a.footprint.unknownEffects) continue;

    const aWrites = (attemptAccessMap.get(a.nodeId) ?? []).filter((acc) => acc.mode === "write");
    if (aWrites.length === 0) continue;

    for (let j = 0; j < attemptNodes.length; j++) {
      if (i === j) continue;
      const b = attemptNodes[j];
      if (b.footprint.unknownEffects) continue;

      const bReads = (attemptAccessMap.get(b.nodeId) ?? []).filter((acc) => acc.mode === "read");
      if (bReads.length === 0) continue;

      const commonIds = a.footprint.writeSet.filter((id) => b.footprint.readSet.includes(id));
      if (commonIds.length === 0) continue;

      let hasPrecedingWrite = false;
      const evRefs: EvidenceRef[] = [];
      for (const cid of commonIds) {
        const writesForId = aWrites.filter((w) => w.artifactId === cid);
        const readsForId = bReads.filter((r) => r.artifactId === cid);
        for (const w of writesForId) {
          for (const r of readsForId) {
            if (w.at < r.at) {
              hasPrecedingWrite = true;
              if (w.toolUseId && evRefs.length < 5) {
                evRefs.push({ kind: "event", toolUseId: w.toolUseId, agentId: w.ownerAgentId });
              }
              if (r.toolUseId && evRefs.length < 5) {
                evRefs.push({ kind: "event", toolUseId: r.toolUseId, agentId: r.ownerAgentId });
              }
            }
          }
        }
      }

      if (hasPrecedingWrite) {
        addEdge({
          edgeId: `observed_data_dep:${a.nodeId}:${b.nodeId}`,
          from: a.nodeId,
          to: b.nodeId,
          kind: "observed_data_dep",
          assertion: "observed",
          derivation: { source: "observed", certainty: "confirmed" },
          evidence: evRefs.length > 0 ? evRefs : b.evidence,
        });
      }
    }
  }

  for (let i = 0; i < attemptNodes.length; i++) {
    const a = attemptNodes[i];
    if (a.footprint.unknownEffects) continue;

    const aWrites = a.footprint.writeSet;
    const aReadsExecs = [...a.footprint.readSet, ...a.footprint.execSet];

    for (let j = i + 1; j < attemptNodes.length; j++) {
      const b = attemptNodes[j];
      if (b.footprint.unknownEffects) continue;

      const bWrites = b.footprint.writeSet;
      const bReadsExecs = [...b.footprint.readSet, ...b.footprint.execSet];

      const hasWriteWrite = aWrites.some((w) => bWrites.includes(w));
      const hasAWriteBReadExec = aWrites.some((w) => bReadsExecs.includes(w));
      const hasBWriteAReadExec = bWrites.some((w) => aReadsExecs.includes(w));

      if (hasWriteWrite || hasAWriteBReadExec || hasBWriteAReadExec) {
        const from = a.nodeId < b.nodeId ? a.nodeId : b.nodeId;
        const to = a.nodeId < b.nodeId ? b.nodeId : a.nodeId;
        addEdge({
          edgeId: `resource_conflict:${from}:${to}`,
          from,
          to,
          kind: "resource_conflict",
          assertion: "observed",
          derivation: { source: "observed", certainty: "confirmed" },
          evidence: [...a.evidence, ...b.evidence],
        });
      }
    }
  }

  return {
    edges: Array.from(edgeMap.values()),
    hasEdgeLimitExceeded,
  };
}

export function deriveSemanticModel(
  state: WorkModelState,
  evidence: SemanticEvidenceIndex,
  options?: {
    conversationId?: string;
    streamOpen?: boolean;
    liveDelegationAgentIds?: ReadonlySet<string>;
    baseDir?: string;
    childSpans?: readonly ChildTranscriptSpan[];
  }
): SemanticModel {
  const liveIds = options?.liveDelegationAgentIds;
  const openAsyncStatusOf = (transcriptAgentId: string): WorkStatus =>
    options?.streamOpen === true && (liveIds === undefined || liveIds.has(transcriptAgentId))
      ? "running"
      : "stale";
  const mode = determineSemanticMode(state, evidence);
  const goalNode = deriveGoalNode(mode, evidence, options?.conversationId);
  const stageNodes = deriveStageNodes(goalNode.nodeId);
  const defaultStageNodeId = stageNodes[0].nodeId;
  const taskNodes = deriveTaskDefinitions(defaultStageNodeId, state, evidence, mode);

  const reopenTimes = new Map<string, number[]>();
  for (const t of evidence.todoTransitions) {
    if (t.from === "completed" && (t.to === "in_progress" || t.to === "pending")) {
      const list = reopenTimes.get(t.taskKey) ?? [];
      list.push(t.at);
      reopenTimes.set(t.taskKey, list);
    }
  }

  const attemptNodes = deriveAttempts(state, evidence, taskNodes, reopenTimes, defaultStageNodeId, openAsyncStatusOf);
  const agentRunNodes = deriveAgentRuns(state, evidence, openAsyncStatusOf);

  const nodes: SemanticNode[] = [goalNode, ...stageNodes, ...taskNodes, ...attemptNodes, ...agentRunNodes].map(
    (n) => {
      const drilldown = deriveDrilldown(n.evidence);
      return n.drilldown === drilldown ? n : { ...n, drilldown };
    }
  );

  const reviewsEdges = deriveReviewsEdges(taskNodes, attemptNodes, evidence);
  const taskReopened = deriveTaskReopened(evidence);
  const edgeResult = deriveEdges(nodes, evidence, reviewsEdges);
  const edges = edgeResult.edges;

  const reworkCandidates = deriveReworkCandidates(
    taskNodes,
    attemptNodes,
    edges.filter((e) => e.kind === "reviews")
  );

  const degraded =
    mode === "fallback" ||
    state.coverage.summary === "prefix-truncated" ||
    state.coverage.details === "prefix-truncated";

  const timingCoverage: Coverage =
    state.coverage.summary === "prefix-truncated" || state.coverage.details === "prefix-truncated"
      ? "partial"
      : "complete";

  let artifactCoverage: Coverage;
  if (attemptNodes.length === 0) {
    artifactCoverage = "unavailable";
  } else if (attemptNodes.every((a) => a.footprint.coverage === "complete")) {
    artifactCoverage = "complete";
  } else if (attemptNodes.every((a) => a.footprint.coverage === "unavailable")) {
    artifactCoverage = "unavailable";
  } else {
    artifactCoverage = "partial";
  }

  const dependencyCoverage: Coverage = "unavailable";

  const hasPartialIdentity = taskNodes.some(
    (t) => t.identity.identityCoverage === "partial" || t.identity.stability === "content-derived"
  );
  const identityCoverage: Coverage =
    taskNodes.length === 0 ? "unavailable" : hasPartialIdentity ? "partial" : "complete";

  const detailCoverage: Coverage = edgeResult.hasEdgeLimitExceeded ? "partial" : "complete";

  const coverage: SemanticCoverage = {
    base: state.coverage,
    timing: timingCoverage,
    dependency: dependencyCoverage,
    artifact: artifactCoverage,
    identity: identityCoverage,
    detail: detailCoverage,
  };

  const conflictCount = attemptNodes.filter((a) => a.reconciledRole.state === "conflict").length;

  const observedAgentIds = new Set(collectAllAgents(state).map((a) => a.agentId));
  const delAgentIds = new Set(evidence.delegations.map((d) => d.agentId));
  let delegationMismatchCount = 0;
  for (const d of evidence.delegations) {
    if (!observedAgentIds.has(d.agentId)) delegationMismatchCount++;
  }
  for (const agentId of observedAgentIds) {
    if (!delAgentIds.has(agentId)) delegationMismatchCount++;
  }

  const semanticHash = createHash("sha256")
    .update(
      `v1|${semanticRevision(state)}|${evidence.hash}|hm:${evidence.humanMessageTimes.join(",")}` +
        `|fh:${JSON.stringify(evidence.firstHumanMessageLine ?? "")}|cid:${JSON.stringify(options?.conversationId ?? "")}` +
        `|lg:${evidence.longGaps.map((g) => `${g.at}+${g.durationMs}`).join(",")}` +
        `|lgd:${evidence.coverage.longGaps}/${evidence.droppedLongGapMs}` +
        `|pp:${evidence.progressTransitions
          .map((p) => `${p.resolvedAssignmentRef ?? ""}:${p.state}@${p.at}:${p.ownershipVerified ? 1 : 0}`)
          .join(",")}|ppi:${evidence.invalidProgressCount}`
    )
    .digest("hex");

  const assignments = deriveAssignments(evidence, taskNodes, defaultStageNodeId);
  const progress = buildProgressL3Input(evidence, assignments, options?.baseDir);
  const assignmentProgressStates = deriveAssignmentProgressStates(evidence);
  const attemptProgressStates: Record<string, string> = {};
  for (const d of evidence.delegations) {
    const attemptNodeId = `attempt:${d.toolUseId}`;
    const st = assignmentProgressStates[progressSubjectKey(attemptNodeId)];
    if (st !== undefined) attemptProgressStates[attemptNodeId] = st;
  }

  const model: SemanticModel = {
    version: SEMANTIC_MODEL_SPEC_VERSION,
    mode,
    revision: state.revision,
    evidenceHash: evidence.hash,
    semanticHash,
    nodes,
    edges,
    coverage,
    degraded,
    conflictCount,
    delegationMismatchCount,
    taskReopened,
    reworkCandidates,
    assignments,
    ...(progress !== undefined ? { progress } : {}),
    ...(Object.keys(attemptProgressStates).length > 0 ? { attemptProgressStates } : {}),
    timeBuckets: deriveTimeBuckets(evidence.timeBuckets, {
      childSpans: options?.childSpans ?? [],
      ...(options?.streamOpen !== undefined ? { streamOpen: options.streamOpen } : {}),
      ...(options?.liveDelegationAgentIds !== undefined
        ? { liveDelegationAgentIds: options.liveDelegationAgentIds }
        : {}),
    }),
    ...(evidence.firstHumanMessageText !== undefined ? { firstPromptText: evidence.firstHumanMessageText } : {}),
    execLogMarks: evidence.execLogMarks.marks,
    execLogFindings: deriveExecLogFindings(evidence.execLogMarks.marks),
    execLogFindingsEmptyLabel: execLogFindingsEmptyLabel(),
  };
  return model;
}

function buildProgressL3Input(
  evidence: SemanticEvidenceIndex,
  assignments: readonly Assignment[],
  baseDir: string | undefined
): ProgressL3Input | undefined {
  const assignmentTaskIdByRef: Record<string, string> = {};
  const assignmentAttemptNodeIdByRef: Record<string, string> = {};
  const assignmentRoleByRef: Record<string, string> = {};
  const agentToTaskId = new Map<string, string>();
  const delByToolUseId = new Map(evidence.delegations.map((d) => [d.toolUseId, d]));
  const assignmentByKey = new Map(assignments.map((a) => [`${a.agentRunId}@${a.startedAt}`, a]));
  for (const d of evidence.delegations) {
    const assignment = assignmentByKey.get(`agentRun:${d.agentId}@${d.startedAt}`);
    if (assignment === undefined) continue;
    const ref = assignmentRefOf(d);
    const taskId = assignment.taskNodeId;
    assignmentTaskIdByRef[ref] = taskId;
    const rootDel = rootDelegationOf(d.toolUseId, delByToolUseId);
    if (rootDel !== undefined) assignmentAttemptNodeIdByRef[ref] = `attempt:${rootDel.toolUseId}`;
    const role = agentTypeRoleOf(d.agentType);
    if (role !== undefined) assignmentRoleByRef[ref] = role;
    agentToTaskId.set(d.agentId, taskId);
  }

  const writesByTaskId: Record<string, { canonicalPath: string; artifactId: string; at: number; ownerAgentId?: string }[]> = {};
  for (const a of evidence.artifactAccesses) {
    if (a.mode !== "write") continue;
    const taskId = a.ownerAgentId !== undefined ? agentToTaskId.get(a.ownerAgentId) : undefined;
    if (taskId === undefined) continue;
    (writesByTaskId[taskId] ??= []).push({
      canonicalPath: a.canonicalPath,
      artifactId: a.artifactId,
      at: a.at,
      ...(a.ownerAgentId !== undefined ? { ownerAgentId: a.ownerAgentId } : {}),
    });
  }

  const verificationsByTaskId: Record<string, number[]> = {};
  const pushVerification = (taskId: string | undefined, at: number) => {
    if (taskId === undefined) return;
    (verificationsByTaskId[taskId] ??= []).push(at);
  };
  for (const a of evidence.artifactAccesses) {
    if (a.mode !== "read") continue;
    pushVerification(a.ownerAgentId !== undefined ? agentToTaskId.get(a.ownerAgentId) : undefined, a.at);
  }
  for (const g of evidence.effectGaps) {
    pushVerification(g.ownerAgentId !== undefined ? agentToTaskId.get(g.ownerAgentId) : undefined, g.at);
  }

  return {
    transitions: evidence.progressTransitions,
    assignmentTaskIdByRef,
    assignmentAttemptNodeIdByRef,
    assignmentRoleByRef,
    writesByTaskId,
    verificationsByTaskId,
    ...(baseDir !== undefined ? { baseDir } : {}),
    longGaps: evidence.longGaps,
  };
}
