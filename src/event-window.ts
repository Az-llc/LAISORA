import { CONVERSATION_ANCHOR_UUIDS_MAX, type NormalizedEvent } from "./protocol";
import { contentText } from "./human-input-vocabulary";

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

export interface ShownConversationRecord {
  uuid: string;
  restored: boolean;
  reply?: { text: string; leadsSegment: boolean };
}

export type PastRecordAction =
  | { kind: "add" }
  | { kind: "skip" }
  | { kind: "complete"; prefix: string }
  | { kind: "fetch" };

export function pastRecordAction(
  shown: ShownConversationRecord | undefined,
  item: { text: string; clipped?: true }
): PastRecordAction {
  if (shown === undefined) return { kind: "add" };
  const reply = shown.reply;
  if (reply === undefined || !reply.leadsSegment) return { kind: "skip" };
  const served = contentText(reply.text);
  if (item.clipped) return served.startsWith(item.text) ? { kind: "skip" } : { kind: "fetch" };
  if (item.text.length <= served.length || !item.text.endsWith(served)) return { kind: "skip" };
  const prefix = item.text.slice(0, item.text.length - served.length);
  const leading = reply.text.slice(0, reply.text.length - reply.text.trimStart().length);
  return { kind: "complete", prefix: prefix.endsWith(leading) ? prefix.slice(0, prefix.length - leading.length) : prefix };
}

export function transcriptAnchorUuids(
  shownOldestFirst: Iterable<ShownConversationRecord>,
  hostDroppedEventCount: number
): string[] {
  const anchors: string[] = [];
  let reachable = hostDroppedEventCount > 0;
  for (const record of shownOldestFirst) {
    reachable ||= record.restored;
    if (anchors.length < CONVERSATION_ANCHOR_UUIDS_MAX && !anchors.includes(record.uuid)) anchors.push(record.uuid);
    if (reachable && anchors.length >= CONVERSATION_ANCHOR_UUIDS_MAX) break;
  }
  return reachable ? anchors : [];
}

function findLastTurnStart(events: NormalizedEvent[], before: number): NormalizedEvent | undefined {
  for (let i = Math.min(before, events.length) - 1; i >= 0; i--) {
    if (events[i].kind === "turn_started") return events[i];
  }
  return undefined;
}
