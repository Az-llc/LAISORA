export const PROGRESS_PROTOCOL_SPEC_PP1 = `[LAISORA progress protocol pp1]
A tool named mcp__laisora_progress__progress is available. When your assignment state changes among active, blocked, review, done, call it once with a JSON input: {"pp":"pp1","state":"active|blocked|review|done","activity":"<short>","blocker":"<short or omit>","evidence":["<short>"],"next":"<short or omit>"}.
Call it at least when you start working (state "active") and when you finish (state "done"). Omit task_id; the host resolves it from your assignment.
Follow the task instructions for what each state means. Do not report percentages. If the tool is unavailable or the call fails, continue working; reporting is optional and must never block the task.`;

export type ProgressTrackingMode = "off" | "observe" | "instrument";

export function normalizeProgressTracking(value: unknown): ProgressTrackingMode {
  return value === "instrument" || value === "observe" || value === "off" ? value : "observe";
}

// Guardrail / Handoff / work-graph が pp1 束縛の鍵を得る単一出所。
// Task nodeId は `task:<semanticTaskId>`、Attempt nodeId は `attempt:<toolUseId>`
export function progressSubjectKey(nodeId: string): string {
  if (nodeId.startsWith("task:")) {
    return nodeId.slice("task:".length);
  }
  if (nodeId.startsWith("attempt:")) {
    return `del:${nodeId.slice("attempt:".length)}`;
  }
  return nodeId;
}
