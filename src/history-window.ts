import type { NormalizedEvent } from "./protocol";
import { windowEvents } from "./event-window";
import { createScopedCursors } from "./scoped-cursors";

export const HISTORY_CURSOR_MAX = 1024;

const IDENTITY_CHAR_BYTES = 2;
const INDEX_ENTRY_BYTES = 64;
const CURSOR_ENTRY_BYTES = 160;
const EVENT_REF_BYTES = 8;

export type HistoryWindowErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "ambiguous-identity"
  | "invalid-request";

export class HistoryWindowError extends Error {
  constructor(readonly reason: HistoryWindowErrorReason) {
    super(reason);
  }
}

export interface HistoryAnchor {
  generation: number;
  seq: number;
}

export interface HistoryCursorHandle {
  cursor?: string;
  hasMore: boolean;
}

export interface HistoryChunkRequest {
  scopeKey: string;
  cursor: string;
  minItems: number;
}

export interface HistoryChunkCoverage {
  returnedCount: number;
  remainingOlderCount: number;
  oldestReached: boolean;
  snapExtendedBy: number;
}

export interface HistoryChunkPage {
  items: NormalizedEvent[];
  nextCursor?: string;
  hasMore: boolean;
  coverage: HistoryChunkCoverage;
}

export interface HistoryWindowStats {
  scopes: number;
  events: number;
  indexEntries: number;
  cursors: number;
  estimatedBytes: number;
}

interface Registration {
  events: readonly NormalizedEvent[];
  index: Map<string, number>;
  identityBytes: number;
}

const store = createScopedCursors<Registration, string>(HISTORY_CURSOR_MAX, () => new HistoryWindowError("history-unavailable"));

function eventIdentity(anchor: HistoryAnchor): string {
  return `${anchor.generation}:${anchor.seq}`;
}

export function registerHistoryWindow(
  scopeKey: string,
  events: readonly NormalizedEvent[],
  scopeMax: number
): void {
  const index = new Map<string, number>();
  let identityBytes = 0;
  for (let i = 0; i < events.length; i++) {
    const key = eventIdentity(events[i]);
    if (index.has(key)) throw new HistoryWindowError("ambiguous-identity");
    index.set(key, i);
    identityBytes += key.length * IDENTITY_CHAR_BYTES;
  }
  store.register(scopeKey, { events: events.slice(), index, identityBytes }, scopeMax);
}

export function releaseHistoryWindow(scopeKey: string): void {
  store.release(scopeKey);
}

export function hasHistoryWindow(scopeKey: string): boolean {
  return store.has(scopeKey);
}

export function historyWindowFingerprint(events: readonly NormalizedEvent[]): string {
  if (events.length === 0) return "0";
  return `${events.length}:${eventIdentity(events[0])}:${eventIdentity(events[events.length - 1])}`;
}

export function cursorForAnchor(scopeKey: string, anchor: HistoryAnchor): HistoryCursorHandle {
  const reg = store.touch(scopeKey);
  const key = eventIdentity(anchor);
  const at = reg.index.get(key);
  if (at === undefined) throw new HistoryWindowError("unknown-anchor");
  if (at === 0) return { hasMore: false };
  return { cursor: store.cursorFor(scopeKey, key), hasMore: true };
}

export function nextHistoryChunk(request: HistoryChunkRequest): HistoryChunkPage {
  const { scopeKey, cursor, minItems } = request;
  if (!Number.isInteger(minItems) || minItems < 1) throw new HistoryWindowError("invalid-request");
  const reg = store.touch(scopeKey);
  const state = store.cursorAt(cursor);
  if (state === undefined || state.scopeKey !== scopeKey) throw new HistoryWindowError("invalid-cursor");
  const anchorIndex = reg.index.get(state.position);
  if (anchorIndex === undefined) throw new HistoryWindowError("invalid-cursor");
  if (anchorIndex === 0) {
    return {
      items: [],
      hasMore: false,
      coverage: { returnedCount: 0, remainingOlderCount: 0, oldestReached: true, snapExtendedBy: 0 },
    };
  }
  const minIndex = Math.max(0, anchorIndex - minItems);
  const start = snapChunkStart(reg, minIndex);
  const items = reg.events.slice(start, anchorIndex);
  const hasMore = start > 0;
  const nextCursor = hasMore ? store.cursorFor(scopeKey, eventIdentity(reg.events[start])) : undefined;
  return {
    items,
    nextCursor,
    hasMore,
    coverage: {
      returnedCount: items.length,
      remainingOlderCount: start,
      oldestReached: !hasMore,
      snapExtendedBy: minIndex - start,
    },
  };
}

export function historyWindowStats(): HistoryWindowStats {
  let events = 0;
  let indexEntries = 0;
  let estimatedBytes = store.cursorCount() * CURSOR_ENTRY_BYTES;
  for (const reg of store.scopes.values()) {
    events += reg.events.length;
    indexEntries += reg.index.size;
    estimatedBytes +=
      reg.events.length * EVENT_REF_BYTES + reg.index.size * INDEX_ENTRY_BYTES + reg.identityBytes;
  }
  return { scopes: store.scopes.size, events, indexEntries, cursors: store.cursorCount(), estimatedBytes };
}

export function clearHistoryWindowsForTest(): void {
  store.clear();
}

function snapChunkStart(reg: Registration, minIndex: number): number {
  if (minIndex <= 0) return 0;
  const head = windowEvents(reg.events.slice(0, minIndex + 1), 1).events[0];
  const at = head === undefined ? undefined : reg.index.get(eventIdentity(head));
  return at === undefined || at > minIndex ? minIndex : at;
}
