import { ENVELOPE_PREAMBLE } from "./handoff-accept";
import { isImageRefInfo, isIsoTimestamp, type HandoffDecisionCounts, type ImageRefInfo } from "./protocol";
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

export type HandoffDecisionTag = "GOAL" | "KILLED" | "DECIDED" | "DROPPED";

export interface HandoffDecisionEntry {
  id: string;
  t: HandoffDecisionTag;
  g: number;
  s: string;
}

export interface HandoffDecisions {
  preamble: string;
  entries: HandoffDecisionEntry[];
  removedLastGen?: HandoffDecisionEntry[];
  nextId?: number;
  carried: number;
  extracted: number;
  removed: number;
  unknownIdRefs: number;
  source: "hook" | "previous_only";
  warn?: { entries: number; bytes: number };
}

export function handoffDecisionLineCount(decisions: HandoffDecisions): number {
  return decisions.entries.length + (decisions.removedLastGen?.length ?? 0);
}

export function handoffDecisionCounts(decisions: HandoffDecisions): HandoffDecisionCounts {
  return {
    total: decisions.entries.length,
    carried: decisions.carried,
    extracted: decisions.extracted,
    removed: decisions.removed,
    unknownIdRefs: decisions.unknownIdRefs,
    ...(decisions.warn !== undefined ? { warn: decisions.warn } : {}),
  };
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
  decisions?: HandoffDecisions;
}

export type { HandoffContextMeasurement, HandoffContextUsage } from "./protocol";

export interface HandoffCompactStats {
  preTokens?: number;
  postTokens?: number;
  retainedResponseCount?: number;
}

export type HandoffParseResult =
  | { ok: true; version: "2"; envelope: HandoffEnvelopeV2; raw: string; decisionsDropped?: true; imageRefsDropped?: true }
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

const DECISION_TAG_SET: ReadonlySet<string> = new Set(["GOAL", "KILLED", "DECIDED", "DROPPED"]);

function parseDecisionEntries(value: unknown): HandoffDecisionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HandoffDecisionEntry[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      typeof item.t !== "string" ||
      !DECISION_TAG_SET.has(item.t) ||
      typeof item.g !== "number" ||
      !Number.isInteger(item.g) ||
      item.g < 1 ||
      typeof item.s !== "string"
    ) {
      return undefined;
    }
    out.push({ id: item.id, t: item.t as HandoffDecisionTag, g: item.g, s: item.s });
  }
  return out;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseDecisions(value: unknown): HandoffDecisions | undefined {
  if (!isRecord(value) || typeof value.preamble !== "string") return undefined;
  const entries = parseDecisionEntries(value.entries);
  if (entries === undefined) return undefined;
  const removedLastGen = value.removedLastGen === undefined ? undefined : parseDecisionEntries(value.removedLastGen);
  if (value.removedLastGen !== undefined && removedLastGen === undefined) return undefined;
  const carried = nonNegativeInt(value.carried);
  const extracted = nonNegativeInt(value.extracted);
  const removed = nonNegativeInt(value.removed);
  const unknownIdRefs = nonNegativeInt(value.unknownIdRefs);
  if (carried === undefined || extracted === undefined || removed === undefined || unknownIdRefs === undefined) {
    return undefined;
  }
  if (value.source !== "hook" && value.source !== "previous_only") return undefined;
  if (value.nextId !== undefined && (!Number.isInteger(value.nextId) || (value.nextId as number) < 1)) return undefined;
  let warn: { entries: number; bytes: number } | undefined;
  if (value.warn !== undefined) {
    if (!isRecord(value.warn)) return undefined;
    const warnEntries = nonNegativeInt(value.warn.entries);
    const warnBytes = nonNegativeInt(value.warn.bytes);
    if (warnEntries === undefined || warnBytes === undefined) return undefined;
    warn = { entries: warnEntries, bytes: warnBytes };
  }
  return {
    preamble: value.preamble,
    entries,
    ...(removedLastGen !== undefined ? { removedLastGen } : {}),
    ...(value.nextId !== undefined ? { nextId: value.nextId as number } : {}),
    carried,
    extracted,
    removed,
    unknownIdRefs,
    source: value.source,
    ...(warn !== undefined ? { warn } : {}),
  };
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
  for (let i = 0; i < parsed.userUtterances.length; i++) {
    const value = parsed.userUtterances[i];
    if (
      !isRecord(value) ||
      value.n !== i + 1 ||
      typeof value.at !== "string" ||
      (value.kind !== "typed" && value.kind !== "answer") ||
      typeof value.text !== "string" ||
      (value.questions !== undefined &&
        (!Array.isArray(value.questions) || !value.questions.every((question) => typeof question === "string")))
    ) {
      return { ok: false, reason: "schema_mismatch" };
    }
    const rawImageRefs = value.imageRefs;
    const rawImageRefsArray = Array.isArray(rawImageRefs) ? rawImageRefs : undefined;
    const validImageRefs = rawImageRefsArray?.filter(isImageRefInfo);
    if (rawImageRefs !== undefined &&
      (validImageRefs === undefined || validImageRefs.length !== rawImageRefsArray?.length)) imageRefsDropped = true;
    utterances.push({
      n: value.n,
      at: value.at,
      kind: value.kind,
      text: value.text,
      ...(value.questions !== undefined ? { questions: value.questions as string[] } : {}),
      ...(validImageRefs !== undefined && (validImageRefs.length > 0 || rawImageRefsArray?.length === 0)
        ? { imageRefs: validImageRefs } : {}),
    });
  }

  const decisions = parsed.decisions === undefined ? undefined : parseDecisions(parsed.decisions);
  const compact = parseCompactMetadata(snapshot.compact);

  return {
    ok: true,
    version: "2",
    ...(parsed.decisions !== undefined && decisions === undefined ? { decisionsDropped: true as const } : {}),
    ...(imageRefsDropped ? { imageRefsDropped: true as const } : {}),
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
      ...(decisions !== undefined ? { decisions } : {}),
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

export function buildHandoffEnvelopeV2(env: HandoffEnvelopeV2): string {
  const body = JSON.stringify(env).replace(/</g, "\\u003c");
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
