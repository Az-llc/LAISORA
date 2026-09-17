import type { ActionDestination, ActionKind } from "./llm-action-policy";
import { ACTION_DESTINATIONS, ACTION_KINDS } from "./llm-action-policy";
import * as l10n from "@vscode/l10n";

export const ANALYSIS_STORE_KEY = "laisora.analysis.artifacts.v1";
export const ANALYSIS_STORE_VERSION = 1;

export type PersistenceState = "pending" | "saved" | "rejected" | "failed";
export type PersistenceReason =
  | "schema_violation"
  | "update_error"
  | "stringify_error";

export type OwnerState =
  | { kind: "unresolved" }
  | { kind: "pinned"; ownerId: string; logicalGeneration: number; source: "resume" | "auth" }
  | { kind: "conflicted"; ownerId: string; logicalGeneration: number; reason: string };

export function formatGeneratedAtLabel(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatPersistenceLabel(
  state: PersistenceState,
  reason?: PersistenceReason | "conflicted"
): string {
  if (state === "saved") return l10n.t("Saved");
  if (state === "pending") return l10n.t("Saving");
  if (reason === "conflicted") {
    return l10n.t("This analysis will not be saved — the session identity could not be verified");
  }
  if (state === "rejected") {
    return l10n.t("This analysis will not be restored after restart — it failed the storage format check");
  }
  if (state === "failed") {
    if (reason === "stringify_error") {
      return l10n.t("This analysis will not be restored after restart — it could not be converted to the storage format");
    }
    return l10n.t("This analysis will not be restored after restart — saving failed");
  }
  return l10n.t("Saving");
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface PersistedEvidenceChip {
  alias: string;
  kind: "event" | "user" | "metric" | "divergence" | "guardrail" | "file";
  label: string;
  toolUseId?: string;
}

export interface PersistedActionFinding {
  findingId: string;
  numberLabel: string;
  title: string;
  observed: string;
  impactLabel: string;
  destination: ActionDestination;
  destinationLabel: string;
  actionKind: ActionKind;
  actionKindLabel: string;
  actionLine: string;
  steps: string[];
  target?: string;
  evidence: PersistedEvidenceChip[];
  confidence: "high" | "medium" | "low";
}

export interface PersistedFindingReport {
  specVersion: number;
  rejectedCount: number;
  slices: number;
  usage?: { inputTokens: number; outputTokens: number };
  findings: PersistedActionFinding[];
}

export interface PersistedAnalysisArtifact {
  artifactId: string;
  generatedAt: number;
  analyzedRevision: number;
  analyzedSemanticHash: string;
  analysisSdk?: "claude" | "codex";
  requestedModel: { kind: "explicit"; value: string } | { kind: "unresolved" };
  requestedEffort: { kind: "explicit"; value: EffortLevel } | { kind: "unresolved" };
  executedModels: string[] | null;
  report: PersistedFindingReport;
}

export interface AnalysisStore {
  version: 1;
  sessions: Record<string, { updatedAt: number; artifacts: PersistedAnalysisArtifact[] }>;
}

export interface AnalysisStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): Promise<void>;
  forSession?(ownerId: string): AnalysisStorage;
}

export type SaveResult =
  | { kind: "saved" }
  | { kind: "rejected"; reason: "schema_violation" }
  | { kind: "failed"; reason: "update_error" | "stringify_error" };

// Persisted history is bounded by the storage backend, not by arbitrary report cardinality or byte caps.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(rec: Record<string, unknown>, keys: string[]): boolean {
  const actualKeys = Object.keys(rec);
  if (actualKeys.length !== keys.length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(rec, k));
}

function hasAllowedKeys(rec: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const actualKeys = Object.keys(rec);
  for (const r of required) {
    if (!Object.prototype.hasOwnProperty.call(rec, r)) return false;
  }
  for (const k of actualKeys) {
    if (!required.includes(k) && !optional.includes(k)) return false;
  }
  return true;
}

function isFiniteNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v) && v >= 0;
}

function isFinitePositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v) && v > 0;
}

type DecodeCheckResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unknown_key" | "bad_type" | "bad_enum" | "too_long" | "out_of_range" };

function decodeEvidenceChip(raw: unknown): DecodeCheckResult<PersistedEvidenceChip> {
  if (!isRecord(raw)) return { ok: false, reason: "bad_type" };
  if (!hasAllowedKeys(raw, ["alias", "kind", "label"], ["toolUseId"])) {
    return { ok: false, reason: "unknown_key" };
  }
  if (typeof raw.alias !== "string" || raw.alias.length < 1) {
    return { ok: false, reason: typeof raw.alias !== "string" ? "bad_type" : "too_long" };
  }
  const allowedKinds = ["event", "user", "metric", "divergence", "guardrail", "file"];
  if (typeof raw.kind !== "string" || !allowedKinds.includes(raw.kind)) {
    return { ok: false, reason: typeof raw.kind !== "string" ? "bad_type" : "bad_enum" };
  }
  if (typeof raw.label !== "string" || raw.label.length < 1) {
    return { ok: false, reason: typeof raw.label !== "string" ? "bad_type" : "too_long" };
  }
  if (raw.toolUseId !== undefined) {
    if (typeof raw.toolUseId !== "string" || raw.toolUseId.length < 1) {
      return { ok: false, reason: typeof raw.toolUseId !== "string" ? "bad_type" : "too_long" };
    }
  }
  return {
    ok: true,
    value: {
      alias: raw.alias,
      kind: raw.kind as PersistedEvidenceChip["kind"],
      label: raw.label,
      toolUseId: raw.toolUseId,
    },
  };
}

function decodeActionFinding(raw: unknown): DecodeCheckResult<PersistedActionFinding> {
  if (!isRecord(raw)) return { ok: false, reason: "bad_type" };
  const required = [
    "findingId",
    "numberLabel",
    "title",
    "observed",
    "impactLabel",
    "destination",
    "destinationLabel",
    "actionKind",
    "actionKindLabel",
    "actionLine",
    "steps",
    "evidence",
    "confidence",
  ];
  if (!hasAllowedKeys(raw, required, ["target"])) {
    return { ok: false, reason: "unknown_key" };
  }
  if (typeof raw.findingId !== "string" || raw.findingId.length < 1) {
    return { ok: false, reason: typeof raw.findingId !== "string" ? "bad_type" : "too_long" };
  }
  for (const field of ["numberLabel", "title", "observed", "impactLabel", "destinationLabel", "actionKindLabel"]) {
    const val = raw[field];
    if (typeof val !== "string" || val.length < 1) {
      return { ok: false, reason: typeof val !== "string" ? "bad_type" : "too_long" };
    }
  }
  if (typeof raw.actionLine !== "string" || raw.actionLine.length < 1) {
    return { ok: false, reason: typeof raw.actionLine !== "string" ? "bad_type" : "too_long" };
  }
  if (raw.target !== undefined) {
    if (typeof raw.target !== "string") return { ok: false, reason: "bad_type" };
  }
  if (typeof raw.destination !== "string" || !ACTION_DESTINATIONS.includes(raw.destination as ActionDestination)) {
    return { ok: false, reason: typeof raw.destination !== "string" ? "bad_type" : "bad_enum" };
  }
  if (typeof raw.actionKind !== "string" || !ACTION_KINDS.includes(raw.actionKind as ActionKind)) {
    return { ok: false, reason: typeof raw.actionKind !== "string" ? "bad_type" : "bad_enum" };
  }
  if (!["high", "medium", "low"].includes(raw.confidence as string)) {
    return { ok: false, reason: typeof raw.confidence !== "string" ? "bad_type" : "bad_enum" };
  }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1) {
    return { ok: false, reason: !Array.isArray(raw.steps) ? "bad_type" : "too_long" };
  }
  for (const step of raw.steps) {
    if (typeof step !== "string") return { ok: false, reason: "bad_type" };
  }
  if (!Array.isArray(raw.evidence)) return { ok: false, reason: "bad_type" };
  const evidence: PersistedEvidenceChip[] = [];
  for (const ev of raw.evidence) {
    const dec = decodeEvidenceChip(ev);
    if (!dec.ok) return dec;
    evidence.push(dec.value);
  }

  return {
    ok: true,
    value: {
      findingId: raw.findingId,
      numberLabel: raw.numberLabel as string,
      title: raw.title as string,
      observed: raw.observed as string,
      impactLabel: raw.impactLabel as string,
      destination: raw.destination as ActionDestination,
      destinationLabel: raw.destinationLabel as string,
      actionKind: raw.actionKind as ActionKind,
      actionKindLabel: raw.actionKindLabel as string,
      actionLine: raw.actionLine as string,
      steps: [...raw.steps],
      target: raw.target as string | undefined,
      evidence,
      confidence: raw.confidence as "high" | "medium" | "low",
    },
  };
}

function decodeReport(raw: unknown): DecodeCheckResult<PersistedFindingReport> {
  if (!isRecord(raw)) return { ok: false, reason: "bad_type" };
  if (!hasAllowedKeys(raw, ["specVersion", "rejectedCount", "slices", "findings"], ["usage"])) {
    return { ok: false, reason: "unknown_key" };
  }
  if (!isFiniteNonNegativeInt(raw.specVersion)) return { ok: false, reason: "out_of_range" };
  if (!isFiniteNonNegativeInt(raw.rejectedCount)) return { ok: false, reason: "out_of_range" };
  if (!isFiniteNonNegativeInt(raw.slices)) return { ok: false, reason: "out_of_range" };
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  if (raw.usage !== undefined) {
    if (!isRecord(raw.usage) || !hasExactKeys(raw.usage, ["inputTokens", "outputTokens"])) {
      return { ok: false, reason: !isRecord(raw.usage) ? "bad_type" : "unknown_key" };
    }
    if (!isFiniteNonNegativeInt(raw.usage.inputTokens) || !isFiniteNonNegativeInt(raw.usage.outputTokens)) {
      return { ok: false, reason: "out_of_range" };
    }
    usage = { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens };
  }
  if (!Array.isArray(raw.findings)) return { ok: false, reason: "bad_type" };
  const findings: PersistedActionFinding[] = [];
  for (const f of raw.findings) {
    const dec = decodeActionFinding(f);
    if (!dec.ok) return dec;
    findings.push(dec.value);
  }

  return {
    ok: true,
    value: {
      specVersion: raw.specVersion,
      rejectedCount: raw.rejectedCount,
      slices: raw.slices,
      usage,
      findings,
    },
  };
}

function decodeArtifact(raw: unknown): DecodeCheckResult<PersistedAnalysisArtifact> {
  if (!isRecord(raw)) return { ok: false, reason: "bad_type" };
  const exact = [
    "artifactId",
    "generatedAt",
    "analyzedRevision",
    "analyzedSemanticHash",
    "requestedModel",
    "requestedEffort",
    "executedModels",
    "report",
  ];
  if (!hasAllowedKeys(raw, exact, ["analysisSdk"])) return { ok: false, reason: "unknown_key" };
  if (typeof raw.artifactId !== "string" || raw.artifactId.length < 1) {
    return { ok: false, reason: typeof raw.artifactId !== "string" ? "bad_type" : "too_long" };
  }
  if (!isFinitePositiveInt(raw.generatedAt)) {
    return { ok: false, reason: "out_of_range" };
  }
  if (!isFiniteNonNegativeInt(raw.analyzedRevision)) {
    return { ok: false, reason: "out_of_range" };
  }
  if (
    typeof raw.analyzedSemanticHash !== "string" ||
    raw.analyzedSemanticHash.length < 1
  ) {
    return { ok: false, reason: typeof raw.analyzedSemanticHash !== "string" ? "bad_type" : "too_long" };
  }
  if (
    raw.analysisSdk !== undefined &&
    (typeof raw.analysisSdk !== "string" || !["claude", "codex"].includes(raw.analysisSdk))
  ) {
    return { ok: false, reason: typeof raw.analysisSdk !== "string" ? "bad_type" : "bad_enum" };
  }

  // requestedModel
  if (!isRecord(raw.requestedModel)) return { ok: false, reason: "bad_type" };
  let requestedModel: PersistedAnalysisArtifact["requestedModel"];
  if (raw.requestedModel.kind === "explicit") {
    if (!hasExactKeys(raw.requestedModel, ["kind", "value"])) return { ok: false, reason: "unknown_key" };
    if (typeof raw.requestedModel.value !== "string" || raw.requestedModel.value.length < 1) {
      return { ok: false, reason: typeof raw.requestedModel.value !== "string" ? "bad_type" : "too_long" };
    }
    requestedModel = { kind: "explicit", value: raw.requestedModel.value };
  } else if (raw.requestedModel.kind === "unresolved") {
    if (!hasExactKeys(raw.requestedModel, ["kind"])) return { ok: false, reason: "unknown_key" };
    requestedModel = { kind: "unresolved" };
  } else {
    return { ok: false, reason: "bad_enum" };
  }

  // requestedEffort
  if (!isRecord(raw.requestedEffort)) return { ok: false, reason: "bad_type" };
  let requestedEffort: PersistedAnalysisArtifact["requestedEffort"];
  const effortLevels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
  if (raw.requestedEffort.kind === "explicit") {
    if (!hasExactKeys(raw.requestedEffort, ["kind", "value"])) return { ok: false, reason: "unknown_key" };
    if (typeof raw.requestedEffort.value !== "string" || !effortLevels.includes(raw.requestedEffort.value as EffortLevel)) {
      return { ok: false, reason: typeof raw.requestedEffort.value !== "string" ? "bad_type" : "bad_enum" };
    }
    requestedEffort = { kind: "explicit", value: raw.requestedEffort.value as EffortLevel };
  } else if (raw.requestedEffort.kind === "unresolved") {
    if (!hasExactKeys(raw.requestedEffort, ["kind"])) return { ok: false, reason: "unknown_key" };
    requestedEffort = { kind: "unresolved" };
  } else {
    return { ok: false, reason: "bad_enum" };
  }

  // executedModels
  let executedModels: string[] | null = null;
  if (raw.executedModels !== null) {
    if (!Array.isArray(raw.executedModels)) return { ok: false, reason: "bad_type" };
    for (const m of raw.executedModels) {
      if (typeof m !== "string" || m.length < 1) {
        return { ok: false, reason: typeof m !== "string" ? "bad_type" : "too_long" };
      }
    }
    executedModels = [...raw.executedModels];
  }

  // report
  const repDec = decodeReport(raw.report);
  if (!repDec.ok) return repDec;

  return {
    ok: true,
    value: {
      artifactId: raw.artifactId,
      generatedAt: raw.generatedAt,
      analyzedRevision: raw.analyzedRevision,
      analyzedSemanticHash: raw.analyzedSemanticHash,
      ...(raw.analysisSdk === undefined ? {} : { analysisSdk: raw.analysisSdk as "claude" | "codex" }),
      requestedModel,
      requestedEffort,
      executedModels,
      report: repDec.value,
    },
  };
}

function compareArtifactAsc(a: PersistedAnalysisArtifact, b: PersistedAnalysisArtifact): number {
  if (a.generatedAt !== b.generatedAt) {
    return a.generatedAt - b.generatedAt;
  }
  return a.artifactId.localeCompare(b.artifactId);
}

export function decodeAnalysisStore(value: unknown, log: (line: string) => void = () => {}): AnalysisStore {
  const emptyStore: AnalysisStore = { version: 1, sessions: {} };
  if (!isRecord(value)) return emptyStore;
  if (value.version !== ANALYSIS_STORE_VERSION) return emptyStore;
  if (!isRecord(value.sessions)) return emptyStore;

  let quarantinedSessions = 0;
  let quarantinedArtifacts = 0;
  const reasons: Record<string, number> = {};

  const recordReason = (code: string, count = 1) => {
    reasons[code] = (reasons[code] ?? 0) + count;
  };

  const outSessions: Record<string, { updatedAt: number; artifacts: PersistedAnalysisArtifact[] }> = {};

  for (const [sessionId, entry] of Object.entries(value.sessions)) {
    if (typeof sessionId !== "string" || sessionId.length < 1) {
      quarantinedSessions++;
      recordReason("too_long");
      continue;
    }
    if (!isRecord(entry)) {
      quarantinedSessions++;
      recordReason("bad_type");
      continue;
    }
    if (!hasExactKeys(entry, ["updatedAt", "artifacts"])) {
      quarantinedSessions++;
      recordReason("unknown_key");
      continue;
    }
    if (!isFiniteNonNegativeInt(entry.updatedAt)) {
      quarantinedSessions++;
      recordReason("out_of_range");
      continue;
    }
    if (!Array.isArray(entry.artifacts)) {
      quarantinedSessions++;
      recordReason("bad_type");
      continue;
    }

    const kept: PersistedAnalysisArtifact[] = [];
    for (const artRaw of entry.artifacts) {
      const dec = decodeArtifact(artRaw);
      if (!dec.ok) {
        quarantinedArtifacts++;
        recordReason(dec.reason);
      } else {
        kept.push(dec.value);
      }
    }

    kept.sort(compareArtifactAsc);

    if (kept.length === 0) {
      continue;
    }

    const repairedUpdatedAt = kept.reduce(
      (latest, artifact) => Math.max(latest, artifact.generatedAt),
      entry.updatedAt
    );
    outSessions[sessionId] = {
      updatedAt: repairedUpdatedAt,
      artifacts: kept,
    };
  }

  if (quarantinedSessions > 0 || quarantinedArtifacts > 0) {
    const reasonParts = Object.entries(reasons)
      .filter(([_, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    log(`[analysis-store] decode: quarantined session=${quarantinedSessions} artifact=${quarantinedArtifacts} (${reasonParts})`);
  }

  return {
    version: 1,
    sessions: outSessions,
  };
}

export function loadStore(storage: AnalysisStorage, log: (line: string) => void = () => {}): AnalysisStore {
  const raw = storage.get(ANALYSIS_STORE_KEY);
  if (raw === undefined) return { version: 1, sessions: {} };
  return decodeAnalysisStore(raw, log);
}

export function loadArtifacts(
  storage: AnalysisStorage,
  ownerId: string,
  log: (line: string) => void = () => {}
): PersistedAnalysisArtifact[] {
  const ownerStorage = storage.forSession?.(ownerId) ?? storage;
  const store = loadStore(ownerStorage, log);
  const entry = store.sessions[ownerId];
  return entry ? [...entry.artifacts] : [];
}

let serializedSaveTail: Promise<unknown> = Promise.resolve();

export function saveArtifact(
  storage: AnalysisStorage,
  candidate: PersistedAnalysisArtifact,
  ownerId: string,
  log: (line: string) => void = () => {}
): Promise<SaveResult> {
  const job = async (): Promise<SaveResult> => {
    const ownerStorage = storage.forSession?.(ownerId) ?? storage;
    // 1. candidate preflight
    let s: string;
    try {
      s = JSON.stringify(candidate);
    } catch {
      return { kind: "failed", reason: "stringify_error" };
    }
    const roundTrip = decodeArtifact(JSON.parse(s));
    if (!roundTrip.ok) {
      log(`[analysis-store] candidate rejected by decoder: ${roundTrip.reason}`);
      return { kind: "rejected", reason: "schema_violation" };
    }

    // 2. read-modify-write on loaded store deep copy (IC-03.4)
    const currentStore = loadStore(ownerStorage, log);
    const next: AnalysisStore = structuredClone(currentStore);

    let entry = next.sessions[ownerId];
    if (!entry) {
      entry = { updatedAt: 0, artifacts: [] };
      next.sessions[ownerId] = entry;
    }

    // Dedupe
    entry.artifacts = entry.artifacts.filter((a) => a.artifactId !== candidate.artifactId);
    entry.artifacts.push(candidate);
    entry.updatedAt = Math.max(entry.updatedAt, candidate.generatedAt);

    // Sort ascending by (generatedAt, artifactId)
    entry.artifacts.sort(compareArtifactAsc);

    // 3. storage write
    try {
      await ownerStorage.update(ANALYSIS_STORE_KEY, next);
      return { kind: "saved" };
    } catch {
      return { kind: "failed", reason: "update_error" };
    }
  };

  const resultPromise = serializedSaveTail.then(job, job);
  serializedSaveTail = resultPromise.then(() => {}, () => {});
  return resultPromise;
}
