import { createHash } from "node:crypto";
import type { DivergenceReport } from "./l3-divergence";
import { progressSubjectKey } from "./progress-protocol";
import type { NormalizedEvent } from "./protocol";
import { redactAbsolutePaths } from "./path-redaction";
import type { SteeringSignalSummary } from "./steering-envelope";

export const MAX_RECENT_FINISHED = 200;
export const MAX_SIGNALS = 200;
export const MAX_APPLIED = 500;
export const MAX_EVIDENCE_TOOL_USES = 8;
export const MAX_REPORT_SIGNALS_PER_ENVELOPE = 20;
export const MAX_PENDING_REPORT_SIGNALS = 200;
export const FAILURE_LOOP_CONSECUTIVE_THRESHOLD = 3;
export const FAILURE_LOOP_SIGNATURE_THRESHOLD = 5;
export const FAILURE_LOOP_LOST_MS_THRESHOLD = 5 * 60_000;
export const FAILURE_LOOP_LOST_MIN_COUNT = 2;
export const STAGNATION_IDLE_MS = 5 * 60_000;
export const OUTPUT_OVERRUN_MESSAGE_TOKENS = 16_000;
export const OUTPUT_OVERRUN_TURN_TOKENS = 100_000;
export const HUMAN_REJECTED_TOOL_RESULT_RE =
  /^(?:The user doesn't want to proceed with this tool use\b|\[Request interrupted by user(?: for tool use)?\])/;
const USAGE_LIMIT_TOOL_RESULT_RE = /^(?:You've (?:hit|reached) your\b|You're out of (?:usage credits|extra usage)\b|Your org is out of usage \u00b7 (?:add funds to continue|contact your admin)\b|Your seat type doesn't include (?:extra usage|usage(?: credits)?)\b|Your usage allocation has been disabled by your admin\b|Your group's usage limit is set to \$0\b|Fable 5 requires usage credits\b|You have hit your limit\b|Usage limit reached\b|Rate limit reached\b)/;

export function isUsageLimitResult(text: string): boolean {
  if (USAGE_LIMIT_TOOL_RESULT_RE.test(text)) return true;
  try {
    const value = JSON.parse(text);
    const type = value?.error?.type ?? value?.type;
    return type === "rate_limit" || type === "usage_limit" || type === "rate_limit_error" || type === "usage_limit_error";
  } catch { return false; }
}

export type GuardrailSubjectId = string;

export type GuardrailSignalKind =
  | "failure_loop"
  | "unsupported_completion"
  | "progress_stagnation"
  | "declared_state_conflict"
  | "stagnation"
  | "output_overrun";

export type Pp1DivergenceKind =
  | "unsupported_completion"
  | "progress_stagnation"
  | "declared_state_conflict";

export const PP1_GUARDRAIL_KINDS: readonly Pp1DivergenceKind[] = [
  "unsupported_completion",
  "progress_stagnation",
  "declared_state_conflict",
];

export interface GuardrailSignal {
  signalId: string;
  kind: GuardrailSignalKind;
  target: "root" | "delegation";
  subjectId: GuardrailSubjectId;
  taskId?: string;
  firstAt: number;
  lastAt: number;
  count: number;
  confidence: "turn" | "signature" | "divergence" | "observed";
  evidence: {
    toolUseIds?: string[];
    divergenceId?: string;
    fingerprintHash?: string;
    idleMs?: number;
    turnId?: string;
    messageId?: string;
    outputTokens?: number;
    lostMs?: number;
  };
}

export interface GuardrailSubjectState {
  openTools: Record<string, { toolName: string; turnId: string; startedAt: number }>;
  recentFinished: {
    toolUseId: string;
    toolName: string;
    turnId: string;
    isError: boolean;
    fingerprintHash?: string;
    at: number;
    lostMs: number;
  }[];
  signatureCounts: Record<string, number>;
  signatureLostMs?: Record<string, number>;
  recoveryCounts?: {
    turnId: string;
    tools: Record<string, Record<string, number>>;
    lostMs?: Record<string, Record<string, number>>;
  };
  turnOutput?: { turnId: string; outputTokens: number };
}

export interface GuardrailAssignment {
  agentRunId: string;
  taskNodeId: string;
  startedAt: number;
  endedAt?: number;
}

export interface GuardrailState {
  specVersion: 1;
  subjects: Record<GuardrailSubjectId, GuardrailSubjectState>;
  signals: GuardrailSignal[];
  droppedSignalCount: number;
  appliedDivergenceIds: string[];
  assignments: GuardrailAssignment[];
  openTurn?: { turnId: string; startedAt: number };
}

export type GuardrailLevel = 0 | 1 | 2 | 3 | 4;

export interface GuardrailPolicy {
  autoMaxLevel: GuardrailLevel;
  levelByKind: Record<GuardrailSignalKind, GuardrailLevel>;
  composite: { kinds: GuardrailSignalKind[]; level: GuardrailLevel }[];
}

export interface GuardrailDecision {
  signalIds: string[];
  taskId?: string;
  recommendedLevel: GuardrailLevel;
  autoLevel: GuardrailLevel;
}

export type GuardrailActionKind = "warn" | "steer" | "escalate" | "interrupt";

export interface GuardrailActionOutcome {
  ok: boolean;
  message: string;
  reason?: string;
  transient?: boolean;
}

export type GuardrailTrigger = "auto" | "manual";

export interface GuardrailExecutor {
  warn(decision: GuardrailDecision, signals: GuardrailSignal[]): void;
  steer?(decision: GuardrailDecision, signals: GuardrailSignal[], trigger: GuardrailTrigger): GuardrailActionOutcome;
  escalate?(decision: GuardrailDecision, signals: GuardrailSignal[], trigger: GuardrailTrigger): GuardrailActionOutcome;
}

export const MAX_AUTO_LEVEL: GuardrailLevel = 3;

export function normalizeAutoMaxLevel(value: unknown, fallback: GuardrailLevel = 1): GuardrailLevel {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(MAX_AUTO_LEVEL, Math.max(0, Math.trunc(n)));
  return clamped as GuardrailLevel;
}

export function actionForLevel(level: GuardrailLevel): GuardrailActionKind | undefined {
  switch (level) {
    case 1:
      return "warn";
    case 2:
      return "steer";
    case 3:
      return "escalate";
    case 4:
      return "interrupt";
    default:
      return undefined;
  }
}

export function decisionKey(decision: Pick<GuardrailDecision, "signalIds">): string {
  return [...decision.signalIds].sort().join(",");
}

export type GuardrailActionLedger = Record<string, GuardrailLevel>;

export interface PlannedGuardrailAction {
  decision: GuardrailDecision;
  level: 2 | 3;
  action: "steer" | "escalate";
  signals: GuardrailSignal[];
}

export function selectAutoActions(
  decisions: readonly GuardrailDecision[],
  signals: readonly GuardrailSignal[],
  isLive: (signal: GuardrailSignal) => boolean,
  ledger: GuardrailActionLedger,
  conversationRunning: boolean
): PlannedGuardrailAction[] {
  if (!conversationRunning) return [];
  const byId = new Map(signals.map((s) => [s.signalId, s] as const));
  const out: PlannedGuardrailAction[] = [];
  let current = ledger;
  for (const decision of decisions) {
    if (decision.autoLevel < 2) continue;
    const level = Math.min(decision.autoLevel, MAX_AUTO_LEVEL) as GuardrailLevel;
    const action = actionForLevel(level);
    if (action !== "steer" && action !== "escalate") continue;
    const members = decision.signalIds.map((id) => byId.get(id)).filter((s): s is GuardrailSignal => s !== undefined);
    if (!members.some((s) => isLive(s))) continue;
    if (members.some((s) => (current[s.signalId] ?? 0) >= level)) continue;
    out.push({ decision, level: level as 2 | 3, action, signals: members });
    current = recordLedger(current, decision.signalIds, level);
  }
  return out;
}

export function touchedSignalIds(before: GuardrailState, after: GuardrailState): string[] {
  if (before === after) return [];
  const prevById = new Map(before.signals.map((s) => [s.signalId, s] as const));
  const out: string[] = [];
  for (const s of after.signals) {
    const prev = prevById.get(s.signalId);
    if (!prev || prev.lastAt !== s.lastAt || prev.count !== s.count || prev.confidence !== s.confidence) out.push(s.signalId);
  }
  return out;
}

export function recordLedger(ledger: GuardrailActionLedger, signalIds: readonly string[], level: GuardrailLevel): GuardrailActionLedger {
  const next: GuardrailActionLedger = { ...ledger };
  for (const id of signalIds) {
    if ((next[id] ?? 0) < level) next[id] = level;
  }
  return next;
}

export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  autoMaxLevel: 1,
  levelByKind: {
    failure_loop: 1,
    unsupported_completion: 1,
    progress_stagnation: 1,
    declared_state_conflict: 1,
    stagnation: 1,
    output_overrun: 1,
  },
  composite: [
    {
      kinds: ["failure_loop", "progress_stagnation"],
      level: 3,
    },
  ],
};

export type GuardrailInput =
  | { type: "event"; event: NormalizedEvent }
  | { type: "tick"; now: number; idleSince: number | undefined }
  | {
      type: "divergence";
      report: DivergenceReport;
      assignments: readonly {
        agentRunId: string;
        taskNodeId: string;
        startedAt: number;
        endedAt?: number;
      }[];
    };

export function createGuardrailState(): GuardrailState {
  return {
    specVersion: 1,
    subjects: {},
    signals: [],
    droppedSignalCount: 0,
    appliedDivergenceIds: [],
    assignments: [],
  };
}

export function clearProcessEphemeral(state: GuardrailState): GuardrailState {
  const next = structuredClone(state);
  for (const sub of Object.values(next.subjects)) {
    sub.openTools = {};
  }
  delete next.openTurn;
  return next;
}

export function computeErrorFingerprintHash(toolName: string, rawResultText?: string): string | undefined {
  const text = (rawResultText ?? "")
    .toLowerCase()
    .replace(/[a-f0-9]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  if (text.length < 8) return undefined;
  const fp = `${toolName}:${text}`;
  return createHash("sha256").update(fp).digest("hex");
}

function getOrCreateSubject(state: GuardrailState, subjectId: GuardrailSubjectId): GuardrailSubjectState {
  let sub = state.subjects[subjectId];
  if (!sub) {
    sub = {
      openTools: {},
      recentFinished: [],
      signatureCounts: {},
    };
    state.subjects[subjectId] = sub;
  }
  return sub;
}

function foldEvent(state: GuardrailState, ev: NormalizedEvent): GuardrailState {
  if (ev.kind === "tool_call_started") {
    const subjectId: GuardrailSubjectId = ev.parentToolUseId ? `agent:${ev.parentToolUseId}` : "root";
    const sub = getOrCreateSubject(state, subjectId);
    sub.openTools[ev.toolUseId] = {
      toolName: ev.toolName,
      turnId: ev.turnId,
      startedAt: ev.timestamp,
    };
    return state;
  }

  if (ev.kind === "tool_call_finished") {
    let targetSubjectId: GuardrailSubjectId | undefined;
    let toolName = "";
    let startedAt: number | undefined;
    for (const [subId, subState] of Object.entries(state.subjects)) {
      if (subState.openTools[ev.toolUseId]) {
        targetSubjectId = subId;
        toolName = subState.openTools[ev.toolUseId].toolName;
        startedAt = subState.openTools[ev.toolUseId].startedAt;
        delete subState.openTools[ev.toolUseId];
        break;
      }
    }

    if (targetSubjectId === undefined && !ev.isError) {
      for (const [subId, subState] of Object.entries(state.subjects)) {
        const previous = subState.recentFinished.find((entry) => entry.toolUseId === ev.toolUseId && entry.isError);
        if (previous) {
          targetSubjectId = subId;
          toolName = previous.toolName;
          break;
        }
      }
    }
    if (targetSubjectId === undefined) {
      return state;
    }
    const usageLimit = ev.isError && isUsageLimitResult(ev.resultPreview ?? "");
    if (usageLimit && state.subjects[`agent:${ev.toolUseId}`]) {
      discardRecoveredFailures(state, `agent:${ev.toolUseId}`, ev.turnId);
    }
    if (ev.isError && (HUMAN_REJECTED_TOOL_RESULT_RE.test(ev.resultPreview ?? "") || usageLimit)) {
      return state;
    }

    const sub = getOrCreateSubject(state, targetSubjectId);
    if (!ev.isError) {
      discardRecoveredFailures(state, targetSubjectId, ev.turnId, toolName);
    }
    let fingerprintHash: string | undefined;
    const lostMs = ev.isError && isObservedTime(startedAt) && isObservedTime(ev.timestamp) && ev.timestamp > startedAt ? ev.timestamp - startedAt : 0;
    if (ev.isError) {
      fingerprintHash = computeErrorFingerprintHash(toolName, ev.resultPreview);
      if (fingerprintHash !== undefined) {
        sub.signatureCounts[fingerprintHash] = (sub.signatureCounts[fingerprintHash] ?? 0) + 1;
        const signatureLostMs = (sub.signatureLostMs ??= {});
        signatureLostMs[fingerprintHash] = (signatureLostMs[fingerprintHash] ?? 0) + lostMs;
        if (sub.recoveryCounts?.turnId !== ev.turnId) sub.recoveryCounts = { turnId: ev.turnId, tools: {}, lostMs: {} };
        const counts = sub.recoveryCounts.tools[toolName] ??= {};
        counts[fingerprintHash] = (counts[fingerprintHash] ?? 0) + 1;
        const recoveryLost = (sub.recoveryCounts.lostMs ??= {})[toolName] ??= {};
        recoveryLost[fingerprintHash] = (recoveryLost[fingerprintHash] ?? 0) + lostMs;
      }
    }

    sub.recentFinished.push({
      toolUseId: ev.toolUseId,
      toolName,
      turnId: ev.turnId,
      isError: ev.isError,
      ...(fingerprintHash ? { fingerprintHash } : {}),
      at: ev.timestamp,
      lostMs,
    });
    if (sub.recentFinished.length > MAX_RECENT_FINISHED) {
      sub.recentFinished = sub.recentFinished.slice(-MAX_RECENT_FINISHED);
    }

    if (!ev.isError) {
      return state;
    }

    let rFl1Hit = false;
    let rFl1Confidence: "turn" | "signature" = "turn";
    let rFl1ToolName = toolName;
    let rFl1FingerprintHash = fingerprintHash;
    let rFl1FirstAt = ev.timestamp;
    let rFl1RecentToolUseIds: string[] = [];

    for (const threshold of [FAILURE_LOOP_CONSECUTIVE_THRESHOLD, FAILURE_LOOP_SIGNATURE_THRESHOLD]) {
      if (sub.recentFinished.length < threshold) continue;
      const window = sub.recentFinished.slice(-threshold);
      if (window.every((entry) => entry.isError)) {
        const firstEntry = window[0];
        const lastEntry = window[window.length - 1];
        const sameTurn = window.every((entry) => entry.turnId === firstEntry.turnId);
        const firstFp = firstEntry.fingerprintHash;
        const sameSignature =
          firstFp !== undefined && window.every((entry) => entry.fingerprintHash === firstFp);
        if ((sameTurn || sameSignature) && (threshold === FAILURE_LOOP_SIGNATURE_THRESHOLD || window.reduce((sum, entry) => sum + entry.lostMs, 0) >= FAILURE_LOOP_LOST_MS_THRESHOLD)) {
          rFl1Hit = true;
          rFl1Confidence = sameSignature ? "signature" : "turn";
          rFl1ToolName = lastEntry.toolName;
          rFl1FingerprintHash = lastEntry.fingerprintHash;
          rFl1FirstAt = firstEntry.at;
          rFl1RecentToolUseIds = window.map((entry) => entry.toolUseId);
          break;
        }
      }
    }

    const signatureCount = fingerprintHash !== undefined ? sub.signatureCounts[fingerprintHash] ?? 0 : 0;
    const signatureLostMs = fingerprintHash !== undefined ? sub.signatureLostMs?.[fingerprintHash] ?? 0 : 0;
    const timeLossHit = signatureCount >= FAILURE_LOOP_LOST_MIN_COUNT && signatureLostMs >= FAILURE_LOOP_LOST_MS_THRESHOLD;
    const rFl2Hit =
      fingerprintHash !== undefined &&
      (signatureCount >= FAILURE_LOOP_SIGNATURE_THRESHOLD || timeLossHit);
    const lostEvidence = (fp: string | undefined): { lostMs?: number } => {
      const ms = fp !== undefined ? sub.signatureLostMs?.[fp] : undefined;
      return ms !== undefined && ms > 0 ? { lostMs: ms } : {};
    };

    if (rFl1Hit) {
      const rootKey = `${targetSubjectId}|${rFl1ToolName}|${rFl1FingerprintHash ?? "unfingerprinted"}`;
      const signalId = createHash("sha256").update(rootKey).digest("hex").slice(0, 16);
      const existing = state.signals.find((s) => s.signalId === signalId);
      if (existing) {
        existing.count += 1;
        existing.lastAt = ev.timestamp;
        if (rFl2Hit || rFl1Confidence === "signature") {
          existing.confidence = "signature";
        }
        if (rFl1FingerprintHash && !existing.evidence.fingerprintHash) {
          existing.evidence.fingerprintHash = rFl1FingerprintHash;
        }
        Object.assign(existing.evidence, lostEvidence(rFl1FingerprintHash));
        if (!existing.evidence.toolUseIds) {
          existing.evidence.toolUseIds = [];
        }
        if (!existing.evidence.toolUseIds.includes(ev.toolUseId)) {
          existing.evidence.toolUseIds.push(ev.toolUseId);
          if (existing.evidence.toolUseIds.length > MAX_EVIDENCE_TOOL_USES) {
            existing.evidence.toolUseIds = existing.evidence.toolUseIds.slice(-MAX_EVIDENCE_TOOL_USES);
          }
        }
      } else {
        if (state.signals.length >= MAX_SIGNALS) {
          state.droppedSignalCount += 1;
        } else {
          state.signals.push({
            signalId,
            kind: "failure_loop",
            target: targetSubjectId === "root" ? "root" : "delegation",
            subjectId: targetSubjectId,
            firstAt: rFl1FirstAt,
            lastAt: ev.timestamp,
            count: 1,
            confidence: rFl2Hit ? "signature" : rFl1Confidence,
            evidence: {
              toolUseIds: rFl1RecentToolUseIds.slice(-MAX_EVIDENCE_TOOL_USES),
              ...(rFl1FingerprintHash ? { fingerprintHash: rFl1FingerprintHash } : {}),
              ...lostEvidence(rFl1FingerprintHash),
            },
          });
        }
      }
    } else if (rFl2Hit) {
      const rootKey = `${targetSubjectId}|${toolName}|${fingerprintHash}`;
      const signalId = createHash("sha256").update(rootKey).digest("hex").slice(0, 16);
      const existing = state.signals.find((s) => s.signalId === signalId);
      if (existing) {
        existing.count += 1;
        existing.lastAt = ev.timestamp;
        existing.confidence = "signature";
        Object.assign(existing.evidence, lostEvidence(fingerprintHash));
        if (!existing.evidence.toolUseIds) {
          existing.evidence.toolUseIds = [];
        }
        if (!existing.evidence.toolUseIds.includes(ev.toolUseId)) {
          existing.evidence.toolUseIds.push(ev.toolUseId);
          if (existing.evidence.toolUseIds.length > MAX_EVIDENCE_TOOL_USES) {
            existing.evidence.toolUseIds = existing.evidence.toolUseIds.slice(-MAX_EVIDENCE_TOOL_USES);
          }
        }
      } else {
        if (state.signals.length >= MAX_SIGNALS) {
          state.droppedSignalCount += 1;
        } else {
          state.signals.push({
            signalId,
            kind: "failure_loop",
            target: targetSubjectId === "root" ? "root" : "delegation",
            subjectId: targetSubjectId,
            firstAt: ev.timestamp,
            lastAt: ev.timestamp,
            count: 1,
            confidence: "signature",
            evidence: {
              toolUseIds: [ev.toolUseId],
              fingerprintHash,
              ...lostEvidence(fingerprintHash),
            },
          });
        }
      }
    }

    return state;
  }

  if (ev.kind === "turn_started") {
    state.openTurn = { turnId: ev.turnId, startedAt: ev.timestamp };
    const root = state.subjects["root"];
    if (root?.turnOutput && root.turnOutput.turnId !== ev.turnId) delete root.turnOutput;
    return state;
  }

  if (
    ev.kind === "turn_completed" ||
    ev.kind === "turn_interrupted" ||
    ev.kind === "turn_failed" ||
    ev.kind === "conversation_closed"
  ) {
    if (ev.kind === "turn_failed" && (ev.errorKind === "usage_limit" || isUsageLimitResult(ev.reason))) {
      for (const subjectId of Object.keys(state.subjects)) {
        discardRecoveredFailures(state, subjectId, ev.turnId);
      }
    }
    for (const sub of Object.values(state.subjects)) delete sub.recoveryCounts;
    delete state.openTurn;
    return state;
  }

  if (ev.kind === "assistant_usage") {
    if (ev.parentToolUseId !== null || typeof ev.usage.outputTokens !== "number") return state;
    const outputTokens = ev.usage.outputTokens;
    const sub = getOrCreateSubject(state, "root");
    if (!sub.turnOutput || sub.turnOutput.turnId !== ev.turnId) sub.turnOutput = { turnId: ev.turnId, outputTokens: 0 };
    sub.turnOutput.outputTokens += outputTokens;
    if (outputTokens >= OUTPUT_OVERRUN_MESSAGE_TOKENS) {
      upsertObservedSignal(state, `output_overrun|message|${ev.messageId}`, "output_overrun", ev.timestamp, ev.timestamp, 1, {
        messageId: ev.messageId,
        turnId: ev.turnId,
        outputTokens,
      });
    }
    if (sub.turnOutput.outputTokens >= OUTPUT_OVERRUN_TURN_TOKENS) {
      upsertObservedSignal(state, `output_overrun|turn|${ev.turnId}`, "output_overrun", ev.timestamp, ev.timestamp, undefined, {
        turnId: ev.turnId,
        outputTokens: sub.turnOutput.outputTokens,
      });
    }
    return state;
  }

  return state;
}

function isObservedTime(t: number | undefined): t is number {
  return typeof t === "number" && Number.isFinite(t) && t > 0;
}

function discardRecoveredFailures(state: GuardrailState, subjectId: string, turnId: string, toolName?: string): void {
  const sub = state.subjects[subjectId];
  const removed = sub.recentFinished.filter((entry) => entry.isError && entry.turnId === turnId && (toolName === undefined || entry.toolName === toolName));
  const recovery = sub.recoveryCounts;
  if (recovery?.turnId === turnId) {
    for (const [name, counts] of Object.entries(recovery.tools)) {
      if (toolName !== undefined && name !== toolName) continue;
      for (const [hash, recovered] of Object.entries(counts)) {
        const count = (sub.signatureCounts[hash] ?? 0) - recovered;
        if (count > 0) sub.signatureCounts[hash] = count;
        else delete sub.signatureCounts[hash];
        if (sub.signatureLostMs) {
          const lost = (sub.signatureLostMs[hash] ?? 0) - (recovery.lostMs?.[name]?.[hash] ?? 0);
          if (count > 0 && lost > 0) sub.signatureLostMs[hash] = lost;
          else delete sub.signatureLostMs[hash];
        }
      }
      delete recovery.tools[name];
      delete recovery.lostMs?.[name];
    }
  }
  const ids = new Set(removed.map((entry) => entry.toolUseId));
  sub.recentFinished = sub.recentFinished.filter((entry) => !ids.has(entry.toolUseId));

}

function upsertObservedSignal(
  state: GuardrailState,
  rootKey: string,
  kind: "stagnation" | "output_overrun",
  firstAt: number,
  lastAt: number,
  count: number | undefined,
  evidence: GuardrailSignal["evidence"]
): void {
  const signalId = createHash("sha256").update(rootKey).digest("hex").slice(0, 16);
  const existing = state.signals.find((s) => s.signalId === signalId);
  if (existing) {
    existing.lastAt = lastAt;
    existing.count = count ?? existing.count + 1;
    existing.evidence = { ...existing.evidence, ...evidence };
    return;
  }
  if (state.signals.length >= MAX_SIGNALS) {
    state.droppedSignalCount += 1;
    return;
  }
  state.signals.push({
    signalId,
    kind,
    target: "root",
    subjectId: "root",
    firstAt,
    lastAt,
    count: count ?? 1,
    confidence: "observed",
    evidence,
  });
}

function isSuppressedByOpenTool(state: GuardrailState): boolean {
  return Object.keys(state.subjects["root"]?.openTools ?? {}).length > 0;
}

function foldTick(state: GuardrailState, now: number, idleSince: number | undefined): GuardrailState {
  if (state.openTurn === undefined || idleSince === undefined) return state;
  const idleMs = now - idleSince;
  if (!(idleMs >= STAGNATION_IDLE_MS)) return state;
  if (isSuppressedByOpenTool(state)) return state;
  const next = structuredClone(state);
  upsertObservedSignal(
    next,
    `stagnation|${next.openTurn!.turnId}|${idleSince}`,
    "stagnation",
    idleSince,
    now,
    Math.floor(idleMs / STAGNATION_IDLE_MS),
    { idleMs, turnId: next.openTurn!.turnId }
  );
  return next;
}

function foldDivergence(
  state: GuardrailState,
  report: DivergenceReport,
  assignments: readonly {
    agentRunId: string;
    taskNodeId: string;
    startedAt: number;
    endedAt?: number;
  }[]
): GuardrailState {
  state.assignments = (assignments ?? []).map((a) => ({
    agentRunId: a.agentRunId,
    taskNodeId: a.taskNodeId,
    startedAt: a.startedAt,
    ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
  }));

  for (const kind of PP1_GUARDRAIL_KINDS) {
    const kindReport = report?.kinds?.[kind];
    if (!kindReport || kindReport.state !== "observed") continue;

    for (const record of kindReport.records ?? []) {
      if (state.appliedDivergenceIds.includes(record.divergenceId)) {
        continue;
      }

      let taskId: string | undefined;
      let subjectId: GuardrailSubjectId = "root";

      for (const sId of record.subjectIds ?? []) {
        const key = progressSubjectKey(sId);
        taskId = key;
        subjectId = `task:${key}`;
        break;
      }

      const recObs = record.observed as Record<string, unknown> | undefined;
      const recDec = record.declared as Record<string, unknown> | undefined;
      const at =
        typeof recObs?.windowEnd === "number"
          ? recObs.windowEnd
          : typeof recObs?.firstWriteAt === "number"
            ? recObs.firstWriteAt
            : typeof recObs?.at === "number"
              ? recObs.at
              : typeof recDec?.at === "number"
                ? recDec.at
                : 0;

      const rootKey = `divergence|${record.divergenceId}`;
      const signalId = createHash("sha256").update(rootKey).digest("hex").slice(0, 16);

      const existingSignal = state.signals.some((s) => s.signalId === signalId);
      if (existingSignal) {
        if (!state.appliedDivergenceIds.includes(record.divergenceId)) {
          state.appliedDivergenceIds.push(record.divergenceId);
          if (state.appliedDivergenceIds.length > MAX_APPLIED) {
            state.appliedDivergenceIds = state.appliedDivergenceIds.slice(-MAX_APPLIED);
          }
        }
        continue;
      }

      if (state.signals.length >= MAX_SIGNALS) {
        state.droppedSignalCount += 1;
        continue;
      }

      state.appliedDivergenceIds.push(record.divergenceId);
      if (state.appliedDivergenceIds.length > MAX_APPLIED) {
        state.appliedDivergenceIds = state.appliedDivergenceIds.slice(-MAX_APPLIED);
      }

      state.signals.push({
        signalId,
        kind,
        target: subjectId === "root" ? "root" : "delegation",
        subjectId,
        ...(taskId !== undefined ? { taskId } : {}),
        firstAt: at,
        lastAt: at,
        count: 1,
        confidence: "divergence",
        evidence: {
          divergenceId: record.divergenceId,
        },
      });
    }
  }

  return state;
}

const FOLDED_EVENT_KINDS: ReadonlySet<NormalizedEvent["kind"]> = new Set<NormalizedEvent["kind"]>([
  "tool_call_started",
  "tool_call_finished",
  "turn_started",
  "turn_completed",
  "turn_interrupted",
  "turn_failed",
  "conversation_closed",
  "assistant_usage",
]);

export function foldGuardrail(state: GuardrailState, input: GuardrailInput): GuardrailState {
  if (input.type === "tick") {
    return foldTick(state, input.now, input.idleSince);
  }
  if (input.type === "event" && input.event.provenance?.path === "history") {
    return state;
  }
  if (input.type === "event" && !FOLDED_EVENT_KINDS.has(input.event.kind)) {
    return state;
  }
  const next = structuredClone(state);
  if (input.type === "event") {
    return foldEvent(next, input.event);
  }
  if (input.type === "divergence") {
    return foldDivergence(next, input.report, input.assignments);
  }
  return next;
}

export function attributeSignalTaskId(state: GuardrailState, signal: GuardrailSignal): string | undefined {
  let attributedTaskId = signal.taskId;
  if (signal.kind === "failure_loop") {
    if (signal.subjectId.startsWith("agent:")) {
      const parentToolUseId = signal.subjectId.slice("agent:".length);
      const agentRunId = `agentRun:agent:${parentToolUseId}`;
      const activeAssignments = (state.assignments ?? []).filter(
        (a) =>
          a.agentRunId === agentRunId &&
          a.startedAt <= signal.lastAt &&
          (a.endedAt === undefined || signal.lastAt <= a.endedAt)
      );
      if (activeAssignments.length === 1) {
        const taskNodeId = activeAssignments[0].taskNodeId;
        attributedTaskId = progressSubjectKey(taskNodeId);
      } else {
        attributedTaskId = undefined;
      }
    } else {
      attributedTaskId = undefined;
    }
  }
  return attributedTaskId;
}

export function decideActions(
  state: GuardrailState,
  policy: GuardrailPolicy = DEFAULT_GUARDRAIL_POLICY
): GuardrailDecision[] {
  interface SignalWithAttribution {
    signal: GuardrailSignal;
    attributedTaskId?: string;
  }

  const signalsWithAttr: SignalWithAttribution[] = state.signals.map((signal) => {
    const attributedTaskId = attributeSignalTaskId(state, signal);
    return { signal, attributedTaskId };
  });

  const decisions: GuardrailDecision[] = [];
  const handledSignalIds = new Set<string>();

  const taskGroups = new Map<string, SignalWithAttribution[]>();
  for (const item of signalsWithAttr) {
    if (item.attributedTaskId !== undefined && item.attributedTaskId !== "") {
      const list = taskGroups.get(item.attributedTaskId) ?? [];
      list.push(item);
      taskGroups.set(item.attributedTaskId, list);
    }
  }

  for (const [taskId, items] of taskGroups.entries()) {
    for (const comp of policy.composite) {
      const matchingSignals: GuardrailSignal[] = [];
      let allFound = true;
      for (const requiredKind of comp.kinds) {
        const foundItem = items.find((it) => it.signal.kind === requiredKind);
        if (foundItem) {
          matchingSignals.push(foundItem.signal);
        } else {
          allFound = false;
          break;
        }
      }
      if (allFound && matchingSignals.length > 0) {
        const recommendedLevel = comp.level;
        const autoLevel = Math.min(recommendedLevel, policy.autoMaxLevel) as GuardrailLevel;
        const signalIds = matchingSignals.map((s) => s.signalId);
        for (const sid of signalIds) {
          handledSignalIds.add(sid);
        }
        decisions.push({
          signalIds,
          taskId,
          recommendedLevel,
          autoLevel,
        });
      }
    }
  }

  for (const item of signalsWithAttr) {
    if (!handledSignalIds.has(item.signal.signalId)) {
      const recommendedLevel = Math.min(
        policy.levelByKind[item.signal.kind] ?? 1,
        3
      ) as GuardrailLevel;
      const autoLevel = Math.min(recommendedLevel, policy.autoMaxLevel) as GuardrailLevel;
      decisions.push({
        signalIds: [item.signal.signalId],
        ...(item.attributedTaskId !== undefined ? { taskId: item.attributedTaskId } : {}),
        recommendedLevel,
        autoLevel,
      });
    }
  }

  return decisions;
}

export interface PlanReportBatchOutput {
  send: SteeringSignalSummary[];
  pending: string[];
  droppedPendingCount: number;
}

export function planReportBatch(
  signals: readonly GuardrailSignal[],
  liveSignalIds: ReadonlySet<string>,
  reportedSignalIds: ReadonlySet<string>,
  pendingSignalIds: readonly string[],
  state: GuardrailState,
  maxSummaries: number = MAX_REPORT_SIGNALS_PER_ENVELOPE,
  maxPending: number = MAX_PENDING_REPORT_SIGNALS
): PlanReportBatchOutput {
  const currentPending = [...pendingSignalIds];
  for (const s of signals) {
    if (liveSignalIds.has(s.signalId) && !reportedSignalIds.has(s.signalId)) {
      if (!currentPending.includes(s.signalId)) {
        currentPending.push(s.signalId);
      }
    }
  }

  const sendIds = currentPending.slice(0, maxSummaries);
  let remainingPending = currentPending.slice(maxSummaries);
  let droppedPendingCount = 0;
  if (remainingPending.length > maxPending) {
    droppedPendingCount = remainingPending.length - maxPending;
    remainingPending = remainingPending.slice(droppedPendingCount);
  }

  const signalMap = new Map<string, GuardrailSignal>();
  for (const s of signals) {
    signalMap.set(s.signalId, s);
  }
  for (const s of state.signals) {
    if (!signalMap.has(s.signalId)) {
      signalMap.set(s.signalId, s);
    }
  }

  const send: SteeringSignalSummary[] = [];
  for (const id of sendIds) {
    const s = signalMap.get(id);
    if (!s) continue;
    const attributedTaskId = attributeSignalTaskId(state, s);
    const safeSubjectId = redactAbsolutePaths(s.subjectId);
    const safeTaskId = attributedTaskId !== undefined ? redactAbsolutePaths(attributedTaskId) : undefined;
    send.push({
      signalId: s.signalId,
      kind: s.kind,
      target: s.target,
      subjectId: safeSubjectId,
      ...(safeTaskId !== undefined && safeTaskId !== "" ? { taskId: safeTaskId } : {}),
      count: s.count,
      confidence: s.confidence,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      ...(s.evidence.lostMs !== undefined ? { lostMs: s.evidence.lostMs } : {}),
    });
  }

  return {
    send,
    pending: remainingPending,
    droppedPendingCount,
  };
}

export type ReportSendOutcomeKind = "sent" | "transient" | "permanent" | "conversation_lost";

export type ReportSendOutcome =
  | ReportSendOutcomeKind
  | { kind: ReportSendOutcomeKind; reason?: string }
  | { ok: true }
  | { ok: false; transient: boolean; reason?: string };

export interface SettleReportSendOutput {
  reportedSignalIds: Set<string>;
  pendingSignalIds: string[];
  droppedPendingCount: number;
  logLine?: string;
}

export const REPORT_SEND_OUTCOME_KINDS: ReadonlySet<string> = new Set(["sent", "transient", "permanent", "conversation_lost"]);

export function classifyReportSendOutcome(result: { ok: boolean; transient?: boolean; reason?: string }): { kind: ReportSendOutcomeKind; reason?: string } {
  if (result.ok) return { kind: "sent" };
  if (result.transient === true) return { kind: "transient", reason: result.reason };
  return { kind: "permanent", reason: result.reason };
}

export function settleReportSend(
  sentSignalIds: readonly string[],
  outcome: ReportSendOutcome,
  reportedSignalIds: ReadonlySet<string>,
  pendingSignalIds: readonly string[],
  maxPending: number = MAX_PENDING_REPORT_SIGNALS
): SettleReportSendOutput {
  let outcomeKind: ReportSendOutcomeKind;
  let reason: string | undefined;

  if (typeof outcome === "string") {
    outcomeKind = outcome;
  } else if ("kind" in outcome && typeof outcome.kind === "string") {
    outcomeKind = outcome.kind;
    reason = outcome.reason;
  } else if ("ok" in outcome && outcome.ok === true) {
    outcomeKind = "sent";
  } else if ("transient" in outcome && typeof outcome.transient === "boolean") {
    outcomeKind = outcome.transient ? "transient" : "permanent";
    reason = (outcome as { reason?: string }).reason;
  } else {
    outcomeKind = "permanent";
    reason = (outcome as { reason?: string }).reason;
  }
  if (!REPORT_SEND_OUTCOME_KINDS.has(outcomeKind)) {
    throw new Error(`unknown report send outcome: ${String(outcomeKind)}`);
  }

  const nextReported = new Set(reportedSignalIds);
  let nextPending = [...pendingSignalIds];
  let droppedPendingCount = 0;
  let logLine: string | undefined;

  switch (outcomeKind) {
    case "sent": {
      for (const id of sentSignalIds) {
        nextReported.add(id);
      }
      break;
    }
    case "transient": {
      const returning = sentSignalIds.filter((id) => !nextPending.includes(id));
      nextPending = [...returning, ...nextPending];
      break;
    }
    case "permanent": {
      for (const id of sentSignalIds) {
        nextReported.add(id);
      }
      logLine = `[guardrail] report permanent failure: ${reason ?? "unknown"} (signals=${sentSignalIds.join(",")})`;
      break;
    }
    case "conversation_lost": {
      for (const id of sentSignalIds) {
        nextReported.delete(id);
      }
      const returning = sentSignalIds.filter((id) => !nextPending.includes(id));
      nextPending = [...returning, ...nextPending];
      logLine = `[guardrail] report conversation lost: returned ${sentSignalIds.length} signals to pending`;
      break;
    }
  }

  if (nextPending.length > maxPending) {
    droppedPendingCount = nextPending.length - maxPending;
    nextPending = nextPending.slice(droppedPendingCount);
  }

  return {
    reportedSignalIds: nextReported,
    pendingSignalIds: nextPending,
    droppedPendingCount,
    ...(logLine !== undefined ? { logLine } : {}),
  };
}
