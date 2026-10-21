import type { NormalizedEvent } from "./protocol";

export interface EventWindow {
  events: NormalizedEvent[];
  droppedCount: number;
}

export function windowEvents(events: NormalizedEvent[], max: number): EventWindow {
  if (max <= 0) return { events: [], droppedCount: events.length };
  if (events.length <= max) return { events, droppedCount: 0 };

  const minimumCut = events.length - max;
  let cut = minimumCut;
  while (cut < events.length && events[cut].kind !== "turn_started") cut++;
  if (cut < events.length) return { events: events.slice(cut), droppedCount: cut };

  const boundary = findLastTurnStart(events, minimumCut);
  if (!boundary) {
    return { events: events.slice(minimumCut), droppedCount: minimumCut };
  }
  const kept = [boundary, ...events.slice(minimumCut + 1)];
  return { events: kept, droppedCount: events.length - kept.length };
}

export function followsDirectly(earlier: { seq: number }, later: { seq: number }): boolean {
  return later.seq === earlier.seq + 1;
}

export function historyAnchorIndex(events: readonly NormalizedEvent[]): number {
  const head = events[0];
  const next = events[1];
  if (head === undefined || next === undefined || head.kind !== "turn_started") return 0;
  return followsDirectly(head, next) ? 0 : 1;
}

function findLastTurnStart(events: NormalizedEvent[], before: number): NormalizedEvent | undefined {
  for (let i = Math.min(before, events.length) - 1; i >= 0; i--) {
    if (events[i].kind === "turn_started") return events[i];
  }
  return undefined;
}
