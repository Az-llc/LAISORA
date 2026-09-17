import { appendFile, open, readFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { pathIsInside, realPathOrNearestSync } from "./agent-inspector";
import { claudeGlobalConfigFile, claudeProjectsDir } from "./claude-env";
import type { Session } from "./extension";
import { output } from "./host-context";
import { SESSION_ID_RE, type ImageAttachment, type SessionImageRef } from "./protocol";

// webview・ResumeReadSet から渡されたパスがセッションストア配下か。
// 判定は agent-inspector.ts の 2 本だけを使う。ここに resolve だけの前方一致を書き戻すと、
// ストア内に張ったジャンクション経由の脱出が Inspector 側では弾かれてここだけ通り、
// 逆に Windows の大小差だけが違う正当なパスがここだけ拒まれる（正当なセッションが復元不能になる）
export function isInSessionStore(filePath: string): boolean {
  const root = realPathOrNearestSync(claudeProjectsDir());
  const target = realPathOrNearestSync(filePath);
  if (root === null || target === null) {
    output.appendLine(`[session] 保存先配下かを確かめられません: ${filePath}`);
    return false;
  }
  return pathIsInside(root, target);
}

// 理由で分岐する側（Inspector の入口）はこちらを使う。理由を捨てて null にすると、走査に
// 失敗しただけの状態が「セッションログがまだ利用できません」（待てば直る）として届く（E-09）
export function inspectorSessionFileLookup(session: Session): SessionFileLookup {
  // resume IDとpathは対でのみ使う。/clear後に片方だけ残った旧値を新会話へ混ぜない。
  if (session.resumeSessionId && session.resumeFilePath) {
    return basename(session.resumeFilePath).toLowerCase() === `${session.resumeSessionId}.jsonl`.toLowerCase()
      ? { path: session.resumeFilePath, reason: null }
      : { path: null, reason: "not_found" };
  }
  // resume していないタブは SDK が system/init で報告した session_id（auth.sessionId）だけで探す。
  // expectedConversationId は claudeHost の randomUUID で SDK へ渡らず、その名の JSONL は
  // 存在しない（refreshTabTitle と同じ理由。R-TAB-04）
  const sessionId = session.auth?.sessionId;
  return sessionId ? lookupSessionFile(sessionId) : { path: null, reason: "not_found" };
}

export function inspectorSessionFile(session: Session): string | null {
  return inspectorSessionFileLookup(session).path;
}

export function sessionIdForOutput(session: Session): string {
  return session.resumeSessionId ?? session.auth?.sessionId ?? "(未取得)";
}

// /rename の書き先。ファイルと sessionId は同じ出所から対で取る（inspectorSessionFile と同じ規則。
// 片方だけ別の出所から取ると、レコードの sessionId がファイルと食い違い parseTitleRecord に落とされる）
export function sessionTranscriptRef(session: Session): { sessionId: string; file: string } | null {
  const file = inspectorSessionFile(session);
  if (file === null) return null;
  const sessionId =
    session.resumeSessionId && session.resumeFilePath ? session.resumeSessionId : session.auth?.sessionId;
  return sessionId ? { sessionId, file } : null;
}

// CLI が書き続けている JSONL の末尾へ 1 レコード足す。末尾が改行で終わっていなければ改行を先に置く
// （行の途中へ継ぎ足すと前のレコードごと壊れる）
export async function appendSessionRecord(file: string, line: string): Promise<void> {
  if (!isInSessionStore(file)) throw new Error("outside-session-store");
  let endsWithNewline = true;
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size > 0) {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      endsWithNewline = buf[0] === 0x0a;
    }
  } finally {
    await fh.close();
  }
  await appendFile(file, endsWithNewline ? line : `\n${line}`, "utf8");
}

export async function resolveSessionImage(
  session: Session,
  ref: SessionImageRef
): Promise<
  | { mediaType: ImageAttachment["mediaType"]; data: string }
  | { error: "not-found" | "read-failed" | "invalid-request" }
> {
  if (ref.kind === "event") {
    const ev = session.events.find(
      (e) => e.generation === ref.generation && e.seq === ref.seq && e.kind === "user_message"
    );
    const img = ev && ev.kind === "user_message" && ev.images ? ev.images[ref.index] : undefined;
    if (img && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(img.mediaType)) {
      return { mediaType: img.mediaType, data: img.data };
    }
    return { error: "not-found" };
  }
  if (ref.kind === "record") {
    const transcriptRef = sessionTranscriptRef(session);
    if (transcriptRef === null) {
      return { error: "invalid-request" };
    }
    try {
      const text = await readFile(transcriptRef.file, "utf8");
      const lines = text.split("\n");
      let foundImage: { mediaType: ImageAttachment["mediaType"]; data: string } | undefined;
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
          obj = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.type === "user" && obj.uuid === ref.uuid) {
          const message = typeof obj.message === "object" && obj.message !== null ? (obj.message as Record<string, unknown>) : undefined;
          const content = message?.content;
          if (Array.isArray(content)) {
            let imageIndex = 0;
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const blockObj = block as Record<string, unknown>;
              if (blockObj.type !== "image") continue;
              if (imageIndex === ref.index) {
                const source = typeof blockObj.source === "object" && blockObj.source !== null ? (blockObj.source as Record<string, unknown>) : undefined;
                if (
                  source?.type === "base64" &&
                  typeof source.media_type === "string" &&
                  ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type) &&
                  typeof source.data === "string"
                ) {
                  foundImage = {
                    mediaType: source.media_type as ImageAttachment["mediaType"],
                    data: source.data,
                  };
                }
                break;
              }
              imageIndex++;
            }
          }
          break;
        }
      }
      if (foundImage) {
        return foundImage;
      }
      return { error: "not-found" };
    } catch {
      return { error: "read-failed" };
    }
  }
  return { error: "invalid-request" };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readCachedUsage(): {
  fetchedAtMs: number;
  limits: Array<{ type: string; utilization: number; resetsAt: number | null }>;
} | null {
  try {
    const raw = JSON.parse(readFileSync(claudeGlobalConfigFile(), "utf8")) as Record<string, any>;
    const c = raw.cachedUsageUtilization;
    if (!c || typeof c !== "object" || typeof c.utilization !== "object") return null;
    // キャッシュには内部用の枠（nimbus_quill 等）も混ざる。意味の分かるものだけ出す
    const SHOW = new Set(["five_hour", "seven_day", "weekly", "seven_day_opus", "seven_day_sonnet"]);
    const limits: Array<{ type: string; utilization: number; resetsAt: number | null }> = [];
    for (const [type, v] of Object.entries(c.utilization as Record<string, any>)) {
      if (!SHOW.has(type)) continue;
      if (!v || typeof v.utilization !== "number") continue;
      const at = typeof v.resets_at === "string" ? Date.parse(v.resets_at) : NaN;
      limits.push({ type, utilization: v.utilization, resetsAt: Number.isNaN(at) ? null : at });
    }
    if (limits.length === 0) return null;
    return { fetchedAtMs: typeof c.fetchedAtMs === "number" ? c.fetchedAtMs : 0, limits };
  } catch {
    return null;
  }
}

// sessionId から ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl を探す。
// cwd のエンコード規則を推測せず、プロジェクトディレクトリを走査して実在するものを返す。
// 「そのセッションが無い」と「有無を確かめられなかった」を区別する。同じ null に畳むと、同期ロック・権限・競合で
// 走査に失敗しただけの状態が、分析では「まだ書き出されていません」（待っても直らない）、会話の遡りでは
// 「読み終わった」（進行表示が黙って消える）として利用者に届き、Output にも出ない（R-17 / R-33）
export type SessionFileLookup =
  | { path: string; reason: null }
  | { path: null; reason: "not_found" }
  | { path: null; reason: "scan_failed"; detail: string };

// sessionId から JSONL の実体位置を解決する（cwd エンコード規則を推測せず全 project を走査）。
// 探索はこの 1 本だけ。別実装を足すと、そちらだけ走査の失敗を「無い」へ潰す形へ戻る（E-18 / R-37）
export function lookupSessionFile(sessionId: string): SessionFileLookup {
  // join へ渡す前に絞る。`../..` を含む id は保存先の外を指すファイル名になる
  if (!SESSION_ID_RE.test(sessionId)) return { path: null, reason: "not_found" };
  const root = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    return { path: null, reason: "scan_failed", detail: errText(err) };
  }
  let scanFailure: string | undefined;
  for (const dir of dirs) {
    const p = join(root, dir, `${sessionId}.jsonl`);
    try {
      if (statSync(p).isFile()) return { path: p, reason: null };
    } catch (err) {
      // ENOENT は「このディレクトリには無い」で正常。それ以外は確かめられなかったということ
      if ((err as { code?: unknown }).code !== "ENOENT" && scanFailure === undefined) {
        scanFailure = `${dir}: ${errText(err)}`;
      }
    }
  }
  if (scanFailure !== undefined) return { path: null, reason: "scan_failed", detail: scanFailure };
  return { path: null, reason: "not_found" };
}

// 理由を必要としない呼び出し用。理由で分岐する側は lookupSessionFile を直接使う
export function findSessionFile(sessionId: string): string | null {
  return lookupSessionFile(sessionId).path;
}
