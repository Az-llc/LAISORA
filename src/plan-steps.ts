import type { TaskStatus } from "./work-model";

export function normalizePlanContent(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " "); }

export function planStepKey(entry: { source?: "tasks" }, item: { taskKey: string; description: string }): string {
  return (entry.source === "tasks" || item.taskKey.startsWith("task:")) ? `task\n${item.taskKey}` : normalizePlanContent(item.description);
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
    else if (status === "completed") step.endedAt = at;
  }
  step.status = status;
  step.removed = false;
  return changed;
}

export function planStepAt<T extends { key: string }>(steps: readonly T[], transitions: ReadonlyMap<string, readonly PlanStepTransition[]>, at: number): T | undefined {
  let winner: T | undefined;
  let latest = -1;
  let latestAt = -1;
  for (const step of steps) {
    const change = transitions.get(step.key)?.filter(value => value.at <= at).at(-1);
    if (change?.active && (change.at > latestAt || change.at === latestAt && change.order > latest)) { winner = step; latest = change.order; latestAt = change.at; }
  }
  return winner;
}
