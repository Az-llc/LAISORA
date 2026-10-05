import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeSettingsFiles } from "./claude-env";
import { privateTextR06, singleLineR10, textHash } from "./learning";
import { itemIdOf, type ClaimRecord, type ClaimRun, type LedgerV2Record } from "./learning-episodes";
import { LearningLedger, readCompleteLines, decodeLedgerRecord } from "./learning-ledger";
import { hookEntriesOf, isInsideFolder, pathTokens, resolveMentionedPath } from "./learning-project";
import { realPathOrNearestSync, resolveNearestRealPathSync } from "./path-containment";
import { EXECUTORS, claudeModelIdLabel, type ExternalModels } from "./orchestration-executors";
import type { OrchestrationRunRecord } from "./orchestration-external";

export const OBSERVATION_RECORD_CAP_PER_CONVERSATION = 8;
export const CLAIM_TEXT_CAP = 300;
export const PROPOSAL_TEXT_CAP = 500;
export const PUBLIC_SOURCE_CAP = 3;
export const RECORD_REF_ALPHABET = "[A-Za-z0-9._:-]";
export const RECORD_REF_MAX_LENGTH = 200;
export const PUBLIC_SOURCE_URL_MAX_LENGTH = 512;
export type LearningToolKind = "observe" | "propose" | "public";
export type LearningRecordResult = { ok: true; status: "recorded" | "unchanged"; kind: LearningToolKind; opIds: string[] }
  | { ok: false; code: "caller-unverified" | "state-unavailable" | "rate-cap" | "invalid-evidence" | "missing-field" | "invalid-value"
    | "unknown-field" | "unknown-target" | "unresolved-alias" | "text-over-cap" | "private-content" | "project-knowledge" | "project-test-unavailable"
    | "unknown-reference" | "request-conflict" | "store-error"; requirement: string; field?: string; destination?: string };
type Refusal = Extract<LearningRecordResult, { ok: false }>;
export interface RecordingContext {
  rootVerified: boolean; ready: boolean; conversation?: string; session: string; project: string; conductorModel: string;
  cwd: string; models?: ExternalModels; roles: ReadonlySet<string>; runs: readonly OrchestrationRunRecord[];
  research?: { id: string; targets: readonly { executor: string; model: string }[] };
  ref: (domain: string, value: string) => string;
  now?: string;
}
interface ClaimInput {
  executor: "claude" | "codex" | "agy"; model: string; effort: string; role: string; text: string;
  sources?: { url: string; checkedAt: string }[]; figures?: string;
}
interface Proposal { kind: "proposal"; v: 2; at: string; opId: string; conversation: string; requestId: string; inputHash: string; text: string }
const queues = new Map<string, Promise<unknown>>();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const RECORD_REF_PATTERN = new RegExp(`^${RECORD_REF_ALPHABET}{1,${RECORD_REF_MAX_LENGTH}}$`);
const ref = (v: unknown): v is string => typeof v === "string" && RECORD_REF_PATTERN.test(v);
const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const refuse = (code: Refusal["code"], requirement = "R-LRN-12", field?: string): Refusal => ({ ok: false, code, requirement, ...(field ? { field } : {}) });
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
function shape(v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): Refusal | undefined {
  const missing = required.find(k => v[k] === undefined);
  if (missing) return refuse("missing-field", "R-LRN-12", missing);
  if (Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) return refuse("unknown-field");
  return undefined;
}
export type ProjectClaimTest = "project" | "general" | "unverifiable";
export function projectClaimText(text: string, cwd: string): ProjectClaimTest {
  const root = realPathOrNearestSync(cwd);
  if (!root) return "unverifiable";
  let unreadable = false;
  const mentionedReal = (candidate: string): string | undefined => {
    try { statSync(candidate); } catch (error) {
      unreadable ||= !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
      return undefined;
    }
    const result = resolveNearestRealPathSync(candidate);
    if ("path" in result) return result.path;
    unreadable = true;
    return undefined;
  };
  if (pathTokens(text).some(token => {
    const candidate = resolveMentionedPath(token, cwd, homedir(), process.platform);
    const real = candidate ? mentionedReal(candidate) : undefined;
    return !!real && isInsideFolder(root, real, process.platform);
  })) return "project";
  if (existsSync(join(cwd, "package.json")) && /\b(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+[^\s]+/i.test(text)) return "project";
  for (const file of claudeSettingsFiles(cwd)) {
    let hooks: ReturnType<typeof hookEntriesOf>;
    try {
      hooks = hookEntriesOf(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      unreadable ||= (error as NodeJS.ErrnoException).code !== "ENOENT";
      continue;
    }
    if (hooks.some(hook => hook.commands.some(command => command.trim().length > 0 && text.includes(command.trim())))) return "project";
  }
  return unreadable ? "unverifiable" : "general";
}
function line(value: unknown, field: string, cap: number, cwd: string): Refusal | undefined {
  if (typeof value !== "string" || !value.trim()) return refuse("invalid-value", "R-LRN-12", field);
  const project = field === "text" ? projectClaimText(value, cwd) : "general";
  if (project === "project") return { ...refuse("project-knowledge", "R-LRN-15", "text"),
    destination: "permanent controls: the project's .claude/rules; facts: Claude Code auto memory" };
  if (project === "unverifiable") return refuse("project-test-unavailable", "R-LRN-15", "text");
  if (privateTextR06(value)) return refuse("private-content", "R-LRN-06", field);
  if (!singleLineR10(value, cap)) return refuse([...value].length > cap ? "text-over-cap" : "invalid-value", "R-LRN-12", field);
  return undefined;
}
function claimInput(v: unknown, kind: "observe" | "public", context: RecordingContext): Refusal | undefined {
  if (!object(v)) return refuse("invalid-value", "R-LRN-24", "claims");
  const fields = ["executor", "model", "effort", "role", "text", ...(kind === "observe" ? ["requestId"] : ["sources"])];
  const malformed = shape(v, fields, kind === "public" ? ["figures"] : []);
  if (malformed) return malformed;
  if (typeof v.role === "string" && v.role.includes("/")) return refuse("unknown-target", "R-LRN-31", "role");
  for (const field of ["executor", "model", "effort", "role"]) if (!ref(v[field])) return refuse("invalid-value", "R-LRN-12", field);
  if (!["claude", "codex", "agy"].includes(String(v.executor))) return refuse("unknown-target", "R-LRN-31", "executor");
  const executor = v.executor as ClaimInput["executor"];
  if (executor === "claude" && /^(?:default|opus|sonnet|haiku)(?:\[1m\])?$/i.test(String(v.model))) return refuse("unresolved-alias", "R-LRN-24", "model");
  const list = context.models?.[executor];
  const models = list?.state === "ok" ? EXECUTORS[executor].models(list) : [];
  const nameOf = (model: string) => executor === "claude" ? claudeModelIdLabel(list?.state === "ok" ? list.models.find(row => row.id === model)?.resolvedModel ?? model : model) : model;
  if (!models?.some(m => nameOf(m.model) === v.model))
    return refuse("unknown-target", "R-LRN-31", "model");
  const model = models.find(m => nameOf(m.model) === v.model)!;
  const efforts = model.efforts ?? [];
  if (!(kind === "public" && v.effort === "any") && !(efforts.length ? efforts.includes(v.effort as never) : v.effort === "none")) return refuse("unknown-target", "R-LRN-31", "effort");
  if (v.role !== "general" && (!context.roles.has(String(v.role)) || v.role === "child" || v.role === "unknown" || String(v.role).includes(":"))) return refuse("unknown-target", "R-LRN-31", "role");
  const badText = line(v.text, "text", CLAIM_TEXT_CAP, context.cwd);
  if (badText) return badText;
  if (/https?:\/\//i.test(v.text as string)) return refuse("invalid-value", "R-LRN-24", "text");
  if (kind === "observe") {
    if ((v.text as string).split(" -> ").length !== 3 || (v.text as string).split(" -> ").some(part => !part.trim())) return refuse("invalid-value", "R-LRN-23", "text");
  } else {
    if (/\p{N}/u.test(v.text as string)) return refuse("invalid-value", "R-LRN-24", "text");
    if (v.figures !== undefined) { const invalid = line(v.figures, "figures", CLAIM_TEXT_CAP, context.cwd); if (invalid) return invalid; }
    if (!Array.isArray(v.sources) || !v.sources.length || v.sources.length > PUBLIC_SOURCE_CAP) return refuse("invalid-value", "R-LRN-24", "sources");
    for (const source of v.sources) {
      if (!object(source)) return refuse("invalid-value", "R-LRN-24", "sources");
      const invalid = shape(source, ["url", "checkedAt"]); if (invalid) return invalid;
      if (typeof source.url === "string" && privateTextR06(source.url)) return refuse("private-content", "R-LRN-06", "url");
      if (!iso(source.checkedAt) || source.checkedAt > (context.now ?? new Date().toISOString())) return refuse("invalid-value", "R-LRN-24", "checkedAt");
      if (typeof source.url !== "string" || source.url.length > PUBLIC_SOURCE_URL_MAX_LENGTH || !/^https:\/\//.test(source.url) || /[\s\\?#]/.test(source.url)) return refuse("invalid-value", "R-LRN-24", "url");
      try {
        const url = new URL(source.url), host = url.hostname.toLowerCase().replace(/\.$/, "");
        if (url.username || url.password || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")
          || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)) return refuse("invalid-value", "R-LRN-24", "url");
      } catch { return refuse("invalid-value", "R-LRN-24", "url"); }
    }
  }
  return undefined;
}

export function observationEvidence(context: RecordingContext, target: ClaimInput, at: string): ClaimRun[] | Refusal {
  const last = new Map<string, OrchestrationRunRecord>();
  for (const run of context.runs) {
    if (!run.runId || run.conversation !== context.conversation) continue;
    const key = run.kind === "agent" ? `agent:${run.agent_id}` : run.runId;
    const prior = last.get(key);
    if (prior?.kind === "agent" && run.kind === "agent" && (prior.segment ?? 0) > (run.segment ?? 0)) continue;
    last.set(key, run);
  }
  const evidence: ClaimRun[] = [];
  for (const run of last.values()) {
    const executor = run.kind === "agent" ? "claude" : run.executor;
    const model = run.kind === "agent" ? run.model : run.observedModel;
    const effort = run.kind === "agent" ? run.effort : run.observedEffort;
    const ended = run.kind === "agent" ? run.lastActivityAt : run.endedAt;
    const started = run.kind === "agent" ? run.firstSeenAt : run.startedAt;
    const attested = run.kind === "agent" ? run.confirmedAt && run.outcomeEvidence?.length && run.outcome !== "unknown"
      : run.attestation && run.attestation.source === "codex-turn-context" && run.attestation.model === model && run.attestation.effort === effort;
    if (!attested || executor !== target.executor || model !== target.model || effort !== target.effort || target.role !== "general" && run.role !== target.role) continue;
    if (!iso(started) || !iso(ended) || ended < started || ended > at || run.kind === "agent" && (!iso(run.confirmedAt) || run.confirmedAt < ended || run.confirmedAt > at)) return refuse("invalid-evidence", "R-LRN-23");
    evidence.push({ runId: run.runId!, endAt: ended });
  }
  return [...new Map(evidence.map(run => [run.runId, run])).values()];
}

function decodeProposal(v: unknown): Proposal | undefined {
  if (!object(v) || v.kind !== "proposal" || v.v !== 2 || !iso(v.at) || ![v.opId, v.conversation, v.requestId].every(ref)
    || typeof v.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(v.inputHash) || typeof v.text !== "string"
    || !singleLineR10(v.text, PROPOSAL_TEXT_CAP) || privateTextR06(v.text)
    || Object.keys(v).some(k => !["kind", "v", "at", "opId", "conversation", "requestId", "inputHash", "text"].includes(k))) return undefined;
  return v as unknown as Proposal;
}

export class LearningRecorder {
  constructor(private readonly ledger: LearningLedger) {}
  record(kind: LearningToolKind, input: unknown, context: RecordingContext): Promise<LearningRecordResult> {
    const value = structuredClone(input);
    const writer = { ...context, roles: new Set(context.roles), runs: structuredClone(context.runs), models: structuredClone(context.models), research: structuredClone(context.research) };
    const key = resolve(this.ledger.directory).toLowerCase();
    const next = (queues.get(key) ?? Promise.resolve()).then(() => this.recordSerial(kind, value, writer));
    queues.set(key, next.catch(() => undefined));
    return next;
  }
  private async recordSerial(kind: LearningToolKind, input: unknown, context: RecordingContext): Promise<LearningRecordResult> {
    if (!context.rootVerified) return refuse("caller-unverified");
    if (!object(input)) return refuse("invalid-value");
    const required = kind === "observe" ? ["requestId", "executor", "model", "effort", "role", "text"] : kind === "propose" ? ["requestId", "text"] : ["requestId", "research", "claims"];
    const malformed = shape(input, required); if (malformed) return malformed;
    if (!ref(input.requestId)) return refuse("invalid-value", "R-LRN-12", "requestId");
    if (privateTextR06(input.requestId)) return refuse("private-content", "R-LRN-06", "requestId");
    if (!context.ready || !context.conversation) return refuse("state-unavailable", "R-LRN-45");
    const at = context.now ?? new Date().toISOString();
    const inputHash = textHash(canonical({ kind, ...input }));
    const requestId = context.ref("request", input.requestId);
    const request = textHash(canonical([context.conversation, kind, requestId]));
    const success = (opIds: string[], unchanged: boolean): LearningRecordResult => ({ ok: true, status: unchanged ? "unchanged" : "recorded", kind, opIds });
    try {
      if (kind === "propose") {
        const invalid = line(input.text, "text", PROPOSAL_TEXT_CAP, context.cwd); if (invalid) return invalid;
        const file = join(this.ledger.directory, "proposals.jsonl");
        const existing = await readCompleteLines(file, 0, decodeProposal);
        if (existing.incompleteTail || existing.skipped) return refuse("state-unavailable", "R-LRN-12");
        const prior = existing.records.find(r => r.conversation === context.conversation && r.requestId === requestId);
        if (prior) return prior.inputHash === inputHash ? success([prior.opId], true) : refuse("request-conflict");
        await mkdir(this.ledger.directory, { recursive: true });
        await appendFile(file, `${JSON.stringify({ kind: "proposal", v: 2, at, opId: request, conversation: context.conversation,
          requestId, inputHash, text: input.text })}\n`, "utf8");
        return success([request], false);
      }
      const submitted = kind === "observe" ? [input] : input.claims;
      if (!Array.isArray(submitted) || !submitted.length) return refuse("invalid-value", "R-LRN-24", "claims");
      for (const claim of submitted) { const invalid = claimInput(claim, kind, context); if (invalid) return invalid; }
      await this.ledger.reload(true);
      const state = this.ledger.state;
      if (!this.ledger.consistent || this.ledger.skipped || state.unavailableConversations.has(context.conversation)) return refuse("state-unavailable", "R-LRN-45");
      const all = [...state.records.values()];
      const prior = all.filter(r => (r.kind === "claim" || r.kind === "research-complete") && r.conversation === context.conversation && r.requestId === requestId);
      if (prior.some(r => (r.kind === "claim" || r.kind === "research-complete") && r.inputHash !== inputHash)) return refuse("request-conflict");
      if (kind === "observe" && prior.length) return success(prior.map(r => r.opId), true);
      if (kind === "observe" && (state.requests.get(context.conversation)?.size ?? 0) >= OBSERVATION_RECORD_CAP_PER_CONVERSATION) return refuse("rate-cap", "R-LRN-23");
      if (kind === "public") {
        if (!ref(input.research)) return refuse("invalid-value", "R-LRN-24", "research");
        const recovery = all.filter(r => (r.kind === "claim" || r.kind === "research-complete") && r.conversation === context.conversation && r.research === input.research);
        if (recovery.some(r => (r.kind === "claim" || r.kind === "research-complete") && (r.inputHash !== inputHash || r.requestId !== requestId))) return refuse("request-conflict");
        if (context.research?.id !== input.research && !recovery.length) return refuse("unknown-reference", "R-LRN-37", "research");
        if (context.research?.id === input.research && submitted.some(c => !context.research!.targets.some(t => t.executor === c.executor && t.model === c.model))) return refuse("unknown-target", "R-LRN-37", "model");
      }
      const originalAt = prior[0]?.at ?? at;
      const records: ClaimRecord[] = [];
      for (const [index, raw] of submitted.entries()) {
        const claim = raw as ClaimInput;
        const hash = textHash(claim.text), source = kind === "observe" ? "observation" : "public";
        const itemId = itemIdOf(source, claim, hash);
        if (records.some(r => r.itemId === itemId)) return refuse("invalid-value", "R-LRN-24", "claims");
        const evidence = kind === "observe" ? observationEvidence(context, claim, at) : [];
        if (!Array.isArray(evidence)) return evidence;
        const credited = new Set(all.flatMap(r => r.kind === "claim" && r.itemId === itemId ? r.evidence.runs.map(run => run.runId) : []));
        records.push({ kind: "claim", v: 2, at: originalAt, opId: textHash(`${request}:${index}`), source,
          executor: claim.executor, model: claim.model, effort: claim.effort, role: claim.role, text: claim.text, hash, itemId,
          evidence: { runs: evidence, creditedRunIds: evidence.filter(run => !credited.has(run.runId)).map(run => run.runId) },
          conversation: context.conversation, session: prior.find(r => r.kind === "claim")?.kind === "claim" ? (prior.find(r => r.kind === "claim") as ClaimRecord).session : context.session,
          requestId, inputHash, conductorModel: claudeModelIdLabel(context.conductorModel), project: context.project,
          ...(kind === "public" ? { research: input.research as string, sources: claim.sources, ...(claim.figures !== undefined ? { figures: claim.figures } : {}) } : {}) });
      }
      const additions: LedgerV2Record[] = [...records];
      if (kind === "public") additions.push({ kind: "research-complete", v: 2, at: originalAt, opId: textHash(`${request}:complete`),
        research: input.research as string, conversation: context.conversation, requestId, inputHash,
        items: records.map(r => ({ itemId: r.itemId, hash: r.hash })) });
      if (additions.some(record => !decodeLedgerRecord(record))) return refuse("store-error", "R-LRN-07");
      let written = false;
      for (const record of additions) {
        const existing = state.records.get(record.opId);
        if (existing) {
          if ((existing.kind !== "claim" && existing.kind !== "research-complete") || existing.inputHash !== inputHash) return refuse("request-conflict");
          continue;
        }
        await this.ledger.append(record); written = true;
      }
      return success(additions.map(r => r.opId), !written);
    } catch { return refuse("store-error", "R-LRN-07"); }
  }
}
