import { createHash } from "node:crypto";

interface RecordBase { kind: string; at: string; opId: string }
export interface EvidenceRefs { sessions: string[]; observations: string[]; recurrences: string[] }
interface RuleTarget { rule_id: string; hash: string; model: string }
export type LearningDomain = "orchestration" | "tools" | "environment" | "verification" | "other";
export interface ModelProfile extends RecordBase {
  kind: "modelProfile";
  executor: "claude" | "codex" | "agy";
  model: string;
  hash: string;
  sources: Array<{ url: string; checkedAt: string }>;
  strengths?: string;
  effort?: string;
  caveats?: string;
}
export type LearningRecord =
  | ModelProfile
  | (RecordBase & RuleTarget & { kind: "candidate"; sourceRef: string; sourceAt: string; sourceUrl?: string; evidence: EvidenceRefs })
  | (RecordBase & { kind: "ruleVersion"; rule_id: string; text: string; hash: string; scope: string; domain: LearningDomain; expectHash?: string })
  | (RecordBase & RuleTarget & { kind: "decision"; action: "promote" | "restore" | "retire" | "reject"; by: "conductor" | "user"; evidence: EvidenceRefs; expectHash?: string })
  | (RecordBase & { kind: "quarantine"; rule_id: string; hash: string; oldModel: string; newModel: string;
      conversationRef: string; sessionRef: string | null; observationRef: string; reviewDueAt: string; reason?: "no-active-qualification" })
  | (RecordBase & RuleTarget & { kind: "reviewDue" })
  | (RecordBase & RuleTarget & { kind: "recurrence"; signature: string; scope: string; sessionRef: string; runRef: string })
  | (RecordBase & { kind: "delivery"; conversationRef: string; sessionRef: string | null; model: string; scope: string;
      rules: Array<{ ruleId: string; hash: string }>; setHash: string; outcome: "sent" | "failed" | "withheld" | "model-mismatch" })
  | (RecordBase & { kind: "observation"; type: "failure" | "human-evaluation"; model: string | null; scope: string;
      conversationRef: string; sessionRef: string | null; runRef: string | null; sourceRef: string; refs: string[] })
  | (RecordBase & { kind: "control"; autoApply: boolean; reason: string })
  | (RecordBase & { kind: "import"; rule_id: string; batchId: string; oldId: string; oldState: QualificationState; reason: "import_unverified" });

type RecordOf<K extends LearningRecord["kind"]> = Extract<LearningRecord, { kind: K }>;
export type QualificationState = "candidate" | "active" | "quarantined" | "review_due" | "retired" | "rejected";
export interface Qualification {
  state: QualificationState;
  latestDecision?: RecordOf<"decision">;
  promotedAt?: string;
  reviewDueAt?: string;
  retired_by?: "human" | "conductor";
  imported?: boolean;
  reason?: "import_unverified";
}
export interface RuleVersionState { record: RecordOf<"ruleVersion">; qualifications: Map<string, Qualification> }
export interface LearningRule { versions: RuleVersionState[] }
export interface LearningState {
  rules: Map<string, LearningRule>;
  records: Map<string, LearningRecord>;
  skipped: Array<{ opId?: string; reason: string }>;
}
export interface LearningFacts {
  coverage: "observed" | "model-unknown" | "session-unknown";
  delivered: { count: number; setHash: string; outcome: RecordOf<"delivery">["outcome"] | "none" };
  observations: number;
  evidenced: number;
  recurrences: number;
  qualifications: { active: number; quarantined: number; reviewDue: number; retiredHuman: number; retiredConductor: number; candidate: number; rejected: number; imported: number };
  generalQualifications: LearningFacts["qualifications"];
}

export function learningFacts(state: LearningState, target: { conversationRef: string; sessionRef: string | null; model: string | null; scope: string }): LearningFacts {
  // R-LRN-09: a missing session must not join unrelated observations with a null session.
  const session = target.sessionRef?.trim().toLowerCase() || null;
  const facts: LearningFacts = {
    coverage: target.model === null ? "model-unknown" : session === null ? "session-unknown" : "observed",
    delivered: { count: 0, setHash: "", outcome: "none" },
    observations: 0, evidenced: 0, recurrences: 0,
    qualifications: { active: 0, quarantined: 0, reviewDue: 0, retiredHuman: 0, retiredConductor: 0, candidate: 0, rejected: 0, imported: 0 },
    generalQualifications: { active: 0, quarantined: 0, reviewDue: 0, retiredHuman: 0, retiredConductor: 0, candidate: 0, rejected: 0, imported: 0 },
  };
  const evidence = new Set<string>();
  for (const record of state.records.values()) {
    if (record.kind === "candidate" || record.kind === "decision") {
      for (const ref of record.evidence.observations) evidence.add(ref);
    }
  }
  let latestDeliveryAt = -Infinity;
  for (const record of state.records.values()) {
    if (record.kind === "delivery" && record.conversationRef === target.conversationRef && Date.parse(record.at) >= latestDeliveryAt) {
      latestDeliveryAt = Date.parse(record.at);
      facts.delivered = { count: record.rules.length, setHash: record.setHash, outcome: record.outcome };
    } else if (record.kind === "observation" && (record.conversationRef === target.conversationRef
      || session !== null && record.sessionRef?.trim().toLowerCase() === session)) {
      facts.observations++;
      if (evidence.has(record.opId)) facts.evidenced++;
    } else if (record.kind === "recurrence" && session !== null && record.sessionRef.trim().toLowerCase() === session) {
      facts.recurrences++;
    }
  }
  for (const rule of state.rules.values()) {
    const version = rule.versions.at(-1);
    if (version?.record.scope !== target.scope) continue;
    for (const [model, counts] of [[target.model, facts.qualifications], ["*", facts.generalQualifications]] as const) {
      if (model === null || model === "*" && counts === facts.qualifications) continue;
      const qualification = version.qualifications.get(model);
      if (!qualification) continue;
      if (qualification.imported) counts.imported++;
      switch (qualification.state) {
        case "active": counts.active++; break;
        case "quarantined": counts.quarantined++; break;
        case "review_due": counts.reviewDue++; break;
        case "retired":
          if (qualification.retired_by === "human") counts.retiredHuman++;
          else if (qualification.retired_by === "conductor") counts.retiredConductor++;
          break;
        case "candidate": counts.candidate++; break;
        case "rejected": counts.rejected++; break;
      }
    }
  }
  return facts;
}
export type LearningTransition = { expectHash?: string } & (
  | RecordOf<"decision">
  | RecordOf<"delivery">
  | (RecordBase & { kind: "amend"; rule_id: string; text: string; scope: string; domain?: LearningDomain })
  | (RecordBase & { kind: "modelChange"; rule_id: string; oldModel: string; newModel: string;
      source: "conductor"; conversationRef: string; sessionRef: string | null; observationRef: string })
  | (RecordBase & { kind: "reviewDue"; rule_id: string; model: string })
);
export type TransitionResult = { ok: true; records: LearningRecord[] } | { ok: false; reason: string };
export interface DeliverySelection { rules: Array<{ ruleId: string; hash: string; text: string; domain: LearningDomain }>; setHash: string; overflow: number }

function objectR27(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysR27(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function refR32(value: unknown): value is string {
  // R-LRN-06: opaque references must not become a second store for messages, paths or credential literals.
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value)
    && !/^(?:sk-|gh[pousr]_|github_pat_|AKIA)/i.test(value);
}
function refsR32(value: unknown): value is string[] { return Array.isArray(value) && value.every(refR32); }
function scopeR32(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\\/\u0000-\u001f]|^[A-Za-z]:/.test(value);
}
function isoR28(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function hashR28(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function evidenceR29(value: unknown): value is EvidenceRefs {
  return objectR27(value) && keysR27(value, ["sessions", "observations", "recurrences"])
    && Array.isArray(value.sessions) && value.sessions.every(session => typeof session === "string" && (!session.trim() || refR32(session.trim())))
    && refsR32(value.observations) && refsR32(value.recurrences);
}
function sessionsR29(sessions: string[]): Set<string> { return new Set(sessions.map(session => session.trim().toLowerCase()).filter(Boolean)); }
function normalizeText(text: string): string { return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").replace(/\n+$/, ""); }
export function textHash(text: string): string { return createHash("sha256").update(normalizeText(text), "utf8").digest("hex"); }

function domainR03(value: unknown): value is LearningDomain {
  return ["orchestration", "tools", "environment", "verification", "other"].includes(value as string);
}
function singleLineR10(value: unknown, cap: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= cap
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
    && !/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|etc|tmp|var)\/|file:\/\/)/.test(value)
    && !/\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]+/i.test(value);
}
const CREDENTIAL_PAIR_R06 = /(?:^|[^\p{L}\p{N}])["'`]?(?:password|passwd|secret|token|api[_-]?key|authorization)["'`]?\s*[:=]\s*["'`]?((?:bearer|basic)\s+)?([^\s"'`,;{}()[\]<>]+)/giu;
const BEARER_R06 = /(?:^|[^\p{L}\p{N}])bearer\s+()([^\s"'`,;{}()[\]<>]+)/giu;
const PATH_ROOT_R06 = /(^|[^\p{L}\p{N}_.~-])(\/\/|\\\\|\/)(?=[^\s/\\])/gu;
function secretValueR06(scheme: string | undefined, raw: string): boolean {
  const value = raw.replace(/[.!?:]+$/, "");
  if ([...value].length < 6) return false;
  return !!scheme || !(/^\p{Ll}+$/u.test(value) || /^\p{Lu}\p{Ll}+$/u.test(value) || /^[^\p{Ll}\p{Lu}\p{N}\p{P}\p{S}]+$/u.test(value));
}
function rootedPathR06(text: string): boolean {
  for (const match of text.matchAll(PATH_ROOT_R06)) {
    const rest = text.slice(match.index + match[1].length + match[2].length);
    const end = rest.search(/[,;"'`()<>|\n]|\.(?:\s|$)/);
    if (/[/\\]/.test(end < 0 ? rest : rest.slice(0, end))) return true;
  }
  return false;
}
function privateTextR06(value: string): boolean {
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*[?#][^\s"'<>]/i.test(value) || /file:\/\//i.test(value)) return true;
  if ([...value.matchAll(CREDENTIAL_PAIR_R06), ...value.matchAll(BEARER_R06)].some(match => secretValueR06(match[1], match[2]))) return true;
  if (/\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]+/i.test(value)) return true;
  const text = value.replace(/\bhttps?:\/\/[^\s"'<>()]*/gi, " ");
  return rootedPathR06(text) || /[A-Za-z]:[\\/]/.test(text) || /(?:^|[^\p{L}\p{N}_])~(?:\p{L}[^\s/\\]*)?[\\/]/u.test(text);
}
function sourceUrlR10(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !/^https:\/\//.test(value) || /[\s\\?#]/.test(value)
    || /^https:\/\/[^/]*@/.test(value)) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, "");
    return !url.username && !url.password && !url.search && !url.hash
      && host.includes(".") && !/^[\d.]+$/.test(host) && !host.includes(":")
      && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)
      && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  } catch { return false; }
}
function profileFieldsR10(value: Record<string, unknown>): boolean {
  return ["claude", "codex", "agy"].includes(value.executor as string) && refR32(value.model)
    && Array.isArray(value.sources) && value.sources.length >= 1 && value.sources.length <= 3
    && value.sources.every(source => objectR27(source) && keysR27(source, ["url", "checkedAt"])
      && sourceUrlR10(source.url) && isoR28(source.checkedAt))
    && ["strengths", "effort", "caveats"].some(key => key in value)
    && ["strengths", "effort", "caveats"].every(key => !(key in value) || singleLineR10(value[key], 120));
}
const compareLexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export function modelProfileHash(profile: Pick<ModelProfile, "model" | "strengths" | "effort" | "caveats" | "sources">): string {
  const sources = profile.sources.map(source => ({ url: new URL(source.url).href, checkedAt: source.checkedAt }))
    .sort((a, b) => compareLexical(a.url, b.url) || compareLexical(a.checkedAt, b.checkedAt));
  return createHash("sha256").update(JSON.stringify({ model: profile.model,
    ...(profile.strengths !== undefined ? { strengths: profile.strengths.normalize("NFC") } : {}),
    ...(profile.effort !== undefined ? { effort: profile.effort.normalize("NFC") } : {}),
    ...(profile.caveats !== undefined ? { caveats: profile.caveats.normalize("NFC") } : {}), sources }), "utf8").digest("hex");
}
export function modelProfileHistory(state: LearningState, target: Pick<ModelProfile, "executor" | "model">): ModelProfile[] {
  return [...state.records.values()].filter((record): record is ModelProfile => record.kind === "modelProfile"
    && record.executor === target.executor && record.model === target.model)
    .sort((a, b) => compareLexical(a.at, b.at) || compareLexical(a.opId, b.opId)).map(record => structuredClone(record));
}
export function latestModelProfile(state: LearningState, target: Pick<ModelProfile, "executor" | "model">): ModelProfile | undefined {
  return modelProfileHistory(state, target).at(-1);
}

export type ModelProfileInput = Omit<ModelProfile, "at" | "opId" | "hash"> & { requestId: string };
export type CandidateInput = {
  kind: "candidate"; requestId: string; ruleId: string; text: string; domain: LearningDomain;
  sourceAt: string; source: { ref: string } | { url: string }; evidence: EvidenceRefs; expectHash?: string;
} & ({ binding: "model"; model: string } | { binding: "general"; model?: never });
export type LearningRecordInput = ModelProfileInput | CandidateInput;
export type LearningRefusalCode = "missing-source" | "missing-date" | "invalid-date" | "invalid-source" | "unknown-model"
  | "unresolved-alias" | "text-over-cap" | "private-content" | "unknown-field" | "unknown-reference" | "hash-conflict" | "qualification-exists" | "request-conflict";
export type LearningAdmission = { ok: true; records: LearningRecord[] }
  | { ok: false; code: LearningRefusalCode; requirement: string; field?: string; reason: string };
export interface RecordContext { at: string; opId: string }
export interface ModelProfileContext extends RecordContext {
  knownModels: ReadonlyArray<Pick<ModelProfile, "executor" | "model">>;
  unresolvedModels?: ReadonlyArray<Pick<ModelProfile, "executor" | "model">>;
}
export interface CandidateContext extends RecordContext {
  scope: string;
  knownModels: readonly string[];
  sourceRefs: readonly string[];
  unresolvedModels?: readonly string[];
}
function refuse(code: LearningRefusalCode, requirement: string, field?: string): Extract<LearningAdmission, { ok: false }> {
  return { ok: false, code, requirement, ...(field ? { field } : {}), reason: `${requirement}: ${code}` };
}
export function validateLearningInput(input: unknown): { ok: true; input: LearningRecordInput } | Extract<LearningAdmission, { ok: false }> {
  if (!objectR27(input)) return refuse("unknown-field", "R-LRN-06");
  const profile = input.kind === "modelProfile", requirement = profile ? "R-LRN-10" : "R-LRN-03";
  const fields = profile ? ["kind", "requestId", "executor", "model", "sources", "strengths", "effort", "caveats"]
    : ["kind", "requestId", "ruleId", "text", "domain", "binding", "sourceAt", "source", "evidence", "expectHash", ...(input.binding === "model" ? ["model"] : [])];
  if ((!profile && input.kind !== "candidate") || Object.keys(input).some(key => !fields.includes(key)))
    return refuse("unknown-field", requirement);
  if (!refR32(input.requestId)) return refuse("unknown-reference", requirement, "requestId");
  if (profile) {
    if (!["claude", "codex", "agy"].includes(input.executor as string) || !refR32(input.model)) return refuse("unknown-model", requirement);
    if (!Array.isArray(input.sources) || !input.sources.length) return refuse("missing-source", requirement, "sources");
    if (input.sources.length > 3) return refuse("invalid-source", requirement, "sources");
    for (const source of input.sources) {
      if (!objectR27(source)) return refuse("invalid-source", requirement, "sources");
      if (Object.keys(source).some(key => !["url", "checkedAt"].includes(key))) return refuse("unknown-field", requirement, "sources");
      if (!("checkedAt" in source)) return refuse("missing-date", requirement, "checkedAt");
      if (!isoR28(source.checkedAt)) return refuse("invalid-date", requirement, "checkedAt");
      if (!("url" in source)) return refuse("missing-source", requirement, "url");
      if (!sourceUrlR10(source.url)) return refuse("invalid-source", requirement, "url");
    }
    if (!["strengths", "effort", "caveats"].some(key => key in input)) return refuse("unknown-field", requirement);
    for (const field of ["strengths", "effort", "caveats"]) {
      if (typeof input[field] === "string" && privateTextR06(input[field])) return refuse("private-content", "R-LRN-06", field);
      if (field in input && !singleLineR10(input[field], 120)) return refuse("text-over-cap", requirement, field);
    }
  } else {
    if (!domainR03(input.domain) || !["model", "general"].includes(input.binding as string)) return refuse("unknown-field", requirement);
    if (input.binding === "model" && !refR32(input.model)) return refuse("unknown-model", requirement, "model");
    if (!refR32(input.ruleId) || !evidenceR29(input.evidence)) return refuse("unknown-reference", requirement);
    if (typeof input.text === "string" && privateTextR06(input.text)) return refuse("private-content", "R-LRN-06", "text");
    if (!singleLineR10(input.text, 500)) return refuse("text-over-cap", requirement, "text");
    if (!("sourceAt" in input)) return refuse("missing-date", requirement, "sourceAt");
    if (!isoR28(input.sourceAt)) return refuse("invalid-date", requirement, "sourceAt");
    if (!("source" in input)) return refuse("missing-source", requirement, "source");
    if (!objectR27(input.source)) return refuse("invalid-source", requirement, "source");
    if (Object.keys(input.source).some(key => !["ref", "url"].includes(key))) return refuse("unknown-field", requirement, "source");
    if (!(keysR27(input.source, ["ref"]) && refR32(input.source.ref))
      && !(keysR27(input.source, ["url"]) && sourceUrlR10(input.source.url))) return refuse("invalid-source", requirement, "source");
    if ("expectHash" in input && !hashR28(input.expectHash)) return refuse("hash-conflict", "R-LRN-02", "expectHash");
  }
  return { ok: true, input: input as unknown as LearningRecordInput };
}
export function admitModelProfile(state: LearningState, input: unknown, context: ModelProfileContext): LearningAdmission {
  const validated = validateLearningInput(input);
  if (!validated.ok) return validated;
  if (validated.input.kind !== "modelProfile") return refuse("unknown-field", "R-LRN-10", "kind");
  const { requestId: _requestId, ...profile } = validated.input;
  if (!isoR28(context.at)) return refuse("invalid-date", "R-LRN-10", "at");
  if (!refR32(context.opId)) return refuse("unknown-reference", "R-LRN-10", "opId");
  const matches = (target: Pick<ModelProfile, "executor" | "model">) => target.executor === profile.executor && target.model === profile.model;
  if (context.unresolvedModels?.some(matches)) return refuse("unresolved-alias", "R-LRN-10", "model");
  if (!context.knownModels.some(matches)) return refuse("unknown-model", "R-LRN-10", "model");
  const record: ModelProfile = { ...profile, at: context.at, opId: context.opId, hash: modelProfileHash(profile) };
  const existing = state.records.get(context.opId);
  if (existing && (existing.kind !== "modelProfile" || !matches(existing) || existing.hash !== record.hash))
    return refuse("request-conflict", "R-LRN-10");
  if (modelProfileHistory(state, profile).some(prior => prior.hash === record.hash)) return { ok: true, records: [] };
  return { ok: true, records: [structuredClone(record)] };
}
export function recordCandidate(state: LearningState, input: unknown, context: CandidateContext): LearningAdmission {
  const validated = validateLearningInput(input);
  if (!validated.ok) return validated;
  if (validated.input.kind !== "candidate") return refuse("unknown-field", "R-LRN-03", "kind");
  const candidate = validated.input;
  if (!isoR28(context.at)) return refuse("invalid-date", "R-LRN-03", "at");
  if (!refR32(context.opId) || !scopeR32(context.scope)) return refuse("unknown-reference", "R-LRN-03");
  const model = candidate.binding === "general" ? "*" : candidate.model;
  if (model !== "*" && context.unresolvedModels?.includes(model)) return refuse("unresolved-alias", "R-LRN-03", "model");
  if (model !== "*" && !context.knownModels.includes(model)) return refuse("unknown-model", "R-LRN-03", "model");
  if ("ref" in candidate.source && !state.records.has(candidate.source.ref) && !context.sourceRefs.includes(candidate.source.ref))
    return refuse("unknown-reference", "R-LRN-03", "source");
  if (candidate.evidence.observations.some(ref => state.records.get(ref)?.kind !== "observation")
    || candidate.evidence.recurrences.some(ref => state.records.get(ref)?.kind !== "recurrence")) return refuse("unknown-reference", "R-LRN-03", "evidence");
  const previous = latestVersion(state, candidate.ruleId), hash = textHash(candidate.text);
  const changed = previous && (previous.record.hash !== hash || previous.record.domain !== candidate.domain || previous.record.scope !== context.scope);
  if ((changed || candidate.expectHash !== undefined) && candidate.expectHash !== previous?.record.hash)
    return refuse("hash-conflict", "R-LRN-02", "expectHash");
  if (!changed && previous?.qualifications.has(model)) return refuse("qualification-exists", "R-LRN-03");
  if (state.records.has(context.opId) || state.records.has(`${context.opId}:version`)) return refuse("request-conflict", "R-LRN-02");
  const records: LearningRecord[] = [];
  if (!previous || changed) records.push({ kind: "ruleVersion", at: context.at, opId: `${context.opId}:version`,
    rule_id: candidate.ruleId, text: candidate.text, hash, scope: context.scope, domain: candidate.domain,
    ...(previous ? { expectHash: previous.record.hash } : {}) });
  if (!previous?.qualifications.has(model)) records.push({ kind: "candidate", at: context.at, opId: context.opId,
    rule_id: candidate.ruleId, hash, model, sourceAt: candidate.sourceAt,
    ...("url" in candidate.source ? { sourceRef: `url:${textHash(candidate.source.url)}`, sourceUrl: candidate.source.url } : { sourceRef: candidate.source.ref }),
    evidence: structuredClone(candidate.evidence) });
  const preview = structuredClone(state);
  for (const record of records) {
    if (preview.records.has(record.opId)) return refuse("request-conflict", "R-LRN-02");
    if (!isLearningRecord(record) || recordFailureR28(preview, record)) return refuse("hash-conflict", "R-LRN-02");
    applyRecord(preview, structuredClone(record));
  }
  return { ok: true, records };
}

export function restoreLearningRecord(value: unknown): LearningRecord | undefined {
  const record = objectR27(value) && value.kind === "ruleVersion" && !("domain" in value)
    ? { ...value, domain: "orchestration" } : value;
  return isLearningRecord(record) ? structuredClone(record) : undefined;
}

export function isLearningRecord(value: unknown): value is LearningRecord {
  // R-LRN-01 R-LRN-06: accepting extra fields would copy private payloads into the replayed learning.
  if (!objectR27(value) || !isoR28(value.at) || !refR32(value.opId)) return false;
  const exact = (...fields: string[]) => keysR27(value, ["kind", "at", "opId", ...fields]);
  const target = () => refR32(value.rule_id) && hashR28(value.hash) && (value.model === "*" || refR32(value.model));
  switch (value.kind) {
    case "modelProfile": return exact("executor", "model", "hash", "sources", ...["strengths", "effort", "caveats"].filter(key => key in value))
      && profileFieldsR10(value) && hashR28(value.hash) && value.hash === modelProfileHash(value as unknown as ModelProfile);
    case "candidate": return exact("rule_id", "hash", "model", "sourceRef", "sourceAt", "evidence", ...("sourceUrl" in value ? ["sourceUrl"] : []))
      && target() && refR32(value.sourceRef) && isoR28(value.sourceAt) && (!("sourceUrl" in value) || sourceUrlR10(value.sourceUrl)) && evidenceR29(value.evidence);
    case "ruleVersion": return exact("rule_id", "text", "hash", "scope", "domain", ...("expectHash" in value ? ["expectHash"] : []))
      && domainR03(value.domain)
      && (!("expectHash" in value) || hashR28(value.expectHash)) && refR32(value.rule_id) && scopeR32(value.scope)
      && typeof value.text === "string" && value.text.trim().length > 0 && hashR28(value.hash) && value.hash === textHash(value.text);
    case "decision": return exact("rule_id", "hash", "model", "action", "by", "evidence", ...("expectHash" in value ? ["expectHash"] : [])) && target()
      && (!("expectHash" in value) || hashR28(value.expectHash))
      && ["promote", "restore", "retire", "reject"].includes(value.action as string)
      && (value.by === "conductor" || value.by === "user") && evidenceR29(value.evidence);
    case "quarantine": return exact("rule_id", "hash", "oldModel", "newModel", "conversationRef", "sessionRef", "observationRef", "reviewDueAt", ...("reason" in value ? ["reason"] : []))
      && (!("reason" in value) || value.reason === "no-active-qualification")
      && refR32(value.rule_id) && hashR28(value.hash) && [value.oldModel, value.newModel, value.conversationRef, value.observationRef].every(refR32) && (value.sessionRef === null || refR32(value.sessionRef))
      && value.oldModel !== value.newModel && isoR28(value.reviewDueAt) && Date.parse(value.reviewDueAt) - Date.parse(value.at) === 30 * 86400000;
    case "reviewDue": return exact("rule_id", "hash", "model") && target();
    case "recurrence": return exact("rule_id", "hash", "model", "signature", "scope", "sessionRef", "runRef") && target()
      && scopeR32(value.scope) && [value.signature, value.sessionRef, value.runRef].every(refR32);
    case "delivery": return exact("conversationRef", "sessionRef", "model", "scope", "rules", "setHash", "outcome")
      && [value.conversationRef, value.model].every(refR32) && (value.sessionRef === null || refR32(value.sessionRef)) && scopeR32(value.scope) && hashR28(value.setHash)
      && ["sent", "failed", "withheld", "model-mismatch"].includes(value.outcome as string) && Array.isArray(value.rules)
      && value.rules.every(rule => objectR27(rule) && keysR27(rule, ["ruleId", "hash"]) && refR32(rule.ruleId) && hashR28(rule.hash));
    case "observation": return exact("type", "model", "scope", "conversationRef", "sessionRef", "runRef", "sourceRef", "refs")
      && (value.type === "failure" || value.type === "human-evaluation") && (value.model === null || refR32(value.model))
      && scopeR32(value.scope) && [value.conversationRef, value.sourceRef].every(refR32) && (value.sessionRef === null || refR32(value.sessionRef))
      && (value.runRef === null || refR32(value.runRef)) && refsR32(value.refs);
    case "control": return exact("autoApply", "reason") && typeof value.autoApply === "boolean" && refR32(value.reason);
    case "import": return exact("rule_id", "batchId", "oldId", "oldState", "reason")
      && [value.rule_id, value.batchId, value.oldId].every(refR32) && value.reason === "import_unverified"
      && ["candidate", "active", "quarantined", "review_due", "retired", "rejected"].includes(value.oldState as string);
    default: return false;
  }
}

function latestVersion(state: LearningState, ruleId: string): RuleVersionState | undefined { return state.rules.get(ruleId)?.versions.at(-1); }
function versionR28(state: LearningState, ruleId: string, hash: string): RuleVersionState | undefined {
  return state.rules.get(ruleId)?.versions.find(version => version.record.hash === hash);
}
function decisionFailureR29(state: LearningState, record: RecordOf<"decision">, version: RuleVersionState): string | undefined {
  const qualification = version.qualifications.get(record.model);
  if (!qualification) return "R-LRN-03: target qualification missing";
  if (record.model === "*" && (record.action === "retire" || record.action === "reject") && record.by !== "user")
    return "R-LRN-03: general qualification requires human retirement or rejection";
  const evidence = record.evidence;
  if ((record.action === "promote" || (record.action === "retire" && record.by === "conductor"))
    && (evidence.observations.some(ref => state.records.get(ref)?.kind !== "observation")
      || evidence.recurrences.some(ref => state.records.get(ref)?.kind !== "recurrence"))) return "R-LRN-03: unknown evidence ref";
  switch (record.action) {
    case "promote": {
      if (qualification.state !== "candidate") return "R-LRN-03: promotion requires candidate";
      const humanEvaluation = evidence.observations.some(ref => {
        const observation = state.records.get(ref);
        return observation?.kind === "observation" && observation.type === "human-evaluation"
          && (record.model === "*" || observation.model === record.model) && observation.scope === version.record.scope;
      });
      if (sessionsR29(evidence.sessions).size < 2 && !humanEvaluation) return "R-LRN-03: promotion evidence insufficient";
      return undefined;
    }
    case "restore": {
      if (qualification.state === "retired" && qualification.retired_by === "human" && record.by === "user") return undefined;
      if (qualification.state !== "quarantined" && qualification.state !== "review_due") return "R-LRN-03: restoration requires review";
      const recurrence = evidence.recurrences.some(ref => {
        const observed = state.records.get(ref);
        return observed?.kind === "recurrence" && observed.model === record.model && observed.rule_id === record.rule_id
          && observed.hash === record.hash && observed.scope === version.record.scope;
      });
      return recurrence ? undefined : "R-LRN-03: same-model recurrence required";
    }
    case "retire":
      return record.by === "user" || (qualification.state === "review_due"
        && sessionsR29(evidence.sessions).size + evidence.observations.length + evidence.recurrences.length > 0)
        ? undefined : "R-LRN-03: retirement requires user or review evidence";
    case "reject": return ["candidate", "quarantined", "review_due"].includes(qualification.state)
      ? undefined : "R-LRN-03: rejection requires candidate or review";
  }
}

function sameDeliveryRules(left: RecordOf<"delivery">["rules"], right: RecordOf<"delivery">["rules"]): boolean {
  const pairs = (rules: RecordOf<"delivery">["rules"]) => new Set(rules.map(rule => `${rule.ruleId}:${rule.hash}`));
  const a = pairs(left), b = pairs(right);
  return left.length === right.length && a.size === b.size && [...a].every(pair => b.has(pair));
}

function recordFailureR28(state: LearningState, record: LearningRecord): string | undefined {
  if (record.kind === "modelProfile") return modelProfileHistory(state, record).some(prior => prior.hash === record.hash)
    ? "R-LRN-10: duplicate profile version" : undefined;
  if (record.kind === "ruleVersion") return record.expectHash !== undefined && record.expectHash !== latestVersion(state, record.rule_id)?.record.hash
    ? "R-LRN-02: expectHash mismatch" : undefined;
  if (record.kind === "observation" || record.kind === "control") return undefined;
  if (record.kind === "import") return latestVersion(state, record.rule_id)?.qualifications.size
    ? undefined : "R-LRN-08: import qualification missing";
  if (record.kind === "delivery") {
    if (record.outcome === "model-mismatch") {
      const sent = [...state.records.values()].find(prior => prior.kind === "delivery" && prior.outcome === "sent"
        && prior.conversationRef === record.conversationRef && prior.scope === record.scope && prior.setHash === record.setHash
        && prior.model !== record.model && sameDeliveryRules(prior.rules, record.rules));
      return sent ? undefined : "R-LRN-05: model mismatch requires the original sent delivery";
    }
    if (record.rules.some(rule => {
      const version = versionR28(state, rule.ruleId, rule.hash);
      return version?.record.scope !== record.scope || (version.qualifications.get(record.model)?.state !== "active"
        && version.qualifications.get("*")?.state !== "active");
    })) return "R-LRN-05: delivery requires active target version and scope";
    return record.setHash === textHash(record.rules.map(rule => `${rule.ruleId}:${rule.hash}`).join("\n"))
      ? undefined : "R-LRN-05: delivery setHash mismatch";
  }
  const version = versionR28(state, record.rule_id, record.hash);
  if (!version) return "R-LRN-02: retained version missing";
  switch (record.kind) {
    case "candidate": return version.qualifications.has(record.model) ? "R-LRN-03: qualification already exists" : undefined;
    case "decision": return record.expectHash !== undefined && record.expectHash !== version.record.hash
      ? "R-LRN-02: expectHash mismatch" : decisionFailureR29(state, record, version);
    case "quarantine": {
      const target = version.qualifications.get(record.newModel);
      const oldState = version.qualifications.get(record.oldModel)?.state;
      if (oldState === "candidate" || oldState === "quarantined" || oldState === "review_due") return undefined;
      if (oldState !== "active" || record.reason !== undefined) return "R-LRN-04: old model is not active";
      return target && target.state !== "candidate" ? "R-LRN-04: target already qualified or isolated" : undefined;
    }
    case "reviewDue": {
      if (record.model === "*") return "R-LRN-04: general qualification has no review deadline";
      const target = version.qualifications.get(record.model);
      return target?.state === "quarantined" && target.reviewDueAt && Date.parse(record.at) >= Date.parse(target.reviewDueAt)
        ? undefined : "R-LRN-04: quarantine deadline not reached";
    }
    case "recurrence": return record.scope === version.record.scope ? undefined : "R-LRN-03: recurrence scope mismatch";
  }
}

function inheritedR29(qualification: Qualification): Qualification {
  // R-LRN-08: retaining conflicting imported text must not erase its pending review.
  if (qualification.imported && qualification.state === "review_due" && qualification.reason === "import_unverified") return { ...qualification };
  return qualification.state === "retired" || qualification.state === "rejected" ? { ...qualification } : { state: "candidate" };
}

export function applyRecord(state: LearningState, record: LearningRecord): void {
  if (record.kind === "ruleVersion") {
    const rule = state.rules.get(record.rule_id) ?? { versions: [] };
    const previous = rule.versions.at(-1);
    const qualifications = new Map<string, Qualification>();
    for (const [model, qualification] of previous?.qualifications ?? []) qualifications.set(model, inheritedR29(qualification));
    rule.versions.push({ record, qualifications });
    state.rules.set(record.rule_id, rule);
  } else if (record.kind === "candidate") {
    versionR28(state, record.rule_id, record.hash)!.qualifications.set(record.model, { state: "candidate" });
  } else if (record.kind === "decision") {
    const qualification = versionR28(state, record.rule_id, record.hash)!.qualifications.get(record.model)!;
    qualification.latestDecision = record;
    if (record.action === "promote" || record.action === "restore") {
      qualification.state = "active";
      qualification.promotedAt = record.at;
      delete qualification.retired_by;
    } else if (record.action === "retire") {
      qualification.state = "retired";
      qualification.retired_by = record.by === "user" ? "human" : "conductor";
    } else if (record.action === "reject") {
      qualification.state = "rejected";
    }
  } else if (record.kind === "quarantine") {
    const version = versionR28(state, record.rule_id, record.hash)!;
    if (version.qualifications.get(record.oldModel)?.state !== "active") {
      state.records.set(record.opId, { ...record, reason: "no-active-qualification" });
      return;
    }
    version.qualifications.set(record.newModel, { ...version.qualifications.get(record.newModel), state: "quarantined", reviewDueAt: record.reviewDueAt });
  } else if (record.kind === "reviewDue") {
    versionR28(state, record.rule_id, record.hash)!.qualifications.get(record.model)!.state = "review_due";
  } else if (record.kind === "import") {
    const version = latestVersion(state, record.rule_id)!;
    for (const [model, qualification] of version.qualifications) {
      if (qualification.state === "rejected" || qualification.state === "retired") continue;
      version.qualifications.set(model,
      record.oldState === "retired" ? { state: "retired", retired_by: "human", imported: true }
        : ["active", "quarantined", "review_due"].includes(record.oldState)
          ? { state: "review_due", reason: "import_unverified", imported: true } : { state: "candidate", imported: true });
    }
  }
  if (record.kind === "candidate" || record.kind === "quarantine") {
    // R-LRN-02: a model first recorded on an old version must seed later candidates regardless of amendment order.
    const versions = state.rules.get(record.rule_id)!.versions;
    const index = versions.indexOf(versionR28(state, record.rule_id, record.hash)!);
    for (let i = index + 1; i < versions.length; i++) {
      for (const [model, qualification] of versions[i - 1].qualifications) {
        if (!versions[i].qualifications.has(model)) versions[i].qualifications.set(model, inheritedR29(qualification));
      }
    }
  }
  state.records.set(record.opId, record);
}

export function applyAdmittedRecords(state: LearningState, records: LearningRecord[]): void {
  for (const record of records) applyRecord(state, structuredClone(record));
}

export function restoreState(records: Iterable<LearningRecord>): LearningState;
export function restoreState(records: Iterable<unknown>): LearningState;
export function restoreState(records: Iterable<unknown>): LearningState {
  const state: LearningState = { rules: new Map(), records: new Map(), skipped: [] };
  const seen = new Set<string>();
  for (const raw of records) {
    const record = restoreLearningRecord(raw);
    // R-LRN-01 R-LRN-02: bad rows and duplicate operations must remain visible as skipped records.
    if (!record) { state.skipped.push({ reason: "R-LRN-01 R-LRN-06: malformed record" }); continue; }
    const reason = seen.has(record.opId) ? "R-LRN-01: duplicate operation" : recordFailureR28(state, record);
    if (reason) { state.skipped.push({ opId: record.opId, reason }); continue; }
    applyRecord(state, structuredClone(record));
    seen.add(record.opId);
  }
  return state;
}

export function admitTransition(state: LearningState, event: LearningTransition): TransitionResult {
  if (!objectR27(event) || !isoR28(event.at) || !refR32(event.opId)) return { ok: false, reason: "R-LRN-02: malformed transition" };
  if (state.records.has(event.opId)) return { ok: true, records: [] };
  if (event.kind === "reviewDue" && event.model === "*") return { ok: false, reason: "R-LRN-04: general qualification has no review deadline" };
  const { expectHash: _expectHash, ...input } = event;
  if (input.kind === "delivery") {
    if (!isLearningRecord(input)) return { ok: false, reason: "R-LRN-05: malformed delivery" };
    const reason = recordFailureR28(state, input);
    return reason ? { ok: false, reason } : { ok: true, records: [structuredClone(input)] };
  }
  const version = input.kind === "decision" ? versionR28(state, input.rule_id, input.hash)
    : input.kind === "reviewDue" ? state.rules.get(input.rule_id)?.versions.find(item => item.qualifications.get(input.model)?.state === "quarantined")
      : latestVersion(state, input.rule_id);
  if (!version) return { ok: false, reason: "R-LRN-02: rule missing" };
  if ((event.kind === "amend" || event.kind === "decision") && event.expectHash !== undefined && event.expectHash !== version.record.hash)
    return { ok: false, reason: "R-LRN-02: expectHash mismatch" };
  let record: LearningRecord;
  switch (input.kind) {
    case "decision": record = { ...input, ...(event.expectHash !== undefined ? { expectHash: event.expectHash } : {}) }; break;
    case "amend": record = { kind: "ruleVersion", at: input.at, opId: input.opId, rule_id: input.rule_id,
      text: input.text, hash: typeof input.text === "string" ? textHash(input.text) : "", scope: input.scope,
      domain: input.domain === undefined ? version.record.domain : input.domain, expectHash: version.record.hash }; break;
    case "modelChange": {
      if (input.oldModel === "*" || input.newModel === "*") return { ok: true, records: [] };
      if (input.source !== "conductor" || !refR32(input.oldModel) || !refR32(input.newModel) || input.oldModel === input.newModel)
        return { ok: false, reason: "R-LRN-04: observed conductor model change required" };
      const qualification = version.qualifications.get(input.newModel);
      const oldState = version.qualifications.get(input.oldModel)?.state;
      if (oldState === undefined && version.qualifications.has("*")) return { ok: true, records: [] };
      const noActiveQualification = oldState === "candidate" || oldState === "quarantined" || oldState === "review_due";
      if (!noActiveQualification && qualification && qualification.state !== "candidate") return { ok: true, records: [] };
      const deadline = Date.parse(input.at) + 30 * 86400000;
      record = { kind: "quarantine", at: input.at, opId: input.opId, rule_id: input.rule_id, hash: version.record.hash,
        oldModel: input.oldModel, newModel: input.newModel, conversationRef: input.conversationRef, sessionRef: input.sessionRef,
        observationRef: input.observationRef, reviewDueAt: new Date(deadline).toISOString(),
        ...(noActiveQualification ? { reason: "no-active-qualification" as const } : {}) }; break;
    }
    case "reviewDue": record = { ...input, hash: version.record.hash }; break;
    default: return { ok: false, reason: "R-LRN-02: unknown transition" };
  }
  if (!isLearningRecord(record)) return { ok: false, reason: "R-LRN-01 R-LRN-06: malformed record" };
  const reason = recordFailureR28(state, record);
  return reason ? { ok: false, reason } : { ok: true, records: [structuredClone(record)] };
}

export function selectDelivery(state: LearningState, target: { model: string; scope: string }, cap = 15): DeliverySelection {
  if (!Number.isInteger(cap) || cap < 0 || cap > 15) throw new RangeError("R-LRN-05: cap must be an integer from 0 to 15");
  const eligible: Array<DeliverySelection["rules"][number] & { promotedAt: string }> = [];
  for (const [ruleId, rule] of state.rules) {
    const version = rule.versions.at(-1)!;
    const modelQualification = version.qualifications.get(target.model);
    const qualification = modelQualification?.state === "active" ? modelQualification : version.qualifications.get("*");
    // R-LRN-05: an older active version must not bypass the current version's qualification or scope.
    if (qualification?.state !== "active" || version.record.scope !== target.scope) continue;
    eligible.push({ ruleId, hash: version.record.hash, text: version.record.text, domain: version.record.domain, promotedAt: qualification.promotedAt! });
  }
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  eligible.sort((left, right) => compare(left.promotedAt, right.promotedAt) || compare(left.ruleId, right.ruleId));
  const rules = eligible.slice(0, cap).map(({ ruleId, hash, text, domain }) => ({ ruleId, hash, text, domain }));
  return { rules, setHash: textHash(rules.map(rule => `${rule.ruleId}:${rule.hash}`).join("\n")), overflow: eligible.length - rules.length };
}

export function renderDeliverySection(selection: DeliverySelection): string {
  if (!selection.rules.length) return "";
  return ["Learned rules:", ...selection.rules.map(rule => `[${rule.domain}] ${rule.ruleId}: ${normalizeText(rule.text).replace(/[\n\u2028\u2029]+/g, " ")}`)].join("\n");
}
