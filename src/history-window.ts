import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "./protocol";
import { windowEvents } from "./event-window";

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
  // tabId + generation。cursor を別タブ・別世代へ流用させない（agent-inspector の scopeKey と同規約）
  scopeKey: string;
  cursor: string;
  // 最低件数であって上限ではない。ここから turn 境界まで古い側へ伸びる。
  // webview からは受け取らない（protocol.ts:445「Host が発行した不透明tokenだけを往復する」）
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
  // events 本体は Host の配列を参照で持つだけなので、ここへ含めるのは参照・索引・token の増分のみ
  estimatedBytes: number;
}

interface Registration {
  events: readonly NormalizedEvent[];
  index: Map<string, number>;
  identityBytes: number;
}

interface CursorState {
  scopeKey: string;
  anchorKey: string;
}

const scopes = new Map<string, Registration>();
const cursors = new Map<string, CursorState>();
const cursorTokens = new Map<string, string>();

function eventIdentity(anchor: HistoryAnchor): string {
  return `${anchor.generation}:${anchor.seq}`;
}

function dedupeKey(scopeKey: string, anchorKey: string): string {
  return `${scopeKey} ${anchorKey}`;
}

function dropCursor(token: string): void {
  const state = cursors.get(token);
  cursors.delete(token);
  if (state === undefined) return;
  const key = dedupeKey(state.scopeKey, state.anchorKey);
  if (cursorTokens.get(key) === token) cursorTokens.delete(key);
}

function dropScope(scopeKey: string): void {
  scopes.delete(scopeKey);
  for (const [token, state] of cursors) {
    if (state.scopeKey === scopeKey) dropCursor(token);
  }
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
    // 同一識別子が2件あると cursor が別位置を指しうる。登録時点で落として fail-closed にする
    if (index.has(key)) throw new HistoryWindowError("ambiguous-identity");
    index.set(key, i);
    identityBytes += key.length * IDENTITY_CHAR_BYTES;
  }
  scopes.delete(scopeKey);
  // 索引は登録時に1度だけ作る。呼び出し側が配列を in-place で書き換えると索引が古くなり
  // cursor が別位置を指す（欠落・重複が無言で出る）。浅いコピーを持って切り離す
  scopes.set(scopeKey, { events: events.slice(), index, identityBytes });
  // scopeMax はタブ上限からの導出値。固定値へ戻すと生きているタブのスコープを捨て、
  // そのタブの遡りが history-unavailable で行き止まりになる（R-SES-04）
  while (scopes.size > scopeMax) {
    const oldest = scopes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    dropScope(oldest);
  }
}

export function releaseHistoryWindow(scopeKey: string): void {
  dropScope(scopeKey);
}

// 登録済みかを見るだけ。touchScope を通さないのは LRU 順を動かさないため（問い合わせで
// 順序が変わると、退避されるスコープが観測行為で変わる）。呼び出し側が「登録済みだから
// 再登録しない」判断に使うので、退避済みを登録済みと答えると以後そのスコープは二度と
// 登録されない
export function hasHistoryWindow(scopeKey: string): boolean {
  return scopes.has(scopeKey);
}

// 再登録が cursor を全部落とす（registerHistoryWindow → dropScope）ため、内容が同じなら
// 呼ばない、を呼び出し側が判断するための指紋。件数と両端の識別子だけで足りるのは、
// events が末尾追加でしか伸びないから（途中挿入・並べ替えは pushEvent に存在しない）
export function historyWindowFingerprint(events: readonly NormalizedEvent[]): string {
  if (events.length === 0) return "0";
  return `${events.length}:${eventIdentity(events[0])}:${eventIdentity(events[events.length - 1])}`;
}

export function cursorForAnchor(scopeKey: string, anchor: HistoryAnchor): HistoryCursorHandle {
  const reg = touchScope(scopeKey);
  const key = eventIdentity(anchor);
  const at = reg.index.get(key);
  if (at === undefined) throw new HistoryWindowError("unknown-anchor");
  if (at === 0) return { hasMore: false };
  return { cursor: cursorFor(scopeKey, key), hasMore: true };
}

export function nextHistoryChunk(request: HistoryChunkRequest): HistoryChunkPage {
  const { scopeKey, cursor, minItems } = request;
  if (!Number.isInteger(minItems) || minItems < 1) throw new HistoryWindowError("invalid-request");
  const reg = touchScope(scopeKey);
  // token は読み取りで消費しない。消費すると chunk の搬送・描画が失敗したときに同じ cursor で
  // 再要求できず prepend が行き止まりになる。agent-inspector の単回消費とはここが違う
  const state = cursors.get(cursor);
  if (state === undefined || state.scopeKey !== scopeKey) throw new HistoryWindowError("invalid-cursor");
  const anchorIndex = reg.index.get(state.anchorKey);
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
  const nextCursor = hasMore ? cursorFor(scopeKey, eventIdentity(reg.events[start])) : undefined;
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
  let estimatedBytes = cursors.size * CURSOR_ENTRY_BYTES;
  for (const reg of scopes.values()) {
    events += reg.events.length;
    indexEntries += reg.index.size;
    estimatedBytes +=
      reg.events.length * EVENT_REF_BYTES + reg.index.size * INDEX_ENTRY_BYTES + reg.identityBytes;
  }
  return { scopes: scopes.size, events, indexEntries, cursors: cursors.size, estimatedBytes };
}

export function clearHistoryWindowsForTest(): void {
  scopes.clear();
  cursors.clear();
  cursorTokens.clear();
}

function touchScope(scopeKey: string): Registration {
  const reg = scopes.get(scopeKey);
  if (reg === undefined) throw new HistoryWindowError("history-unavailable");
  scopes.delete(scopeKey);
  scopes.set(scopeKey, reg);
  return reg;
}

// windowEvents は「先頭が turn_started であるか、先頭より前に turn_started が存在しない」窓しか
// 返さない（event-window.ts:8-11）。prefix へ max=1 で当てると、その不変条件を満たす頭が1件だけ
// 返り、それが prepend 方向のスナップ位置になる。minIndex をそのまま使う形へ単純化すると窓の
// 先頭が turn_started でなくなり、tab.ts の turnId 照合が落ちて delta が全消滅する（C2-4）。
// turn 境界の規則をここへ書き写して第2実装にしないこと。
function snapChunkStart(reg: Registration, minIndex: number): number {
  if (minIndex <= 0) return 0;
  const head = windowEvents(reg.events.slice(0, minIndex + 1), 1).events[0];
  const at = head === undefined ? undefined : reg.index.get(eventIdentity(head));
  return at === undefined || at > minIndex ? minIndex : at;
}

function cursorFor(scopeKey: string, anchorKey: string): string {
  const key = dedupeKey(scopeKey, anchorKey);
  const existing = cursorTokens.get(key);
  if (existing !== undefined && cursors.has(existing)) return existing;
  const token = randomUUID();
  cursors.set(token, { scopeKey, anchorKey });
  cursorTokens.set(key, token);
  while (cursors.size > HISTORY_CURSOR_MAX) {
    const oldest = cursors.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    dropCursor(oldest);
  }
  return token;
}
