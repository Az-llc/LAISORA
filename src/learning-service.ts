import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readLearning, appendLearning } from "./learning-store";
import { admitModelProfile, admitTransition, applyAdmittedRecords, isLearningRecord, modelProfileHash, recordCandidate, restoreState, textHash, validateLearningInput,
  type LearningRecord, type LearningRecordInput, type LearningRefusalCode, type LearningState, type LearningTransition, type ModelProfileContext, type QualificationState } from "./learning";

export type LearningResult = {
  ok: true; status: "recorded" | "unchanged"; kind: LearningRecordInput["kind"]; model: string; hash: string;
  opIds: string[]; nextPrompt: "next-start" | "withheld"; qualification?: QualificationState;
} | { ok: false; code: LearningRefusalCode | "disabled" | "caller-unverified" | "store-error"; requirement: string; field?: string };
export interface LearningWriterContext {
  enabled: boolean; rootVerified: boolean; conversationRef: string; scope: string;
  knownModels: ModelProfileContext["knownModels"]; unresolvedModels?: ModelProfileContext["knownModels"]; sourceRefs: readonly string[];
}
type Store = { read: typeof readLearning; append: typeof appendLearning };
type Request = { fingerprint: string; result?: LearningResult };
const services = new Map<string, LearningService>();

export function sharedLearningService(file: string): LearningService {
  const absolute = resolve(file);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  let service = services.get(key);
  if (!service) { service = new LearningService(absolute); services.set(key, service); }
  return service;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const storeError = (): LearningResult => ({ ok: false, code: "store-error", requirement: "R-LRN-07" });

export class LearningService {
  private current?: LearningState;
  private queue: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  private confirmed = false;
  private pending?: { records: LearningRecord[]; request?: Request; result?: LearningResult };
  private readonly requests = new Map<string, Request>();
  skipped = 0;

  constructor(private readonly file: string, private readonly store: Store = { read: readLearning, append: appendLearning }) {}
  get state(): LearningState | undefined { return this.current; }
  get consistent(): boolean { return !!this.current && !this.uncertain; }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  load(): Promise<boolean> { return this.serial(() => this.current && !this.uncertain ? Promise.resolve(true) : this.read()); }
  reload(): Promise<boolean> { return this.serial(() => this.read()); }

  private async read(): Promise<boolean> {
    try {
      const read = await this.store.read(this.file);
      const restored = restoreState(read.records);
      const skipped = read.skipped + restored.skipped.length;
      const confirmed = this.confirmed ? this.current : undefined;
      if (read.incompleteTail || read.incompleteBatch || confirmed && skipped !== this.skipped) return this.unsettled(restored);
      if (confirmed) {
        for (const [id, record] of confirmed.records) {
          if (!isDeepStrictEqual(restored.records.get(id), record)) return this.unsettled(restored);
        }
      }
      if (this.pending) {
        const { records, request, result } = this.pending;
        const present = records.filter(record => isDeepStrictEqual(restored.records.get(record.opId), record)).length;
        if (present !== 0 && present !== records.length || records.some(record => restored.records.has(record.opId)
          && !isDeepStrictEqual(restored.records.get(record.opId), record))) return this.unsettled(restored);
        if (request) request.result = present === records.length ? result : undefined;
      }
      if (this.current) Object.assign(this.current, restored);
      else this.current = restored;
      this.pending = undefined;
      this.skipped = skipped;
      this.uncertain = false;
      this.confirmed = true;
      return true;
    } catch { this.uncertain = true; return false; }
  }

  private unsettled(restored: LearningState): false {
    if (!this.confirmed) {
      if (this.current) Object.assign(this.current, restored);
      else this.current = restored;
    }
    this.uncertain = true;
    return false;
  }

  private async persist(records: LearningRecord[], request?: Request, result?: LearningResult): Promise<boolean> {
    if (!this.current || this.uncertain) return false;
    if (!records.every(isLearningRecord)) return false;
    const preview = restoreState([...this.current.records.values(), ...records]);
    if (preview.skipped.length
      || records.some(record => !isDeepStrictEqual(preview.records.get(record.opId), record))) return false;
    try { await this.store.append(this.file, records); }
    catch {
      this.pending = { records, request, result };
      this.uncertain = true;
      return false;
    }
    applyAdmittedRecords(this.current, records);
    return true;
  }

  transition(transition: LearningTransition): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.serial(async () => {
      if (!this.current || this.uncertain) return { ok: false, reason: "R-LRN-07: store-error" };
      const admitted = admitTransition(this.current, transition);
      if (!admitted.ok) return admitted;
      return await this.persist(admitted.records) ? { ok: true } : { ok: false, reason: "R-LRN-07: store-error" };
    });
  }

  record(input: unknown, context: LearningWriterContext): Promise<LearningResult> {
    const submitted = structuredClone(input), writer = structuredClone(context);
    return this.serial(async () => {
      if (!writer.enabled) return { ok: false, code: "disabled", requirement: "R-LRN-07" };
      if (!writer.rootVerified) return { ok: false, code: "caller-unverified", requirement: "R-LRN-12" };
      const validated = validateLearningInput(submitted);
      if (!validated.ok) return { ok: false, code: validated.code, requirement: validated.requirement, ...(validated.field ? { field: validated.field } : {}) };
      const requestId = submitted && typeof submitted === "object" && "requestId" in submitted ? submitted.requestId : undefined;
      const key = digest([writer.conversationRef, requestId]);
      const fingerprint = digest(submitted), prior = this.requests.get(key);
      if (prior && prior.fingerprint !== fingerprint) return { ok: false, code: "request-conflict", requirement: "R-LRN-12" };
      if (prior?.result) return structuredClone(prior.result);
      if (!this.current || this.uncertain) return storeError();
      const value = validated.input;
      const request = prior ?? { fingerprint };
      this.requests.set(key, request);
      const base = { at: new Date().toISOString(), opId: key };
      const admitted = value.kind === "candidate"
        ? recordCandidate(this.current, value, { ...base, scope: writer.scope, sourceRefs: writer.sourceRefs,
          knownModels: writer.knownModels.map(model => model.model), unresolvedModels: writer.unresolvedModels?.map(model => model.model) })
        : admitModelProfile(this.current, value, { ...base, knownModels: writer.knownModels, unresolvedModels: writer.unresolvedModels });
      if (!admitted.ok) {
        request.result = { ok: false, code: admitted.code, requirement: admitted.requirement, ...(admitted.field ? { field: admitted.field } : {}) };
        return structuredClone(request.result);
      }
      const { subject: _subject, ...content } = value;
      const model = value.kind === "candidate" && value.binding === "general" ? "*" : value.model!;
      const preview = restoreState([...this.current.records.values(), ...admitted.records]);
      const control = [...preview.records.values()].filter(record => record.kind === "control").at(-1);
      const result: LearningResult = { ok: true, status: admitted.records.length ? "recorded" : "unchanged", kind: value.kind, model,
        hash: content.kind === "candidate" ? textHash(content.text) : modelProfileHash(content), opIds: admitted.records.map(record => record.opId),
        nextPrompt: control?.autoApply === false ? "withheld" : "next-start",
        ...(value.kind === "candidate" ? { qualification: preview.rules.get(value.ruleId)?.versions.at(-1)?.qualifications.get(model)?.state } : {}) };
      if (!await this.persist(admitted.records, request, result)) return storeError();
      request.result = result;
      return structuredClone(result);
    });
  }
}
