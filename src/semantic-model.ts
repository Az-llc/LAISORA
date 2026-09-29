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
import { findToolPlacement, type WorkAgent, type WorkSegment } from "./work-model";
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

// R1
export interface GoalNode extends SemanticNodeBase {
  kind: "goal";
}

// R2
export interface StageNode extends SemanticNodeBase {
  kind: "stage";
  stageState: "undetermined";
}

// R3
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

// R4
export interface ExecutionAttemptNode extends SemanticNodeBase {
  kind: "attempt";
  // subagentType ヒューリスティック（R4.3）のみ。宣言入力ではない
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
  // nodes / edges と独立。Attempt の identity・基数・parentId には影響しない
  assignments: Assignment[];
  // Attempt nodeId → pp1 state（Assignment 単位集約を Host 側で適用した結果）。
  // webview は再集計せずこの値を表示する。done は投影されない
  attemptProgressStates?: Record<string, string>;
  // pp1 の L3 入力。deriveDivergences は SemanticModel のみを
  // 受け取るため、progress と scope 照合の基準ディレクトリはここで供給する。
  // progress は Host-only（webview へは projectSemanticModel が落とす）
  progress?: ProgressL3Input;
  // 経過時間の 4 区分・依頼ブロック・サブエージェント区間（R-DSP-15/16/17/20/21）。
  // semanticHash 非入力。省略可能（undefined = 未着）
  timeBuckets?: TimeBucketView;
  // 「1 つ目のプロンプト」の本文（R-DSP-02）。Goal title（1 行目 200 字）とは別に全文を運ぶ
  firstPromptText?: string;
  // 実行ログの印と、その飛び先になる所見の見出し（R-TAB-06）。semanticHash 非入力。省略可能（undefined = 未着）
  execLogMarks?: ExecLogMark[];
  execLogFindings?: ExecLogFindingView[];
  execLogFindingsEmptyLabel?: string;
}

// baseDir / writes[].canonicalPath は Host-only（流出防止）
export interface ProgressL3Input {
  transitions: readonly ProgressTransitionRecord[];
  // 鍵はいずれも assignmentRefOf(delegation)。値は Assignment（taskNodeId）と
  // その委任の root Attempt nodeId（入れ子委任は Attempt を持たないため root へ束ねる）。
  // root 委任が保持上限で淘汰された委任は Attempt を持たないため attemptNodeId 側に鍵が無い
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

// R1
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

// Stage は常に unsegmented
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

// R3
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

  // 1. evidence.bindings 由来
  for (const binding of evidence.bindings) {
    for (const k of binding.taskKeys) {
      coveredTaskKeys.add(k);
    }

    // partial は content-derived キーを
    // **跨いで**統合した場合のみ（連続性の主張が heuristic になるため）
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

  // 2. binding に無い記帳キー（state.tasks / transitionSummaries）由来
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

// union 規則の単一実装。l3-analysis.ts もこれを使う（再実装すると
// 「重なった区間を二重に数えない」規則が2箇所へ分岐する）
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

// 子孫収集の正本は delegations の parentToolUseId 連鎖。reducer の parentAgentId 連鎖は
// background 入れ子で切れる（deriveAgentRuns の上のコメントと同じ理由）
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

// 入力は dedupe 前の生レコードを渡す。dedupe は read→write へ mode を潰すため、
// dedupe 後から作ると read+write 両方した artifact が readSet から消え
// observed_data_dep が壊滅する
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
  // classifyOperation が verify のみ（phase 分類経由の近似 — r1 M13）
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

// R4.3: AttemptRole 値との完全一致 + reviewer- 前置一致のみ。語彙表の拡張は
// 仕様外（目的推定の禁止と同根 — r1 M19 で縮小）
function agentTypeRoleOf(agentType: string | undefined): AttemptRole | undefined {
  if (!agentType) return undefined;
  const t = agentType.toLowerCase();
  if (t === "review" || t.startsWith("reviewer-")) return "review";
  if (t === "implement" || t === "research" || t === "fix" || t === "verify") return t;
  return undefined;
}

// "declared_only" は agentTypeRole のみ観測できた状態（宣言入力ではない。protocol.ts の
// SEMANTIC_RECONCILE_STATES と名前を揃えている）
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

// Assignment / AgentSpan — AgentRun と TaskDefinition の「時間付き帰属」。
// nodes / edges とは独立した兄弟コレクションで、Attempt の identity・基数・parentId を一切変えない
// （Attempt を Assignment のために再parent・分割しない）。
//
// 委任 1 件 = Assignment 1 件。taskNodeId は root Attempt の帰属先
// （active-task なら owner Task、undetermined なら Attempt 自身）。agentId 一致・6C 推定・
// reopen は禁止（reopen は { at } しか持たず Task を運ばない）。
//
// 1 AgentRun に対し配列で複数区間を持てる形にしてある。現 corpus には mid-execution の
// 追加 Task 帰属 carrier が 0 件のため単一区間しか生成されないが、それは corpus の性質であって
// 仕様ではない（単一区間を前提にした最適化・型の単数化をしないこと）。
export interface Assignment {
  // 決定論的 id。配列添字を参照先にしないため（採番・順序に依存させない）
  assignmentId: string;
  agentRunId: string;
  taskNodeId: string;
  source: "delegation";
  startedAt: number;
  endedAt?: number;
  evidence: EvidenceRef[];
  derivation: Derivation;
}

// 入れ子委任は Attempt を持たない（P1-D）ので root の委任（parentToolUseId === null）へ束ねる。
// root が保持上限（MAX_DELEGATIONS）で淘汰され辿れないときは undefined: その委任に対応する
// Attempt ノードは存在しないので、呼び手は `attempt:<toolUseId>` を鍵にしてはならない
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
    // 帰属規則は resolveAttemptOwnership と同一実装（第 2 実装を作らない）。
    // root が淘汰済みなら undetermined として stage 直下（存在しない nodeId を鍵にしない）
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
  // 順序を id で確定させる（導出順・配列位置を意味に持ち込まない）
  out.sort((a, b) => (a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0));
  return out;
}

// active-task → undetermined の 2 段。
// parentToolUseId → placement → segment.taskKey の規則は持たない: Attempt 化される委任は親発行のみで
// parentToolUseId が常に null のため到達不能
function resolveAttemptOwnership(
  del: DelegationRecord,
  tasks: TaskDefinitionNode[],
  defaultParentId: string
): { parentId: string; ownerState: "structural" | "active-task" | "undetermined" } {
  // 1. activeTaskKeyAtStart（activeAmbiguousAtStart=true なら不使用）
  if (del.activeTaskKeyAtStart && !del.activeAmbiguousAtStart) {
    const task = tasks.find((t) => t.identity.taskKeys.includes(del.activeTaskKeyAtStart!));
    if (task) {
      return { parentId: task.nodeId, ownerState: "active-task" };
    }
  }

  // 2. 不可
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
    // 1. 全順序ソート: startedAt → seq → 最小 toolUseId → nodeId
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

    // 2. 時間区間が重なる対を検出
    const overlappingNodeIds = new Set<string>();
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      const aStart = a.startedAt;
      const aEnd = a.endedAt ?? Infinity;

      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        const bStart = b.startedAt;
        const bEnd = b.endedAt ?? Infinity;

        // 重なり判定: max(aStart, bStart) < min(aEnd, bEnd)
        if (Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) {
          overlappingNodeIds.add(a.nodeId);
          overlappingNodeIds.add(b.nodeId);
        }
      }
    }

    // 3. ordinalWithinTask の付与 (重なるものは undefined)
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

    // approval は Task 単位（WorkPhaseState の伝播先）。グローバル判定にすると
    // 無関係な Task に承認待ちが灯る（r1 M6）
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

// R4
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

  // 1. 委任 Attempt (DelegationRecord ごと)
  const delegatedAttempts: ExecutionAttemptNode[] = [];
  const delegationSegmentIds = new Set<string>();

  for (const del of evidence.delegations) {
    // P1-D: Attempt=コンダクターの1 dispatch。入れ子委任は AgentRun 側の勘定であり
    // Attempt ノードを作らない（凍結期待値: 親dispatch 2 : AgentRun 10）
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
      // 裁定H-1: async ACK後〜完了通知前の窓（reopen 中を含む）。reducer は dispatch の
      // tool_result で completed を確定済みのため、rootAgent.status より先に判定しないと
      // completed 表示に化ける。running/completed への推定は禁止で、値は呼び出し側が観測した
      // 「ストリーム継続中か」と「この委任を live で観測したか」だけで決まる（openAsyncStatusOf）
      // transcript 未観測の background 宣言委任は live 観測が成立し得ないため定数 stale
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

  // 2. 非委任 Attempt (同一 TaskDefinition に帰属する連続 segment 群を1 Attempt に束ねる)
  const nonDelegatedSegments = state.segments.filter((s) => {
    if (delegationSegmentIds.has(s.segmentId) && s.toolCount <= 1) {
      return false;
    }
    return true;
  });

  // E4（R4.2）の非委任側適用: ambiguity="multiple-active-tasks" の
  // 区間で開かれた segment の taskKey は帰属に使わない（r1 M2）。
  // 判定は todoTransitions から segment 開始時点の in_progress 件数を再構成する
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

    // 切断は別 TaskDefinition への移動のみ（R4.1 規則3a）。両側とも Task 未解決の
    // ときだけ taskKey 変化で切る（同一 TaskDefinition 内の別 taskKey で切ると Q2 が水増し — r1 M3）
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

    // R4.2 の ownerState は帰属解決手段の確度。非委任の segment.taskKey 帰属は
    // 構造ヒューリスティックなので最良でも structural
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

    // toolPlacements はツール終了時に消えるため、完全履歴の導出時点では常に空で、placement 経由の帰属は成立しない。
    // 親（ownerAgentId 無し）のアクセスを群の時刻窓で帰属させる。
    // 窓は半開区間 [start, end)（両端閉だと隣接群の境界一致で1アクセスが
    // 二重帰属し、偽の rc/dd が合成される — r3 M-R3-1）。
    // 委任 dispatch 自体に載るアクセスは委任 Attempt が toolUseId で claim する
    // ため窓側から除外（二重帰属防止 — r3 M-R3-2）
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

  // 3. Task ごとの writeSet を集計し、observedRole & reconciledRole を確定
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

  // 4. Canonical Order 付与
  assignCanonicalOrder(allAttempts);

  // 5. TaskDefinitionNode の executionSummary & executionWindow 充足
  populateTaskExecutionInfo(tasks, allAttempts, state);

  return allAttempts;
}

// 階層の正本は evidence.delegations の parentToolUseId 連鎖。
// L2a（state.agents）の spawnDepth を使わない理由: background 委任は tool_result が
// 即時返るため placement が子 spawn より先に消え、reducer の親子連鎖が background
// 入れ子で機能しない（reducer 側では全件 depth 1 になる）
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
    // root が保持上限淘汰で delegations から消えている場合、その Attempt は存在しない
    // ため parentId を張らない（dangling 防止 — r2 M-R5）
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

// cause "review" を返さない: reviews 辺は candidate のみで、candidate を確定値の根拠にしない
function determineReopenCause(
  reopen: { taskKey: string; at: number },
  evidence: SemanticEvidenceIndex
): "user-change" | "unknown" {
  // user-change: 再開の直前に人間発言がある
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
    // R6a: completed → 非終端 (in_progress / pending) への明示遷移のみ
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

  // reviews 辺は candidate / inferred のみ。L2 グラフ表示と L3 の件数（attemptPairReviewsRelated）にだけ使い、判定入力にしない。
  // 1. 親（コンダクター自筆）Attempt はレビュー主体から除外する
  // 2. exec ゲートは effectGaps 件数で近似する（mcp__/未知ツール・path 欠落も含む広い述語）
  // 3. 交差判定は norm 済みイベントに限定せず全 artifactAccesses を使う
  // 4. depth>=2 の subagent reviewer は Attempt を持たないので発火しない
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
      actorId: string | undefined; // undefined = 親
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
      if (r.actorId === undefined) continue; // 親 reviewer は from ノード非一意のため対象外
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
      if (r.execCount > 0) continue; // blocked: 自身の exec

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

// R6a-2: 間接シグナルは candidate 別格保持・taskReopened へ昇格させない
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
      // deriveAttempts の非委任経路と同じ帰属規則（半開区間・dispatch claim 除外）
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

// contains/executes は保存しない（parentId が正本）。
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

  // 1. R5 reviews 辺
  for (const edge of reviewsEdges) {
    addEdge(edge);
  }

  // 2. R7 observed_before
  // (a) 同一 TaskDefinition 配下の Attempt 間 (canonical order 隣接・非重複)
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

  // (b) TaskDefinition 間 (同一 Stage 配下の executionWindow 隣接・非重複)
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

  // 4. R7 overlaps
  // (a) Attempt 間 (実区間重なり)
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

  // (b) TaskDefinition 間 (executionWindow 実区間重なり)
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

  // 5. R7 observed_data_dep (Attempt A.writeSet ∩ B.readSet ≠ ∅ かつ A の write が B の read より先行。unknownEffects=true の対には張らない)
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

  // 6. R7 resource_conflict (writeSet∩writeSet ≠ ∅ または writeSet∩(readSet∪execSet) ≠ ∅。同一 Attempt 内は除外。unknownEffects=true の対には張らない)
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
    // scope 照合の基準ディレクトリ（Host-only）
    baseDir?: string;
    // R-DSP-49: childSpans; src/time-buckets.ts#deriveTimeBuckets
    childSpans?: readonly ChildTranscriptSpan[];
  }
): SemanticModel {
  // 裁定H-1: 起動ACK後〜完了通知前の async 委任の status。streamOpen はイベントストリームが
  // 導出時点で継続中という取得経路非依存の観測事実（live/history の分岐ではない）。
  // 継続中なら running、終端済み（既定）なら実行継続を証明できないため stale（既存の
  // undetermined 語彙。completed にも running にも推定しない）。
  // liveDelegationAgentIds（MED-1）: 指定時は、継続中ストリームで実際に ACK/再開を観測した
  // transcriptAgentId だけが running。resume 復元・旧プロセス由来の未終端委任は、ストリームが
  // 開いていても実行継続を証明できないため stale。省略時は従来どおり streamOpen のみで決まる
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

  // R6a の再開時刻マップ（deriveAttempts の Attempt 分割に渡す）
  const reopenTimes = new Map<string, number[]>();
  for (const t of evidence.todoTransitions) {
    if (t.from === "completed" && (t.to === "in_progress" || t.to === "pending")) {
      const list = reopenTimes.get(t.taskKey) ?? [];
      list.push(t.at);
      reopenTimes.set(t.taskKey, list);
    }
  }

  // R4〜R7
  const attemptNodes = deriveAttempts(state, evidence, taskNodes, reopenTimes, defaultStageNodeId, openAsyncStatusOf);
  const agentRunNodes = deriveAgentRuns(state, evidence, openAsyncStatusOf);

  // 不変条件:「drilldown="aggregate-only" は evidence が aggregate だけの状態と一致する」。
  // 各生成箇所で literal を書くと10箇所が独立に腐るため、最終ノード集合に対して一度だけ導出する。
  // evidence は空でもよい。空のときの drilldown は available（drilldown は二値）。
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

  // R8
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

  // 依存の宣言入力は無い。観測辺（observed_data_dep 等）は依存の完全集合ではないため
  // complete / partial を主張しない
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

  // 構造判定（L2a の WorkAgent 観測）と delegation フィールド判定
  // （evidence.delegations）の食い違いを数える。両辺を同一ソースから作ると恒真になる
  const observedAgentIds = new Set(collectAllAgents(state).map((a) => a.agentId));
  const delAgentIds = new Set(evidence.delegations.map((d) => d.agentId));
  let delegationMismatchCount = 0;
  for (const d of evidence.delegations) {
    if (!observedAgentIds.has(d.agentId)) delegationMismatchCount++;
  }
  for (const agentId of observedAgentIds) {
    if (!delAgentIds.has(agentId)) delegationMismatchCount++;
  }

  // evidence.hash 射影外だがモデル出力に影響する入力
  // （humanMessageTimes=cause / firstHumanMessageLine=Goal title / conversationId=Goal nodeId /
  // longGaps=longGapMs・longGapCount）は semanticHash 側の入力列に含める
  // fh はユーザー文なので JSON 化で区切り文字インジェクションを封じる（r3 L-R3-1）
  const semanticHash = createHash("sha256")
    .update(
      `v1|${state.revision}|${evidence.hash}|hm:${evidence.humanMessageTimes.join(",")}` +
        `|fh:${JSON.stringify(evidence.firstHumanMessageLine ?? "")}|cid:${JSON.stringify(options?.conversationId ?? "")}` +
        `|lg:${evidence.longGaps.map((g) => `${g.at}+${g.durationMs}`).join(",")}` +
        `|lgd:${evidence.coverage.longGaps}/${evidence.droppedLongGapMs}` +
        // pp1 progress は evidence.hash 射影外だがモデル出力へ影響しうる入力
        `|pp:${evidence.progressTransitions
          .map((p) => `${p.resolvedAssignmentRef ?? ""}:${p.state}@${p.at}:${p.ownershipVerified ? 1 : 0}`)
          .join(",")}|ppi:${evidence.invalidProgressCount}`
    )
    .digest("hex");

  const assignments = deriveAssignments(evidence, taskNodes, defaultStageNodeId);
  const progress = buildProgressL3Input(evidence, assignments, options?.baseDir);
  // evidence-index 側の鍵は progressSubjectKey(attempt nodeId)。Attempt nodeId へ戻す
  // （鍵の逆変換を書かず、delegations を走査して同じ関数で引く）
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
    // open の主張は openAsyncStatusOf と同じゲート（MED-1 / 裁定H-1）を通す。resume 復元の
    // 旧 background 委任を open のまま出すと、終了済みセッションの並列数が残る
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

// pp1 の L3 入力を evidence と Assignment から組み立てる。
// pp1 側（progress）と observed 側（writes・verification 観測）を別キーで渡し、比較器が両者を混ぜない。
// pp1 emission が1件も無くても observed writes は供給する（observed-only アーム）
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

  // completion を裏付ける observed evidence の時刻列。パス名からの推測はしない（自然言語/
  // 文字列推測の禁止と同型）。観測事実だけを使う: (1) 読み戻し（read アクセス）、
  // (2) コマンド実行の観測（effectGaps = exec_unknown 等の効果不明呼び出し）。
  // pp1 の evidence 文字列の真偽は入力にしない
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
