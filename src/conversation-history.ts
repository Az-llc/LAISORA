import { randomUUID } from "node:crypto";
import type { ImageRefInfo } from "./protocol";

// history-window.ts の兄弟。cursor 契約・token を消費しない規約は揃えるが、
// 実装は共有しない: 向こうは NormalizedEvent を turn 境界でスナップし、こちらは transcript の
// メッセージを1件単位で切る。共通化すると turn 境界の不変条件（event-window.ts の窓が
// turn_started で始まる保証）を会話側の都合で触ることになり、作業ログ側の欠陥に化ける。
// scope 上限は定数を持たず、呼び出し側が tab-limits.ts の scopeMaxForTabs から渡す。
// 会話側と作業ログ側で別々の係数を持たせない。
export const CONVERSATION_CURSOR_MAX = 512;

const CURSOR_ENTRY_BYTES = 160;

export type ConversationHistoryErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "invalid-request";

export class ConversationHistoryError extends Error {
  constructor(readonly reason: ConversationHistoryErrorReason) {
    super(reason);
  }
}

// transcript の1レコード。text は表示用の本文だけで、tool_use / tool_result は含まない
// （会話面に出ないものを運ぶと搬送量が跳ねる）。uuid はレコード固有で fork 重複の排除にも使う
export interface ConversationMessage {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  imageRefs?: ImageRefInfo[];
  model?: string;
}

export interface ConversationChunkRequest {
  scopeKey: string;
  cursor: string;
  maxItems: number;
}

export interface ConversationChunkCoverage {
  returnedCount: number;
  remainingOlderCount: number;
  oldestReached: boolean;
}

export interface ConversationChunkPage {
  items: ConversationMessage[];
  nextCursor?: string;
  hasMore: boolean;
  coverage: ConversationChunkCoverage;
}

export interface ConversationHistoryStats {
  scopes: number;
  messages: number;
  cursors: number;
  estimatedBytes: number;
}

interface Registration {
  messages: readonly ConversationMessage[];
  bytes: number;
}

interface CursorState {
  scopeKey: string;
  index: number;
}

const scopes = new Map<string, Registration>();
const cursors = new Map<string, CursorState>();
const cursorTokens = new Map<string, string>();

function dedupeKey(scopeKey: string, index: number): string {
  return `${scopeKey} ${index}`;
}

function dropCursor(token: string): void {
  const state = cursors.get(token);
  cursors.delete(token);
  if (state === undefined) return;
  const key = dedupeKey(state.scopeKey, state.index);
  if (cursorTokens.get(key) === token) cursorTokens.delete(key);
}

function dropScope(scopeKey: string): void {
  scopes.delete(scopeKey);
  for (const [token, state] of cursors) {
    if (state.scopeKey === scopeKey) dropCursor(token);
  }
}

// 登録した配列を後から書き換えると cursor が別位置を指す（欠落・重複が無言で出る）ので、
// 浅いコピーを持って切り離す
export function registerConversationHistory(
  scopeKey: string,
  messages: readonly ConversationMessage[],
  scopeMax: number
): void {
  let bytes = 0;
  for (const m of messages) bytes += m.text.length * 2 + m.uuid.length * 2 + 32 + (m.imageRefs ? m.imageRefs.length * 80 : 0) + (m.model ? m.model.length * 2 : 0);
  scopes.delete(scopeKey);
  scopes.set(scopeKey, { messages: messages.slice(), bytes });
  // scopeMax はタブ上限からの導出値。固定値へ戻すと、生きているタブのスコープを捨てる。
  // 会話側は退避されてもエラーにならず、次の要求が transcript を読み直して起点を作り直すため、
  // 遡りが無言で巻き戻って同じ発言が二度出る（R-SES-04）
  while (scopes.size > scopeMax) {
    const oldest = scopes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    dropScope(oldest);
  }
}

export function releaseConversationHistory(scopeKey: string): void {
  dropScope(scopeKey);
}

export function hasConversationHistory(scopeKey: string): boolean {
  return scopes.has(scopeKey);
}

// 画面に出ている最古メッセージの uuid から遡り始めるための cursor。
// **件数で起点を決めてはならない。** 画面へ出した側（readSessionTranscript）と
// ここへ登録する側（readConversationMessages）は別実装で、
//   - 前者は uuid 重複除去をしない / 後者はする
//   - 前者は sidechain の assistant を含む / 後者は除く
//   - 後者は uuid を持たないレコードを落とす
// ため件数が一致しない。件数を起点にすると、その差だけ会話が欠落するか重複する。
// uuid を起点にすれば、両者が同じレコードを指していることが構造的に保証される。
export function conversationCursorBeforeUuid(scopeKey: string, uuid: string): string | undefined {
  return conversationCursorBeforeAnyUuid(scopeKey, [uuid]);
}

// 候補は「画面に出ている会話メッセージの uuid」を古い順に並べたもの。先頭から順に探し、
// 最初に登録側で見つかったものの手前を起点にする。
//
// 先頭（＝画面上の最古）が見つからないことがある: 画面へ出す側と登録側は別実装で、
// uuid 重複除去・sidechain の扱い・uuid 欠落レコードの扱いが違うため集合が完全一致しない。
// そこで諦めると会話の遡りが恒久的に行き止まりになる。1つずれた位置から始めれば、
// 重なるぶんは webview の uuid 集合が弾くので**重複も欠落も出ない**。
// 1件も見つからなければ集合がまるごとずれているので unknown-anchor で落とす。
export function conversationCursorBeforeAnyUuid(
  scopeKey: string,
  uuids: readonly string[]
): string | undefined {
  const reg = touchScope(scopeKey);
  if (uuids.length === 0) throw new ConversationHistoryError("invalid-request");
  const at = new Map<string, number>();
  for (let i = 0; i < reg.messages.length; i++) at.set(reg.messages[i].uuid, i);
  for (const uuid of uuids) {
    if (typeof uuid !== "string" || uuid.length === 0) continue;
    const found = at.get(uuid);
    if (found === undefined) continue;
    if (found === 0) return undefined;
    return cursorFor(scopeKey, found);
  }
  throw new ConversationHistoryError("unknown-anchor");
}

export function nextConversationChunk(request: ConversationChunkRequest): ConversationChunkPage {
  const { scopeKey, cursor, maxItems } = request;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new ConversationHistoryError("invalid-request");
  }
  const reg = touchScope(scopeKey);
  // token は読み取りで消費しない。消費すると搬送・描画が失敗したときに同じ cursor で
  // 再要求できず prepend が行き止まりになる（history-window.ts と同じ規約）
  const state = cursors.get(cursor);
  if (state === undefined || state.scopeKey !== scopeKey) {
    throw new ConversationHistoryError("invalid-cursor");
  }
  const end = Math.min(state.index, reg.messages.length);
  const start = Math.max(0, end - maxItems);
  const items = reg.messages.slice(start, end);
  const hasMore = start > 0;
  return {
    items,
    nextCursor: hasMore ? cursorFor(scopeKey, start) : undefined,
    hasMore,
    coverage: {
      returnedCount: items.length,
      remainingOlderCount: start,
      oldestReached: !hasMore,
    },
  };
}

export function conversationHistoryStats(): ConversationHistoryStats {
  let messages = 0;
  let estimatedBytes = cursors.size * CURSOR_ENTRY_BYTES;
  for (const reg of scopes.values()) {
    messages += reg.messages.length;
    estimatedBytes += reg.bytes;
  }
  return { scopes: scopes.size, messages, cursors: cursors.size, estimatedBytes };
}

export function clearConversationHistoryForTest(): void {
  scopes.clear();
  cursors.clear();
  cursorTokens.clear();
}

function touchScope(scopeKey: string): Registration {
  const reg = scopes.get(scopeKey);
  if (reg === undefined) throw new ConversationHistoryError("history-unavailable");
  scopes.delete(scopeKey);
  scopes.set(scopeKey, reg);
  return reg;
}

function cursorFor(scopeKey: string, index: number): string {
  const key = dedupeKey(scopeKey, index);
  const existing = cursorTokens.get(key);
  if (existing !== undefined && cursors.has(existing)) return existing;
  const token = randomUUID();
  cursors.set(token, { scopeKey, index });
  cursorTokens.set(key, token);
  while (cursors.size > CONVERSATION_CURSOR_MAX) {
    const oldest = cursors.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    dropCursor(oldest);
  }
  return token;
}
