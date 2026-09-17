// Context Handoff の activeTasks 射影。本番の Host 経路からは import しない（esbuild の単体出力 dist/handoff-capsule.mjs として検査が読む）。
// evidence-index / semantic-model へ書き戻さない。attemptProgressStates は state 文字列しか返さないため、
// unavailableReason / assignmentRefs / lastProgressAt / blocker はここで導出する。
// Task の鍵は SemanticModel.assignments から取り、ここで帰属を再解決しない（Guardrail の taskId と同じ関数・同じ入力で一致させる）
import {
  assignmentRefOf,
  isAssignmentActiveAt,
  type DelegationRecord,
  type ProgressTransitionRecord,
  type SemanticEvidenceIndex,
} from "./evidence-index";
import { redactAbsolutePaths } from "./path-redaction";
import { progressSubjectKey } from "./progress-protocol";
import type { Assignment } from "./semantic-model";

export type HandoffAssignmentInput = Pick<Assignment, "agentRunId" | "taskNodeId" | "startedAt">;

// state を投影できなかった理由。「done で終わった」と「観測地平の外」を潰さない
export type HandoffUnavailableReason =
  | "ended_by_done"
  | "ended_by_assignment_close"
  | "out_of_horizon"
  | "no_attributed_progress";

// state=undetermined の理由
export type HandoffStateUndeterminedReason = "multiple_active_assignments";

export interface HandoffActiveTask {
  taskId: string;
  state: "active" | "blocked" | "review" | "undetermined" | "unavailable";
  stateUndeterminedReason?: HandoffStateUndeterminedReason;
  unavailableReason?: HandoffUnavailableReason;
  assignmentRefs: string[];
  lastProgressAt?: number;
  blocker?: string;
}

function horizonOf(index: SemanticEvidenceIndex): number {
  let horizon = 0;
  for (const t of index.progressTransitions) if (t.at > horizon) horizon = t.at;
  for (const d of index.delegations) {
    if (d.startedAt > horizon) horizon = d.startedAt;
    if (d.endedAt !== undefined && d.endedAt > horizon) horizon = d.endedAt;
  }
  return horizon;
}

// 当該 Assignment scoped の最終 verified 遷移（deriveAssignmentProgressStates と同じ選別規則）
function scopedTransitions(index: SemanticEvidenceIndex): Map<string, ProgressTransitionRecord> {
  const out = new Map<string, ProgressTransitionRecord>();
  for (const t of index.progressTransitions) {
    if (!t.ownershipVerified) continue;
    if (t.resolvedAssignmentRef === undefined) continue;
    out.set(t.resolvedAssignmentRef, t);
  }
  return out;
}

// 有効0件のとき、なぜ投影できないのかを1つに決める
function unavailableReasonFor(
  refs: string[],
  byRef: Map<string, DelegationRecord>,
  scoped: Map<string, ProgressTransitionRecord>
): HandoffUnavailableReason {
  let sawDone = false;
  let sawClosed = false;
  let sawProgress = false;
  for (const ref of refs) {
    const d = byRef.get(ref);
    if (d === undefined) continue;
    const last = scoped.get(ref);
    if (last !== undefined) sawProgress = true;
    if (last?.state === "done") sawDone = true;
    if (d.endedAt !== undefined) sawClosed = true;
  }
  if (sawDone) return "ended_by_done";
  if (sawClosed) return "ended_by_assignment_close";
  if (!sawProgress) return "no_attributed_progress";
  return "out_of_horizon";
}

export function buildActiveTasks(
  index: SemanticEvidenceIndex,
  assignments: readonly HandoffAssignmentInput[]
): HandoffActiveTask[] {
  const taskNodeIdByKey = new Map(assignments.map((a) => [`${a.agentRunId}@${a.startedAt}`, a.taskNodeId]));
  const taskRefs = new Map<string, string[]>();
  for (const d of index.delegations) {
    const taskNodeId = taskNodeIdByKey.get(`agentRun:${d.agentId}@${d.startedAt}`);
    // Assignment は委任 1 件につき 1 件（deriveAssignments）。無い委任は別 evidence 由来なので鍵を作らない
    if (taskNodeId === undefined) continue;
    const tid = progressSubjectKey(taskNodeId);
    const list = taskRefs.get(tid) ?? [];
    list.push(assignmentRefOf(d));
    taskRefs.set(tid, list);
  }
  const byRef = new Map(index.delegations.map((d) => [assignmentRefOf(d), d] as const));
  const scoped = scopedTransitions(index);
  const evaluatedAt = horizonOf(index) + 1;

  const out: HandoffActiveTask[] = [];
  for (const [taskId, refs] of taskRefs) {
    const valid = refs.filter((ref) => {
      const d = byRef.get(ref);
      return d !== undefined && isAssignmentActiveAt(d, evaluatedAt, index.progressTransitions);
    });

    if (valid.length === 0) {
      out.push({
        taskId,
        state: "unavailable",
        unavailableReason: unavailableReasonFor(refs, byRef, scoped),
        assignmentRefs: refs,
      });
      continue;
    }
    if (valid.length > 1) {
      // task-level の undetermined は「有効 Assignment が複数」。単数 ref へ潰さない
      out.push({
        taskId,
        state: "undetermined",
        stateUndeterminedReason: "multiple_active_assignments",
        assignmentRefs: valid,
      });
      continue;
    }
    const last = scoped.get(valid[0]);
    const s = last?.state;
    if (s === "active" || s === "blocked" || s === "review") {
      out.push({
        taskId,
        state: s,
        assignmentRefs: valid,
        lastProgressAt: last?.at,
        // blocker は emitter 由来の自由文で絶対パスを含みうる
        ...(last?.blocker !== undefined ? { blocker: redactAbsolutePaths(last.blocker) } : {}),
      });
      continue;
    }
    out.push({
      taskId,
      state: "unavailable",
      unavailableReason: "no_attributed_progress",
      assignmentRefs: valid,
    });
  }
  out.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return out;
}
