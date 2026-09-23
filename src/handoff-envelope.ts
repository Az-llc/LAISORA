import { ENVELOPE_PREAMBLE } from "./handoff-accept";

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
}

export type HandoffDecisionTag = "GOAL" | "KILLED" | "DECIDED" | "DROPPED";

// 要約のタグ行を機械転記したエントリ（R-HND-11）。g は世代番号で、各世代の日時は
// その世代の封筒 snapshot.capturedAt が持つのでここには載せない
export interface HandoffDecisionEntry {
  id: string;
  t: HandoffDecisionTag;
  g: number;
  s: string;
}

export interface HandoffDecisions {
  preamble: string;
  entries: HandoffDecisionEntry[];
  // 直前の世代で [DONE] により外された行。1 世代だけ運ぶ（2 世代目で落ちる）
  removedLastGen?: HandoffDecisionEntry[];
  // 次に採番する番号。removedLastGen が落ちた後も消した id を再利用しないために封筒が運ぶ。
  // 欄を持たない封筒（この欄より前に書かれたもの）は entries と removedLastGen の最大値から復元する
  nextId?: number;
  carried: number;
  extracted: number;
  removed: number;
  unknownIdRefs: number;
  source: "hook" | "previous_only";
  warn?: { entries: number; bytes: number };
}

// 展開部に出る行の本数。消した行も本文に出るので、entries が 0 でも removedLastGen があれば
// 展開部は空にならない
export function handoffDecisionLineCount(decisions: HandoffDecisions): number {
  return decisions.entries.length + (decisions.removedLastGen?.length ?? 0);
}

export interface HandoffEnvelopeV2 {
  schema: "hb2";
  preamble: string;
  snapshot: {
    sourceSessionId: string;
    forkSessionId: string;
    capturedAt: string;
    compact?: { preTokens: number; postTokens: number };
  };
  userUtterances: HandoffUtterance[];
  decisions?: HandoffDecisions;
}

export type HandoffParseResult =
  // decisionsDropped: 封筒は受理したが `decisions` の検証に落ちて省いた。黙って転記の連鎖が
  // 切れるのを見えるようにするための印で、読み手は記録へ 1 行出す（本文は出さない）
  | { ok: true; version: "2"; envelope: HandoffEnvelopeV2; raw: string; decisionsDropped?: true }
  | { ok: false; reason: HandoffRejectReason };

const OPEN_RE = new RegExp(`^<${HANDOFF_TAG}(\\s[^>]*)?>`, "i");
const VERSION_RE = /version\s*=\s*"([^"]*)"/i;
const CLOSE_TAG = `</${HANDOFF_TAG}>`;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCompactMetadata(value: unknown): value is { preTokens: number; postTokens: number } {
  if (!isRecord(value)) return false;
  return (
    typeof value.preTokens === "number" &&
    Number.isFinite(value.preTokens) &&
    value.preTokens >= 0 &&
    typeof value.postTokens === "number" &&
    Number.isFinite(value.postTokens) &&
    value.postTokens >= 0
  );
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

// 壊れていたら `decisions` だけを落として封筒は受理する（R-HND-11）。ここで封筒ごと落とすと
// 世代境界の検出（R-HND-09）と引き継ぎ由来レコードの除外（R-HND-06）が同時に壊れる
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
    typeof snapshot.capturedAt !== "string" ||
    !ISO_8601_RE.test(snapshot.capturedAt) ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    (snapshot.compact !== undefined && !isCompactMetadata(snapshot.compact))
  ) {
    return { ok: false, reason: "schema_mismatch" };
  }

  if (!Array.isArray(parsed.userUtterances)) return { ok: false, reason: "schema_mismatch" };
  const utterances: HandoffUtterance[] = [];
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
    utterances.push({
      n: value.n,
      at: value.at,
      kind: value.kind,
      text: value.text,
      ...(value.questions !== undefined ? { questions: value.questions as string[] } : {}),
    });
  }

  const decisions = parsed.decisions === undefined ? undefined : parseDecisions(parsed.decisions);

  return {
    ok: true,
    version: "2",
    ...(parsed.decisions !== undefined && decisions === undefined ? { decisionsDropped: true as const } : {}),
    raw,
    envelope: {
      schema: HANDOFF_SCHEMA_V2,
      preamble: ENVELOPE_PREAMBLE,
      snapshot: {
        sourceSessionId: snapshot.sourceSessionId,
        forkSessionId: snapshot.forkSessionId,
        capturedAt: snapshot.capturedAt,
        ...(snapshot.compact !== undefined
          ? { compact: { preTokens: snapshot.compact.preTokens, postTokens: snapshot.compact.postTokens } }
          : {}),
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
