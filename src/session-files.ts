import { open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { constants, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { pathIsInside, realPathOrNearestSync } from "./agent-inspector";
import { claudeProjectsDir } from "./claude-env";
import type { Session } from "./extension";
import { output } from "./host-context";
import { SESSION_ID_RE, type ImageAttachment, type SessionImageRef } from "./protocol";
import { extractHumanUserPrompt } from "./session-transcript";

export function isInSessionStore(filePath: string): boolean {
  const root = realPathOrNearestSync(claudeProjectsDir());
  const target = realPathOrNearestSync(filePath);
  if (root === null || target === null) {
    output.appendLine(`[session] 保存先配下かを確かめられません: ${filePath}`);
    return false;
  }
  return pathIsInside(root, target);
}

export function inspectorSessionFileLookup(session: Session): SessionFileLookup {
  if (session.resumeSessionId && session.resumeFilePath) {
    return basename(session.resumeFilePath).toLowerCase() === `${session.resumeSessionId}.jsonl`.toLowerCase()
      ? { path: session.resumeFilePath, reason: null }
      : { path: null, reason: "not_found" };
  }
  const sessionId = session.auth?.sessionId;
  return sessionId ? lookupSessionFile(sessionId) : { path: null, reason: "not_found" };
}

export function inspectorSessionFile(session: Session): string | null {
  return inspectorSessionFileLookup(session).path;
}

export function sessionIdForOutput(session: Session): string {
  return session.resumeSessionId ?? session.auth?.sessionId ?? "(未取得)";
}

export function sessionTranscriptRef(session: Session): { sessionId: string; file: string } | null {
  const file = inspectorSessionFile(session);
  if (file === null) return null;
  const sessionId =
    session.resumeSessionId && session.resumeFilePath ? session.resumeSessionId : session.auth?.sessionId;
  return sessionId ? { sessionId, file } : null;
}

function assertSessionRecordOf(realFile: string, sessionId: string): void {
  if (basename(realFile).toLowerCase() !== `${sessionId}.jsonl`.toLowerCase()) throw new Error("not-session-record");
  if (!isInSessionStore(realFile)) throw new Error("outside-session-store");
}

export interface SessionRecordIo {
  realpath: (file: string) => Promise<string>;
  open: (file: string, flags: number) => Promise<Pick<FileHandle, "stat" | "read" | "write" | "close">>;
}

const fsSessionRecordIo: SessionRecordIo = { realpath: (file) => realpath(file), open: (file, flags) => open(file, flags) };

export async function appendSessionRecordOnFreshLine(
  file: string,
  sessionId: string,
  line: string,
  io: SessionRecordIo = fsSessionRecordIo
): Promise<void> {
  const realFile = await io.realpath(file);
  assertSessionRecordOf(realFile, sessionId);
  const fh = await io.open(realFile, constants.O_RDWR | constants.O_APPEND);
  try {
    if ((await io.realpath(realFile)) !== realFile) throw new Error("not-session-record");
    let endsWithNewline = true;
    const { size } = await fh.stat();
    if (size > 0) {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      endsWithNewline = buf[0] === 0x0a;
    }
    const data = Buffer.from(endsWithNewline ? line : `\n${line}`, "utf8");
    for (let offset = 0; offset < data.length; ) {
      const { bytesWritten } = await fh.write(data, offset, data.length - offset, null);
      if (!(bytesWritten > 0)) throw new Error("session-record-short-write");
      offset += bytesWritten;
    }
  } finally {
    await fh.close();
  }
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
        if (obj.uuid === ref.uuid) {
          const content = extractHumanUserPrompt(obj)?.content;
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

export type SessionFileLookup =
  | { path: string; reason: null }
  | { path: null; reason: "not_found" }
  | { path: null; reason: "scan_failed"; detail: string };

export function lookupSessionFile(sessionId: string): SessionFileLookup {
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
      if ((err as { code?: unknown }).code !== "ENOENT" && scanFailure === undefined) {
        scanFailure = `${dir}: ${errText(err)}`;
      }
    }
  }
  if (scanFailure !== undefined) return { path: null, reason: "scan_failed", detail: scanFailure };
  return { path: null, reason: "not_found" };
}

export function findSessionFile(sessionId: string): string | null {
  return lookupSessionFile(sessionId).path;
}
