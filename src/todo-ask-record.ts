import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { ConversationMessage } from "./conversation-history";
import { ASK_FENCE_INFO } from "./markdown-ast";
import { createConversationMessageParser, extractCliInsertedUserText, extractHumanUserPrompt } from "./session-transcript";
import { todoAskDecisionTracker, todoAskSourceMessages, todoDecisionKey, type TodoAskDecisionTracker, type TodoDecision, type TodoDecisionAsk, type TodoRecordMessage } from "./todo-model";

export interface RecordLineSink<R> {
  push(lines: string[]): Promise<void> | void;
  result(): R;
}

export const RECORD_READ_CHUNK_BYTES = 16 * 1024 * 1024;

export class RecordTailReader<R> {
  private sink: RecordLineSink<R> | null = null;
  private offset = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { path: string; size: number; promise: Promise<R> } | null = null;
  bytesRead = 0;

  constructor(private readonly create: () => RecordLineSink<R>) {}

  get position(): number {
    return this.offset;
  }

  protected resumeAt(offset: number, sink: RecordLineSink<R>): void {
    if (this.sink !== null) return;
    this.sink = sink;
    this.offset = offset;
  }

  read(path: string, size: number): Promise<R> {
    if (this.pending && this.pending.path === path && this.pending.size === size) return this.pending.promise;
    const promise = this.queue.then(() => this.readNow(path, size));
    const entry = { path, size, promise };
    this.pending = entry;
    this.queue = promise.catch(() => undefined).finally(() => { if (this.pending === entry) this.pending = null; });
    return promise;
  }

  private async readNow(path: string, size: number): Promise<R> {
    const handle = await open(path, "r");
    try {
      if (this.sink === null || size < this.offset || !(await this.endsLine(handle))) {
        this.sink = this.create();
        this.offset = 0;
      }
      let carry = Buffer.alloc(0);
      for (let position = this.offset; position < size;) {
        const bytes = Buffer.alloc(Math.min(RECORD_READ_CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
        if (bytesRead === 0) break;
        this.bytesRead += bytesRead;
        position += bytesRead;
        const data = carry.length ? Buffer.concat([carry, bytes.subarray(0, bytesRead)]) : bytes.subarray(0, bytesRead);
        const end = data.lastIndexOf(0x0a);
        if (end < 0) {
          carry = data;
          continue;
        }
        await this.sink.push(data.subarray(0, end).toString("utf8").split("\n"));
        this.offset += end + 1;
        carry = data.subarray(end + 1);
      }
    } finally {
      await handle.close();
    }
    return this.sink!.result();
  }

  private async endsLine(handle: Awaited<ReturnType<typeof open>>): Promise<boolean> {
    if (this.offset === 0) return true;
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, this.offset - 1);
    return bytesRead === 1 && byte[0] === 0x0a;
  }
}

const keepForAsks = (message: ConversationMessage): boolean => message.role === "user" || (message.role === "assistant" && message.text.includes(ASK_FENCE_INFO));

export interface TodoAskRecordRead {
  readonly endedAt: number;
  readonly messages: Array<TodoRecordMessage & { role: "user" | "assistant" }>;
}

export class TodoAskRecordReader extends RecordTailReader<TodoAskRecordRead> {
  constructor(sessionId: string) {
    super(() => {
      const parser = createConversationMessageParser(sessionId, keepForAsks);
      return {
        push: lines => parser.push(lines),
        result: () => {
          const read = parser.result();
          return { endedAt: read.lastTimestamp, messages: todoAskSourceMessages(read.messages) };
        },
      };
    });
  }
}

function decisionSink(sessionId: string, otherChoice: string, state: { tracker?: TodoAskDecisionTracker }, known?: readonly TodoDecisionAsk[]): RecordLineSink<readonly TodoDecision[]> {
  const parser = createConversationMessageParser(sessionId, keepForAsks);
  const tracker = state.tracker = todoAskDecisionTracker(sessionId, otherChoice, known);
  return {
    push: lines => parser.push(lines),
    result: () => {
      tracker.add(parser.result().messages);
      return tracker.decisions();
    },
  };
}

export class TodoDecisionRecordReader extends RecordTailReader<readonly TodoDecision[]> {
  private readonly state: { tracker?: TodoAskDecisionTracker };

  constructor(private readonly sessionId: string, private readonly otherChoice: string) {
    const state: { tracker?: TodoAskDecisionTracker } = {};
    super(() => decisionSink(sessionId, otherChoice, state));
    this.state = state;
  }

  resume(cursor: TodoDecisionCursor): void {
    this.resumeAt(cursor.offset, decisionSink(this.sessionId, this.otherChoice, this.state, cursor.asks));
  }

  asks(): TodoDecisionAsk[] {
    return this.state.tracker?.asks() ?? [];
  }
}

export const TODO_DECISION_HEAD_BYTES = 4096;

export interface TodoDecisionCursor {
  readonly offset: number;
  readonly headLength: number;
  readonly head: string;
  readonly asks: readonly TodoDecisionAsk[];
}

export function isTodoDecisionCursor(value: unknown): value is TodoDecisionCursor {
  if (typeof value !== "object" || value === null) return false;
  const cursor = value as Record<string, unknown>;
  return Number.isSafeInteger(cursor.offset) && Number.isSafeInteger(cursor.headLength) && typeof cursor.head === "string" && Array.isArray(cursor.asks)
    && cursor.asks.every(ask => Array.isArray(ask) && typeof ask[0] === "string" && Array.isArray(ask[1]) && ask[1].every(label => typeof label === "string"));
}

async function recordHead(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    return createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}

export interface TodoDecisionRead {
  readonly reader?: TodoDecisionRecordReader;
  readonly decisions: readonly TodoDecision[];
  readonly cursor: TodoDecisionCursor;
}

export async function readTodoDecisions(sessionId: string, otherChoice: string, file: { path: string; size: number }, known?: TodoDecisionRecordReader, cursor?: TodoDecisionCursor): Promise<TodoDecisionRead> {
  let reader = known;
  if (reader === undefined) {
    const same = cursor !== undefined && cursor.offset <= file.size && await recordHead(file.path, cursor.headLength) === cursor.head;
    if (same && cursor.offset === file.size) return { decisions: [], cursor };
    reader = new TodoDecisionRecordReader(sessionId, otherChoice);
    if (same) reader.resume(cursor);
  }
  const decisions = await reader.read(file.path, file.size);
  const headLength = Math.min(TODO_DECISION_HEAD_BYTES, reader.position);
  return { reader, decisions, cursor: { offset: reader.position, headLength, head: await recordHead(file.path, headLength), asks: reader.asks() } };
}

export type TodoDecisionSaved = (TodoDecisionCursor & { readonly path: string }) | { readonly gone: true };

function parseTodoDecisionSaved(value: unknown): TodoDecisionSaved | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ((value as { gone?: unknown }).gone === true) return { gone: true };
  return isTodoDecisionCursor(value) && typeof (value as { path?: unknown }).path === "string" ? value as TodoDecisionSaved : undefined;
}

export type TodoDecisionRecordOutcome = "recorded" | "unlinked" | "failed";

export interface TodoDecisionRecorderDeps {
  readonly enabled: () => boolean;
  readonly otherChoice: () => string;
  readonly saved: (sessionId: string) => unknown;
  readonly save: (sessionId: string, value: TodoDecisionSaved | undefined) => void;
  readonly knownPath: (sessionId: string) => string | undefined;
  readonly rememberPath: (sessionId: string, path: string | undefined) => void;
  readonly lookup: (sessionId: string) => { readonly path: string | null; readonly reason: string | null };
  readonly inStore: (path: string) => boolean;
  readonly record: (sessionId: string, decisions: readonly TodoDecision[]) => Promise<TodoDecisionRecordOutcome>;
  readonly log: (line: string) => void;
}

export const TODO_DECISION_RETRY_MS = 60_000;
export const TODO_DECISION_RETRY_LIMIT = 3;
export const TODO_DECISION_SWEEP_PARALLEL = 2;

export class TodoDecisionRecorder {
  private readonly readers = new Map<string, TodoDecisionRecordReader>();
  private readonly recorded = new Map<string, Set<string>>();
  private readonly live = new Set<string>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly deps: TodoDecisionRecorderDeps, private readonly retryMs = TODO_DECISION_RETRY_MS) {}

  turnEnded(sessionId: string): Promise<void> {
    this.live.add(sessionId);
    return this.record(sessionId);
  }

  ended(sessionId: string): void {
    this.live.delete(sessionId);
    this.readers.delete(sessionId);
    this.recorded.delete(sessionId);
  }

  keepOnly(sessions: ReadonlySet<string>): void {
    for (const cache of [this.readers, this.recorded, this.failures]) for (const sessionId of cache.keys()) if (!sessions.has(sessionId)) cache.delete(sessionId);
    for (const sessionId of this.live) if (!sessions.has(sessionId)) this.live.delete(sessionId);
  }

  async sweep(sessions: readonly string[]): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < sessions.length; index = next++) await this.record(sessions[index]);
    };
    await Promise.all(Array.from({ length: Math.min(TODO_DECISION_SWEEP_PARALLEL, sessions.length) }, worker));
  }

  dispose(): void {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  record(sessionId: string): Promise<void> {
    const run = (this.runs.get(sessionId) ?? Promise.resolve()).then(() => this.recordNow(sessionId))
      .finally(() => { if (this.runs.get(sessionId) === run) this.runs.delete(sessionId); });
    this.runs.set(sessionId, run);
    return run;
  }

  private failed(sessionId: string): void {
    const failures = (this.failures.get(sessionId) ?? 0) + 1;
    this.failures.set(sessionId, failures);
    if (failures > TODO_DECISION_RETRY_LIMIT) return;
    if (failures === TODO_DECISION_RETRY_LIMIT) {
      this.deps.log(`[todo] stopped retrying to record the decisions of ${sessionId}; its next turn end tries again`);
      return;
    }
    if (this.retries.has(sessionId)) return;
    this.retries.set(sessionId, setTimeout(() => {
      this.retries.delete(sessionId);
      void this.record(sessionId);
    }, this.retryMs));
  }

  private async sourceFile(sessionId: string, saved: string | undefined): Promise<{ path: string; size: number } | "gone" | undefined> {
    for (const path of new Set([this.deps.knownPath(sessionId), saved])) {
      if (path === undefined) continue;
      try { return { path, size: (await stat(path)).size }; } catch { this.deps.rememberPath(sessionId, undefined); }
    }
    const found = this.deps.lookup(sessionId);
    if (found.path === null) return found.reason === "not_found" ? "gone" : undefined;
    this.deps.rememberPath(sessionId, found.path);
    try { return { path: found.path, size: (await stat(found.path)).size }; } catch { return undefined; }
  }

  private async recordNow(sessionId: string): Promise<void> {
    if (!this.deps.enabled()) return;
    const outcome = await this.attempt(sessionId);
    if (outcome === "failed") this.failed(sessionId);
    else this.failures.delete(sessionId);
  }

  private async attempt(sessionId: string): Promise<"done" | "failed"> {
    const saved = parseTodoDecisionSaved(this.deps.saved(sessionId));
    if (saved && "gone" in saved && !this.live.has(sessionId)) return "done";
    const cursor = saved && !("gone" in saved) ? saved : undefined;
    try {
      const file = await this.sourceFile(sessionId, cursor?.path);
      if (file === "gone") {
        this.readers.delete(sessionId);
        if (!saved || !("gone" in saved)) this.deps.save(sessionId, { gone: true });
        return "done";
      }
      if (!file) return "failed";
      if (!this.deps.inStore(file.path)) return "done";
      const read = await readTodoDecisions(sessionId, this.deps.otherChoice(), file, this.readers.get(sessionId), cursor?.path === file.path ? cursor : undefined);
      const live = this.live.has(sessionId);
      if (live && read.reader) this.readers.set(sessionId, read.reader);
      const recorded = this.recorded.get(sessionId) ?? new Set<string>();
      if (live) this.recorded.set(sessionId, recorded);
      const decisions = read.decisions.filter(decision => !recorded.has(todoDecisionKey(decision)));
      if (decisions.length > 0) {
        const outcome = await this.deps.record(sessionId, decisions);
        if (outcome === "failed") return "failed";
        if (outcome === "unlinked") return "done";
        for (const decision of decisions) recorded.add(todoDecisionKey(decision));
      }
      if (cursor?.path !== file.path || cursor.offset !== read.cursor.offset || cursor.head !== read.cursor.head) this.deps.save(sessionId, { ...read.cursor, path: file.path });
      return "done";
    } catch (error) {
      this.deps.log(`[todo] could not record the decisions of a conversation: ${String(error)}`);
      return "failed";
    }
  }
}

export interface TodoWorkTurn {
  readonly start: number;
  readonly end: number;
}

export type TodoWorkTurns = ReadonlyMap<string, TodoWorkTurn>;

const COMPACT_COMMAND = /<command-name>\/compact<\/command-name>/;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord(record: Record<string, unknown>): "close" | "skip" | null {
  if (record.type === "system" && record.subtype === "compact_boundary") return isRecordObject(record.compact_metadata) && record.compact_metadata.trigger === "manual" ? "close" : "skip";
  if (record.type !== "user") return null;
  if (record.isCompactSummary === true) return "skip";
  const content = isRecordObject(record.message) ? record.message.content : undefined;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map(block => isRecordObject(block) && typeof block.text === "string" ? block.text : "").join("") : "";
  return COMPACT_COMMAND.test(text) ? "close" : null;
}

function turnStart(record: Record<string, unknown>): boolean {
  if (extractHumanUserPrompt(record) !== null) return true;
  return record.type === "user" && record.isMeta !== true && extractCliInsertedUserText(record) !== null;
}

export function todoWorkTurnSink(): RecordLineSink<TodoWorkTurns> {
  const turns = new Map<string, TodoWorkTurn>();
  let current: { uuid: string; start: number; end: number } | undefined;
  const settled = (turn: { uuid: string; start: number; end: number }): TodoWorkTurn => ({ start: turn.start, end: Math.max(turn.end, turns.get(turn.uuid)?.end ?? turn.end) });
  const close = () => {
    if (!current) return;
    turns.set(current.uuid, settled(current));
    current = undefined;
  };
  return {
    push(lines) {
      for (const line of lines) {
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        if (!isRecordObject(record) || record.isSidechain === true || record.isMeta === true || record.forkedFrom !== undefined) continue;
        const compact = compactRecord(record);
        if (compact === "close") close();
        if (compact !== null) continue;
        const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
        if (!Number.isFinite(at)) continue;
        if (turnStart(record) && typeof record.uuid === "string" && record.uuid.length > 0) {
          close();
          current = { uuid: record.uuid, start: at, end: at };
          continue;
        }
        if (current && (record.type === "user" || record.type === "assistant")) current.end = Math.max(current.end, at);
      }
    },
    result() {
      const out = new Map(turns);
      if (current) out.set(current.uuid, settled(current));
      return out;
    },
  };
}

export function todoWorkTurnReader(): RecordTailReader<TodoWorkTurns> {
  return new RecordTailReader(todoWorkTurnSink);
}

export function todoWorkTotal(records: Iterable<TodoWorkTurns>): number {
  const merged = new Map<string, TodoWorkTurn>();
  for (const turns of records) {
    for (const [uuid, turn] of turns) {
      const known = merged.get(uuid);
      merged.set(uuid, known === undefined ? turn : { start: Math.min(known.start, turn.start), end: Math.max(known.end, turn.end) });
    }
  }
  let total = 0;
  for (const turn of merged.values()) total += Math.max(0, turn.end - turn.start);
  return total;
}
