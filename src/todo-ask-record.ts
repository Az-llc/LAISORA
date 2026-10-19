import { open } from "node:fs/promises";
import type { ConversationMessage } from "./conversation-history";
import { ASK_FENCE_INFO } from "./markdown-ast";
import { createConversationMessageParser, extractCliInsertedUserText, extractHumanUserPrompt } from "./session-transcript";
import { todoAskSourceMessages, type TodoRecordMessage } from "./todo-model";

export interface RecordLineSink<R> {
  push(lines: string[]): Promise<void> | void;
  result(): R;
}

export class RecordTailReader<R> {
  private sink: RecordLineSink<R> | null = null;
  private offset = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { path: string; size: number; promise: Promise<R> } | null = null;
  bytesRead = 0;

  constructor(private readonly create: () => RecordLineSink<R>) {}

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
      if (size > this.offset) {
        const bytes = Buffer.alloc(size - this.offset);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, this.offset);
        this.bytesRead += bytesRead;
        const end = bytes.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (end >= 0) {
          await this.sink.push(bytes.subarray(0, end).toString("utf8").split("\n"));
          this.offset += end + 1;
        }
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
