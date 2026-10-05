import { createHash, createHmac, randomBytes, randomUUID, type Hash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { appendFile, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { deliverySetHash, episodeOpId, itemIdOf, qualifyRules, ruleIdOf, type EpisodeRecord, type LedgerV2Record, type ExperimentAssignmentRecord, type ClaimRecord, type RuleState } from "./learning-episodes";
import { textHash } from "./learning";
import { containsAbsolutePath } from "./path-redaction";
import { encodeLedgerFrame, LedgerV3Decoder, type LedgerLine } from "./learning-ledger-codec";
import { CHECKPOINT_MIN_GAIN_BYTES, LEARNING_MAX_LINE_BYTES, learningReadChunk, checkpointCandidates, hashPrefix, loadCheckpoint, publishCheckpoint, sameCheckpointContent } from "./learning-checkpoint";

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
        const episode = validLedgerRecord(r.episode);
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
  return r as unknown as LedgerV2Record;
}

export function decodeLedgerRecord(value: unknown): LedgerV2Record | undefined {
  const valid = validLedgerRecord(value);
  return valid && structuredClone(valid);
}

function validLedgerRecord(value: unknown): LedgerV2Record | undefined {
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
  return record;
}

export interface LedgerRead<T> { records: T[]; skipped: number; offset: number; incompleteTail: boolean }

function forEachLine(bytes: Buffer, visit: (line: Buffer, start: number) => void): void {
  for (let start = 0, end = bytes.indexOf(10); end >= 0; start = end + 1, end = bytes.indexOf(10, start)) visit(bytes.subarray(start, end), start);
}
function parseLine(line: Buffer): unknown {
  if (line.length > LEARNING_MAX_LINE_BYTES) throw new Error("learning ledger line too long");
  return JSON.parse(line.toString("utf8"));
}

function decodeLines<T>(bytes: Buffer, decode: (value: unknown) => T | undefined): { records: T[]; skipped: number } {
  const records: T[] = [];
  let skipped = 0;
  forEachLine(bytes, line => {
    let record: T | undefined;
    try { record = decode(parseLine(line)); } catch { record = undefined; }
    if (record === undefined) skipped++; else records.push(record);
  });
  return { records, skipped };
}

interface ChunkHandlers { complete(bytes: Buffer): void; overlong?(bytes: Buffer): void; overlongEnd(): void }
async function readCompleteChunks(file: string, offset: number, handlers: ChunkHandlers): Promise<{ end: number; incompleteTail: boolean; identity: FileIdentity } | undefined> {
  let handle;
  try { handle = await open(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && offset === 0) return undefined;
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    const size = Number(info.size);
    if (size < offset) throw new Error("learning ledger truncated");
    const emitOverlong = async (from: number, to: number) => {
      for (let position = from; position < to;) {
        const piece = Buffer.alloc(Math.min(learningReadChunk.bytes, to - position));
        const { bytesRead } = await handle.read(piece, 0, piece.length, position);
        if (!bytesRead) throw new Error("learning ledger truncated");
        handlers.overlong?.(piece.subarray(0, bytesRead));
        position += bytesRead;
      }
      handlers.overlongEnd();
    };
    let position = offset, end = offset, carry = Buffer.alloc(0), overlongStart = -1;
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(learningReadChunk.bytes, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      const chunkStart = position;
      position += bytesRead;
      let data = chunk.subarray(0, bytesRead), dataStart = chunkStart;
      if (overlongStart >= 0) {
        const lf = data.indexOf(10);
        if (lf < 0) continue;
        await emitOverlong(overlongStart, chunkStart + lf + 1);
        end = chunkStart + lf + 1;
        overlongStart = -1;
        data = data.subarray(lf + 1);
        dataStart = end;
      } else if (carry.length) {
        data = Buffer.concat([carry, data]);
        dataStart = chunkStart - carry.length;
      }
      const complete = data.lastIndexOf(10) + 1;
      if (complete) { handlers.complete(data.subarray(0, complete)); end = dataStart + complete; }
      const rest = data.subarray(complete);
      if (rest.length > LEARNING_MAX_LINE_BYTES) { overlongStart = dataStart + complete; carry = Buffer.alloc(0); }
      else carry = Buffer.from(rest);
    }
    return { end, incompleteTail: carry.length > 0 || overlongStart >= 0, identity: identityOf(info) };
  } finally { await handle.close(); }
}

export async function readCompleteLines<T>(file: string, offset: number, decode: (value: unknown) => T | undefined): Promise<LedgerRead<T>> {
  const records: T[] = [];
  let skipped = 0;
  const read = await readCompleteChunks(file, offset, { complete: complete => {
    const decoded = decodeLines(complete, decode);
    for (const record of decoded.records) records.push(record);
    skipped += decoded.skipped;
  }, overlongEnd: () => { skipped++; } });
  return { records, skipped, offset: read?.end ?? offset, incompleteTail: read?.incompleteTail ?? false };
}

function decodeLedgerLine(decoder: LedgerV3Decoder, line: Buffer): LedgerLine | undefined {
  try { return decoder.decode(parseLine(line)); } catch { return undefined; }
}

export function decodeLedgerBytes(bytes: Buffer, decoder = new LedgerV3Decoder()): { records: LedgerV2Record[]; skipped: number; dictionary: number } {
  const records: LedgerV2Record[] = [];
  let skipped = 0, dictionary = 0;
  forEachLine(bytes, line => {
    const decoded = decodeLedgerLine(decoder, line), record = decoded?.kind === "record" ? decodeLedgerRecord(decoded.value) : undefined;
    if (decoded?.kind === "dictionary") dictionary++; else if (record) records.push(record); else skipped++;
  });
  return { records, skipped, dictionary };
}

export function decodeLedgerText(text: string, decoder = new LedgerV3Decoder()): { records: LedgerV2Record[]; skipped: number; dictionary: number } {
  return decodeLedgerBytes(Buffer.from(text, "utf8"), decoder);
}

export function encodeLedgerRecords(records: Iterable<LedgerV2Record>, decoder = new LedgerV3Decoder()): string {
  let text = "";
  for (const record of records) {
    const frame = encodeLedgerFrame(record, id => decoder.has(id));
    for (const line of frame.text.split("\n").slice(0, -1)) decoder.decode(JSON.parse(line));
    text += frame.text;
  }
  return text;
}

export async function readLedgerFile(file: string): Promise<LedgerRead<LedgerV2Record>> {
  const decoder = new LedgerV3Decoder(), records: LedgerV2Record[] = [];
  let skipped = 0;
  const read = await readCompleteChunks(file, 0, { complete: complete => {
    const decoded = decodeLedgerBytes(complete, decoder);
    for (const record of decoded.records) records.push(record);
    skipped += decoded.skipped;
  }, overlongEnd: () => { skipped++; } });
  return { records, skipped, offset: read?.end ?? 0, incompleteTail: read?.incompleteTail ?? false };
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

export interface LedgerState {
  records: ReadonlyMap<string, LedgerV2Record>;
  conflicts: ReadonlySet<string>;
  rules: ReadonlyMap<string, RuleState>;
  assignments: ReadonlyMap<string, ExperimentAssignmentRecord>;
  requests: ReadonlyMap<string, ReadonlyMap<string, string>>;
  unavailableConversations: ReadonlySet<string>;
}

class LedgerReduction {
  private derived?: LedgerState;
  private mapsShared = false;
  private stateShared = false;
  constructor(private acceptedById = new Map<string, LedgerV2Record>(), private byId = new Map<string, LedgerV2Record>(), private conflictIds = new Set<string>()) {}
  static restore(records: readonly LedgerV2Record[], conflicts: readonly string[]): LedgerReduction {
    const conflictIds = new Set(conflicts);
    const acceptedById = new Map(records.map(record => [record.opId, record] as const));
    return new LedgerReduction(acceptedById, new Map([...acceptedById].filter(([opId]) => !conflictIds.has(opId))), conflictIds);
  }
  get records(): ReadonlyMap<string, LedgerV2Record> { return this.byId; }
  get conflicts(): ReadonlySet<string> { return this.conflictIds; }
  get accepted(): Iterable<LedgerV2Record> { return this.acceptedById.values(); }
  fork(): LedgerReduction {
    const fork = new LedgerReduction(this.acceptedById, this.byId, this.conflictIds);
    fork.derived = this.derived;
    fork.mapsShared = this.mapsShared = true;
    return fork;
  }
  add(record: LedgerV2Record): void {
    const prior = this.acceptedById.get(record.opId);
    if (prior && isDeepStrictEqual(prior, record)) return;
    if (this.mapsShared) {
      this.acceptedById = new Map(this.acceptedById);
      this.byId = new Map(this.byId);
      this.conflictIds = new Set(this.conflictIds);
    } else if (this.stateShared) {
      this.byId = new Map(this.byId);
      this.conflictIds = new Set(this.conflictIds);
    }
    this.mapsShared = this.stateShared = false;
    this.derived = undefined;
    if (prior) {
      this.conflictIds.add(record.opId);
      this.byId.delete(record.opId);
      return;
    }
    this.acceptedById.set(record.opId, record);
    this.byId.set(record.opId, record);
  }
  state(): LedgerState {
    if (!this.derived) {
      this.derived = deriveLedgerState(this.byId, this.conflictIds);
      this.stateShared = true;
    }
    return this.derived;
  }
}

export function reduceLedger(records: Iterable<LedgerV2Record>): LedgerState {
  const reduction = new LedgerReduction();
  for (const input of records) {
    const record = decodeLedgerRecord(input);
    if (record) reduction.add(record);
  }
  return reduction.state();
}

function deriveLedgerState(byId: Map<string, LedgerV2Record>, conflicts: Set<string>): LedgerState {
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

export const LEDGER_FILE_NAME = "ledger-v3.jsonl";
const LEDGER_WINDOW_BYTES = 1 << 16;
interface FileIdentity { dev: string; ino: string; birthtimeNs: string }
const identityOf = (info: BigIntStats): FileIdentity => ({ dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) });
const sameIdentity = (a?: FileIdentity, b?: FileIdentity): boolean => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

interface ContextLocation { offset: number; length: number; hash: string }
const lineHash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
interface LedgerCursor {
  reduction: LedgerReduction;
  decoder: LedgerV3Decoder;
  locations: Map<string, ContextLocation>;
  offset: number;
  hash: Hash;
  window: Buffer;
  identity?: FileIdentity;
  skipped: number;
  incompleteTail: boolean;
}
interface LedgerCapture extends LedgerCursor { digest: string }
const emptyCursor = (): LedgerCursor => ({ reduction: new LedgerReduction(), decoder: new LedgerV3Decoder(), locations: new Map(), offset: 0, hash: createHash("sha256"),
  window: Buffer.alloc(0), skipped: 0, incompleteTail: false });
function checkpointLocations(entries: readonly unknown[], decoder: LedgerV3Decoder, offset: number): Map<string, ContextLocation> | undefined {
  const locations = new Map<string, ContextLocation>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 4) return undefined;
    const [id, start, length, hash] = entry;
    if (typeof id !== "string" || !decoder.has(id) || locations.has(id) || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 2
      || length > LEARNING_MAX_LINE_BYTES + 1 || start + length > offset || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
    locations.set(id, { offset: start, length, hash });
  }
  const spans = [...locations.values()].sort((a, b) => a.offset - b.offset);
  if (spans.some((span, index) => index > 0 && spans[index - 1].offset + spans[index - 1].length > span.offset)) return undefined;
  return locations.size === decoder.size ? locations : undefined;
}
function advance(cursor: LedgerCursor, bytes: Buffer): void {
  cursor.hash.update(bytes);
  cursor.window = bytes.length >= LEDGER_WINDOW_BYTES ? Buffer.from(bytes.subarray(bytes.length - LEDGER_WINDOW_BYTES))
    : Buffer.concat([cursor.window.subarray(Math.max(0, cursor.window.length + bytes.length - LEDGER_WINDOW_BYTES)), bytes]);
  cursor.offset += bytes.length;
}
interface SharedLedger {
  holder?: LearningLedger;
  checkpointOffset: number;
  requestedOffset: number;
  invalid: Set<string>;
  pending?: LedgerCapture;
  publishing?: Promise<void>;
}

const ledgerQueues = new Map<string, Promise<unknown>>();
const sharedLedgers = new Map<string, SharedLedger>();
function ledgerPathKey(directory: string): string {
  const absolute = resolve(directory);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function serialLedger<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = ledgerPathKey(directory);
  const next = (ledgerQueues.get(key) ?? Promise.resolve()).then(action);
  ledgerQueues.set(key, next.catch(() => undefined));
  return next;
}
function sharedLedger(file: string): SharedLedger {
  const key = ledgerPathKey(file);
  let shared = sharedLedgers.get(key);
  if (!shared) sharedLedgers.set(key, shared = { checkpointOffset: 0, requestedOffset: 0, invalid: new Set() });
  return shared;
}
async function fileBytes(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, start + length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
async function fileIdentity(file: string): Promise<{ identity: FileIdentity; size: number } | undefined> {
  try {
    const info = await stat(file, { bigint: true });
    return { identity: identityOf(info), size: Number(info.size) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class LearningLedger {
  private cursor: LedgerCursor = emptyCursor();
  private loaded = false;
  consistent = true;
  constructor(readonly directory: string, private readonly log: (message: string) => void = () => {}, readonly fileName = LEDGER_FILE_NAME) {}
  get state(): LedgerState { return this.cursor.reduction.state(); }
  get skipped(): number { return this.cursor.skipped; }
  get incompleteTail(): boolean { return this.cursor.incompleteTail; }
  get publication(): Promise<void> { return sharedLedger(this.file).publishing ?? Promise.resolve(); }
  private get file(): string { return join(this.directory, this.fileName); }
  serial<T>(action: () => Promise<T>): Promise<T> {
    return serialLedger(this.directory, action);
  }
  private capture(): LedgerCapture {
    const cursor = this.cursor;
    return { ...cursor, reduction: cursor.reduction.fork(), decoder: cursor.decoder.clone(), locations: new Map(cursor.locations), hash: cursor.hash.copy(),
      digest: cursor.hash.copy().digest("hex") };
  }
  private async readInto(cursor: LedgerCursor, earlier?: Set<string>): Promise<void> {
    const start = cursor.offset;
    const tail = await readCompleteChunks(this.file, cursor.offset, {
      complete: bytes => {
        let skipped = 0;
        forEachLine(bytes, (line, lineStart) => {
          const decoded = decodeLedgerLine(cursor.decoder, line);
          const record = decoded?.kind === "record" ? decodeLedgerRecord(decoded.value) : undefined;
          if (decoded?.kind === "dictionary") {
            if (decoded.fresh) cursor.locations.set(decoded.id, { offset: cursor.offset + lineStart, length: line.length + 1, hash: lineHash(bytes.subarray(lineStart, lineStart + line.length + 1)) });
          } else if (decoded?.kind === "record" && record) {
            cursor.reduction.add(record);
            if (earlier) for (const id of decoded.contexts) if ((cursor.locations.get(id)?.offset ?? -1) < start) earlier.add(id);
          } else skipped++;
        });
        cursor.skipped += skipped;
        advance(cursor, bytes);
        if (skipped) this.log(`[learning-v2] skipped ${skipped} broken complete lines (${cursor.skipped} total)`);
      },
      overlong: bytes => advance(cursor, bytes),
      overlongEnd: () => {
        cursor.skipped++;
        this.log(`[learning-v2] skipped 1 broken complete lines (${cursor.skipped} total)`);
      },
    });
    if (tail) cursor.identity = tail.identity;
    cursor.incompleteTail = tail?.incompleteTail ?? false;
  }
  private async definitionsOnDisk(cursor: LedgerCursor, ids: Iterable<string>): Promise<boolean> {
    for (const id of ids) {
      const location = cursor.locations.get(id);
      if (!location || location.length > LEARNING_MAX_LINE_BYTES + 1) return false;
      const lead = location.offset ? 1 : 0;
      const bytes = await fileBytes(this.file, location.offset - lead, location.offset + location.length);
      if (bytes.length !== location.length + lead || lead && bytes[0] !== 10 || bytes[bytes.length - 1] !== 10
        || lineHash(bytes.subarray(lead)) !== location.hash) return false;
    }
    return true;
  }
  private async unchanged(cursor: LedgerCursor, compareWindow: boolean): Promise<boolean> {
    const current = await fileIdentity(this.file);
    if (!current) return cursor.offset === 0;
    if (!cursor.identity) return cursor.offset === 0;
    if (!sameIdentity(current.identity, cursor.identity) || current.size < cursor.offset) return false;
    return !compareWindow || (await fileBytes(this.file, cursor.offset - cursor.window.length, cursor.offset)).equals(cursor.window);
  }
  private async restore(verify: boolean): Promise<void> {
    const shared = sharedLedger(this.file);
    const captured = shared.holder?.loaded ? shared.holder.capture() : undefined;
    let next: LedgerCursor | undefined = !verify && captured && await this.unchanged(captured, true) ? captured : await this.restoreVerified(shared, captured);
    if (!next) {
      next = emptyCursor();
      shared.checkpointOffset = shared.requestedOffset = 0;
    } else if (next.skipped) this.log(`[learning-v2] skipped ${next.skipped} broken complete lines (${next.skipped} total)`);
    await this.readInto(next);
    this.cursor = next;
    this.loaded = true;
  }
  private async restoreVerified(shared: SharedLedger, captured?: LedgerCapture): Promise<LedgerCursor | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await fileIdentity(this.file);
      if (!before) return undefined;
      const disk = (await checkpointCandidates(this.file)).filter(candidate => !shared.invalid.has(candidate.name));
      for (const candidate of disk) if (candidate.offset > before.size) shared.invalid.add(candidate.name);
      const offsets = [...disk.map(candidate => candidate.offset), captured?.offset ?? 0].filter(offset => offset > 0 && offset <= before.size);
      if (!offsets.length) return undefined;
      const verified = await hashPrefix(this.file, offsets);
      const after = await fileIdentity(this.file);
      if (!after || !sameIdentity(before.identity, after.identity) || after.size < Math.max(...offsets)) continue;
      for (const offset of [...new Set(offsets)].sort((a, b) => b - a)) {
        const prefix = verified.get(offset);
        if (!prefix) continue;
        if (captured?.offset === offset && captured.digest === prefix.digest) return { ...captured, identity: after.identity };
        const atOffset = disk.filter(candidate => candidate.offset === offset);
        if (!atOffset.length) continue;
        if (atOffset.length > 1 && !await sameCheckpointContent(this.file, atOffset.map(candidate => candidate.name))) {
          for (const candidate of atOffset) shared.invalid.add(candidate.name);
          return undefined;
        }
        const payload = await loadCheckpoint(this.file, atOffset[0], prefix.digest);
        const decoder = payload && LedgerV3Decoder.restore(payload.dictionary, payload.conflictedContexts);
        const records = payload?.records.map(validLedgerRecord);
        const locations = payload && decoder && checkpointLocations(payload.locations, decoder, offset);
        if (!payload || !decoder || !locations || !records || records.some(record => record === undefined)) { for (const candidate of atOffset) shared.invalid.add(candidate.name); continue; }
        shared.checkpointOffset = Math.max(shared.checkpointOffset, offset);
        return { reduction: LedgerReduction.restore(records as LedgerV2Record[], payload.conflicts), decoder, locations, offset, hash: prefix.hash,
          window: await fileBytes(this.file, Math.max(0, offset - LEDGER_WINDOW_BYTES), offset), identity: after.identity, skipped: payload.skipped, incompleteTail: false };
      }
      for (const candidate of disk) shared.invalid.add(candidate.name);
      return undefined;
    }
    return undefined;
  }
  private async sync(compareWindow: boolean, verified: ReadonlySet<string> = new Set()): Promise<void> {
    if (!this.loaded) await this.restore(false);
    else if (!await this.unchanged(this.cursor, compareWindow)) await this.restore(true);
    else {
      const earlier = new Set<string>();
      await this.readInto(this.cursor, earlier);
      if (!await this.definitionsOnDisk(this.cursor, [...earlier].filter(id => !verified.has(id)))) await this.restore(true);
    }
    this.share();
  }
  private share(): void {
    const shared = sharedLedger(this.file);
    const holder = shared.holder, cursor = this.cursor;
    if (!holder || holder === this || !holder.loaded || cursor.offset > holder.cursor.offset || !sameIdentity(cursor.identity, holder.cursor.identity)) shared.holder = this;
    if (shared.holder !== this || cursor.offset - Math.max(shared.checkpointOffset, shared.requestedOffset) < CHECKPOINT_MIN_GAIN_BYTES) return;
    shared.requestedOffset = cursor.offset;
    shared.pending = this.capture();
    shared.publishing ??= (async () => {
      while (shared.pending) {
        const next = shared.pending;
        shared.pending = undefined;
        if (next.offset - shared.checkpointOffset < CHECKPOINT_MIN_GAIN_BYTES) continue;
        try {
          if (await publishCheckpoint(this.file, next.offset, next.digest,
            { dictionary: [...next.decoder.entries], conflictedContexts: [...next.decoder.conflictedIds],
              locations: [...next.locations].map(([id, location]) => [id, location.offset, location.length, location.hash]),
              records: [...next.reduction.accepted], conflicts: [...next.reduction.conflicts], skipped: next.skipped }, [...shared.invalid])) {
            shared.checkpointOffset = Math.max(shared.checkpointOffset, next.offset);
          }
        } catch (error) {
          this.log(`[learning-v2] checkpoint not published${typeof (error as NodeJS.ErrnoException)?.code === "string" ? ` (${(error as NodeJS.ErrnoException).code})` : ""}`);
        }
      }
      shared.publishing = undefined;
    })();
  }
  private synchronize(mode: "tail" | "checked" | "reset"): Promise<void> {
    return this.serial(async () => {
      try {
        if (mode === "reset") { await this.restore(true); this.share(); }
        else await this.sync(mode === "checked");
      } catch (error) { this.consistent = false; throw error; }
      this.consistent = !this.cursor.incompleteTail && !this.cursor.reduction.conflicts.size;
    });
  }
  reload(reset = false): Promise<void> { return this.synchronize(reset ? "reset" : "tail"); }
  async refresh(): Promise<void> {
    await this.synchronize("checked");
    if (!this.consistent || this.skipped) await this.synchronize("reset");
  }
  append(record: LedgerV2Record): Promise<void> {
    return this.serial(async () => {
      if (!decodeLedgerRecord(record)) throw new Error("invalid learning ledger record");
      if (!this.consistent) throw new Error("learning ledger state-unavailable; reload required");
      const unavailable = () => { this.consistent = false; return new Error("learning ledger state-unavailable; reload required"); };
      if (encodeLedgerFrame(record, () => false).text.split("\n").some(line => Buffer.byteLength(line) > LEARNING_MAX_LINE_BYTES)) throw new Error("invalid learning ledger record");
      try { await this.sync(false); } catch (error) { this.consistent = false; throw error; }
      let frame: { text: string; reused: string[] } | undefined;
      for (let attempt = 0; ; attempt++) {
        if (this.cursor.incompleteTail || this.cursor.reduction.conflicts.size) throw unavailable();
        const prior = this.cursor.reduction.records.get(record.opId);
        if (prior && isDeepStrictEqual(prior, record)) return;
        if (prior || this.cursor.reduction.conflicts.has(record.opId)) throw new Error("learning opId conflict");
        const encoded = encodeLedgerFrame(record, id => this.cursor.decoder.has(id));
        const reference = JSON.parse(encoded.text.slice(encoded.text.lastIndexOf("\n", encoded.text.length - 2) + 1)) as { c?: unknown; e?: unknown };
        const reused = [reference.c, reference.e].filter((id): id is string => typeof id === "string" && !encoded.contexts.some(context => context.id === id));
        let onDisk: boolean;
        try { onDisk = await this.definitionsOnDisk(this.cursor, reused); } catch { onDisk = false; }
        if (onDisk) { frame = { text: encoded.text, reused }; break; }
        if (attempt) throw unavailable();
        try { await this.restore(true); this.share(); } catch (error) { this.consistent = false; throw error; }
      }
      try {
        await mkdir(this.directory, { recursive: true });
        await appendFile(this.file, frame.text, "utf8");
        await this.sync(false, new Set(frame.reused));
      }
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
