import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { artifactIdOf, canonicalizeArtifactPath } from "./artifact-access";
import { basenameOf } from "./path-redaction";
import { isFileWritingTool } from "./file-writing-tools";
import { isShellTool } from "./shell-tools";
import type { FileEdit } from "./protocol";

export const EDIT_SUMMARY_SETTING = "editSummary.enabled";


interface PatchHunk {
  oldStart: number;
  oldLines: number;
  lines: string[];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function patchHunks(value: unknown): PatchHunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks: PatchHunk[] = [];
  for (const raw of value) {
    const hunk = asObject(raw);
    if (!hunk || !Number.isSafeInteger(hunk.oldStart) || !Number.isSafeInteger(hunk.oldLines)) return undefined;
    if (!Array.isArray(hunk.lines) || !hunk.lines.every((line) => typeof line === "string")) return undefined;
    hunks.push({ oldStart: hunk.oldStart as number, oldLines: hunk.oldLines as number, lines: hunk.lines as string[] });
  }
  return hunks;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function isWriteResult(result: Record<string, unknown>): boolean {
  return (result.type === "create" || result.type === "update") && typeof result.content === "string";
}

function originalContentOf(result: Record<string, unknown>): string | undefined {
  if (typeof result.originalFile === "string") return result.originalFile;
  return typeof result.originalFileContents === "string" ? result.originalFileContents : undefined;
}

export function editFileKey(filePath: string, cwd: string): string {
  return artifactIdOf(canonicalizeArtifactPath(filePath, cwd));
}

const WORKTREE_TOOLS: ReadonlySet<string> = new Set(["EnterWorktree", "ExitWorktree"]);

function changesCwd(toolName: string): boolean {
  return isShellTool(toolName) || WORKTREE_TOOLS.has(toolName);
}

export interface RunRootState {
  root?: string;
  lastCwd?: string;
  shellInTurn: boolean;
}

export function advanceRunRoot(state: RunRootState, record: Record<string, unknown>): RunRootState {
  const content = asObject(record.message)?.content;
  const blocks = Array.isArray(content) ? content.map(asObject) : [];
  const isInput = record.type === "user" && record.isMeta !== true && !blocks.some((block) => block?.type === "tool_result");
  let { root, lastCwd, shellInTurn } = state;
  if (isInput) shellInTurn = false;
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined;
  if (cwd !== undefined) {
    if (root === undefined || (cwd !== lastCwd && !shellInTurn)) root = cwd;
    lastCwd = cwd;
  }
  if (record.type === "assistant" && blocks.some((block) => block?.type === "tool_use" && typeof block.name === "string" && changesCwd(block.name))) {
    shellInTurn = true;
  }
  return { root, lastCwd, shellInTurn };
}

export function singleToolUseResult(content: unknown, toolUseResult: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  return content.filter((block) => asObject(block)?.type === "tool_result").length === 1 ? toolUseResult : undefined;
}

export type GitEntryProbe = (dir: string) => boolean;
export type WorkFolderLookup = (dir: string) => string | undefined;

type PathRoot = "drive" | "unc" | "posix" | "relative";

function pathRootOf(path: string): PathRoot {
  if (/^[a-z]:\//i.test(path)) return "drive";
  if (path.startsWith("//")) return "unc";
  return path.startsWith("/") ? "posix" : "relative";
}

function pathKey(path: string): string {
  return pathRootOf(path) === "drive" ? path.toLowerCase() : path;
}

const WALK_ROOT_LENGTH: Readonly<Record<PathRoot, number>> = { drive: 3, posix: 1, unc: 0, relative: 0 };

export function findWorkFolder(dir: string, home: string, hasGitEntry: GitEntryProbe): string | undefined {
  const rootLength = WALK_ROOT_LENGTH[pathRootOf(dir)];
  if (rootLength === 0) return undefined;
  const homeKey = `${pathKey(home.replace(/\/+$/, ""))}/`;
  for (let current = dir; current.length > rootLength; current = current.slice(0, current.lastIndexOf("/"))) {
    if (homeKey.startsWith(`${pathKey(current)}/`)) return undefined;
    if (hasGitEntry(current)) return current;
  }
  return undefined;
}

const WORK_FOLDER_MEMO_LIMIT = 1024;
const workFolderMemo = new Map<string, string>();
let canonicalHome: string | undefined;

export function hostWorkFolderOf(dir: string): string | undefined {
  const key = pathKey(dir);
  const memo = workFolderMemo.get(key);
  if (memo !== undefined) return memo;
  canonicalHome ??= canonicalizeArtifactPath(homedir(), "");
  const found = findWorkFolder(dir, canonicalHome, (candidate) => existsSync(`${candidate}/.git`));
  if (found === undefined) return undefined;
  if (workFolderMemo.size >= WORK_FOLDER_MEMO_LIMIT) workFolderMemo.clear();
  workFolderMemo.set(key, found);
  return found;
}

export function editDisplayPath(filePath: string, cwd: string, workFolderOf: WorkFolderLookup): string {
  const file = canonicalizeArtifactPath(filePath, cwd);
  const root = cwd.trim().length > 0 ? canonicalizeArtifactPath(cwd, "") : "";
  if (root.length > 0) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const caseless = ["drive", "unc"].includes(pathRootOf(prefix));
    const inside = caseless ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix);
    if (inside && file.length > prefix.length) return file.slice(prefix.length);
  }
  const cut = file.lastIndexOf("/");
  const folder = cut > 0 ? workFolderOf(file.slice(0, cut)) : undefined;
  return folder !== undefined ? file.slice(folder.lastIndexOf("/") + 1) : basenameOf(filePath);
}

export function countFileEdit(toolName: string, toolUseResult: unknown, cwd: string, workFolderOf: WorkFolderLookup = hostWorkFolderOf): FileEdit | undefined {
  if (!isFileWritingTool(toolName)) return undefined;
  const result = asObject(toolUseResult);
  if (!result || result.staged === true) return undefined;
  if (typeof result.filePath !== "string" || result.filePath.trim().length === 0) return undefined;
  const hunks = patchHunks(result.structuredPatch);
  if (!hunks) return undefined;
  const created = toolName === "Write" && result.type === "create";
  const file = editDisplayPath(result.filePath, cwd, workFolderOf);
  const key = editFileKey(result.filePath, cwd);
  if (hunks.length === 0) {
    if (toolName !== "Write" || typeof result.content !== "string") return undefined;
    const original = typeof result.originalFile === "string" ? result.originalFile : undefined;
    if (original === result.content) return undefined;
    return { file, key, added: lineCount(result.content), removed: created || original === undefined ? 0 : lineCount(original), created };
  }
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { file, key, added, removed, created };
}

interface PatchLine {
  text: string;
  eol: string;
  added: boolean;
}

function sourceLines(text: string): PatchLine[] {
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((piece) => {
    const eol = piece.endsWith("\r\n") ? "\r\n" : piece.endsWith("\n") ? "\n" : "";
    return { text: piece.slice(0, piece.length - eol.length), eol, added: false };
  });
}

function applyPatch(original: string, hunks: readonly PatchHunk[]): string | undefined {
  const source = sourceLines(original);
  const defaultEol = original.includes("\r\n") ? "\r\n" : "\n";
  const out: PatchLine[] = [];
  let noNewlineMarker = false;
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(hunk.oldStart - 1, 0);
    if (start < cursor || start > source.length) return undefined;
    out.push(...source.slice(cursor, start));
    cursor = start;
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      const marker = line[0];
      if (marker === " ") {
        if (cursor >= source.length) return undefined;
        out.push(source[cursor++]);
      } else if (marker === "-") {
        if (cursor >= source.length) return undefined;
        cursor++;
      } else if (marker === "+") {
        const endsFile = hunk.lines[i + 1]?.startsWith("\\") === true;
        out.push({ text: line.slice(1).replace(/\r$/, ""), eol: endsFile ? "" : defaultEol, added: true });
      } else if (marker === "\\") {
        noNewlineMarker = true;
      }
    }
  }
  out.push(...source.slice(cursor));
  const last = out[out.length - 1];
  if (!noNewlineMarker && last?.added && cursor === source.length && source.length > 0 && source[source.length - 1].eol === "") {
    last.eol = "";
  }
  return out.map((line) => line.text + line.eol).join("");
}

export function reconstructEditDiff(firstResult: unknown, lastResult: unknown): { before: string; after: string } | undefined {
  const first = asObject(firstResult);
  const last = asObject(lastResult);
  if (!first || !last) return undefined;
  if (typeof first.filePath !== "string" || typeof last.filePath !== "string") return undefined;
  if (editFileKey(first.filePath, "") !== editFileKey(last.filePath, "")) return undefined;
  const before = first.type === "create" && isWriteResult(first) ? "" : originalContentOf(first);
  if (before === undefined) return undefined;
  if (isWriteResult(last)) return { before, after: last.content as string };
  const lastOriginal = originalContentOf(last);
  if (lastOriginal === undefined) return undefined;
  const hunks = patchHunks(last.structuredPatch);
  if (!hunks) return undefined;
  const after = applyPatch(lastOriginal, hunks);
  return after === undefined ? undefined : { before, after };
}
