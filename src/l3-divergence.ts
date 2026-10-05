import { createHash } from "node:crypto";
import type { SerializationClassification } from "./l3-analysis";
import { progressSubjectKey } from "./progress-protocol";
import type {
  Coverage,
  EvidenceRef,
  ExecutionAttemptNode,
  SemanticCoverage,
  SemanticEdge,
  SemanticModel,
  TaskDefinitionNode,
} from "./semantic-model";

export const L3_DIVERGENCE_SPEC_VERSION = 2;

export type DivergenceKind =
  | "serialization"
  | "unsupported_completion"
  | "progress_stagnation"
  | "declared_state_conflict";

export const DIVERGENCE_KINDS: readonly DivergenceKind[] = [
  "serialization",
  "unsupported_completion",
  "progress_stagnation",
  "declared_state_conflict",
];

export type DivergenceUndeterminedReason =
  | "no_determinable_pair"
  | "no_serialization_input"
  | "no_declared_task_input";

export type DivergenceAbsentReason = "no_observed_dependency_edge";

export interface DivergenceAbsent {
  state: "absent";
  reason: DivergenceAbsentReason;
}

export type DivergenceUnit = "task_pair" | "attempt_pair";

export interface DivergenceRecord {
  divergenceId: string;
  kind: DivergenceKind;
  subjectIds: string[];
  declared: unknown;
  observed: unknown;
  magnitude?: number;
  evidence: EvidenceRef[];
  coverage: Coverage;
}

type DraftDivergenceRecord = Omit<DivergenceRecord, "divergenceId">;

export interface DivergenceKindReport {
  kind: DivergenceKind;
  state: "observed" | "undetermined";
  reason?: DivergenceUndeterminedReason;
  records: DivergenceRecord[];
  counts: Record<string, number>;
  coverage: SemanticCoverage;
}

type DraftKindReport = Omit<DivergenceKindReport, "records"> & {
  records: DraftDivergenceRecord[];
};

export interface DivergenceReport {
  specVersion: number;
  semanticHash: string;
  coverage: SemanticCoverage;
  kinds: Record<DivergenceKind, DivergenceKindReport>;
  recordCount: number;
  droppedRecordCount: number;
  segmentAnchoredIdCount: number;
}

export const DIVERGENCE_ID_RULE_VERSION = "dv1";
const DIVERGENCE_ID_HEX_LENGTH = 16;

const MAX_EVIDENCE_PER_RECORD = 8;
const MAX_RECORDS_PER_KIND = 100;
const MAX_ATTEMPT_PAIR_SCAN = 250000;

function worstCoverage(axes: Coverage[]): Coverage {
  if (axes.includes("unavailable")) return "unavailable";
  if (axes.includes("partial")) return "partial";
  return "complete";
}

function baseAxis(model: SemanticModel): Coverage {
  return model.coverage.base.summary === "prefix-truncated" ||
    model.coverage.base.details === "prefix-truncated"
    ? "partial"
    : "complete";
}

function capEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  return refs.slice(0, MAX_EVIDENCE_PER_RECORD);
}

function taskNodesOf(model: SemanticModel): TaskDefinitionNode[] {
  return model.nodes.filter((n): n is TaskDefinitionNode => n.kind === "task");
}

function attemptNodesOf(model: SemanticModel): ExecutionAttemptNode[] {
  return model.nodes.filter((n): n is ExecutionAttemptNode => n.kind === "attempt");
}

function taskOfAttempt(a: ExecutionAttemptNode): string | undefined {
  return a.parentId !== undefined && a.parentId.startsWith("task:") ? a.parentId : undefined;
}

type SubjectKey = string[];

interface SubjectKeyIndex {
  tasks: Map<string, TaskDefinitionNode>;
  attempts: Map<string, ExecutionAttemptNode>;
}

function buildSubjectKeyIndex(model: SemanticModel): SubjectKeyIndex {
  return {
    tasks: new Map(taskNodesOf(model).map((t) => [t.nodeId, t])),
    attempts: new Map(attemptNodesOf(model).map((a) => [a.nodeId, a])),
  };
}

function subjectKeyOf(nodeId: string, index: SubjectKeyIndex): SubjectKey {
  const task = index.tasks.get(nodeId);
  if (task !== undefined) return ["t", task.identity.semanticTaskId];
  const attempt = index.attempts.get(nodeId);
  if (attempt !== undefined) {
    if (attempt.actor !== undefined) return ["a", nodeId.slice("attempt:".length)];
    const parent = attempt.parentId !== undefined ? index.tasks.get(attempt.parentId) : undefined;
    return ["s", parent?.identity.semanticTaskId ?? "", String(attempt.startedAt)];
  }
  return ["s", nodeId];
}

function divergenceIdOf(kind: DivergenceKind, subjects: SubjectKey[]): string {
  const canonical = JSON.stringify([DIVERGENCE_ID_RULE_VERSION, kind, subjects]);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${DIVERGENCE_ID_RULE_VERSION}_${digest.slice(0, DIVERGENCE_ID_HEX_LENGTH)}`;
}

function pairKeyOf(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${x.length}\u0000${x}\u0000${y}`;
}

function taskUnknownEffects(t: TaskDefinitionNode): boolean | undefined {
  return t.executionSummary?.footprint?.unknownEffects;
}

function taskFootprintCoverage(t: TaskDefinitionNode): Coverage {
  return t.executionSummary?.footprint?.coverage ?? "unavailable";
}

function taskWindowsOverlap(a: TaskDefinitionNode, b: TaskDefinitionNode): boolean {
  const aw = a.executionWindow;
  const bw = b.executionWindow;
  if (aw === undefined || bw === undefined) return false;
  const aEnd = aw.endedAt ?? Infinity;
  const bEnd = bw.endedAt ?? Infinity;
  return Math.max(aw.startedAt, bw.startedAt) < Math.min(aEnd, bEnd);
}

interface TaskPair {
  aId: string;
  bId: string;
  observedDataDep: SemanticEdge[];
  resourceConflict: SemanticEdge[];
}

function buildTaskPairs(model: SemanticModel): Map<string, TaskPair> {
  const attemptTask = new Map<string, string>();
  for (const a of attemptNodesOf(model)) {
    const t = taskOfAttempt(a);
    if (t !== undefined) attemptTask.set(a.nodeId, t);
  }
  const taskIds = new Set(taskNodesOf(model).map((t) => t.nodeId));
  const toTaskId = (nodeId: string): string | undefined =>
    taskIds.has(nodeId) ? nodeId : attemptTask.get(nodeId);

  const map = new Map<string, TaskPair>();
  const entry = (from: string, to: string): TaskPair => {
    const key = pairKeyOf(from, to);
    let e = map.get(key);
    if (!e) {
      const [aId, bId] = from < to ? [from, to] : [to, from];
      e = {
        aId,
        bId,
        observedDataDep: [],
        resourceConflict: [],
      };
      map.set(key, e);
    }
    return e;
  };

  for (const edge of model.edges) {
    if (edge.kind !== "observed_data_dep" && edge.kind !== "resource_conflict") {
      continue;
    }
    const from = toTaskId(edge.from);
    const to = toTaskId(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const e = entry(from, to);
    if (edge.kind === "observed_data_dep") {
      e.observedDataDep.push(edge);
    } else {
      e.resourceConflict.push(edge);
    }
  }
  return map;
}

function classifySerialization(
  a: TaskDefinitionNode,
  b: TaskDefinitionNode,
  pair: TaskPair | undefined
): SerializationClassification {
  const dd = pair?.observedDataDep ?? [];
  const rc = pair?.resourceConflict ?? [];
  if (dd.length > 0 || rc.length > 0) return "required";
  if (taskUnknownEffects(a) === false && taskUnknownEffects(b) === false) return "independent-serial";
  return "undetermined";
}

function sortRecords(records: DraftDivergenceRecord[]): DraftDivergenceRecord[] {
  return records.sort((x, y) => {
    const kx = x.subjectIds.join("\u0000");
    const ky = y.subjectIds.join("\u0000");
    if (kx !== ky) return kx < ky ? -1 : 1;
    return (x.magnitude ?? 0) - (y.magnitude ?? 0);
  });
}

function finish(
  kind: DivergenceKind,
  model: SemanticModel,
  records: DraftDivergenceRecord[],
  counts: Record<string, number>,
  state: "observed" | "undetermined",
  reason?: DivergenceUndeterminedReason,
  coveragePatch?: Partial<SemanticCoverage>
): DraftKindReport {
  const kept = records.slice(0, MAX_RECORDS_PER_KIND);
  const allCounts = { ...counts, droppedRecordCount: records.length - kept.length };
  const report: DraftKindReport = {
    kind,
    state,
    records: kept,
    counts: allCounts,
    coverage: { ...model.coverage, ...coveragePatch },
  };
  if (reason !== undefined) report.reason = reason;
  return report;
}

interface AttemptPairScan {
  records: DraftDivergenceRecord[];
  counts: Record<string, number>;
  scanned: boolean;
}

function scanAttemptPairs(
  model: SemanticModel,
  taskPairsAlreadyReported: Set<string>
): AttemptPairScan {
  const attempts = attemptNodesOf(model)
    .filter((a) => a.endedAt !== undefined && taskOfAttempt(a) !== undefined)
    .sort((x, y) => x.startedAt - y.startedAt || (x.nodeId < y.nodeId ? -1 : 1));
  const counts: Record<string, number> = {
    attemptPairPoolSize: attempts.length,
    attemptPairCount: 0,
    attemptPairRequired: 0,
    attemptPairIndependentSerial: 0,
    attemptPairUndetermined: 0,
    attemptPairSameActorExcluded: 0,
    attemptPairCoveredByTaskPair: 0,
    attemptPairReviewsRelated: 0,
  };
  const pairTotal = (attempts.length * (attempts.length - 1)) / 2;
  if (pairTotal > MAX_ATTEMPT_PAIR_SCAN) {
    return { records: [], counts, scanned: false };
  }

  const attemptDataDep = new Set<string>();
  const attemptConflict = new Set<string>();
  const reviewsFromAttempt = new Map<string, Set<string>>();
  for (const e of model.edges) {
    if (e.kind === "observed_data_dep") attemptDataDep.add(pairKeyOf(e.from, e.to));
    else if (e.kind === "resource_conflict") attemptConflict.add(pairKeyOf(e.from, e.to));
    else if (e.kind === "reviews") {
      const set = reviewsFromAttempt.get(e.from) ?? new Set<string>();
      set.add(e.to);
      reviewsFromAttempt.set(e.from, set);
    }
  }

  const records: DraftDivergenceRecord[] = [];
  const axes = [baseAxis(model), model.coverage.dependency, model.coverage.detail];
  for (let i = 0; i < attempts.length; i++) {
    for (let j = i + 1; j < attempts.length; j++) {
      const a = attempts[i];
      const b = attempts[j];
      const taskA = taskOfAttempt(a)!;
      const taskB = taskOfAttempt(b)!;
      if (taskA === taskB) continue;
      const aEnd = a.endedAt!;
      const bEnd = b.endedAt!;
      if (Math.max(a.startedAt, b.startedAt) < Math.min(aEnd, bEnd)) continue;
      counts.attemptPairCount++;
      const key = pairKeyOf(a.nodeId, b.nodeId);
      if (attemptDataDep.has(key) || attemptConflict.has(key)) {
        counts.attemptPairRequired++;
        continue;
      }
      if (!(a.footprint.unknownEffects === false && b.footprint.unknownEffects === false)) {
        counts.attemptPairUndetermined++;
        continue;
      }
      counts.attemptPairIndependentSerial++;
      const actorA = a.actor?.agentId;
      const actorB = b.actor?.agentId;
      if (actorA !== undefined && actorA === actorB) {
        counts.attemptPairSameActorExcluded++;
        continue;
      }
      if (taskPairsAlreadyReported.has(pairKeyOf(taskA, taskB))) {
        counts.attemptPairCoveredByTaskPair++;
        continue;
      }
      if (reviewsFromAttempt.get(a.nodeId)?.has(taskB) || reviewsFromAttempt.get(b.nodeId)?.has(taskA)) {
        counts.attemptPairReviewsRelated++;
      }
      records.push({
        kind: "serialization",
        subjectIds: [a.nodeId, b.nodeId],
        declared: { state: "absent", reason: "no_observed_dependency_edge" } satisfies DivergenceAbsent,
        observed: {
          classification: "independent-serial",
          unit: "attempt_pair" satisfies DivergenceUnit,
        },
        evidence: capEvidence([...a.evidence, ...b.evidence]),
        coverage: worstCoverage([...axes, a.footprint.coverage, b.footprint.coverage]),
      });
    }
  }
  return { records, counts, scanned: true };
}

function deriveSerialization(
  model: SemanticModel,
  pairs: Map<string, TaskPair>
): DraftKindReport {
  const tasks = taskNodesOf(model).filter((t) => t.executionWindow !== undefined);
  const counts: Record<string, number> = {
    windowedTaskCount: tasks.length,
    taskPairCount: 0,
    taskPairRequired: 0,
    taskPairIndependentSerial: 0,
    taskPairUndetermined: 0,
    evidenceMissingCount: 0,
  };
  const taskRecords: DraftDivergenceRecord[] = [];
  const reportedTaskPairs = new Set<string>();
  const axes = [baseAxis(model), model.coverage.dependency, model.coverage.detail];

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (taskWindowsOverlap(a, b)) continue;
      counts.taskPairCount++;
      const pair = pairs.get(pairKeyOf(a.nodeId, b.nodeId));
      const classification = classifySerialization(a, b, pair);
      if (classification === "required") {
        counts.taskPairRequired++;
        continue;
      }
      if (classification === "undetermined") {
        counts.taskPairUndetermined++;
        continue;
      }
      counts.taskPairIndependentSerial++;
      const evidence = capEvidence([...a.evidence, ...b.evidence]);
      if (evidence.length === 0) counts.evidenceMissingCount++;
      reportedTaskPairs.add(pairKeyOf(a.nodeId, b.nodeId));
      taskRecords.push({
        kind: "serialization",
        subjectIds: [a.nodeId, b.nodeId],
        declared: { state: "absent", reason: "no_observed_dependency_edge" } satisfies DivergenceAbsent,
        observed: {
          classification: "independent-serial",
          unit: "task_pair" satisfies DivergenceUnit,
        },
        evidence,
        coverage: worstCoverage([...axes, taskFootprintCoverage(a), taskFootprintCoverage(b)]),
      });
    }
  }

  const attemptScan = scanAttemptPairs(model, reportedTaskPairs);
  const allCounts: Record<string, number> = {
    ...counts,
    ...attemptScan.counts,
    attemptPairScanLimited: attemptScan.scanned ? 0 : 1,
  };
  const poolSize = counts.taskPairCount + allCounts.attemptPairCount;
  const determinable =
    counts.taskPairRequired +
    counts.taskPairIndependentSerial +
    allCounts.attemptPairRequired +
    allCounts.attemptPairIndependentSerial;
  const patch = attemptScan.scanned ? undefined : { detail: "partial" as Coverage };

  if (poolSize === 0) {
    return finish("serialization", model, [], allCounts, "undetermined", "no_serialization_input", patch);
  }
  if (determinable === 0) {
    return finish("serialization", model, [], allCounts, "undetermined", "no_determinable_pair", patch);
  }
  const ordered = [...sortRecords(taskRecords), ...sortRecords(attemptScan.records)];
  return finish("serialization", model, ordered, allCounts, "observed", undefined, patch);
}

interface AssignedKinds {
  kinds: Record<DivergenceKind, DivergenceKindReport>;
  segmentAnchoredIdCount: number;
}

function assignIds(
  model: SemanticModel,
  drafts: Record<DivergenceKind, DraftKindReport>
): AssignedKinds {
  const index = buildSubjectKeyIndex(model);
  let segmentAnchoredIdCount = 0;
  const kinds = {} as Record<DivergenceKind, DivergenceKindReport>;
  for (const kind of Object.keys(drafts) as DivergenceKind[]) {
    const draft = drafts[kind];
    kinds[kind] = {
      ...draft,
      records: draft.records.map((record) => {
        const subjects = record.subjectIds.map((nodeId) => subjectKeyOf(nodeId, index));
        if (subjects.some((s) => s[0] === "s")) segmentAnchoredIdCount++;
        return { divergenceId: divergenceIdOf(record.kind, subjects), ...record };
      }),
    };
  }
  return { kinds, segmentAnchoredIdCount };
}

const PROGRESS_STAGNATION_GAP_MS = 5 * 60_000;

function progressCoverage(model: SemanticModel, kind: DivergenceKind): Coverage {
  const axes = [baseAxis(model), model.coverage.identity, model.coverage.artifact];
  if (kind === "progress_stagnation") axes.push(model.coverage.timing);
  return worstCoverage(axes);
}

interface ProgressScopedEntry {
  ref: string;
  taskId: string;
  attemptNodeId?: string;
  state: "active" | "blocked" | "review" | "done";
  at: number;
  next?: number;
  hasBlocker: boolean;
  role?: string;
}

function attributedTransitions(model: SemanticModel): ProgressScopedEntry[] {
  const p = model.progress;
  if (p === undefined) return [];
  const out: ProgressScopedEntry[] = [];
  for (const t of p.transitions) {
    if (!t.ownershipVerified) continue;
    const ref = t.resolvedAssignmentRef;
    if (ref === undefined) continue;
    const taskId = p.assignmentTaskIdByRef[ref];
    if (taskId === undefined) continue;
    const attemptNodeId = p.assignmentAttemptNodeIdByRef[ref];
    out.push({
      ref,
      taskId,
      ...(attemptNodeId !== undefined ? { attemptNodeId } : {}),
      state: t.state,
      at: t.at,
      hasBlocker: t.blocker !== undefined && t.blocker !== "",
      ...(p.assignmentRoleByRef[ref] !== undefined ? { role: p.assignmentRoleByRef[ref] } : {}),
    });
  }
  out.sort((a, b) => a.at - b.at);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].ref === out[i].ref) {
        out[i].next = out[j].at;
        break;
      }
    }
  }
  return out;
}

function progressSubjectIds(e: ProgressScopedEntry): string[] {
  return e.attemptNodeId === undefined || e.attemptNodeId === e.taskId ? [e.taskId] : [e.taskId, e.attemptNodeId];
}

function progressReport(
  kind: DivergenceKind,
  model: SemanticModel,
  records: DraftDivergenceRecord[],
  counts: Record<string, number>
): DraftKindReport {
  if (model.progress === undefined) {
    return finish(kind, model, [], counts, "undetermined", "no_declared_task_input");
  }
  const entries = attributedTransitions(model);
  if (entries.length === 0) {
    return finish(kind, model, [], counts, "undetermined", "no_declared_task_input");
  }
  return finish(kind, model, records, counts, "observed");
}

function deriveUnsupportedCompletion(model: SemanticModel): DraftKindReport {
  const p = model.progress;
  const counts = { doneCount: 0, unsupportedCount: 0 };
  if (p === undefined) {
    return finish("unsupported_completion", model, [], counts, "undetermined", "no_declared_task_input");
  }
  const records: DraftDivergenceRecord[] = [];
  for (const e of attributedTransitions(model)) {
    if (e.state !== "done") continue;
    counts.doneCount++;
    const verifications = (p.verificationsByTaskId[e.taskId] ?? []).filter((at) => at <= e.at);
    const writes = (p.writesByTaskId[e.taskId] ?? []).filter((w) => w.at <= e.at);
    if (verifications.length > 0 || writes.length > 0) continue;
    counts.unsupportedCount++;
    records.push({
      kind: "unsupported_completion",
      coverage: progressCoverage(model, "unsupported_completion"),
      subjectIds: progressSubjectIds(e),
      declared: { taskId: progressSubjectKey(e.taskId), state: "done", at: e.at },
      observed: { verificationCount: 0, writeCount: 0, windowEnd: e.at },
      evidence: [],
    });
  }
  return progressReport("unsupported_completion", model, records, counts);
}

function deriveProgressStagnation(model: SemanticModel): DraftKindReport {
  const p = model.progress;
  const counts = { activeCount: 0, stagnantCount: 0 };
  if (p === undefined) {
    return finish("progress_stagnation", model, [], counts, "undetermined", "no_declared_task_input");
  }
  const records: DraftDivergenceRecord[] = [];
  for (const e of attributedTransitions(model)) {
    if (e.state !== "active") continue;
    if (e.hasBlocker) continue;
    counts.activeCount++;
    const windowEnd = e.next;
    if (windowEnd === undefined) continue;
    const advanced =
      (p.writesByTaskId[e.taskId] ?? []).some((w) => w.at > e.at && w.at <= windowEnd) ||
      (p.verificationsByTaskId[e.taskId] ?? []).some((at) => at > e.at && at <= windowEnd);
    const gapped = p.longGaps.some((g) => g.at >= e.at && g.at < windowEnd && g.durationMs >= PROGRESS_STAGNATION_GAP_MS);
    if (advanced || !gapped) continue;
    counts.stagnantCount++;
    records.push({
      kind: "progress_stagnation",
      coverage: progressCoverage(model, "progress_stagnation"),
      subjectIds: progressSubjectIds(e),
      declared: { taskId: progressSubjectKey(e.taskId), state: "active", at: e.at },
      observed: { windowEnd, advanced: false },
      evidence: [],
    });
  }
  return progressReport("progress_stagnation", model, records, counts);
}

function deriveDeclaredStateConflict(model: SemanticModel): DraftKindReport {
  const p = model.progress;
  const counts = { reviewOrDoneCount: 0, conflictCount: 0 };
  if (p === undefined) {
    return finish("declared_state_conflict", model, [], counts, "undetermined", "no_declared_task_input");
  }
  const records: DraftDivergenceRecord[] = [];
  for (const e of attributedTransitions(model)) {
    if (e.state !== "review" && e.state !== "done") continue;
    if (e.role === "review") continue;
    counts.reviewOrDoneCount++;
    const windowEnd = e.next ?? Number.POSITIVE_INFINITY;
    const writes = (p.writesByTaskId[e.taskId] ?? []).filter((w) => w.at > e.at && w.at < windowEnd);
    if (writes.length === 0) continue;
    counts.conflictCount++;
    records.push({
      kind: "declared_state_conflict",
      coverage: progressCoverage(model, "declared_state_conflict"),
      subjectIds: progressSubjectIds(e),
      declared: { taskId: progressSubjectKey(e.taskId), state: e.state, at: e.at },
      observed: {
        writeCount: writes.length,
        firstWriteAt: writes[0].at,
        artifactIds: writes.slice(0, 8).map((w) => w.artifactId),
      },
      evidence: [],
    });
  }
  return progressReport("declared_state_conflict", model, records, counts);
}

export function deriveDivergences(model: SemanticModel): DivergenceReport {
  const pairs = buildTaskPairs(model);
  const { kinds, segmentAnchoredIdCount } = assignIds(model, {
    serialization: deriveSerialization(model, pairs),
    unsupported_completion: deriveUnsupportedCompletion(model),
    progress_stagnation: deriveProgressStagnation(model),
    declared_state_conflict: deriveDeclaredStateConflict(model),
  });

  let recordCount = 0;
  let droppedRecordCount = 0;
  for (const kind of DIVERGENCE_KINDS) {
    recordCount += kinds[kind].records.length;
    droppedRecordCount += kinds[kind].counts.droppedRecordCount ?? 0;
  }

  return {
    specVersion: L3_DIVERGENCE_SPEC_VERSION,
    semanticHash: model.semanticHash,
    coverage: model.coverage,
    kinds,
    recordCount,
    droppedRecordCount,
    segmentAnchoredIdCount,
  };
}
