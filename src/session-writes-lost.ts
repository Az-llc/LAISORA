import { withOldestEvicted } from "./capped-record";

export const WRITES_LOST_NOTICE_SETTING_KEY = "claude.writesLostNotice";

export function writesLostNoticeEnabled(get: (key: typeof WRITES_LOST_NOTICE_SETTING_KEY) => unknown): boolean {
  return get(WRITES_LOST_NOTICE_SETTING_KEY) !== false;
}

export const WRITES_LOST_KINDS = ["transcript", "global_config"] as const;
export type WritesLostKind = (typeof WRITES_LOST_KINDS)[number];

export interface WritesLostShown {
  errorCode: string;
  lost: WritesLostKind[];
}

export interface SessionWritesLost extends WritesLostShown {
  transcriptSessionIds?: string[];
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{0,40}$/;

export function isWritesLostKind(value: unknown): value is WritesLostKind {
  return (WRITES_LOST_KINDS as readonly unknown[]).includes(value);
}

export function isWritesLostErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE_RE.test(value);
}

export function isWritesLostSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function sessionWritesLostOf(record: Record<string, unknown>): SessionWritesLost | undefined {
  if (record.type !== "system" || record.subtype !== "session_writes_lost" || !Array.isArray(record.lost)) return undefined;
  const lost = WRITES_LOST_KINDS.filter((kind) => (record.lost as unknown[]).includes(kind));
  if (lost.length === 0) return undefined;
  const errorCode = isWritesLostErrorCode(record.error_code) ? record.error_code : "";
  const ids = lost.includes("transcript") && Array.isArray(record.transcript_session_ids)
    ? [...new Set((record.transcript_session_ids as unknown[]).filter(isWritesLostSessionId))]
    : [];
  return { errorCode, lost, ...(ids.length > 0 ? { transcriptSessionIds: ids } : {}) };
}

export function shownWritesLost(loss: WritesLostShown): WritesLostShown {
  return { errorCode: loss.errorCode, lost: [...loss.lost] };
}

export type WritesLostCause = "diskFull" | "quota" | "other" | "unspecified";

export interface WritesLostNotice {
  subject: "transcript" | "globalConfig";
  cause: WritesLostCause;
  errorCode: string;
}

function causeOf(errorCode: string): WritesLostCause {
  return errorCode === "ENOSPC" ? "diskFull" : errorCode === "EDQUOT" ? "quota" : "other";
}

export function writesLostNotices(loss: WritesLostShown): WritesLostNotice[] {
  const notices: WritesLostNotice[] = [];
  const transcript = loss.lost.includes("transcript");
  if (transcript) notices.push({ subject: "transcript", cause: causeOf(loss.errorCode), errorCode: loss.errorCode });
  if (loss.lost.includes("global_config")) {
    notices.push(transcript
      ? { subject: "globalConfig", cause: "unspecified", errorCode: "" }
      : { subject: "globalConfig", cause: causeOf(loss.errorCode), errorCode: loss.errorCode });
  }
  return notices;
}

export const WRITES_LOST_MARKS_KEY = "history.writesLostMarks";
export const WRITES_LOST_MARKS_MAX = 200;

export interface WritesLostMark {
  errorCode: string;
  at: number;
}

export interface WritesLostMarkState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

function isWritesLostMark(value: unknown): value is WritesLostMark {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const mark = value as Record<string, unknown>;
  return isWritesLostErrorCode(mark.errorCode) && typeof mark.at === "number" && Number.isFinite(mark.at);
}

function storedMarks(stored: unknown): Record<string, WritesLostMark> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const marks: Record<string, WritesLostMark> = {};
  for (const [id, mark] of Object.entries(stored as Record<string, unknown>)) {
    if (isWritesLostSessionId(id) && isWritesLostMark(mark)) marks[id] = { errorCode: mark.errorCode, at: mark.at };
  }
  return marks;
}

export function withWritesLostMarks(stored: unknown, loss: SessionWritesLost, at: number): Record<string, WritesLostMark> | undefined {
  const ids = loss.lost.includes("transcript") ? loss.transcriptSessionIds ?? [] : [];
  if (ids.length === 0) return undefined;
  const mark: WritesLostMark = { errorCode: loss.errorCode, at };
  return withOldestEvicted(storedMarks(stored), ids.map((id) => [id, mark] as const), WRITES_LOST_MARKS_MAX, (m) => m.at).entries;
}

export function writesLostMarkOf(stored: unknown, sessionId: string): WritesLostMark | undefined {
  return storedMarks(stored)[sessionId];
}

export function restoredWritesLost(mark: WritesLostMark): WritesLostShown {
  return { errorCode: mark.errorCode, lost: ["transcript"] };
}

export function recordWritesLost(state: WritesLostMarkState | undefined, loss: SessionWritesLost, at: number): Promise<void> {
  if (state === undefined) return Promise.resolve();
  const next = withWritesLostMarks(state.get(WRITES_LOST_MARKS_KEY), loss, at);
  return next === undefined ? Promise.resolve() : Promise.resolve(state.update(WRITES_LOST_MARKS_KEY, next));
}

export interface WritesLostLookup {
  sessionId: string;
  markedBy?: number;
}

export function restoredWritesLostIn(state: Pick<WritesLostMarkState, "get"> | undefined, lookups: readonly WritesLostLookup[]): WritesLostShown | undefined {
  if (state === undefined) return undefined;
  const stored = state.get(WRITES_LOST_MARKS_KEY);
  for (const { sessionId, markedBy } of lookups) {
    const mark = writesLostMarkOf(stored, sessionId);
    if (mark !== undefined && (markedBy === undefined || mark.at <= markedBy)) return restoredWritesLost(mark);
  }
  return undefined;
}
