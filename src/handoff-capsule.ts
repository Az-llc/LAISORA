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

export type HandoffUnavailableReason =
  | "ended_by_done"
  | "ended_by_assignment_close"
  | "out_of_horizon"
  | "no_attributed_progress";

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

function scopedTransitions(index: SemanticEvidenceIndex): Map<string, ProgressTransitionRecord> {
  const out = new Map<string, ProgressTransitionRecord>();
  for (const t of index.progressTransitions) {
    if (!t.ownershipVerified) continue;
    if (t.resolvedAssignmentRef === undefined) continue;
    out.set(t.resolvedAssignmentRef, t);
  }
  return out;
}

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
