import type { HandoffRunner } from "./handoff-runner";

export interface HandoffRunReservation { runId: string; runner: HandoffRunner | null }

export const handoffRuns = new Map<string, HandoffRunReservation>();

export function handoffInProgress(tabId: string): boolean {
  return handoffRuns.has(tabId);
}
