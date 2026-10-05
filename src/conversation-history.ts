import { randomUUID } from "node:crypto";
import type { ImageRefInfo, RestoredApprovalCard } from "./protocol";

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

export function registerConversationHistory(
  scopeKey: string,
  messages: readonly ConversationMessage[],
  scopeMax: number
): void {
  let bytes = 0;
  for (const m of messages) bytes += m.text.length * 2 + m.uuid.length * 2 + 32 + (m.imageRefs ? m.imageRefs.length * 80 : 0) + (m.model ? m.model.length * 2 : 0) + (m.restoredApproval ? JSON.stringify(m.restoredApproval).length * 2 : 0);
  scopes.delete(scopeKey);
  scopes.set(scopeKey, { messages: messages.slice(), bytes });
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

export function conversationCursorBeforeUuid(scopeKey: string, uuid: string): string | undefined {
  return conversationCursorBeforeAnyUuid(scopeKey, [uuid]);
}

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
