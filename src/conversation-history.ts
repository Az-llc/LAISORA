import { holdsAskAnswerLine } from "./ask-parser";
import { askBlocksIn } from "./markdown-ast";
import type { ImageRefInfo, RestoredApprovalCard } from "./protocol";
import { surrogateSafeEnd } from "./text-clip";
import { createScopedCursors } from "./scoped-cursors";

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

export interface ConversationMessage {
  uuid: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  imageRefs?: ImageRefInfo[];
  model?: string;
  restoredApproval?: RestoredApprovalCard;
  remote?: true;
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

const store = createScopedCursors<Registration, number>(CONVERSATION_CURSOR_MAX, () => new ConversationHistoryError("history-unavailable"));

export function registerConversationHistory(
  scopeKey: string,
  messages: readonly ConversationMessage[],
  scopeMax: number
): void {
  let bytes = 0;
  for (const m of messages) bytes += m.text.length * 2 + m.uuid.length * 2 + 32 + (m.imageRefs ? m.imageRefs.length * 80 : 0) + (m.model ? m.model.length * 2 : 0) + (m.restoredApproval ? JSON.stringify(m.restoredApproval).length * 2 : 0);
  store.register(scopeKey, { messages: messages.slice(), bytes }, scopeMax);
}

export function releaseConversationHistory(scopeKey: string): void {
  store.release(scopeKey);
}

export function hasConversationHistory(scopeKey: string): boolean {
  return store.has(scopeKey);
}

export function conversationCursorBeforeUuid(scopeKey: string, uuid: string): string | undefined {
  return conversationCursorBeforeAnyUuid(scopeKey, [uuid]);
}

export function conversationCursorBeforeAnyUuid(scopeKey: string, uuids: readonly string[]): string | undefined {
  const found = firstKnownAnchorIndex(scopeKey, uuids);
  return found === 0 ? undefined : store.cursorFor(scopeKey, found);
}

export function conversationCursorThroughAnyUuid(scopeKey: string, uuids: readonly string[]): string {
  return store.cursorFor(scopeKey, firstKnownAnchorIndex(scopeKey, uuids) + 1);
}

function firstKnownAnchorIndex(scopeKey: string, uuids: readonly string[]): number {
  const reg = store.touch(scopeKey);
  if (uuids.length === 0) throw new ConversationHistoryError("invalid-request");
  const at = new Map<string, number>();
  for (let i = 0; i < reg.messages.length; i++) at.set(reg.messages[i].uuid, i);
  for (const uuid of uuids) {
    if (typeof uuid !== "string" || uuid.length === 0) continue;
    const found = at.get(uuid);
    if (found !== undefined) return found;
  }
  throw new ConversationHistoryError("unknown-anchor");
}

export function clipConversationText<T extends { text: string }>(m: T, limit: number): T & { clipped?: true } {
  if (m.text.length <= limit) return m;
  return { ...m, text: m.text.slice(0, surrogateSafeEnd(m.text, limit)), clipped: true };
}

export function clipConversationMessage<T extends { role: "user" | "assistant" | "system"; text: string }>(
  m: T,
  limit: number
): T & { clipped?: true; asksPastCut?: true } {
  const cut = clipConversationText(m, limit);
  if (!cut.clipped) return cut;
  const asksPastCut = m.role === "user" ? holdsAskAnswerLine(m.text.slice(m.text.lastIndexOf("\n", cut.text.length - 1) + 1))
    : m.role === "assistant" && JSON.stringify(askBlocksIn(m.text)) !== JSON.stringify(askBlocksIn(cut.text));
  return asksPastCut ? { ...cut, asksPastCut: true } : cut;
}

export function conversationMessageByUuid(scopeKey: string, uuid: string): ConversationMessage | undefined {
  return store.touch(scopeKey).messages.find((m) => m.uuid === uuid);
}

export function nextConversationChunk(request: ConversationChunkRequest): ConversationChunkPage {
  const { scopeKey, cursor, maxItems } = request;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new ConversationHistoryError("invalid-request");
  }
  const reg = store.touch(scopeKey);
  const state = store.cursorAt(cursor);
  if (state === undefined || state.scopeKey !== scopeKey) {
    throw new ConversationHistoryError("invalid-cursor");
  }
  const end = Math.min(state.position, reg.messages.length);
  const start = Math.max(0, end - maxItems);
  const items = reg.messages.slice(start, end);
  const hasMore = start > 0;
  return {
    items,
    nextCursor: hasMore ? store.cursorFor(scopeKey, start) : undefined,
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
  let estimatedBytes = store.cursorCount() * CURSOR_ENTRY_BYTES;
  for (const reg of store.scopes.values()) {
    messages += reg.messages.length;
    estimatedBytes += reg.bytes;
  }
  return { scopes: store.scopes.size, messages, cursors: store.cursorCount(), estimatedBytes };
}

export function clearConversationHistoryForTest(): void {
  store.clear();
}
