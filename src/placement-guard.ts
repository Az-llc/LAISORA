import { programName, segmentProgramIndex, shellSegments, isShellTool, PLACEMENT_GUARD_REASON_PREFIX } from "./learning-signature";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, AGY_EFFORTS } from "./orchestration-executors";
import { resolve, join, basename } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { realPathOrNearestSync, resolveNearestRealPathSync, expandHomePath } from "./path-containment";

export type ProtectedKind = "memory" | "CLAUDE.md" | "AGENTS.md" | "rules";
export type GuardReason = "cooccurrence" | "model-name" | "shell";

export { PLACEMENT_LINE } from "./placement-line";

export const PLACEMENT_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} this write targets persistent instructions. Session-only instructions are not persisted; keep them in this conversation. Record model-specific observations through the learning tool; standing model choices belong in roster or conductor policy settings. Please do not retry by removing or paraphrasing names. Please use Write or Edit for shell writes so the content can be checked.`;
export const PLACEMENT_UNREADABLE_REFUSAL = `${PLACEMENT_GUARD_REASON_PREFIX} the current content of this protected file could not be read, so the edit cannot be checked. Retry once the file is readable.`;
export function placementGuardReason(_kind: ProtectedKind, _learningEnabled: boolean): string { return PLACEMENT_REFUSAL; }

export function placementGuardShellReason(kind: ProtectedKind): string {
  return placementGuardReason(kind, true);
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
function wordPattern(words: readonly string[]): RegExp | undefined {
  const unique = [...new Set(words.filter((word) => word.trim() !== ""))].sort((a, b) => b.length - a.length);
  return unique.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${unique.map(escape).join("|")})(?![A-Za-z0-9_])`, "i") : undefined;
}

export interface CompiledVocabulary {
  readonly names?: RegExp;
  readonly qualifiers?: RegExp;
  readonly listed?: RegExp;
}

export function compileVocabulary(vocabulary: PlacementVocabulary): CompiledVocabulary {
  return { names: wordPattern(vocabulary.names), qualifiers: wordPattern([...vocabulary.effortWords, ...vocabulary.roleNames]), listed: wordPattern(vocabulary.listedModelIds) };
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

export function protectedDestination(filePath: string, configDir: string, platform: NodeJS.Platform = process.platform): ProtectedKind | undefined {
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

export interface GuardDecision {
  readonly destination?: ProtectedKind;
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

export function judgeFileWrite(tool: string, input: unknown, current: string | undefined, vocabulary: CompiledVocabulary, configDir: string,
  platform: NodeJS.Platform = process.platform): GuardDecision {
  const filePath = inputRecord(input).file_path;
  const destination = typeof filePath === "string" ? protectedDestination(filePath, configDir, platform) : undefined;
  if (destination === undefined) return { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const after = resultingContent(tool, input, current);
  if (after === undefined) return { destination, blocked: false, reasons: [], examinedLines: 0, blockedLines: [], skipped: "edit-does-not-apply" };
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

export function shellProtectedWrite(command: string, configDir: string, platform: NodeJS.Platform = process.platform, cwd = process.cwd()): ProtectedKind | undefined {
  let base = cwd;
  const kindOf = (word: string | undefined): ProtectedKind | undefined => {
    if (word === undefined || /[$*?]/.test(word.replace(/^\$HOME/i, ""))) return undefined;
    const path = platform === process.platform ? placementPath(word, base, false) : word;
    return path === undefined ? undefined : protectedDestination(path, configDir, platform);
  };
  const uncertainKind = (args: readonly string[]): ProtectedKind | undefined => {
    for (const arg of args) {
      const token = arg.startsWith("-") && arg.includes(":") ? arg.slice(arg.indexOf(":") + 1) : arg;
      for (const value of token.split(",")) { const kind = kindOf(value); if (kind) return kind; }
    }
    return undefined;
  };
  const copyKind = (destination: string | undefined, sources: readonly string[], directory = false): ProtectedKind | undefined => {
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
    if (!directory) return undefined;
    for (const source of sources) {
      const name = basename(source.replace(/[\\/]+$/, "").replace(/\\/g, "/"));
      const kind = kindOf(`${destination.replace(/[\\/]+$/, "")}/${name}`);
      if (kind) return kind;
    }
    return undefined;
  };
  const inlineKind = (program: string, script: string): ProtectedKind | undefined => {
    if (program === "pwsh" || program === "powershell") return shellProtectedWrite(script, configDir, platform, base);
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
  for (const segment of shellSegments(command, true)) {
    const words = segment.words;
    for (let i = 0; i < words.length - 1; i++) if (segment.operators?.includes(i) && REDIRECT_RE.test(words[i])) { const kind = kindOf(words[i + 1]); if (kind) return kind; }
    const index = segmentProgramIndex(segment);
    if (index >= words.length) continue;
    const program = programName(words[index]);
    const args = words.slice(index + 1);
    const positional = args.filter((word) => !word.startsWith("-"));
    if (["cd", "set-location", "pushd", "push-location"].includes(program)) {
      const flag = args.findIndex(word => /^-(?:path|literalpath)$/i.test(word));
      const directory = args[flag >= 0 ? flag + 1 : 0];
      if (directory && platform === process.platform) base = placementPath(directory, base, false) ?? base;
    }
    if (program === "tee") {
      for (const arg of positional) { const kind = kindOf(arg); if (kind) return kind; }
    } else if (CONTENT_CMDLETS.has(program)) {
      const parsed = powershellArguments(program, args);
      if (parsed.uncertain) { const kind = uncertainKind(args); if (kind) return kind; }
      const kind = kindOf(parsed.named.get("-literalpath") ?? parsed.named.get("-path") ?? parsed.named.get("-filepath") ?? parsed.positional[0]);
      if (kind) return kind;
    }
    if ((program === "sed" || program === "perl") && args.some((word) => /^-[a-zA-Z]*i/.test(word) || /^--in-place(?:=|$)/.test(word))) {
      const targets = args.filter((word, i) => !word.startsWith("-") && !(i > 0 && ["-e", "-f", "--expression", "--file"].includes(args[i - 1])))
        .slice(args.some(word => ["-e", "-f", "--expression", "--file"].includes(word)) ? 0 : 1);
      for (const arg of targets) { const kind = kindOf(arg); if (kind) return kind; }
    }
    const powershellCopy = COPY_CMDLETS.has(program) || COPY_PROGRAMS.has(program) && args.some(word => /^-(?:path|literalpath|destination)(?::|$)/i.test(word));
    if (COPY_PROGRAMS.has(program) && !powershellCopy) {
      const flag = args.findIndex(word => word === "-t" || word === "--target-directory");
      const inline = args.find(word => word.startsWith("--target-directory="));
      const destination = flag >= 0 ? args[flag + 1] : inline ? inline.slice("--target-directory=".length) : positional[positional.length - 1];
      const sources = args.filter((word, i) => !word.startsWith("-") && !(i > 0 && ["-t", "--target-directory", "-S", "--suffix"].includes(args[i - 1])));
      if (flag < 0 && !inline) sources.pop();
      const kind = copyKind(destination, sources, flag >= 0 || !!inline);
      if (kind) return kind;
    }
    if (powershellCopy) {
      const parsed = powershellArguments(program === "move-item" || program === "mi" || program === "mv" || program === "move" ? "move-item" : "copy-item", args);
      if (parsed.uncertain) { const kind = uncertainKind(args); if (kind) return kind; }
      const source = parsed.named.get("-literalpath") ?? parsed.named.get("-path");
      const destination = parsed.named.get("-destination") ?? parsed.positional[source === undefined ? 1 : 0];
      const sources = source === undefined ? parsed.positional.slice(0, parsed.named.has("-destination") ? undefined : 1) : [source];
      const kind = copyKind(destination, sources.flatMap(value => value.split(",")));
      if (kind) return kind;
    }
    if (INLINE_RUNNERS.has(program)) {
      const flag = args.findIndex((word) => INLINE_FLAGS.has(word.toLowerCase()));
      if (flag >= 0 && flag + 1 < args.length) { const kind = inlineKind(program, args[flag + 1]); if (kind) return kind; }
    }
    if (program === "git") {
      const directory = args.indexOf("-C");
      const previousBase = base;
      if (directory >= 0 && args[directory + 1] && platform === process.platform) base = placementPath(args[directory + 1], base, false) ?? base;
      const gitArgs = args.filter((_, i) => !GIT_VALUE_OPTIONS.has(args[i]) && !(i > 0 && GIT_VALUE_OPTIONS.has(args[i - 1])));
      const gitPositional = gitArgs.filter((word) => !word.startsWith("-"));
      const sub = gitPositional[0];
      if (sub === "mv") { const kind = kindOf(gitPositional[gitPositional.length - 1]); if (kind) return kind; }
      if (sub === "restore") {
        const paths = gitArgs.slice(gitArgs.indexOf("restore") + 1).filter((word, i, list) => !word.startsWith("-") && !(i > 0 && ["--source", "-s"].includes(list[i - 1])));
        for (const arg of paths) { const kind = kindOf(arg); if (kind) return kind; }
      }
      if (sub === "checkout") {
        const dash = args.indexOf("--");
        if (dash >= 0) { for (const arg of args.slice(dash + 1)) { const kind = kindOf(arg); if (kind) return kind; } }
      }
      base = previousBase;
    }
  }
  return undefined;
}

export function judgeShellWrite(tool: string, input: unknown, configDir: string, platform: NodeJS.Platform = process.platform, cwd = process.cwd()): GuardDecision {
  const command = inputRecord(input).command;
  if (!isShellTool(tool) || typeof command !== "string") return { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] };
  const destination = shellProtectedWrite(command, configDir, platform, cwd);
  return destination === undefined
    ? { blocked: false, reasons: [], examinedLines: 0, blockedLines: [] }
    : { destination, blocked: true, reasons: ["shell"], examinedLines: 0, blockedLines: [] };
}
