import type { NormalizedEvent } from "./protocol";

export interface EventWindow {
  events: NormalizedEvent[];
  droppedCount: number;
  backfilledHead: boolean;
}

export function windowEvents(events: NormalizedEvent[], max: number): EventWindow {
  if (max <= 0) return { events: [], droppedCount: events.length, backfilledHead: false };
  if (events.length <= max) return { events, droppedCount: 0, backfilledHead: false };

  const minimumCut = events.length - max;
  let cut = minimumCut;
  while (cut < events.length && events[cut].kind !== "turn_started") cut++;
  if (cut < events.length) return { events: events.slice(cut), droppedCount: cut, backfilledHead: false };

  const boundary = findLastTurnStart(events, minimumCut);
  if (!boundary) {
    return { events: events.slice(minimumCut), droppedCount: minimumCut, backfilledHead: false };
  }
  const kept = [boundary, ...events.slice(minimumCut + 1)];
  return { events: kept, droppedCount: events.length - kept.length, backfilledHead: true };
}

function findLastTurnStart(events: NormalizedEvent[], before: number): NormalizedEvent | undefined {
  for (let i = Math.min(before, events.length) - 1; i >= 0; i--) {
    if (events[i].kind === "turn_started") return events[i];
  }
  return undefined;
}
