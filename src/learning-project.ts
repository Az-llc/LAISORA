import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import * as path from "node:path";
import { realPathOrNearestSync } from "./path-containment";
import { commandSegments, filePathOf, isFileTool, isShellTool, programName, segmentProgramIndex, shellSegments, stripLeadingDirectoryChange } from "./learning-signature";

export const UNKNOWN_PROJECT = "unknown";

export type GitCommonDirState = { readonly kind: "git"; readonly commonDir: string } | { readonly kind: "not-git" } | { readonly kind: "failed" };

export function gitCommonDirState(dir: string, timeoutMs = 5000): Promise<GitCommonDirState> {
  return new Promise((done) => {
    execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: dir, shell: false, windowsHide: true, encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
        if (!error) {
          const commonDir = stdout.trim();
          done(commonDir ? { kind: "git", commonDir } : { kind: "failed" });
          return;
        }
        const code = (error as { code?: unknown }).code;
        done(code === 128 && /not a git repository/i.test(String(stderr)) ? { kind: "not-git" } : { kind: "failed" });
      });
  });
}

function caseKey(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function projectIdOf(installKey: Uint8Array, state: GitCommonDirState | undefined, workFolderReal: string | undefined,
  commonDirReal: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (!state || state.kind === "failed" || workFolderReal === undefined) return UNKNOWN_PROJECT;
  const source = state.kind === "git"
    ? commonDirReal === undefined ? undefined : `git:${caseKey(commonDirReal, platform)}`
    : `dir:${caseKey(workFolderReal, platform)}`;
  return source === undefined ? UNKNOWN_PROJECT : createHmac("sha256", installKey).update(source, "utf8").digest("hex").slice(0, 32);
}

export interface HookEntry {
  readonly event: string;
  readonly matcher: string;
  readonly commands: readonly string[];
}

export function hookEntriesOf(settings: unknown): HookEntry[] {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const entries: HookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const value = group as { matcher?: unknown; hooks?: unknown };
      const commands = Array.isArray(value?.hooks)
        ? value.hooks.map((hook) => (hook as { command?: unknown })?.command).filter((command): command is string => typeof command === "string")
        : [];
      entries.push({ event, matcher: typeof value?.matcher === "string" ? value.matcher : "", commands });
    }
  }
  return entries;
}

function hookMatches(entry: HookEntry, event: string, tool: string): boolean {
  if (entry.event !== event) return false;
  if (entry.matcher === "" || entry.matcher === "*") return true;
  try { return new RegExp(`^(?:${entry.matcher})$`).test(tool); } catch { return entry.matcher === tool; }
}

export interface ProjectDefinition {
  readonly workFolder: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly exists: (absolutePath: string) => boolean | undefined;
  readonly hasPackageJson: boolean | undefined;
  readonly projectHooks: readonly HookEntry[] | undefined;
  readonly userHooks: readonly HookEntry[] | undefined;
}

export type ProjectReason = "P1" | "P2" | "P3" | "P4" | "P5";

export interface ProjectJudgment {
  readonly specific: boolean;
  readonly reasons: readonly ProjectReason[];
  readonly held: readonly ProjectReason[];
}

export interface FailedCall {
  readonly tool: string;
  readonly input: unknown;
  readonly text: string;
  readonly cls: string;
}

const pathApi = (platform: NodeJS.Platform) => platform === "win32" ? path.win32 : path.posix;
const CWD_NOTE_RE = /Note: your current working directory is [^\n]*/g;
const MISSING_LINE_RE = /no such file|does not exist|not found|cannot find|cannot access|is not recognized|could not find/i;
const PATH_TOKEN_SPLIT_RE = /[\s"'`<>()[\]{},;=|]+/;
const SCRIPT_RUNNERS = new Set(["node", "python", "python3", "pwsh", "powershell", "bash", "sh"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const P5_EXACT_WORDS = new Set(["--prefix", "-C", "-c", "-e"]);
const P5_FOLDED_WORDS = new Set(["cd", "pushd", "set-location"]);
const NOT_FOUND_CLASSES = new Set(["not_found", "module_not_found", "cmd_not_found"]);

export function resolveMentionedPath(token: string, baseFolder: string | undefined, homeDir: string, platform: NodeJS.Platform, literal = false): string | undefined {
  const cleaned = literal ? token : token.replace(/[:.,;]+$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (!cleaned || /:\/\//.test(cleaned) || /[$%*?]/.test(cleaned)) return undefined;
  const api = pathApi(platform);
  let candidate = cleaned;
  if (platform === "win32") {
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(candidate);
    if (msys) candidate = `${msys[1].toUpperCase()}:${msys[2] ?? "/"}`;
  }
  if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) candidate = api.join(homeDir, candidate.slice(1));
  if (baseFolder === undefined) return api.isAbsolute(candidate) ? api.resolve(candidate) : undefined;
  return api.resolve(baseFolder, candidate);
}

export interface ShellCommandContext {
  readonly command: string;
  readonly baseFolder: string | undefined;
  readonly uncertain?: boolean;
}

export function shellCommandContext(command: string, workFolder: string, homeDir: string, platform: NodeJS.Platform, failureText = ""): ShellCommandContext {
  const stripped = stripLeadingDirectoryChange(command, failureText);
  let baseFolder: string | undefined = workFolder;
  for (const directory of stripped.directories) baseFolder = baseFolder === undefined ? undefined : resolveMentionedPath(directory, baseFolder, homeDir, platform);
  return { command: stripped.command, baseFolder, ...(stripped.uncertain ? { uncertain: true } : {}) };
}

export function isInsideFolder(folder: string, target: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const root = caseKey(api.resolve(folder), platform);
  const value = caseKey(api.resolve(target), platform);
  return value === root || value.startsWith(root.endsWith(api.sep) ? root : root + api.sep);
}

const FILE_EXTENSION_RE = /^[\w.-]+\.(?:[cm]?[jt]sx?|json[c5l]?|md|mdx|py|ps[dm]?1|sh|bash|css|scss|html?|txt|ya?ml|toml|log|lock|ini|cfg|xml|csv|bat|cmd|exe|dll|go|rs|java|kt|cs|rb|php|sql|svg|png|jpe?g|pdf|zip|vsix|env)$/i;

function looksLikePath(token: string): boolean {
  return /[\\/]/.test(token) || FILE_EXTENSION_RE.test(token.replace(/[:.,;]+$/, ""));
}

export function pathTokens(text: string): string[] {
  return text.replace(CWD_NOTE_RE, " ").split(PATH_TOKEN_SPLIT_RE).filter((token) => token.length > 1 && looksLikePath(token));
}

const CONTENT_FIELDS = new Set(["content", "old_string", "new_string", "edits", "new_source"]);

function argumentValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) argumentValues(entry, out);
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) if (!CONTENT_FIELDS.has(key)) argumentValues(entry, out);
  return out;
}

function commandOf(input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : "";
}

export function directoryChangeWord(command: string): boolean {
  return shellSegments(command).some((segment) => segment.words.some((word) =>
    P5_EXACT_WORDS.has(word) || word.startsWith("--prefix=") || P5_FOLDED_WORDS.has(word.toLowerCase())));
}

function launchedScripts(command: string): string[] {
  const scripts: string[] = [];
  for (const segment of commandSegments(command)) {
    const index = segmentProgramIndex(segment);
    const programWord = segment.words[index];
    if (looksLikePath(programWord)) scripts.push(programWord);
    if (SCRIPT_RUNNERS.has(programName(programWord))) {
      const argument = segment.words.slice(index + 1).find((word) => !word.startsWith("-") && looksLikePath(word));
      if (argument !== undefined) scripts.push(argument);
    }
  }
  return scripts;
}

function runsPackageScript(command: string): boolean {
  return commandSegments(command).some((segment) => {
    const index = segmentProgramIndex(segment);
    if (!PACKAGE_MANAGERS.has(programName(segment.words[index]))) return false;
    const sub = segment.words.slice(index + 1).find((word) => !word.startsWith("-"));
    return sub === "run" || sub === "run-script" || sub === "test" || sub === "start";
  });
}

function hookJudgment(call: FailedCall, def: ProjectDefinition): boolean | undefined {
  const origin = /^(\w+):([\w|*]+) hook error:/.exec(call.text);
  if (def.projectHooks === undefined) return undefined;
  const scriptNames = def.projectHooks.flatMap((entry) => entry.commands)
    .flatMap((command) => pathTokens(command).map((token) => token.split(/[\\/]/).pop() ?? token));
  if (scriptNames.some((name) => name.length > 3 && call.text.includes(name))) return true;
  if (!origin) return false;
  const [, event, tool] = origin;
  const inProject = def.projectHooks.some((entry) => hookMatches(entry, event, tool));
  if (!inProject) return false;
  if (def.userHooks === undefined) return undefined;
  return !def.userHooks.some((entry) => hookMatches(entry, event, tool));
}

function packageJsonAt(baseFolder: string | undefined, def: ProjectDefinition): boolean | undefined {
  if (baseFolder === undefined || !isInsideFolder(def.workFolder, baseFolder, def.platform)) return false;
  if (caseKey(pathApi(def.platform).resolve(baseFolder), def.platform) === caseKey(pathApi(def.platform).resolve(def.workFolder), def.platform)) return def.hasPackageJson;
  return def.exists(pathApi(def.platform).join(baseFolder, "package.json"));
}

function missingTargets(call: FailedCall): string[] {
  if (isFileTool(call.tool)) {
    const file = filePathOf(call.input);
    return file === undefined ? [] : [file];
  }
  const fromInput = ["Grep", "Glob"].includes(call.tool) && typeof (call.input as { path?: unknown } | null)?.path === "string"
    ? [(call.input as { path: string }).path] : [];
  const lines = call.text.replace(CWD_NOTE_RE, " ").split(/\r?\n/).filter((line) => MISSING_LINE_RE.test(line));
  return [...fromInput, ...lines.flatMap(pathTokens)];
}

export function projectSpecificByCause(call: FailedCall, def: ProjectDefinition): ProjectJudgment {
  const reasons: ProjectReason[] = [];
  const held: ProjectReason[] = [];
  const shell = isShellTool(call.tool) ? shellCommandContext(commandOf(call.input), def.workFolder, def.homeDir, def.platform, call.text) : undefined;
  const baseFolder = shell ? shell.baseFolder : def.workFolder;
  const inside = (token: string): string | undefined => {
    const resolved = resolveMentionedPath(token, baseFolder, def.homeDir, def.platform);
    return resolved !== undefined && isInsideFolder(def.workFolder, resolved, def.platform) ? resolved : undefined;
  };
  if (shell) {
    let p1: boolean | undefined = false;
    for (const script of launchedScripts(shell.command)) {
      const resolved = inside(script);
      if (resolved === undefined) continue;
      const exists = def.exists(resolved);
      if (exists === true) { p1 = true; break; }
      if (exists === undefined) p1 = undefined;
    }
    if (p1 === true) reasons.push("P1"); else if (p1 === undefined) held.push("P1");
    if (runsPackageScript(shell.command)) {
      const packageJson = packageJsonAt(shell.baseFolder, def);
      if (packageJson === true) reasons.push("P2"); else if (packageJson === undefined) held.push("P2");
    }
    if (directoryChangeWord(shell.command)) reasons.push("P5");
  }
  if (call.cls === "hook_block") {
    const judged = hookJudgment(call, def);
    if (judged === true) reasons.push("P3"); else if (judged === undefined) held.push("P3");
  }
  if (NOT_FOUND_CLASSES.has(call.cls) && missingTargets(call).some((token) => inside(token) !== undefined)) reasons.push("P4");
  return { specific: reasons.length > 0, reasons, held: reasons.length > 0 ? [] : held };
}

export function projectSpecificLiteral(call: FailedCall, workFolder: string, homeDir: string, platform: NodeJS.Platform): boolean {
  const shell = isShellTool(call.tool) ? shellCommandContext(commandOf(call.input), workFolder, homeDir, platform, call.text) : undefined;
  const input = shell ? { ...(call.input as Record<string, unknown>), command: shell.command } : call.input;
  const baseFolder = shell ? shell.baseFolder : workFolder;
  const texts = argumentValues(input);
  return texts.some((text) => pathTokens(text).some((token) => {
    const resolved = resolveMentionedPath(token, baseFolder, homeDir, platform);
    return resolved !== undefined && isInsideFolder(workFolder, resolved, platform);
  }));
}

export function projectSpecificP5(call: FailedCall): boolean {
  return isShellTool(call.tool) && directoryChangeWord(stripLeadingDirectoryChange(commandOf(call.input), call.text).command);
}

export function projectSpecific(call: FailedCall, workFolder: string, homeDir: string, platform: NodeJS.Platform, includeP5 = false): boolean {
  return projectSpecificLiteral(call, workFolder, homeDir, platform) || includeP5 && projectSpecificP5(call);
}

export function projectLiteralJudgment(call: FailedCall, workFolder: string, homeDir: string): "project" | "general" | "unknown" {
  const root = realPathOrNearestSync(workFolder);
  if (!root) return "unknown";
  const shell = isShellTool(call.tool) ? shellCommandContext(commandOf(call.input), workFolder, homeDir, process.platform, call.text) : undefined;
  if (shell && (shell.uncertain || shell.baseFolder === undefined || /(?:cd|pushd|set-location)\s*:/i.test(call.text) && shell.command !== commandOf(call.input)
    && !/^(?:cd|pushd|set-location)\b/i.test(shell.command))) return "unknown";
  const base = shell?.baseFolder ?? workFolder;
  const candidates: { value: string; literal: boolean }[] = [];
  const add = (value: string, literal = false) => candidates.push({ value, literal });
  const collect = (value: unknown, field = "") => {
    if (CONTENT_FIELDS.has(field)) return;
    if (typeof value === "string") {
      if (["file_path", "notebook_path", "path", "cwd", "files"].includes(field)) add(value, true);
      else pathTokens(value).forEach(token => add(token));
    } else if (Array.isArray(value)) for (const entry of value) collect(entry, field);
    else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) collect(entry, key);
  };
  if (shell) for (const segment of shellSegments(shell.command)) {
    const index = segmentProgramIndex(segment);
    if (["cd", "pushd", "set-location"].includes(programName(segment.words[index] ?? ""))) {
      const directory = segment.words.slice(index + 1).find(word => !word.startsWith("-"));
      if (directory) add(directory, true);
    } else {
      const program = programName(segment.words[index] ?? "");
      const options = new Set(["--prefix", "--file", "--config", "--project", "--directory", "--cwd", "--git-dir", "--work-tree", "--input", "--output"]);
      if (["make", "gmake", "awk", "gawk", "grep", "rg", "sed", "psql", "kubectl", "powershell", "pwsh"].includes(program)
        || ["docker", "podman"].includes(program) && segment.words[index + 1] === "build") options.add("-f");
      const shortPaths: Record<string, readonly string[]> = {
        git: ["-C"], tar: ["-C", "-f", "-T", "-X"], ninja: ["-C", "-f"], make: ["-C", "-f", "-I"], gmake: ["-C", "-f", "-I"],
        cmake: ["-S", "-B", "-C"], ctest: ["-S"], zip: ["-b"], unzip: ["-d"], patch: ["-d", "-i", "-o"],
      };
      for (const option of shortPaths[program] ?? []) options.add(option);
      const words = segment.words.slice(index + 1);
      for (let i = 0; i < words.length; i++) {
        const word = words[i], equals = word.indexOf("=");
        if (options.has(word)) {
          if (words[i + 1] !== undefined) add(words[++i], true);
        } else if (equals > 0 && options.has(word.slice(0, equals))) add(word.slice(equals + 1), true);
        else if (word.length > 2 && options.has(word.slice(0, 2)) && !word.startsWith("--")) add(word.slice(2), true);
        else pathTokens(word).forEach(token => add(token));
      }
    }
  } else collect(call.input);
  let unknown = false;
  for (const token of candidates) {
    const resolved = resolveMentionedPath(token.value, base, homeDir, process.platform, token.literal);
    const real = resolved === undefined ? null : realPathOrNearestSync(resolved);
    if (!real) { unknown = true; continue; }
    if (isInsideFolder(root, real, process.platform)) return "project";
  }
  return unknown ? "unknown" : "general";
}
