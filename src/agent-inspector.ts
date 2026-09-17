import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import type {
  AgentInspectorCoverage,
  AgentInspectorErrorReason,
  AgentInspectorMessageItem,
  AgentInspectorPage,
  AgentInspectorSection,
  AgentInspectorToolItem,
  AgentInspectorTruncatedReason,
} from "./protocol";
import { summarizeToolInput } from "./protocol";
import { claudeProjectsDir } from "./claude-env";

export const INSPECTOR_TOOL_PAGE_SIZE = 25;
export const INSPECTOR_MESSAGE_PAGE_SIZE = 20;
export const INSPECTOR_PREVIEW_BYTES = 8 * 1024;
export const INSPECTOR_CHUNK_BYTES = 32 * 1024;
export const INSPECTOR_RESPONSE_BYTES = 256 * 1024;
export const INSPECTOR_READ_BYTES = 512 * 1024;
export const INSPECTOR_RECORD_BYTES = 1024 * 1024;
export const INSPECTOR_CACHE_BYTES = 2 * 1024 * 1024;

const META_FILE_MAX = 64 * 1024;
const META_COUNT_MAX = 1024;
const META_TOTAL_MAX = 128 * 1024;
const PAGE_PAYLOAD_BUDGET = 240 * 1024;

export class AgentInspectorReadError extends Error {
  constructor(readonly reason: AgentInspectorErrorReason, readonly detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

// ENOENT だけが「無い」。それ以外（EACCES・EPERM・同期ロック等）は有無を確かめられなかった
// ので read-failed に detail を付ける。同じ理由へ畳むと「まだ利用できません」（待てば出る）へ誘導する（R-37）
function notFoundOrReadFailed(notFound: AgentInspectorErrorReason): (err: unknown) => never {
  return (err) => {
    if ((err as { code?: unknown })?.code === "ENOENT") throw new AgentInspectorReadError(notFound);
    throw new AgentInspectorReadError("read-failed", err instanceof Error ? err.message : String(err));
  };
}

export interface AgentInspectorReadRequest {
  sessionFilePath: string;
  sessionStoreRoot?: string;
  toolUseId: string;
  agentTranscriptId?: string;
  section: AgentInspectorSection;
  cursor?: string;
  // tabId + generation。cursorを別タブ・別世代へ流用させない。
  scopeKey: string;
}

export interface AgentInspectorReadResult {
  fingerprint: { size: number; mtimeMs: number };
  page: AgentInspectorPage;
}

interface CachedTranscript {
  key: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  lines: string[];
  bytesRead: number;
  malformedRecordCount: number;
  skippedRecordCount: number;
  truncatedReasons: AgentInspectorTruncatedReason[];
  cacheBytes: number;
}

interface CursorState {
  scopeKey: string;
  cacheKey: string;
  toolUseId: string;
  section: AgentInspectorSection;
  index: number;
}

interface LocatedAgent {
  transcriptPath: string;
  meta: Record<string, unknown>;
  metaLimitReached: boolean;
  bytesRead: number;
}

const transcriptCache = new Map<string, CachedTranscript>();
const cursors = new Map<string, CursorState>();
let transcriptCacheBytes = 0;

export function releaseInspectorCursor(token: string): void {
  cursors.delete(token);
}

export function clearAgentInspectorCacheForTest(): void {
  transcriptCache.clear();
  cursors.clear();
  transcriptCacheBytes = 0;
}

export function agentInspectorCacheStatsForTest(): { entries: number; bytes: number; cursors: number } {
  return { entries: transcriptCache.size, bytes: transcriptCacheBytes, cursors: cursors.size };
}

export async function readAgentInspectorPage(
  request: AgentInspectorReadRequest
): Promise<AgentInspectorReadResult> {
  const root = await realpath(request.sessionStoreRoot ?? claudeProjectsDir())
    .catch(notFoundOrReadFailed("session-unavailable"));
  const sessionPath = await realpath(request.sessionFilePath)
    .catch(notFoundOrReadFailed("session-unavailable"));
  await assertRegularFileInside(root, sessionPath, "session-unavailable");
  if (!sessionPath.toLowerCase().endsWith(".jsonl")) {
    throw new AgentInspectorReadError("session-unavailable");
  }

  const subagentDir = `${sessionPath.slice(0, -".jsonl".length)}/subagents`;
  const realSubagentDir = await realpath(subagentDir)
    .catch(notFoundOrReadFailed("agent-unavailable"));
  assertInside(root, realSubagentDir, "agent-unavailable");
  const located = await locateAgent(realSubagentDir, request.toolUseId, request.agentTranscriptId);
  const transcriptPath = await realpath(located.transcriptPath)
    .catch(notFoundOrReadFailed("transcript-unavailable"));
  assertInside(realSubagentDir, transcriptPath, "transcript-unavailable");
  const fileStat = await stat(transcriptPath)
    .catch(notFoundOrReadFailed("transcript-unavailable"));
  if (!fileStat.isFile()) throw new AgentInspectorReadError("transcript-unavailable");
  const fingerprint = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
  const cacheKey = [transcriptPath, fileStat.size, fileStat.mtimeMs, fileStat.ctimeMs, fileStat.dev, fileStat.ino]
    .join("\u0000");

  let index = 0;
  const cursorToken = request.cursor;
  let cursorState: CursorState | undefined;
  if (request.cursor !== undefined) {
    const state = cursors.get(request.cursor);
    if (!state || state.scopeKey !== request.scopeKey || state.cacheKey !== cacheKey ||
        state.toolUseId !== request.toolUseId || state.section !== request.section) {
      cursors.delete(request.cursor);
      throw new AgentInspectorReadError("invalid-cursor");
    }
    index = state.index;
    cursorState = state;
    cursors.delete(request.cursor);
  }

  try {
    let cached = transcriptCache.get(cacheKey);
    if (cached) {
      transcriptCache.delete(cacheKey);
      transcriptCache.set(cacheKey, cached);
    } else {
      cached = await readTranscriptSample(
        transcriptPath,
        fileStat,
        cacheKey,
        Math.max(0, INSPECTOR_READ_BYTES - located.bytesRead)
      );
      rememberTranscript(cached);
    }

    const records: Record<string, unknown>[] = [];
    let malformed = cached.malformedRecordCount;
    let skipped = cached.skippedRecordCount;
    for (const line of cached.lines) {
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > INSPECTOR_RECORD_BYTES) {
        skipped++;
        continue;
      }
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) malformed++;
        else records.push(parsed as Record<string, unknown>);
      } catch {
        malformed++;
      }
    }

    const reasons = [...cached.truncatedReasons];
    if (located.metaLimitReached) reasons.push("meta-limit");
    if (malformed > 0 && !reasons.includes("malformed-record")) reasons.push("malformed-record");
    if (skipped > 0 && !reasons.includes("record-limit")) reasons.push("record-limit");
    const baseCoverage = (returnedRecords: number): AgentInspectorCoverage => ({
      state: reasons.length === 0 ? "complete" : "partial",
      returnedRecords,
      bytesRead: cached!.bytesRead + located.bytesRead,
      fileSize: cached!.size,
      malformedRecordCount: malformed,
      skippedRecordCount: skipped,
      truncatedReasons: reasons,
    });

    if (request.section === "overview") {
      const instruction = firstInstruction(records);
      const startedAt = firstTimestamp(records);
      const endedAt = lastTimestamp(records);
      const modelMeasured = firstString(records, (record) => asRecord(record.message)?.model);
      const effortMeasured = firstString(records, (record) => record.effort);
      const clippedInstruction = clipUtf8(instruction, INSPECTOR_PREVIEW_BYTES);
      const previewTruncated = clippedInstruction.length !== instruction.length;
      return {
        fingerprint,
        page: {
          section: "overview",
          overview: {
            agentType: stringValue(located.meta.agentType),
            description: stringValue(located.meta.description) ?? "",
            instruction: clippedInstruction,
            modelMeasured,
            effortMeasured,
            startedAt,
            endedAt,
            elapsedMs: startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined,
            spawnedWithWorktree: typeof located.meta.spawnedWithWorktree === "boolean"
              ? located.meta.spawnedWithWorktree : undefined,
            worktreeBranch: stringValue(located.meta.worktreeBranch),
          },
          coverage: withCoverageLimits(baseCoverage(1), previewTruncated ? 1 : 0, false),
        },
      };
    }

    if (request.section === "tools") {
      const toolData = toolItems(records);
      const tools = toolData.items;
      const candidates = tools.slice(index, index + INSPECTOR_TOOL_PAGE_SIZE);
      const pageItems = fitItemsToBudget(
        "tools",
        candidates
      );
      const previewTruncated = toolData.previewTruncated.slice(index, index + pageItems.length)
        .filter(Boolean).length;
      return {
        fingerprint,
        page: {
          section: "tools",
          tools: pageItems,
          nextCursor: makeCursor(request, cacheKey, index + pageItems.length, tools.length),
          coverage: withCoverageLimits(
            baseCoverage(pageItems.length),
            previewTruncated,
            pageItems.length < candidates.length
          ),
        },
      };
    }

    if (request.section === "messages") {
      const messageData = messageItems(records);
      const messages = messageData.items;
      const candidates = messages.slice(index, index + INSPECTOR_MESSAGE_PAGE_SIZE);
      const pageItems = fitItemsToBudget(
        "messages",
        candidates
      );
      const previewTruncated = messageData.previewTruncated.slice(index, index + pageItems.length)
        .filter(Boolean).length;
      return {
        fingerprint,
        page: {
          section: "messages",
          messages: pageItems,
          nextCursor: makeCursor(request, cacheKey, index + pageItems.length, messages.length),
          coverage: withCoverageLimits(
            baseCoverage(pageItems.length),
            previewTruncated,
            pageItems.length < candidates.length
          ),
        },
      };
    }

    const report = finalReport(records);
    const chunk = sliceUtf8(report, index, INSPECTOR_CHUNK_BYTES);
    return {
      fingerprint,
      page: {
        section: "report",
        text: chunk.text,
        nextCursor: makeCursor(request, cacheKey, chunk.nextIndex, report.length),
        coverage: baseCoverage(chunk.text.length > 0 ? 1 : 0),
      },
    };
  } catch (error) {
    if (cursorToken !== undefined && cursorState !== undefined) {
      cursors.set(cursorToken, cursorState);
    }
    throw error;
  }
}

async function locateAgent(
  realSubagentDir: string,
  toolUseId: string,
  agentTranscriptId?: string
): Promise<LocatedAgent> {
  const directName = agentTranscriptId && /^[A-Za-z0-9_-]+$/.test(agentTranscriptId)
    ? `agent-${agentTranscriptId}.meta.json`
    : undefined;
  const allNames = directName
    ? [directName]
    : (await readdir(realSubagentDir)).filter((name) => name.endsWith(".meta.json")).sort();
  const names = allNames;
  const limited = names.slice(0, META_COUNT_MAX);
  let bytesRead = 0;
  let byteLimitReached = false;
  for (const name of limited) {
    const metaPath = await realpath(join(realSubagentDir, name)).catch(() => null);
    if (!metaPath) continue;
    assertInside(realSubagentDir, metaPath, "agent-unavailable");
    const metaStat = await stat(metaPath).catch(() => null);
    if (!metaStat?.isFile() || metaStat.size > META_FILE_MAX) continue;
    if (bytesRead + metaStat.size > META_TOTAL_MAX) {
      byteLimitReached = true;
      break;
    }
    bytesRead += metaStat.size;
    let meta: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(metaPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {}
    if (meta?.toolUseId !== toolUseId) continue;
    const match = /^agent-(.+)\.meta\.json$/.exec(name);
    if (!match || match[1].includes("/") || match[1].includes("\\")) break;
    return {
      transcriptPath: join(realSubagentDir, `agent-${match[1]}.jsonl`),
      meta,
      metaLimitReached: names.length > META_COUNT_MAX,
      bytesRead,
    };
  }
  if (byteLimitReached) {
    throw new AgentInspectorReadError("meta-limit");
  }
  throw new AgentInspectorReadError("agent-unavailable");
}

async function readTranscriptSample(
  realPath: string,
  expected: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number },
  key: string,
  readBudget: number
): Promise<CachedTranscript> {
  const handle = await open(realPath, "r").catch(() => {
    throw new AgentInspectorReadError("read-failed");
  });
  let lines: string[] = [];
  let bytesRead = 0;
  let skippedRecordCount = 0;
  const truncatedReasons: AgentInspectorTruncatedReason[] = [];
  try {
    const opened = await handle.stat();
    if (!sameFileFingerprint(opened, expected)) throw new AgentInspectorReadError("read-failed");
    if (expected.size <= readBudget) {
      const buffer = Buffer.alloc(expected.size);
      const read = expected.size > 0 ? await handle.read(buffer, 0, expected.size, 0) : { bytesRead: 0 };
      bytesRead = read.bytesRead;
      lines = buffer.toString("utf8", 0, read.bytesRead).split("\n");
    } else {
      const half = Math.floor(readBudget / 2);
      const head = Buffer.alloc(half);
      const tail = Buffer.alloc(readBudget - half);
      const headRead = await handle.read(head, 0, head.length, 0);
      const tailRead = await handle.read(tail, 0, tail.length, expected.size - tail.length);
      bytesRead = headRead.bytesRead + tailRead.bytesRead;
      const headText = head.toString("utf8", 0, headRead.bytesRead);
      const tailText = tail.toString("utf8", 0, tailRead.bytesRead);
      const headLines = headText.split("\n");
      const tailLines = tailText.split("\n");
      if (!headText.endsWith("\n")) {
        headLines.pop();
        skippedRecordCount++;
      }
      if (tailLines.length > 0) {
        tailLines.shift();
        skippedRecordCount++;
      }
      lines = [...headLines, ...tailLines];
      truncatedReasons.push("read-limit");
    }
    const finished = await handle.stat();
    if (!sameFileFingerprint(finished, expected)) throw new AgentInspectorReadError("read-failed");
  } catch {
    throw new AgentInspectorReadError("read-failed");
  } finally {
    await handle.close();
  }
  return {
    key,
    realPath,
    size: expected.size,
    mtimeMs: expected.mtimeMs,
    lines,
    bytesRead,
    malformedRecordCount: 0,
    skippedRecordCount,
    truncatedReasons,
    cacheBytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0),
  };
}

function rememberTranscript(entry: CachedTranscript): void {
  transcriptCache.set(entry.key, entry);
  transcriptCacheBytes += entry.cacheBytes;
  while (transcriptCacheBytes > INSPECTOR_CACHE_BYTES && transcriptCache.size > 0) {
    const oldestKey = transcriptCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = transcriptCache.get(oldestKey);
    transcriptCache.delete(oldestKey);
    transcriptCacheBytes -= oldest?.cacheBytes ?? 0;
    for (const [token, cursor] of cursors) {
      if (cursor.cacheKey === oldestKey) cursors.delete(token);
    }
  }
}

function makeCursor(
  request: AgentInspectorReadRequest,
  cacheKey: string,
  nextIndex: number,
  total: number
): string | undefined {
  if (nextIndex >= total) return undefined;
  const token = randomUUID();
  cursors.set(token, {
    scopeKey: request.scopeKey,
    cacheKey,
    toolUseId: request.toolUseId,
    section: request.section,
    index: nextIndex,
  });
  while (cursors.size > 1024) {
    const oldest = cursors.keys().next().value as string | undefined;
    if (!oldest) break;
    cursors.delete(oldest);
  }
  return token;
}

function toolItems(records: readonly Record<string, unknown>[]): {
  items: AgentInspectorToolItem[];
  previewTruncated: boolean[];
} {
  const results = new Map<string, { isError: boolean; preview: string; truncated: boolean }>();
  for (const record of records) {
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const value = asRecord(block);
      if (value?.type !== "tool_result" || typeof value.tool_use_id !== "string") continue;
      const raw = typeof value.content === "string" ? value.content : JSON.stringify(value.content) ?? "";
      const preview = clipUtf8(raw, 4096);
      results.set(value.tool_use_id, { isError: value.is_error === true, preview, truncated: preview.length !== raw.length });
    }
  }
  const items: AgentInspectorToolItem[] = [];
  const previewTruncated: boolean[] = [];
  for (const record of records) {
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const value = asRecord(block);
      if (value?.type !== "tool_use" || typeof value.name !== "string") continue;
      const toolUseId = stringValue(value.id) ?? "";
      const result = results.get(toolUseId);
      const inputRaw = JSON.stringify(value.input) ?? "";
      const inputPreview = clipUtf8(inputRaw, 4096);
      const resultPreview = result?.preview;
      const summary = summarizeToolInput(value.name, value.input);
      const inputSummary = summary ? clipUtf8(summary, 1024) : undefined;
      items.push({
        toolUseId,
        toolName: value.name,
        timestamp: timestampValue(record.timestamp),
        inputSummary,
        inputPreview,
        isError: result?.isError,
        resultPreview,
      });
      previewTruncated.push(
        inputPreview.length !== inputRaw.length ||
        (summary !== null && inputSummary?.length !== summary.length) ||
        (result !== undefined && result.truncated)
      );
    }
  }
  return { items, previewTruncated };
}

function messageItems(records: readonly Record<string, unknown>[]): {
  items: AgentInspectorMessageItem[];
  previewTruncated: boolean[];
} {
  const items: AgentInspectorMessageItem[] = [];
  const previewTruncated: boolean[] = [];
  for (const record of records) {
    if (record.type !== "user" && record.type !== "assistant") continue;
    const text = extractText(asRecord(record.message)?.content);
    if (!text) continue;
    const clipped = clipUtf8(text, INSPECTOR_PREVIEW_BYTES);
    items.push({ role: record.type, timestamp: timestampValue(record.timestamp), text: clipped });
    previewTruncated.push(clipped.length !== text.length);
  }
  return { items, previewTruncated };
}

function firstInstruction(records: readonly Record<string, unknown>[]): string {
  for (const record of records) {
    if (record.type !== "user") continue;
    const text = extractText(asRecord(record.message)?.content);
    if (text) return text;
  }
  return "";
}

function finalReport(records: readonly Record<string, unknown>[]): string {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type !== "assistant") continue;
    const text = extractText(asRecord(record.message)?.content);
    if (text) return text;
  }
  return "";
}

function firstTimestamp(records: readonly Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    const timestamp = timestampValue(record.timestamp);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function lastTimestamp(records: readonly Record<string, unknown>[]): number | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const timestamp = timestampValue(records[i].timestamp);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function firstString(
  records: readonly Record<string, unknown>[],
  get: (record: Record<string, unknown>) => unknown
): string | undefined {
  for (const record of records) {
    const value = get(record);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const value = asRecord(block);
    return value?.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n").trim();
}

function sliceUtf8(value: string, start: number, maxBytes: number): { text: string; nextIndex: number } {
  let end = Math.min(value.length, start + maxBytes);
  while (end > start && Buffer.byteLength(value.slice(start, end), "utf8") > maxBytes) end--;
  if (end > start && end < value.length && isHighSurrogate(value.charCodeAt(end - 1)) &&
      isLowSurrogate(value.charCodeAt(end))) end--;
  return { text: value.slice(start, end), nextIndex: end };
}

function fitItemsToBudget<T>(section: "tools" | "messages", candidates: readonly T[]): T[] {
  const items = [...candidates];
  const key = section === "tools" ? "tools" : "messages";
  while (items.length > 1 && Buffer.byteLength(JSON.stringify({ section, [key]: items }), "utf8") > PAGE_PAYLOAD_BUDGET) {
    items.pop();
  }
  return items;
}

function withCoverageLimits(
  coverage: AgentInspectorCoverage,
  previewTruncatedCount: number,
  responseLimited: boolean
): AgentInspectorCoverage {
  const truncatedReasons = [...coverage.truncatedReasons];
  if (previewTruncatedCount > 0 && !truncatedReasons.includes("preview-limit")) {
    truncatedReasons.push("preview-limit");
  }
  if (responseLimited && !truncatedReasons.includes("response-limit")) {
    truncatedReasons.push("response-limit");
  }
  return {
    ...coverage,
    state: truncatedReasons.length === 0 ? "complete" : "partial",
    previewTruncatedCount: previewTruncatedCount > 0 ? previewTruncatedCount : undefined,
    truncatedReasons,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function sameFileFingerprint(
  actual: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number },
  expected: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }
): boolean {
  return actual.size === expected.size && actual.mtimeMs === expected.mtimeMs &&
    actual.ctimeMs === expected.ctimeMs && actual.dev === expected.dev && actual.ino === expected.ino;
}

function clipUtf8(value: string, maxBytes: number): string {
  return sliceUtf8(value, 0, maxBytes).text;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

async function assertRegularFileInside(
  root: string,
  target: string,
  reason: AgentInspectorErrorReason
): Promise<void> {
  assertInside(root, target, reason);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new AgentInspectorReadError(reason);
}

function assertInside(root: string, target: string, reason: AgentInspectorErrorReason): void {
  if (!pathIsInside(root, target)) throw new AgentInspectorReadError(reason);
}

// 保存先配下かの判定はこの 2 本だけ。extension.ts の isInSessionStore も同じ 2 本を通す
// （resolve だけの前方一致を別に持つと、ジャンクション経由の脱出が片方だけ通る）。
// 最終許可判定では両辺を realPathOrNearestSync に通すこと。candidate I/O 前の棄却に限り
// lexical path へ使えるが、true を許可根拠にしてはならない。resolve は `..` しか畳まず、
// リンクの実体も Windows の大小差も残る
export function pathIsInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep);
}

// realpath は存在しないパスで ENOENT を投げる。書く前の検査・同期途中の欠落でも判定を続けられる
// よう、実在する最も近い祖先まで遡って実体を採り、残りを継ぎ足す（残りは実在しないので
// リンクではありえず、継ぎ足しても脱出経路にならない）。ENOENT / ENOTDIR 以外は
// 「確かめられなかった」なので null を返して呼び手に閉じさせる。
// Google Drive 同期下では実体が入れ替わりうるので結果をキャッシュしない
export function realPathOrNearestSync(target: string): string | null {
  let current = resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}
