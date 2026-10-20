import { programName, segmentProgramIndex, shellSegments, isShellTool, PLACEMENT_GUARD_REASON_PREFIX } from "./learning-signature";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, AGY_EFFORTS } from "./orchestration-executors";
import { resolve, join, basename, dirname, win32, posix } from "node:path";
import fs, { readdirSync, statSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { realPathOrNearestSync, resolveNearestRealPathSync, expandHomePath } from "./path-containment";

export type ProtectedKind = "memory" | "CLAUDE.md" | "AGENTS.md" | "rules";
export type GuardReason = "cooccurrence" | "model-name" | "shell";

import type { Placement } from "./placement-line";
export { placementOf } from "./placement-line";

export const DELEGATE_CONTROL_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} only the conductor changes instruction, settings and hook files; return a proposed change in the reply instead.`;
export const PLACEMENT_UNREADABLE_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} the current content of this protected file could not be read, so the edit cannot be checked. Retry once the file is readable.`;
export function placementGuardReason(placement: Placement): string {
  return `${PLACEMENT_GUARD_REASON_PREFIX} this write targets persistent instructions. Session-only instructions are not persisted; keep them in this conversation. ${placement.learningEnabled ? "Record model-specific observations through the learning tool; standing" : "Standing"} model choices belong in roster or conductor policy settings. Please do not retry by removing or paraphrasing names. Please use Write or Edit for shell writes so the content can be checked.`;
}

export const PLACEMENT_EFFORT_WORDS: readonly string[] = Object.freeze([...new Set<string>([...CLAUDE_EFFORTS, ...CODEX_EFFORTS, ...AGY_EFFORTS])]);
export const DEFAULT_ROLE_NAMES: readonly string[] = Object.freeze(["worker", "explorer", "reviewer"]);
const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"];
const MODEL_NAME_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?<![A-Za-z0-9_])(?:${CLAUDE_ALIASES.join("|")})(?![A-Za-z0-9_])`, "i"),
  /(?<![A-Za-z0-9_])(?:claude|opus|sonnet|haiku|fable|gemini|gpt)[- ]?\d+(?:\.\d+)*/i,
  /(?<![A-Za-z0-9_])claude-[a-z]+-\d/i,
];

export interface PlacementVocabulary {
  readonly names: readonly string[];
  readonly effortWords: readonly string[];
  readonly roleNames: readonly string[];
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
  return { names: wordPattern(vocabulary.names, WORD_BEFORE + PATH_SEGMENT_BEFORE), qualifiers: wordPattern([...vocabulary.effortWords, ...vocabulary.roleNames]), listed: wordPattern(vocabulary.listedModelIds) };
}

export interface LineVerdict {
  readonly cooccurrence: boolean;
  readonly modelName: boolean;
}

export function lineVerdict(line: string, vocabulary: CompiledVocabulary): LineVerdict {
  const cooccurrence = !!vocabulary.names?.test(line) && (!!vocabulary.qualifiers?.test(line) || /実装|レビュー|委任|分担|得意/.test(line));
  const modelName = MODEL_NAME_PATTERNS.some((re) => re.test(line)) || !!vocabulary.listed?.test(line);
  return { cooccurrence, modelName };
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
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

export function applyEdits(content: string, edits: readonly EditOperation[]): string | undefined {
  let result = content;
  for (const edit of edits) {
    if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string" || edit.old_string === "" || !result.includes(edit.old_string)) return undefined;
    result = edit.replace_all ? result.split(edit.old_string).join(edit.new_string) : result.replace(edit.old_string, () => edit.new_string);
  }
  return result;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  let text = value.trim().replace(/\\/g, "/");
  if (platform === "win32") {
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(text);
    if (msys) text = `${msys[1]}:${msys[2] ?? "/"}`;
    text = text.toLowerCase();
  }
  return text.replace(/\/+/g, "/");
}

export function placementPath(value: string, cwd = process.cwd(), canonical = true): string | undefined {
  let path = expandHomePath(value);
  if (/[$*?]|\$\(/.test(path)) return undefined;
  if (process.platform === "win32") path = path.replace(/^\/([a-z])(?=\/)/i, "$1:");
  const requested = resolve(cwd, path);
  return canonical ? realPathOrNearestSync(requested) ?? undefined : requested;
}

const UNREADABLE_REAL_PATH = Symbol("unreadable real path");
function canonicalPlacement(value: string, cwd = process.cwd()): string | typeof UNREADABLE_REAL_PATH | undefined {
  const requested = placementPath(value, cwd, false);
  if (requested === undefined) return undefined;
  const result = resolveNearestRealPathSync(requested);
  return "path" in result ? result.path : result.unresolved === "error" ? UNREADABLE_REAL_PATH : undefined;
}

export function controlFileContext(configDir: string) {
  const roots: { path: string; requested: string; kind: ProtectedKind | "control"; directory: boolean }[] = [];
  let unknown = false;
  const add = (path: string, kind: ProtectedKind | "control", directory = true) => {
    const canonical = canonicalPlacement(path);
    if (canonical === UNREADABLE_REAL_PATH) unknown = true;
    else if (canonical) roots.push({ requested: path, path: normalizedPath(canonical, process.platform).replace(/\/$/, ""), kind, directory });
  };
  try { for (const project of readdirSync(join(configDir, "projects"))) add(join(configDir, "projects", project, "memory"), "memory"); }
  catch (error) { unknown = !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
  add(join(configDir, "rules"), "rules");
  add(join(configDir, "hooks"), "control");
  add(join(configDir, "settings.json"), "control", false);
  return { roots, unknown };
}
type ControlFileContext = ReturnType<typeof controlFileContext>;

export function protectedDestination(filePath: string, configDir: string, platform: NodeJS.Platform = process.platform, context?: ControlFileContext): ProtectedKind | undefined {
  const requested = platform === process.platform ? placementPath(filePath, process.cwd(), false) ?? filePath : filePath;
  const config = normalizedPath(configDir, platform).replace(/\/$/, "");
  const classify = (path: string): ProtectedKind | undefined => {
    const target = normalizedPath(path, platform);
    const name = target.split("/").pop() ?? "";
    const fold = (value: string) => platform === "win32" ? value.toLowerCase() : value;
    const underConfig = (sub: string) => target === `${config}/${sub}` || target.startsWith(`${config}/${sub}/`) || target.startsWith(`~/.claude/${sub}/`) || target.startsWith(`$home/.claude/${sub}/`);
    if (new RegExp(`^${escape(config)}/projects/[^/]+/memory(?:/|$)`).test(target) || /(^|\/)\.claude\/projects\/[^/]+\/memory(?:\/|$)/.test(target)) return "memory";
    if ([fold("CLAUDE.md"), fold("CLAUDE.local.md")].includes(name)) return "CLAUDE.md";
    if (name === fold("AGENTS.md")) return "AGENTS.md";
    if (underConfig("rules") || /(^|\/)\.claude\/rules(?:\/|$)/.test(target)) return "rules";
    return undefined;
  };
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
  const names = platform === "win32" ? ["claude.md", "claude.local.md", "agents.md"] : ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
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
  readonly skipped?: "edit-does-not-apply";
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

export function resultingContent(tool: string, input: unknown, current: string | undefined): string | undefined {
  const value = inputRecord(input);
  if (tool === "Write") return typeof value.content === "string" ? value.content : undefined;
  if (current === undefined) return undefined;
  if (tool === "Edit") return applyEdits(current, [value as unknown as EditOperation]);
  if (tool === "MultiEdit") return Array.isArray(value.edits) ? applyEdits(current, value.edits as EditOperation[]) : undefined;
  return undefined;
}

export type MemoryActor = "conductor" | "delegate";
export type MemoryReason = "delegate" | "untyped" | "type" | "index-target-missing" | "index-line";

export interface MemoryDecision {
  readonly destination?: "memory";
  readonly blocked: boolean;
  readonly reasons: MemoryReason[];
  readonly blockedLines: string[];
  readonly type?: string;
  readonly skipped?: "edit-does-not-apply";
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

function readMemoryFile(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

export function judgeMemoryWrite(tool: string, input: unknown, current: string | undefined, actor: MemoryActor, memoryTypes: readonly string[], configDir: string,
  platform: NodeJS.Platform = process.platform, readFile: (path: string) => string | undefined = readMemoryFile): MemoryDecision {
  const filePath = inputRecord(input).file_path;
  if (typeof filePath !== "string" || protectedDestination(filePath, configDir, platform) !== "memory") return { blocked: false, reasons: [], blockedLines: [] };
  const destination = "memory";
  if (actor === "delegate") return { destination, blocked: true, reasons: ["delegate"], blockedLines: [] };
  const after = resultingContent(tool, input, current);
  if (after === undefined) return { destination, blocked: false, reasons: [], blockedLines: [], skipped: "edit-does-not-apply" };
  if (after.trim() === "") return { destination, blocked: false, reasons: [], blockedLines: [] };
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
  const reason = decision.reasons.includes("delegate") ? "only the conductor writes memory; delegates must not write memory" : "this memory write has an invalid topic type or index entry";
  return `${PLACEMENT_GUARD_REASON_PREFIX} ${reason}. ${placement.memoryDestination}. Topic frontmatter must contain only single-line key: value lines (top level, or indented two spaces under metadata:) with one plain type in [${placement.memoryTypes.join(", ")}]; index additions must link to existing, typed topic files in the same directory. Do not retry by changing the type.`;
}

export function judgeFileWrite(tool: string, input: unknown, current: string | undefined, vocabulary: CompiledVocabulary | undefined, configDir: string,
  platform: NodeJS.Platform = process.platform): GuardDecision {
  const filePath = inputRecord(input).file_path;
  const destination = typeof filePath === "string" ? protectedDestination(filePath, configDir, platform) : undefined;
  if (destination === undefined) return { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const after = resultingContent(tool, input, current);
  if (after === undefined) return { destination, blocked: false, reasons: [], examinedLines: 0, blockedLines: [], skipped: "edit-does-not-apply" };
  if (!vocabulary) return { destination, blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const lines = addedLines(current, after);
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

const REDIRECT_RE = /^\d?>>?$/;
const CONTENT_CMDLETS = new Set(["set-content", "add-content", "out-file", "new-item", "tee", "tee-object"]);
const POWERSHELL_CMDLET_ALIASES: Record<string, string> = { ni: "new-item", sc: "set-content", ac: "add-content" };
const COPY_PROGRAMS = new Set(["cp", "mv", "ln", "copy", "move"]);
const COPY_CMDLETS = new Set(["copy-item", "move-item", "cpi", "mi"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
const INLINE_RUNNERS = new Set(["python", "python3", "node", "pwsh", "powershell"]);
const INLINE_FLAGS = new Set(["-c", "-e", "-command", "--eval", "-p"]);
const POWERSHELL_COMMON_VALUES = ["erroraction", "warningaction", "informationaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable"];
const POWERSHELL_PROVIDER_VALUES = ["path", "literalpath", "filter", "include", "exclude", "credential"];
const POWERSHELL_WRITE_SWITCHES = ["force", "whatif", "confirm", "usetransaction"];
const POWERSHELL_PARAMETERS: Record<string, { values: readonly string[]; switches: readonly string[] }> = {
  "set-content": { values: [...POWERSHELL_PROVIDER_VALUES, "value", "encoding", "stream"], switches: [...POWERSHELL_WRITE_SWITCHES, "passthru", "nonewline"] },
  "add-content": { values: [...POWERSHELL_PROVIDER_VALUES, "value", "encoding", "stream"], switches: [...POWERSHELL_WRITE_SWITCHES, "passthru", "nonewline"] },
  "out-file": { values: ["filepath", "literalpath", "encoding", "width", "inputobject"], switches: ["force", "whatif", "confirm", "append", "noclobber", "nonewline"] },
  "copy-item": { values: [...POWERSHELL_PROVIDER_VALUES, "destination", "fromsession", "tosession"], switches: [...POWERSHELL_WRITE_SWITCHES, "container", "recurse", "passthru"] },
  "remove-item": { values: POWERSHELL_PROVIDER_VALUES, switches: [...POWERSHELL_WRITE_SWITCHES, "recurse"] },
  "move-item": { values: [...POWERSHELL_PROVIDER_VALUES, "destination"], switches: [...POWERSHELL_WRITE_SWITCHES, "passthru"] },
  "new-item": { values: ["path", "name", "itemtype", "value", "credential"], switches: POWERSHELL_WRITE_SWITCHES },
  "tee-object": { values: ["filepath", "literalpath", "inputobject", "variable"], switches: ["append"] },
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

function executablePosition(script: string, position: number): boolean {
  let quote = "", comment = "";
  for (let i = 0; i < position; i++) {
    if (comment) {
      if (comment === "line" && script[i] === "\n") comment = "";
      else if (comment === "block" && script[i] === "*" && script[i + 1] === "/") { comment = ""; i++; }
      continue;
    }
    if (quote) { if (script[i] === "\\") i++; else if (script[i] === quote) quote = ""; continue; }
    if (script[i] === "#" || script[i] === "/" && script[i + 1] === "/") { comment = "line"; continue; }
    if (script[i] === "/" && script[i + 1] === "*") { comment = "block"; i++; continue; }
    if (["'", '"', "`"].includes(script[i])) quote = script[i];
  }
  return !quote && !comment;
}

function containsControlLocation(path: string, configDir: string): boolean {
  const canonical = canonicalPlacement(path);
  if (canonical === UNREADABLE_REAL_PATH) return true;
  if (!canonical) return false;
  try { if (!statSync(canonical).isDirectory()) return false; }
  catch (error) { return !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
  if (normalizedPath(path, process.platform).replace(/\/$/, "").split("/").pop() === ".claude") return true;
  const context = controlFileContext(configDir);
  if (context.unknown) return true;
  const target = normalizedPath(canonical, process.platform).replace(/\/$/, "");
  if (context.roots.some(root => root.path === target || root.path.startsWith(target + "/"))) return true;
  const pending = [canonical], visited = new Set<string>();
  let entriesSeen = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const real = canonicalPlacement(directory);
    if (real === UNREADABLE_REAL_PATH) return true;
    if (!real || visited.has(real)) continue;
    visited.add(real);
    if (normalizedPath(real, process.platform).split("/").pop() === ".claude") return true;
    try {
      for (const entry of readdirSync(real, { withFileTypes: true })) {
        if (++entriesSeen > 20_000) return true;
        const name = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
        if ((process.platform === "win32" ? [".claude", "claude.md", "claude.local.md", "agents.md"] : [".claude", "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]).includes(name)) return true;
        const child = join(real, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink() && statSync(child).isDirectory()) pending.push(child);
      }
    } catch { return true; }
  }
  return false;
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
  try { return new RegExp("^" + expression + "$", platform === "win32" ? "i" : "").test(name); }
  catch { return true; }
}

function expandedCopySources(sources: readonly string[], cwd: string): string[] | undefined {
  try {
    return sources.flatMap(source => {
      if (!GLOB_CHARACTERS.test(source)) return [source];
      const pattern = expandHomePath(source).replace(/\\/g, "/");
      if (typeof fs.globSync === "function") return fs.globSync(pattern, { cwd });
      const parent = dirname(pattern), name = basename(pattern);
      try { return readdirSync(resolve(cwd, parent)).filter(entry => globCouldMatch(name, entry, process.platform)).map(entry => join(parent, entry)); }
      catch (error) { if (ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
    });
  } catch { return undefined; }
}

function overlapsControlLocation(path: string, configDir: string): boolean {
  const context = controlFileContext(configDir);
  if (isControlFile(path, configDir, process.platform, context)) return true;
  const canonical = canonicalPlacement(path);
  if (canonical === UNREADABLE_REAL_PATH) return true;
  if (canonical) {
    const target = normalizedPath(canonical, process.platform).replace(/\/$/, "");
    if (context.roots.some(root => root.path === target || root.path.startsWith(target + "/"))) return true;
  }
  return containsControlLocation(path, configDir);
}

function recursiveCopyControls(source: string, destination: string, configDir: string): boolean {
  const pending = [{ source, destination, ancestors: new Set<string>() }];
  let visited = 0;
  const context = controlFileContext(configDir);
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 20_000 || isControlFile(item.destination, configDir, process.platform, context)) return true;
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

const CONTROL_PATHSPECS = ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude", "**/.claude/settings*.json", "**/.claude/rules/**", "**/.claude/hooks/**", "**/.claude/projects/*/memory/**"]
  .map(path => (process.platform === "win32" ? ":(top,glob,icase)" : ":(top,glob)") + path);

const GIT_INERT_CONFIG: readonly (readonly [string, string])[] = [["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"]];
const GIT_INERT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
const GIT_FILTER_DRIVER_KEY = /^filter\.(.+)\.(clean|process)$/;
const GIT_GITLINK_ENTRY = /^160000 [0-9a-f]+ \d\t([\s\S]+)$/;
const GIT_READ_OPTIONS: ExecFileSyncOptionsWithStringEncoding = { shell: false, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
const gitEnvByJudgement = new WeakMap<Map<string, boolean>, Map<string, NodeJS.ProcessEnv>>();

export function gitInertEnv(filterDrivers: Iterable<string> = []): NodeJS.ProcessEnv {
  const entries = [...GIT_INERT_CONFIG, ...[...new Set(filterDrivers)].flatMap(driver =>
    [[`filter.${driver}.clean`, ""], [`filter.${driver}.process`, ""], [`filter.${driver}.required`, "false"]] as const)];
  const start = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_INERT_ENV, GIT_CONFIG_COUNT: String(start + entries.length) };
  entries.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${start + i}`] = key; env[`GIT_CONFIG_VALUE_${start + i}`] = value; });
  return env;
}

function repositoryGitEnv(cwd: string, cache: Map<string, boolean>): NodeJS.ProcessEnv {
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

function gitReader(cwd: string, cache: Map<string, boolean>): (args: string[]) => string {
  return args => execFileSync("git", args, { ...GIT_READ_OPTIONS, cwd, env: repositoryGitEnv(cwd, cache) });
}

function gitControlPaths(cwd: string, paths: readonly string[], configDir: string, cache: Map<string, boolean>, target?: string, stash = false): boolean {
  const key = JSON.stringify([cwd, paths, target, stash]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const read = gitReader(cwd, cache);
  let blocked: boolean;
  try {
    const tree = read(["rev-parse", "--show-toplevel"]).trim();
    const specs = paths.length ? [...paths] : CONTROL_PATHSPECS;
    const status = !stash && (target === undefined || read(["rev-parse", "--verify", "--end-of-options", target + "^{commit}"]).trim() === read(["rev-parse", "--verify", "HEAD"]).trim());
    let listed: string;
    if (stash) {
      const args = ["stash", "show", "--name-only", "-z", "--no-ext-diff", "--no-textconv"];
      try { listed = read([...args, "--include-untracked", target ?? "stash@{0}"]); }
      catch { listed = read([...args, target ?? "stash@{0}"]); }
    } else listed = status
      ? read(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=dirty", "--", ...specs])
      : read(["diff", "--name-only", "--no-ext-diff", "--no-textconv", "--no-relative", "-z", "HEAD", target!, "--", ...specs]);
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
    blocked = files.some(file => isControlPath(resolve(tree, file), configDir));
  } catch (error) {
    blocked = stash || target !== undefined || !/not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? ""));
  }
  cache.set(key, blocked);
  return blocked;
}

function gitListedControls(cwd: string, paths: readonly string[], configDir: string, cache: Map<string, boolean>, options: readonly string[] = []): boolean {
  const args = ["ls-files", "-z", ...options, "--", ...paths];
  const key = JSON.stringify([cwd, args]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let blocked: boolean;
  try {
    const listed = gitReader(cwd, cache)(args);
    blocked = listed.split("\0").filter(Boolean).some(file => !file.endsWith("/") && isControlPath(resolve(cwd, file), configDir));
  } catch (error) { blocked = !/not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? "")); }
  cache.set(key, blocked);
  return blocked;
}

function patchControls(files: readonly string[], cwd: string, configDir: string, strip = 1, directory = ""): boolean {
  if (!files.length) return true;
  try {
    for (const file of files) {
      const patch = readFileSync(resolve(cwd, file), "utf8");
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
          if (isControlPath(resolve(cwd, directory, name), configDir)) return true;
        }
      }
    }
    return false;
  } catch { return true; }
}

export function shellProtectedWrite(command: string, configDir: string, platform: NodeJS.Platform = process.platform, cwd = process.cwd(), includeControl = false, gitCache = new Map<string, boolean>()): ProtectedKind | "control" | undefined {
  let base = cwd;
  const kindOf = (word: string | undefined): ProtectedKind | "control" | undefined => {
    if (word === undefined) return undefined;
    if (includeControl && GLOB_CHARACTERS.test(word)) {
      const normalized = word.replace(/\\/g, "/");
      const specific = /[^*?\[\]{}]/.test(normalized.split("/").pop() ?? "");
      const inspect = (pattern: string): boolean => {
        const wildcard = pattern.search(GLOB_CHARACTERS);
        if (wildcard < 0) {
          const path = platform === process.platform ? placementPath(pattern, base, false) : pattern;
          return !!path && (isControlFile(path, configDir, platform) || platform === process.platform && overlapsControlLocation(path, configDir));
        }
        const slash = pattern.lastIndexOf("/", wildcard);
        const prefix = pattern.slice(0, slash + 1) || ".";
        const rest = pattern.slice(slash + 1);
        const next = rest.indexOf("/");
        const segment = next < 0 ? rest : rest.slice(0, next);
        const path = platform === process.platform ? placementPath(prefix, base, false) : prefix;
        if (!path) return false;
        if (next < 0) {
          if (isControlFile(path, configDir, platform)) return true;
          const names = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
          if (specific && names.some(name => globCouldMatch(segment, name, platform))) return true;
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
            if (next < 0 ? overlapsControlLocation(matched, configDir) : inspect(matched.replace(/\\/g, "/") + rest.slice(next))) return true;
          }
        } catch (error) { return !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
        return false;
      };
      if (inspect(normalized)) return "control";
      return undefined;
    }
    if (/[$*?]/.test(word.replace(/^\$HOME/i, ""))) return undefined;
    const path = platform === process.platform ? placementPath(word, base, false) : word;
    return path === undefined ? undefined : protectedDestination(path, configDir, platform)
      ?? (includeControl && isControlFile(path, configDir, platform) ? "control" : undefined);
  };
  const uncertainKind = (args: readonly string[], directories = false): ProtectedKind | "control" | undefined => {
    for (const arg of args) {
      const token = arg.startsWith("-") && arg.includes(":") ? arg.slice(arg.indexOf(":") + 1) : arg;
      for (const value of token.split(/,(?![^{}]*\})/)) {
        const kind = kindOf(value); if (kind) return kind;
        if (directories && platform === process.platform) {
          const path = placementPath(value, base, false);
          if (path && containsControlLocation(path, configDir)) return "control";
        }
      }
    }
    return undefined;
  };
  const copyKind = (destination: string | undefined, sources: readonly string[], directory = false, recursive = false, contents = false): ProtectedKind | "control" | undefined => {
    const direct = kindOf(destination);
    if (direct || destination === undefined) return direct;
    directory ||= /[\\/]$/.test(destination);
    if (platform === process.platform) {
      const path = canonicalPlacement(destination, base);
      if (path === UNREADABLE_REAL_PATH) directory = true;
      else if (path) {
        try { directory ||= statSync(path).isDirectory(); }
        catch (error) { directory ||= !ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? ""); }
      }
    }
    if (includeControl && platform === process.platform) {
      const expanded = expandedCopySources(sources, base);
      if (!expanded) return "control";
      sources = expanded;
    }
    if (includeControl && recursive && platform === process.platform) {
      const target = placementPath(destination, base, false);
      for (const source of sources) {
        const from = placementPath(source, base, false);
        if (from && target && recursiveCopyControls(from, directory && !contents && !/[\\/]\.$/.test(source) ? join(target, basename(from)) : target, configDir)) return "control";
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
    const path = placementPath(link, base, false);
    if (!path) return undefined;
    if (overlapsControlLocation(path, configDir)) return "control";
    for (const target of targets) {
      for (const from of new Set([placementPath(target, base, false), placementPath(target, dirname(path), false)])) {
        if (!from) continue;
        if (hard ? overlapsControlLocation(from, configDir) : recursiveCopyControls(from, path, configDir)) return "control";
      }
    }
    return undefined;
  };
  const inlineKind = (program: string, script: string): ProtectedKind | "control" | undefined => {
    if (program === "pwsh" || program === "powershell") return shellProtectedWrite(script, configDir, platform, base, includeControl, gitCache);
    const patterns = program === "node" ? [
      /\bfs(?:\.promises)?\.(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\s*\(\s*(['"])(.*?)\1/g,
    ] : [
      /\bopen\s*\(\s*(['"])(.*?)\1\s*,\s*(?:mode\s*=\s*)?['"][wax][bt+]*['"]/g,
      /\b(?:Path|pathlib\.Path)\s*\(\s*(['"])(.*?)\1\s*\)\.(?:write_text|write_bytes)\s*\(/g,
    ];
    for (const pattern of patterns) for (const match of script.matchAll(pattern)) {
      if (!executablePosition(script, match.index)) continue;
      const kind = kindOf(match[2]); if (kind) return kind;
    }
    return undefined;
  };
  const parsedCommand = includeControl ? command.replace(/@\{[^{}\s;&|<>]+\}|\{[^{}\s;&|<>]*,[^{}\s;&|<>]*\}/g,
    (literal, offset: number) => executablePosition(command, offset) ? literal.replace(/[{}]/g, (brace: string) => "'" + brace + "'") : literal) : command;
  for (const segment of shellSegments(parsedCommand, true)) {
    const words = segment.words;
    for (let i = 0; i < words.length - 1; i++) if (segment.operators?.includes(i) && REDIRECT_RE.test(words[i])) { const kind = kindOf(words[i + 1]); if (kind) return kind; }
    const index = segmentProgramIndex(segment);
    if (index >= words.length) continue;
    const program = POWERSHELL_CMDLET_ALIASES[programName(words[index])] ?? programName(words[index]);
    const args = words.slice(index + 1);
    const positional = args.filter((word) => !word.startsWith("-"));
    if (["cd", "set-location", "pushd", "push-location"].includes(program)) {
      const flag = args.findIndex(word => /^-(?:path|literalpath)$/i.test(word));
      const directory = args[flag >= 0 ? flag + 1 : 0];
      if (directory && platform === process.platform) base = placementPath(directory, base, false) ?? base;
    }
    if (includeControl && ["rm", "del", "erase", "remove-item", "ri", "rmdir"].includes(program)) {
      const parsed = powershellArguments("remove-item", args);
      const targets = [...parsed.positional, ...[parsed.named.get("-path"), parsed.named.get("-literalpath")].filter((value): value is string => value !== undefined)];
      const kind = uncertainKind(parsed.uncertain ? args : targets, true);
      if (kind) return kind;
    }
    if (program === "tee") {
      for (const arg of positional) { const kind = kindOf(arg); if (kind) return kind; }
    } else if (CONTENT_CMDLETS.has(program)) {
      const parsed = powershellArguments(program, args);
      if (parsed.uncertain) { const kind = uncertainKind(args); if (kind) return kind; }
      const kind = kindOf(parsed.named.get("-literalpath") ?? parsed.named.get("-path") ?? parsed.named.get("-filepath") ?? parsed.positional[0]);
      if (kind) return kind;
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
      for (const arg of targets) { const kind = kindOf(arg); if (kind) return kind; }
    }
    const powershellCopy = COPY_CMDLETS.has(program) || COPY_PROGRAMS.has(program) && args.some(word => /^-(?:path|literalpath|destination)(?::|$)/i.test(word));
    if (COPY_PROGRAMS.has(program) && !powershellCopy) {
      const flag = args.findIndex(word => word === "--target-directory" || /^-[^-]*t$/.test(word));
      const inline = args.find(word => word.startsWith("--target-directory="));
      const destination = flag >= 0 ? args[flag + 1] : inline ? inline.slice("--target-directory=".length) : positional[positional.length - 1];
      const sources = args.filter((word, i) => !word.startsWith("-") && !(flag >= 0 && i === flag + 1) && !(i > 0 && ["-S", "--suffix"].includes(args[i - 1])));
      if (flag < 0 && !inline) sources.pop();
      if (includeControl && ["mv", "move"].includes(program)) { const kind = uncertainKind(sources, true); if (kind) return kind; }
      const kind = copyKind(destination, sources, flag >= 0 || !!inline, program === "cp" && args.some(word => /^-[^-]*[rRa]/.test(word) || word === "--recursive" || word === "--archive"));
      if (kind) return kind;
      if (includeControl && program === "cp" && platform === process.platform && args.some(word => /^-[^-]*l/.test(word) || word === "--link")) {
        const expanded = expandedCopySources(sources, base);
        if (!expanded || expanded.some(source => { const from = placementPath(source, base, false); return !from || overlapsControlLocation(from, configDir); })) return "control";
      }
      if (includeControl && program === "ln" && destination !== undefined) {
        const hard = !args.some(word => /^-[^-]*s/.test(word) || word === "--symbolic");
        const replace = args.some(word => /^-[^-]*[nT]/.test(word) || word === "--no-dereference" || word === "--no-target-directory");
        const targets = sources.length ? sources : [destination];
        let links = sources.length ? [destination] : [basename(destination.replace(/[\\/]+$/, ""))];
        if (sources.length && platform === process.platform) {
          const path = placementPath(destination, base, false);
          let directory = flag >= 0 || !!inline, linked = false;
          try { if (path) { linked = fs.lstatSync(path).isSymbolicLink(); directory ||= statSync(path).isDirectory(); } }
          catch (error) { if (!ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? "")) return "control"; }
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
        const kind = shellProtectedWrite(rest.length === 1 ? rest[0] : rest.map(word => /\s/.test(word) ? `"${word}"` : word).join(" "), configDir, platform, base, includeControl, gitCache);
        if (kind) return kind;
      }
    }
    if (powershellCopy) {
      const parsed = powershellArguments(program === "move-item" || program === "mi" || program === "mv" || program === "move" ? "move-item" : "copy-item", args);
      if (parsed.uncertain) { const kind = uncertainKind(args); if (kind) return kind; }
      const source = parsed.named.get("-literalpath") ?? parsed.named.get("-path");
      const destination = parsed.named.get("-destination") ?? parsed.positional[source === undefined ? 1 : 0];
      const sources = source === undefined ? parsed.positional.slice(0, parsed.named.has("-destination") ? undefined : 1) : [source];
      if (includeControl && ["move-item", "mi", "mv", "move"].includes(program)) { const kind = uncertainKind(sources, true); if (kind) return kind; }
      const kind = copyKind(destination, sources.flatMap(value => value.split(/,(?![^{}]*\})/)), false, args.some(word => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::|$)/i.test(word)));
      if (kind) return kind;
    }
    if (includeControl && ["robocopy", "xcopy"].includes(program)) {
      const paths = args.filter(word => !/^\/[a-z]+(?::.*)?$/i.test(word) && !word.startsWith("-"));
      const kind = copyKind(paths[1], paths.slice(0, 1), true, true, true);
      if (kind) return kind;
    }
    if (INLINE_RUNNERS.has(program)) {
      const flag = args.findIndex((word) => INLINE_FLAGS.has(word.toLowerCase()));
      if (flag >= 0 && flag + 1 < args.length) { const kind = inlineKind(program, args[flag + 1]); if (kind) return kind; }
    }
    if (program === "git") {
      const previousBase = base;
      if (!includeControl) {
        const directory = args.indexOf("-C");
        if (directory >= 0 && args[directory + 1] && platform === process.platform) base = placementPath(args[directory + 1], base, false) ?? base;
      } else {
        for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
          if (GIT_VALUE_OPTIONS.has(args[i])) {
            const option = args[i++];
            if (["-C", "--work-tree"].includes(option) && args[i] && platform === process.platform) base = placementPath(args[i], base, false) ?? base;
          } else if (args[i].startsWith("--work-tree=") && platform === process.platform) base = placementPath(args[i].slice(12), base, false) ?? base;
        }
      }
      let subIndex = 0;
      while (subIndex < args.length && args[subIndex].startsWith("-")) subIndex += GIT_VALUE_OPTIONS.has(args[subIndex]) ? 2 : 1;
      const gitArgs = args.slice(subIndex);
      const gitPositional = gitArgs.filter((word) => !word.startsWith("-"));
      const sub = gitPositional[0];
      if (includeControl && ["mv", "rm"].includes(sub)) { const kind = uncertainKind(gitPositional.slice(1), true); if (kind) return kind; }
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
          try { statSync(resolve(base, word)); return true; }
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
            if (!flag("X") && gitListedControls(base, pathArgs, configDir, gitCache, [...listing, "--exclude-standard", ...excludes])) return "control";
            if ((flag("x") || flag("X")) && gitListedControls(base, pathArgs, configDir, gitCache, [...listing, "--ignored", "--exclude-standard", ...excludes.map(exclude => flag("X") ? exclude : exclude.replace("--exclude=", "--exclude=!"))])) return "control";
          }
        }
        else if (sub === "stash" && ["pop", "apply"].includes(tail[0])) {
          const stash = positional([]).slice(1)[0] ?? "stash@{0}";
          if (gitControlPaths(base, [], configDir, gitCache, stash, true)) return "control";
        } else if (sub === "stash" && !["list", "show", "drop", "clear", "create", "store"].includes(tail[0])) paths = dash >= 0 ? tail.slice(dash + 1) : [];
        else if (["merge", "rebase", "cherry-pick", "revert", "pull"].includes(sub)) {
          refs = positional(["-m", "--mainline", "-s", "--strategy", "-X", "--strategy-option", "--onto"]);
          if (sub === "rebase" && value(["--onto"])) refs.unshift(value(["--onto"])!);
          if (sub === "pull" && refs.length > 1) refs = refs.slice(1).map(ref => refs[0] + "/" + ref);
          else if (sub === "pull" || !refs.length) refs = ["@{upstream}"];
        } else if (sub === "apply" || sub === "am") {
          if (!options.some(word => ["--check", "--stat", "--numstat", "--summary"].includes(word))) {
            const files = positional(["-p", "--directory", "--include", "--exclude", "--whitespace"]);
            const strip = Number(value(["-p"]) ?? options.find(word => /^-p\d+$/.test(word))?.slice(2) ?? 1);
            if (patchControls(files, base, configDir, strip, value(["--directory"]) ?? "")) return "control";
          }
        }
        if (["checkout", "reset"].includes(sub) && refs.length) {
          if (GLOB_CHARACTERS.test(refs[0]) || existingPath(refs[0])) { paths = [...refs, ...(paths ?? [])]; refs = []; }
          else if (refs.length > 1) { paths = [...refs.slice(1), ...(paths ?? [])]; refs = refs.slice(0, 1); }
        }
        if (["checkout", "reset"].includes(sub) && paths?.some(path => GLOB_CHARACTERS.test(path))) {
          const globs = paths.filter(path => GLOB_CHARACTERS.test(path));
          if (gitListedControls(base, globs, configDir, gitCache)) return "control";
          paths = paths.filter(path => !GLOB_CHARACTERS.test(path));
          if (!paths.length) { base = previousBase; continue; }
        }
        for (const ref of refs) if (gitControlPaths(base, paths ?? [], configDir, gitCache, ref)) return "control";
        if (!refs.length && paths && gitControlPaths(base, paths, configDir, gitCache)) return "control";
        if (sub === "reset" && options.includes("--hard") && refs.length && gitControlPaths(base, paths ?? [], configDir, gitCache)) return "control";
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
  }
  return undefined;
}

export function judgeShellWrite(tool: string, input: unknown, configDir: string, platform: NodeJS.Platform = process.platform, cwd = process.cwd(), includeControl = false): GuardDecision {
  const command = inputRecord(input).command;
  if (!isShellTool(tool) || typeof command !== "string") return { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const destination = shellProtectedWrite(command, configDir, platform, cwd, includeControl);
  return destination === undefined
    ? { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] }
    : { destination, blocked: true, reasons: ["shell"], examinedLines: 0, blockedLines: [] };
}
