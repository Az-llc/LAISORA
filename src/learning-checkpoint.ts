import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";

export const CHECKPOINT_MIN_GAIN_BYTES = 1 << 20;
export const CHECKPOINT_RENAME_RETRY_MS = [25, 50, 100, 200, 400];
export const CHECKPOINT_STALE_TEMPORARY_MS = 10 * 60 * 1000;
export const learningReadChunk = { bytes: 8 << 20 };
export const LEARNING_MAX_LINE_BYTES = 1 << 20;
const CHECKPOINT_SCHEMA = 3;

export interface CheckpointPayload { dictionary: unknown[]; conflictedContexts: string[]; locations: unknown[]; records: unknown[]; conflicts: string[]; skipped: number }
export interface CheckpointCandidate { name: string; offset: number }
export interface VerifiedPrefix { offset: number; digest: string; hash: Hash }

let codeIdentity: Promise<string | undefined> | undefined;
export function checkpointCompatibility(): Promise<string | undefined> {
  return codeIdentity ??= (async () => {
    if (typeof __filename !== "string") return undefined;
    try { return createHash("sha256").update(await readFile(__filename)).digest("hex").slice(0, 16); }
    catch { return undefined; }
  })();
}

const checkpointPrefix = (ledger: string): string => `${basename(ledger)}.checkpoint-v${CHECKPOINT_SCHEMA}.`;
function parseName(ledger: string, name: string): { compat: string; offset: number } | undefined {
  const prefix = checkpointPrefix(ledger);
  const match = name.startsWith(prefix) ? /^([a-f0-9]{16})\.(\d{20})\.[a-f0-9-]{36}\.json\.gz$/.exec(name.slice(prefix.length)) : null;
  if (!match) return undefined;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) ? { compat: match[1], offset } : undefined;
}

export async function checkpointCandidates(ledger: string): Promise<CheckpointCandidate[]> {
  const compat = await checkpointCompatibility();
  if (!compat) return [];
  let names: string[];
  try { names = await readdir(dirname(ledger)); } catch { return []; }
  return names.flatMap(name => {
    const parsed = parseName(ledger, name);
    return parsed && parsed.compat === compat && parsed.offset > 0 ? [{ name, offset: parsed.offset }] : [];
  }).sort((a, b) => b.offset - a.offset || a.name.localeCompare(b.name));
}

export async function hashPrefix(file: string, offsets: readonly number[]): Promise<Map<number, VerifiedPrefix>> {
  const wanted = [...new Set(offsets)].filter(offset => offset > 0).sort((a, b) => a - b);
  const result = new Map<number, VerifiedPrefix>();
  if (!wanted.length) return result;
  const handle = await open(file, "r");
  try {
    const hash = createHash("sha256"), buffer = Buffer.alloc(Math.min(learningReadChunk.bytes, wanted.at(-1)!));
    let position = 0;
    for (const offset of wanted) {
      while (position < offset) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, offset - position), position);
        if (!bytesRead) return result;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      result.set(offset, { offset, digest: hash.copy().digest("hex"), hash: hash.copy() });
    }
    return result;
  } finally { await handle.close(); }
}

async function* gunzipChunks(file: string): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  pipeline(createReadStream(file, { highWaterMark: Math.min(learningReadChunk.bytes, 1 << 16) }), gunzip, () => undefined);
  for await (const chunk of gunzip) yield chunk as Buffer;
}

async function* gunzipLines(file: string): AsyncGenerator<Buffer> {
  let carry = Buffer.alloc(0);
  for await (const chunk of gunzipChunks(file)) {
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      if (end - start > LEARNING_MAX_LINE_BYTES) throw new Error("learning checkpoint line too long");
      yield data.subarray(start, end);
      start = end + 1;
    }
    if (data.length - start > LEARNING_MAX_LINE_BYTES) throw new Error("learning checkpoint line too long");
    carry = Buffer.from(data.subarray(start));
  }
  if (carry.length) throw new Error("learning checkpoint truncated");
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export async function loadCheckpoint(ledger: string, candidate: CheckpointCandidate, prefixDigest: string): Promise<CheckpointPayload | undefined> {
  const compat = await checkpointCompatibility();
  const dictionary: unknown[] = [], conflictedContexts: string[] = [], locations: unknown[] = [], conflicts: string[] = [], records: unknown[] = [];
  let header: Record<string, unknown> | undefined;
  try {
    for await (const line of gunzipLines(join(dirname(ledger), candidate.name))) {
      const value = JSON.parse(line.toString("utf8"));
      if (!header) {
        header = value;
        if (!header || header.schema !== CHECKPOINT_SCHEMA || header.compat !== compat || header.offset !== candidate.offset || header.prefixHash !== prefixDigest
          || ![header.skipped, header.dictionary, header.conflictedContexts, header.locations, header.conflicts, header.records].every(count)) return undefined;
      } else if (dictionary.length < (header.dictionary as number)) dictionary.push(value);
      else if (conflictedContexts.length < (header.conflictedContexts as number)) {
        if (typeof value !== "string") return undefined;
        conflictedContexts.push(value);
      } else if (locations.length < (header.locations as number)) locations.push(value);
      else if (conflicts.length < (header.conflicts as number)) {
        if (typeof value !== "string") return undefined;
        conflicts.push(value);
      } else {
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.opId !== "string") return undefined;
        records.push(value);
      }
    }
  } catch { return undefined; }
  if (!header || header.dictionary !== dictionary.length || header.conflictedContexts !== conflictedContexts.length || header.locations !== locations.length
    || header.conflicts !== conflicts.length || header.records !== records.length) return undefined;
  const ids = new Set(records.map(record => (record as { opId: string }).opId));
  if (ids.size !== records.length || new Set(conflicts).size !== conflicts.length || !conflicts.every(id => ids.has(id))) return undefined;
  return { dictionary, conflictedContexts, locations, records, conflicts, skipped: header.skipped as number };
}

export async function sameCheckpointContent(ledger: string, names: readonly string[]): Promise<boolean> {
  const digests = new Set<string>();
  for (const name of names) {
    try {
      const hash = createHash("sha256");
      for await (const chunk of gunzipChunks(join(dirname(ledger), name))) hash.update(chunk);
      digests.add(hash.digest("hex"));
    } catch { return false; }
  }
  return digests.size === 1;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= CHECKPOINT_RENAME_RETRY_MS.length || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, CHECKPOINT_RENAME_RETRY_MS[attempt]));
    }
  }
}

export async function publishCheckpoint(ledger: string, offset: number, prefixDigest: string, payload: CheckpointPayload,
  invalid: readonly string[] = []): Promise<string | undefined> {
  const compat = await checkpointCompatibility();
  if (!compat || offset <= 0) return undefined;
  const directory = dirname(ledger), prefix = checkpointPrefix(ledger);
  if ((await checkpointCandidates(ledger)).some(candidate => candidate.offset >= offset && !invalid.includes(candidate.name))) return undefined;
  const temporary = join(directory, `${prefix}${randomUUID()}.tmp`);
  const name = `${prefix}${compat}.${String(offset).padStart(20, "0")}.${randomUUID()}.json.gz`;
  const handle = await open(temporary, "wx");
  let renamed = false;
  try {
    try {
      const gzip = createGzip();
      const written = (async () => { for await (const chunk of gzip) await handle.write(chunk as Buffer); })();
      written.catch(() => undefined);
      const write = async (text: string) => { if (!gzip.write(text)) await Promise.race([once(gzip, "drain"), written]); };
      await write(`${JSON.stringify({ schema: CHECKPOINT_SCHEMA, compat, offset, prefixHash: prefixDigest, skipped: payload.skipped,
        dictionary: payload.dictionary.length, conflictedContexts: payload.conflictedContexts.length, locations: payload.locations.length,
        conflicts: payload.conflicts.length, records: payload.records.length })}\n`);
      let batch = "";
      for (const part of [payload.dictionary, payload.conflictedContexts, payload.locations, payload.conflicts, payload.records]) for (const value of part) {
        const line = `${JSON.stringify(value)}\n`;
        if (line.length > LEARNING_MAX_LINE_BYTES / 3 && Buffer.byteLength(line) > LEARNING_MAX_LINE_BYTES) throw new Error("learning checkpoint line too long");
        if (batch.length + line.length > learningReadChunk.bytes && batch) { await write(batch); batch = ""; }
        batch += line;
      }
      if (batch) await write(batch);
      gzip.end();
      await written;
      await handle.sync();
    } finally { await handle.close(); }
    await renameWithRetry(temporary, join(directory, name));
    renamed = true;
  } finally { if (!renamed) await unlink(temporary).catch(() => undefined); }
  if ((await checkpointCandidates(ledger)).some(candidate => candidate.offset > offset && !invalid.includes(candidate.name))) {
    await unlink(join(directory, name)).catch(() => undefined);
    return undefined;
  }
  await removeSuperseded(ledger, offset, invalid);
  return name;
}

async function removeSuperseded(ledger: string, offset: number, invalid: readonly string[]): Promise<void> {
  const directory = dirname(ledger), prefix = checkpointPrefix(ledger);
  let names: string[];
  try { names = await readdir(directory); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const parsed = parseName(ledger, name);
    if (parsed ? parsed.offset < offset || invalid.includes(name) : false) await unlink(join(directory, name)).catch(() => undefined);
    else if (!parsed && name.endsWith(".tmp")) {
      const info = await stat(join(directory, name)).catch(() => undefined);
      if (info && now - info.mtimeMs > CHECKPOINT_STALE_TEMPORARY_MS) await unlink(join(directory, name)).catch(() => undefined);
    }
  }
}
