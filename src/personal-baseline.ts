import { createHash } from "node:crypto";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { analyzeSessionFileAsync, baselineSessionMetrics, calculatePersonalBaselineFromSessions, BaselineScanDegradation, BaselineSessionMetrics, PersonalBaseline } from "./analysis";
import { claudeProjectsDir } from "./claude-env";
import { extensionContext, output } from "./host-context";

interface BaselineCache {
  version: 1;
  // Short hash -> packed scalar metrics. No paths and no full reports are persisted.
  entries: Record<string, string>;
  // 先頭レコードのtimestamp。JSONLは追記専用なのでこれはファイル不変値であり、90日判定の
  // ためだけに毎回全ファイルを開き直す必要がない（実測: 1697件の open+read+close で852ms、
  // キャッシュ後は statSync のみの十数ms）。
  firstTimestamps: Record<string, number>;
}

function sessionCacheKey(path: string): string { return createHash("sha256").update(path).digest("hex").slice(0, 12); }
function packMetrics(mtime: number, size: number, data: BaselineSessionMetrics): string {
  const pack = (value: number | null, scale = 1) => value === null ? "" : Math.round(value * scale).toString(36);
  return [Math.round(mtime).toString(36), size.toString(36), pack(data.turns), pack(data.metrics.toolFailureRate, 1_000_000), pack(data.metrics.turnDurationMs, 1_000), pack(data.metrics.outputTokens), pack(data.metrics.agentTokenRatio, 1_000_000), pack(data.metrics.failureLoopFrequency, 1_000_000)].join(".");
}
function unpackMetrics(packed: string): { mtime: number; size: number; metrics: BaselineSessionMetrics } | null {
  const fields = packed.split("."); if (fields.length !== 8) return null;
  const read = (index: number, scale = 1): number | null => fields[index] === "" ? null : Number.parseInt(fields[index], 36) / scale;
  const mtime = read(0); const size = read(1); const turns = read(2); if (mtime === null || size === null || turns === null) return null;
  return { mtime, size, metrics: { turns, metrics: { toolFailureRate: read(3, 1_000_000), turnDurationMs: read(4, 1_000), outputTokens: read(5), agentTokenRatio: read(6, 1_000_000), failureLoopFrequency: read(7, 1_000_000) } } };
}

interface BaselineSourceFiles {
  files: Array<{ path: string; mtime: number; size: number }>;
  // First-record timestamps are immutable for append-only JSONL files, so retain them to avoid reopening every file.
  firstTimestamps: Record<string, number>;
  // 解析例外は列挙より後（personalBaselineSerialized）で起きるので、ここでは数えられない
  scan: Omit<BaselineScanDegradation, "unparsedSessions">;
}

// 実測1696件で同時64が最速、128は悪化
const BASELINE_SCAN_CONCURRENCY = 64;
const FIRST_RECORD_SCAN_LIMIT = 1024 * 1024;

// 列挙の await で再入しうる。直列化しないと globalState の read-modify-write が後勝ちで消える
let personalBaselineTail: Promise<void> = Promise.resolve();
// SessionFacts の baseline 比は同期導出なので、直近に解決した値だけを使う（未解決なら null）
export let cachedPersonalBaseline: PersonalBaseline | null = null;

async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
  return results;
}

// The 90-day window is based on the JSONL's first-record timestamp, not its mtime.
// readFailed は timestamp===null の 3 通り（読取失敗・走査上限・時刻が無い）を分けるためにある。
// 全部を「読めなかった」に数えると、読めているのに欠落件数が水増しされる（R-34）
async function firstSessionTimestamp(path: string): Promise<{ timestamp: number | null; readFailed: boolean }> {
  let file: FileHandle | undefined;
  let readFailed = false;
  try {
    file = await open(path, "r");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(8192);
    let position = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(Buffer.from(buffer.subarray(0, newline === -1 ? bytesRead : newline)));
      if (newline !== -1) break;
      position += bytesRead;
      // 改行が来ないファイルを最後まで読むと、64並列ぶんが常駐して拡張ホストが落ちる
      if (position >= FIRST_RECORD_SCAN_LIMIT) return { timestamp: null, readFailed };
    }
    const firstLine = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    const timestampText = (() => {
      try { return (JSON.parse(firstLine) as { timestamp?: string }).timestamp ?? ""; }
      catch { return /"timestamp"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(firstLine)?.[1] ?? ""; }
    })();
    const timestamp = Date.parse(timestampText);
    return { timestamp: Number.isFinite(timestamp) ? timestamp : null, readFailed };
  } catch {
    readFailed = true;
    return { timestamp: null, readFailed };
  }
  finally { if (file !== undefined) { try { await file.close(); } catch {} } }
}

async function baselineSourceFiles(previousFirstTimestamps: Record<string, number>): Promise<BaselineSourceFiles> {
  const root = claudeProjectsDir();
  const firstTimestamps = { ...previousFirstTimestamps };
  const cutoff = Date.now() - 90 * 24 * 60 * 60_000;
  let unreadableProjects = 0;
  let unreadableSessions = 0;
  let rootFailed = false;
  try {
    const dirs = await readdir(root);
    const namesByProject = await mapWithConcurrency(dirs, BASELINE_SCAN_CONCURRENCY, async (dir) => {
      try { return await readdir(join(root, dir)); } catch { unreadableProjects++; return [] as string[]; }
    });
    const candidates = namesByProject.flatMap((names, index) => {
      const project = join(root, dirs[index]);
      return names.filter((name) => name.endsWith(".jsonl")).map((name) => {
        const path = join(project, name);
        return { path, key: sessionCacheKey(path) };
      });
    });
    const seen = new Set(candidates.map((candidate) => candidate.key));
    const scans = await mapWithConcurrency(candidates, BASELINE_SCAN_CONCURRENCY, async (candidate) => {
      try {
        const info = await stat(candidate.path);
        // ディレクトリ等は正常な読み飛ばし。読めなかった件数へ混ぜない
        if (!info.isFile()) return { kind: "skip" as const };
        const cached = firstTimestamps[candidate.key];
        const first = Number.isFinite(cached)
          ? { timestamp: cached, readFailed: false }
          : await firstSessionTimestamp(candidate.path);
        if (first.readFailed) unreadableSessions++;
        return { kind: "file" as const, key: candidate.key, path: candidate.path, mtime: Math.round(info.mtimeMs), size: info.size, timestamp: first.timestamp };
      } catch {
        unreadableSessions++;
        return { kind: "skip" as const };
      }
    });
    const files: BaselineSourceFiles["files"] = [];
    for (const scan of scans) {
      if (scan.kind !== "file") continue;
      // null をキャッシュすると、後で中身が入っても永久に90日フィルタから漏れる
      if (scan.timestamp === null) { delete firstTimestamps[scan.key]; continue; }
      firstTimestamps[scan.key] = scan.timestamp;
      if (scan.timestamp >= cutoff) files.push({ path: scan.path, mtime: scan.mtime, size: scan.size });
    }
    for (const key of Object.keys(firstTimestamps)) if (!seen.has(key)) delete firstTimestamps[key];
    return { files, firstTimestamps, scan: { rootFailed, unreadableProjects, unreadableSessions, readSessions: files.length } };
  } catch {
    // 保存先を読めなかったことを 0 件へ畳まない。畳むと「比較できるベースラインがない」と
    // 断言することになる（R-34）
    rootFailed = true;
    return { files: [], firstTimestamps, scan: { rootFailed, unreadableProjects, unreadableSessions, readSessions: 0 } };
  }
}

export const PERSONAL_BASELINE_CACHE_KEY = "laisora.analysis.personalBaseline.v1";

async function writePersonalBaselineCache(cache: BaselineCache): Promise<void> {
  const ctx = extensionContext;
  if (!ctx) return;
  const update = async (key: string, value: unknown): Promise<void> => {
    try { await ctx.globalState.update(key, value); }
    catch (error) { output.appendLine(`[baseline] cache update failed (${key}): ${String(error)}`); }
  };
  await update(PERSONAL_BASELINE_CACHE_KEY, cache);
}

const NO_BASELINE_SCAN: BaselineScanDegradation = {
  rootFailed: false,
  unreadableProjects: 0,
  unreadableSessions: 0,
  unparsedSessions: 0,
  readSessions: 0,
};

// baseline===null は「比較できるものが無い」ではなく「揃わなかった」。理由の内訳を
// scan で一緒に返し、断言の前に注記へ写せるようにする（R-34）
let onPersonalBaselineChanged: (() => void) | undefined;
// 走査は activate 後も続くので、完了時に開いている画面へ描き直しを依頼する口
export function setPersonalBaselineListener(listener: () => void): void {
  onPersonalBaselineChanged = listener;
}

export function personalBaseline(excludePath?: string): Promise<{ baseline: PersonalBaseline | null; scan: BaselineScanDegradation }> {
  const result = personalBaselineTail.then(() => personalBaselineSerialized(excludePath));
  personalBaselineTail = result.then(
    (outcome) => {
      // 除外付きの走査は分析対象セッションの報告用。共有の cachedPersonalBaseline へ入れると、開いている全タブの比較対象から
      // そのセッションが抜け、全タブの base が失効する
      if (excludePath !== undefined || outcome.baseline === null) return;
      // 同じ内容で参照だけ替えると semantic memo が失効し、描き直しが無駄に走る。calculatedAt は毎回変わるので比較から外す
      if (cachedPersonalBaseline !== null && JSON.stringify({ ...cachedPersonalBaseline, calculatedAt: 0 }) === JSON.stringify({ ...outcome.baseline, calculatedAt: 0 })) return;
      cachedPersonalBaseline = outcome.baseline;
      try {
        onPersonalBaselineChanged?.();
      } catch (error) {
        output.appendLine(`[analysis] baseline change notification failed: ${String(error)}`);
      }
    },
    () => undefined
  );
  return result;
}

async function personalBaselineSerialized(excludePath?: string): Promise<{ baseline: PersonalBaseline | null; scan: BaselineScanDegradation }> {
  const ctx = extensionContext;
  if (!ctx) return { baseline: null, scan: NO_BASELINE_SCAN };
  const previous = ctx.globalState.get<BaselineCache>(PERSONAL_BASELINE_CACHE_KEY);
  const { files, firstTimestamps, scan } = await baselineSourceFiles(previous?.version === 1 ? previous.firstTimestamps : {});
  let unparsedSessions = 0;
  const entries: BaselineCache["entries"] = { ...(previous?.version === 1 ? previous.entries : {}) };
  if (files.length === 0) {
    await writePersonalBaselineCache({ version: 1, entries, firstTimestamps });
    return { baseline: null, scan: { ...scan, unparsedSessions } };
  }
  // 列挙側キーは join() 済み。excludePath は webview 由来なので揃えないと除外が外れる
  const excluded = excludePath ? sessionCacheKey(resolve(excludePath)) : "";
  // 呼び出し元が同じファイルを解析するので、ここで解析すると13MB級を2回読む。metrics は
  // 古いまま残るが、他セッションの分析時に mtime/size 差分で更新される
  for (const file of files) {
    const key = sessionCacheKey(file.path);
    if (key === excluded) continue;
    const cached = entries[key] ? unpackMetrics(entries[key]) : null;
    if (cached && cached.mtime === file.mtime && cached.size === file.size) continue;
    try { entries[key] = packMetrics(file.mtime, file.size, baselineSessionMetrics(await analyzeSessionFileAsync(file.path))); }
    // 母集団から黙って外さない。外した件数を数えないと「20 件未満」「比較できるものが無い」の
    // 断言が、実際は読めなかっただけの状態を覆い隠す（R-34 E-04）
    catch { unparsedSessions++; delete entries[key]; }
    // 1 記録ごとにイベントループへ戻す。activate から撃たれるので、続けて回すと拡張ホストが止まる
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const active = new Set(files.map((file) => sessionCacheKey(file.path)));
  for (const key of Object.keys(entries)) if (!active.has(key)) delete entries[key];
  await writePersonalBaselineCache({ version: 1, entries, firstTimestamps });
  const baseline = calculatePersonalBaselineFromSessions(Object.entries(entries).filter(([key]) => key !== excluded).map(([, packed]) => unpackMetrics(packed)?.metrics).filter((metrics): metrics is BaselineSessionMetrics => !!metrics));
  return { baseline, scan: { ...scan, unparsedSessions } };
}
