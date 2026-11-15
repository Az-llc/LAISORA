import type { FileHandle } from "node:fs/promises";

export const SUBAGENTS_DIR_NAME = "subagents";
const AGENT_PREFIX = "agent-";
const TRANSCRIPT_SUFFIX = ".jsonl";
const META_SUFFIX = ".meta.json";
const TRANSCRIPT_SUFFIX_RE = /\.jsonl$/i;

export function subagentDirOf(sessionFilePath: string): string | undefined {
  const base = sessionFilePath.replace(TRANSCRIPT_SUFFIX_RE, "");
  return base === sessionFilePath ? undefined : `${base}/${SUBAGENTS_DIR_NAME}`;
}

export function subagentTranscriptName(agentId: string): string {
  return `${AGENT_PREFIX}${agentId}${TRANSCRIPT_SUFFIX}`;
}

export function subagentMetaName(agentId: string): string {
  return `${AGENT_PREFIX}${agentId}${META_SUFFIX}`;
}

function agentIdOf(name: string, suffix: string): string | undefined {
  if (!name.startsWith(AGENT_PREFIX) || !name.endsWith(suffix)) return undefined;
  const agentId = name.slice(AGENT_PREFIX.length, name.length - suffix.length);
  return agentId.length > 0 ? agentId : undefined;
}

export function agentIdOfTranscriptName(name: string): string | undefined {
  return agentIdOf(name, TRANSCRIPT_SUFFIX);
}

export function agentIdOfMetaName(name: string): string | undefined {
  return agentIdOf(name, META_SUFFIX);
}

export function isSubagentMetaName(name: string): boolean {
  return name.endsWith(META_SUFFIX);
}

export function subagentMetaPathOf(transcriptPath: string): string {
  return transcriptPath.replace(TRANSCRIPT_SUFFIX_RE, META_SUFFIX);
}

export function isSubagentTranscriptPath(filePath: string): boolean {
  return filePath.split(/[\\/]/).includes(SUBAGENTS_DIR_NAME);
}

export function parseSubagentMeta(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function readSubagentMeta(metaPath: string, readText: (path: string) => Promise<string>): Promise<Record<string, unknown> | null> {
  return parseSubagentMeta(await readText(metaPath).catch(() => ""));
}

export function readSubagentMetaSync(metaPath: string, readText: (path: string) => string): Record<string, unknown> | null {
  try {
    return parseSubagentMeta(readText(metaPath));
  } catch {
    return null;
  }
}

export function subagentLaunchToolUseId(meta: Record<string, unknown> | null): string | undefined {
  return typeof meta?.toolUseId === "string" ? meta.toolUseId : undefined;
}

export interface ForkLaunch {
  toolUseId: string;
  settled: boolean;
}

export function forkLaunchOf(meta: Record<string, unknown> | null): ForkLaunch | undefined {
  const toolUseId = meta?.isFork === true ? subagentLaunchToolUseId(meta) : undefined;
  return toolUseId === undefined ? undefined : { toolUseId, settled: meta!.finished === true || meta!.stoppedByUser === true };
}

export function isForkLaunchRecord(record: unknown, launchToolUseId: string): boolean {
  if (typeof record !== "object" || record === null) return false;
  const { type, message } = record as { type?: unknown; message?: { content?: unknown } };
  const content = typeof message === "object" && message !== null ? message.content : undefined;
  return type === "assistant" && Array.isArray(content)
    && content.some((block) => typeof block === "object" && block !== null && block.type === "tool_use" && block.id === launchToolUseId);
}

function isForkLaunchLine(line: string, launchToolUseId: string): boolean {
  if (!line.includes(launchToolUseId)) return false;
  try { return isForkLaunchRecord(JSON.parse(line), launchToolUseId); } catch { return false; }
}

export interface ForkCopies {
  copied: number;
  launchMissing: boolean;
}

function forkCopiesAt(launchIndex: number, itemCount: number, fork: ForkLaunch): ForkCopies {
  if (launchIndex >= 0) return { copied: launchIndex + 1, launchMissing: false };
  return fork.settled ? { copied: 0, launchMissing: true } : { copied: itemCount, launchMissing: false };
}

export function forkCopiedCount<T>(items: readonly T[], fork: ForkLaunch | undefined, recordOf: (item: T) => unknown): ForkCopies {
  if (fork === undefined) return { copied: 0, launchMissing: false };
  return forkCopiesAt(items.findIndex((item) => isForkLaunchRecord(recordOf(item), fork.toolUseId)), items.length, fork);
}

export function forkCopiedLineCount(lines: readonly string[], fork: ForkLaunch | undefined): ForkCopies {
  if (fork === undefined) return { copied: 0, launchMissing: false };
  return forkCopiesAt(lines.findIndex((line) => isForkLaunchLine(line, fork.toolUseId)), lines.length, fork);
}

const FORK_SCAN_CHUNK_BYTES = 1 << 20;

async function* handleLines(handle: FileHandle, byteLength: number): AsyncGenerator<{ line: Buffer; end: number }> {
  const chunk = Buffer.alloc(FORK_SCAN_CHUNK_BYTES);
  let pending: Buffer[] = [];
  let offset = 0;
  while (offset < byteLength) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, byteLength - offset), offset);
    if (bytesRead === 0) break;
    const data = chunk.subarray(0, bytesRead);
    let start = 0;
    for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
      const line = pending.length > 0 ? Buffer.concat([...pending, data.subarray(start, newline)]) : data.subarray(start, newline);
      pending = [];
      start = newline + 1;
      yield { line, end: offset + start };
    }
    if (start < data.length) pending.push(Buffer.from(data.subarray(start)));
    offset += bytesRead;
  }
  if (pending.length > 0) yield { line: Buffer.concat(pending), end: offset };
}

export async function forkOwnStart(handle: FileHandle, byteLength: number, fork: ForkLaunch | undefined):
  Promise<{ offset: number; launchMissing: boolean }> {
  if (fork === undefined) return { offset: 0, launchMissing: false };
  const mark = Buffer.from(fork.toolUseId);
  let index = 0;
  let end = 0;
  for await (const line of handleLines(handle, byteLength)) {
    end = line.end;
    if (line.line.indexOf(mark) !== -1 && isForkLaunchLine(line.line.toString("utf8"), fork.toolUseId)) return { offset: line.end, launchMissing: false };
    index++;
  }
  const copies = forkCopiesAt(-1, index, fork);
  return { offset: copies.copied === 0 ? 0 : end, launchMissing: copies.launchMissing };
}

export function withoutForkLaunchAnswer<R extends Record<string, unknown>>(record: R, fork: ForkLaunch | undefined): R {
  if (fork === undefined || record.type !== "user") return record;
  const message = record.message;
  if (typeof message !== "object" || message === null) return record;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return record;
  const own = content.filter((block) => !(typeof block === "object" && block !== null && block.type === "tool_result" && block.tool_use_id === fork.toolUseId));
  return own.length === content.length ? record : { ...record, message: { ...message, content: own } };
}
