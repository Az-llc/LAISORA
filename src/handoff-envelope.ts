import { ENVELOPE_PREAMBLE, WORK_MEMO_PREAMBLE } from "./handoff-accept";
import { isImageRefInfo, isIsoTimestamp, type ImageRefInfo } from "./protocol";
import { memoUpdatedAt, WORK_MEMO_SECTIONS, type TodoItem, type WorkMemoSection } from "./todo-model";
export { isHandoffContextUsage } from "./protocol";

export const HANDOFF_TAG = "laisora-handoff";
export const HANDOFF_SUPPORTED_VERSIONS: readonly string[] = ["2"];
export const HANDOFF_SCHEMA_V2 = "hb2";

export type HandoffRejectReason =
  | "no_envelope"
  | "unterminated"
  | "missing_version"
  | "unsupported_version"
  | "invalid_json"
  | "schema_mismatch";

export interface HandoffUtterance {
  n: number;
  at: string;
  kind: "typed" | "answer";
  text: string;
  questions?: string[];
  imageRefs?: ImageRefInfo[];
}

export interface HandoffEnvelopeV2 {
  schema: "hb2";
  preamble: string;
  snapshot: {
    sourceSessionId: string;
    forkSessionId: string;
    capturedAt: string;
    compact?: HandoffCompactStats;
  };
  userUtterances: HandoffUtterance[];
  workMemo?: HandoffWorkMemo;
}

export interface HandoffWorkMemo {
  preamble: string;
  item: { id: string; title: string };
  updatedAt: string;
  sections: Partial<Record<WorkMemoSection, string>>;
}

export function handoffWorkMemoOf(item: Pick<TodoItem, "id" | "title" | "workMemo">): HandoffWorkMemo | undefined {
  const updatedAt = memoUpdatedAt(item);
  if (updatedAt === undefined) return undefined;
  const sections = Object.fromEntries(WORK_MEMO_SECTIONS.flatMap(section => {
    const text = item.workMemo[section]?.text;
    return text ? [[section, text]] : [];
  })) as HandoffWorkMemo["sections"];
  if (Object.keys(sections).length === 0) return undefined;
  return { preamble: WORK_MEMO_PREAMBLE, item: { id: item.id, title: item.title }, updatedAt: new Date(updatedAt).toISOString(), sections };
}

function parseWorkMemo(value: unknown): HandoffWorkMemo | undefined {
  if (!isRecord(value) || typeof value.preamble !== "string" || !isRecord(value.item) || !isIsoTimestamp(value.updatedAt) || !isRecord(value.sections)) return undefined;
  const { id, title } = value.item;
  if (typeof id !== "string" || id.length === 0 || typeof title !== "string") return undefined;
  const entries = Object.entries(value.sections);
  if (!entries.every(([section, text]) => (WORK_MEMO_SECTIONS as readonly string[]).includes(section) && typeof text === "string")) return undefined;
  return { preamble: value.preamble, item: { id, title }, updatedAt: value.updatedAt as string, sections: Object.fromEntries(entries) as HandoffWorkMemo["sections"] };
}

export type { HandoffContextMeasurement, HandoffContextUsage } from "./protocol";

export interface HandoffCompactStats {
  preTokens?: number;
  postTokens?: number;
  retainedResponseCount?: number;
}

export type HandoffParseResult =
  | { ok: true; version: "2"; envelope: HandoffEnvelopeV2; raw: string; imageRefsDropped?: true; workMemoDropped?: true; singleGeneration?: true }
  | { ok: false; reason: HandoffRejectReason };

const OPEN_RE = new RegExp(`^<${HANDOFF_TAG}(\\s[^>]*)?>`, "i");
const VERSION_RE = /version\s*=\s*"([^"]*)"/i;
const CLOSE_TAG = `</${HANDOFF_TAG}>`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseCompactMetadata(value: unknown): HandoffCompactStats | undefined {
  if (!isRecord(value)) return undefined;
  const tokens = nonNegativeFinite(value.preTokens) && nonNegativeFinite(value.postTokens)
    ? { preTokens: value.preTokens, postTokens: value.postTokens } : {};
  const retained = typeof value.retainedResponseCount === "number" &&
    Number.isSafeInteger(value.retainedResponseCount) && value.retainedResponseCount >= 2
    ? { retainedResponseCount: value.retainedResponseCount } : {};
  const compact: HandoffCompactStats = { ...tokens, ...retained };
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function parseV2(parsed: Record<string, unknown>, raw: string): HandoffParseResult {
  if (parsed.schema !== HANDOFF_SCHEMA_V2 || parsed.preamble !== ENVELOPE_PREAMBLE) {
    return { ok: false, reason: "schema_mismatch" };
  }
  const snapshot = parsed.snapshot;
  if (
    !isRecord(snapshot) ||
    typeof snapshot.sourceSessionId !== "string" ||
    snapshot.sourceSessionId.length === 0 ||
    typeof snapshot.forkSessionId !== "string" ||
    snapshot.forkSessionId.length === 0 ||
    !isIsoTimestamp(snapshot.capturedAt)
  ) {
    return { ok: false, reason: "schema_mismatch" };
  }

  if (!Array.isArray(parsed.userUtterances)) return { ok: false, reason: "schema_mismatch" };
  const utterances: HandoffUtterance[] = [];
  let imageRefsDropped = false;
  let singleGeneration = false;
  for (let i = 0; i < parsed.userUtterances.length; i++) {
    const value = parsed.userUtterances[i];
    if (
      !isRecord(value) ||
      (value.n !== undefined && value.n !== i + 1) ||
      typeof value.at !== "string" ||
      (value.kind !== undefined && value.kind !== "typed" && value.kind !== "answer") ||
      typeof value.text !== "string" ||
      (value.questions !== undefined &&
        (!Array.isArray(value.questions) || !value.questions.every((question) => typeof question === "string")))
    ) {
      return { ok: false, reason: "schema_mismatch" };
    }
    if (value.n !== undefined) singleGeneration = true;
    const rawImageRefs = value.imageRefs;
    const rawImageRefsArray = Array.isArray(rawImageRefs) ? rawImageRefs : undefined;
    const validImageRefs = rawImageRefsArray?.filter(isImageRefInfo);
    if (rawImageRefs !== undefined &&
      (validImageRefs === undefined || validImageRefs.length !== rawImageRefsArray?.length)) imageRefsDropped = true;
    utterances.push({
      n: i + 1,
      at: value.at,
      kind: value.kind === "answer" ? "answer" : "typed",
      text: value.text,
      ...(value.questions !== undefined ? { questions: value.questions as string[] } : {}),
      ...(validImageRefs !== undefined && (validImageRefs.length > 0 || rawImageRefsArray?.length === 0)
        ? { imageRefs: validImageRefs } : {}),
    });
  }

  const workMemo = parsed.workMemo === undefined ? undefined : parseWorkMemo(parsed.workMemo);
  const compact = parseCompactMetadata(snapshot.compact);

  return {
    ok: true,
    version: "2",
    ...(parsed.workMemo !== undefined && workMemo === undefined ? { workMemoDropped: true as const } : {}),
    ...(imageRefsDropped ? { imageRefsDropped: true as const } : {}),
    ...(singleGeneration ? { singleGeneration: true as const } : {}),
    raw,
    envelope: {
      schema: HANDOFF_SCHEMA_V2,
      preamble: ENVELOPE_PREAMBLE,
      snapshot: {
        sourceSessionId: snapshot.sourceSessionId,
        forkSessionId: snapshot.forkSessionId,
        capturedAt: snapshot.capturedAt,
        ...(compact !== undefined ? { compact } : {}),
      },
      userUtterances: utterances,
      ...(workMemo !== undefined ? { workMemo } : {}),
    },
  };
}

export function parseHandoffEnvelope(text: string): HandoffParseResult {
  const trimmed = text.trimStart();
  const open = OPEN_RE.exec(trimmed);
  if (!open) return { ok: false, reason: "no_envelope" };
  const closeAt = trimmed.indexOf(CLOSE_TAG, open[0].length);
  if (closeAt < 0) return { ok: false, reason: "unterminated" };

  const version = VERSION_RE.exec(open[1] ?? "")?.[1];
  if (version === undefined) return { ok: false, reason: "missing_version" };
  if (!HANDOFF_SUPPORTED_VERSIONS.includes(version)) return { ok: false, reason: "unsupported_version" };

  const body = trimmed.slice(open[0].length, closeAt).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "schema_mismatch" };
  const raw = trimmed.slice(0, closeAt + CLOSE_TAG.length);
  return parseV2(parsed, raw);
}

function wireUtterance({ n: _n, kind, at, text, ...rest }: HandoffUtterance): Record<string, unknown> {
  return { at, ...(kind === "typed" ? {} : { kind }), text, ...rest };
}

export function handoffUtteranceAt(at: string): string {
  if (!isIsoTimestamp(at)) return at;
  const date = new Date(at);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function buildHandoffEnvelopeV2(env: HandoffEnvelopeV2): string {
  const body = JSON.stringify({ ...env, userUtterances: env.userUtterances.map(wireUtterance) }).replace(/</g, "\\u003c");
  return `<${HANDOFF_TAG} version="2">\n${body}\n</${HANDOFF_TAG}>`;
}

export function handoffContextUsageKey(sessionId: string): string {
  return "laisora.handoff.contextUsage." + sessionId;
}

export function handoffUnreadableLinesKey(sessionId: string): string {
  return "laisora.handoff.unreadableLines." + sessionId;
}

export function restoredHandoffUnreadableLineCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
