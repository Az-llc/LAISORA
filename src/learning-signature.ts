import { createHmac } from "node:crypto";
import { HUMAN_REJECTED_TOOL_RESULT_RE, isUsageLimitResult } from "./guardrail";

export const SIG_VERSION = 1;

export type SignatureGroup = "transient" | "human" | "hook" | "probe" | "counted" | "unclassified";

export interface FailureFacts {
  readonly tool: string;
  readonly input: unknown;
  readonly text: string;
  readonly messageHead: string;
  readonly exitCode?: number;
  readonly httpCodes: readonly number[];
  readonly errnos: readonly string[];
  readonly sdkErrors: readonly string[];
}

export interface SignatureClassRule {
  readonly group: SignatureGroup;
  readonly match: (facts: FailureFacts) => string | undefined;
}

export interface FailureLabel {
  readonly pattern: RegExp;
  readonly text: string;
}

export interface FailureSignature {
  readonly cls: string;
  readonly group: SignatureGroup;
  readonly head: string;
  readonly messageHead: string;
  readonly label?: number;
}

export const PLACEMENT_GUARD_REASON_PREFIX = "LAISORA placement guard:";

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const HEAD_SUBCOMMAND_PROGRAMS = new Set(["git", "npm", "pnpm", "yarn", "gh", "docker", "cargo", "go", "dotnet", "pip"]);
const HEAD_PLAIN_PROGRAMS = new Set(["node", "python", "pwsh", "powershell", "bash", "sh", "cd", "pushd", "set-location"]);
const LEADING_DIRECTORY_CHANGE_RE = /^\s*(?:cd|pushd|set-location(?:\s+-(?:literal)?path)?)\s+(?:"([^"]*)"|'([^']*)'|([^\s"';&|]+))\s*(?:&&|;|\r?\n)\s*/i;
const OPTIONS_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]),
  npm: new Set(["--prefix", "-C", "--workspace", "-w"]),
  pnpm: new Set(["--prefix", "-C", "--dir", "--filter", "-F"]),
  yarn: new Set(["--cwd"]),
};
const KNOWN_ERRNOS = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT",
  "ENOENT", "EACCES", "EPERM", "EBUSY", "EEXIST"]);
const SDK_ERROR_KINDS = ["authentication_failed", "oauth_org_not_allowed", "billing_error", "rate_limit", "overloaded", "server_error"];
const HEAD_KEYWORD_RE = /error|fatal|failed|exception|denied|not found|invalid|cannot|unable/i;
const HOOK_DENIAL_RE = /^PreToolUse(?::[\w|*]+)? hook error:/;
const PROBE_PATH = String.raw`(?:"[^"$\x60\r\n]*"|'[^'\r\n]*'|[^\s"'$\x60;&|<>()[\]{}*?\\]+)`;
const TEST_PROBE_RE = new RegExp(String.raw`^\s*(?:test\s+-[efd]\s+(${PROBE_PATH})|\[\s+-e\s+(${PROBE_PATH})\s+\])\s*$`);
const LIST_PROBE_RE = new RegExp(String.raw`^\s*(ls)\s+(${PROBE_PATH})\s*$`);

function failureOutput(text: string): string {
  return stripToolUseErrorTags(text).replace(/^Exit code \d+(?:\r?\n|$)/, "").trim();
}

function negativeExistenceProbe(facts: FailureFacts): boolean {
  if (!isShellTool(facts.tool)) return false;
  const command = commandOf(facts.input);
  const output = failureOutput(facts.text);
  const test = TEST_PROBE_RE.exec(command);
  if (test && (test[1] ?? test[2]).replace(/^["']|["']$/g, "") !== "") return facts.exitCode === 1 && output === "";
  const list = LIST_PROBE_RE.exec(command);
  if (!list || facts.exitCode === 0) return false;
  const target = list[2].replace(/^["']|["']$/g, "");
  if (!target || target.startsWith("-") || /[*?]/.test(target)) return false;
  const missing = /^ls: (?:cannot access )?(?:'([^'\r\n]+)'|"([^"\r\n]+)"|‘([^’\r\n]+)’|([^\r\n]+)): No such file or directory$/.exec(output);
  if (missing) return (missing[1] ?? missing[2] ?? missing[3] ?? missing[4]) === target;
  return false;
}

const has = (facts: FailureFacts, re: RegExp): boolean => re.test(facts.text);
const httpIn = (facts: FailureFacts, codes: readonly number[]): boolean => facts.httpCodes.some((code) => codes.includes(code));
const errnoIn = (facts: FailureFacts, names: readonly string[]): boolean => facts.errnos.some((name) => names.includes(name));
const sdkIn = (facts: FailureFacts, kinds: readonly string[]): boolean => facts.sdkErrors.some((kind) => kinds.includes(kind));
const when = (cls: string, test: (facts: FailureFacts) => boolean) => (facts: FailureFacts): string | undefined => test(facts) ? cls : undefined;

export const SIGNATURE_CLASSES: readonly SignatureClassRule[] = Object.freeze([
  { group: "unclassified", match: when("hook_error", (f) => HOOK_DENIAL_RE.test(stripToolUseErrorTags(f.text))) },
  { group: "probe", match: when("probe", negativeExistenceProbe) },
  { group: "human", match: when("human", (f) => HUMAN_REJECTED_TOOL_RESULT_RE.test(stripToolUseErrorTags(f.text).trimStart()) || f.text.startsWith(PLACEMENT_GUARD_REASON_PREFIX)) },
  { group: "transient", match: when("net", (f) => errnoIn(f, ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"])
    || has(f, /Could not resolve host|socket hang up|network is unreachable|\b(?:TLS|SSL)\b[^\n]{0,40}\b(?:handshake|connection|connect)\b/i)) },
  { group: "transient", match: when("rate", (f) => httpIn(f, [429]) || has(f, /rate limit|Too Many Requests/i) || isUsageLimitResult(stripToolUseErrorTags(f.text).trimStart()) || sdkIn(f, ["rate_limit"])) },
  { group: "transient", match: when("auth", (f) => httpIn(f, [401, 403, 407])
    || has(f, /Authentication failed|Permission denied \(publickey\)|\bUnauthorized\b|\bForbidden\b|not logged in/i)
    || sdkIn(f, ["authentication_failed", "oauth_org_not_allowed", "billing_error"])) },
  { group: "transient", match: when("svc", (f) => httpIn(f, [500, 502, 503, 504, 529]) || has(f, /\boverloaded\b|Service Unavailable|Bad Gateway/i)
    || sdkIn(f, ["overloaded", "server_error"])) },
  { group: "counted", match: when("edit_not_read", (f) => has(f, /File has not been read yet\. Read it first before writing to it/)) },
  { group: "counted", match: when("edit_mismatch", (f) => has(f, /String to replace not found in file/)) },
  { group: "counted", match: when("edit_multi", (f) => has(f, /Found \d+ matches of the string to replace, but replace_all is false/)) },
  { group: "counted", match: when("input_validation", (f) => has(f, /InputValidationError|Invalid arguments for tool/)) },
  { group: "counted", match: when("tool_timeout", (f) => has(f, /Command timed out/)) },
  { group: "counted", match: when("ps_parse", (f) => has(f, /ParserError|is not a valid statement separator/)) },
  { group: "counted", match: when("cmd_not_found", (f) => f.exitCode === 127 || has(f, /command not found|is not recognized as/)) },
  { group: "counted", match: when("module_not_found", (f) => has(f, /Cannot find module|ModuleNotFoundError/)) },
  { group: "counted", match: (f) => { const code = f.httpCodes.find((c) => c >= 400 && c < 500); return code === undefined ? undefined : `http_${code}`; } },
  { group: "counted", match: when("fs_perm", (f) => errnoIn(f, ["EACCES", "EPERM"])) },
  { group: "counted", match: when("fs_busy", (f) => errnoIn(f, ["EBUSY"])) },
  { group: "counted", match: when("fs_exists", (f) => errnoIn(f, ["EEXIST"])) },
  { group: "counted", match: when("not_found", (f) => errnoIn(f, ["ENOENT"]) || (f.httpCodes.length === 0 && has(f, /No such file|does not exist|not found/i))) },
  { group: "counted", match: (f) => f.exitCode !== undefined && f.messageHead !== "" ? `exit_${f.exitCode}` : undefined },
]);

export const FAILURE_LABELS: Readonly<Record<string, readonly FailureLabel[]>> = Object.freeze({
  ps_parse: [{ pattern: /The token '&&' is not a valid statement separator/, text: "`&&` is not a statement separator in Windows PowerShell 5.1; use `;` or `if ($?) { … }`" }],
  edit_not_read: [{ pattern: /File has not been read yet/, text: "the file was not Read before Edit/Write in this conversation" }],
  edit_mismatch: [{ pattern: /String to replace not found in file/, text: "old_string did not match the file content" }],
  edit_multi: [{ pattern: /Found \d+ matches of the string to replace/, text: "old_string matched more than one place; add surrounding context or set replace_all" }],
  cmd_not_found: [{ pattern: /command not found|is not recognized as/, text: "the command is not installed or not on PATH" }],
  input_validation: [{ pattern: /InputValidationError|Invalid arguments for tool/, text: "the tool input did not match the tool's input schema" }],
  tool_timeout: [{ pattern: /Command timed out/, text: "the command ran past the tool's timeout" }],
  hook_block: [{ pattern: HOOK_DENIAL_RE, text: "a hook denied the call before it ran" }],
});

export function isShellTool(tool: string): boolean { return SHELL_TOOLS.has(tool); }
export function isFileTool(tool: string): boolean { return FILE_TOOLS.has(tool); }

export interface ShellSegment { readonly words: readonly string[]; readonly operators?: readonly number[] }

function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  let delimiter: string | undefined;
  for (const line of lines) {
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }
    kept.push(line);
    const opened = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (opened) delimiter = opened[2];
  }
  return kept.join("\n");
}

export function shellSegments(command: string, trackOperators = false): ShellSegment[] {
  const text = stripHeredocBodies(command);
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let operators: number[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push({ words, ...(trackOperators ? { operators } : {}) }); words = []; operators = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === "\"") {
      let end = i + 1, quoted = "";
      for (; end < text.length; end++) {
        if (text[end] === ch) break;
        if (ch === '"' && text[end] === "\\" && ['"', "\\", "$", "`"].includes(text[end + 1])) { quoted += text[++end]; continue; }
        quoted += text[end];
      }
      word += quoted;
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length && SHELL_ESCAPABLE.has(text[i + 1])) { word += text[i + 1]; inWord = true; i++; continue; }
    if (ch === "\n" || ch === ";") { endSegment(); continue; }
    if (ch === "&" || ch === "|") {
      if (i > 0 && text[i - 1] === ">") { word += ch; inWord = true; continue; }
      if (text[i + 1] === ch) i++;
      endSegment();
      continue;
    }
    if (ch === ">" || ch === "<") {
      const digitPrefix = inWord && /^\d$/.test(word);
      if (!digitPrefix) endWord();
      let op = digitPrefix ? word + ch : ch;
      word = ""; inWord = false;
      if (text[i + 1] === ch) { op += ch; i++; }
      if (text[i + 1] === "&") { let j = i + 2; while (j < text.length && /[\d-]/.test(text[j])) j++; op += text.slice(i + 1, j); i = j - 1; }
      operators.push(words.length); words.push(op);
      continue;
    }
    if (/\s/.test(ch) || ch === "(" || ch === ")" || ch === "{" || ch === "}") { endWord(); continue; }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_ESCAPABLE = new Set([" ", "\t", "'", "\"", "\\", ";", "&", "|", "<", ">", "(", ")", "$", "`"]);

export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

export function segmentProgramIndex(segment: ShellSegment): number {
  let index = 0;
  while (index < segment.words.length && ASSIGNMENT_RE.test(segment.words[index])) index++;
  return index;
}

export interface LeadingDirectoryChange {
  readonly command: string;
  readonly directories: readonly string[];
  readonly uncertain?: boolean;
}

function directoryChangeFailed(directory: string, failureText: string): boolean {
  const normalize = (value: string) => value.replace(/^["']|["']$/g, "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const target = normalize(directory);
  if (!target) return false;
  return failureText.split(/\r?\n/).some((line) => {
    const shell = /(?:^|: )(?:cd|pushd): (.+): (?:No such file or directory|Not a directory|Permission denied)\s*$/i.exec(line);
    if (shell) return normalize(shell[1]) === target;
    const ps = /^(?:Set-Location|cd|pushd)\s*:\s*Cannot find path '([^']+)' because it does not exist\.\s*$/i.exec(line);
    if (!ps) return false;
    const missing = normalize(ps[1]).toLowerCase();
    return missing === target.toLowerCase() || missing.endsWith("/" + target.toLowerCase());
  });
}

export function stripLeadingDirectoryChange(command: string, failureText = ""): LeadingDirectoryChange {
  const directories: string[] = [];
  let rest = command;
  for (;;) {
    const match = LEADING_DIRECTORY_CHANGE_RE.exec(rest);
    if (!match) break;
    const directory = match[1] ?? match[2] ?? match[3];
    if (directoryChangeFailed(directory, failureText)) {
      rest = match[0].replace(/(?:&&|;|\r?\n)\s*$/, "").trimEnd();
      break;
    }
    if (failureText.split(/\r?\n/).some(line => /(?:^|: )(?:cd|pushd|set-location)\s*:/i.test(line))) {
      return { command: match[0].replace(/(?:&&|;|\r?\n)\s*$/, "").trimEnd(), directories, uncertain: true };
    }
    directories.push(directory);
    rest = rest.slice(match[0].length);
  }
  return { command: rest, directories };
}

export function commandSegments(command: string, failureText = ""): ShellSegment[] {
  return shellSegments(stripLeadingDirectoryChange(command, failureText).command).filter((segment) => segmentProgramIndex(segment) < segment.words.length);
}

function subcommandOf(program: string, args: readonly string[]): string | undefined {
  const withValue = OPTIONS_WITH_VALUE[program] ?? new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) { if (withValue.has(arg)) i++; continue; }
    return /^[a-z][a-z0-9-]*$/.test(arg) ? arg : undefined;
  }
  return undefined;
}

export function commandHead(command: string, failureText = ""): string {
  const segment = commandSegments(command, failureText)[0];
  if (!segment) return "other";
  const index = segmentProgramIndex(segment);
  const program = programName(segment.words[index]);
  if (HEAD_SUBCOMMAND_PROGRAMS.has(program)) {
    const sub = subcommandOf(program, segment.words.slice(index + 1));
    return sub ? `${program} ${sub}` : program;
  }
  return HEAD_PLAIN_PROGRAMS.has(program) ? program : "other";
}

function commandOf(input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : "";
}

export function toolHead(tool: string, input: unknown, failureText = ""): string {
  return isShellTool(tool) ? commandHead(commandOf(input), failureText) : "";
}

export function filePathOf(input: unknown): string | undefined {
  const value = input as { file_path?: unknown; notebook_path?: unknown; path?: unknown } | null;
  const path = value?.file_path ?? value?.notebook_path;
  return typeof path === "string" ? path : undefined;
}

export function callKey(tool: string, input: unknown, failureText = ""): string {
  if (isShellTool(tool)) return `${tool}\u0000${toolHead(tool, input, failureText)}`;
  if (isFileTool(tool)) {
    const path = filePathOf(input);
    if (path !== undefined) return `${tool}\u0000${path.replace(/\\/g, "/").toLowerCase()}`;
  }
  return tool;
}

function stripToolUseErrorTags(text: string): string {
  return text.replace(/<\/?tool_use_error>/g, "");
}

function normalizeHeadLine(line: string): string {
  const quoted = line.replace(/"[^"\n]*"|(?<![A-Za-z])'[^'\n]*'(?![A-Za-z])|`[^`\n]*`|“[^”\n]*”/g, " <q> ");
  const tokens = quoted.split(/\s+/).map((token) => token === "<q>" ? token
    : /[\\/]/.test(token) || /^[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,6}[:,;)\]]*$/.test(token) ? "<path>" : token);
  return tokens.join(" ")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function messageHead(text: string): string {
  const lines = stripToolUseErrorTags(text).split(/\r?\n/);
  if (lines.length && /^Exit code \d+\s*$/.test(lines[0])) lines.shift();
  const candidates = lines.filter((line) => line.trim() !== "");
  const chosen = candidates.find((line) => HEAD_KEYWORD_RE.test(line)) ?? candidates[0] ?? "";
  return normalizeHeadLine(chosen);
}

export function failureFacts(tool: string, text: string, input?: unknown): FailureFacts {
  const exit = /^Exit code (\d+)/.exec(text);
  const httpCodes: number[] = [];
  for (const re of [/HTTP\/\d(?:\.\d)?\s+(\d{3})\b/g, /\bHTTP\s(\d{3})\b/g, /\bstatus(?: code)?[:=\s]+(\d{3})\b/gi, /\b(404) Not Found\b/g]) {
    for (const match of text.matchAll(re)) httpCodes.push(Number(match[1]));
  }
  const errnos = [...new Set([...text.matchAll(/\b(E[A-Z][A-Z_]+)\b/g)].map((m) => m[1]).filter((name) => KNOWN_ERRNOS.has(name)))];
  const sdkErrors = SDK_ERROR_KINDS.filter((kind) => new RegExp(`\\b${kind}\\b`).test(text));
  return { tool, input, text, messageHead: messageHead(text), ...(exit ? { exitCode: Number(exit[1]) } : {}), httpCodes, errnos, sdkErrors };
}

export function classifyFailure(tool: string, text: string, input: unknown, table: readonly SignatureClassRule[] = SIGNATURE_CLASSES,
  labels: Readonly<Record<string, readonly FailureLabel[]>> = FAILURE_LABELS): FailureSignature {
  const facts = failureFacts(tool, text, input);
  const head = toolHead(tool, input, text);
  for (const rule of table) {
    const cls = rule.match(facts);
    if (cls === undefined) continue;
    const index = (labels[cls] ?? []).findIndex((label) => label.pattern.test(text));
    return { cls, group: rule.group, head, messageHead: facts.messageHead, ...(index >= 0 ? { label: index } : {}) };
  }
  return { cls: "unclassified", group: "unclassified", head, messageHead: facts.messageHead };
}

export function failureSig(installKey: Uint8Array, tool: string, signature: Pick<FailureSignature, "cls" | "head" | "messageHead">, version = SIG_VERSION): string {
  return createHmac("sha256", installKey).update([String(version), tool, signature.cls, signature.head, signature.messageHead].join("|"), "utf8").digest("hex").slice(0, 32);
}

export function failureLabelText(cls: string, label: number | undefined, labels: Readonly<Record<string, readonly FailureLabel[]>> = FAILURE_LABELS): string | undefined {
  return label === undefined ? undefined : labels[cls]?.[label]?.text;
}
