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
}

export type HandoffParseResult =
  | { ok: true; version: "2"; envelope: HandoffEnvelopeV2; raw: string }
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

  return {
    ok: true,
    version: "2",
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
