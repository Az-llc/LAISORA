import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFile, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { deliverySetHash, episodeOpId, itemIdOf, qualifyRules, ruleIdOf, type EpisodeRecord, type LedgerV2Record, type ExperimentAssignmentRecord, type ClaimRecord } from "./learning-episodes";
import { textHash } from "./learning";
import { containsAbsolutePath } from "./path-redaction";

const ref = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
const time = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const statuses = new Set(["counted", "transient", "human", "hook", "probe", "unclassified", "project", "unknown-project", "unknown-model", "state-unavailable"]);
const episodeFields = new Set(["kind", "v", "at", "opId", "sig", "sigV", "tool", "cls", "head", "label", "labelFacts", "ruleId", "key", "conversation", "session", "recipient", "run", "dispatchId", "toolUse", "project", "status"]);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.every(ref);
const fields = (r: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every(key => r[key] !== undefined)
  && Object.keys(r).every(key => ["kind", "v", "at", "opId", ...required, ...optional].includes(key));
const itemList = (value: unknown): boolean => Array.isArray(value) && value.every(item => item && typeof item === "object"
  && Object.keys(item).length === 2 && ["rule", "claim", "measured", "notice"].includes(item.type) && ref(item.id));
const safeText = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value)
  && [...value].length <= limit && !containsAbsolutePath(value) && !/\b(?:sk-[\w-]{12,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/i.test(value);
function publicSource(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 2 || !time(source.checkedAt) || typeof source.url !== "string") return false;
  try {
    const url = new URL(source.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && !/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[|.*\.(?:local|internal)$)/i.test(url.hostname);
  } catch { return false; }
}

function decodeFact(r: Record<string, unknown>): LedgerV2Record | undefined {
  if (!ref(r.conversation)) return undefined;
  switch (r.kind) {
    case "episode-state": {
      if (!fields(r, ["conversation", "recipient", "run", "toolUse", "operation", "action"], ["sig", "episode", "status", "tool", "head"])
        || ![r.recipient, r.run, r.toolUse, r.operation].every(ref) || !["failure", "success"].includes(String(r.action))
        || r.status !== undefined && r.status !== "state-unavailable"
        || (r.action === "failure" ? typeof r.sig !== "string" || !/^[a-f0-9]{32}$/.test(r.sig) : r.sig !== undefined)) return undefined;
      if (r.episode !== undefined) {
        const episode = decodeLedgerRecord(r.episode);
        if (r.action !== "failure" || episode?.kind !== "episode" || episode.conversation !== r.conversation
          || episode.recipient !== r.recipient || episode.run !== r.run || episode.toolUse !== r.toolUse || episode.sig !== r.sig
          || episode.at !== r.at || (r.status === "state-unavailable") !== (episode.status === "state-unavailable")) return undefined;
      }
      if (r.tool !== undefined && !ref(r.tool) || r.head !== undefined && (typeof r.head !== "string" || !/^(?:|other|[a-z]+(?: [a-z][a-z0-9-]*)?)$/.test(r.head))) return undefined;
      break;
    }
    case "claim": {
      if (!fields(r, ["source", "executor", "model", "effort", "role", "text", "hash", "itemId", "evidence", "conversation", "session", "requestId", "inputHash", "conductorModel", "project"], ["research", "sources", "figures"])) return undefined;
      if (!["observation", "public"].includes(String(r.source)) || !["claude", "codex", "agy"].includes(String(r.executor))) return undefined;
      if (![r.model, r.effort, r.role, r.session, r.requestId, r.conductorModel, r.project].every(ref) || !safeText(r.text, 300) || !hash(r.inputHash) || r.hash !== textHash(r.text)) return undefined;
      const evidence = r.evidence as Record<string, unknown>;
      if (!evidence || Object.keys(evidence).length !== 2 || !Array.isArray(evidence.runs) || !refs(evidence.creditedRunIds)
        || !evidence.runs.every(run => run && Object.keys(run).length === 2 && ref(run.runId) && time(run.endAt))) return undefined;
      if (!evidence.creditedRunIds.every(id => (evidence.runs as { runId: string }[]).some(run => run.runId === id))) return undefined;
      if (r.source === "public" && (!ref(r.research) || !Array.isArray(r.sources) || r.sources.length < 1 || r.sources.length > 3 || !r.sources.every(publicSource))) return undefined;
      if (r.source === "observation" && (r.research !== undefined || r.sources !== undefined || r.figures !== undefined)) return undefined;
      if (r.figures !== undefined && !safeText(r.figures, 300)) return undefined;
      const claim = r as unknown as ClaimRecord;
      if (claim.itemId !== itemIdOf(claim.source, claim, claim.hash)) return undefined;
      break;
    }
    case "use": {
      if (!fields(r, ["item", "conversation", "recipient", "run", "dispatchId"], ["runs"]) || ![r.recipient, r.run, r.dispatchId].every(ref)) return undefined;
      const item = r.item as Record<string, unknown>;
      if (!item || Object.keys(item).length !== 2 || !(item.type === "rule" && ref(item.ruleId) || item.type === "claim" && ref(item.itemId)) || r.runs !== undefined && !refs(r.runs)) return undefined;
      break;
    }
    case "delivery":
      if (!fields(r, ["conversation", "session", "conductorModel", "project", "items", "setHash", "chars", "dropped", "outcome"], ["exposureId"])
        || ![r.session, r.conductorModel, r.project].every(ref) || !itemList(r.items) || !count(r.chars) || !count(r.dropped)
        || !["sent", "model-mismatch"].includes(String(r.outcome)) || r.exposureId !== undefined && !ref(r.exposureId)) return undefined;
      if (r.setHash !== deliverySetHash((r as unknown as Extract<LedgerV2Record, { kind: "delivery" }>).items)) return undefined;
      break;
    case "exposure":
      if (!fields(r, ["exposureId", "conversation", "session", "recipient", "run", "dispatchId", "items", "promptHash", "requestedModel", "requestedEffort", "observedModel", "observedEffort", "outcome"], ["attestation", "route", "executor", "role", "reason", "budget", "common"])
        || ![r.exposureId, r.session, r.recipient, r.run, r.dispatchId, r.requestedModel, r.requestedEffort, r.observedModel, r.observedEffort].every(ref)
        || !itemList(r.items) || !hash(r.promptHash) || r.attestation !== undefined && !refs(r.attestation)
        || !["sent", "withheld", "budget-withheld", "disabled", "state-unavailable", "model-mismatch", "dispatch-failed"].includes(String(r.outcome))) return undefined;
      if (r.route !== undefined && !["conductor", "target"].includes(String(r.route)) || r.executor !== undefined && !["claude", "codex", "agy"].includes(String(r.executor))
        || r.role !== undefined && !ref(r.role) || r.reason !== undefined && !ref(r.reason)) return undefined;
      if (r.budget !== undefined) {
        const budget = r.budget as Record<string, unknown>;
        if (!budget || Object.keys(budget).some(key => !["adapter", "learningAdditionCap", "learningAdditionPoints", "commandLineLimit", "commandLineUnits", "taskCodePointLimit", "taskCodePoints"].includes(key))
          || !ref(budget.adapter) || ![budget.learningAdditionCap, budget.learningAdditionPoints, budget.commandLineLimit, budget.commandLineUnits].every(count)
          || (budget.taskCodePointLimit === undefined) !== (budget.taskCodePoints === undefined)
          || budget.taskCodePointLimit !== undefined && ![budget.taskCodePointLimit, budget.taskCodePoints].every(count)) return undefined;
      }
      if (r.common !== undefined) {
        const common = r.common as Record<string, unknown>;
        if (!common || Object.keys(common).some(key => !["items", "hash", "chars", "compressed"].includes(key))
          || !itemList(common.items) || !hash(common.hash) || !count(common.chars)
          || common.compressed !== undefined && (!itemList(common.compressed)
            || !(common.compressed as { type: string; id: string }[]).every(item => item.type === "measured"
              && (common.items as { type: string; id: string }[]).some(kept => kept.type === item.type && kept.id === item.id)))) return undefined;
      }
      break;
    case "research-complete":
      if (!fields(r, ["research", "conversation", "requestId", "inputHash", "items"]) || ![r.research, r.requestId].every(ref) || !hash(r.inputHash)
        || !Array.isArray(r.items) || !r.items.length || !r.items.every(item => item && Object.keys(item).length === 2 && ref(item.itemId) && hash(item.hash))) return undefined;
      break;
    case "experiment-assignment":
      if (!fields(r, ["conversation", "eligible", "reason", "candidates", "experimentVersion", "detectorVersion", "probability", "arm", "switches"])
        || typeof r.eligible !== "boolean" || !ref(r.reason) || !refs(r.candidates) || !Number.isSafeInteger(r.experimentVersion) || !Number.isSafeInteger(r.detectorVersion)
        || !count(r.probability) || r.probability > 1 || !["delivery", "holdout"].includes(String(r.arm)) || !r.switches || typeof r.switches !== "object"
        || !Object.entries(r.switches).every(([key, value]) => ref(key) && typeof value === "boolean")) return undefined;
      break;
    case "measurement":
      if (!fields(r, ["conversation", "run", "counts"], ["tags"]) || !ref(r.run) || !r.counts || typeof r.counts !== "object"
        || !Object.entries(r.counts).every(([key, value]) => ref(key) && (value === null || count(value)))) return undefined;
      if (r.tags !== undefined && (!r.tags || typeof r.tags !== "object" || !Object.entries(r.tags).every(([key, value]) => ref(key) && ref(value)))) return undefined;
      break;
    case "switch-change":
    case "detector-regression":
      if (!fields(r, ["conversation", "detectorVersion", "switches"], ["rejectedVersion"]) || !Number.isSafeInteger(r.detectorVersion)
        || r.rejectedVersion !== undefined && !Number.isSafeInteger(r.rejectedVersion) || !r.switches || typeof r.switches !== "object"
        || !Object.entries(r.switches).every(([key, value]) => ref(key) && typeof value === "boolean")) return undefined;
      break;
    default: return undefined;
  }
  return structuredClone(r) as unknown as LedgerV2Record;
}

export function decodeLedgerRecord(value: unknown): LedgerV2Record | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== 2 || !time(r.at) || !ref(r.opId)) return undefined;
  if (r.kind !== "episode") return decodeFact(r);
  if (Object.keys(r).some(key => !episodeFields.has(key))) return undefined;
  if (![r.conversation, r.session, r.recipient, r.run, r.dispatchId, r.toolUse, r.project, r.ruleId].every(ref)) return undefined;
  if (typeof r.sig !== "string" || !/^[a-f0-9]{32}$/.test(r.sig) || !Number.isSafeInteger(r.sigV) || Number(r.sigV) < 1) return undefined;
  if (!ref(r.tool) || !ref(r.cls) || typeof r.head !== "string" || !/^(?:|other|[a-z]+(?: [a-z][a-z0-9-]*)?)$/.test(r.head)) return undefined;
  if (typeof r.status !== "string" || !statuses.has(r.status)) return undefined;
  if (r.label !== undefined && (!Number.isSafeInteger(r.label) || Number(r.label) < 0)) return undefined;
  const key = r.key as Record<string, unknown> | undefined;
  if (!key || key.sig !== r.sig || !ref(key.model)) return undefined;
  const keyFields = key.bind === "conductor" ? ["sig", "bind", "model"] : key.bind === "target" ? ["sig", "bind", "executor", "model", "effort", "role"] : [];
  if (!keyFields.length || Object.keys(key).length !== keyFields.length || !keyFields.every(field => ref(key[field]))) return undefined;
  if (key.bind === "target" && !["claude", "codex", "agy"].includes(String(key.executor))) return undefined;
  if (r.labelFacts !== undefined) {
    const facts = r.labelFacts as Record<string, unknown>;
    if (!facts || Object.keys(facts).some(key => !["code", "fields", "schemaV"].includes(key))) return undefined;
    if (facts.code !== undefined && !["delegation_invalid", "target_unavailable"].includes(String(facts.code))) return undefined;
    if (facts.fields !== undefined && (!Array.isArray(facts.fields) || !facts.fields.every(field => ["target", "prompt", "description", "files", "diff", "cwd", "subagent_type", "name", "team_name", "model", "mode", "isolation", "run_in_background"].includes(field)))) return undefined;
    if (facts.schemaV !== undefined && (!Number.isSafeInteger(facts.schemaV) || Number(facts.schemaV) < 1)) return undefined;
  }
  const record = r as unknown as EpisodeRecord;
  if (record.ruleId !== ruleIdOf(record.key) || record.opId !== episodeOpId(record.conversation, record.toolUse, record.recipient, record.run)) return undefined;
  return structuredClone(record);
}

export interface LedgerRead<T> { records: T[]; skipped: number; offset: number; incompleteTail: boolean }

export async function readCompleteLines<T>(file: string, offset: number, decode: (value: unknown) => T | undefined): Promise<LedgerRead<T>> {
  let handle;
  try { handle = await open(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && offset === 0) return { records: [], skipped: 0, offset, incompleteTail: false };
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size < offset) throw new Error("learning ledger truncated");
    const buffer = Buffer.alloc(size - offset);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, offset + length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const complete = buffer.subarray(0, length).lastIndexOf(10) + 1;
    const records: T[] = [];
    let skipped = 0;
    if (complete) for (const line of buffer.subarray(0, complete).toString("utf8").split("\n").slice(0, -1)) {
      let record: T | undefined;
      try { record = decode(JSON.parse(line)); } catch { record = undefined; }
      if (record === undefined) skipped++; else records.push(record);
    }
    return { records, skipped, offset: offset + complete, incompleteTail: length > complete };
  } finally { await handle.close(); }
}

export async function appendLedgerRecord(file: string, record: LedgerV2Record): Promise<void> {
  const decoded = decodeLedgerRecord(record);
  if (!decoded) throw new Error("invalid v2 ledger record");
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(decoded)}\n`, "utf8");
}

export async function installKeyOf(directory: string): Promise<Buffer> {
  const file = join(directory, "install-key");
  let key: Buffer;
  try { key = await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `install-key.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(randomBytes(32)); } finally { await handle.close(); }
      try { await link(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await unlink(temporary).catch(() => undefined); }
    key = await readFile(file);
  }
  if (key.length !== 32) throw new Error("invalid learning install-key length");
  return key;
}

export function opaqueLearningRef(key: Uint8Array, domain: string, value: string): string {
  return createHmac("sha256", key).update(`${domain}:${value}`).digest("hex");
}

export function reduceLedger(records: Iterable<LedgerV2Record>) {
  const byId = new Map<string, LedgerV2Record>();
  const conflicts = new Set<string>();
  for (const input of records) {
    const record = decodeLedgerRecord(input);
    if (!record) continue;
    const prior = byId.get(record.opId);
    if (prior && !isDeepStrictEqual(prior, record)) conflicts.add(record.opId);
    else byId.set(record.opId, record);
  }
  for (const id of conflicts) byId.delete(id);
  const assignments = new Map<string, ExperimentAssignmentRecord>();
  const unavailableConversations = new Set<string>();
  const requests = new Map<string, Map<string, string>>();
  for (const record of byId.values()) {
    if (record.kind === "experiment-assignment") {
      const prior = assignments.get(record.conversation);
      if (prior && !isDeepStrictEqual({ ...prior, opId: "", at: "" }, { ...record, opId: "", at: "" })) unavailableConversations.add(record.conversation);
      else assignments.set(record.conversation, record);
    }
    if (record.kind === "claim" && record.source === "observation") {
      const known = requests.get(record.conversation) ?? new Map<string, string>();
      const prior = known.get(record.requestId);
      if (prior !== undefined && prior !== record.inputHash) unavailableConversations.add(record.conversation);
      known.set(record.requestId, record.inputHash);
      requests.set(record.conversation, known);
    }
  }
  for (const conversation of unavailableConversations) assignments.delete(conversation);
  return { records: byId, conflicts, rules: qualifyRules(byId.values()), assignments, requests, unavailableConversations };
}

const ledgerQueues = new Map<string, Promise<unknown>>();
function serialLedger<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const absolute = resolve(directory);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const next = (ledgerQueues.get(key) ?? Promise.resolve()).then(action);
  ledgerQueues.set(key, next.catch(() => undefined));
  return next;
}
export class LearningLedger {
  private offset = 0;
  private records: LedgerV2Record[] = [];
  skipped = 0;
  incompleteTail = false;
  consistent = true;
  constructor(readonly directory: string, private readonly log: (message: string) => void = () => {}) {}
  get state() { return reduceLedger(this.records); }
  serial<T>(action: () => Promise<T>): Promise<T> {
    return serialLedger(this.directory, action);
  }
  private async read(): Promise<void> {
    const read = await readCompleteLines(join(this.directory, "ledger.jsonl"), this.offset, decodeLedgerRecord);
    this.offset = read.offset;
    this.records.push(...read.records);
    this.skipped += read.skipped;
    this.incompleteTail = read.incompleteTail;
    if (read.skipped) this.log(`[learning-v2] skipped ${read.skipped} broken complete lines (${this.skipped} total)`);
  }
  reload(reset = false): Promise<void> {
    return this.serial(async () => {
      if (reset) { this.offset = 0; this.records = []; this.skipped = 0; this.incompleteTail = false; }
      await this.read();
      this.consistent = !this.incompleteTail && !this.state.conflicts.size;
    });
  }
  append(record: LedgerV2Record): Promise<void> {
    return this.serial(async () => {
      if (!decodeLedgerRecord(record)) throw new Error("invalid v2 ledger record");
      if (!this.consistent) throw new Error("learning ledger state-unavailable; reload required");
      await this.read();
      if (this.incompleteTail || this.state.conflicts.size) { this.consistent = false; throw new Error("learning ledger state-unavailable; reload required"); }
      const prior = this.state.records.get(record.opId);
      if (prior && isDeepStrictEqual(prior, record)) return;
      if (prior || this.state.conflicts.has(record.opId)) throw new Error("learning opId conflict");
      try { await appendLedgerRecord(join(this.directory, "ledger.jsonl"), record); await this.read(); }
      catch (error) { this.consistent = false; throw error; }
    });
  }
}

interface ConversationMapping { v: 2; conversation: string; session: string; resume?: string }
function decodeMapping(value: unknown): ConversationMapping | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== 2 || !ref(r.conversation) || !ref(r.session) || r.resume !== undefined && !ref(r.resume)
    || Object.keys(r).some(key => !["v", "conversation", "session", "resume"].includes(key))) return undefined;
  return r as unknown as ConversationMapping;
}
function reliableMappings(read: LedgerRead<ConversationMapping>): boolean {
  if (read.skipped || read.incompleteTail) return false;
  const conversations = new Map<string, string>();
  for (const record of read.records) for (const session of [record.session, record.resume]) {
    if (!session) continue;
    const prior = conversations.get(session);
    if (prior && prior !== record.conversation) return false;
    conversations.set(session, record.conversation);
  }
  return true;
}

export class LearningConversationKey {
  conversation?: string;
  startedWithoutPriorState = false;
  private knownConversation?: string;
  private boundSession?: string;
  constructor(private readonly directory: string, private readonly key: Uint8Array, private readonly resumeSession?: string) {
    if (!resumeSession) this.conversation = randomUUID();
  }
  private sessionRef(session: string): string { return opaqueLearningRef(this.key, "session", session); }
  restore(): Promise<boolean> { return serialLedger(this.directory, () => this.restoreMapping()); }
  private async restoreMapping(): Promise<boolean> {
    if (!this.resumeSession) return this.conversation !== undefined;
    const file = join(this.directory, "conversations.jsonl");
    let read = await readCompleteLines(file, 0, decodeMapping);
    const wanted = this.sessionRef(this.resumeSession);
    const matching = () => new Set(read.records.filter(record => record.session === wanted || record.resume === wanted).map(record => record.conversation));
    if (reliableMappings(read) && matching().size === 0 && !this.knownConversation) {
      this.knownConversation = randomUUID();
      await mkdir(this.directory, { recursive: true });
      await appendFile(file, `${JSON.stringify({ v: 2, conversation: this.knownConversation, session: wanted })}\n`, "utf8");
      read = await readCompleteLines(file, 0, decodeMapping);
      this.startedWithoutPriorState = true;
    }
    const conversations = matching();
    const restored = reliableMappings(read) && conversations.size === 1 ? [...conversations][0] : undefined;
    const bound = this.boundSession ? this.sessionRef(this.boundSession) : wanted;
    const conflicting = read.records.some(record => (record.session === bound || record.resume === bound) && record.conversation !== restored);
    this.conversation = restored && !conflicting && (!this.knownConversation || restored === this.knownConversation) ? restored : undefined;
    if (this.conversation) this.knownConversation = this.conversation;
    return this.conversation !== undefined;
  }
  bind(session: string): Promise<boolean> {
    return serialLedger(this.directory, async () => {
      this.boundSession = session;
      if (!await this.restoreMapping() || !this.conversation) return false;
      const file = join(this.directory, "conversations.jsonl");
      const record: ConversationMapping = { v: 2, conversation: this.conversation, session: this.sessionRef(session),
        ...(this.resumeSession ? { resume: this.sessionRef(this.resumeSession) } : {}) };
      const reliable = (read: LedgerRead<ConversationMapping>) => reliableMappings(read)
        && !read.records.some(existing => (existing.session === record.session || existing.resume === record.session)
          && existing.conversation !== record.conversation);
      let read = await readCompleteLines(file, 0, decodeMapping);
      if (reliable(read) && !read.records.some(existing => isDeepStrictEqual(existing, record))) {
        await mkdir(this.directory, { recursive: true });
        await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
        read = await readCompleteLines(file, 0, decodeMapping);
      }
      if (!reliable(read) || !read.records.some(existing => isDeepStrictEqual(existing, record))) { this.conversation = undefined; return false; }
      return true;
    });
  }
}
