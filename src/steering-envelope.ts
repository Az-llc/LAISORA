import type { GuardrailLevel, GuardrailSignalKind } from "./guardrail";
import { containsAbsolutePath, redactAbsolutePaths } from "./path-redaction";
import * as l10n from "@vscode/l10n";

export const STEER_TAG = "laisora-steer";
export const STEER_SCHEMA = "gs1";
export const STEER_SUPPORTED_VERSIONS: readonly string[] = ["1"];

export type SteeringMode = "steer" | "escalate" | "report";
export type SteeringLevel = 2 | 3;
export type SteeringTrigger = "auto" | "manual";

export interface SteeringSignalSummary {
  signalId: string;
  kind: GuardrailSignalKind;
  target: "root" | "delegation";
  subjectId: string;
  taskId?: string;
  count: number;
  confidence: string;
  firstAt: number;
  lastAt: number;
  lostMs?: number;
}

export interface SteeringEnvelopeBody {
  schema: "gs1";
  mode: SteeringMode;
  level: SteeringLevel;
  issuedAt: number;
  trigger: SteeringTrigger;
  decision: {
    key: string;
    signalIds: string[];
    taskId?: string;
    recommendedLevel: GuardrailLevel;
    autoLevel: GuardrailLevel;
  };
  signals: SteeringSignalSummary[];
  instruction: string;
}

export type SteeringRejectReason =
  | "no_envelope"
  | "unterminated"
  | "missing_version"
  | "unsupported_version"
  | "invalid_json"
  | "schema_mismatch"
  | "level_mode_mismatch"
  | "instruction_mismatch"
  | "trailing_content"
  | "unknown_field";

export type SteeringParseResult =
  | { ok: true; version: string; body: SteeringEnvelopeBody; raw: string }
  | { ok: false; reason: SteeringRejectReason };

export const STEER_LEVEL_BY_MODE: Record<SteeringMode, SteeringLevel> = { steer: 2, escalate: 3, report: 2 };

const OPEN_RE = new RegExp(`^<${STEER_TAG}(\\s[^>]*)?>`, "i");
const VERSION_RE = /version\s*=\s*"([^"]*)"/i;
const CLOSE_TAG = `</${STEER_TAG}>`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ROOT_KEYS = new Set(["schema", "mode", "level", "issuedAt", "trigger", "decision", "signals", "instruction"]);
const DECISION_KEYS = new Set(["key", "signalIds", "taskId", "recommendedLevel", "autoLevel"]);
const SIGNAL_KEYS = new Set(["signalId", "kind", "target", "subjectId", "taskId", "count", "confidence", "firstAt", "lastAt", "lostMs"]);
const SIGNAL_KINDS = new Set([
  "failure_loop",
  "unsupported_completion",
  "progress_stagnation",
  "declared_state_conflict",
  "stagnation",
  "output_overrun",
]);
const CONFIDENCES = new Set(["turn", "signature", "divergence", "observed"]);
const hasOnlyKeys = (r: Record<string, unknown>, allowed: Set<string>): boolean => Object.keys(r).every((k) => allowed.has(k));
const isLevel = (v: unknown): boolean => v === 0 || v === 1 || v === 2 || v === 3 || v === 4;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isOptionalString = (v: unknown): boolean => v === undefined || typeof v === "string";

function lostTimeNote(s: SteeringSignalSummary): string {
  return s.lostMs !== undefined && s.lostMs >= 60_000 ? `, about ${Math.round(s.lostMs / 60_000)} min lost` : "";
}

function describeSignals(signals: readonly SteeringSignalSummary[]): string {
  return signals
    .map((s) => `${s.kind} on ${s.subjectId} (count ${s.count}${lostTimeNote(s)})${s.taskId ? ` task ${s.taskId}` : ""}`)
    .join("; ");
}

export function steeringInstruction(mode: SteeringMode, signals: readonly SteeringSignalSummary[]): string {
  if (mode === "report") {
    const observed = signals
      .map((s) => {
        const onWhat = s.target === "root" ? "the root conversation" : s.subjectId;
        return `${s.kind} on ${onWhat} (count ${s.count}${lostTimeNote(s)})${s.taskId ? ` task ${s.taskId}` : ""}`;
      })
      .join("; ");
    return (
      `Machine-generated LAISORA report; not a human message or request. Live Guardrail observed: ${observed}. ` +
      "Judge each observation against the corresponding task or delegation result and decide, for each, whether to continue, re-delegate with changed instructions, or stop it. Do not wait for a human decision."
    );
  }
  const observed = describeSignals(signals);
  if (mode === "steer") {
    return (
      `LAISORA Live Guardrail — Level 2 (steer). Observed: ${observed}. ` +
      "Do not repeat the same failing call. Change the approach, or record the blocker with the progress tool, then continue."
    );
  }
  return (
    `LAISORA Live Guardrail — Level 3 (escalate). Observed: ${observed}. ` +
    "Stop the current line of work now. Do not start new delegations or retries. " +
    "Summarize the current state, the blocker and the options, then end your turn and wait for the human decision."
  );
}

export function buildSteeringEnvelope(body: SteeringEnvelopeBody, version = "1"): string {
  const safe = JSON.parse(JSON.stringify(body)) as SteeringEnvelopeBody;
  safe.instruction = redactAbsolutePaths(safe.instruction);
  return `<${STEER_TAG} version="${version}">\n${JSON.stringify(safe)}\n</${STEER_TAG}>`;
}

export function parseSteeringEnvelope(text: string): SteeringParseResult {
  const trimmed = text.trimStart();
  const open = OPEN_RE.exec(trimmed);
  if (!open) return { ok: false, reason: "no_envelope" };
  const closeAt = trimmed.indexOf(CLOSE_TAG, open[0].length);
  if (closeAt < 0) return { ok: false, reason: "unterminated" };
  if (trimmed.slice(closeAt + CLOSE_TAG.length).trim() !== "") return { ok: false, reason: "trailing_content" };

  const version = VERSION_RE.exec(open[1] ?? "")?.[1];
  if (version === undefined) return { ok: false, reason: "missing_version" };
  if (!STEER_SUPPORTED_VERSIONS.includes(version)) return { ok: false, reason: "unsupported_version" };

  const bodyText = trimmed.slice(open[0].length, closeAt).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(parsed) || parsed.schema !== STEER_SCHEMA) return { ok: false, reason: "schema_mismatch" };
  if (!hasOnlyKeys(parsed, ROOT_KEYS)) return { ok: false, reason: "unknown_field" };
  const mode = parsed.mode;
  const level = parsed.level;
  if ((mode !== "steer" && mode !== "escalate" && mode !== "report") || (level !== 2 && level !== 3)) {
    return { ok: false, reason: "schema_mismatch" };
  }
  if (STEER_LEVEL_BY_MODE[mode] !== level) return { ok: false, reason: "level_mode_mismatch" };
  const decision = parsed.decision;
  if (!isRecord(decision)) return { ok: false, reason: "schema_mismatch" };
  if (!hasOnlyKeys(decision, DECISION_KEYS)) return { ok: false, reason: "unknown_field" };
  if (
    typeof decision.key !== "string" ||
    decision.key === "" ||
    !Array.isArray(decision.signalIds) ||
    !decision.signalIds.every((id) => typeof id === "string" && id !== "") ||
    !isOptionalString(decision.taskId) ||
    !isLevel(decision.recommendedLevel) ||
    !isLevel(decision.autoLevel)
  ) {
    return { ok: false, reason: "schema_mismatch" };
  }
  if (!Array.isArray(parsed.signals) || typeof parsed.instruction !== "string") {
    return { ok: false, reason: "schema_mismatch" };
  }
  if ((parsed.trigger !== "auto" && parsed.trigger !== "manual") || !isFiniteNumber(parsed.issuedAt)) {
    return { ok: false, reason: "schema_mismatch" };
  }
  if (mode === "report") {
    if (parsed.signals.length < 1 || parsed.signals.length > 20) {
      return { ok: false, reason: "schema_mismatch" };
    }
    const signalIdList = parsed.signals.map((s) => (isRecord(s) && typeof s.signalId === "string" ? s.signalId : ""));
    const uniqueSignalIds = new Set(signalIdList);
    if (uniqueSignalIds.size !== signalIdList.length) {
      return { ok: false, reason: "schema_mismatch" };
    }
    const decisionSignalIds = decision.signalIds as string[];
    if (decisionSignalIds.length !== uniqueSignalIds.size) {
      return { ok: false, reason: "schema_mismatch" };
    }
    for (const id of decisionSignalIds) {
      if (!uniqueSignalIds.has(id)) {
        return { ok: false, reason: "schema_mismatch" };
      }
    }
    const expectedKey = [...decisionSignalIds].sort().join(",");
    if (decision.key !== expectedKey) {
      return { ok: false, reason: "schema_mismatch" };
    }
  }
  const decisionIds = new Set(decision.signalIds as unknown[]);
  for (const s of parsed.signals) {
    if (!isRecord(s)) return { ok: false, reason: "schema_mismatch" };
    if (!hasOnlyKeys(s, SIGNAL_KEYS)) return { ok: false, reason: "unknown_field" };
    if (
      typeof s.signalId !== "string" ||
      !decisionIds.has(s.signalId) ||
      typeof s.kind !== "string" ||
      !SIGNAL_KINDS.has(s.kind) ||
      (s.target !== "root" && s.target !== "delegation") ||
      typeof s.subjectId !== "string" ||
      s.subjectId === "" ||
      containsAbsolutePath(s.subjectId) ||
      s.target !== (s.subjectId === "root" ? "root" : "delegation") ||
      (s.taskId !== undefined && (typeof s.taskId !== "string" || s.taskId === "" || containsAbsolutePath(s.taskId))) ||
      !isFiniteNumber(s.count) ||
      !Number.isInteger(s.count) ||
      s.count < 0 ||
      typeof s.confidence !== "string" ||
      !CONFIDENCES.has(s.confidence) ||
      !isFiniteNumber(s.firstAt) ||
      !isFiniteNumber(s.lastAt) ||
      (s.lostMs !== undefined && (!isFiniteNumber(s.lostMs) || s.lostMs < 0))
    ) {
      return { ok: false, reason: "schema_mismatch" };
    }
  }
  const body = parsed as unknown as SteeringEnvelopeBody;
  if (body.instruction !== steeringInstruction(mode, body.signals)) return { ok: false, reason: "instruction_mismatch" };
  return { ok: true, version, raw: trimmed.slice(0, closeAt + CLOSE_TAG.length), body };
}

export type SteeringSendRejectReason =
  | "closed"
  | "interrupting"
  | "not_running"
  | "invalid_envelope"
  | "redaction";

export type SteeringAdmission =
  | { ok: true }
  | { ok: false; reason: SteeringSendRejectReason; message: string; transient: boolean };

export function admitSteeringSend(
  state: { closed: boolean; turnState: "idle" | "running" | "interrupting" },
  envelopeText: string,
  checkRedaction: (text: string) => { ok: true } | { ok: false; violations: { field: string }[] }
): SteeringAdmission {
  if (state.closed) {
    return { ok: false, reason: "closed", message: l10n.t("The conversation has ended. Steering cannot be submitted."), transient: true };
  }
  if (state.turnState === "interrupting") {
    return { ok: false, reason: "interrupting", message: l10n.t("Interrupt in progress. Steering cannot be submitted."), transient: true };
  }
  if (state.turnState !== "running") {
    return {
      ok: false,
      reason: "not_running",
      message: l10n.t("No turn is running (steering can only be submitted while a turn is running)."),
      transient: true,
    };
  }
  const parsed = parseSteeringEnvelope(envelopeText);
  if (!parsed.ok) {
    return { ok: false, reason: "invalid_envelope", message: l10n.t("Invalid steering envelope ({0}).", parsed.reason), transient: false };
  }
  const redaction = checkRedaction(envelopeText);
  if (!redaction.ok) {
    return {
      ok: false,
      reason: "redaction",
      message: l10n.t("Steering aborted (Host-only values included: {0})", redaction.violations.map((v) => v.field).join(", ")),
      transient: false,
    };
  }
  return { ok: true };
}

export function admitReportSend(
  state: { closed: boolean; turnState: "idle" | "running" | "interrupting" },
  envelopeText: string,
  checkRedaction: (text: string) => { ok: true } | { ok: false; violations: { field: string }[] }
): SteeringAdmission {
  if (state.closed) {
    return { ok: false, reason: "closed", message: l10n.t("The conversation has ended. A report cannot be submitted."), transient: true };
  }
  if (state.turnState === "interrupting") {
    return { ok: false, reason: "interrupting", message: l10n.t("Interrupt in progress. A report cannot be submitted."), transient: true };
  }
  const parsed = parseSteeringEnvelope(envelopeText);
  if (!parsed.ok) {
    return { ok: false, reason: "invalid_envelope", message: l10n.t("Invalid report envelope ({0}).", parsed.reason), transient: false };
  }
  if (parsed.body.mode !== "report") {
    return { ok: false, reason: "invalid_envelope", message: l10n.t("Modes other than report cannot be sent with admitReportSend."), transient: false };
  }
  const redaction = checkRedaction(envelopeText);
  if (!redaction.ok) {
    return {
      ok: false,
      reason: "redaction",
      message: l10n.t("Report aborted (Host-only values included: {0})", redaction.violations.map((v) => v.field).join(", ")),
      transient: false,
    };
  }
  return { ok: true };
}
