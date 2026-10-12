import { MEMORY_DESTINATION } from "./placement-line";
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeSettingsFiles } from "./claude-env";
import { privateTextR06, singleLineR10, textHash } from "./learning";
import { correctionTimes, qualifyClaims, shortItemId, itemIdOf, type ClaimRecord, type ClaimRun, type CorrectionRecord, type LedgerV2Record, type RosterTarget } from "./learning-episodes";
import { LearningLedger, readCompleteLines, decodeLedgerRecord } from "./learning-ledger";
import { hookEntriesOf, isInsideFolder, pathTokens, resolveMentionedPath } from "./learning-project";
import { realPathOrNearestSync, resolveNearestRealPathSync } from "./path-containment";
import { EXECUTORS, claudeModelIdLabel, type ExternalModels } from "./orchestration-executors";
import { learningClaimTargets } from "./learning-delivery";
import { resolveClaudeProfileModel } from "./orchestration-profiles";
import type { OrchestrationRow } from "./orchestration-roster";
import { attestedExternalRun, type OrchestrationRunRecord } from "./orchestration-external";

export const OBSERVATION_RECORD_CAP_PER_CONVERSATION = 8;
export const CLAIM_TEXT_CAP = 300;
export const PROPOSAL_TEXT_CAP = 500;
export const RECORD_REF_ALPHABET = "[A-Za-z0-9._:-]";
export const RECORD_REF_MAX_LENGTH = 200;
export type LearningToolKind = "observe" | "propose" | "correct";
export type LearningRecordResult = { ok: true; status: "recorded" | "unchanged"; kind: LearningToolKind; opIds: string[] }
  | { ok: false; code: "caller-unverified" | "state-unavailable" | "rate-cap" | "invalid-evidence" | "missing-field" | "invalid-value"
    | "unknown-field" | "unknown-target" | "unresolved-alias" | "text-over-cap" | "private-content" | "project-knowledge" | "project-test-unavailable"
    | "unknown-reference" | "unknown-item" | "retracted" | "no-model-work" | "request-conflict" | "store-error"; message?: string; requirement: string; field?: string; destination?: string };
type Refusal = Extract<LearningRecordResult, { ok: false }>;
export interface RecordingContext {
  rootVerified: boolean; ready: boolean; conversation?: string; session: string; project: string; conductorModel: string;
  cwd: string; models?: ExternalModels; roster: readonly OrchestrationRow[]; targets: readonly RosterTarget[]; roles: ReadonlySet<string>; runs: readonly OrchestrationRunRecord[];
  ref: (domain: string, value: string) => string;
  now?: string;
  loadRuns?: () => Promise<readonly OrchestrationRunRecord[]>;
}
interface ClaimInput {
  executor: "claude" | "codex" | "agy"; model: string; effort: string; role: string; text: string;
}
interface Proposal { kind: "proposal"; v: 2; at: string; opId: string; conversation: string; requestId: string; inputHash: string; text: string }
const queues = new Map<string, Promise<unknown>>();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const RECORD_REF_PATTERN = new RegExp(`^${RECORD_REF_ALPHABET}{1,${RECORD_REF_MAX_LENGTH}}$`);
const ref = (v: unknown): v is string => typeof v === "string" && RECORD_REF_PATTERN.test(v);
const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const refuse = (code: Refusal["code"], requirement = "R-LRN-12", field?: string): Refusal => ({ ok: false, code, requirement, ...(field ? { field } : {}),
  ...(code === "no-model-work" ? { message: "Environment or startup failures are not model behavior and belong in project records." } : {}) });
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
  const project = projectClaimText(value, cwd);
  if (project === "project") return { ...refuse("project-knowledge", "R-LRN-15", field),
    destination: `permanent controls: the project's .claude/rules; ${MEMORY_DESTINATION}` };
  if (project === "unverifiable") return refuse("project-test-unavailable", "R-LRN-15", field);
  if (privateTextR06(value)) return refuse("private-content", "R-LRN-06", field);
  if (!singleLineR10(value, cap)) return refuse([...value].length > cap ? "text-over-cap" : "invalid-value", "R-LRN-12", field);
  return undefined;
}
function claimInput(v: Record<string, unknown>, context: RecordingContext): Refusal | undefined {
  const malformed = shape(v, ["requestId", "executor", "model", "effort", "role", "text", "runs"]);
  if (malformed) return malformed;
  if (typeof v.role === "string" && v.role.includes("/")) return refuse("unknown-target", "R-LRN-31", "role");
  for (const field of ["executor", "model", "effort", "role"]) if (!ref(v[field])) return refuse("invalid-value", "R-LRN-12", field);
  if (!["claude", "codex", "agy"].includes(String(v.executor))) return refuse("unknown-target", "R-LRN-31", "executor");
  const executor = v.executor as ClaimInput["executor"];
  if (executor === "claude" && /^(?:default|opus|sonnet|haiku)(?:\[1m\])?$/i.test(String(v.model))) return refuse("unresolved-alias", "R-LRN-23", "model");
  const list = context.models?.[executor];
  const models = list?.state === "ok" ? EXECUTORS[executor].models(list) : [];
  const nameOf = (model: string) => executor === "claude" ? claudeModelIdLabel(resolveClaudeProfileModel(model, context.models) ?? "unknown") : model;
  const model = models?.find(m => nameOf(m.model) === v.model);
  if (!model) return refuse("unknown-target", "R-LRN-31", "model");
  const efforts = model.efforts ?? [];
  if (!(efforts.length ? efforts.includes(v.effort as never) : v.effort === "none")) return refuse("unknown-target", "R-LRN-31", "effort");
  if (v.role !== "general" && (!context.roles.has(String(v.role)) || v.role === "child" || v.role === "unknown" || String(v.role).includes(":"))) return refuse("unknown-target", "R-LRN-31", "role");
  const badText = line(v.text, "text", CLAIM_TEXT_CAP, context.cwd);
  if (badText) return badText;
  if (/https?:\/\//i.test(v.text as string)) return refuse("invalid-value", "R-LRN-23", "text");
  if ((v.text as string).split(" -> ").length !== 3 || (v.text as string).split(" -> ").some(part => !part.trim())) return refuse("invalid-value", "R-LRN-23", "text");
  return undefined;
}

export function observationEvidence(context: RecordingContext, target: Partial<Pick<ClaimInput, "executor" | "model" | "effort" | "role">>,
  at: string, references: unknown, requireWork = true): ClaimRun[] | Refusal {
  if (!Array.isArray(references) || references.length < 1 || references.length > 8 || !references.every(ref)) return refuse("invalid-evidence", "R-LRN-23", "runs");
  const last = new Map<string, OrchestrationRunRecord>();
  for (const run of context.runs) {
    if (!run.runId || run.conversation !== context.conversation) continue;
    const key = run.kind === "agent" ? "agent:" + run.agent_id : "external:" + run.runId;
    const prior = last.get(key);
    if (prior?.kind === "agent" && run.kind === "agent" && ((prior.segment ?? 0) > (run.segment ?? 0)
      || (prior.segment ?? 0) === (run.segment ?? 0) && prior.lastActivityAt > run.lastActivityAt)) continue;
    last.set(key, run);
  }
  const cited: OrchestrationRunRecord[] = [];
  for (const reference of new Set(references as string[])) {
    const matches = [...last.values()].filter(run => (run.kind === "agent" ? run.agent_id : run.runId) === reference);
    if (matches.length !== 1) return refuse("invalid-evidence", "R-LRN-23", "runs");
    const run = matches[0], executor = run.kind === "agent" ? "claude" : run.executor;
    const observedModel = run.kind === "agent" ? run.model : run.observedModel;
    const observedEffort = run.kind === "agent" ? run.effort : run.observedEffort;
    const model = observedModel && observedModel !== "unknown" ? observedModel : run.requestedModel;
    const effort = observedEffort && observedEffort !== "unknown" ? observedEffort : run.requestedEffort;
    if (target.executor !== undefined && executor !== target.executor || target.model !== undefined && model !== target.model
      || target.effort !== undefined && effort !== target.effort || target.role !== undefined && target.role !== "general" && run.role !== target.role)
      return refuse("invalid-evidence", "R-LRN-23", "runs");
    cited.push(run);
  }
  if (requireWork && !cited.some(run => run.kind === "agent" ? run.outcome === "normal" : run.outcome === "ok" && (run.usage?.output_tokens ?? 0) > 0))
    return refuse("no-model-work", "R-LRN-23");
  const evidence: ClaimRun[] = [];
  for (const run of cited) {
    const executor = run.kind === "agent" ? "claude" : run.executor;
    const model = run.kind === "agent" ? run.model : run.observedModel;
    const effort = run.kind === "agent" ? run.effort : run.observedEffort;
    const ended = run.kind === "agent" ? run.lastActivityAt : run.endedAt;
    const started = run.kind === "agent" ? run.firstSeenAt : run.startedAt;
    const attested = run.kind === "agent" ? run.confirmedAt && run.outcomeEvidence?.length && run.outcome !== "unknown"
      : attestedExternalRun(run);
    if (!attested || !model || model === "unknown" || !effort || effort === "unknown"
      || target.executor !== undefined && executor !== target.executor || target.model !== undefined && model !== target.model
      || target.effort !== undefined && effort !== target.effort || target.role !== undefined && target.role !== "general" && run.role !== target.role)
      return refuse("invalid-evidence", "R-LRN-23", "runs");
    if (!iso(started) || !iso(ended) || ended < started || ended > at || run.kind === "agent" && (!iso(run.confirmedAt) || run.confirmedAt < ended || run.confirmedAt > at))
      return refuse("invalid-evidence", "R-LRN-23", "runs");
    evidence.push({ runId: run.runId!, endAt: ended });
  }
  return [...new Map(evidence.map(run => [run.runId, run])).values()];
}

function observationRecord(claim: ClaimInput, evidence: ClaimRun[], context: RecordingContext, at: string, requestId: string,
  inputHash: string, request: string, all: readonly LedgerV2Record[]): ClaimRecord {
  const hash = textHash(claim.text), source = "observation", itemId = itemIdOf(source, claim, hash);
  const credited = new Set(all.flatMap(r => r.kind === "claim" && r.itemId === itemId ? r.evidence.runs.map(run => run.runId) : []));
  return { kind: "claim", v: 2, at, opId: textHash(request + ":0"), source,
    executor: claim.executor, model: claim.model, effort: claim.effort, role: claim.role, text: claim.text, hash, itemId,
    evidence: { runs: evidence, creditedRunIds: evidence.filter(run => !credited.has(run.runId)).map(run => run.runId) },
    conversation: context.conversation!, session: context.session, requestId, inputHash,
    conductorModel: claudeModelIdLabel(context.conductorModel), project: context.project };
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
    const writer = { ...context, roles: new Set(context.roles), runs: structuredClone(context.runs), models: structuredClone(context.models), targets: structuredClone(context.targets), roster: structuredClone(context.roster) };
    const key = resolve(this.ledger.directory).toLowerCase();
    const next = (queues.get(key) ?? Promise.resolve()).then(() => this.recordSerial(kind, value, writer));
    queues.set(key, next.catch(() => undefined));
    return next;
  }
  private async recordSerial(kind: LearningToolKind, input: unknown, context: RecordingContext): Promise<LearningRecordResult> {
    if (!context.rootVerified) return refuse("caller-unverified");
    if (!object(input)) return refuse("invalid-value");
    const required = kind === "observe" ? ["requestId", "executor", "model", "effort", "role", "text", "runs"]
      : kind === "correct" ? ["requestId", "item", "action", "reason"] : ["requestId", "text"];
    const malformed = shape(input, required, kind === "correct" ? ["text", "runs"] : []); if (malformed) return malformed;
    if (!ref(input.requestId)) return refuse("invalid-value", "R-LRN-12", "requestId");
    if (privateTextR06(input.requestId)) return refuse("private-content", "R-LRN-06", "requestId");
    if (!context.ready || !context.conversation) return refuse("state-unavailable", "R-LRN-45");
    const loadRuns = async (): Promise<Refusal | undefined> => {
      if (!context.loadRuns || !Array.isArray(input.runs) || !input.runs.length || input.runs.length > 8 || !input.runs.every(ref)) return undefined;
      try { context.runs = await context.loadRuns(); context.loadRuns = undefined; }
      catch { return refuse("state-unavailable", "R-LRN-23"); }
      return undefined;
    };
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
      if (kind === "observe") { const invalid = claimInput(input, context); if (invalid) return invalid; }
      else {
        if (!["retract", "replace"].includes(String(input.action))) return refuse("invalid-value", "R-LRN-12", "action");
        if (typeof input.item !== "string" || !/^#[a-f0-9]{8}$/.test(input.item)) return refuse("unknown-item", "R-LRN-47");
        if (input.action === "replace" && input.text === undefined) return refuse("missing-field", "R-LRN-12", "text");
        if (input.action === "retract" && input.text !== undefined) return refuse("invalid-value", "R-LRN-12", "text");
        for (const field of input.action === "replace" ? ["reason", "text"] : ["reason"]) {
          const invalid = line(input[field], field, CLAIM_TEXT_CAP, context.cwd); if (invalid) return invalid;
        }
      }
      await this.ledger.refresh();
      const state = this.ledger.state;
      if (!this.ledger.consistent || this.ledger.skipped || state.unavailableConversations.has(context.conversation)) return refuse("state-unavailable", "R-LRN-45");
      const all = [...state.records.values()];
      const prior = all.filter(r => (r.kind === "claim" || r.kind === "research-complete" || r.kind === "correction")
        && r.conversation === context.conversation && r.requestId === requestId);
      if (prior.some(r => (r.kind === "claim" || r.kind === "research-complete" || r.kind === "correction") && r.inputHash !== inputHash)) return refuse("request-conflict");
      if (kind === "correct") {
        const accepted = prior.find((r): r is CorrectionRecord => r.kind === "correction");
        if (accepted) {
          const replacement = all.find((r): r is ClaimRecord => r.kind === "claim" && r.itemId === accepted.replacement
            && r.conversation === accepted.conversation && r.requestId === accepted.requestId && r.inputHash === accepted.inputHash);
          if (accepted.action === "retract" || replacement) return success(prior.map(r => r.opId), true);
          if (!accepted.replacementRecord) return refuse("state-unavailable", "R-LRN-45");
          await this.ledger.append(accepted.replacementRecord);
          return success([accepted.replacementRecord.opId, accepted.opId], false);
        }
        const targets = learningClaimTargets(context.roster, context.models);
        const claims = qualifyClaims(all, at, (executor, model) => targets.some(target => target.executor === executor && target.model === model), context.roles);
        const rules = state.rules;
        const candidates = [
          ...[...new Map(claims.map(claim => [claim.itemId, claim])).values()].filter(claim => shortItemId(claim.itemId) === input.item)
            .map(claim => ({ item: { type: "claim" as const, itemId: claim.itemId }, tags: { executor: claim.executor, model: claim.model, effort: claim.effort, role: claim.role } })),
          ...[...rules.values()].filter(rule => rule.active && shortItemId(rule.ruleId) === input.item && (rule.key.bind === "conductor"
            ? rule.key.model === claudeModelIdLabel(context.conductorModel)
            : context.targets.some(target => rule.key.bind === "target" && target.executor === rule.key.executor && target.model === rule.key.model
              && target.effort === rule.key.effort && target.role === rule.key.role)))
            .map(rule => ({ item: { type: "rule" as const, ruleId: rule.ruleId }, tags: rule.key.bind === "target" ? rule.key : undefined, rule })),
        ];
        if (candidates.length !== 1) return refuse("unknown-item", "R-LRN-47");
        const original = candidates[0];
        let replacement = prior.find((r): r is ClaimRecord => r.kind === "claim");
        let evidence: readonly ClaimRun[] = replacement?.evidence.runs ?? [];
        if (!replacement && (original.tags || input.runs !== undefined || input.action === "replace")) {
          const unavailable = await loadRuns(); if (unavailable) return unavailable;
          const resolved = observationEvidence(context, original.tags ? { executor: original.tags.executor as ClaimInput["executor"], model: original.tags.model } : {}, at, input.runs, input.action === "replace");
          if (!Array.isArray(resolved)) return resolved;
          evidence = resolved;
        }
        if (input.action === "replace" && !replacement) {
          let tags = original.tags;
          if (!tags && "rule" in original && original.rule.key.bind === "conductor") {
            const efforts = new Set(context.runs.filter(run => run.kind === "agent" && evidence.some(cited => cited.runId === run.runId)).map(run => run.effort));
            if (efforts.size !== 1 || ![...efforts][0]) return refuse("invalid-evidence", "R-LRN-47", "runs");
            tags = { executor: "claude", model: original.rule.key.model, effort: [...efforts][0]!, role: "general" };
          }
          if (!tags) return refuse("invalid-evidence", "R-LRN-47", "runs");
          const claim = { ...tags, text: input.text } as ClaimInput;
          const invalid = claimInput({ requestId: input.requestId, executor: claim.executor, model: claim.model, effort: claim.effort,
            role: claim.role, text: claim.text, runs: input.runs }, context);
          if (invalid) return invalid;
          const resolved = observationEvidence(context, claim, at, input.runs);
          if (!Array.isArray(resolved)) return resolved;
          replacement = observationRecord(claim, resolved, context, at, requestId, inputHash, request, all);
          if (correctionTimes(all).has("claim:" + replacement.itemId) || original.item.type === "claim" && original.item.itemId === replacement.itemId)
            return refuse("retracted", "R-LRN-47");
          if ((state.requests.get(context.conversation)?.size ?? 0) >= OBSERVATION_RECORD_CAP_PER_CONVERSATION) return refuse("rate-cap", "R-LRN-23");
        }
        const correction: CorrectionRecord = { kind: "correction", v: 2, at: replacement?.at ?? at, opId: textHash(request + ":correction"), conversation: context.conversation,
          session: context.session, requestId, inputHash, item: original.item, action: input.action as CorrectionRecord["action"], reason: input.reason as string,
          runs: evidence, ...(replacement ? { replacement: replacement.itemId, replacementRecord: replacement } : {}) };
        if (!decodeLedgerRecord(correction) || replacement && !decodeLedgerRecord(replacement)) return refuse("store-error", "R-LRN-07");
        await this.ledger.append(correction);
        if (replacement) await this.ledger.append(replacement);
        return success([...(replacement ? [replacement.opId] : []), correction.opId], false);
      }
      if (prior.length) return success(prior.map(r => r.opId), true);
      const claim = input as unknown as ClaimInput;
      const itemId = itemIdOf("observation", claim, textHash(claim.text));
      if (correctionTimes(all).has("claim:" + itemId)) return refuse("retracted", "R-LRN-47");
      if ((state.requests.get(context.conversation)?.size ?? 0) >= OBSERVATION_RECORD_CAP_PER_CONVERSATION) return refuse("rate-cap", "R-LRN-23");
      const unavailable = await loadRuns(); if (unavailable) return unavailable;
      const evidence = observationEvidence(context, claim, at, input.runs);
      if (!Array.isArray(evidence)) return evidence;
      const record = observationRecord(claim, evidence, context, at, requestId, inputHash, request, all);
      if (!decodeLedgerRecord(record)) return refuse("store-error", "R-LRN-07");
      await this.ledger.append(record);
      return success([record.opId], false);
    } catch { return refuse("store-error", "R-LRN-07"); }
  }
}
