import { ASSIGNMENT_RE, POWERSHELL_ASSIGNMENT_RE, withDollars, programName, segmentProgram, isFdDuplication, shellSyntax, runsShellCommand, toolDialect, unescapeSequences, hashtableStatements, stringLiteral, MAX_SCRIPT_NESTING, QUERY_OPTIONS, type ScanBudget, type ShellDialect, type ShellSegment, type ShellSubshell, type ShellSyntax } from "./shell-tools";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, AGY_EFFORTS } from "./orchestration-executors";
import { resolve, relative as relativePath, isAbsolute, join, basename, dirname, win32, posix } from "node:path";
import fs, { readdirSync, statSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { realPathOrNearestSync, resolveNearestRealPathSync, expandHomePath } from "./path-containment";

export type ProtectedKind = "memory" | "CLAUDE.md" | "AGENTS.md" | "rules";
export type GuardReason = "cooccurrence" | "model-name" | "shell" | "edit-not-applied";
export const CONTROL_FILE_NAMES: readonly string[] = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
const CONTROL_FILE_NAMES_FOLDED = CONTROL_FILE_NAMES.map(name => name.toLowerCase());

import { MODEL_NOTES_RULE, DELEGATE_CONTROL_RULE, DELEGATE_MEMORY_RULE, DELEGATE_PROPOSAL, type Placement } from "./placement-line";
export { placementOf } from "./placement-line";

export const PLACEMENT_GUARD_REASON_PREFIX = "LAISORA placement guard:";
const DELEGATE_CONTROL_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} ${DELEGATE_CONTROL_RULE}; ${DELEGATE_PROPOSAL}.`;

export type ControlRefusalKind = "control-write" | "git-control-paths" | "git-unlisted" | "patch-unverified" | "patch-control" | "stash-unclassified" | "stash-ignored" | "git-config" | "unreadable-command"
  | "glob-unexpanded" | "recursive-copy" | "link-control" | "path-unreadable" | "brace-expansion" | "positional-unresolved" | "path-unresolved" | "directory-unresolved"
  | "folder-control-dir" | "folder-control-file" | "folder-unreadable" | "folder-unknown" | "folder-scan-limit";
export interface ControlRefusal { readonly kind: ControlRefusalKind; readonly file?: string; readonly inner?: string }

const CONTROL_REFUSAL_REASONS: Readonly<Record<ControlRefusalKind, (file: string | undefined, inner: string | undefined) => string>> = {
  "control-write": file => `the command writes, moves, deletes or links ${file ?? "a control file or a folder that contains one"}.`,
  "git-control-paths": file => `this git operation would change ${file ?? "control files"}; limit it to other files with an explicit pathspec and leave the change to ${file ?? "those files"} to the conductor.`,
  "git-unlisted": () => "the files this git operation would change could not be listed (unknown revision, or the repository could not be read); check the revision name, or let the conductor run it.",
  "patch-unverified": () => "the patch content could not be verified (the patch is written in the same command, read from standard input, or unreadable); write the patch file and apply it in separate calls, or let the conductor apply it.",
  "patch-control": file => `the patch changes ${file ?? "a control file"}; apply a patch without that file and leave its change to the conductor.`,
  "stash-unclassified": () => "this stash pop or apply could not be classified as a round trip; use one command of the form `git stash push -q -- <paths> && <commands>; git stash pop -q` with no other stash, branch or ref changes, or let the conductor run it.",
  "stash-ignored": () => "git stash -a/--all also stashes ignored files, which can include control files; drop -a/--all and use -u or an explicit pathspec instead.",
  "git-config": () => "git aliases or configuration passed by environment, -c alias.*, --config-env, external diff or pager programs, or an unresolvable -C or --work-tree path cannot be checked; run git without them.",
  "unreadable-command": () => "part of the command could not be read (nesting too deep, an unknown wrapper option, an unclosed quote, a script from standard input or written in the same command, or git run by xargs or find); run the git or file command directly in its own call.",
  "glob-unexpanded": file => `the copy sources ${file ?? ""} could not be expanded; name the files to copy explicitly.`,
  "recursive-copy": file => `the recursive copy into ${file ?? "its destination"} would create or replace a control file; copy only the files that are not control files.`,
  "link-control": file => `the link ${file ?? ""} would make a control file or a folder that contains one reachable through the link; link other files, or leave the link to the conductor.`,
  "path-unreadable": file => `${file ?? "a path in the command"} could not be inspected, so the guard cannot tell whether it reaches a control file; retry once it is readable.`,
  "brace-expansion": file => `the program name ${file ?? ""} uses brace expansion, which the guard does not expand; write the program name out.`,
  "positional-unresolved": file => `the script writes through positional parameters (shift, set --, a loop over the arguments, an assignment or an expansion with an operator) that the guard cannot resolve, and ${file ?? "one of its arguments"} is passed to it; name the files in the script itself, or leave the change to the conductor.`,
  "path-unresolved": file => `the target ${file ?? ""} contains a variable, command substitution or loop variable whose value is not set by a plain assignment earlier in this command, so the guard cannot tell whether it reaches a control file; write the literal path, or delete or move the entries individually.`,
  "directory-unresolved": file => `the command changes to a directory whose path the guard cannot determine, so it cannot tell where ${file ?? "the relative path"} points; change to a literal directory, or use an absolute path.`,
  "folder-control-dir": (file, inner) => `the folder ${file ?? ""} contains the control directory ${inner === "." ? "(the folder itself)" : inner ?? ".claude"}; delete or move the other entries individually and leave the control directory to the conductor.`,
  "folder-control-file": (file, inner) => `the folder ${file ?? ""} contains the control file ${inner ?? "CLAUDE.md"}; delete or move the other entries individually and leave ${inner ?? "that file"} to the conductor.`,
  "folder-unreadable": (file, inner) => `${inner && inner !== "." ? `${inner} inside the folder ${file ?? ""}` : `the folder ${file ?? ""}`} could not be read, so the guard cannot tell whether the folder contains a control file; retry once it is readable, or name the files individually.`,
  "folder-unknown": file => `the memory, rules or hooks locations under the Claude Code configuration directory could not be read, so the guard cannot tell whether the folder ${file ?? ""} contains one; retry once they are readable, or name the files individually.`,
  "folder-scan-limit": file => `the folder ${file ?? ""} has more than ${CONTROL_SCAN_LIMIT} entries, so the guard stopped looking for control files in it; delete or move its subfolders one at a time.`,
};

const CONTROL_WRITE: ControlRefusal = { kind: "control-write" };

const REFUSAL_PATH_LIMIT = 200;
const shownPath = (path: string | undefined) => path === undefined ? path : withDollars(path.length > REFUSAL_PATH_LIMIT ? `${path.slice(0, REFUSAL_PATH_LIMIT)}...` : path);

export function delegateControlRefusal(refusal: ControlRefusal = CONTROL_WRITE): string {
  return `${DELEGATE_CONTROL_REFUSAL}\nReason: ${CONTROL_REFUSAL_REASONS[refusal.kind](shownPath(refusal.file), shownPath(refusal.inner))}`;
}

export const PLACEMENT_UNREADABLE_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} the current content of this protected file could not be read, so the edit cannot be checked. Retry once the file is readable.`;
export const PLACEMENT_EDIT_NOT_APPLIED_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} old_string was not found in the current content of this protected file, so the edit cannot be checked. Read the file again and resend the edit with old_string copied exactly from it.`;
export const PLACEMENT_GUARD_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} this write targets persistent instructions. Session-only instructions are not persisted; keep them in this conversation. ${MODEL_NOTES_RULE}; standing model choices belong in roster or conductor policy settings. Please do not retry by removing or paraphrasing names. Please use Write or Edit for shell writes so the content can be checked.`;

export const PLACEMENT_EFFORT_WORDS: readonly string[] = Object.freeze([...new Set<string>([...CLAUDE_EFFORTS, ...CODEX_EFFORTS, ...AGY_EFFORTS])]);
const STRENGTH_CLAIM_RE = /得意|苦手|(?<![A-Za-z0-9_])(?:good|better|best|bad|worse|worst|strong|weak) at(?![A-Za-z0-9_])/i;
const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"];
const PRODUCT_TERMS_RE = /(?<![A-Za-z0-9_])(?:claude\s+code|claude(?:\.local)?\.md)(?![A-Za-z0-9_])/gi;
const BARE_ALIAS_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${CLAUDE_ALIASES.join("|")})(?![A-Za-z0-9_-]|\\s?\\d)`, "gi");
const CAPITALISED_ALIAS_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${CLAUDE_ALIASES.map(alias => alias[0].toUpperCase() + alias.slice(1)).join("|")})(?![A-Za-z0-9_-])`, "g");
const MODEL_WORD_RE = /(?<![A-Za-z])models?(?![A-Za-z])|モデル/i;
const MODEL_NAME_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?<![A-Za-z0-9_])(?:${CLAUDE_ALIASES.join("|")})(?![A-Za-z0-9_])`, "i"),
  /(?<![A-Za-z0-9_])(?:claude|opus|sonnet|haiku|fable|gemini|gpt)[- ]?\d+(?:\.\d+)*/i,
  /(?<![A-Za-z0-9_])claude-[a-z]+-\d/i,
];

export interface PlacementVocabulary {
  readonly names: readonly string[];
  readonly effortWords: readonly string[];
  readonly listedModelIds: readonly string[];
}

const ABSENT_PATH_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD_BEFORE = "A-Za-z0-9_";
const PATH_SEGMENT_BEFORE = "./\\\\";
function wordPattern(words: readonly string[], excludedBefore = WORD_BEFORE): RegExp | undefined {
  const unique = [...new Set(words.filter((word) => word.trim() !== ""))].sort((a, b) => b.length - a.length);
  return unique.length ? new RegExp(`(?<![${excludedBefore}])(?:${unique.map(escape).join("|")})(?![A-Za-z0-9_])`, "i") : undefined;
}

export interface CompiledVocabulary {
  readonly names?: RegExp;
  readonly qualifiers?: RegExp;
  readonly listed?: RegExp;
}

export function compileVocabulary(vocabulary: PlacementVocabulary): CompiledVocabulary {
  return { names: wordPattern(vocabulary.names, WORD_BEFORE + PATH_SEGMENT_BEFORE), qualifiers: wordPattern(vocabulary.effortWords), listed: wordPattern(vocabulary.listedModelIds) };
}

export interface LineVerdict {
  readonly cooccurrence: boolean;
  readonly modelName: boolean;
}

function modelContext(text: string): boolean {
  return MODEL_WORD_RE.test(text) || new Set(text.match(CAPITALISED_ALIAS_RE) ?? []).size >= 2;
}

const comparableText = (line: string): string => line.normalize("NFKC").replace(/\p{Cf}/gu, "");

export function lineVerdict(line: string, vocabulary: CompiledVocabulary): LineVerdict {
  const products = comparableText(line).replace(PRODUCT_TERMS_RE, " ");
  const text = modelContext(products) ? products : products.replace(BARE_ALIAS_RE, " ");
  const cooccurrence = !!vocabulary.names?.test(text) && (!!vocabulary.qualifiers?.test(text) || STRENGTH_CLAIM_RE.test(text));
  const modelName = MODEL_NAME_PATTERNS.some((re) => re.test(text)) || !!vocabulary.listed?.test(text);
  return { cooccurrence, modelName };
}

function lfText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function splitLines(text: string): string[] {
  return lfText(text).split("\n");
}

export function addedLines(before: string | undefined, after: string): string[] {
  const remaining = new Map<string, number>();
  for (const line of before === undefined ? [] : splitLines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of splitLines(after)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1); else added.push(line);
  }
  return added;
}

export interface EditOperation {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

const straightQuotes = (text: string): string => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

function matchedText(content: string, searched: string): string | undefined {
  if (content.includes(searched)) return searched;
  const at = straightQuotes(content).indexOf(straightQuotes(searched));
  return at < 0 ? undefined : content.slice(at, at + searched.length);
}

export function applyEdits(content: string | undefined, edits: readonly EditOperation[]): string | undefined {
  let result = lfText(content ?? "");
  for (const edit of edits) {
    if (typeof edit?.old_string !== "string" || typeof edit.new_string !== "string") return undefined;
    const searched = lfText(edit.old_string), after = lfText(edit.new_string);
    if (searched === "") {
      if (result.trim() !== "") return undefined;
      result = after;
      continue;
    }
    const before = matchedText(result, searched);
    if (before === undefined) return undefined;
    result = edit.replace_all ? result.split(before).join(after) : result.replace(before, () => after);
  }
  return result;
}

const foldsCase = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  let text = value.trim().replace(/\\/g, "/");
  if (platform === "win32") {
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(text);
    if (msys) text = `${msys[1]}:${msys[2] ?? "/"}`;
    const parts = text.split("/");
    text = parts.map((part, i) => /^\.+$/.test(part) ? part : part.replace(i === parts.length - 1 ? /[. ]+$/ : /\.+$/, "")).join("/");
  }
  if (foldsCase(platform)) text = text.toLowerCase();
  return text.replace(/\/+/g, "/");
}

export const fileSystemWord = (word: string): string => withDollars(word);

export function gitRootFromExecPath(execPath: string): string | undefined {
  return /^([A-Za-z]:[\\/].*?)[\\/](?:mingw64|mingw32|clangarm64|usr)[\\/]libexec[\\/]git-core[\\/]?$/i.exec(execPath.trim())?.[1];
}

const GIT_ROOT_RETRY_MS = 60_000;
let gitBashRootPath: { readonly path: string; readonly probed: boolean; readonly at: number } | undefined;
function gitBashRoot(): string {
  if (gitBashRootPath === undefined || !gitBashRootPath.probed && Date.now() - gitBashRootPath.at > GIT_ROOT_RETRY_MS) {
    let execPath = "";
    try { execPath = execFileSync("git", ["--exec-path"], { ...GIT_READ_OPTIONS, env: gitInertEnv() }); } catch { execPath = ""; }
    const probed = gitRootFromExecPath(execPath);
    gitBashRootPath = { path: probed ?? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git"), probed: probed !== undefined, at: Date.now() };
  }
  return gitBashRootPath.path;
}

function gitBashAbsolute(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  const temporary = /^\/tmp(?=\/|$)/.exec(normalized), drive = /^\/([A-Za-z])(?=\/|$)/.exec(normalized);
  if (temporary) return tmpdir() + normalized.slice(4);
  if (drive) return `${drive[1]}:/${normalized.slice(3)}`;
  return join(gitBashRoot(), normalized);
}

function gitBashView(path: string): string {
  const inner = relativePath(gitBashRoot(), path);
  if (!inner.startsWith("..") && !isAbsolute(inner)) return posix.join("/", inner.replace(/\\/g, "/"));
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(path);
  return drive ? posix.join("/", drive[1].toLowerCase(), drive[2].replace(/\\/g, "/")) : path.replace(/\\/g, "/");
}

export function placementPath(value: string, cwd = process.cwd(), canonical = true, gitBash = false): string | undefined {
  if (/[*?]|\$\(/.test(value)) return undefined;
  let path = expandHomePath(fileSystemWord(value));
  let requested: string;
  if (gitBash && process.platform === "win32" && !/^(?:[A-Za-z]:|[/\\]{2})/.test(path)) requested = gitBashAbsolute(/^[/\\]/.test(path) ? path : `${gitBashView(resolve(cwd))}/${path}`);
  else {
    if (process.platform === "win32") path = path.replace(/^\/([a-z])(?=\/)/i, "$1:");
    requested = resolve(cwd, path);
  }
  return canonical ? realPathOrNearestSync(requested) ?? undefined : requested;
}

const UNREADABLE_REAL_PATH = Symbol("unreadable real path");
function canonicalPlacement(value: string, cwd = process.cwd(), gitBash = false): string | typeof UNREADABLE_REAL_PATH | undefined {
  const requested = placementPath(value, cwd, false, gitBash);
  if (requested === undefined) return undefined;
  const result = resolveNearestRealPathSync(requested);
  return "path" in result ? result.path : result.unresolved === "error" ? UNREADABLE_REAL_PATH : undefined;
}

function absentPath(path: string): boolean {
  try { statSync(path); return false; }
  catch (error) { return ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
}

export function controlFileContext(configDir: string) {
  const roots: { path: string; requested: string; kind: ProtectedKind | "control"; directory: boolean; present: boolean }[] = [];
  let unknown = false;
  const add = (path: string, kind: ProtectedKind | "control", directory = true) => {
    const canonical = canonicalPlacement(path);
    if (canonical === UNREADABLE_REAL_PATH) unknown = true;
    else if (canonical) roots.push({ requested: path, path: normalizedPath(canonical, process.platform).replace(/\/$/, ""), kind, directory, present: !absentPath(path) });
  };
  try { for (const project of readdirSync(join(configDir, "projects"))) add(join(configDir, "projects", project, "memory"), "memory"); }
  catch (error) { unknown = !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
  add(join(configDir, "rules"), "rules");
  add(join(configDir, "hooks"), "control");
  add(join(configDir, "settings.json"), "control", false);
  return { roots, unknown };
}
type ControlFileContext = ReturnType<typeof controlFileContext>;

function lexicalProtectedKind(path: string, configDir: string, platform: NodeJS.Platform): ProtectedKind | undefined {
  const config = normalizedPath(configDir, platform).replace(/\/$/, "");
  const target = normalizedPath(path, platform);
  const name = target.split("/").pop() ?? "";
  const fold = (value: string) => foldsCase(platform) ? value.toLowerCase() : value;
  const underConfig = (sub: string) => target === `${config}/${sub}` || target.startsWith(`${config}/${sub}/`) || target.startsWith(`~/.claude/${sub}/`) || target.startsWith(`$home/.claude/${sub}/`);
  if (new RegExp(`^${escape(config)}/projects/[^/]+/memory(?:/|$)`).test(target) || /(^|\/)\.claude\/projects\/[^/]+\/memory(?:\/|$)/.test(target)) return "memory";
  if ([fold("CLAUDE.md"), fold("CLAUDE.local.md")].includes(name)) return "CLAUDE.md";
  if (name === fold("AGENTS.md")) return "AGENTS.md";
  if (underConfig("rules") || /(^|\/)\.claude\/rules(?:\/|$)/.test(target)) return "rules";
  return undefined;
}

export function protectedDestination(filePath: string, configDir: string, platform: NodeJS.Platform = process.platform, context?: ControlFileContext): ProtectedKind | undefined {
  const requested = platform === process.platform ? placementPath(filePath, process.cwd(), false) ?? filePath : filePath;
  const classify = (path: string) => lexicalProtectedKind(path, configDir, platform);
  const lexical = classify(requested);
  if (lexical || platform !== process.platform) return lexical;
  const canonical = canonicalPlacement(requested);
  if (canonical === UNREADABLE_REAL_PATH) return "memory";
  if (!canonical) return undefined;
  const direct = classify(canonical);
  if (direct) return direct;
  if (context) {
    const target = normalizedPath(canonical, platform);
    return context.roots.find(root => root.kind !== "control" && (target === root.path || root.directory && target.startsWith(root.path + "/")))?.kind as ProtectedKind | undefined
      ?? (context.unknown ? "memory" : undefined);
  }
  const roots: { path: string; kind: ProtectedKind }[] = [];
  let memoryRootsUnknown = false;
  try {
    for (const project of readdirSync(join(configDir, "projects"))) roots.push({ path: join(configDir, "projects", project, "memory"), kind: "memory" });
  } catch (error) {
    memoryRootsUnknown = !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "");
  }
  roots.push({ path: join(configDir, "rules"), kind: "rules" });
  const target = normalizedPath(canonical, platform);
  let unresolvedRoot: ProtectedKind | undefined;
  for (const root of roots) {
    const real = canonicalPlacement(root.path);
    if (real === UNREADABLE_REAL_PATH) { unresolvedRoot ??= root.kind; continue; }
    if (!real) continue;
    const normalized = normalizedPath(real, platform).replace(/\/$/, "");
    if (target === normalized || target.startsWith(`${normalized}/`)) return root.kind;
  }
  return memoryRootsUnknown ? "memory" : unresolvedRoot;
}

/** Lexical filter: safe to use before any filesystem probes on Git listings. */
export function isControlPath(filePath: string, configDir: string, platform: NodeJS.Platform = process.platform): boolean {
  const target = normalizedPath(filePath, platform);
  const config = normalizedPath(configDir, platform).replace(/\/$/, "");
  const names = foldsCase(platform) ? CONTROL_FILE_NAMES_FOLDED : CONTROL_FILE_NAMES;
  return names.includes(target.slice(target.lastIndexOf("/") + 1))
    || /(^|\/)\.claude$/.test(target)
    || /(^|\/)\.claude\/(?:settings(?:\.local)?\.json$|(?:rules|hooks)(?:\/|$)|projects\/[^/]+\/memory(?:\/|$))/.test(target)
    || target === config + "/settings.json"
    || ["rules", "hooks"].some(part => target === config + "/" + part || target.startsWith(config + "/" + part + "/"))
    || target.startsWith(config + "/projects/") && /\/projects\/[^/]+\/memory(?:\/|$)/.test(target);
}

export function isControlFile(filePath: string, configDir: string, platform: NodeJS.Platform = process.platform, context?: ControlFileContext): boolean {
  if (protectedDestination(filePath, configDir, platform, context) !== undefined) return true;
  const config = normalizedPath(configDir, platform).replace(/\/$/, "");
  const classify = (path: string): boolean => {
    const target = normalizedPath(path, platform);
    return /(^|\/)\.claude\/settings(?:\.local)?\.json$/.test(target)
      || /(^|\/)\.claude\/hooks(?:\/|$)/.test(target)
      || target === config + "/settings.json" || target === config + "/hooks" || target.startsWith(config + "/hooks/");
  };
  const requested = platform === process.platform ? placementPath(filePath, process.cwd(), false) ?? filePath : filePath;
  if (classify(requested)) return true;
  if (platform !== process.platform) return false;
  const canonical = canonicalPlacement(requested);
  if (canonical === UNREADABLE_REAL_PATH) return true;
  if (!canonical) return false;
  if (classify(canonical)) return true;
  const target = normalizedPath(canonical, platform);
  if (context) return context.unknown || context.roots.some(root => target === root.path || root.directory && target.startsWith(root.path + "/"));
  for (const [path, directory] of [[join(configDir, "settings.json"), false], [join(configDir, "hooks"), true]] as const) {
    const real = canonicalPlacement(path);
    if (real === UNREADABLE_REAL_PATH) return true;
    if (!real) continue;
    const normalized = normalizedPath(real, platform).replace(/\/$/, "");
    if (target === normalized || directory && target.startsWith(normalized + "/")) return true;
  }
  return false;
}

export interface GuardDecision {
  readonly destination?: ProtectedKind | "control";
  readonly blocked: boolean;
  readonly reasons: readonly GuardReason[];
  readonly examinedLines: number;
  readonly blockedLines: readonly string[];
  readonly refusal?: ControlRefusal;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function editOperations(tool: string, value: Record<string, unknown>): EditOperation[] | undefined {
  if (tool === "Edit") return [value as unknown as EditOperation];
  if (tool === "MultiEdit") return Array.isArray(value.edits) ? value.edits as EditOperation[] : undefined;
  return undefined;
}

type WrittenContent = { readonly after: string } | { readonly unapplied: true } | undefined;

function writtenContent(tool: string, input: unknown, current: string | undefined): WrittenContent {
  const value = inputRecord(input);
  if (tool === "Write") return typeof value.content === "string" ? { after: value.content } : undefined;
  const edits = editOperations(tool, value);
  if (!edits) return undefined;
  const after = applyEdits(current, edits);
  return after === undefined ? { unapplied: true } : { after };
}

export type MemoryActor = "conductor" | "delegate";
export type MemoryReason = "delegate" | "untyped" | "type" | "index-target-missing" | "index-line" | "edit-not-applied";

export interface MemoryDecision {
  readonly destination?: "memory";
  readonly blocked: boolean;
  readonly reasons: MemoryReason[];
  readonly blockedLines: string[];
  readonly type?: string;
}

const MEMORY_METADATA_KEY = "metadata";

function memoryTopicType(content: string, memoryTypes: readonly string[]): { type?: string; reason?: MemoryReason } {
  const lines = splitLines(content.replace(/^\uFEFF/, ""));
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) return { reason: "untyped" };
  const types: string[] = [];
  let inMetadata = false;
  for (const line of lines.slice(1, end)) {
    const field = /^( {2})?([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(\S.*)?$/.exec(line);
    if (!field || (field[1] !== undefined && !inMetadata)) return { reason: "untyped" };
    const value = (field[3] ?? "").trim();
    if (field[1] === undefined) inMetadata = field[2] === MEMORY_METADATA_KEY && value === "";
    if (field[2] === "type") types.push(value);
    else if (/^[|>]/.test(value)) return { reason: "untyped" };
  }
  if (!types.length) return { reason: "untyped" };
  const type = types.join(", ");
  return { type, reason: types.length === 1 && /^[a-z]+$/.test(type) && memoryTypes.includes(type) ? undefined : "type" };
}

export function readGuardedFile(path: string): string {
  const bytes = readFileSync(path);
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : "utf8");
}

function readMemoryFile(path: string): string | undefined {
  try { return readGuardedFile(path); } catch { return undefined; }
}

export function judgeMemoryWrite(tool: string, input: unknown, current: string | undefined, actor: MemoryActor, memoryTypes: readonly string[], configDir: string,
  platform: NodeJS.Platform = process.platform, readFile: (path: string) => string | undefined = readMemoryFile): MemoryDecision {
  const filePath = inputRecord(input).file_path;
  if (typeof filePath !== "string" || protectedDestination(filePath, configDir, platform) !== "memory") return { blocked: false, reasons: [], blockedLines: [] };
  const destination = "memory";
  if (actor === "delegate") return { destination, blocked: true, reasons: ["delegate"], blockedLines: [] };
  const content = writtenContent(tool, input, current);
  if (content && "unapplied" in content) return { destination, blocked: true, reasons: ["edit-not-applied"], blockedLines: [] };
  if (content === undefined || content.after.trim() === "") return { destination, blocked: false, reasons: [], blockedLines: [] };
  const after = content.after;
  const additions = addedLines(current?.replace(/^﻿/, ""), after.replace(/^﻿/, "")).filter(line => line.trim() !== "");
  if (!additions.length) return { destination, blocked: false, reasons: [], blockedLines: [] };
  const path = platform === "win32" ? win32 : posix;
  const canonical = platform === process.platform ? canonicalPlacement(filePath) : filePath;
  if (typeof canonical !== "string") return { destination, blocked: true, reasons: ["type"], blockedLines: [] };
  const name = path.basename(canonical);
  if (platform === "win32" ? name.toLowerCase() !== "memory.md" : name !== "MEMORY.md") {
    const verdict = memoryTopicType(after, memoryTypes);
    return { destination, blocked: verdict.reason !== undefined, reasons: verdict.reason ? [verdict.reason] : [], blockedLines: verdict.reason ? splitLines(after).filter(line => line.trim() !== "") : [], type: verdict.type };
  }
  const reasons = new Set<MemoryReason>();
  const blockedLines: string[] = [];
  let type: string | undefined;
  for (const line of additions) {
    const entry = /^- \[[^\]\r\n]+\]\(([^()\s]+)\)(?:[ \t].*)?$/.exec(line);
    const target = entry?.[1];
    let reason: MemoryReason | undefined;
    if (!target || !(platform === "win32" ? /\.md$/i : /\.md$/).test(target) || (platform === "win32" ? target.toLowerCase() === "memory.md" : target === "MEMORY.md") || /[\\/:<>"|?*\x00-\x1f]/.test(target) || target.includes("..")) reason = "index-line";
    else {
      const directory = path.dirname(canonical);
      const requested = path.join(directory, target);
      const realTarget = platform === process.platform ? canonicalPlacement(requested) : requested;
      if (typeof realTarget !== "string" || normalizedPath(path.dirname(realTarget), platform) !== normalizedPath(directory, platform) || normalizedPath(realTarget, platform) === normalizedPath(canonical, platform)) reason = "index-line";
      else {
        const content = readFile(realTarget);
        if (content === undefined) reason = "index-target-missing";
        else {
          const verdict = memoryTopicType(content, memoryTypes);
          reason = verdict.reason;
          if (reason === "type") type ??= verdict.type;
        }
      }
    }
    if (reason) { reasons.add(reason); blockedLines.push(line); }
  }
  return { destination, blocked: reasons.size > 0, reasons: [...reasons], blockedLines, ...(type === undefined ? {} : { type }) };
}

export function memoryGuardReason(decision: MemoryDecision, placement: Placement): string {
  if (decision.reasons.includes("edit-not-applied")) return PLACEMENT_EDIT_NOT_APPLIED_REFUSAL;
  const reason = decision.reasons.includes("delegate") ? `${DELEGATE_MEMORY_RULE}; delegates must not write memory` : "this memory write has an invalid topic type or index entry";
  return `${PLACEMENT_GUARD_REASON_PREFIX} ${reason}. ${placement.memoryDestination}. Topic frontmatter must contain only single-line key: value lines (top level, or indented two spaces under metadata:) with one plain type in [${placement.memoryTypes.join(", ")}]; index additions must link to existing, typed topic files in the same directory. Do not retry by changing the type.`;
}

export function judgeFileWrite(tool: string, input: unknown, current: string | undefined, vocabulary: CompiledVocabulary | undefined, configDir: string,
  platform: NodeJS.Platform = process.platform): GuardDecision {
  const filePath = inputRecord(input).file_path;
  const destination = typeof filePath === "string" ? protectedDestination(filePath, configDir, platform) : undefined;
  if (destination === undefined) return { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const content = writtenContent(tool, input, current);
  if (content && "unapplied" in content) return { destination, blocked: true, reasons: ["edit-not-applied"], examinedLines: 0, blockedLines: [] };
  if (content === undefined || !vocabulary) return { destination, blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const lines = addedLines(current, content.after);
  const reasons = new Set<GuardReason>();
  const blockedLines: string[] = [];
  for (const line of lines) {
    const verdict = lineVerdict(line, vocabulary);
    if (verdict.cooccurrence) reasons.add("cooccurrence");
    if (verdict.modelName) reasons.add("model-name");
    if (verdict.cooccurrence || verdict.modelName) blockedLines.push(line);
  }
  return { destination, blocked: blockedLines.length > 0, reasons: [...reasons], examinedLines: lines.length, blockedLines };
}

const REDIRECT_RE = /^(?:\d*|&|\*)>>?[|&]?$/;
const INPUT_REDIRECT_RE = /^\d*<(?:&[\d-]*)?$/;
const CONTENT_CMDLETS = new Set(["set-content", "add-content", "clear-content", "out-file", "new-item", "tee", "tee-object"]);
const CONTENT_FROM_PIPELINE_CMDLETS: ReadonlySet<string> = new Set(["set-content", "add-content", "clear-content", "new-item"]);
const POWERSHELL_ALIASES: ReadonlyMap<string, string> = new Map(`
  %=foreach-object ?=where-object ac=add-content asnp=add-pssnapin cat=get-content cd=set-location cfs=convertfrom-string chdir=set-location clc=clear-content clear=clear-host
  clhy=clear-history cli=clear-item clp=clear-itemproperty cls=clear-host clv=clear-variable cnsn=connect-pssession compare=compare-object copy=copy-item cp=copy-item cpi=copy-item
  cpp=copy-itemproperty curl=invoke-webrequest cvpa=convert-path dbp=disable-psbreakpoint del=remove-item diff=compare-object dir=get-childitem dnsn=disconnect-pssession
  ebp=enable-psbreakpoint echo=write-output epal=export-alias epcsv=export-csv epsn=export-pssession erase=remove-item etsn=enter-pssession exsn=exit-pssession fc=format-custom
  fhx=format-hex fl=format-list ft=format-table fw=format-wide gal=get-alias gbp=get-psbreakpoint gc=get-content gci=get-childitem gcm=get-command gcs=get-pscallstack
  gdr=get-psdrive ghy=get-history gi=get-item gjb=get-job gl=get-location gm=get-member gmo=get-module gp=get-itemproperty gps=get-process gpv=get-itempropertyvalue group=group-object
  gsn=get-pssession gsnp=get-pssnapin gsv=get-service gu=get-unique gv=get-variable gwmi=get-wmiobject h=get-history history=get-history icm=invoke-command iex=invoke-expression
  ihy=invoke-history ii=invoke-item ipal=import-alias ipcsv=import-csv ipmo=import-module ipsn=import-pssession irm=invoke-restmethod ise=powershell_ise.exe iwmi=invoke-wmimethod
  iwr=invoke-webrequest kill=stop-process lp=out-printer ls=get-childitem man=help md=mkdir measure=measure-object mi=move-item mount=new-psdrive move=move-item mp=move-itemproperty
  mv=move-item nal=new-alias ndr=new-psdrive ni=new-item nmo=new-module npssc=new-pssessionconfigurationfile nsn=new-pssession nv=new-variable ogv=out-gridview oh=out-host
  popd=pop-location ps=get-process pushd=push-location pwd=get-location r=invoke-history rbp=remove-psbreakpoint rcjb=receive-job rcsn=receive-pssession rd=remove-item
  rdr=remove-psdrive ren=rename-item ri=remove-item rjb=remove-job rm=remove-item rmdir=remove-item rmo=remove-module rni=rename-item rnp=rename-itemproperty rp=remove-itemproperty
  rsn=remove-pssession rsnp=remove-pssnapin rujb=resume-job rv=remove-variable rvpa=resolve-path rwmi=remove-wmiobject sajb=start-job sal=set-alias saps=start-process
  sasv=start-service sbp=set-psbreakpoint sc=set-content select=select-object set=set-variable shcm=show-command si=set-item sl=set-location sleep=start-sleep sls=select-string
  sort=sort-object sp=set-itemproperty spjb=stop-job spps=stop-process spsv=stop-service start=start-process sujb=suspend-job sv=set-variable swmi=set-wmiinstance tee=tee-object
  trcm=trace-command type=get-content wget=invoke-webrequest where=where-object wjb=wait-job write=write-output
`.trim().split(/\s+/).map(entry => entry.split("=") as [string, string]));
const CROSS_DIALECT_CMDLETS: ReadonlyMap<string, string> = new Map(["ni", "sc", "ac", "clc", "rni", "ren", "iwr", "irm", "rm", "del", "erase", "ri", "rmdir", "rd"]
  .map(alias => [alias, POWERSHELL_ALIASES.get(alias)!]));
const ALIAS_DEFINING_CMDLETS: ReadonlySet<string> = new Set(["set-alias", "new-alias"]);
const ALIAS_HOPS = 8;

function commandName(word: string, dialect: ShellDialect, scope?: ShellScope): string {
  let name = programName(word);
  if (dialect !== "powershell") return CROSS_DIALECT_CMDLETS.get(name) ?? name;
  for (let hop = 0; hop < ALIAS_HOPS; hop++) {
    const next = (scope && scopeEntry(scope, current => current.aliases, name)) ?? POWERSHELL_ALIASES.get(name);
    if (next === undefined || next === null) break;
    name = next;
  }
  return name;
}
const COPY_PROGRAMS = new Set(["cp", "mv", "ln", "copy", "move"]);
const COPY_CMDLETS = new Set(["copy-item", "move-item"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const POWERSHELL_PROGRAMS: ReadonlySet<string> = new Set(["pwsh", "powershell"]);
const INLINE_RUNNERS = new Set(["python", "python3", "node", ...POWERSHELL_PROGRAMS]);
const INLINE_FLAGS = new Set(["-c", "-e", "-command", "--eval", "-p"]);
const PYTHON_STRING_PREFIX = "(?:[rRbBuU]{1,2})?";
const PYTHON_WRITE_MODE = String.raw`${PYTHON_STRING_PREFIX}['"](?:[wax][bt+]*|r[bt]*\+[bt+]*)['"]`;
const PYTHON_KEYWORD_ARGUMENT = String.raw`[A-Za-z_]\w*\s*=\s*(?:'[^'\n]*'|"[^"\n]*"|[\w.-]+)\s*,\s*`;
const PYTHON_WRITE_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bopen\s*\(\s*(?:file\s*=\s*)?${PYTHON_STRING_PREFIX}(['"])(?<path>(?:(?!\1)[^\n])*)\1\s*,\s*(?:(?:${PYTHON_KEYWORD_ARGUMENT})*mode\s*=\s*)?${PYTHON_WRITE_MODE}`, "g"),
  new RegExp(String.raw`\b(?:Path|pathlib\.Path)\s*\(\s*${PYTHON_STRING_PREFIX}(['"])(?<path>(?:(?!\1)[^\n])*)\1\s*\)\.(?:write_text|write_bytes)\s*\(`, "g"),
];
const NODE_WRITE_PATTERNS: readonly RegExp[] = [
  /(?<![\w$])(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\s*\(\s*(['"`])(?<path>(?:(?!\1|\$\{)[^\n])*)\1/g,
];
const INLINE_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-W", "-X", "--check-hash-based-pycs", "-r", "--require", "--import", "--input-type"]);
const NODE_SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

export function optionValueUnknown(program: string, option: string): boolean {
  return program === "node" && option.startsWith("-") && !option.includes("=") && !option.startsWith("--no-") && !INLINE_VALUE_OPTIONS.has(option);
}
const POWERSHELL_COMMON_VALUES = ["erroraction", "warningaction", "informationaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable"];
const POWERSHELL_PROVIDER_VALUES = ["path", "literalpath", "filter", "include", "exclude", "credential"];
const POWERSHELL_WRITE_SWITCHES = ["force", "whatif", "confirm", "usetransaction"];
const ANY_CMDLET = "*", EXPORT_CMDLET = "export-*";
const CMDLET_NAME = /^[a-z]+-[a-z]/;
const POWERSHELL_PARAMETERS: Record<string, { values: readonly string[]; switches: readonly string[] }> = {
  "set-content": { values: [...POWERSHELL_PROVIDER_VALUES, "value", "encoding", "stream"], switches: [...POWERSHELL_WRITE_SWITCHES, "passthru", "nonewline"] },
  "add-content": { values: [...POWERSHELL_PROVIDER_VALUES, "value", "encoding", "stream"], switches: [...POWERSHELL_WRITE_SWITCHES, "passthru", "nonewline"] },
  "out-file": { values: ["filepath", "literalpath", "encoding", "width", "inputobject"], switches: ["force", "whatif", "confirm", "append", "noclobber", "nonewline"] },
  "copy-item": { values: [...POWERSHELL_PROVIDER_VALUES, "destination", "fromsession", "tosession"], switches: [...POWERSHELL_WRITE_SWITCHES, "container", "recurse", "passthru"] },
  "clear-content": { values: [...POWERSHELL_PROVIDER_VALUES, "stream"], switches: POWERSHELL_WRITE_SWITCHES },
  "remove-item": { values: POWERSHELL_PROVIDER_VALUES, switches: [...POWERSHELL_WRITE_SWITCHES, "recurse"] },
  "move-item": { values: [...POWERSHELL_PROVIDER_VALUES, "destination"], switches: [...POWERSHELL_WRITE_SWITCHES, "passthru"] },
  "rename-item": { values: ["path", "literalpath", "newname", "credential"], switches: [...POWERSHELL_WRITE_SWITCHES, "passthru"] },
  "new-item": { values: ["path", "name", "itemtype", "value", "credential"], switches: POWERSHELL_WRITE_SWITCHES },
  "tee-object": { values: ["filepath", "literalpath", "inputobject", "variable"], switches: ["append"] },
  "join-path": { values: ["path", "childpath", "additionalchildpath", "credential"], switches: ["resolve"] },
  "set-alias": { values: ["name", "value", "description", "option", "scope"], switches: ["passthru", "force", "whatif", "confirm"] },
  "new-alias": { values: ["name", "value", "description", "option", "scope"], switches: ["passthru", "force", "whatif", "confirm"] },
  [ANY_CMDLET]: { values: ["outfile"], switches: [] },
  [EXPORT_CMDLET]: { values: ["path", "literalpath", "filepath", "outfile"], switches: [] },
};
const POWERSHELL_PARAMETER_ALIASES: Record<string, string> = {
  pspath: "literalpath", nooverwrite: "noclobber", type: "itemtype", target: "value", vb: "verbose", db: "debug",
  ea: "erroraction", wa: "warningaction", infa: "informationaction", ev: "errorvariable", wv: "warningvariable",
  iv: "informationvariable", ov: "outvariable", ob: "outbuffer", pv: "pipelinevariable", wi: "whatif", cf: "confirm", usetx: "usetransaction",
};

function powershellArguments(program: string, args: readonly string[]) {
  const parameters = POWERSHELL_PARAMETERS[program];
  const switches = new Set(["verbose", "debug", ...parameters.switches]);
  const names = [...POWERSHELL_COMMON_VALUES, ...parameters.values, ...switches];
  const aliases = Object.entries(POWERSHELL_PARAMETER_ALIASES).filter(([, name]) => names.includes(name));
  const named = new Map<string, string>(), positional: string[] = [];
  let ended = false, uncertain = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (ended || !word.startsWith("-")) { positional.push(word); continue; }
    if (word === "--") { ended = true; continue; }
    const colon = word.indexOf(":");
    const prefix = (colon < 0 ? word : word.slice(0, colon)).slice(1).toLowerCase();
    const exact = names.includes(prefix) ? prefix : aliases.find(([alias]) => alias === prefix)?.[1];
    const matches = new Set(exact ? [exact] : [...names.filter(name => name.startsWith(prefix)), ...aliases.filter(([alias]) => alias.startsWith(prefix)).map(([, name]) => name)]);
    if (matches.size !== 1) { uncertain = true; continue; }
    const name = [...matches][0];
    if (switches.has(name)) continue;
    const value = colon < 0 ? args[++i] : word.slice(colon + 1);
    if (value !== undefined) named.set(`-${name}`, value);
  }
  return { named, positional, uncertain };
}

type ScriptLanguage = "python" | "node" | "shell";
type ScanMode = "code" | "'" | '"' | "`" | "'''" | '"""' | "line" | "block" | "regex" | "class";
interface ScanFrame { readonly mode: ScanMode; readonly interpolated: boolean; readonly depth: number }
interface ScanState { readonly mode: ScanMode; readonly interpolated: boolean; readonly frames: readonly ScanFrame[]; readonly skip: number }

const NODE_KEYWORDS_BEFORE_REGEX: ReadonlySet<string> = new Set(["return", "typeof", "instanceof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw", "new", "extends"]);
const MAX_SCAN_STATES = 16;
const MAX_SCAN_FRAMES = 16;
const CODE_STATE: ScanState = { mode: "code", interpolated: false, frames: [], skip: 0 };

function slashReading(script: string, at: number): "regex" | "division" | "either" {
  let end = at - 1;
  while (end >= 0 && /\s/.test(script[end])) end--;
  if (end < 0) return "regex";
  const last = script[end];
  if (/[\w$]/.test(last)) {
    let start = end;
    while (start > 0 && /[\w$]/.test(script[start - 1])) start--;
    const word = script.slice(start, end + 1);
    return !/^\d/.test(word) && NODE_KEYWORDS_BEFORE_REGEX.has(word) && script[start - 1] !== "." ? "either" : "division";
  }
  if ("'\"`".includes(last)) return "division";
  if (")]}/".includes(last) || (last === "+" || last === "-") && script[end - 1] === last) return "either";
  return "regex";
}

function pythonInterpolated(script: string, quote: number): boolean {
  let start = quote;
  while (start > quote - 2 && start > 0 && /[A-Za-z]/.test(script[start - 1])) start--;
  return !(start > 0 && /\w/.test(script[start - 1])) && /[ft]/i.test(script.slice(start, quote));
}

function scanStep(state: ScanState, script: string, i: number, language: ScriptLanguage, slash: () => ReturnType<typeof slashReading>): ScanState[] {
  if (state.skip) return [{ ...state, skip: state.skip - 1 }];
  const ch = script[i], next = script[i + 1];
  const to = (mode: ScanMode, skip = 0, interpolated = false): ScanState => ({ mode, interpolated, frames: state.frames, skip });
  const open = (skip: number): ScanState => ({ mode: "code", interpolated: false, frames: [...state.frames, { mode: state.mode, interpolated: state.interpolated, depth: 0 }], skip });
  switch (state.mode) {
    case "code": {
      if (ch === "#" && (language !== "node" || i === 0 && next === "!")) return [to("line")];
      if (language !== "python" && ch === "/" && next === "/") return [to("line")];
      if (language !== "python" && ch === "/" && next === "*") return [to("block", 1)];
      if (ch === "'" || ch === '"') {
        const interpolated = language === "python" && pythonInterpolated(script, i);
        if (language === "python" && script[i + 1] === ch && script[i + 2] === ch) return [to(ch === "'" ? "'''" : '"""', 2, interpolated)];
        return [to(ch, 0, interpolated)];
      }
      if (ch === "`" && language !== "python") return [to("`", 0, language === "node")];
      if (ch === "/" && language === "node") {
        const reading = slash();
        return reading === "regex" ? [to("regex")] : reading === "either" ? [to("regex"), state] : [state];
      }
      const top = state.frames[state.frames.length - 1];
      if (top && ch === "{") return [{ ...state, frames: [...state.frames.slice(0, -1), { ...top, depth: top.depth + 1 }] }];
      if (top && ch === "}") return [top.depth ? { ...state, frames: [...state.frames.slice(0, -1), { ...top, depth: top.depth - 1 }] }
        : { mode: top.mode, interpolated: top.interpolated, frames: state.frames.slice(0, -1), skip: 0 }];
      return [state];
    }
    case "'": case '"': case "`": case "'''": case '"""': {
      if (ch === "\\") return [{ ...state, skip: 1 }];
      if (state.mode.length === 3 ? script.startsWith(state.mode, i) : ch === state.mode) return [to("code", state.mode.length - 1)];
      if (ch === "\n" && state.mode.length === 1 && state.mode !== "`" && language !== "shell") return [to("code")];
      if (!state.interpolated) return [state];
      if (state.mode === "`") return ch === "$" && next === "{" ? [open(1)] : [state];
      if (ch === "{") return next === "{" ? [{ ...state, skip: 1 }] : [open(0)];
      return [state];
    }
    case "line": return [ch === "\n" ? to("code") : state];
    case "block": return [ch === "*" && next === "/" ? to("code", 1) : state];
    case "regex": return ch === "\\" ? [{ ...state, skip: 1 }] : ch === "[" ? [to("class")] : ch === "/" ? [to("code")] : ch === "\n" ? [] : [state];
    case "class": return ch === "\\" ? [{ ...state, skip: 1 }] : ch === "]" ? [to("regex")] : ch === "\n" ? [] : [state];
  }
}

const scanKey = (state: ScanState): string => `${state.mode}${state.interpolated ? "i" : ""}${state.skip}${state.frames.map(frame => `/${frame.mode}${frame.interpolated ? "i" : ""}${frame.depth}`).join("")}`;

function executablePositions(script: string, language: ScriptLanguage): (position: number) => boolean {
  let states: ScanState[] = [CODE_STATE], i = 0, everything = false;
  return position => {
    for (; i < position && !everything; i++) {
      let slash: ReturnType<typeof slashReading> | undefined;
      const reading = () => slash ??= slashReading(script, i);
      const stepped = states.flatMap(state => scanStep(state, script, i, language, reading));
      const seen = new Set<string>();
      states = stepped.length === 1 ? stepped : stepped.filter(state => { const key = scanKey(state); return !seen.has(key) && !!seen.add(key); });
      if (!states.length) states = [CODE_STATE];
      everything = states.length > MAX_SCAN_STATES || states.some(state => state.frames.length > MAX_SCAN_FRAMES);
    }
    return everything || states.some(state => state.mode === "code" && !state.skip);
  };
}

const CONTROL_SCAN_LIMIT = 20_000;

function stdinBodies(segment: ShellSegment): { body: string; expands: boolean }[] {
  if (segment.heredocs.length) return segment.heredocs.map(doc => ({ body: doc.body, expands: !doc.literal }));
  return segment.operators.filter(i => segment.words[i] === "<<<" && i + 1 < segment.words.length).map(i => ({ body: segment.words[i + 1], expands: true }));
}

function pathListItems(segment: ShellSegment, word: string): string[] {
  return [...new Set([...segment.listItems.get(word) ?? [], word])];
}

type FolderControlKind = Extract<ControlRefusalKind, `folder-${string}`>;
interface FolderControl { readonly kind: FolderControlKind; readonly path: string }

function containsControlLocation(path: string, configDir: string): FolderControl | undefined {
  const canonical = canonicalPlacement(path);
  if (canonical === UNREADABLE_REAL_PATH) return { kind: "folder-unreadable", path: "." };
  if (!canonical) return undefined;
  try { if (!statSync(canonical).isDirectory()) return undefined; }
  catch (error) { return ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "") ? undefined : { kind: "folder-unreadable", path: "." }; }
  if (normalizedPath(path, process.platform).replace(/\/$/, "").split("/").pop() === ".claude") return { kind: "folder-control-dir", path: "." };
  const context = controlFileContext(configDir);
  if (context.unknown) return { kind: "folder-unknown", path: "." };
  const target = normalizedPath(canonical, process.platform).replace(/\/$/, "");
  const [present] = context.roots.filter(root => root.present && (root.path === target || root.path.startsWith(target + "/")));
  if (present) {
    const shown = canonicalPlacement(present.requested);
    const inner = typeof shown === "string" ? relativePath(canonical, shown).replace(/\\/g, "/") : "";
    const below = inner !== "" && !inner.startsWith("..") && !isAbsolute(inner);
    return { kind: present.directory ? "folder-control-dir" : "folder-control-file", path: below ? inner : "." };
  }
  const pending = [{ directory: canonical, relative: "" }], visited = new Set<string>();
  const below = (relative: string, name: string) => relative ? `${relative}/${name}` : name;
  let entriesSeen = 0;
  while (pending.length) {
    const { directory, relative } = pending.pop()!;
    const real = canonicalPlacement(directory);
    if (real === UNREADABLE_REAL_PATH) return { kind: "folder-unreadable", path: relative || "." };
    if (!real || visited.has(real)) continue;
    visited.add(real);
    if (normalizedPath(real, process.platform).split("/").pop() === ".claude") return { kind: "folder-control-dir", path: relative || "." };
    let entries: fs.Dirent[];
    try { entries = readdirSync(real, { withFileTypes: true }); } catch { return { kind: "folder-unreadable", path: relative || "." }; }
    for (const entry of entries) {
      if (++entriesSeen > CONTROL_SCAN_LIMIT) return { kind: "folder-scan-limit", path: "." };
      const name = foldsCase(process.platform) ? entry.name.toLowerCase() : entry.name;
      const childRelative = below(relative, entry.name);
      if ([".claude", ...(foldsCase(process.platform) ? CONTROL_FILE_NAMES_FOLDED : CONTROL_FILE_NAMES)].includes(name)) {
        return { kind: name === ".claude" ? "folder-control-dir" : "folder-control-file", path: childRelative };
      }
      const child = join(real, entry.name);
      let isDirectory: boolean;
      try { isDirectory = entry.isDirectory() || entry.isSymbolicLink() && statSync(child).isDirectory(); } catch { return { kind: "folder-unreadable", path: childRelative }; }
      if (isDirectory) pending.push({ directory: child, relative: childRelative });
    }
  }
  return undefined;
}


const GLOB_CHARACTERS = /[*?[\]{}]/;
function globCouldMatch(pattern: string, name: string, platform: NodeJS.Platform): boolean {
  let expression = "", braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") expression += ".*";
    else if (char === "?") expression += ".";
    else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) return true;
      expression += "[" + pattern.slice(i + 1, end).replace(/^!/, "^") + "]";
      i = end;
    } else if (char === "{") { expression += "(?:"; braces++; }
    else if (char === "}" && braces) { expression += ")"; braces--; }
    else if (char === "," && braces) expression += "|";
    else expression += escape(char);
  }
  try { return new RegExp("^" + expression + "$", foldsCase(platform) ? "i" : "").test(name); }
  catch { return true; }
}

function expandedCopySources(sources: readonly string[], cwd: string): string[] | undefined {
  try {
    return sources.flatMap(source => {
      if (!GLOB_CHARACTERS.test(source)) return [source];
      const pattern = expandHomePath(fileSystemWord(source)).replace(/\\/g, "/");
      if (typeof fs.globSync === "function") return fs.globSync(pattern, { cwd });
      const parent = dirname(pattern), name = basename(pattern);
      try { return readdirSync(resolve(cwd, parent)).filter(entry => globCouldMatch(name, entry, process.platform)).map(entry => join(parent, entry)); }
      catch (error) { if (ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
    });
  } catch { return undefined; }
}

function directoryOrUnknown(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return true; }
}

function overlapsControlLocation(path: string, configDir: string): boolean {
  const context = controlFileContext(configDir);
  if (isControlFile(path, configDir, process.platform, context)) return true;
  const canonical = canonicalPlacement(path);
  if (canonical === UNREADABLE_REAL_PATH) return true;
  if (canonical) {
    const target = normalizedPath(canonical, process.platform).replace(/\/$/, "");
    if (context.roots.some(root => root.path === target || root.present && root.path.startsWith(target + "/"))) return true;
  }
  return !!containsControlLocation(path, configDir);
}

function recursiveCopyControls(source: string, destination: string, configDir: string): boolean {
  const pending = [{ source, destination, ancestors: new Set<string>() }];
  let visited = 0;
  const context = controlFileContext(configDir);
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > CONTROL_SCAN_LIMIT || isControlFile(item.destination, configDir, process.platform, context)) return true;
    const canonical = canonicalPlacement(item.source);
    if (canonical === UNREADABLE_REAL_PATH) return true;
    if (!canonical) continue;
    try {
      if (!statSync(canonical).isDirectory()) continue;
      if (item.ancestors.has(canonical)) return true;
      const ancestors = new Set([...item.ancestors, canonical]);
      for (const entry of readdirSync(canonical)) pending.push({ source: join(canonical, entry), destination: join(item.destination, entry), ancestors });
    } catch (error) { if (!ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "")) return true; }
  }
  return false;
}

const CONTROL_PATHSPECS = [...CONTROL_FILE_NAMES.map(name => `**/${name}`), "**/.claude", "**/.claude/settings*.json", "**/.claude/rules/**", "**/.claude/hooks/**", "**/.claude/projects/*/memory/**"]
  .map(path => (foldsCase(process.platform) ? ":(top,glob,icase)" : ":(top,glob)") + path);

type GitCache = Map<string, ControlRefusal | false>;

const GIT_INERT_CONFIG: readonly (readonly [string, string])[] = [["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"]];
const GIT_INERT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
const GIT_FILTER_DRIVER_KEY = /^filter\.(.+)\.(clean|process)$/;
const GIT_GITLINK_ENTRY = /^160000 [0-9a-f]+ \d\t([\s\S]+)$/;
const GIT_READ_OPTIONS: ExecFileSyncOptionsWithStringEncoding = { shell: false, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
const gitEnvByJudgement = new WeakMap<GitCache, Map<string, NodeJS.ProcessEnv>>();

export function gitInertEnv(filterDrivers: Iterable<string> = []): NodeJS.ProcessEnv {
  const entries = [...GIT_INERT_CONFIG, ...[...new Set(filterDrivers)].flatMap(driver =>
    [[`filter.${driver}.clean`, ""], [`filter.${driver}.process`, ""], [`filter.${driver}.required`, "false"]] as const)];
  const start = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_INERT_ENV, GIT_CONFIG_COUNT: String(start + entries.length) };
  entries.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${start + i}`] = key; env[`GIT_CONFIG_VALUE_${start + i}`] = value; });
  return env;
}

function repositoryGitEnv(cwd: string, cache: GitCache): NodeJS.ProcessEnv {
  let envs = gitEnvByJudgement.get(cache);
  if (!envs) gitEnvByJudgement.set(cache, envs = new Map());
  const cached = envs.get(cwd);
  if (cached) return cached;
  const keys = spawnSync("git", ["config", "-z", "--name-only", "--get-regexp", GIT_FILTER_DRIVER_KEY.source], { ...GIT_READ_OPTIONS, cwd, env: gitInertEnv() });
  if (keys.error || (keys.status !== 0 && keys.status !== 1)) throw keys.error ?? Error(String(keys.stderr));
  const env = gitInertEnv(String(keys.stdout).split("\0").flatMap(key => GIT_FILTER_DRIVER_KEY.exec(key)?.[1] ?? []));
  envs.set(cwd, env);
  return env;
}

function gitReader(cwd: string, cache: GitCache): (args: string[]) => string {
  return args => execFileSync("git", args.map(fileSystemWord), { ...GIT_READ_OPTIONS, cwd, env: repositoryGitEnv(cwd, cache) });
}

function gitControlPaths(cwd: string, paths: readonly string[], configDir: string, cache: GitCache, target?: string, stash = false): ControlRefusal | false {
  const key = JSON.stringify([cwd, paths, target, stash]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const read = gitReader(cwd, cache);
  let blocked: ControlRefusal | false;
  try {
    const tree = read(["rev-parse", "--show-toplevel"]).trim();
    const specs = paths.length ? [...paths] : CONTROL_PATHSPECS;
    const status = !stash && (target === undefined || read(["rev-parse", "--verify", "--end-of-options", target + "^{commit}"]).trim() === read(["rev-parse", "--verify", "HEAD"]).trim());
    let listed: string;
    if (stash) {
      const args = ["stash", "show", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"];
      try { listed = read([...args, "--include-untracked", target ?? "stash@{0}"]); }
      catch { listed = read([...args, target ?? "stash@{0}"]); }
    } else listed = status
      ? read(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty", "--", ...specs])
      : read(["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=none", "-z", "HEAD", target!, "--", ...specs]);
    const entries = listed.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      files.push(status ? entries[i].slice(3) : entries[i]);
      if (status && /^[RC]|^.[RC]/.test(entries[i]) && entries[i + 1]) files.push(entries[++i]);
    }
    if (status) for (const entry of read(["ls-files", "-s", "-z", "--full-name", "--", ...specs]).split("\0")) {
      const gitlink = GIT_GITLINK_ENTRY.exec(entry);
      if (gitlink) files.push(gitlink[1]);
    }
    const file = files.find(file => isControlPath(resolve(tree, file), configDir));
    blocked = file === undefined ? false : { kind: "git-control-paths", file };
  } catch (error) {
    blocked = stash || target !== undefined || !/not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? "")) ? { kind: "git-unlisted" } : false;
  }
  cache.set(key, blocked);
  return blocked;
}

function gitListedControls(cwd: string, paths: readonly string[], configDir: string, cache: GitCache, options: readonly string[] = []): ControlRefusal | false {
  const args = ["ls-files", "-z", ...options, "--", ...paths];
  const key = JSON.stringify([cwd, args]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let blocked: ControlRefusal | false;
  try {
    const listed = gitReader(cwd, cache)(args);
    const file = listed.split("\0").filter(Boolean).find(file => !file.endsWith("/") && isControlPath(resolve(cwd, file), configDir));
    blocked = file === undefined ? false : { kind: "git-control-paths", file };
  } catch (error) { blocked = /not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? "")) ? false : { kind: "git-unlisted" }; }
  cache.set(key, blocked);
  return blocked;
}

const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "grep", "blame", "describe", "shortlog", "rev-list", "whatchanged", "version", "help"]);
const GIT_READ_ONLY_GLOBALS = new Set(["-C", "--git-dir", "--work-tree", "--no-pager", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);
const STASH_ROUND_TRIP_GIT = new Set(["stash", ...GIT_READ_ONLY]);
const STASH_ROUND_TRIP_ACTIONS = new Set(["push", "save", "pop", "apply", "list", "show", "drop"]);
const SCRIPT_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const STDIN_SHELLS = new Set([...SCRIPT_SHELLS, "cmd", ...POWERSHELL_PROGRAMS]);
const POWERSHELL_SCRIPT_RUNNERS = new Set(["invoke-expression"]);
const SCRIPT_RUNNERS = new Set([...POWERSHELL_SCRIPT_RUNNERS, "eval", "trap"]);
const OPAQUE_RUNNERS = new Set([...STDIN_SHELLS, ...SCRIPT_RUNNERS, "source", ".", "xargs", "parallel", "find",
  "alias", "function", "start-process"]);
const SHELL_SCRIPT_VALUE_OPTIONS = new Set(["--rcfile", "--init-file"]);
const SHELL_CLUSTER_VALUE_OPTION = /^[-+][a-zA-Z]*[oO]$/;
const STDIN_SCRIPT_PATHS = new Set(["/dev/stdin", "/proc/self/fd/0", "/dev/fd/0"]);
const POWERSHELL_VALUE_PARAMETERS: readonly (readonly string[])[] = [["file", "f"], ["command", "c"], ["encodedcommand", "e", "ec"], ["executionpolicy", "ep", "ex"],
  ["workingdirectory", "wd"], ["windowstyle", "w"], ["configurationname", "config"], ["outputformat", "o", "of"], ["inputformat", "if", "in"], ["settingsfile", "settings"],
  ["custompipename"], ["version", "v"], ["encodedarguments", "ea"], ["psconsolefile"]];
const LOOP_HEADERS = new Set(["for", "while", "until"]);
const STASH_ROUND_TRIP_UNCLASSIFIED = /--autostash|reflog|update-ref|--config-env|--git-dir|--work-tree|--namespace|GIT_[A-Z_]+/i;
const STASH_PUSH_PROVABLE_FLAGS = new Set(["-q", "--quiet", "-u", "--include-untracked", "-k", "--keep-index", "--no-keep-index"]);
const GIT_WORD = /(?:^|[\s'"(;&|])git(?:\.exe)?(?:[\s'")]|$)/i;
const CONTROL_WORD = /\.claude|claude(?:\.local)?\.md|agents\.md/i;
const SUBSTITUTION_OPENER = /\$\(|`|<\(|>\(/;
const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

function opaqueRisk(text: string): boolean {
  return GIT_WORD.test(text) || CONTROL_WORD.test(text) || SUBSTITUTION_OPENER.test(text);
}

function parenthesizedLiteral(word: string, budget: ScanBudget): string | undefined {
  let start = 0, end = word.length;
  for (;;) {
    while (start < end && /\s/.test(word[start])) start++;
    while (end > start && /\s/.test(word[end - 1])) end--;
    if (end - start < 2 || word[start] !== "(" || word[end - 1] !== ")") break;
    start++; end--;
  }
  if (start === 0) return undefined;
  const syntax = shellSyntax(word.slice(start, end), "powershell", budget);
  const [segment] = syntax.segments;
  return syntax.balanced && syntax.segments.length === 1 && segment.words.length === 1
    && !segment.substitutions.length && !segment.blocks.length && !segment.operators.length ? stringLiteral(segment, 0) : undefined;
}

function joinPathWord(word: string, budget: ScanBudget): string | undefined {
  const inner = /^\s*\(([\s\S]*)\)\s*$/.exec(word)?.[1];
  if (inner === undefined) return undefined;
  const syntax = shellSyntax(inner, "powershell", budget);
  const [segment] = syntax.segments;
  if (!syntax.balanced || syntax.segments.length !== 1 || segment.words[0]?.toLowerCase() !== "join-path"
    || segment.blocks.length || segment.operators.length) return undefined;
  const args = segment.words.slice(1).map(arg => parenthesizedLiteral(arg, budget) ?? /^\(\s*(\$(?:env:)?[A-Za-z_]\w*)\s*\)$/i.exec(arg)?.[1] ?? arg);
  if (args.some(arg => arg.startsWith("(") || arg.includes("$("))) return undefined;
  const parsed = powershellArguments("join-path", args);
  if (parsed.uncertain) return undefined;
  const positional = [...parsed.positional];
  const parent = parsed.named.get("-path") ?? positional.shift();
  const child = parsed.named.get("-childpath") ?? positional.shift();
  const extra = parsed.named.get("-additionalchildpath");
  const parts = [parent, child, ...(extra === undefined ? [] : [extra]), ...positional];
  return parts.every((part): part is string => part !== undefined) ? parts.join("/") : undefined;
}

function segmentText(segment: ShellSegment): string {
  return [...segment.words, ...segment.substitutions, ...segment.blocks.map(block => block.body), ...segment.heredocs.map(doc => doc.body)].join(" ");
}

const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const ARGUMENT_RUNNERS = new Set(["xargs", "find"]);

function posixQuoted(word: string): string {
  return "'" + word.replace(/'/g, "'\\''") + "'";
}

const XARGS_VALUE_FLAGS = "InPEdaLs";
const XARGS_ATTACHED_FLAGS = "iel";
const XARGS_VALUE_OPTIONS = new Set(["--max-args", "--max-procs", "--delimiter", "--arg-file", "--max-chars", "--process-slot-var"]);
const XARGS_LONG_OPTIONS = [...XARGS_VALUE_OPTIONS, "--null", "--eof", "--replace", "--max-lines", "--interactive", "--verbose", "--exit", "--no-run-if-empty",
  "--show-limits", "--open-tty", "--help", "--version"];
const FIND_NAME_TESTS = new Set(["-name", "-iname"]);
const FIND_PATH_TESTS = new Set(["-path", "-ipath", "-wholename", "-iwholename"]);
const FIND_OUTPUT_ACTIONS = /^-f(?:print0?|printf|ls)$/;

function xargsLongOption(word: string): string | undefined {
  const matches = XARGS_LONG_OPTIONS.filter(option => option.startsWith(word));
  return matches.includes(word) ? word : matches.length === 1 ? matches[0] : undefined;
}

const PIPED_INPUT = "$(piped input)";
const DOTNET_FILE_CALLEE = /\[(?:System\.)?IO\.(?:File|Directory)\]::(\w+)(?:\.Invoke)?$/i;
const DOTNET_READ_METHOD = /^(?:read|get|exists|enumerate|open(?:read|text)$)/i;
const DOTNET_OPEN_METHOD = /^open(?:handle)?$/i;
const DOTNET_FILE_ENUM = /^\[(?:System\.)?IO\.File(?:Mode|Access)\]::(\w+)$/i;
const POWERSHELL_VARIABLE_REFERENCE = /^\$(?:\{[^}]*\}|(?:env:)?[A-Za-z_]\w*)$/i;

interface DotnetArgument { readonly raw: string; readonly literal?: string; readonly word?: string }

function dotnetArgument(raw: string, budget: ScanBudget): DotnetArgument {
  const syntax = shellSyntax(raw, "powershell", budget);
  const [segment] = syntax.segments;
  if (!syntax.balanced || syntax.segments.length !== 1 || segment.words.length !== 1 || segment.operators.length || segment.blocks.length) return { raw };
  const word = segment.words[0], literal = stringLiteral(segment, 0);
  if (literal !== undefined) return { raw, literal, word };
  const parenthesized = segment.substitutions.length === 1 && word.startsWith("(") && word.endsWith(")");
  return !segment.quoted.length && (POWERSHELL_VARIABLE_REFERENCE.test(word) || parenthesized) ? { raw, word } : { raw };
}

const dotnetEnumName = (argument: DotnetArgument | undefined): string | undefined =>
  (argument?.literal ?? (argument && DOTNET_FILE_ENUM.exec(argument.raw)?.[1]))?.trim().toLowerCase();

function opensForReading(args: readonly DotnetArgument[]): boolean {
  const mode = dotnetEnumName(args[1]);
  return dotnetEnumName(args[2]) === "read" && mode !== undefined && mode !== "openorcreate";
}

function expressionStrings(text: string, budget: ScanBudget, depth = 0): string[] {
  if (depth > MAX_SCRIPT_NESTING) return [];
  return shellSyntax(text, "powershell", budget).segments.flatMap(segment => [...[...segment.stringParts.values()].flat().map(part => part.text),
    ...[...segment.substitutions, ...segment.blocks.map(block => block.body)].flatMap(inner => expressionStrings(inner, budget, depth + 1))]);
}

interface XargsInvocation { readonly start: number; readonly replacement?: string }

function xargsInvocation(words: readonly string[], from: number): XargsInvocation {
  let i = from, replacement: string | undefined;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") return { start: i + 1, replacement };
    if (!word.startsWith("-") || word === "-") return { start: i, replacement };
    if (word.startsWith("--")) {
      const equals = word.indexOf("="), name = xargsLongOption(equals < 0 ? word : word.slice(0, equals));
      if (name === "--replace") replacement = equals < 0 ? "{}" : word.slice(equals + 1);
      i += equals < 0 && XARGS_VALUE_OPTIONS.has(name ?? "") ? 2 : 1;
      continue;
    }
    let next = i + 1;
    for (let k = 1; k < word.length; k++) {
      if (word[k] === "i") { replacement = word.slice(k + 1) || "{}"; break; }
      if (word[k] === "I") { replacement = word.slice(k + 1) || words[i + 1]; if (k === word.length - 1) next++; break; }
      if (XARGS_ATTACHED_FLAGS.includes(word[k])) break;
      if (XARGS_VALUE_FLAGS.includes(word[k])) { if (k === word.length - 1) next++; break; }
    }
    i = next;
  }
  return { start: i, replacement };
}

function findStartIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length && /^-(?:[HLP]|D|O\d*)$/.test(args[i])) i += args[i] === "-D" ? 2 : 1;
  return i;
}

interface FindMatch { readonly names: readonly string[]; readonly paths: readonly string[] }
interface FindBranches { readonly match?: FindMatch; readonly action: boolean }

const FIND_NOTHING: FindMatch = { names: [], paths: [] };

function findClose(tokens: readonly string[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")" && --depth === 0) return i;
  }
  return tokens.length;
}

function findConjunction(tokens: readonly string[]): FindBranches & { readonly pruned: boolean } {
  const factors: (FindMatch | undefined)[] = [];
  let action = false, pruned = false, negate = false, empty = false, directories = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "!" || token === "-not") { negate = !negate; continue; }
    if (token === "(") {
      const close = findClose(tokens, i);
      const inner = findDisjunction(tokens.slice(i + 1, close), false);
      action ||= inner.action;
      if (!negate) factors.push(inner.match);
      i = close; negate = false; continue;
    }
    if (FIND_EXEC_ACTIONS.has(token)) {
      action = true;
      while (i < tokens.length && tokens[i] !== ";" && tokens[i] !== "+") i++;
    } else if (token === "-delete") action = true;
    else if (token === "-prune") pruned ||= !negate;
    else if (token === "-empty") empty ||= !negate;
    else if (FIND_NAME_TESTS.has(token) || FIND_PATH_TESTS.has(token)) {
      const value = tokens[++i];
      if (!negate && value !== undefined) factors.push(FIND_NAME_TESTS.has(token) ? { names: [value], paths: [] } : { names: [], paths: [value] });
    } else if (token === "-type") directories ||= !negate && tokens[++i] === "d";
    else if (token.startsWith("-") && i + 1 < tokens.length && !/^[-()!,]/.test(tokens[i + 1])) i++;
    negate = false;
  }
  const match = empty && directories ? FIND_NOTHING : factors.find(factor => factor !== undefined);
  return { match, action, pruned };
}

function findDisjunction(tokens: readonly string[], actionsOnly: boolean): FindBranches {
  const branches: (readonly string[])[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")") depth--;
    else if (FIND_EXEC_ACTIONS.has(tokens[i])) { while (i < tokens.length && tokens[i] !== ";" && tokens[i] !== "+") i++; }
    else if (depth === 0 && ["-o", "-or", ","].includes(tokens[i])) { branches.push(tokens.slice(start, i)); start = i + 1; }
  }
  branches.push(tokens.slice(start));
  const names: string[] = [], paths: string[] = [];
  let action = false, unconstrained = false;
  for (const branch of branches) {
    const result = findConjunction(branch);
    action ||= result.action;
    if (actionsOnly && !result.action || result.pruned && !result.action) continue;
    if (!result.match) unconstrained = true;
    else { names.push(...result.match.names); paths.push(...result.match.paths); }
  }
  return { match: unconstrained ? undefined : { names, paths }, action };
}

function findTouchedPaths(args: readonly string[]): string[] {
  const first = findStartIndex(args);
  let end = first;
  while (end < args.length && !/^[-(!,]/.test(args[end])) end++;
  const starts = end > first ? args.slice(first, end).map(start => start.replace(/[\\/]+$/, "") || "/") : ["."];
  const { match } = findDisjunction(args.slice(end), true);
  if (!match) return starts.map(start => `${start}/**`);
  return [...match.paths, ...starts.flatMap(start => match.names.flatMap(name => [`${start}/${name}`, `${start}/**/${name}`]))];
}

function runnerCommands(program: string, words: readonly string[]): (readonly [number, number])[] {
  return program === "xargs" ? [[xargsInvocation(words, 1).start, words.length]] : runnerArguments(program, words, 0);
}

const SHELL_EXPANSION = /"?(?<!\\)\$(?:\{[^}]*\}|[A-Za-z_]\w*|[#@*?!$0-9-])"?/g;
const POSITIONAL_REFERENCE =/(?<!\\)\$(?:\{([0-9@*])\}|([0-9@*]))/g;
const UNRESOLVED_POSITIONAL = /(?<!\\)\$(?:#|\{[#!]|\{(?:[0-9@*][^}]+|\d{2,})\})|(?<![\w-])(?:shift|getopts)(?![\w-])|(?<![\w-])set\s+--|(?<![\w-])for\s+\w+\s*(?:;|\n|$|do(?![\w-]))|(?<![\w-])for\s+\w+\s+in\s+"?\$\{?[@*]|\w+=["']?\$\{?[0-9@*]/;

interface PositionalScript { readonly script: string; readonly unresolved: boolean }

function substitutePositional(script: string, values: readonly string[]): PositionalScript {
  if (!values.length) return { script, unresolved: false };
  const unresolved = UNRESOLVED_POSITIONAL.test(script);
  const value = (key: string) => key === "@" || key === "*" ? values.slice(1).map(posixQuoted).join(" ") : posixQuoted(values[Number(key)] ?? "");
  const replace = (_: string, braced: string | undefined, bare: string | undefined) => value(braced ?? bare ?? "");
  return { script: script.replace(/"\$(?:\{([0-9@*])\}|([0-9@*]))"/g, replace).replace(POSITIONAL_REFERENCE, replace), unresolved };
}

function shellScriptArgument(args: readonly string[], run: number): number {
  let i = run + 1;
  while (i < args.length) {
    if (args[i] === "--") return i + 1;
    if (!/^[-+]./.test(args[i])) return i;
    i += SHELL_CLUSTER_VALUE_OPTION.test(args[i]) ? 2 : 1;
  }
  return i;
}

function runnerArguments(program: string, words: readonly string[], index: number): (readonly [number, number])[] {
  if (program !== "find") return [[index + 1, words.length]];
  const ranges: (readonly [number, number])[] = [];
  for (let i = index + 1; i < words.length; i++) {
    if (!FIND_EXEC_ACTIONS.has(words[i])) continue;
    let end = i + 1;
    while (end < words.length && words[end] !== ";" && words[end] !== "+") end++;
    ranges.push([i + 1, end]);
    i = end;
  }
  return ranges;
}

function powershellParameter(word: string): string | undefined {
  const name = word.replace(/^-+/, "").toLowerCase();
  return (POWERSHELL_VALUE_PARAMETERS.find(names => names.slice(1).includes(name))
    ?? POWERSHELL_VALUE_PARAMETERS.find(names => name.length > 1 && names[0].startsWith(name)))?.[0];
}

export interface ShellScriptSource { readonly stdin: boolean; readonly script?: string }

export function shellScriptSource(program: string, args: readonly string[]): ShellScriptSource {
  const operand = (word: string | undefined): ShellScriptSource => word === undefined || word === "-" || STDIN_SCRIPT_PATHS.has(word) ? { stdin: true } : { stdin: false, script: word };
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (QUERY_OPTIONS.includes(word.toLowerCase())) return { stdin: false };
    if (POWERSHELL_PROGRAMS.has(program)) {
      if (!word.startsWith("-")) return operand(word);
      const parameter = powershellParameter(word);
      if (parameter === "file") return operand(args[i + 1]);
      if (parameter === "command") return { stdin: args[i + 1] === undefined || args[i + 1] === "-" };
      if (parameter) i++;
      continue;
    }
    if (word === "--") return operand(args[i + 1]);
    if (word !== "-" && (/^[-+]/.test(word) || program === "cmd" && word.startsWith("/"))) {
      if (SCRIPT_SHELLS.has(program) && /^-[a-zA-Z]*s[a-zA-Z]*$/.test(word)) return { stdin: true };
      if (SHELL_SCRIPT_VALUE_OPTIONS.has(word) || SHELL_CLUSTER_VALUE_OPTION.test(word)) i++;
      continue;
    }
    return operand(word);
  }
  return { stdin: true };
}

interface GitInvocation {
  readonly globals: readonly { readonly name: string; readonly value?: string }[];
  readonly sub: number;
}

function gitInvocation(args: readonly string[]): GitInvocation {
  const globals: { name: string; value?: string }[] = [];
  let sub = 0;
  while (sub < args.length && args[sub].startsWith("-")) {
    const word = args[sub], equals = word.indexOf("=");
    if (GIT_VALUE_OPTIONS.has(word)) { globals.push({ name: word, value: args[sub + 1] }); sub += 2; continue; }
    if (/^-[cC]./.test(word)) { globals.push({ name: word.slice(0, 2), value: word.slice(2) }); sub++; continue; }
    globals.push(word.startsWith("--") && equals > 0 ? { name: word.slice(0, equals), value: word.slice(equals + 1) } : { name: word });
    sub++;
  }
  return { globals, sub };
}

function gitWriteOptions(sub: string | undefined, args: readonly string[]): { outputs: string[]; runsProgram: boolean } {
  const outputs: string[] = [];
  let runsProgram = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output") outputs.push(args[i + 1] ?? "");
    else if (args[i].startsWith("--output=")) outputs.push(args[i].slice("--output=".length));
    else if (args[i] === "--ext-diff" || sub === "grep" && /^(?:-O|--open-files-in-pager(?:=|$))/.test(args[i])) runsProgram = true;
  }
  return { outputs, runsProgram };
}

const GIT_CONFIG_READ_ACTIONS = new Map([["--get", [1, 2]], ["--get-all", [1, 2]], ["--get-regexp", [1, 2]], ["--list", [0, 0]], ["-l", [0, 0]]]);
const GIT_CONFIG_READ_FLAGS = new Set(["--show-origin", "--show-scope", "--global", "--system", "--local", "--worktree", "--includes", "--no-includes",
  "--null", "-z", "--name-only", "--bool", "--int", "--bool-or-int", "--path", "--expiry-date", "--no-type"]);
const GIT_CONFIG_READ_VALUE_OPTIONS = new Set(["--file", "-f", "--blob", "--type", "--default"]);

export function gitConfigReadOnly(args: readonly string[], argumentsMayFollow = false): boolean {
  const actions: string[] = [], positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i], name = word.startsWith("--") && word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (GIT_CONFIG_READ_ACTIONS.has(word)) actions.push(word);
    else if (GIT_CONFIG_READ_VALUE_OPTIONS.has(name)) { if (name === word) i++; }
    else if (word.startsWith("-")) { if (!GIT_CONFIG_READ_FLAGS.has(word)) return false; }
    else positionals.push(word);
  }
  if (actions.length > 1) return false;
  // A config key always has a section dot; the subcommand forms (`git config edit`, `set`, `unset`) do not.
  if (!actions.length) return positionals.length === 1 && positionals[0].includes(".") && !argumentsMayFollow;
  const [min, max] = GIT_CONFIG_READ_ACTIONS.get(actions[0])!;
  return positionals.length >= min && positionals.length <= max;
}

function gitReadOnly(args: readonly string[], argumentsMayFollow = false): boolean {
  const { globals, sub } = gitInvocation(args);
  if (!globals.every(option => GIT_READ_ONLY_GLOBALS.has(option.name))) return false;
  if (args[sub] === "config") return gitConfigReadOnly(args.slice(sub + 1), argumentsMayFollow);
  if (!GIT_READ_ONLY.has(args[sub])) return false;
  const writes = gitWriteOptions(args[sub], args.slice(sub + 1));
  return !writes.outputs.length && !writes.runsProgram;
}

const LITERAL_WRITERS: ReadonlySet<string> = new Set(["echo", "printf", "write-output"]);

function carriesInlineText(segment: ShellSegment, dialect: ShellDialect): boolean {
  const found = segmentProgram(segment);
  return segment.heredocs.length > 0 || segment.operators.some(i => segment.words[i] === "<<<") || segment.words.length === 1 && segment.quoted.includes(0)
    || found.index < segment.words.length && LITERAL_WRITERS.has(commandName(segment.words[found.index], dialect));
}

function pipedLiteral(segment: ShellSegment, dialect: ShellDialect): string | undefined {
  const found = segmentProgram(segment);
  const program = commandName(segment.words[found.index] ?? "", dialect);
  const args = segment.words.slice(found.index + 1);
  if (segment.operators.length || [segment.words[found.index] ?? "", ...args].some(word => /[$`]/.test(word))) return undefined;
  if (segment.words.length === 1 && segment.quoted.includes(0)) return segment.words[0];
  if (dialect === "powershell" && program === "write-output") return args.some(word => word.startsWith("-")) ? undefined : args.join("\n");
  if (program === "echo") {
    let decode = false;
    while (args.length && /^-[neE]+$/.test(args[0])) for (const flag of args.shift()!.slice(1)) if (flag !== "n") decode = flag === "e";
    return decode ? unescapeSequences(args.join(" ")) : args.join(" ");
  }
  return program === "printf" && args.length === 1 && !/%(?!%)/.test(args[0].replace(/%%/g, "")) ? unescapeSequences(args[0]).replace(/%%/g, "%") : undefined;
}

function loopHeader(segment: ShellSegment, index: number, program: number): boolean {
  const word = segment.words[index];
  if (!LOOP_HEADERS.has(word.toLowerCase()) && !(word === "select" && segment.words[index + 2] === "in" && !segment.quoted.includes(index + 2))) return false;
  return !segment.quoted.includes(index) && (index <= program || segment.commandStarts.includes(index));
}

interface LoopFrame { readonly kind: "if" | "loop"; readonly header: number; readonly variable?: string }
interface LoopPosition {
  readonly closed: boolean;
  readonly header: boolean;
  readonly inLoop: boolean;
  readonly loopsBefore: number;
  readonly ifsBefore: number;
  readonly opened: readonly LoopFrame[];
  readonly ended?: LoopFrame;
  readonly list?: number;
}

function loopTracker(dialect: ShellDialect): (segment: ShellSegment, program: number, position?: number) => LoopPosition {
  const frames: LoopFrame[] = [];
  let loops = 0, ifs = 0, headers = 0;
  const push = (frame: LoopFrame) => { frames.push(frame); if (frame.kind === "loop") loops++; else ifs++; };
  const pop = (): LoopFrame | undefined => { const frame = frames.pop(); if (frame?.kind === "loop") loops--; else if (frame) ifs--; return frame; };
  return (segment, program, position = 0) => {
    const words = segment.words, bare = (index: number) => !segment.quoted.includes(index);
    const before = { loopsBefore: loops, ifsBefore: ifs };
    if (dialect !== "posix") {
      const condition = words.some((word, i) => i < program && word.toLowerCase() === "do" && bare(i) || loopHeader(segment, i, program));
      return { closed: false, header: condition, inLoop: condition, ...before, opened: [] };
    }
    if ((words[0] === "done" || words[0] === "fi") && bare(0)) {
      const ended = pop();
      return { closed: words[0] === "done", header: false, inLoop: loops > 0, ...before, opened: [], ended };
    }
    const opened: LoopFrame[] = [];
    let list: number | undefined, headed = 0;
    for (let i = 0; i < words.length; i++) {
      if (i < program && bare(i) && words[i].toLowerCase() === "do") {
        if (headers > 0) headers--;
        else opened.push({ kind: "loop", header: position });
      } else if (i < program && bare(i) && words[i] === "if") opened.push({ kind: "if", header: position });
      else if (loopHeader(segment, i, program)) {
        const named = /^(?:for|select)$/.test(words[i]) && /^[A-Za-z_]\w*$/.test(words[i + 1] ?? "") ? words[i + 1] : undefined;
        if (named && words[i + 2] === "in" && bare(i + 2)) list = i + 3;
        opened.push({ kind: "loop", header: position, variable: named });
        headers++; headed++;
      }
    }
    for (const frame of opened) push(frame);
    return { closed: false, header: headed > 0, inLoop: loops > 0, ...before, opened, list };
  };
}
type StashTrail = { pushed: number; consumed: number; tainted: boolean };
const stashTrailsByJudgement = new WeakMap<GitCache, Map<string, StashTrail>>();

function stashAction(tail: readonly string[]): string {
  return tail[0] === undefined || tail[0].startsWith("-") ? "push" : tail[0];
}

function stashPushAll(options: readonly string[]): boolean {
  return options.some(word => /^--al?l?$/.test(word) || /^-[a-zA-Z]*a/.test(word));
}

function stashActive(cache: GitCache): boolean {
  return [...stashTrailsByJudgement.get(cache)?.values() ?? []].some(trail => trail.pushed + trail.consumed > 0 || trail.tainted);
}

function stashRoundTripClassified(command: string, syntax: ShellSyntax, dialect: ShellDialect, budget: ScanBudget, gitAllowed = true, depth = 0): boolean {
  if (depth > MAX_SCRIPT_NESTING || STASH_ROUND_TRIP_UNCLASSIFIED.test(command) || !syntax.balanced || syntax.literalBackticks) return false;
  const inner = (body: string) => stashRoundTripClassified(body, shellSyntax(body, dialect, budget), dialect, budget, false, depth + 1);
  const track = loopTracker(dialect);
  for (const segment of syntax.segments) {
    if (segment.substitutions.some(body => !inner(body)) || segment.blocks.some(block => !inner(block.body))) return false;
    const words = segment.words, found = segmentProgram(segment), index = found.index;
    if (found.unclassified) return false;
    const loop = track(segment, index);
    if (loop.closed) continue;
    const hasGit = words.some(word => GIT_WORD.test(word));
    if (hasGit && (!gitAllowed || loop.inLoop)) return false;
    if (index >= words.length || loop.header) continue;
    const program = commandName(words[index], dialect);
    if (program !== "git") {
      if (OPAQUE_RUNNERS.has(program) || hasGit) return false;
      continue;
    }
    const args = commandArguments(segment, index + 1);
    const { globals, sub } = gitInvocation(args);
    if (globals.some(option => option.name !== "-C")) return false;
    if (!STASH_ROUND_TRIP_GIT.has(args[sub])) return false;
    if (args[sub] === "stash" && !STASH_ROUND_TRIP_ACTIONS.has(stashAction(args.slice(sub + 1)))) return false;
  }
  return true;
}

function stashTrail(cwd: string, cache: GitCache): StashTrail | undefined {
  let trails = stashTrailsByJudgement.get(cache);
  if (!trails) stashTrailsByJudgement.set(cache, trails = new Map());
  let repository: string;
  try { repository = resolve(cwd, gitReader(cwd, cache)(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()); }
  catch { return undefined; }
  let trail = trails.get(repository);
  if (!trail) trails.set(repository, trail = { pushed: 0, consumed: 0, tainted: false });
  return trail;
}

function stashEntries(cwd: string, cache: GitCache): number {
  const read = gitReader(cwd, cache);
  try { read(["rev-parse", "--verify", "--quiet", "refs/stash"]); }
  catch (error) {
    if ((error as { status?: unknown }).status === 1) return 0;
    throw error;
  }
  const count = Number(read(["rev-list", "--walk-reflogs", "--count", "refs/stash"]).trim());
  if (!Number.isInteger(count) || count < 0) throw Error("unreadable stash count");
  return count;
}

const STASH_UNCLASSIFIED: ControlRefusal = { kind: "stash-unclassified" };

function stashChangesControls(cwd: string, stash: string, configDir: string, cache: GitCache, roundTrip: boolean): ControlRefusal | false {
  if (!stashActive(cache)) return gitControlPaths(cwd, [], configDir, cache, stash, true);
  const index = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(stash);
  const trail = roundTrip && index ? stashTrail(cwd, cache) : undefined;
  if (!index || !trail || trail.tainted) return STASH_UNCLASSIFIED;
  const selected = Number(index[1] ?? index[2]);
  if (selected >= trail.pushed - trail.consumed) return STASH_UNCLASSIFIED;
  try {
    const entries = stashEntries(cwd, cache);
    for (let original = Math.max(0, selected - trail.pushed); original <= selected + trail.consumed && original < entries; original++) {
      const refusal = gitControlPaths(cwd, [], configDir, cache, `stash@{${original}}`, true);
      if (refusal) return refusal;
    }
    return false;
  } catch { return STASH_UNCLASSIFIED; }
}

function stashPushPathspec(words: readonly string[]): string[] | undefined {
  const paths: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "-m" || word === "--message") { if (++i >= words.length) return undefined; continue; }
    if (/^-m./.test(word) || word.startsWith("--message=") || STASH_PUSH_PROVABLE_FLAGS.has(word)) continue;
    if (word.startsWith("-")) return undefined;
    paths.push(word);
  }
  return paths;
}

function stashPushProvable(cwd: string, tail: readonly string[], options: readonly string[], paths: readonly string[], cache: GitCache): boolean {
  const flags = options.slice(["push", "save"].includes(tail[0]) ? 1 : 0);
  if (tail[0] === "push") { if (stashPushPathspec(flags) === undefined) return false; }
  else for (let i = 0; i < flags.length; i++) {
    if (["-m", "--message"].includes(flags[i])) { i++; continue; }
    if (flags[i].startsWith("--message=") || !flags[i].startsWith("-") && tail[0] === "save") continue;
    if (!STASH_PUSH_PROVABLE_FLAGS.has(flags[i])) return false;
  }
  const untracked = flags.some(word => word === "-u" || word === "--include-untracked");
  try {
    return gitReader(cwd, cache)(["status", "--porcelain=v1", "-z", "--no-renames", untracked ? "--untracked-files=all" : "--untracked-files=no",
      "--ignore-submodules=dirty", "--", ...paths]).split("\0").some(Boolean);
  } catch { return false; }
}

function recordStashTrail(cwd: string, sub: string, tail: readonly string[], options: readonly string[], paths: readonly string[], cache: GitCache): void {
  if (sub !== "stash") return;
  const action = stashAction(tail);
  if (!["push", "save", "store", "pop", "drop", "clear", "branch"].includes(action)) return;
  const trail = stashTrail(cwd, cache);
  if (!trail) return;
  if (action === "store") trail.tainted = true;
  else if (action === "push" || action === "save") {
    if (trail.pushed + trail.consumed === 0 && !trail.tainted && stashPushProvable(cwd, tail, options, paths, cache)) trail.pushed++;
    else trail.tainted = true;
  } else trail.consumed++;
}

const PATCH_UNVERIFIED: ControlRefusal = { kind: "patch-unverified" };

function patchControls(files: readonly string[], cwd: string, configDir: string, strip = 1, directory = ""): ControlRefusal | false {
  if (!files.length) return PATCH_UNVERIFIED;
  try {
    for (const file of files) {
      const patch = readFileSync(resolve(cwd, fileSystemWord(file)), "utf8");
      let removed = 0, added = 0;
      for (const line of patch.split(/\r?\n/)) {
        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
        if (hunk) { removed = Number(hunk[1] ?? 1); added = Number(hunk[2] ?? 1); continue; }
        if (removed > 0 || added > 0) {
          if (line.startsWith("-") || line.startsWith(" ")) removed--;
          if (line.startsWith("+") || line.startsWith(" ")) added--;
          continue;
        }
        const header = /^(?:---|\+\+\+) (.+?)(?:\t.*)?$/.exec(line);
        const rename = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
        const binary = /^diff --git (".*?"|a\/.*?) (".*?"|b\/.*)$/.exec(line);
        for (let name of header ? [header[1]] : rename ? [rename[1]] : binary ? [binary[1], binary[2]] : []) {
          if (name.startsWith('"')) name = JSON.parse(name);
          if (name === "/dev/null") continue;
          name = name.split("/").slice(rename ? 0 : strip).join("/");
          if (isControlPath(resolve(cwd, directory, name), configDir)) return { kind: "patch-control", file: name };
        }
      }
    }
    return false;
  } catch { return PATCH_UNVERIFIED; }
}

type ShellWriteKind = ProtectedKind | "control" | undefined;

interface ShellJudgement {
  readonly gitCache: GitCache;
  readonly written: Set<string>;
  readonly memo: Map<string, ShellWriteKind>;
  readonly budget: ScanBudget;
  readonly calling: Set<string>;
  readonly names: Map<string, readonly string[] | null>;
  readonly callBudget: ScanBudget;
  readonly expansion: ScanBudget;
  refusal?: ControlRefusal;
}

const UNREADABLE_COMMAND: ControlRefusal = { kind: "unreadable-command" };
const GIT_CONFIG: ControlRefusal = { kind: "git-config" };
const STASH_IGNORED: ControlRefusal = { kind: "stash-ignored" };

function refuse(judgement: ShellJudgement, refusal: ControlRefusal): "control" {
  judgement.refusal = refusal;
  return "control";
}

function redirectPositions(segment: Pick<ShellSegment, "words" | "operators">): Set<number> {
  const redirection = new Set<number>();
  for (const i of segment.operators) {
    redirection.add(i);
    if (!isFdDuplication(segment.words[i])) redirection.add(i + 1);
  }
  return redirection;
}

function commandArguments(segment: ShellSegment, from: number): string[] {
  const redirection = redirectPositions(segment);
  return segment.words.slice(from).filter((_, i) => !redirection.has(from + i));
}

export const KNOWN_ENVIRONMENT: readonly string[] = ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "TMPDIR"];

interface ShellFunction { readonly body: string; readonly dialect: ShellDialect }
interface ShellScope {
  readonly parent?: ShellScope;
  readonly id: number;
  readonly values: Map<string, string | null>;
  readonly functions: Map<string, ShellFunction>;
  readonly aliases: Map<string, string>;
  functionsVersion: number;
  opaque: boolean;
}

let scopeIds = 0;
function childScope(parent?: ShellScope): ShellScope {
  return { parent, id: ++scopeIds, values: new Map(), functions: new Map(), aliases: new Map(), functionsVersion: 0, opaque: false };
}

function scopeEntry<T>(scope: ShellScope | undefined, pick: (scope: ShellScope) => Map<string, T>, key: string): T | null | undefined {
  for (let current = scope; current; current = current.parent) {
    const map = pick(current);
    if (map.has(key)) return map.get(key)!;
    if (current.opaque && current.values === map) return null;
  }
  return undefined;
}

function setVariable(scope: ShellScope, key: string, value: string | null): void {
  scope.values.set(key, value);
}

function setPosixVariable(scope: ShellScope, name: string, value: string | null, exported = false): void {
  setVariable(scope, name, value);
  if (exported) setVariable(scope, exportedKey(name), value);
}

function defineFunction(scope: ShellScope, name: string, body: ShellFunction): void {
  scope.functions.set(name, body);
  scope.functionsVersion++;
}

function defineAlias(scope: ShellScope, name: string, target: string): void {
  scope.aliases.set(name, target);
  scope.functionsVersion++;
}

function makeOpaque(scope: ShellScope): void {
  scope.values.clear();
  scope.opaque = true;
}

const powershellKey = (name: string) => "$" + name.toLowerCase();
const exportedKey = (name: string) => "env:" + name;
const environmentKey = (name: string) => exportedKey(process.platform === "win32" ? name.toUpperCase() : name);
const dialectKeys = (name: string, dialect: ShellDialect): string[] =>
  dialect === "posix" ? [name, exportedKey(name)] : dialect === "powershell" ? [powershellKey(name), environmentKey(name)] : [environmentKey(name)];
const variableKeys = (name: string) => [...new Set([...dialectKeys(name, "posix"), ...dialectKeys(name, "powershell")])];

function poisonVariables(scope: ShellScope, names: Iterable<string>, dialect: ShellDialect): void {
  for (const name of names) for (const key of dialectKeys(name, dialect)) setVariable(scope, key, null);
}

const REFERENCED_NAME = /\$\{?(?:env:)?([A-Za-z_]\w*)|%([A-Za-z_]\w*)%|(~)|(mktemp)/gi;

function scopeFingerprint(scope: ShellScope, text: string): string {
  const names = new Set<string>();
  for (const match of text.matchAll(REFERENCED_NAME)) names.add(match[1] ?? match[2] ?? (match[3] ? "HOME" : "TMPDIR"));
  const values = [...names].sort().map(name => variableKeys(name).map(key => scopeEntry(scope, current => current.values, key) ?? 0));
  const functions: string[] = [];
  for (let current: ShellScope | undefined = scope; current; current = current.parent) if (current.functions.size || current.aliases.size) functions.push(`${current.id}:${current.functionsVersion}`);
  return JSON.stringify([[...names].sort(), values, functions]);
}

function knownEnvironment(name: string, dialect: ShellDialect): string | undefined {
  const known = KNOWN_ENVIRONMENT.find(entry => dialect === "posix" || process.platform !== "win32" ? entry === name : entry === name.toUpperCase());
  if (known === undefined) return undefined;
  if (known === "HOME" && dialect === "posix") return homedir();
  return process.env[known] || (known === "TMPDIR" && dialect === "posix" && process.platform === "win32" ? tmpdir() : undefined);
}

function assignedEnvironment(scope: ShellScope | undefined, name: string, dialect: ShellDialect): string | null | undefined {
  for (const key of dialect === "posix" ? dialectKeys(name, dialect) : [environmentKey(name)]) {
    const assigned = scopeEntry(scope, current => current.values, key);
    if (assigned !== undefined) return assigned;
  }
  return undefined;
}

function environmentValue(scope: ShellScope | undefined, name: string, dialect: ShellDialect): string | null {
  const assigned = assignedEnvironment(scope, name, dialect);
  return assigned !== undefined ? assigned : knownEnvironment(name, dialect) ?? null;
}

function homeDirectory(scope: ShellScope | undefined, dialect: ShellDialect): string | null {
  return dialect === "posix" ? environmentValue(scope, "HOME", dialect) : knownEnvironment("HOME", "posix")!;
}

const VARIABLE_SYNTAX: Readonly<Record<ShellDialect, RegExp>> = {
  posix: /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*):-([^${}`]*)\}|\$\(\s*mktemp((?:\s+[^\s()$`;&|<>'"\\]+)*)\s*\)|`\s*mktemp((?:\s+[^\s()$`;&|<>'"\\]+)*)\s*`|(^~)(?=[/\\]|$)|\$\(\s*cygpath((?:\s+-[a-zA-Z]+)*)\s+([^\s()$`;&|<>'"\\]+)\s*\)|\$\{|\$\(|\$[0-9@*#?!$-]|`/g,
  powershell: /\$\{([^}]*)\}|\$([A-Za-z_]\w*):([A-Za-z_]\w*)|\$([A-Za-z_]\w*)(?=(\.[A-Za-z_]|\[)?)|\$\(|@\(|\$[?^$]/g,
  cmd: /%([^%\s]+)%|%[0-9*~]|%%?[A-Za-z](?![\w]*%)/g,
};

export function hasShellVariable(word: string, dialect: ShellDialect): boolean {
  const syntax = VARIABLE_SYNTAX[dialect];
  syntax.lastIndex = 0;
  const found = syntax.test(word);
  syntax.lastIndex = 0;
  return found;
}

function mktempPath(options: string, temporary: () => string | null, directoryExists: (directory: string) => boolean): string | null {
  let template: string | undefined, directory: string | undefined, tmpdirFlag = false, inTemp = false;
  const words = options.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (/^-[dqu]*t[dqut]*$/.test(word)) inTemp = true;
    else if (/^-[dqu]+$|^--(?:directory|quiet|dry-run)$/.test(word)) continue;
    else if (word === "--tmpdir") tmpdirFlag = true;
    else if (word.startsWith("--tmpdir=")) directory = word.slice("--tmpdir=".length);
    else if (word === "-p") { directory = words[++i]; if (directory === undefined) return null; }
    else if (/^-p./.test(word)) directory = word.slice(2);
    else if (word.startsWith("-") || template !== undefined) return null;
    else template = word;
  }
  if (template !== undefined && !inTemp && !tmpdirFlag && directory === undefined) return template;
  if (template !== undefined && (inTemp ? /[\\/]/ : /^(?:[\\/]|[A-Za-z]:)/).test(template)) return null;
  const temporaryDirectory = temporary();
  const parent = inTemp ? temporaryDirectory === null ? null : temporaryDirectory || directory || "/tmp"
    : directory ?? (temporaryDirectory === null ? null : temporaryDirectory || "/tmp");
  return parent === null || /\s/.test(parent) || !directoryExists(parent) ? null : `${parent}/${template ?? "tmp.XXXXXXXXXX"}`;
}

function cygpathPath(options: string, path: string): string | null {
  const flags = options.split(/\s+/).filter(Boolean);
  if (process.platform !== "win32" || flags.some(flag => !/^-[mwua]+$/.test(flag)) || flags.join("").includes("u")) return null;
  const converted = /^\/(?!\/)/.test(path) ? gitBashAbsolute(path) : path;
  return /\s/.test(converted) ? null : converted;
}

const MULTIPLE_VALUES = "";
const multipleValues = (values: readonly string[]) => MULTIPLE_VALUES + values.join(MULTIPLE_VALUES);
const valuesOf = (value: string | null | undefined): readonly string[] | undefined =>
  typeof value === "string" && value.startsWith(MULTIPLE_VALUES) ? value.slice(1).split(MULTIPLE_VALUES) : undefined;

interface Expansion { readonly directoryExists?: (directory: string) => boolean; readonly partial?: boolean; readonly budget?: ScanBudget }

function expandShellWord(word: string, scope: ShellScope | undefined, dialect: ShellDialect, expansion: Expansion = {}): string | undefined {
  let resolved = true;
  const variable = (name: string): string | null => {
    if (dialect !== "posix" && name.toLowerCase() === "home") return homeDirectory(scope, dialect);
    const value = dialect === "posix" ? environmentValue(scope, name, dialect) : scopeEntry(scope, current => current.values, powershellKey(name)) ?? null;
    return value === null || valuesOf(value) || dialect === "posix" && /\s/.test(value) ? null : value;
  };
  const replaced = word.replace(VARIABLE_SYNTAX[dialect], (match: string, ...groups: (string | undefined)[]) => {
    let value: string | null | undefined;
    if (dialect === "posix" && groups[2] !== undefined) {
      const assigned = environmentValue(scope, groups[2], dialect);
      value = assigned === "" ? groups[3] : valuesOf(assigned) ? null : assigned;
    } else if (dialect === "posix" && (groups[4] ?? groups[5]) !== undefined) {
      value = mktempPath((groups[4] ?? groups[5])!, () => {
        const assigned = assignedEnvironment(scope, "TMPDIR", dialect);
        if (assigned !== undefined) return valuesOf(assigned) ? null : assigned;
        return knownEnvironment("TMPDIR", dialect) ?? "";
      }, expansion.directoryExists ?? (() => false));
    } else if (dialect === "posix" && groups[6] !== undefined) value = homeDirectory(scope, dialect);
    else if (dialect === "posix" && groups[8] !== undefined) value = cygpathPath(groups[7]!, groups[8]);
    else if (dialect === "posix") value = groups[0] ?? groups[1] ? variable((groups[0] ?? groups[1])!) : undefined;
    else if (dialect === "cmd") value = groups[0] !== undefined ? environmentValue(scope, groups[0], dialect) : undefined;
    else if (groups[0] !== undefined) value = /^env:/i.test(groups[0]) ? environmentValue(scope, groups[0].slice(4), dialect) : /^[A-Za-z_]\w*$/.test(groups[0]) ? variable(groups[0]) : undefined;
    else if (groups[1] !== undefined) value = groups[1].toLowerCase() === "env" ? environmentValue(scope, groups[2]!, dialect) : undefined;
    else if (groups[3] !== undefined && groups[4] === undefined) value = variable(groups[3]);
    if (value === null || value === undefined || valuesOf(value)) { resolved = false; return match; }
    return value;
  });
  if (expansion.budget && replaced !== word && (expansion.budget.remaining -= replaced.length) < 0) return expansion.partial ? word : undefined;
  if (!resolved && !expansion.partial) return undefined;
  if (dialect === "cmd" || dialect === "posix" || !/^~(?=[/\\]|$)/.test(word)) return replaced;
  return homeDirectory(scope, dialect) + replaced.slice(1);
}

const READING_PROGRAMS: ReadonlySet<string> = new Set(["read", "readarray", "mapfile", "getopts", "unset"]);
const POSIX_DECLARATIONS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "readonly", "local"]);
const POWERSHELL_VARIABLE_COMMANDS: ReadonlySet<string> = new Set(["set-variable", "new-variable", "clear-variable", "remove-variable"]);
const POWERSHELL_VARIABLE_OPTION = /^-(?:outvariable|ov|errorvariable|ev|warningvariable|wv|informationvariable|iv|pipelinevariable|pv)(?::(.*))?$/i;
const POWERSHELL_VARIABLE_PROVIDER = /(?:^|[\s(])variable:|psvariable/i;
const POSIX_ASSIGNED = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/;
const POSIX_DEFAULT_ASSIGNED = /\$\{([A-Za-z_]\w*):?=/g;
const ARITHMETIC_ASSIGNED = /([A-Za-z_]\w*)\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)|([A-Za-z_]\w*)\s*(?:\+\+|--)|(?:\+\+|--)\s*([A-Za-z_]\w*)/g;
const POWERSHELL_TARGET = /^(?:\[[\w.[\]]+\])*\$\{?(?:[A-Za-z_]\w*:)?([A-Za-z_]\w*)\}?(?:[.[].*)?$/s;
const POWERSHELL_ATTACHED = /^(.+?)(?:[-+*/%]|\?\?)?=(?!=)|^(.+?)(?:\+\+|--)$/s;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const powershellName = (word: string) => /([A-Za-z_]\w*)\}?$/.exec(word.replace(/^\+?\$?\{?/, ""))?.[1];

type ScriptNames = (script: string, dialect: ShellDialect) => readonly string[] | null;

function segmentAssignedNames(segment: ShellSegment, dialect: ShellDialect, scriptNames: ScriptNames): string[] | null {
  const words = segment.words, found = segmentProgram(segment), names: string[] = [];
  const nested = (script: string, scriptDialect: ShellDialect): boolean => {
    const inner = scriptNames(script, scriptDialect);
    if (inner) names.push(...inner);
    return inner !== null;
  };
  const program = found.index < words.length ? commandName(words[found.index], dialect) : undefined;
  const args = program === undefined ? [] : commandArguments(segment, found.index + 1);
  const operands = args.filter(word => !word.startsWith("-"));
  if (dialect === "posix") {
    for (let i = 0; i <= Math.min(found.index, words.length - 1); i++) {
      const assigned = segment.quotedStart.includes(i) ? null : POSIX_ASSIGNED.exec(words[i]);
      if (assigned) names.push(assigned[1]);
    }
    for (const word of words) {
      for (const match of word.matchAll(POSIX_DEFAULT_ASSIGNED)) names.push(match[1]);
      if (word.includes("((")) for (const match of word.matchAll(ARITHMETIC_ASSIGNED)) names.push((match[1] ?? match[2] ?? match[3])!);
    }
    if (program === undefined) return names;
    if (program === "let") for (const word of args) for (const match of word.matchAll(ARITHMETIC_ASSIGNED)) names.push((match[1] ?? match[2] ?? match[3])!);
    if (POSIX_DECLARATIONS.has(program)) {
      if (args.some(word => /^-[a-zA-Z]*n/.test(word))) return null;
      for (const word of operands) {
        const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
        if (hasShellVariable(name, dialect)) return null;
        if (word.includes("=") || program === "local") names.push(name.replace(/\[.*$/, "").replace(/\+$/, ""));
      }
    }
    if (READING_PROGRAMS.has(program)) {
      if (operands.some(word => hasShellVariable(word, dialect))) return null;
      names.push(...args.filter(word => IDENTIFIER.test(word)));
    }
    if (program === "printf") for (const [i, word] of args.entries()) {
      const name = word === "-v" ? args[i + 1] : /^-v./.test(word) ? word.slice(2) : undefined;
      if (name !== undefined && (hasShellVariable(name, dialect) || !IDENTIFIER.test(name.replace(/\[.*$/, "")))) return null;
      if (name !== undefined) names.push(name.replace(/\[.*$/, ""));
    }
    if ((program === "for" || program === "select") && IDENTIFIER.test(args[0] ?? "")) names.push(args[0]);
    if ((program === "eval" || program === "trap") && !nested(program === "trap" ? args[0] ?? "" : args.join(" "), dialect)) return null;
    return names;
  }
  if (dialect !== "powershell") return names;
  if (words.some(word => POWERSHELL_VARIABLE_PROVIDER.test(word))) return null;
  for (let i = 0; i <= Math.min(found.index, words.length - 1); i++) {
    if (segment.quotedStart.includes(i)) continue;
    const attached = POWERSHELL_ATTACHED.exec(words[i]);
    const bare = segment.stringParts.get(i)?.[0]?.at ?? Infinity;
    const target = POWERSHELL_ASSIGNMENT_RE.test(words[i + 1] ?? "") ? words[i] : attached && (attached[1] ?? attached[2])!.length < bare ? attached[1] ?? attached[2] : undefined;
    if (target === undefined || !/^(?:\[[\w.[\]]+\])*[$(]/.test(target)) continue;
    const name = POWERSHELL_TARGET.exec(target)?.[1];
    if (name === undefined) return null;
    names.push(name);
  }
  for (const [i, word] of args.entries()) {
    const option = POWERSHELL_VARIABLE_OPTION.exec(word);
    const value = option ? option[1] ?? args[i + 1] : undefined;
    if (value !== undefined && powershellName(value)) names.push(powershellName(value)!);
  }
  if (program !== undefined && POWERSHELL_VARIABLE_COMMANDS.has(program)) {
    const flag = args.findIndex(word => /^-n(?:a(?:me?)?)?(?::|$)/i.test(word));
    const name = flag >= 0 ? args[flag].includes(":") ? args[flag].slice(args[flag].indexOf(":") + 1) : args[flag + 1] : args.some(word => word.startsWith("-")) ? undefined : operands[0];
    if (name === undefined || hasShellVariable(name, dialect) || /[*?[\],]/.test(name) || !IDENTIFIER.test(name.replace(/^\$/, ""))) return null;
    names.push(name.replace(/^\$/, ""));
  }
  if (program === "foreach" || program === "for") { const variable = /\$([A-Za-z_]\w*)/.exec(words[found.index + 1] ?? "")?.[1]; if (variable) names.push(variable); }
  for (const script of [...segment.substitutions, ...segment.blocks.filter(block => block.script).map(block => block.body)]) if (!nested(script, dialect)) return null;
  if (program !== undefined && POWERSHELL_SCRIPT_RUNNERS.has(program) && !nested(args.join(" "), dialect)) return null;
  return names;
}

const LOOP_VALUE_LIMIT = 64;

function loopValue(words: readonly string[], dialect: ShellDialect): string | null {
  if (!words.length || words.length > LOOP_VALUE_LIMIT || words.some(word => hasShellVariable(word, dialect) || /\s/.test(word))) return null;
  return words.length === 1 ? words[0] : multipleValues(words);
}

function scriptWords(words: readonly string[], at: number, redirects: ReadonlySet<number>, name: (word: string) => string, end = words.length, raw = new Set<number>()): Set<number> {
  const word = words[at];
  if (word === undefined || at >= end) return raw;
  const program = name(word);
  const first = (test: (word: string) => boolean) => { for (let i = at + 1; i < end; i++) if (!redirects.has(i) && test(words[i])) return i; return -1; };
  const rest = (from: number) => { for (let i = from; i < end; i++) if (!redirects.has(i)) raw.add(i); };
  if (SCRIPT_SHELLS.has(program)) {
    const run = first(option => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(option));
    if (run >= 0) raw.add(at + 1 + shellScriptArgument(words.slice(at + 1, end), run - at - 1));
  } else if (program === "cmd") {
    const run = first(option => /^\/{1,2}[ck]$/i.test(option));
    if (run >= 0) rest(run + 1);
  } else if (POWERSHELL_PROGRAMS.has(program)) {
    const run = first(option => option.startsWith("-") && powershellParameter(option) === "command");
    if (run >= 0) rest(run + 1);
  } else if (INLINE_RUNNERS.has(program)) {
    const run = first(option => INLINE_FLAGS.has(option.toLowerCase()));
    if (run >= 0) raw.add(run + 1);
  } else if (SCRIPT_RUNNERS.has(program) || program === "parallel" || program === "start-process") rest(at + 1);
  else if (program === "xargs") scriptWords(words, xargsInvocation(words.slice(0, end), at + 1).start, redirects, name, end, raw);
  else if (program === "find") for (const [from, to] of runnerArguments(program, words.slice(0, end), at)) scriptWords(words, from, redirects, name, to, raw);
  return raw;
}

const WORKTREE_GIT: ReadonlySet<string> = new Set(["checkout", "switch", "restore", "reset", "clean", "stash", "merge", "rebase", "cherry-pick", "revert", "pull", "apply", "am", "rm", "mv",
  "checkout-index", "read-tree", "sparse-checkout", "bisect"]);
const PREVIOUS_BRANCH_GIT: ReadonlySet<string> = new Set(["checkout", "switch", "merge", "rebase", "cherry-pick"]);
const PREVIOUS_BRANCH = "@{-1}";
const DIRECTORY_CHANGES: ReadonlySet<string> = new Set(["cd", "chdir", "pushd", "popd", "set-location", "push-location", "pop-location"]);
const POWERSHELL_ASSIGNMENT = /^(?:\[[\w.[\]]+\])*\$(env:)?([A-Za-z_]\w*)(=(?!=)(.*))?$/is;

const ALIAS_DRIVE = /^(?:-\w+:)?alias:/i;
const ALIAS_DRIVE_WRITERS: ReadonlySet<string> = new Set(["set-item", "new-item", "copy-item", "move-item", "rename-item"]);

function aliasDefinition(segment: ShellSegment, scope: ShellScope): { readonly name: string; readonly target: string } | null | undefined {
  const found = segmentProgram(segment);
  if (found.index >= segment.words.length) return undefined;
  const program = commandName(segment.words[found.index], "powershell", scope), args = commandArguments(segment, found.index + 1);
  if (program === "import-alias" || ALIAS_DRIVE_WRITERS.has(program) && args.some(word => ALIAS_DRIVE.test(word))) return null;
  if (!ALIAS_DEFINING_CMDLETS.has(program)) return undefined;
  const parsed = powershellArguments(program, args), rest = [...parsed.positional];
  const name = parsed.named.get("-name") ?? rest.shift(), target = parsed.named.get("-value") ?? rest.shift();
  if (parsed.uncertain || name === undefined || target === undefined || [name, target].some(word => hasShellVariable(word, "powershell") || /[*?[\]]/.test(word))) return null;
  return { name: name.toLowerCase(), target: programName(target) };
}

function functionDefinition(segment: ShellSegment, dialect: ShellDialect): string | undefined {
  const body = segment.blocks.filter(block => block.script);
  if (!body.length || segment.quoted.includes(0)) return undefined;
  const words = segment.words;
  const name = words[0]?.toLowerCase() === "function" ? words[1]?.replace(/\(\)$/, "") : dialect === "posix" ? /^([A-Za-z_][\w-]*)\(\)$/.exec(words[0] ?? "")?.[1] : undefined;
  return name && /^[A-Za-z_][\w-]*$/.test(name) ? name.toLowerCase() : undefined;
}

const JUDGEMENT_BUDGET_PER_CHARACTER = 512;
const JUDGEMENT_BUDGET_FLOOR = 65_536;
const CALL_BUDGET_PER_CHARACTER = 1;
const CALL_BUDGET_FLOOR = 8_192;
const EXPANSION_BUDGET_PER_CHARACTER = 16;
const EXPANSION_BUDGET_FLOOR = 65_536;

function shellJudgement(command: string): ShellJudgement {
  return { gitCache: new Map(), written: new Set(), memo: new Map(), calling: new Set(), names: new Map(), budget: { remaining: JUDGEMENT_BUDGET_PER_CHARACTER * command.length + JUDGEMENT_BUDGET_FLOOR },
    callBudget: { remaining: CALL_BUDGET_PER_CHARACTER * command.length + CALL_BUDGET_FLOOR },
    expansion: { remaining: EXPANSION_BUDGET_PER_CHARACTER * command.length + EXPANSION_BUDGET_FLOOR } };
}

function judgementState(judgement: ShellJudgement): string {
  return JSON.stringify([judgement.written.size, [...stashTrailsByJudgement.get(judgement.gitCache)?.entries() ?? []]]);
}

export function shellProtectedWrite(command: string, configDir: string, platform: NodeJS.Platform = process.platform, cwd = process.cwd(), includeControl = false, judgement = shellJudgement(command), depth = 0, dialect: ShellDialect = "posix", repeating = false,
  parentScope?: ShellScope, cwdUnknown = false): ShellWriteKind {
  if (depth > MAX_SCRIPT_NESTING || judgement.budget.remaining < 0) return refuse(judgement, UNREADABLE_COMMAND);
  const { gitCache, written } = judgement;
  const scope = childScope(parentScope);
  let base = cwd, baseUnknown = cwdUnknown, recursed = false, commandScope = scope;
  const pathOf = (word: string, from = base) => placementPath(word, from, false, dialect === "posix");
  const directoryExists = (directory: string) => {
    const path = pathOf(directory);
    try { return path !== undefined && statSync(path).isDirectory(); } catch { return false; }
  };
  const expansion: Expansion = { directoryExists, budget: judgement.expansion };
  const writtenKey = (word: string) => normalizedPath(pathOf(word) ?? resolve(base, word), platform);
  const record = (word: string) => { written.add(writtenKey(word)); };
  const writtenEarlier = (word: string) => written.has(writtenKey(word)) || written.size > 0 && hasShellVariable(word, dialect);
  const writeKind = (word: string | undefined) => {
    if (word === undefined) return undefined;
    record(word);
    return kindOf(word);
  };
  const refused = (refusal: ControlRefusal | false): boolean => {
    if (refusal) judgement.refusal = refusal;
    return !!refusal;
  };
  const judgeNested = (code: string, scriptDialect = dialect, scriptRepeating = repeating, nestedScope = scope): ShellWriteKind => {
    const script = withDollars(code);
    judgement.budget.remaining -= script.length + 1;
    if (judgement.budget.remaining < 0) return refuse(judgement, UNREADABLE_COMMAND);
    const key = JSON.stringify([script, scriptDialect, scriptRepeating, base, baseUnknown, scopeFingerprint(nestedScope, script), judgementState(judgement)]);
    if (judgement.memo.has(key)) return judgement.memo.get(key);
    const kind = shellProtectedWrite(script, configDir, platform, base, includeControl, judgement, depth + 1, scriptDialect, scriptRepeating, nestedScope, baseUnknown);
    judgement.memo.set(key, kind);
    return kind;
  };
  const runScript = (script: string, scriptDialect = dialect, scriptRepeating = repeating) => { recursed = true; return judgeNested(script, scriptDialect, scriptRepeating, commandScope); };
  const expandedStage = (stage: ShellSegment): ShellSegment => ({ ...stage, words: stage.words.map(word => expandShellWord(word, scope, dialect, expansion) ?? word) });
  const pipedScript = (pipeline: readonly ShellSegment[]) => pipeline.length === 1 ? pipedLiteral(expandedStage(pipeline[0]), dialect) : undefined;
  const unreadableInline = (inline: readonly ShellSegment[]) => opaqueRisk(command) && inline.some(stage => expandedStage(stage).words.some(word => hasShellVariable(word, dialect)));
  const stdinScriptKind = (segment: ShellSegment, pipeline: readonly ShellSegment[], scriptDialect: ShellDialect): ShellWriteKind => {
    const bodies = stdinBodies(segment);
    for (const { body, expands } of bodies) {
      const kind = runScript(body, scriptDialect);
      if (kind) return kind;
      if (includeControl && expands && /[$`]/.test(body) && opaqueRisk(body)) return refuse(judgement, UNREADABLE_COMMAND);
    }
    if (bodies.length) return undefined;
    const redirect = segment.operators.filter(i => INPUT_REDIRECT_RE.test(segment.words[i])).pop();
    if (redirect !== undefined) {
      const source = segment.words[redirect + 1];
      if (segment.words[redirect].includes("&") || source === undefined) return includeControl && opaqueRisk(command) ? refuse(judgement, UNREADABLE_COMMAND) : undefined;
      if (writtenEarlier(source)) return includeControl ? refuse(judgement, UNREADABLE_COMMAND) : undefined;
      return includeControl && opaqueRisk(segmentText(segment)) ? refuse(judgement, UNREADABLE_COMMAND) : undefined;
    }
    if (!segment.piped) return undefined;
    const literal = pipedScript(pipeline);
    if (literal !== undefined) return runScript(literal, scriptDialect);
    const unreadable = opaqueRisk([...pipeline, segment].map(segmentText).join(" ")) || unreadableInline(pipeline.filter(stage => carriesInlineText(stage, dialect)));
    return includeControl && unreadable ? refuse(judgement, UNREADABLE_COMMAND) : undefined;
  };
  const unresolvedTarget = (word: string): "path-unresolved" | "directory-unresolved" | undefined => {
    if (!includeControl || dialect === "powershell" && /^\$null$/i.test(word)) return undefined;
    if (hasShellVariable(word, dialect) || dialect === "powershell" && /^\s*\(/.test(word)
      && parenthesizedLiteral(word, judgement.budget) === undefined && joinPathWord(word, judgement.budget) === undefined) return "path-unresolved";
    return baseUnknown && !word.startsWith("-") && !isAbsolute(expandHomePath(word)) ? "directory-unresolved" : undefined;
  };
  const kindOf = (word: string | undefined): ProtectedKind | "control" | undefined => {
    const kind = wordKind(word);
    if (kind) judgement.refusal ??= { kind: unresolvedTarget(word!) ?? "control-write", file: word };
    return kind;
  };
  const wordKind = (word: string | undefined): ProtectedKind | "control" | undefined => {
    if (word === undefined) return undefined;
    const joined = dialect === "powershell" ? joinPathWord(word, judgement.budget) ?? parenthesizedLiteral(word, judgement.budget) : undefined;
    if (joined !== undefined) return wordKind(joined);
    if (unresolvedTarget(word)) return "control";
    if (dialect === "powershell" && /^\s*\(/.test(word)) {
      const named = expressionStrings(word, judgement.budget).map(text => lexicalProtectedKind(text, configDir, platform)).find(kind => kind !== undefined);
      if (named) return named;
    }
    if (includeControl && GLOB_CHARACTERS.test(word)) {
      const normalized = word.replace(/\\/g, "/");
      const specific = /[^*?\[\]{}]/.test(normalized.split("/").pop() ?? "");
      const inspect = (pattern: string): boolean => {
        const wildcard = pattern.search(GLOB_CHARACTERS);
        if (wildcard < 0) {
          const path = platform === process.platform ? pathOf(pattern) : pattern;
          return !!path && (isControlFile(path, configDir, platform) || platform === process.platform && overlapsControlLocation(path, configDir));
        }
        const slash = pattern.lastIndexOf("/", wildcard);
        const prefix = pattern.slice(0, slash + 1) || ".";
        const rest = pattern.slice(slash + 1);
        const next = rest.indexOf("/");
        const segment = next < 0 ? rest : rest.slice(0, next);
        const path = platform === process.platform ? pathOf(prefix) : prefix;
        if (!path) return false;
        if (segment === "**" && next >= 0 && inspect(pattern.slice(0, slash + 1) + rest.slice(next + 1))) return true;
        if (next < 0) {
          if (isControlFile(path, configDir, platform)) return true;
          if (specific && CONTROL_FILE_NAMES.some(name => globCouldMatch(segment, name, platform))) return true;
          const directory = normalizedPath(path, platform).replace(/\/$/, "");
          const config = normalizedPath(configDir, platform).replace(/\/$/, "");
          if (directory.endsWith("/.claude") || directory === ".claude" || directory === config) {
            if (["settings.json", "settings.local.json", "rules", "hooks", segment.replace(/\*/g, "").replace(/\?/g, "x")]
              .some(name => /^(?:settings.*\.json|rules|hooks)$/.test(name) && globCouldMatch(segment, name, platform))) return true;
          }
        }
        if (platform !== process.platform) return false;
        try {
          for (const name of readdirSync(path)) {
            if (!globCouldMatch(segment, name, platform)) continue;
            const matched = join(path, name);
            if (next >= 0 && !directoryOrUnknown(matched)) continue;
            if (next < 0 ? overlapsControlLocation(matched, configDir) : inspect(matched.replace(/\\/g, "/") + rest.slice(next))) return true;
          }
        } catch (error) { return !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
        return false;
      };
      if (inspect(normalized)) return "control";
      return undefined;
    }
    if (/[$*?]/.test(word.replace(/^\$HOME/i, ""))) return lexicalProtectedKind(word, configDir, platform) ?? (includeControl && isControlPath(word, configDir, platform) ? "control" : undefined);
    const path = platform === process.platform ? pathOf(word) : word;
    return path === undefined ? undefined : protectedDestination(path, configDir, platform)
      ?? (includeControl && isControlFile(path, configDir, platform) ? "control" : undefined);
  };
  const uncertainKind = (segment: ShellSegment, args: readonly string[], directories = false): ProtectedKind | "control" | undefined => {
    for (const arg of args) {
      const token = arg.startsWith("-") && arg.includes(":") ? arg.slice(arg.indexOf(":") + 1) : arg;
      for (const value of pathListItems(segment, token)) {
        const kind = kindOf(value); if (kind) return kind;
        if (directories && platform === process.platform) {
          const path = pathOf(value);
          const contained = path ? containsControlLocation(path, configDir) : undefined;
          if (contained) return refuse(judgement, { kind: contained.kind, file: value, inner: contained.path });
        }
      }
    }
    return undefined;
  };
  const copyKind = (destination: string | undefined, sources: readonly string[], directory = false, recursive = false, contents = false): ProtectedKind | "control" | undefined => {
    if (destination !== undefined) for (const source of sources) record(join(destination, basename(source.replace(/[\\/]+$/, ""))));
    const direct = writeKind(destination);
    if (direct || destination === undefined) return direct;
    directory ||= /[\\/]$/.test(destination);
    if (platform === process.platform) {
      const path = canonicalPlacement(destination, base, dialect === "posix");
      if (path === UNREADABLE_REAL_PATH) directory = true;
      else if (path) {
        try { directory ||= statSync(path).isDirectory(); }
        catch (error) { directory ||= !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
      }
    }
    if (includeControl && platform === process.platform) {
      const expanded = expandedCopySources(sources, base);
      if (!expanded) return refuse(judgement, { kind: "glob-unexpanded", file: sources.join(" ") });
      sources = expanded;
    }
    if (includeControl && recursive && platform === process.platform) {
      const target = pathOf(destination);
      for (const source of sources) {
        const from = pathOf(source);
        if (from && target && recursiveCopyControls(from, directory && !contents && !/[\\/]\.$/.test(source) ? join(target, basename(from)) : target, configDir)) return refuse(judgement, { kind: "recursive-copy", file: destination });
      }
    }
    if (!directory) return undefined;
    for (const source of sources) {
      const name = basename(source.replace(/[\\/]+$/, "").replace(/\\/g, "/"));
      const kind = kindOf(`${destination.replace(/[\\/]+$/, "")}/${name}`);
      if (kind) return kind;
    }
    return undefined;
  };
  const linkKind = (link: string | undefined, targets: readonly string[], hard: boolean): ProtectedKind | "control" | undefined => {
    const direct = kindOf(link);
    if (direct || link === undefined || !includeControl || platform !== process.platform) return direct;
    const path = pathOf(link);
    if (!path) return undefined;
    if (overlapsControlLocation(path, configDir)) return refuse(judgement, { kind: "link-control", file: link });
    for (const target of targets) {
      const unresolved = unresolvedTarget(target);
      if (unresolved) return refuse(judgement, { kind: unresolved, file: target });
      for (const from of new Set([pathOf(target), pathOf(target, dirname(path))])) {
        if (!from) continue;
        if (hard ? overlapsControlLocation(from, configDir) : recursiveCopyControls(from, path, configDir)) return refuse(judgement, { kind: "link-control", file: link });
      }
    }
    return undefined;
  };
  const inlineKind = (program: string, script: string): ProtectedKind | "control" | undefined => {
    if (POWERSHELL_PROGRAMS.has(program)) return runScript(script, "powershell");
    for (const pattern of program === "node" ? NODE_WRITE_PATTERNS : PYTHON_WRITE_PATTERNS) {
      const executable = executablePositions(script, program === "node" ? "node" : "python");
      for (const match of script.matchAll(pattern)) {
        if (!executable(match.index)) continue;
        const kind = kindOf(match.groups?.path); if (kind) return kind;
      }
    }
    return undefined;
  };
  const inlineStdinKind = (program: string, args: readonly string[], segment: ShellSegment, pipeline: readonly ShellSegment[]): ProtectedKind | "control" | undefined => {
    for (let i = 0; i < args.length; i++) {
      if (INLINE_VALUE_OPTIONS.has(args[i])) i++;
      else if (args[i] === "-") break;
      else if (program !== "node" && /^-[a-zA-Z]*m/.test(args[i])) return undefined;
      else if (!args[i].startsWith("-")) {
        if (i > 0 && optionValueUnknown(program, args[i - 1]) && !NODE_SCRIPT_FILE.test(args[i])) continue;
        return undefined;
      }
    }
    const bodies = stdinBodies(segment).map(({ body }) => body);
    const piped = !bodies.length && segment.piped ? pipedScript(pipeline) : undefined;
    for (const body of piped === undefined ? bodies : [piped]) {
      const kind = inlineKind(program, body); if (kind) return kind;
    }
    const inline = bodies.length || piped !== undefined || !segment.piped ? [] : pipeline.filter(stage => carriesInlineText(stage, dialect));
    if (includeControl && (opaqueRisk(inline.map(segmentText).join(" ")) || unreadableInline(inline))) return refuse(judgement, UNREADABLE_COMMAND);
    return undefined;
  };
  const executableInCommand = executablePositions(command, "shell");
  const parsedCommand = includeControl && dialect !== "cmd" ? command.replace(/@\{[^{}\s;&|<>]+\}|\{[^{}\s;&|<>,]*,[^{}\s;&|<>]*\}/g,
    (literal, offset: number) => executableInCommand(offset) ? literal.replace(/[{}]/g, (brace: string) => "'" + brace + "'") : literal) : command;
  const syntax = shellSyntax(parsedCommand, dialect, judgement.budget);
  if (syntax.exceeded) return refuse(judgement, UNREADABLE_COMMAND);
  const stashRoundTrip = includeControl && depth === 0 && stashRoundTripClassified(command, syntax, dialect, judgement.budget);
  if (judgement.budget.remaining < 0) return refuse(judgement, UNREADABLE_COMMAND);
  if (includeControl && !syntax.balanced && opaqueRisk(command)) return refuse(judgement, UNREADABLE_COMMAND);
  let pipelineStart = 0;
  const segments = syntax.segments;
  const scriptNames: ScriptNames = (script, scriptDialect) => {
    const key = JSON.stringify([scriptDialect, script]);
    if (judgement.names.has(key)) return judgement.names.get(key)!;
    judgement.names.set(key, null);
    const parsed = shellSyntax(script, scriptDialect, { remaining: JUDGEMENT_BUDGET_PER_CHARACTER * script.length + JUDGEMENT_BUDGET_FLOOR });
    let names: string[] | null = parsed.exceeded ? null : [];
    for (const segment of parsed.segments) {
      const found = names && segmentAssignedNames(segment, scriptDialect, scriptNames);
      names = found && names ? [...names, ...found] : null;
    }
    judgement.names.set(key, names);
    return names;
  };
  const crude = segments.map(segment => segmentAssignedNames(segment, dialect, scriptNames));
  const track = loopTracker(dialect);
  const steps = segments.map((segment, position) => track(segment, segmentProgram(segment).index, position));
  const loopEnd = new Map<number, number>();
  for (const [position, step] of steps.entries()) if (step.ended?.kind === "loop") loopEnd.set(step.ended.header, position);
  const poisonNames = (names: readonly (readonly string[] | null)[]) => { if (names.includes(null)) makeOpaque(scope); else poisonVariables(scope, names.flat() as string[], dialect); };
  const loopNames = (header: number) => crude.slice(header, (loopEnd.get(header) ?? segments.length - 1) + 1);
  if (repeating) poisonNames(crude);
  const subshells: { node: ShellSubshell; base: string; baseUnknown: boolean }[] = [];
  const enterSubshell = (node: ShellSubshell | undefined) => {
    const entered: ShellSubshell[] = [];
    let current = node;
    while (current && subshells[current.depth - 1]?.node !== current) { entered.push(current); current = current.parent; }
    while (subshells.length > (current?.depth ?? 0)) { const saved = subshells.pop()!; base = saved.base; baseUnknown = saved.baseUnknown; }
    for (const entry of entered.reverse()) subshells.push({ node: entry, base, baseUnknown });
  };
  const segmentVariants = (segment: ShellSegment): ShellScope[] => {
    const choices: [string, readonly string[]][] = [];
    for (const match of segment.words.join(" ").matchAll(REFERENCED_NAME)) {
      const name = match[1];
      const values = name === undefined || choices.some(([known]) => known === name) ? undefined : valuesOf(environmentValue(scope, name, dialect));
      if (values) choices.push([name!, values]);
    }
    let variants = [scope];
    for (const [name, values] of choices) {
      if (variants.length * values.length > LOOP_VALUE_LIMIT) return [scope];
      variants = variants.flatMap(variant => values.map(value => { const choice = childScope(variant); setPosixVariable(choice, name, value); return choice; }));
    }
    return variants;
  };
  const directories: { base: string; baseUnknown: boolean }[] = [];
  let hidesAssignments = false;
  const chained = new Set<string>();
  const assignWord = (target: ShellScope, word: string, from = scope, exported = false) => {
    const equals = word.indexOf("=");
    setPosixVariable(target, word.slice(0, equals), expandShellWord(word.slice(equals + 1), from, dialect, expansion) ?? null, exported);
  };
  const preciseAssignments = (segment: ShellSegment, step: LoopPosition): ShellScope | undefined => {
    if (!["start", ";", "&&"].includes(segment.after) || segment.grouped || segment.piped || segment.ended === "|" || segment.ended === "&" || segment.blocks.length) return undefined;
    if (step.ifsBefore || step.loopsBefore > 1) return undefined;
    const words = segment.words, bare = (index: number) => !segment.quoted.includes(index), assigned = childScope(scope);
    if (dialect === "posix") {
      const first = step.loopsBefore && words[0] === "do" && bare(0) ? 1 : 0;
      const declaration = POSIX_DECLARATIONS.has(words[first] ?? "") && bare(first);
      const from = first + (declaration ? 1 : 0), operands = words.slice(from);
      if (declaration ? operands.some(word => word.startsWith("-") && !/^-[xgr]+$/.test(word)) : segmentProgram(segment).index < words.length) return undefined;
      for (const [i, word] of operands.entries()) {
        if (ASSIGNMENT_RE.test(word) && !segment.quotedStart.includes(from + i)) assignWord(assigned, word, assigned, declaration && words[first] === "export");
        else if (!declaration) return undefined;
      }
      return assigned;
    }
    if (dialect !== "powershell" || segment.operators.length) return undefined;
    const target = POWERSHELL_ASSIGNMENT.exec(words[0] ?? "");
    if (!target || segment.quotedStart.includes(0)) return undefined;
    if (!target[3] && words[1] === "=" && words[2]?.toLowerCase() === "join-path") {
      const call = words.slice(2).map((word, i) => segment.quoted.includes(i + 2) || /\s/.test(word) ? `'${word.replace(/'/g, "''")}'` : word).join(" ");
      const joined = joinPathWord(`(${call})`, judgement.budget);
      setVariable(assigned, target[1] ? environmentKey(target[2]) : powershellKey(target[2]),
        joined === undefined ? null : expandShellWord(joined, assigned, dialect, { ...expansion, partial: true }) ?? null);
      return assigned;
    }
    if (words.length > 3) return undefined;
    const value = words.length === 3 ? words[1] === "=" ? words[2] : undefined : words.length === 2 ? target[3] === "=" ? words[1] : undefined : target[3] ? target[4] : undefined;
    if (value === undefined || segment.listItems.has(value)) return undefined;
    setVariable(assigned, target[1] ? environmentKey(target[2]) : powershellKey(target[2]), expandShellWord(value, assigned, dialect, expansion) ?? null);
    return assigned;
  };
  const judgeSegment = (position: number, parsed: ShellSegment, looping: boolean, wordScope: ShellScope): ShellWriteKind => {
    const parsedProgram = segmentProgram(parsed), programAt = parsedProgram.index;
    const literalProgram = dialect === "powershell" && programAt < parsed.words.length ? parenthesizedLiteral(parsed.words[programAt], judgement.budget) : undefined;
    const literal = literalProgram === undefined ? parsed : { ...parsed, words: parsed.words.map((word, i) => i === programAt ? literalProgram : word) };
    const expandWord = (word: string) => expandShellWord(word, wordScope, dialect, expansion) ?? word;
    const expandCode = (word: string) => expandShellWord(word, wordScope, dialect, { ...expansion, partial: true }) ?? word;
    const expandedWords = literal.words.map(expandWord);
    const redirects = redirectPositions(literal);
    const code = parsedProgram.script === undefined ? scriptWords(literal.words.map((word, i) => i === programAt ? expandedWords[i] : word), programAt, redirects, word => commandName(word, dialect, scope))
      : new Set(literal.words.map((_, i) => i).filter(i => i >= parsedProgram.script! && !redirects.has(i)));
    const segment: ShellSegment = { ...literal, words: literal.words.map((word, i) => code.has(i) ? expandCode(word) : expandedWords[i]),
      listItems: new Map([...literal.listItems].map(([word, items]) => [expandWord(word), items.map(expandWord)])) };
    const words = segment.words;
    if (!segment.piped) pipelineStart = position;
    const pipeline = syntax.segments.slice(pipelineStart, position);
    recursed = false;
    const found = segmentProgram(segment);
    for (const body of segment.substitutions) { const kind = judgeNested(body, dialect, looping); if (kind) return kind; }
    for (const i of segment.operators) if (i < words.length - 1 && REDIRECT_RE.test(words[i])) for (const value of pathListItems(segment, words[i + 1])) { const kind = writeKind(value); if (kind) return kind; }
    for (const write of found.writes) { const kind = writeKind(write); if (kind) return kind; }
    if (found.unclassified) {
      if (includeControl) return refuse(judgement, UNREADABLE_COMMAND);
      return uncertainKind(segment, words.slice(found.index + 1));
    }
    for (const block of segment.blocks) {
      if (!block.body.trim()) continue;
      const kind = block.script ? runScript(block.body, dialect, true) : judgeNested(hashtableStatements(block.body), dialect, looping);
      if (kind) return kind;
    }
    if (found.script !== undefined) return runScript(commandArguments(segment, found.script).join(" "), "posix");
    for (const call of dialect === "powershell" ? literal.calls : []) {
      const method = DOTNET_FILE_CALLEE.exec(call.callee)?.[1].toLowerCase();
      if (method === undefined || DOTNET_READ_METHOD.test(method)) continue;
      const dotnetArgs = call.args.map(raw => dotnetArgument(raw, judgement.budget));
      if (DOTNET_OPEN_METHOD.test(method) && opensForReading(dotnetArgs)) continue;
      const values = dotnetArgs.map(argument => argument.word === undefined ? `(${argument.raw})` : expandWord(argument.word));
      if (method === "createsymboliclink") { const kind = linkKind(values[0], values.slice(1, 2), false); if (kind) return kind; continue; }
      const written = method === "delete" ? [] : method === "copy" || method === "move" ? values.slice(1, 2) : method === "replace" ? values.slice(1, 3) : values.slice(0, 1);
      for (const value of written) { const kind = writeKind(value); if (kind) return kind; }
      if (includeControl && ["delete", "move", "replace"].includes(method)) { const kind = uncertainKind(segment, values.slice(0, 1), true); if (kind) return kind; }
    }
    const index = found.index;
    if (index >= words.length) return undefined;
    if (includeControl && dialect === "posix" && BRACE_EXPANSION.test(words[index])) return refuse(judgement, { kind: "brace-expansion", file: words[index] });
    const program = commandName(words[index], dialect, scope);
    const args = commandArguments(segment, index + 1);
    const positional = args.filter((word) => !word.startsWith("-"));
    const alias = dialect === "powershell" ? aliasDefinition(segment, scope) : undefined;
    if (alias === null && includeControl) return refuse(judgement, UNREADABLE_COMMAND);
    if (alias) defineAlias(scope, alias.name, alias.target);
    const pipedPaths = (): string[] => {
      if (dialect !== "powershell" || !segment.piped) return [];
      const previous = pipeline[pipeline.length - 1];
      const at = previous ? segmentProgram(previous).index : 0;
      if (!previous || commandName(previous.words[at] ?? "", dialect, scope) !== "join-path") return [PIPED_INPUT];
      const joined = powershellArguments("join-path", previous.words.slice(at + 1));
      if (joined.uncertain || joined.named.has("-path")) return [PIPED_INPUT];
      return [[PIPED_INPUT, joined.named.get("-childpath"), joined.named.get("-additionalchildpath"), ...joined.positional].filter((part): part is string => part !== undefined).join("/")];
    };
    const called = scopeEntry(scope, current => current.functions, program);
    const rejudged = called && !judgement.calling.has(program) && (includeControl || depth < MAX_SCRIPT_NESTING) ? called : undefined;
    if (rejudged) judgement.callBudget.remaining -= rejudged.body.length + 1;
    if (rejudged && judgement.callBudget.remaining < 0 && includeControl) return refuse(judgement, UNREADABLE_COMMAND);
    if (rejudged && judgement.callBudget.remaining >= 0) {
      const called = rejudged;
      judgement.calling.add(program);
      const kind = runScript(called.body, called.dialect);
      judgement.calling.delete(program);
      if (kind) return kind;
      poisonNames([scriptNames(called.body, called.dialect)]);
    }
    if (DIRECTORY_CHANGES.has(program) && platform === process.platform) {
      if (program === "popd" || program === "pop-location") {
        const saved = directories.pop();
        if (saved) ({ base, baseUnknown } = saved);
        else if (includeControl) baseUnknown = true;
      } else {
        if (program === "pushd" || program === "push-location") directories.push({ base, baseUnknown });
        const flag = args.findIndex(word => /^-(?:path|literalpath)$/i.test(word));
        const directory = flag >= 0 ? args[flag + 1] : args.find(word => dialect === "posix" ? !/^-[LPe@]+$/.test(word) : !word.startsWith("-"));
        const target = directory ?? (dialect === "posix" && program === "cd" ? expandShellWord("~", scope, dialect) : undefined);
        const next = target === undefined || target === "-" || hasShellVariable(target, dialect) ? undefined : pathOf(target);
        if (next !== undefined) { baseUnknown &&= !isAbsolute(expandHomePath(target!)); base = next; }
        else if (includeControl) baseUnknown = true;
      }
    }
    hidesAssignments = program === "source" || program === "." || SCRIPT_RUNNERS.has(program) && program !== "trap" && args.some(word => hasShellVariable(word, dialect) || word.includes("`"));
    if (dialect === "powershell" && CMDLET_NAME.test(program) && !Object.hasOwn(POWERSHELL_PARAMETERS, program)) {
      const exporting = program.startsWith("export-");
      const parsed = powershellArguments(exporting ? EXPORT_CMDLET : ANY_CMDLET, args);
      const path = parsed.named.get("-literalpath") ?? parsed.named.get("-path") ?? parsed.named.get("-filepath");
      const exported = !exporting ? [] : path !== undefined ? [path] : parsed.positional.slice(0, parsed.uncertain ? undefined : 1);
      for (const value of [parsed.named.get("-outfile"), ...exported]) { const kind = writeKind(value); if (kind) return kind; }
    }
    if (includeControl && program === "remove-item") {
      const parsed = powershellArguments("remove-item", args);
      const targets = [...parsed.positional, ...[parsed.named.get("-path"), parsed.named.get("-literalpath")].filter((value): value is string => value !== undefined)];
      const kind = uncertainKind(segment, parsed.uncertain ? args : targets.length ? targets : pipedPaths(), true);
      if (kind) return kind;
    }
    if (program === "rename-item") {
      const parsed = powershellArguments("rename-item", args);
      if (parsed.uncertain) { const kind = uncertainKind(segment, args, includeControl); if (kind) return kind; }
      const named = parsed.named.get("-literalpath") ?? parsed.named.get("-path");
      const source = named ?? parsed.positional[0] ?? pipedPaths()[0];
      const name = parsed.named.get("-newname") ?? parsed.positional[named === undefined ? 1 : 0];
      if (includeControl && source !== undefined) { const kind = uncertainKind(segment, [source], true); if (kind) return kind; }
      if (source !== undefined && name !== undefined) { const kind = writeKind(join(dirname(source), name)); if (kind) return kind; }
    }
    if (program === "tee") {
      for (const arg of positional) { const kind = writeKind(arg); if (kind) return kind; }
    } else if (CONTENT_CMDLETS.has(program)) {
      const parsed = powershellArguments(program, args);
      if (parsed.uncertain) { const kind = uncertainKind(segment, args); if (kind) return kind; }
      const target = parsed.named.get("-literalpath") ?? parsed.named.get("-path") ?? parsed.named.get("-filepath") ?? parsed.positional[0]
        ?? (CONTENT_FROM_PIPELINE_CMDLETS.has(program) ? pipedPaths()[0] : undefined);
      for (const value of target === undefined ? [] : pathListItems(segment, target)) { const kind = writeKind(value); if (kind) return kind; }
      const itemType = parsed.named.get("-itemtype")?.toLowerCase();
      const linkType = itemType ? ["symboliclink", "junction", "hardlink"].find(type => type.startsWith(itemType)) : undefined;
      if (program === "new-item" && linkType) {
        const location = parsed.named.get("-path") ?? parsed.positional[0] ?? ".", name = parsed.named.get("-name"), target = parsed.named.get("-value");
        const found = linkKind(name === undefined ? location : join(location, name), target === undefined ? [] : [target], linkType === "hardlink");
        if (found) return found;
      }
    }
    if ((program === "sed" || program === "perl") && args.some((word) => /^-[a-zA-Z]*i/.test(word) || /^--in-place(?:=|$)/.test(word))) {
      const targets = args.filter((word, i) => !word.startsWith("-") && !(i > 0 && ["-e", "-f", "--expression", "--file"].includes(args[i - 1])))
        .slice(args.some(word => ["-e", "-f", "--expression", "--file"].includes(word)) ? 0 : 1);
      for (const arg of targets) { const kind = writeKind(arg); if (kind) return kind; }
    }
    const powershellCopy = COPY_CMDLETS.has(program) || COPY_PROGRAMS.has(program) && args.some(word => /^-(?:path|literalpath|destination)(?::|$)/i.test(word));
    if (COPY_PROGRAMS.has(program) && !powershellCopy) {
      const flag = args.findIndex(word => word === "--target-directory" || /^-[^-]*t$/.test(word));
      const inline = args.find(word => word.startsWith("--target-directory="));
      const destination = flag >= 0 ? args[flag + 1] : inline ? inline.slice("--target-directory=".length) : positional[positional.length - 1];
      const sources = args.filter((word, i) => !word.startsWith("-") && !(flag >= 0 && i === flag + 1) && !(i > 0 && ["-S", "--suffix"].includes(args[i - 1])));
      if (flag < 0 && !inline) sources.pop();
      if (includeControl && ["mv", "move"].includes(program)) { const kind = uncertainKind(segment, sources, true); if (kind) return kind; }
      const kind = copyKind(destination, sources, flag >= 0 || !!inline, program === "cp" && args.some(word => /^-[^-]*[rRa]/.test(word) || word === "--recursive" || word === "--archive"));
      if (kind) return kind;
      if (includeControl && program === "cp" && platform === process.platform && args.some(word => /^-[^-]*l/.test(word) || word === "--link")) {
        const expanded = expandedCopySources(sources, base);
        if (!expanded || expanded.some(source => { const from = pathOf(source); return !from || overlapsControlLocation(from, configDir); })) return refuse(judgement, { kind: "link-control", file: destination });
      }
      if (includeControl && program === "ln" && destination !== undefined) {
        const hard = !args.some(word => /^-[^-]*s/.test(word) || word === "--symbolic");
        const replace = args.some(word => /^-[^-]*[nT]/.test(word) || word === "--no-dereference" || word === "--no-target-directory");
        const targets = sources.length ? sources : [destination];
        let links = sources.length ? [destination] : [basename(destination.replace(/[\\/]+$/, ""))];
        if (sources.length && platform === process.platform) {
          const path = pathOf(destination);
          let directory = flag >= 0 || !!inline, linked = false;
          try { if (path) { linked = fs.lstatSync(path).isSymbolicLink(); directory ||= statSync(path).isDirectory(); } }
          catch (error) { if (!ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "")) return refuse(judgement, { kind: "path-unreadable", file: destination }); }
          if (directory && !(replace && linked)) links = sources.map(source => join(destination, basename(source.replace(/[\\/]+$/, ""))));
        }
        for (const [index, link] of links.entries()) {
          const found = linkKind(link, links.length > 1 ? [targets[index]] : targets, hard);
          if (found) return found;
        }
      }
    }
    if (program === "mklink") {
      const positional = args.filter(word => !/^\/{1,2}[dhj]$/i.test(word));
      const kind = linkKind(positional[0], positional.slice(1, 2), args.some(word => /^\/{1,2}h$/i.test(word)));
      if (kind) return kind;
    }
    if (program === "fsutil" && args[0]?.toLowerCase() === "hardlink" && args[1]?.toLowerCase() === "create") {
      const kind = linkKind(args[2], args.slice(3, 4), true);
      if (kind) return kind;
    }
    if (program === "cmd") {
      const run = args.findIndex(word => /^\/{1,2}[ck]$/i.test(word));
      if (run >= 0) {
        const rest = args.slice(run + 1);
        const kind = runScript(rest.length === 1 ? rest[0] : rest.map(word => /\s/.test(word) ? `"${word}"` : word).join(" "), "cmd");
        if (kind) return kind;
      }
    }
    if (powershellCopy) {
      const parsed = powershellArguments(program === "move-item" || program === "mv" || program === "move" ? "move-item" : "copy-item", args);
      if (parsed.uncertain) { const kind = uncertainKind(segment, args); if (kind) return kind; }
      const source = parsed.named.get("-literalpath") ?? parsed.named.get("-path");
      const destination = parsed.named.get("-destination") ?? parsed.positional[source === undefined ? 1 : 0];
      const listed = source === undefined ? parsed.positional.slice(0, parsed.named.has("-destination") ? undefined : 1) : [source];
      const sources = listed.length ? listed : pipedPaths();
      if (includeControl && ["move-item", "mv", "move"].includes(program)) { const kind = uncertainKind(segment, sources, true); if (kind) return kind; }
      const kind = copyKind(destination, sources.flatMap(value => pathListItems(segment, value)), false, args.some(word => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::|$)/i.test(word)));
      if (kind) return kind;
    }
    if (includeControl && ["robocopy", "xcopy"].includes(program)) {
      const paths = args.filter(word => !/^\/[a-z]+(?::.*)?$/i.test(word) && !word.startsWith("-"));
      const kind = copyKind(paths[1], paths.slice(0, 1), true, true, true);
      if (kind) return kind;
    }
    if (INLINE_RUNNERS.has(program)) {
      const flag = args.findIndex((word) => INLINE_FLAGS.has(word.toLowerCase()));
      if (flag >= 0 && flag + 1 < args.length && args[flag + 1] !== "-") {
        const kind = inlineKind(program, POWERSHELL_PROGRAMS.has(program) ? args.slice(flag + 1).join(" ") : args[flag + 1]);
        if (kind) return kind;
      } else if (flag < 0 && !POWERSHELL_PROGRAMS.has(program)) {
        const kind = inlineStdinKind(program, args, segment, pipeline);
        if (kind) return kind;
      }
    }
    if (SCRIPT_SHELLS.has(program)) {
      const run = args.findIndex(word => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
      const at = run < 0 ? args.length : shellScriptArgument(args, run);
      if (at < args.length) {
        const values = args.slice(at + 1), positional = substitutePositional(withDollars(args[at]), values);
        if (includeControl && positional.unresolved) for (const value of values) {
          if (!wordKind(value)) continue;
          if (judgeNested(withDollars(args[at]).replace(SHELL_EXPANSION, () => posixQuoted(value)), "posix")) return refuse(judgement, { kind: "positional-unresolved", file: value });
        }
        const kind = runScript(positional.script, "posix");
        if (kind) return kind;
      }
    }
    if (SCRIPT_RUNNERS.has(program)) {
      const trapArgs = args[0] === "--" ? args.slice(1) : args;
      const script = program === "trap" ? trapArgs[0]?.startsWith("-") ? undefined : trapArgs[0] : args.filter(word => !/^-command$/i.test(word)).map(word => POWERSHELL_SCRIPT_RUNNERS.has(program) ? parenthesizedLiteral(word, judgement.budget) ?? word : word).join(" ");
      const scriptDialect = POWERSHELL_SCRIPT_RUNNERS.has(program) ? "powershell" : "posix";
      if (script === "" && POWERSHELL_SCRIPT_RUNNERS.has(program)) { const kind = stdinScriptKind(segment, pipeline, scriptDialect); if (kind) return kind; }
      else if (script !== undefined) { const kind = runScript(script, scriptDialect); if (kind) return kind; }
    }
    if (includeControl && (program === "source" || program === ".") && args[0] !== undefined && writtenEarlier(args[0])) return refuse(judgement, UNREADABLE_COMMAND);
    if (STDIN_SHELLS.has(program) && !recursed) {
      const source = shellScriptSource(program, args);
      if (includeControl && source.script !== undefined && writtenEarlier(source.script)) return refuse(judgement, UNREADABLE_COMMAND);
      if (source.stdin) {
        const kind = stdinScriptKind(segment, pipeline, SCRIPT_SHELLS.has(program) ? "posix" : program === "cmd" ? "cmd" : "powershell");
        if (kind) return kind;
      }
    }
    const argv = [words[index], ...args];
    if (program === "find") {
      for (let i = 0; i < args.length; i++) if (FIND_OUTPUT_ACTIONS.test(args[i])) { const kind = writeKind(args[i + 1]); if (kind) return kind; }
      if (includeControl && args.includes("-delete")) for (const path of findTouchedPaths(args)) { const kind = kindOf(path); if (kind) return kind; }
    }
    if (ARGUMENT_RUNNERS.has(program) && !recursed) {
      const touched = program === "find" ? findTouchedPaths(args) : [];
      for (const [from, to] of runnerCommands(program, argv)) {
        if (from >= to || programName(argv[from]) === "git") continue;
        const replacement = program === "xargs" ? xargsInvocation(argv, 1).replacement : undefined;
        for (const path of touched.length ? touched : [undefined]) {
          const quoted = argv.slice(from, to).map(word => path !== undefined ? posixQuoted(word.split("{}").join(path))
            : replacement ? word.split(replacement).map(posixQuoted).join(PIPED_INPUT) : posixQuoted(word));
          const command = [...quoted, ...program === "xargs" && !replacement ? [PIPED_INPUT] : []].join(" ");
          const kind = judgeNested(command, "posix", true);
          if (kind) return kind;
        }
      }
    }
    if (includeControl && OPAQUE_RUNNERS.has(program) && !recursed) {
      for (const [from, to] of runnerArguments(program, argv, 0)) {
        for (let j = from; j < to; j++) {
          if (!GIT_WORD.test(argv[j])) continue;
          if (programName(argv[j]) === "git") { if (!gitReadOnly(argv.slice(j + 1, to), true)) return refuse(judgement, UNREADABLE_COMMAND); break; }
          const kind = judgeNested(argv[j], dialect, true);
          if (kind) return kind;
        }
      }
    }
    if (program === "git") {
      const previousBase = base;
      const invocation = gitInvocation(args);
      if (includeControl && (words.slice(0, index).some(word => /^GIT_CONFIG/i.test(word))
        || invocation.globals.some(option => option.name === "--config-env" || option.name === "-c" && /^alias\./i.test(option.value ?? "")))) return refuse(judgement, GIT_CONFIG);
      let worktreeKnown = !baseUnknown;
      for (const option of invocation.globals) {
        if (!includeControl && option.name !== "-C" || !["-C", "--work-tree", "--git-dir"].includes(option.name)) continue;
        const resolved = option.value === undefined || hasShellVariable(option.value, dialect) ? undefined : pathOf(option.value);
        if (includeControl && resolved === undefined && !gitReadOnly(args)) return refuse(judgement, GIT_CONFIG);
        if ((option.name === "-C" || option.name === "--work-tree" && includeControl) && resolved && platform === process.platform) {
          base = resolved;
          worktreeKnown ||= isAbsolute(expandHomePath(option.value!));
        }
      }
      const subAt = args.slice(invocation.sub).findIndex(word => !word.startsWith("-"));
      const pathsAt = args.slice(invocation.sub).indexOf("--");
      const given = args.slice(invocation.sub);
      const previousAt = PREVIOUS_BRANCH_GIT.has(given[subAt]) ? given.findIndex((word, i) => i > subAt && (pathsAt < 0 || i < pathsAt) && word === "-") : -1;
      const gitArgs = given.map((word, i) => i === previousAt ? PREVIOUS_BRANCH : word);
      const writes = gitWriteOptions(gitArgs[0], gitArgs.slice(1));
      if (includeControl && writes.runsProgram) return refuse(judgement, GIT_CONFIG);
      for (const output of writes.outputs) { const kind = writeKind(output); if (kind) return kind; }
      const gitPositional = gitArgs.filter((word) => !word.startsWith("-"));
      const sub = gitPositional[0];
      if (includeControl && WORKTREE_GIT.has(sub)) {
        const tail = gitArgs.slice(gitArgs.indexOf(sub) + 1);
        const unresolved = tail.find((word, i) => !(i > 0 && ["-m", "--message", "-F", "--file"].includes(tail[i - 1])) && !word.startsWith("--message=") && hasShellVariable(word, dialect));
        if (unresolved !== undefined) return refuse(judgement, { kind: "path-unresolved", file: unresolved });
        if (!worktreeKnown) return refuse(judgement, { kind: "directory-unresolved", file: sub });
      }
      if (includeControl && ["mv", "rm"].includes(sub)) { const kind = uncertainKind(segment, gitPositional.slice(1), true); if (kind) return kind; }
      if (sub === "mv") { const kind = kindOf(gitPositional[gitPositional.length - 1]); if (kind) return kind; }
      if (includeControl && platform === process.platform) {
        const tail = gitArgs.slice(gitArgs.indexOf(sub) + 1);
        const dash = tail.indexOf("--");
        const options = dash < 0 ? tail : tail.slice(0, dash);
        const value = (names: string[]) => {
          for (let i = 0; i < options.length; i++) {
            if (names.includes(options[i])) return options[i + 1];
            for (const name of names) if (options[i].startsWith(name + "=")) return options[i].slice(name.length + 1);
          }
          return undefined;
        };
        const positional = (valueOptions: string[]) => options.filter((word, i) => !word.startsWith("-") && !(i > 0 && valueOptions.includes(options[i - 1])));
        const pathArgs = dash < 0 ? positional(["--source", "-s", "-e", "--exclude"]) : tail.slice(dash + 1);
        const existingPath = (word: string) => {
          try { statSync(pathOf(word) ?? resolve(base, word)); return true; }
          catch (error) { return !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
        };
        let paths: string[] | undefined, refs: string[] = [];
        if (sub === "restore") {
          const source = value(["--source", "-s"]) ?? options.find(word => /^-s.+/.test(word))?.slice(2);
          paths = pathArgs;
          if (source) refs = [source];
        } else if (sub === "checkout" || sub === "switch") {
          refs = positional(["-b", "-B", "-c", "-C", "--orphan", "--create", "--force-create"]);
          if (dash >= 0) paths = tail.slice(dash + 1);
          else if (!refs.length && !options.some(word => /^(?:-[bBcC]|--(?:orphan|create|force-create))/.test(word))) paths = [];
        } else if (sub === "reset" && !options.includes("--soft")) {
          refs = positional([]);
          paths = dash >= 0 ? tail.slice(dash + 1) : [];
        } else if (sub === "clean") {
          const flag = (letter: string) => options.some((word, i) => /^-[dfinqxX]+$/.test(word) && !["-e", "--exclude"].includes(options[i - 1]) && word.slice(1).includes(letter));
          if (!options.includes("--dry-run") && !flag("n")) {
            const excludes = options.flatMap((word, i) => word === "-e" || word === "--exclude" ? ["--exclude=" + options[i + 1]]
              : word.startsWith("--exclude=") ? [word] : /^-e.+/.test(word) ? ["--exclude=" + word.slice(2)] : []);
            const listing = ["--others", ...(!flag("d") && !pathArgs.length ? ["--directory", "--no-empty-directory"] : [])];
            if (!flag("X") && refused(gitListedControls(base, pathArgs, configDir, gitCache, [...listing, "--exclude-standard", ...excludes]))) return "control";
            if ((flag("x") || flag("X")) && refused(gitListedControls(base, pathArgs, configDir, gitCache, [...listing, "--ignored", "--exclude-standard", ...excludes.map(exclude => flag("X") ? exclude : exclude.replace("--exclude=", "--exclude=!"))]))) return "control";
          }
        }
        else if (sub === "stash" && ["pop", "apply"].includes(tail[0])) {
          if (dash >= 0 || looping) return refuse(judgement, STASH_UNCLASSIFIED);
          const stash = positional([]).slice(1)[0] ?? "stash@{0}";
          if (refused(stashChangesControls(base, stash, configDir, gitCache, stashRoundTrip))) return "control";
        } else if (sub === "stash" && !["list", "show", "drop", "clear", "create", "store"].includes(tail[0])) {
          if (["push", "save"].includes(stashAction(tail)) && stashPushAll(options)) return refuse(judgement, STASH_IGNORED);
          const pathspec = tail[0] === "push" ? stashPushPathspec(options.slice(1)) ?? (dash >= 0 ? options.slice(1).filter(word => !word.startsWith("-")) : undefined) : [];
          paths = pathspec === undefined ? [] : [...pathspec, ...dash >= 0 ? tail.slice(dash + 1) : []];
        }
        else if (["merge", "rebase", "cherry-pick", "revert", "pull"].includes(sub)) {
          refs = positional(["-m", "--mainline", "-s", "--strategy", "-X", "--strategy-option", "--onto"]);
          if (sub === "rebase" && value(["--onto"])) refs.unshift(value(["--onto"])!);
          if (sub === "pull" && refs.length > 1) refs = refs.slice(1).map(ref => refs[0] + "/" + ref);
          else if (sub === "pull" || !refs.length) refs = ["@{upstream}"];
        } else if (sub === "apply" || sub === "am") {
          if (!options.some(word => ["--check", "--stat", "--numstat", "--summary"].includes(word))) {
            const files = positional(["-p", "--directory", "--include", "--exclude", "--whitespace"]);
            if (files.some(writtenEarlier)) return refuse(judgement, PATCH_UNVERIFIED);
            const strip = Number(value(["-p"]) ?? options.find(word => /^-p\d+$/.test(word))?.slice(2) ?? 1);
            if (refused(patchControls(files, base, configDir, strip, value(["--directory"]) ?? ""))) return "control";
          }
        } else if (sub === "checkout-index") {
          if (value(["--prefix"]) !== undefined || options.includes("--stdin")) return refuse(judgement, { kind: "git-unlisted" });
          if (options.some(word => word === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(word))) paths = [];
          else if (pathArgs.length) paths = pathArgs;
        } else if (sub === "read-tree" && options.includes("-u")) {
          if (value(["--prefix"]) !== undefined) return refuse(judgement, { kind: "git-unlisted" });
          refs = positional([]);
          if (refused(refs.length ? gitControlPaths(base, [], configDir, gitCache) : gitListedControls(base, [], configDir, gitCache))) return "control";
        } else if (sub === "sparse-checkout" && !["list", "check-rules"].includes(tail[0]) || sub === "bisect" && !["log", "visualize", "view", "terms", "help"].includes(tail[0])) {
          if (refused(gitListedControls(base, [], configDir, gitCache))) return "control";
        }
        if (["checkout", "reset"].includes(sub) && refs.length) {
          if (dash < 0 && !refs[0].includes("@{") && (GLOB_CHARACTERS.test(refs[0]) || existingPath(refs[0]))) { paths = [...refs, ...(paths ?? [])]; refs = []; }
          else if (refs.length > 1) { paths = [...refs.slice(1), ...(paths ?? [])]; refs = refs.slice(0, 1); }
        }
        if (["checkout", "reset"].includes(sub) && paths?.some(path => GLOB_CHARACTERS.test(path))) {
          const globs = paths.filter(path => GLOB_CHARACTERS.test(path));
          if (refused(gitListedControls(base, globs, configDir, gitCache))) return "control";
          paths = paths.filter(path => !GLOB_CHARACTERS.test(path));
          if (!paths.length) { base = previousBase; return undefined; }
        }
        if (refs.some(ref => /stash/i.test(ref)) && stashActive(gitCache)) return refuse(judgement, STASH_UNCLASSIFIED);
        for (const ref of refs) if (refused(gitControlPaths(base, paths ?? [], configDir, gitCache, ref))) return "control";
        if (!refs.length && paths && refused(gitControlPaths(base, paths, configDir, gitCache))) return "control";
        if (sub === "reset" && options.includes("--hard") && refs.length && refused(gitControlPaths(base, paths ?? [], configDir, gitCache))) return "control";
        recordStashTrail(base, sub, tail, options, paths ?? [], gitCache);
      }
      if (!includeControl && sub === "restore") {
        const paths = gitArgs.slice(gitArgs.indexOf("restore") + 1).filter((word, i, list) => !word.startsWith("-") && !(i > 0 && ["--source", "-s"].includes(list[i - 1])));
        for (const arg of paths) { const kind = kindOf(arg); if (kind) return kind; }
      }
      if (!includeControl && sub === "checkout") {
        const dash = args.indexOf("--");
        if (dash >= 0) { for (const arg of args.slice(dash + 1)) { const kind = kindOf(arg); if (kind) return kind; } }
      }
      base = previousBase;
    }
    return undefined;
  };
  for (const [position, parsed] of segments.entries()) {
    enterSubshell(parsed.subshell);
    const step = steps[position];
    if (parsed.after !== "&&" && parsed.after !== "|" && chained.size) { poisonVariables(scope, chained, dialect); chained.clear(); }
    const precise = preciseAssignments(parsed, step);
    if (step.opened.some(frame => frame.kind === "loop") && !step.loopsBefore) poisonNames(loopNames(position));
    poisonNames([crude[position]]);
    const program = segmentProgram(parsed).index;
    const aliased = dialect === "powershell" && program < parsed.words.length ? commandName(parsed.words[program], dialect, scope) : undefined;
    if (aliased !== undefined && aliased !== commandName(parsed.words[program], dialect)) {
      poisonNames([segmentAssignedNames({ ...parsed, words: parsed.words.map((word, i) => i === program ? aliased : word) }, dialect, scriptNames)]);
    }
    const prefixes = parsed.words.slice(0, program).filter(word => ASSIGNMENT_RE.test(word));
    commandScope = scope;
    if (program < parsed.words.length && prefixes.length) {
      commandScope = childScope(scope);
      for (const word of prefixes) assignWord(commandScope, word, scope, true);
    }
    hidesAssignments = false;
    for (const variant of segmentVariants(parsed)) {
      const kind = judgeSegment(position, parsed, repeating || step.inLoop, variant);
      if (kind) return kind;
    }
    if (hidesAssignments) makeOpaque(scope);
    for (const [key, value] of precise?.values ?? []) {
      setVariable(scope, key, value);
      if (parsed.after === "&&") chained.add(key.replace(/^\$|^env:/, ""));
    }
    const defined = functionDefinition(parsed, dialect);
    if (defined) defineFunction(scope, defined, { body: parsed.blocks.filter(block => block.script).map(block => block.body).join("\n"), dialect });
    if (step.ended?.kind === "loop") poisonNames(step.loopsBefore > 1 ? [step.ended.variable === undefined ? [] : [step.ended.variable]] : loopNames(step.ended.header));
    const header = step.opened.find(frame => frame.variable !== undefined);
    if (header) {
      const list = step.list === undefined ? undefined : parsed.words.slice(step.list).map(word => expandShellWord(word, scope, dialect, expansion) ?? word);
      setPosixVariable(scope, header.variable!, list === undefined ? null : loopValue(list, dialect));
    }
  }
  return undefined;
}

export function judgeShellWrite(tool: string, input: unknown, configDir: string, platform: NodeJS.Platform = process.platform, cwd = process.cwd(), includeControl = false): GuardDecision {
  const command = inputRecord(input).command;
  if (!runsShellCommand(tool) || typeof command !== "string") return { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const judgement = shellJudgement(command);
  const destination = shellProtectedWrite(command, configDir, platform, cwd, includeControl, judgement, 0, toolDialect(tool));
  return destination === undefined
    ? { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] }
    : { destination, blocked: true, reasons: ["shell"], examinedLines: 0, blockedLines: [], refusal: judgement.refusal ?? CONTROL_WRITE };
}
