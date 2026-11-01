import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { claudeSettingsFiles } from "./claude-env";
import {
  IMPROVEMENT_CANDIDATE_RETRY_WINDOW as CANDIDATE_RETRY_WINDOW, IMPROVEMENT_INDEX_LOCATIONS as INDEX_LOCATIONS, IMPROVEMENT_MIN_CONVERSATIONS, IMPROVEMENT_RETRY_WINDOW as RETRY_WINDOW, IMPROVEMENT_TOOL_FILE,
  VERDICT_KINDS, isImprovementFirstMessage, lastVerdictsBlock, parseVerdicts, type ImprovementVerdict,
} from "./improvement-brief";
import { parseLaisoraInput } from "./laisora-input";
import { classifyToolFailure, isShellTool, stripToolUseErrorTags, type ToolFailureKind, type ToolFailureRecord } from "./tool-result-signals";
import { ASK_UNANSWERED_KINDS, askUnansweredQuestions, type AskUnansweredKind } from "./ask-unanswered";
import { singleToolUseResult } from "./edit-summary";

export const IMPROVEMENT_LINE_MAX_CHARS = 16 * 1024 * 1024;
const RETRY_SIM = 0.8;
const CANDIDATE_RETRY_SIM = 0.5;
const INDEX_DAYS = 6;
const INDEX_MASKED_OWNERS = 16;
const COMPACT_DETAIL_CHARS = 50;
const INDEX_SLOW = 8;
const INDEX_CAUSES = 24;
const OWNER_TAIL_MIN_CONVERSATIONS = 3;
const CLASS_MEMBER_CAP = 12;
const SIGNATURE_CHARS = 60;
const SPLIT_WORDS = 3;
const OTHER_REASONS = "other reasons";
const OWNER_REASONS_SHOWN = 2;
const OWNER_REASON_CHARS = 50;
const SLOW_CALL_SEC = 60;
const IMPROVEMENT_MARKER_SCAN_LINES = 400;
const HOOK_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const LAISORA_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
const HOOK_SCRIPT_RE = /\.(?:mjs|cjs|js|ts|py|ps1|sh|bash|cmd|bat)$/i;
const SOURCE_HEAD_MIN = 16;
const LAISORA_HEAD_MIN = 20;

export type PatternKind = ToolFailureKind | "hook_failure";

export const LISTED_IN_ANY_CONVERSATION: readonly PatternKind[] = ["hook_denial", "hook_failure", "classifier_denial", "permission_prompt", "safety_check"];
const PROMPT_DETAIL_CHARS = 100;

function hookReason(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = lines[0] ?? "";
  return /[:：]$/.test(head) && lines[1] ? `${head} ${lines[1]}` : head;
}
export const LISTED_FROM_MIN_CONVERSATIONS: readonly PatternKind[] = ["nonzero_exit", "mcp_tool_error", "other"];

export interface ScanLocation {
  readonly path: string;
  readonly ref: string;
  readonly line: number;
  readonly at: string | null;
  readonly actor: "main" | "subagent";
  readonly tool: string;
}

export interface ScanPattern {
  id: string;
  readonly key: string;
  kind: PatternKind | "candidate" | "slow";
  owner: string;
  detail: string;
  sample: string;
  ownerFixed?: boolean;
  uncertain?: string;
  site?: string;
  siteStrong?: boolean;
  script?: string;
  variants: Map<string, { count: number; first: string | null; last: string | null }>;
  durationsSec: number[];
  backgrounded: number;
  classifierChecked: number;
  shapes: Map<string, { count: number; ref: string }>;
  recovery: number[];
  recoveryExplored: number;
  unrecovered: number;
  count: number;
  sessions: Set<string>;
  retries: number;
  retriesSame: number;
  first: string | null;
  last: string | null;
  days: Map<string, number>;
  actors: { main: number; subagent: number };
  tools: Map<string, number>;
  locations: ScanLocation[];
}

export interface Classified { kind: PatternKind; owner: string; detail: string; sample: string; uncertain?: string; script?: string }

export interface HookSource { readonly path: string; readonly laisora: boolean; readonly bundle: boolean; readonly text: string }

export interface HookGate { readonly site: string | undefined; readonly patterns: ScanPattern[] }

export interface HookGroup { id: string; readonly owner: string; readonly sources: readonly string[]; readonly patterns: ScanPattern[]; readonly gates: HookGate[] }

export interface FailureClass { id: string; readonly tier: string; readonly head: string; readonly errorClass: string; readonly split?: string; readonly patterns: ScanPattern[]; readonly sessions: Set<string>; readonly count: number }

export interface ScanStats {
  parentFiles: number;
  subagentFiles: number;
  subagentForkFiles: number;
  filesRead: number;
  unreadableFiles: number;
  bytes: number;
  lines: number;
  unparsable: number;
  oversizedLines: number;
  duplicateRecords: number;
  toolResults: number;
  errorResults: number;
  excludedImprovementSessions: number;
  excludedImprovementAgents: number;
  firstDate: string | null;
  lastDate: string | null;
  runtimeSec: number;
}

export interface SelfCheck {
  filesChecked: number;
  mismatchFiles: number;
  rawNonForkErrors: number;
  creditedNonFork: number;
  creditedFromForkCopyWithoutOrigin: number;
  mismatches: { file: string; rawNonForkErrors: number; credited: number }[];
}

export interface ScanResult {
  stats: ScanStats;
  selfCheck: SelfCheck;
  previous: PreviousVerdicts;
  idCollisions: IdCollision[];
  patterns: ScanPattern[];
  candidates: ScanPattern[];
  slowCalls: ScanPattern[];
  maskedOwners: MaskedOwner[];
  causes: Cause[];
  waitCalls: { count: number; conversations: number };
  unansweredQuestions: Record<AskUnansweredKind, number>;
  failureClasses: FailureClass[];
  hookGroups: HookGroup[];
  hookSourcesRead: string[];
  settingsFilesRead: string[];
}

export interface ScanOptions {
  readonly projectsDir: string;
  readonly configDir: string;
  readonly laisoraSources?: readonly string[];
  readonly now?: () => number;
}

export function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function bracketFree(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) out = out.replace(/\((?:[^()\n]|\([^()\n]*\))*\)/g, "(…)");
  return out.replace(/（[^）\n]*）/g, "（…）").replace(/「[^」\n]*」/g, "「…」");
}

const LIST_ITEMS_RE = /[、,，/・]|\d|<(?:path|file|hex|id|uuid)>/;
const PAREN_REASON_MAX = 30;
const ID_OR_NUMBER_RE = /\b(?:[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+|(?:cp|utf-?|UTF-?|iso-?)\d+)\b|\d+(?:\.\d+)*/g;

export function norm(s: string): string {
  return String(s)
    .replace(/[A-Za-z]:[\\/][^\s"'`)\]}>,;]*/g, "<path>")
    .replace(/(^|[\s"'(=])(\/|~\/|\.\.?\/)[^\s"'`)\]}>,;]*/g, "$1<path>")
    .replace(/\b[\w.-]+\.(ts|mjs|js|cjs|json|md|py|ps1|jsonl|txt|css|html|yml|yaml|sh|log)\b/g, "<file>")
    .replace(/toolu_[A-Za-z0-9]+/g, "<toolu>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\b[a-z]{1,3}[0-9][a-z0-9]{6,}\b/gi, "<id>")
    .replace(/（([^）\n]*)）/g, (all, inner: string) => (LIST_ITEMS_RE.test(inner) || inner.length > PAREN_REASON_MAX ? "（<list>）" : all))
    .replace(/"[^"\n]{25,}"/g, '"<str>"')
    .replace(/「[^」\n]{12,}」/g, "「<str>」")
    .replace(ID_OR_NUMBER_RE, (token) => (/^\d/.test(token) ? "N" : token))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

function firstLine(t: string): string {
  return (t.split("\n").find((l) => l.trim()) || "").trim();
}

export interface CommandSegment { readonly text: string; readonly sep: string }

const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1[ \t]*(?=\n|$)/g;

const MEMO_MAX = 4000;
const splitMemo = new Map<string, CommandSegment[]>();
const bodyMemo = new Map<string, string>();

function memo<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (cache.size >= MEMO_MAX) cache.clear();
  cache.set(key, value);
  return value;
}

export function splitCommand(cmd: string, tool = "Bash"): CommandSegment[] {
  return memo(splitMemo, `${tool}|${cmd}`, () => splitUncached(cmd, tool));
}

function splitUncached(cmd: string, tool: string): CommandSegment[] {
  const pwsh = tool === "PowerShell";
  const flat = pwsh ? cmd.replace(/`\r?\n/g, " ") : cmd.replace(HEREDOC_RE, "<<$1$2");
  const escape = pwsh ? "`" : "\\";
  const out: CommandSegment[] = [];
  let cur = "";
  let sep = "";
  let quote: string | null = null;
  let depth = 0;
  const push = (next: string): void => {
    const t = cur.trim();
    cur = "";
    if (!t) return;
    if (!t.startsWith("#")) out.push({ text: t, sep });
    sep = next;
  };
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (quote) {
      cur += c;
      if (c === escape && quote === '"' && i + 1 < flat.length) { cur += flat[++i]; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || (!pwsh && c === "`")) { quote = c; cur += c; continue; }
    if (c === escape && i + 1 < flat.length) { cur += c + flat[++i]; continue; }
    if (c === "$" && flat[i + 1] === "(") { depth++; cur += "$("; i++; continue; }
    if (depth > 0) { if (c === "(") depth++; else if (c === ")") depth--; cur += c; continue; }
    const two = flat.slice(i, i + 2);
    if (two === "&&" || two === "||") { push(two); i++; continue; }
    if (c === ";" || c === "\n") { push(c); continue; }
    if (c === "|" && flat[i - 1] !== ">") { push("|"); continue; }
    if (pwsh && c === "{") {
      if (flat[i - 1] === "$" || flat[i - 1] === "@") {
        let d = 1;
        cur += c;
        while (++i < flat.length && d > 0) { if (flat[i] === "{") d++; else if (flat[i] === "}") d--; cur += flat[i]; }
        i--;
        continue;
      }
      push(";");
      continue;
    }
    if (pwsh && c === "}") { push(";"); continue; }
    cur += c;
  }
  push("");
  return out;
}

const KEYWORD_PREFIX_RE = /^(?:(?:do|then|else|elif|elseif|if|while|until|!|time|exec|nohup|function\s+[\w-]+(?:\s*\(\))?)\s+|timeout\s+(?:-\S+\s+)*\S+\s+|[A-Za-z_][\w-]*\s*\(\)\s*|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|(?!\$\()[^\s"']*)\s+|&\s*|[({]\s*)+/;
const ASSIGN_SUBST_RE = /^[A-Za-z_]\w*=["']?\$\(([\s\S]*)\)["']?$/;
const PS_ASSIGN_RE = /^\$[\w:]+\s*=\s*([\s\S]+)$/;
const FIND_EXEC_RE = /^find\b[^]*?\s-exec(?:dir)?\s+(.+?)\s+(?:\{\}\s*)?(?:\\;|';'|"\;"|\+)\s*$/;
const NOT_A_PROGRAM_RE = /^(?:done|fi|esac|do|then|else|\}|\)|\{|\(|\[|\[\[|test|for|foreach|try|catch|finally|switch|case|in|cd|pushd|popd|export|set|unset|local|Set-Location|exit|return|true|false|break|continue|:)$/;
const ECHO_PROGRAMS = new Set(["echo", "printf", "Write-Output", "Write-Host", "write-output", "write-host"]);
const TRANSPARENT_FILTERS = new Set(["head", "tail", "cut", "sort", "uniq", "tee", "cat", "more", "less", "wc", "tr", "column", "nl", "iconv"]);
const CONTENT_DUMPERS = new Set(["grep", "rg", "egrep", "fgrep", "cat", "sed", "head", "tail", "awk", "less", "more", "type", "ls", "find", "wc", "sort", "uniq", "cut", "tr", "jq", "nl", "diff", "echo", "printf", "stat", "file", "du", "tree", "Get-Content", "Select-String", "findstr", "Get-ChildItem", "Get-Item", "Select-Object", "Format-List", "Format-Table", "Out-String", "Measure-Object", "Write-Output", "Write-Host", "Test-Path"]);
const CONTENT_DUMP_SUBCOMMANDS = /^git\s+(?:-C\s+\S+\s+)?(?:show|log|diff|grep|blame|cat-file|ls-files|status|branch|worktree\s+list|rev-parse|remote\s+-v)\b/;
const PREDICATE_WORDS = new Set(["grep", "egrep", "fgrep", "rg", "cmp", "diff", "which", "where", "command", "type", "pgrep", "ls", "stat", "find", "Test-Path", "Select-String", "findstr"]);
const PREDICATE_GIT_RE = /^git\s+(?:-C\s+\S+\s+)?(?:merge-base\s+--is-ancestor|diff\b[^|;&]*--(?:quiet|exit-code)|rev-parse\b[^|;&]*--verify|show-ref|check-ignore|ls-files\b[^|;&]*--error-unmatch|cat-file\s+-e|ls-remote\b[^|;&]*--exit-code)/;
const INLINE_READ_RE = /readFileSync|readdirSync|\bopen\(|read_text|readlines|json\.load|Get-Content/;
const INLINE_ACT_RE = /writeFileSync|appendFileSync|\.write\(|spawn|exec(?:Sync|File)?\(|subprocess|os\.system|unlink|rmSync|mkdirSync|import\s*\(|from\s+["']\.|require\(["']\.|\bimport\s+\w+\s+from/;
const isCmdlet = (word: string): boolean => /^[A-Z][a-z]+-[A-Z][A-Za-z]+$/.test(word);

function closerCount(s: string, ch: string): number { let n = 0; for (const c of s) if (c === ch) n++; return n; }

function stripPrefix(seg: string): string {
  let body = seg.trim().replace(KEYWORD_PREFIX_RE, "").trim();
  for (const [close, open] of [[")", "("], ["}", "{"]] as const) while (body.endsWith(close) && closerCount(body, close) > closerCount(body, open)) body = body.slice(0, -1).trimEnd();
  return body;
}

function segmentBody(seg: string): string {
  return memo(bodyMemo, seg, () => {
    const body = stripPrefix(seg);
    const sub = ASSIGN_SUBST_RE.exec(body) ?? PS_ASSIGN_RE.exec(body) ?? FIND_EXEC_RE.exec(body);
    return sub ? stripPrefix(sub[1]) : body;
  });
}

const rawWord = (seg: string): string => (segmentBody(seg).match(/"[^"]*"|'[^']*'|\S+/) || [""])[0];

function segmentWord(seg: string): string {
  return path.basename(rawWord(seg).replace(/^["']|["']$/g, "")).replace(/\.exe$/i, "");
}

const isEchoSegment = (seg: string, tool: string): boolean => ECHO_PROGRAMS.has(segmentWord(seg)) || (tool === "PowerShell" && /^["']/.test(segmentBody(seg)));

function isProgramSegment(seg: string, tool = "Bash"): boolean {
  const body = segmentBody(seg);
  if (!body || /^[A-Za-z_][A-Za-z0-9_]*=/.test(body)) return false;
  if (tool === "PowerShell" && /^["']/.test(body)) return false;
  const raw = rawWord(seg).replace(/^["']|["']$/g, "");
  if (!raw || /^[$(\d-]/.test(raw)) return false;
  return !NOT_A_PROGRAM_RE.test(segmentWord(seg));
}

const programIndexes = (segs: readonly CommandSegment[], tool: string): number[] =>
  segs.map((_, i) => i).filter((i) => isProgramSegment(segs[i].text, tool) && !isEchoSegment(segs[i].text, tool));

const GIT_WRITE_RE = /^git\s+(?:-C\s+\S+\s+)?(?:branch\b[^|;&]*\s(?:-[dDmMcC]\b|--delete|--move|--copy|--set-upstream\S*|-u\b)|worktree\s+(?:add|remove|prune|move)|remote\s+(?:add|remove|rename|set-url)|stash\s+(?:drop|pop|push|apply|clear))/;

function writesOrRuns(word: string, body: string): boolean {
  if (/[<>]\(/.test(body)) return true;
  if (word === "git") return GIT_WRITE_RE.test(body);
  if (word === "sed") return /\s(?:-i\S*|--in-place)/.test(body);
  if (word === "find") return /\s-(?:exec|execdir|delete|ok|okdir|fprint\w*)\b/.test(body);
  if (word === "sort") return /\s(?:-o|--output)\b/.test(body);
  if (word === "awk") return /-i\s+inplace/.test(body);
  return false;
}

const isPredicateOrRead = (seg: string): boolean => {
  const word = segmentWord(seg);
  const body = segmentBody(seg);
  if (writesOrRuns(word, body)) return false;
  return PREDICATE_WORDS.has(word) || CONTENT_DUMPERS.has(word) || PREDICATE_GIT_RE.test(body) || CONTENT_DUMP_SUBCOMMANDS.test(body);
};

const COMPARE_PROGRAMS = new Set(["diff", "cmp"]);
const STATUS_TOKEN_RE =/^\$\{?(\?|PIPESTATUS\[(\d+)\]|LASTEXITCODE|env:LASTEXITCODE)\}?$/;

function statusOwnerBefore(segs: readonly CommandSegment[], i: number, ref: string, pipeIndex: string | undefined, tool: string): number | undefined {
  if (ref === "LASTEXITCODE" || ref === "env:LASTEXITCODE") {
    for (let k = i - 1; k >= 0; k--) if (isProgramSegment(segs[k].text, tool) && !isCmdlet(segmentWord(segs[k].text)) && !isEchoSegment(segs[k].text, tool)) return k;
    return undefined;
  }
  if (/^else\b/.test(segs[i].text)) {
    for (let k = i - 1; k >= 0; k--) if (/^(?:if|elif)\s/.test(segs[k].text)) return k;
    return undefined;
  }
  let end = i - 1;
  if (segs[i].sep === "||") while (end > 0 && isEchoSegment(segs[end].text, tool) && segs[end].sep === "&&") end--;
  if (end < 0) return undefined;
  let start = end;
  while (start > 0 && segs[start].sep === "|") start--;
  if (pipeIndex !== undefined) {
    const k = start + Number(pipeIndex);
    return k <= end ? k : undefined;
  }
  for (let k = end; k >= start; k--) {
    const w = segmentWord(segs[k].text);
    if (k > start && (TRANSPARENT_FILTERS.has(w) || (tool === "PowerShell" && isCmdlet(w)))) continue;
    return k;
  }
  return end;
}

export interface StatusEcho { readonly re: RegExp; readonly owners: readonly (number | undefined)[]; readonly loopVars: readonly (string | undefined)[]; readonly bare: boolean }

const ECHO_TOKEN_RE = /\$\{[^}]*\}|\$\([^)]*\)|\$(?:env:)?[A-Za-z_]\w*(?:\[\d+\])?|\$\?|["']|\s+|[^$"'\s]+|\$/g;
const LOOP_VAR_RE = /^(?:for\s+([A-Za-z_]\w*)\s+in\b|foreach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b)/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function statusEchoes(cmd: string, tool: string, segs: readonly CommandSegment[] = splitCommand(cmd, tool)): StatusEcho[] {
  const vars = new Map<string, number | undefined>();
  const out: StatusEcho[] = [];
  const loopNames = new Set(segs.map((s) => { const m = LOOP_VAR_RE.exec(stripPrefix(s.text)); return m?.[1] ?? m?.[2]; }).filter((n): n is string => !!n));
  const generatedBefore = (k: number): boolean => segs.slice(0, k).some((s) => isProgramSegment(s.text, tool) && !isEchoSegment(s.text, tool) && !isPredicateOrRead(s.text) && !LIGHT_PROGRAMS.has(segmentWord(s.text)));
  const comparison = (k: number): boolean => COMPARE_PROGRAMS.has(segmentWord(segs[k].text)) && generatedBefore(k);
  const valid = (k: number | undefined): number | undefined => (k !== undefined && isProgramSegment(segs[k].text, tool) && !isEchoSegment(segs[k].text, tool) && (!isPredicateOrRead(segs[k].text) || comparison(k)) ? k : undefined);
  segs.forEach((s, i) => {
    const plain = stripPrefix(s.text);
    const assign = /^\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?\$\{?(\?|PIPESTATUS\[(\d+)\]|LASTEXITCODE|env:LASTEXITCODE)\}?["']?\s*$/.exec(plain);
    if (assign) { vars.set(assign[1], valid(statusOwnerBefore(segs, i, assign[2].replace(/\[\d+\]$/, ""), assign[3], tool))); return; }
    if (!isEchoSegment(s.text, tool)) return;
    const body = segmentBody(s.text);
    const args = /^["']/.test(body) ? body : body.replace(/^\S+\s*(?:-[neE]+\s+)*/, "");
    const parts: string[] = [];
    const owners: (number | undefined)[] = [];
    const loopVars: (string | undefined)[] = [];
    let literal = false;
    for (const tok of args.match(ECHO_TOKEN_RE) ?? []) {
      if (tok === '"' || tok === "'") continue;
      if (/^\s+$/.test(tok)) { parts.push("\\s+"); continue; }
      const st = STATUS_TOKEN_RE.exec(tok);
      const name = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(tok)?.[1];
      if (st) { parts.push("(-?\\d+)"); owners.push(valid(statusOwnerBefore(segs, i, st[1].replace(/\[\d+\]$/, ""), st[2], tool))); loopVars.push(undefined); continue; }
      if (name !== undefined && vars.has(name)) { parts.push("(-?\\d+)"); owners.push(vars.get(name)); loopVars.push(undefined); continue; }
      if (name !== undefined && loopNames.has(name)) { parts.push("(.*?)"); owners.push(undefined); loopVars.push(name); continue; }
      if (tok.startsWith("$")) { parts.push(".*?"); continue; }
      parts.push(escapeRe(tok));
      literal = true;
    }
    if (!owners.some((o, g) => o !== undefined || loopVars[g] === undefined)) return;
    const bare = !literal;
    if (bare && segs.slice(i + 1).some((x) => isProgramSegment(x.text, tool) || isEchoSegment(x.text, tool))) return;
    out.push({ re: new RegExp(`^\\s*${parts.join("").replace(/(?:\\s\+)+/g, "\\s+")}\\s*$`), owners, loopVars, bare });
  });
  return out;
}

export function substituteLoopValues(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, name: string) => values[name] ?? all);
}

export interface PrintedStatus { readonly segment: number; readonly status: number; readonly line: number; readonly loopValues: Readonly<Record<string, string>> }

export function printedStatuses(text: string, echoes: readonly StatusEcho[]): { failures: PrintedStatus[]; echoLines: number[] } {
  const lines = text.split("\n");
  let last = lines.length - 1;
  while (last > 0 && !lines[last].trim()) last--;
  const failures: PrintedStatus[] = [];
  const echoLines: number[] = [];
  const seen = new Set<string>();
  lines.forEach((l, idx) => {
    for (const e of echoes) {
      if (e.bare && idx !== last) continue;
      const m = e.re.exec(l);
      if (!m) continue;
      echoLines.push(idx);
      const loopValues: Record<string, string> = {};
      e.loopVars.forEach((name, g) => { if (name !== undefined) loopValues[name] = m[g + 1]; });
      e.owners.forEach((seg, g) => {
        const status = Number(m[g + 1]);
        const key = `${seg}|${JSON.stringify(loopValues)}`;
        if (seg === undefined || e.loopVars[g] !== undefined || status === 0 || seen.has(key)) return;
        seen.add(key);
        failures.push({ segment: seg, status, line: idx, loopValues });
      });
      break;
    }
  });
  return { failures, echoLines };
}

export interface Attribution { readonly owner: string; readonly attributed: boolean; readonly heads: readonly string[]; readonly script?: string }

const SCRIPT_TOKEN_RE = /(?:^|[\s(;&|])((?:node|python3?|py|bash|sh|pwsh|powershell|deno|tsx|bun)(?:\.exe)?)(?:\s+-\S+)*\s+["']?([^\s"'<>|;&]*?([\w.-]+)\.(py|mjs|cjs|js|ts|sh|ps1))\b/g;
const SCRIPT_EXT_RE = /\.(?:py|mjs|cjs|js|ts|sh|ps1|exe)$/i;
const DIAGNOSTIC_LINE_RE = /^(?:[\w.-]+:\s+)?([\w.-]{2,60}):\s+\S/;
const PASS_WORD_RE = /\b(?:pass(?:ed|es)?|ok|success(?:ful)?|all passed|up to date)\b/i;
const FAIL_WORD_RE = /\b(?:fail|error|cannot|can't|not found|refus|denied|no such|invalid|unable|missing)|失敗|拒否|停止/i;
const GIT_LINE_SUBCOMMANDS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/\bpathspec\b/, ["rm", "add", "checkout", "restore", "mv", "reset", "commit", "stash"]],
  [/\bbranch\b/, ["branch", "checkout", "switch"]],
  [/\bworktree\b/, ["worktree"]],
  [/\bstash\b/, ["stash"]],
  [/\b(?:merge|conflict)\b/, ["merge", "pull"]],
  [/\brebase\b/, ["rebase", "pull"]],
  [/\b(?:refspec|remote|upstream)\b/, ["push", "fetch", "pull"]],
];
const PREFIX_EMITTERS: readonly (readonly [RegExp, RegExp, boolean])[] = [
  [/^fatal:\s/, /^git$/, false],
  [/^error:\s.*\b(?:branch|worktree|pathspec|refspec|commit|merge|rebase|stash|HEAD|remote|tag|index|checkout|working tree)\b/i, /^git$/, false],
  [/^error:\s/, /^git$/, true],
  [/^error\[E\d+\]/, /^(?:cargo|rustc)$/, false],
  [/^error:\s/, /^(?:cargo|rustc)$/, true],
  [/^npm (?:ERR!|error)\s/, /^(?:npm|npx)$/, false],
  [/^(?:pnpm|yarn)\s*(?:ERR|error)/i, /^(?:pnpm|yarn)$/, false],
];

function scriptRef(segs: readonly CommandSegment[], i: number): string | undefined {
  const body = segmentBody(segs[i].text);
  const m = new RegExp(SCRIPT_TOKEN_RE.source).exec(` ${body}`);
  if (!m) return undefined;
  const parts = m[2].replace(/\\+/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  const interp = m[1].replace(/\.exe$/i, "");
  if (parts.length >= 2) return `${interp} ${parts.slice(-2).join("/")}`;
  const cd = segs.slice(0, i).reverse().map((s) => /^(?:cd|pushd|Set-Location)\s+["']?([^"';&|]+?)["']?\s*$/.exec(stripPrefix(s.text))?.[1]).find(Boolean);
  return `${interp} ${cd ? path.basename(cd.replace(/\\+/g, "/")) : "."}/${parts[0]}`;
}

function programNames(segs: readonly CommandSegment[], tool: string): Map<string, number> {
  const names = new Map<string, number>();
  for (const i of programIndexes(segs, tool)) {
    const w = segmentWord(segs[i].text).replace(SCRIPT_EXT_RE, "");
    if (!names.has(w)) names.set(w, i);
    for (const m of ` ${segmentBody(segs[i].text)}`.matchAll(SCRIPT_TOKEN_RE)) if (!names.has(m[3])) names.set(m[3], i);
  }
  return names;
}

const MISSING_OUTCOME_RE = /No such file|cannot access|can't (?:read|open|stat|access)|cannot (?:open|stat|find)|not found|does not exist|no match|Is a directory|Not a directory/i;

export function diagnosticProgram(text: string, cmd: string, tool = "Bash", segs: readonly CommandSegment[] = splitCommand(cmd, tool)): { segment: number; line: string } | undefined {
  const names = programNames(segs, tool);
  const progs = programIndexes(segs, tool);
  const emitter = (word: RegExp, exclusive: boolean, line: string): number | undefined => {
    const hits = progs.filter((i) => word.test(segmentWord(segs[i].text)));
    if (exclusive && progs.some((i) => !hits.includes(i) && !isPredicateOrRead(segs[i].text) && !TRANSPARENT_FILTERS.has(segmentWord(segs[i].text)))) return undefined;
    const writers = hits.filter((i) => !isPredicateOrRead(segs[i].text));
    if (hits.length === 1) return hits[0];
    if (writers.length === 1) return writers[0];
    const subs = GIT_LINE_SUBCOMMANDS.filter(([re]) => re.test(line)).flatMap(([, s]) => s);
    const named = (writers.length ? writers : hits).filter((i) => subs.includes(/^git\s+(?:-C\s+\S+\s+)?(\S+)/.exec(segmentBody(segs[i].text))?.[1] ?? ""));
    return named[0] ?? (subs.length ? undefined : (writers[0] ?? hits[0]));
  };
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (looksLikeCode(l) || (PASS_WORD_RE.test(l) && !FAIL_WORD_RE.test(l))) continue;
    const lead = DIAGNOSTIC_LINE_RE.exec(l);
    const name = lead ? [lead[1], /^([\w.-]+):/.exec(l)?.[1] ?? ""].map((n) => n.replace(SCRIPT_EXT_RE, "")).find((n) => names.has(n) && !ECHO_PROGRAMS.has(n)) : undefined;
    let segment = name === undefined ? undefined : names.get(name);
    if (segment === undefined) for (const [line, word, exclusive] of PREFIX_EMITTERS) if (line.test(l)) { segment = emitter(word, exclusive, l); if (segment !== undefined) break; }
    if (segment === undefined) continue;
    if (isPredicateOrRead(segs[segment].text) && MISSING_OUTCOME_RE.test(l)) continue;
    return { segment, line: l };
  }
  return undefined;
}

const PY_FRAME_ERROR_RE = /^\s*File "<(?:stdin|string)>", line \d+[\s\S]*?^\s*([A-Z]\w*(?:Error|Exception)):/m;

export function pythonFailureAt(text: string): number | undefined {
  const tb = TRACEBACK_RE.exec(text);
  if (tb) return tb.index;
  const frame = PY_FRAME_ERROR_RE.exec(text);
  return frame ? frame.index : undefined;
}

const INTERPRETERS = /^(node|python|python3|py|bash|sh|pwsh|powershell|deno|tsx|ts-node|bun)$/i;
const OUTPUT_FILTERS = new Set(["grep", "rg", "egrep", "fgrep", "sed", "awk", "cut", "findstr", "jq"]);
const SHELL_PARSE_RE = /^(?:\S*\/)?(?:bash|sh|zsh)(?:\.exe)?: (?:-c: )?line \d+: (?:unexpected EOF|syntax error near unexpected token)/m;

export function attributeFailure(cmd: unknown, tool: string, text: string, fromOutput = false): Attribution {
  if (typeof cmd !== "string") return { owner: "cmd:?", attributed: true, heads: [] };
  const segs = splitCommand(cmd, tool);
  const progs = programIndexes(segs, tool);
  const keyAt = (i: number): string => programKey(segmentBody(segs[i].text), true);
  const heads = progs.map(keyAt);
  const at = (i: number): Attribution => { const script = scriptRef(segs, i); return { owner: `cmd:${keyAt(i)}`, attributed: true, heads, ...(script ? { script } : {}) }; };
  if (SHELL_PARSE_RE.test(text)) return { owner: "cmd:shell parse", attributed: true, heads };
  if (!progs.length) return { owner: `cmd:${programKey(cmd)}`, attributed: true, heads };
  const printed = printedStatuses(text, statusEchoes(cmd, tool, segs)).failures[0];
  if (printed) return at(printed.segment);
  const diag = diagnosticProgram(text, cmd, tool, segs);
  if (diag) return at(diag.segment);
  const transparent = (i: number): boolean => {
    const w = segmentWord(segs[i].text);
    if (TRANSPARENT_FILTERS.has(w) || (tool === "PowerShell" && isCmdlet(w))) return true;
    return fromOutput && OUTPUT_FILTERS.has(w) && segs[i].sep === "|";
  };
  const working = progs.filter((i) => !transparent(i));
  if (working.length <= 1) return at(working[0] ?? progs[progs.length - 1]);
  const only = (re: RegExp): number | undefined => { const hits = working.filter((i) => re.test(segmentWord(segs[i].text))); return hits.length === 1 ? hits[0] : undefined; };
  const pick = (k: number | undefined): Attribution | undefined => (k === undefined ? undefined : at(k));
  const found = (pythonFailureAt(text) !== undefined ? pick(only(/^(python|python3|py)$/i)) : undefined)
    ?? (/^Node\.js v\d|\bERR_[A-Z_]{3,}\b|^\s+at .*\(node:|^\[eval\]/m.test(text) ? pick(only(/^node$/i)) : undefined);
  if (found) return found;
  const loop = segs.some((s) => /^(for|while|until|foreach)\b/.test(s.text)) ? "loop>" : "";
  return { owner: `chain:${loop}${keyAt(working[working.length - 1])}`, attributed: false, heads };
}

const LIGHT_PROGRAMS = new Set([...CONTENT_DUMPERS, "cd", "mkdir", "rm", "cp", "mv", "touch", "ln", "chmod", "date", "pwd", "basename", "dirname", "realpath", "New-Item", "Remove-Item", "Copy-Item", "Move-Item", "Join-Path", "Split-Path", "Resolve-Path"]);
const WAIT_PROGRAMS = /^(?:sleep|Start-Sleep)$/i;

export function slowOwner(cmd: unknown, tool: string): { owner: string; wait: boolean; uncertain?: string } {
  if (typeof cmd !== "string") return { owner: "cmd:?", wait: false };
  const segs = splitCommand(cmd, tool);
  const progs = programIndexes(segs, tool);
  const sleeps = progs.filter((i) => WAIT_PROGRAMS.test(segmentWord(segs[i].text)));
  const heavy = progs.filter((i) => !LIGHT_PROGRAMS.has(segmentWord(segs[i].text)) && !sleeps.includes(i));
  const loop = segs.some((s) => /^(?:until|while|for)\b/.test(s.text));
  const longest = Math.max(0, ...sleeps.map((i) => Number(/(\d+)\s*$/.exec(segmentBody(segs[i].text).replace(/[smh]\s*$/, ""))?.[1] ?? 0)));
  if (sleeps.length && (loop || !heavy.length || longest >= WAIT_SLEEP_MIN_SEC)) return { owner: "wait", wait: true };
  const keyAt = (i: number): string => programKey(segmentBody(segs[i].text), true);
  if (heavy.length === 1) return { owner: `cmd:${keyAt(heavy[0])}`, wait: false };
  if (!heavy.length) return { owner: `cmd:${progs.length ? keyAt(progs[0]) : programKey(cmd)}`, wait: false };
  const note = chainNote(heavy.map(keyAt));
  const classed = heavy.map((i) => ({ i, cls: heavyClass(segmentBody(segs[i].text)) })).filter((x) => x.cls);
  if (classed.length === 1) return { owner: `cmd:${keyAt(classed[0].i)}`, wait: false, uncertain: note };
  const classes = [...new Set(classed.map((x) => x.cls!))].sort();
  const label = classes.length ? classes.map((c) => `${c} steps`).join(" + ") : [...new Set(heavy.map(keyAt))].slice(0, CHAIN_KEY_HEADS).join(" + ");
  return { owner: `chain:${label}`, wait: false, uncertain: note };
}

const CHAIN_KEY_HEADS = 2;

const WAIT_SLEEP_MIN_SEC = 30;
const SCRIPT_FILE_RE = /\.(?:m?js|cjs|ts|py|sh|ps1)$/;
const TEST_LIKE_NAME = /test|verify|check|spec/;
const BUILD_LIKE_NAME = /build|bundle|compile/;
const HEAVY_CLASSES: readonly (readonly [string, RegExp])[] = [
  ["package", /\b(?:npm|pnpm|yarn)\s+run\s+(?:package|release|publish|dist)\b|\b(?:npm|pnpm|yarn)\s+(?:pack|publish)\b|\bvsce\b|\bcargo\s+(?:package|publish)\b|\bmake\s+(?:package|dist|release)\b/],
  ["build", /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|compile|bundle)|\b(?:tsc|esbuild|webpack|vite|rollup)\b|\b(?:cargo|go)\s+build\b|^make(?:\s+(?:all|build))?\s*$/],
  ["test", /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test|\b(?:jest|vitest|pytest|mocha|playwright)\b|\b(?:cargo|go)\s+test\b|\bmake\s+(?:test|check)\b/],
];

export function heavyClass(body: string): string | undefined {
  const named = HEAVY_CLASSES.find(([, re]) => re.test(body))?.[0];
  if (named) return named;
  const scripts = body.split(/\s+/).map((t) => path.basename(t.replace(/^["']|["']$/g, ""))).filter((t) => SCRIPT_FILE_RE.test(t));
  if (scripts.some((t) => TEST_LIKE_NAME.test(t))) return "test";
  if (scripts.some((t) => BUILD_LIKE_NAME.test(t))) return "build";
  return undefined;
}

const SINGLE_CALL = "single command";

function isInlineReader(cmd: string, seg: string): boolean {
  const body = segmentBody(seg);
  if (!INTERPRETERS.test(segmentWord(seg)) || !/\s-(?:e|c|Command)\b|<<|\s-\s*$/.test(body)) return false;
  return INLINE_READ_RE.test(cmd) && !INLINE_ACT_RE.test(cmd);
}

const OWN_CODE_FRAME_RE = /File "<(?:string|stdin)>"/;

export function isContentDump(cmd: string, tool = "Bash", inlineReaders = true): boolean {
  const segs = splitCommand(cmd, tool);
  const progs = segs.filter((s) => isProgramSegment(s.text, tool));
  return progs.length > 0 && progs.every((s) => isPredicateOrRead(s.text) || isEchoSegment(s.text, tool) || (inlineReaders && isInlineReader(cmd, s.text)));
}

const CHAIN_HEADS_SHOWN = 6;

export function chainNote(heads: readonly string[]): string {
  const shown = heads.slice(0, CHAIN_HEADS_SHOWN).join(" → ");
  return `chain not attributed: ${shown}${heads.length > CHAIN_HEADS_SHOWN ? ` → … (${heads.length})` : ""}`;
}

export function commandClass(owner: string): string {
  const key = owner.replace(/^(?:cmd|chain|tool):(?:loop>)?/, "");
  const [p, ...rest] = key.split(" ");
  if (INTERPRETERS.test(p)) return rest[0]?.startsWith("-") ? `${p} ${rest[0]}` : rest.length ? `${p} script` : p;
  return key;
}

export function programKey(cmd: unknown, isSegment = false, tool = "Bash"): string {
  if (typeof cmd !== "string") return "?";
  if (!isSegment) {
    const segs = splitCommand(cmd, tool);
    const first = programIndexes(segs, tool)[0];
    return first === undefined ? "?" : programKey(segmentBody(segs[first].text), true);
  }
  const toks: string[] = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "").replace(/^&\s*/, "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (!toks.length) return "?";
  const base = (t: string) => path.basename(t.replace(/^["']|["']$/g, "")).replace(/\.exe$/i, "");
  const p = base(toks[0] ?? "");
  const rest = toks.slice(1).filter((t) => !t.startsWith("-") && !/^[<>|]/.test(t) && !/^\d?>/.test(t));
  if (toks.some((t) => t.startsWith("<<")) && /^(node|python|python3|py|bash|sh|cat)$/i.test(p)) return `${p} -heredoc`;
  if (/^(npm|pnpm|yarn)$/.test(p) && /^run(-script)?$/.test(rest[0] ?? "") && rest[1]) return `${p} run ${rest[1]}`;
  if (["git", "npm", "npx", "gh", "pnpm", "yarn", "docker", "code", "vsce", "codex", "claude"].includes(p) && rest[0]) return `${p} ${base(rest[0])}`;
  if (/^(node|python|python3|py|bash|sh|pwsh|powershell)$/i.test(p)) {
    const script = rest.find((t) => !/^["']?-/.test(t));
    if (toks.includes("-e") || toks.includes("-c") || toks.includes("-Command")) return `${p} -inline`;
    return script ? `${p} ${base(script)}` : p;
  }
  return p;
}

const GREP_PREFIX_RE = /^(?:[\w./\\-]+:)?\d+[:-]\s?(?=\S)/;
const lineCore = (l: string): string => l.trim().replace(ITEM_PREFIX_RE, "").replace(GREP_PREFIX_RE, "").trim();
const ITEM_PREFIX_RE = /^\[item: [^\]]+\]\s*/;
const PASS_LINE_RE = /^(?:PASS(?:ED)?\b|✔|✓|√|ok\b|OK\b|\[ok\]|\[PASS\])/;
const FAIL_LINE_RE = /^(?:FAIL(?:ED)?\b(?![\s:=]*0\b)|not ok\b|[✗✕✖×]\s|(?:[^\s:：]{1,20}[:：]\s*)?NG\b(?![\s:：=]*(?:0\b|none\b|なし)))/;
const ITEM_ID_RE = /^(?:[-*•]\s*)?([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+)\b/;
const ITEM_LOOKAHEAD = 3;
const FAIL_WORDS = 3;
const HINT_MATCH_CHARS = 60;
const ENV_MANGLED_ARGUMENT = "path argument arrived mangled";
const ESBUILD_ERROR_RE = /^[✘X]\s+\[ERROR\]\s+(.*)$/;
const FAIL_SUMMARY_RE = /^(?:Tests?|Test Suites|Suites?|test result)\b[^\n]*?\b[1-9]\d* fail(?:ed|ures?|ing)\b/im;
const DECISIVE_RE = /\b(?:refused|refusing|denied|rejected|not found|No such file|can't|cannot|could not|not recognized|unable to|aborted|blocked|unexpected EOF|syntax error near unexpected token|unknown (?:command|option))\b|拒否|中止|見つから/i;
const EXCEPTION_RE = /^[\w.]*(?:Error|Exception)\b(?:\s*\[[\w-]+\])?[:\s]|^Error \[?[A-Z_]+\]?:|^(?:error|fatal|FATAL|ERROR)(?:\[[\w-]+\])?:\s|\bERR_[A-Z][A-Z_]{2,}\b/;
const GENERIC_ERROR_RE = /\b(?:error|fatal|failed|failure|invalid|exception)\b|失敗/i;
const SUMMARY_LINE_RE = /^(?:RESULT\b|---|===|npm (?:ERR!|error) (?:code|path|command|A complete log|Lifecycle)|Command failed\b|Error: Build failed with\b|Exit code\b|exit(?:ed)?\s*(?:code)?\s*[=:]?\s*\d|.*\b(?:FAIL|failed)\s*[=:]?\s*\d+\s*(?:\/|$)|\s*at\s)/i;
const SYMBOL_LINE_RE = /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*:\s+\S/;

export function isFailLine(line: string): boolean {
  const core = lineCore(line);
  return FAIL_LINE_RE.test(core) || ESBUILD_ERROR_RE.test(core);
}

const SUCCESS_CODE_RE = /(?:^|_)(?:OK|PASS(?:ED)?|SUCCESS|DONE|CLEAN|READY)$/;
const CODE_LINE_RE = /^(?![A-Z0-9_]*_(?:OK|PASS(?:ED)?|SUCCESS|DONE|CLEAN|READY)\b)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const CODE_ONLY_LINE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const isFailureCode = (line: string): boolean => CODE_ONLY_LINE_RE.test(line) && !SUCCESS_CODE_RE.test(line);
const CODE_LIKE_LINE_RE = /[,{\[(;]\s*$|:\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|['"`{\[])\s*,?\s*$/;
export const looksLikeCode = (line: string): boolean => CODE_LIKE_LINE_RE.test(line.trim());

export function reasonLine(lines: readonly string[]): string | undefined {
  const body = lines.map(lineCore).filter((l) => l && !PASS_LINE_RE.test(l));
  const nonSummary = body.filter((l) => !SUMMARY_LINE_RE.test(l) || FAIL_LINE_RE.test(l));
  const failAt = nonSummary.findIndex((l) => FAIL_LINE_RE.test(l) || ESBUILD_ERROR_RE.test(l));
  if (failAt >= 0) {
    const line = nonSummary[failAt];
    if (FAIL_LINE_RE.test(line) && !failId(line)) {
      const item = nonSummary.slice(failAt + 1, failAt + 1 + ITEM_LOOKAHEAD).map((l) => ITEM_ID_RE.exec(l)?.[1]).find(Boolean);
      if (item) return `[item: ${item}] ${line}`;
    }
    return line;
  }
  return [...nonSummary].reverse().find((l) => /^[\w.]*(?:Error|Exception)\b[:\s]/.test(l) && !/^Error:?\s*$/.test(l))
    ?? nonSummary.find((l) => SYMBOL_LINE_RE.test(l))
    ?? nonSummary.find((l) => DECISIVE_RE.test(l))
    ?? nonSummary.find((l) => EXCEPTION_RE.test(l) && !CODE_LINE_RE.test(l))
    ?? body.find((l) => CODE_LINE_RE.test(l))
    ?? nonSummary.find((l) => GENERIC_ERROR_RE.test(l))
    ?? body.find((l) => GENERIC_ERROR_RE.test(l) || DECISIVE_RE.test(l));
}

function exitSignature(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const code = (/^Exit code (\d+)/.exec(lines[0] || "") || [])[1] ?? "?";
  const err = reasonLine(lines.slice(1));
  return withHints(`exit ${code}: ${err ? norm(err) : "(no error line)"}`, text, err);
}

const MODULE_MISSING_RE = /MODULE_NOT_FOUND|Cannot find (?:module|package)|ModuleNotFoundError|No module named/;
const MISSING_PATH_LINE_RE = /FileNotFoundError|ENOENT|No such file|can't open file|cannot open|cannot access|WindowsPath\(/;
const PATH_SHAPES: readonly RegExp[] = [
  /can't open file '([^'\n]+)'/,
  /No such file or directory:\s*'([^'\n]+)'/,
  /WindowsPath\('([^'\n]+)'\)/,
  /ENOENT[^'\n]*'([^'\n]+)'/,
  /cannot (?:access|open|stat) '([^'\n]+)'/,
  /(?:^|\s)'([^'\n]+)': No such file/,
];

export function moduleKind(text: string): string | undefined {
  if (!MODULE_MISSING_RE.test(text)) return undefined;
  if (/Cannot find package|No module named/.test(text)) return "package";
  const target = /Cannot find module '([^']+)'|url: '([^']+)'/.exec(text);
  const p = (target?.[1] ?? target?.[2] ?? "").replace(/\\+/g, "/");
  if (/(?:^|\/)dist\//.test(p)) return "dist";
  if (!p) return "module";
  return /^(?:file:|\.|\/|[A-Za-z]:)/.test(p) ? "local file" : "package";
}

export function pathKindOf(line: string): string | undefined {
  if (!MISSING_PATH_LINE_RE.test(line)) return undefined;
  if (/\$'\\[0-7]{3}/.test(line)) return "non-ASCII name shown escaped";
  const shaped = PATH_SHAPES.map((re) => re.exec(line)?.[1]).find((x): x is string => !!x);
  if (shaped === undefined) return undefined;
  const p = shaped.replace(/\\+/g, "/");
  if (/\uFFFD/.test(p)) return ENV_MANGLED_ARGUMENT;
  if (/^\/(?:tmp|[a-z])\//.test(p)) return "Git Bash path given to a Windows program";
  if (/^[A-Za-z]:\//.test(p)) return "absolute path missing";
  return "relative path missing";
}

function withHints(reason: string, text: string, rawLine?: string): string {
  const kind = moduleKind(text);
  if (kind) return `${reason} [missing: ${kind}]`;
  const targets = [norm(reason), norm(reason.replace(/^exit \S+:\s*/, ""))].map((t) => t.slice(0, HINT_MATCH_CHARS));
  const line = rawLine ?? text.split("\n").find((l) => MISSING_PATH_LINE_RE.test(l) && targets.includes(norm(lineCore(l)).slice(0, HINT_MATCH_CHARS)));
  const pathKind = line ? pathKindOf(line) : undefined;
  return pathKind ? `${reason} [path: ${pathKind}]` : reason;
}

export function reasonSignature(reason: string): string | undefined {
  const missing = /\[missing: ([^\]]+)\]/.exec(reason)?.[1];
  const pathHint = /\[path: ([^\]]+)\]/.exec(reason)?.[1];
  const core = lineCore(reason);
  const esbuild = ESBUILD_ERROR_RE.exec(core);
  if (esbuild) return `esbuild: ${esbuild[1].split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 3).join(" ")}`;
  if (FAIL_LINE_RE.test(core)) {
    const id = /\[item: ([^\]]+)\]/.exec(reason)?.[1] ?? failId(core);
    return `FAIL ${id || failWords(core) || "line"}`;
  }
  const code = CODE_LINE_RE.exec(core)?.[0];
  if (code) return code;
  const named = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b|\b(ERR_[A-Z][A-Z_]{2,})\b|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:error|failed|failure))\b/.exec(reason);
  if (named) return `${named[1] ?? named[2] ?? named[3]}${missing ? ` ${missing}` : pathHint ? ` ${pathHint}` : ""}`;
  return DECISIVE_RE.exec(reason)?.[0].toLowerCase();
}

const FAIL_MARKER_PREFIX_RE = /^(?:FAIL(?:ED)?|not ok(?:\s+[\dN]+)?|[✗✕✖×]|[^\s:：]{1,20}[:：]\s*NG|NG)\s*[:-]?\s*/;

export function failId(core: string): string {
  const token = (/^(\S+)/.exec(core.replace(FAIL_MARKER_PREFIX_RE, ""))?.[1] ?? "").replace(/[:,.;]+$/, "");
  return /[A-Za-z]/.test(token) && /^[\w./#-]+$/.test(token) && !/^[\dN.]+$/.test(token) ? token : "";
}

function failWords(core: string): string {
  return core.replace(FAIL_MARKER_PREFIX_RE, "").split(/\s+/).filter((w) => /^[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(w) && !/^N\W*$/.test(w)).slice(0, FAIL_WORDS).join(" ");
}

export function failFamily(id: string): string {
  return id.split(/[-_:]/)[0];
}

interface ToolUse { name: string; input: unknown; inp: string; idx: number; at?: string | null; outcome?: "ok" | "fail"; keys?: Set<string> }

export function retryKeys(input: unknown, tool: string): Set<string> {
  const cmd = (input as { command?: unknown } | undefined)?.command;
  const out = new Set<string>();
  if (typeof cmd !== "string") return out;
  const segs = splitCommand(cmd, tool);
  for (const i of programIndexes(segs, tool)) {
    if (isPredicateOrRead(segs[i].text)) continue;
    const body = segmentBody(segs[i].text);
    const script = new RegExp(SCRIPT_TOKEN_RE.source).exec(` ${body}`);
    if (script) out.add(`script:${script[1].replace(/\.exe$/i, "")} ${script[2].replace(/\\+/g, "/").toLowerCase()}`);
    else if (!/<</.test(body)) out.add(`cmd:${body.replace(/\s+/g, " ").slice(0, RETRY_KEY_CHARS)}`);
  }
  return out;
}

export function classify(rawText: string, rec: Record<string, unknown>, use: ToolUse | undefined): Classified {
  const text = stripToolUseErrorTags(rawText).trimStart();
  const tool = use?.name || "?";
  const failure = classifyToolFailure(text, use?.name, rec as ToolFailureRecord);
  const target = (): string => isShellTool(tool) ? programKey((use?.input as { command?: unknown } | undefined)?.command, false, tool) : tool;
  switch (failure.kind) {
    case "classifier_unavailable":
      return { kind: failure.kind, owner: "classifier:unavailable", detail: tool, sample: firstLine(text) };
    case "classifier_denial": {
      const reason = failure.reason ?? "?";
      return { kind: failure.kind, owner: "classifier", detail: norm(bracketFree(reason)).slice(0, 120), sample: reason };
    }
    case "safety_check":
      return { kind: failure.kind, owner: "claude-code", detail: `${tool} ${target()}: ${norm(firstLine(failure.message) || firstLine(text)).slice(0, PROMPT_DETAIL_CHARS)}`, sample: firstLine(text) };
    case "permission_prompt":
      return { kind: failure.kind, owner: "permission", detail: `${tool} ${target()}: ${norm(failure.prompt)}`, sample: firstLine(text) };
    case "user_rejected":
      return { kind: failure.kind, owner: "user", detail: tool, sample: firstLine(text) };
    case "hook_denial": {
      const body = hookReason(failure.body);
      return { kind: failure.kind, owner: "hook", detail: norm(bracketFree(body)).slice(0, 140), sample: body.slice(0, 400) };
    }
    case "nonzero_exit": {
      const eo = attributeFailure((use?.input as { command?: unknown } | undefined)?.command, tool, text);
      return { kind: failure.kind, owner: eo.owner, detail: exitSignature(text), sample: firstLine(text), ...(eo.attributed ? {} : { uncertain: chainNote(eo.heads) }), ...(eo.script ? { script: eo.script } : {}) };
    }
  }
  const kind = failure.kind;
  if (/^\s*\{/.test(text)) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const code = j.error || j.code || (j.ok === false ? "ok:false" : null);
      if (code) return { kind, owner: `tool:${tool}`, detail: norm(`json ${String(code)}${j.requirement ? " " + String(j.requirement) : ""}`), sample: firstLine(text) };
    } catch { /* not JSON */ }
  }
  return { kind, owner: `tool:${tool}`, detail: norm(firstLine(text)), sample: firstLine(text) };
}

export interface MaskedSignal { readonly marker: string; readonly owner: string; readonly reason: string; readonly uncertain?: string; readonly script?: string }

export const MASKED_MARKERS_NEEDING_RETRY: ReadonlySet<string> = new Set(["error-line", "missing", "error-code", "result-failed", "powershell-error", "status-word"]);
const MASKED_SCAN_CHARS = 20000;
const MASKED_TAIL_LINES = 5;
const MASKED_REASON_CHARS = 100;
const RETRY_KEY_CHARS = 300;
const BACKGROUNDED_RE = /did not complete within its \d+\s*s(?:econds)? timeout and was moved to the background/;
const ASYNC_HANDOFF_RE = /^(?:MCP tool "[^"]+" is still running after|Command running in background with ID)/;
const TRACEBACK_RE = /^Traceback \(most recent call last\)/m;
const ERROR_ID_SHAPE = "(?!(?:is|has|on|no)_)[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:error|failed|failure)";
const ERROR_ID_FIELD_RE = new RegExp(`"(?:type|error|code|errorCode|error_code|status|reason|kind)"\\s*:\\s*"(${ERROR_ID_SHAPE})"`);
const ERROR_ID_TEXT_RE = new RegExp(`(?:^|[\\s\`'"(])(${ERROR_ID_SHAPE}):\\s`, "m");

const TEXT_MARKERS: readonly (readonly [string, RegExp])[] = [
  ["error-code", /\bERR_[A-Z][A-Z_]{2,}\b/],
  ["error-line", /^\s*(?:[A-Z]\w*(?:Error|Exception)|Error|error|fatal|FATAL|ERROR)(?:\s*\[[\w-]+\])?:\s/m],
  ["missing", /No such file or directory|can't (?:read|open|access)|cannot (?:open|access|find)|not recognized as|command not found|Cannot find module/],
  ["powershell-error", /FullyQualifiedErrorId\s*:\s*\S+/],
  ["json-failure", /"error"\s*:\s*"[^"]|"(?:status|result|verdict|candidate|outcome|state)"\s*:\s*"(?:fail|failed|failure|error)"/i],
  ["status-word", /^[\w .#/-]{1,40}:\s*(?:fail(?:ed|ure)?|error|NG)\b(?![\s:：=]*(?:0\b|none\b|なし))/im],
];

function maskedReason(text: string, fallback?: string): string {
  const lines = text.slice(0, MASKED_SCAN_CHARS).split("\n");
  return norm(reasonLine(lines) ?? fallback ?? firstLine(text)).slice(0, MASKED_REASON_CHARS);
}

function printedReason(lines: readonly string[], echoLines: readonly number[], at: number, keep: (l: string) => boolean): string | undefined {
  const prev = Math.max(-1, ...echoLines.filter((n) => n < at));
  const next = Math.min(lines.length, ...echoLines.filter((n) => n > at));
  const pick = (a: number, b: number): string | undefined => reasonLine(lines.slice(a, b).filter(keep));
  return pick(prev + 1, at) ?? pick(at + 1, next);
}

const RECORD_COMMAND_RE = new RegExp(`${IMPROVEMENT_TOOL_FILE.replace(/[.]/g, "\\.")}['"]?\\s+record\\b`);

function firstMatchNotCode(re: RegExp, text: string): RegExpExecArray | null {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let m = global.exec(text); m; m = global.exec(text)) {
    const at = m.index + m[0].length - m[0].trimStart().length;
    const line = text.slice(text.lastIndexOf("\n", at) + 1, (text.indexOf("\n", at) + 1 || text.length + 1) - 1);
    if (!looksLikeCode(line)) return m;
  }
  return null;
}

export function maskedSignals(text: string, tool: string, input: unknown): MaskedSignal[] {
  const t = text.slice(0, MASKED_SCAN_CHARS);
  return shellOrMcpSignals(t, tool, input).map((s) => ({ ...s, reason: withHints(s.reason, t) }));
}

function shellOrMcpSignals(t: string, tool: string, input: unknown): MaskedSignal[] {
  if (ASYNC_HANDOFF_RE.test(t) || BACKGROUNDED_RE.test(t)) return [];
  if (isShellTool(tool)) {
    const cmd = (input as { command?: unknown } | undefined)?.command;
    if (typeof cmd !== "string") return [];
    const segs = splitCommand(cmd, tool);
    const lines = t.split("\n");
    const { failures, echoLines } = printedStatuses(t, statusEchoes(cmd, tool, segs));
    if (failures.length) {
      const names = programNames(segs, tool);
      return failures.map((f) => {
        const resolved = segs.map((seg, k) => (k === f.segment ? { ...seg, text: substituteLoopValues(seg.text, f.loopValues) } : seg));
        const ownerKey = programKey(segmentBody(resolved[f.segment].text), true);
        const otherDiagnostic = (l: string): boolean => { const n = DIAGNOSTIC_LINE_RE.exec(l)?.[1]?.replace(SCRIPT_EXT_RE, ""); return n !== undefined && names.has(n) && names.get(n) !== f.segment; };
        const reason = printedReason(lines, echoLines, f.line, (l) => !otherDiagnostic(l));
        const script = scriptRef(resolved, f.segment);
        const statusLine = Object.values(f.loopValues).filter(Boolean).reduce((l, v) => l.replace(new RegExp(`(?<![\\w.-])${escapeRe(v)}(?![\\w.-])`, "g"), "<item>"), lines[f.line].trim());
        return { marker: "printed-status", owner: `cmd:${ownerKey}`, reason: norm(reason ?? statusLine).slice(0, MASKED_REASON_CHARS), ...(script ? { script } : {}) };
      });
    }
    const diag = diagnosticProgram(t, cmd, tool, segs);
    const diagSignal = (d: { segment: number; line: string }): MaskedSignal[] => {
      const script = scriptRef(segs, d.segment);
      return [{ marker: "program-diagnostic", owner: `cmd:${programKey(segmentBody(segs[d.segment].text), true)}`, reason: norm(d.line).slice(0, MASKED_REASON_CHARS), ...(script ? { script } : {}) }];
    };
    if (RECORD_COMMAND_RE.test(cmd)) return [];
    if (isContentDump(cmd, tool, false)) return diag ? diagSignal(diag) : [];
    const owned = (marker: string, reason: string, evidence = t): MaskedSignal[] => {
      const a = attributeFailure(cmd, tool, evidence, true);
      return [{ marker, owner: a.owner, reason, ...(a.attributed ? {} : { uncertain: chainNote(a.heads) }), ...(a.script ? { script: a.script } : {}) }];
    };
    const inlineReader = isContentDump(cmd, tool, true);
    const code = lines.map((l) => l.trim()).find(isFailureCode);
    const resultLine = lines.map((l) => l.trim()).find((l) => /^RESULT failed\b/.test(l)) ?? FAIL_SUMMARY_RE.exec(t)?.[0];
    const tail = lines.filter((l) => l.trim()).slice(-MASKED_TAIL_LINES).join("\n");
    const result = (evidence = t): MaskedSignal[] => {
      const failing = evidence.split("\n").find(isFailLine);
      if (failing && resultLine) return owned("fail-line", norm(reasonLine(evidence.split("\n")) ?? lineCore(failing)).slice(0, MASKED_REASON_CHARS), evidence);
      return code && resultLine ? owned("result-code", code, evidence) : /^RESULT failed\b/m.test(tail) ? owned("result-failed", maskedReason(evidence), evidence) : [];
    };
    const tb = pythonFailureAt(t);
    if (tb !== undefined && (!inlineReader || OWN_CODE_FRAME_RE.test(t.slice(tb)))) {
      const block = t.slice(tb).split("\n");
      const excAt = block.findIndex((l) => /^\s*[\w.]*(Error|Exception)\b/.test(l));
      const exc = excAt >= 0 ? block[excAt].trim() : "Traceback";
      const rest = `${t.slice(0, tb)}\n${block.slice(excAt + 1).join("\n")}`;
      return [...owned("traceback", norm(exc).slice(0, MASKED_REASON_CHARS)), ...(resultLine ? result(rest) : [])];
    }
    if (inlineReader) return diag ? diagSignal(diag) : [];
    const failLine = lines.find(isFailLine);
    if (failLine) return owned("fail-line", norm(reasonLine(lines) ?? lineCore(failLine)).slice(0, MASKED_REASON_CHARS));
    const summary = FAIL_SUMMARY_RE.exec(t);
    if (summary) return code ? owned("result-code", code) : owned("fail-summary", norm(summary[0]).slice(0, MASKED_REASON_CHARS));
    if (diag) return diagSignal(diag);
    const fromResult = result();
    if (fromResult.length) return fromResult;
    for (const [marker, re] of TEXT_MARKERS) {
      const m = marker === "error-line" ? firstMatchNotCode(re, t) : re.exec(t);
      if (m) return owned(marker, norm(lines[t.slice(0, m.index + m[0].length - m[0].trimStart().length).split("\n").length - 1]).slice(0, MASKED_REASON_CHARS));
    }
    return [];
  }
  if (!tool.startsWith("mcp__")) return [];
  const owner = `tool:${tool}`;
  if (TRACEBACK_RE.test(t)) return [{ marker: "traceback", owner, reason: maskedReason(t) }];
  const json = /^\s*[[{]/.test(t);
  const id = ERROR_ID_FIELD_RE.exec(t) ?? (json ? null : ERROR_ID_TEXT_RE.exec(t));
  if (id) return [{ marker: "error-id", owner, reason: id[1] }];
  if (json) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      if (j.ok === false || (typeof j.error === "string" && j.error)) return [{ marker: "mcp-json-failure", owner, reason: norm(`json ${String(j.error ?? j.code ?? "ok:false")}`) }];
    } catch { /* not JSON */ }
  }
  return [];
}

export interface TaskNotification { readonly status: string; readonly summary: string; readonly result: string; readonly taskId?: string; readonly toolUseId?: string }

export function taskNotifications(text: string): TaskNotification[] {
  const out: TaskNotification[] = [];
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1];
    const field = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim();
    const taskId = field("task-id");
    const toolUseId = field("tool-use-id");
    out.push({ status: field("status") ?? "", summary: field("summary") ?? "", result: field("result") ?? "", ...(taskId ? { taskId } : {}), ...(toolUseId ? { toolUseId } : {}) });
  }
  return out;
}

export function notificationKey(n: TaskNotification): string {
  return `${n.taskId ?? n.summary}|${n.status}`;
}

export function notificationText(rec: Record<string, any>): string {
  if (rec.type === "attachment" && rec.attachment?.type === "queued_command" && typeof rec.attachment.prompt === "string") return rec.attachment.prompt;
  if (rec.type !== "user") return "";
  const content = rec.message?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text as string).join("\n") : "";
}

export interface HookAttachment { readonly key: string; readonly kind: "hook_failure" | "hook_denial"; readonly command: string; readonly hookName: string; readonly detail: string; readonly sample: string }

export function hookAttachment(rec: Record<string, any>): HookAttachment | undefined {
  const a = rec.type === "attachment" ? rec.attachment : undefined;
  if (!a || typeof a.type !== "string") return undefined;
  const base = { key: `${a.type}|${a.toolUseID ?? ""}|${a.hookName ?? ""}|${a.command ?? ""}`, hookName: String(a.hookName ?? a.hookEvent ?? "hook") };
  if (a.type === "hook_cancelled" && a.timedOut === true) {
    const detail = `hook timed out (limit ${Math.round(Number(a.timeoutMs ?? 0) / 1000)} s)`;
    return { ...base, kind: "hook_failure", command: String(a.command ?? ""), detail: norm(detail), sample: detail };
  }
  if (a.type === "hook_non_blocking_error") {
    const first = firstLine(String(a.stderr ?? "")) || firstLine(String(a.stdout ?? ""));
    const detail = `hook failed (exit ${a.exitCode ?? "?"}): ${first}`;
    return { ...base, kind: "hook_failure", command: String(a.command ?? ""), detail: norm(detail).slice(0, 140), sample: detail.slice(0, 400) };
  }
  if (a.type === "hook_blocking_error") {
    const be = a.blockingError ?? {};
    const text = hookReason(String(be.blockingError ?? ""));
    return { ...base, kind: "hook_denial", command: String(be.command ?? a.command ?? ""), detail: norm(bracketFree(text)).slice(0, 140), sample: text.slice(0, 400) };
  }
  return undefined;
}

export function notificationSignal(n: TaskNotification, use: { name: string; input: unknown } | undefined): (MaskedSignal & { tool: string }) | undefined {
  const mcp = /^MCP task \S+ \(([\w-]+)\/([\w-]+)\)/.exec(n.summary);
  if (mcp) {
    const tool = `mcp__${mcp[1]}__${mcp[2]}`;
    if (n.status === "failed") return { tool, marker: "task-failed", owner: `tool:${tool}`, reason: maskedReason(n.result || n.summary) };
    const s = maskedSignals(n.result, tool, undefined)[0];
    return s ? { ...s, tool } : undefined;
  }
  if (/^Background command\b/.test(n.summary)) {
    const code = /exit code (\d+)/.exec(n.summary)?.[1];
    if (n.status !== "failed" && (!code || code === "0")) return undefined;
    const tool = use?.name ?? "Bash";
    const a: Attribution = use ? attributeFailure((use.input as { command?: unknown } | undefined)?.command, tool, n.result) : { owner: "cmd:?", attributed: true, heads: [] };
    return { tool, marker: "background-exit", owner: a.owner, reason: `background command failed with exit code ${code ?? "?"}`, ...(a.attributed ? {} : { uncertain: chainNote(a.heads) }), ...(a.script ? { script: a.script } : {}) };
  }
  return undefined;
}

const RECOVERY_WINDOW = 15;
const isTaskSwitch = (u: ToolUse): boolean => u.name === "TaskCreate" || (u.name === "TaskUpdate" && (u.input as { status?: unknown } | undefined)?.status === "completed");
const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"]);

function useKeys(u: ToolUse): Set<string> {
  if (u.keys) return u.keys;
  const input = (u.input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
  u.keys = isShellTool(u.name) ? retryKeys(u.input, u.name) : FILE_TOOLS.has(u.name) ? new Set([`file:${String(input.file_path ?? input.notebook_path ?? "")}`]) : new Set([`tool:${u.name}`]);
  return u.keys;
}

const isExploration = (u: ToolUse): boolean => EXPLORE_TOOLS.has(u.name) || (isShellTool(u.name) && typeof (u.input as { command?: unknown } | undefined)?.command === "string" && isContentDump((u.input as { command: string }).command, u.name));

export function measureRecovery(calls: readonly ToolUse[], failures: readonly { pattern: ScanPattern; idx: number }[]): void {
  for (const { pattern, idx } of failures) {
    const failed = calls[idx];
    if (!failed) continue;
    const keys = useKeys(failed);
    let explored = false;
    let recoveredAt = -1;
    for (let k = idx + 1; k < calls.length && k <= idx + RECOVERY_WINDOW; k++) {
      const u = calls[k];
      if (isTaskSwitch(u)) break;
      if (u.name === failed.name && u.outcome === "ok" && [...useKeys(u)].some((x) => keys.has(x))) { recoveredAt = k; break; }
      if (isExploration(u)) explored = true;
    }
    if (recoveredAt < 0) { pattern.unrecovered++; continue; }
    pattern.recovery.push(recoveredAt - idx);
    if (explored) pattern.recoveryExplored++;
  }
}

export function recoveryNote(ps: readonly ScanPattern[]): string {
  const calls = ps.flatMap((p) => p.recovery).sort((a, b) => a - b);
  const unrecovered = ps.reduce((n, p) => n + p.unrecovered, 0);
  const total = calls.length + unrecovered;
  if (!total) return "";
  const at = (q: number): number => calls[Math.min(calls.length - 1, Math.floor(q * calls.length))];
  const explored = ps.reduce((n, p) => n + p.recoveryExplored, 0);
  return calls.length
    ? ` · rec ${at(0.5)}/${at(0.75)}, expl ${Math.round((100 * explored) / calls.length)}%, unrec ${unrecovered}/${total}`
    : ` · unrec ${unrecovered}/${total}`;
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = Math.max(a.length, b.length);
  if (!n) return 1;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return (p + s) / n;
}

export function dedupKeyOf(rec: Record<string, any>): string | undefined {
  if (rec.type !== "user" && rec.type !== "assistant") return undefined;
  const trId = Array.isArray(rec.message?.content) ? rec.message.content.find((b: any) => b?.type === "tool_result")?.tool_use_id : undefined;
  return trId ? `tr:${trId}` : rec.forkedFrom?.messageUuid ?? rec.uuid;
}

const errorBlocks = (rec: Record<string, any>): number => (rec.type === "user" && Array.isArray(rec.message?.content) ? rec.message.content.filter((b: any) => b?.type === "tool_result" && b.is_error).length : 0);

const AGENT_PROMPT_SCAN_LINES = 5;

export function isImprovementDelegation(text: string): boolean {
  return isImprovementFirstMessage(text) || /^\s*Read \S+brief\.md and follow it\b/.test(text);
}

export function isImprovementRecord(rec: Record<string, any>): boolean {
  if (rec.type !== "user") return false;
  const content = rec.message?.content;
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text as string) : [];
  return texts.some((t) => parseLaisoraInput(t)?.input.kind === "improvement" || isImprovementFirstMessage(t));
}

interface FileEntry { full: string; session: string; label: string; ref: string; isFork: boolean; depth: number; parentAgentId?: string }

async function* jsonLines(file: string, stats: ScanStats, limit = Infinity): AsyncGenerator<{ lineNo: number; rec: Record<string, any> | undefined }> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo > limit) break;
      if (!line.trim()) { yield { lineNo, rec: undefined }; continue; }
      if (line.length > IMPROVEMENT_LINE_MAX_CHARS) { stats.oversizedLines++; yield { lineNo, rec: undefined }; continue; }
      let rec: Record<string, any> | undefined;
      try { rec = JSON.parse(line); } catch { stats.unparsable++; }
      yield { lineNo, rec: rec && typeof rec === "object" ? rec : undefined };
    }
  } finally {
    rl.close();
  }
}

function forkMeta(full: string): { isFork: boolean; depth: number; parentAgentId?: string } {
  try {
    const m = JSON.parse(fs.readFileSync(full.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return { isFork: m.isFork === true, depth: typeof m.spawnDepth === "number" ? m.spawnDepth : 1, ...(typeof m.parentAgentId === "string" ? { parentAgentId: m.parentAgentId } : {}) };
  } catch {
    return { isFork: false, depth: 0 };
  }
}

export function listTranscriptFiles(projectsDir: string): FileEntry[] {
  const out: FileEntry[] = [];
  const dirents = (d: string): fs.Dirent[] => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  for (const project of dirents(projectsDir)) {
    if (!project.isDirectory()) continue;
    const pdir = path.join(projectsDir, project.name);
    for (const ent of dirents(pdir)) {
      const full = path.join(pdir, ent.name);
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const session = ent.name.replace(/\.jsonl$/, "");
        out.push({ full, session, label: "parent", ref: `${session.slice(0, 8)}:parent`, isFork: false, depth: 0 });
      } else if (ent.isDirectory()) {
        const sub = path.join(full, "subagents");
        for (const f of dirents(sub)) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const fileFull = path.join(sub, f.name);
          out.push({ full: fileFull, session: ent.name, label: f.name, ref: `${ent.name.slice(0, 8)}:${f.name.replace(/\.jsonl$/, "")}`, ...forkMeta(fileFull) });
        }
      }
    }
  }
  return out;
}

function settingsHookScripts(file: string, projectDir: string | undefined, home: string): string[] {
  let json: unknown;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const commands: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "command" && typeof x === "string") commands.push(x); else walk(x); }
  };
  walk((json as { hooks?: unknown } | undefined)?.hooks);
  return commands.flatMap((command) => commandScripts(command, projectDir, home));
}

export function commandScripts(command: string, projectDir: string | undefined, home: string): string[] {
  const expanded = command
    .replace(/\$\{?CLAUDE_PROJECT_DIR\}?|%CLAUDE_PROJECT_DIR%/g, projectDir ?? "")
    .replace(/\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE|(?<![\w.])~(?=[\\/])/g, home);
  const scripts: string[] = [];
  for (const m of expanded.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    const token = (m[1] ?? m[2] ?? m[3] ?? "").replace(/^["']|["']$/g, "");
    if (HOOK_SCRIPT_RE.test(token) && path.isAbsolute(token)) scripts.push(path.normalize(token));
  }
  return scripts;
}

const CONSTANT_DECL_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g;
const CONSTANT_REF_RE = /\$\{([A-Za-z_$][\w$]*)\}/g;
const CONSTANT_PASSES = 3;

export function literalConstants(texts: readonly string[]): Map<string, string> {
  const raw = new Map<string, string>();
  for (const t of texts) for (const m of t.matchAll(CONSTANT_DECL_RE)) if (!m[2].includes("\n") && !raw.has(m[1])) raw.set(m[1], m[2].slice(1, -1));
  const resolved = new Map<string, string>();
  for (let pass = 0; pass < CONSTANT_PASSES; pass++) {
    for (const [name, value] of raw) {
      if (resolved.has(name)) continue;
      const expanded = value.replace(CONSTANT_REF_RE, (all, ref: string) => resolved.get(ref) ?? all);
      if (!expanded.includes("${") && !expanded.includes("`")) resolved.set(name, expanded);
    }
  }
  return resolved;
}

export function expandConstants(text: string, constants: ReadonlyMap<string, string>): string {
  return constants.size ? text.replace(CONSTANT_REF_RE, (all, ref: string) => constants.get(ref) ?? all) : text;
}

export function discoverHookSources(configDir: string, cwds: Iterable<string>, laisoraSources: readonly string[] = []): { sources: HookSource[]; settingsFiles: string[] } {
  const home = os.homedir();
  const scriptPaths = new Set<string>();
  const settingsFiles: string[] = [];
  const seen = new Set<string>();
  const projectDirs = [undefined, ...[...cwds].filter((d) => { const k = pathKey(d); if (seen.has(k)) return false; seen.add(k); return true; })];
  for (const projectDir of projectDirs) {
    for (const file of claudeSettingsFiles(projectDir, configDir)) {
      if (!fs.existsSync(file)) continue;
      settingsFiles.push(file);
      for (const s of settingsHookScripts(file, projectDir, home)) scriptPaths.add(s);
    }
    const hooksDir = projectDir === undefined ? path.join(configDir, "hooks") : path.join(projectDir, ".claude", "hooks");
    try {
      for (const f of fs.readdirSync(hooksDir, { withFileTypes: true })) if (f.isFile() && HOOK_SCRIPT_RE.test(f.name)) scriptPaths.add(path.join(hooksDir, f.name));
    } catch { /* no hooks dir */ }
  }
  const read = (p: string, max: number): string | undefined => {
    try { return fs.statSync(p).size <= max ? fs.readFileSync(p, "utf8") : undefined; } catch { return undefined; }
  };
  const sources: HookSource[] = [];
  const laisora: { path: string; text: string }[] = [];
  for (const p of laisoraSources) { const text = read(p, LAISORA_SOURCE_MAX_BYTES); if (text !== undefined) laisora.push({ path: p, text }); }
  const constants = literalConstants(laisora.map((s) => s.text));
  for (const s of laisora) sources.push({ path: s.path, laisora: true, bundle: /\.[cm]?js$/i.test(s.path), text: expandConstants(s.text, constants) });
  const scriptKeys = new Set<string>();
  for (const p of [...scriptPaths].sort()) {
    if (scriptKeys.has(pathKey(p))) continue;
    scriptKeys.add(pathKey(p));
    const text = read(p, HOOK_SOURCE_MAX_BYTES);
    if (text !== undefined) sources.push({ path: p, laisora: false, bundle: false, text });
  }
  return { sources, settingsFiles };
}

const pathKey = (p: string): string => (process.platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p));

const HEAD_MAX = 80;
const HEADS_PER_REFUSAL = 12;
const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);
const LITERAL_OPENERS = ['"', "'", "`"];

export function sourceHeads(refusal: string): string[] {
  const literal = refusalLiteral(refusal).slice(0, HEAD_MAX).trimEnd();
  const heads = new Set<string>([literal]);
  for (let i = literal.length - 1; i > 0; i--) if (literal[i] === " ") heads.add(literal.slice(0, i).trimEnd());
  if (!isAscii(literal)) for (const n of [48, 32, 24]) heads.add(literal.slice(0, n).trimEnd());
  return [...heads].filter((h) => h.length >= SOURCE_HEAD_MIN).sort((a, b) => b.length - a.length).slice(0, HEADS_PER_REFUSAL);
}

export function sourceContainsHead(source: HookSource, head: string): boolean {
  if (!source.laisora) return source.text.includes(head);
  if (head.length < LAISORA_HEAD_MIN) return false;
  if (source.bundle && !isAscii(head)) return false;
  return LITERAL_OPENERS.some((q) => source.text.includes(q + head));
}

export function hookCommandScript(refusal: string, cwd: string | undefined, home: string = os.homedir()): string | undefined {
  const command = /^\[([^\]\n]{1,300})\]:/.exec(refusal)?.[1];
  if (command === undefined) return undefined;
  const script = projectHookScript(command, cwd, home) ?? command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")).find((t) => HOOK_SCRIPT_RE.test(t));
  return script === undefined ? undefined : path.normalize(script);
}

const projectScriptMemo = new Map<string, string | undefined>();

export function projectHookScript(command: string, cwd: string | undefined, home: string = os.homedir(), exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const first = commandScripts(command, cwd, home)[0];
  if (!cwd || !/CLAUDE_PROJECT_DIR/.test(command)) return first;
  const key = `${command}|${cwd}`;
  if (projectScriptMemo.has(key)) return projectScriptMemo.get(key);
  let found: string | undefined;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = commandScripts(command, dir, home)[0];
    if (candidate && exists(candidate)) { found = candidate; break; }
    if (path.dirname(dir) === dir) break;
  }
  const result = found ?? first;
  if (projectScriptMemo.size >= MEMO_MAX) projectScriptMemo.clear();
  projectScriptMemo.set(key, result);
  return result;
}

const SITE_STRONG_COVERAGE = 0.8;
const LITERAL_SCAN_MAX = 2000;
const FRAGMENT_KEY_CHARS = 20;
const FRAGMENT_KEY_MIN = 4;
const REFUSAL_DYNAMIC_RE = /\d+|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\([^)\n]*\)|（[^）\n]*）|「[^」\n]*」|<[^>\n]*>|\{[^}\n]*\}|\[[^\]\n]*\]/g;
const FIXED_CHAR_RE = /[A-Za-z぀-ヿ一-鿿]/g;

const refusalBody = (refusal: string): string => refusal.replace(/^\[[^\]\n]{1,200}\]:?\s*/, "");

export function refusalLiteral(refusal: string): string {
  return /^[^0-9"'`(（「<{\\]+/.exec(refusalBody(refusal))?.[0] ?? "";
}

export function literalFragments(text: string, start: number): string[] {
  const q = text[start - 1];
  const template = q === "`";
  const quoted = template || q === '"' || q === "'";
  const frags = [""];
  const end = Math.min(text.length, start + LITERAL_SCAN_MAX);
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "\n" && !template) break;
    if (c === "\\") { frags[frags.length - 1] += text[i + 1] ?? ""; i++; continue; }
    if (template && c === "$" && text[i + 1] === "{") {
      let depth = 1;
      for (i += 2; i < end && depth > 0; i++) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; }
      i--;
      frags.push("");
      continue;
    }
    if (quoted ? c === q : /["'`]/.test(c)) break;
    frags[frags.length - 1] += c;
  }
  return frags;
}

const fragmentKey = (f: string): string => f.replace(/^[\s.,;:)(（）\][]+/, "").slice(0, FRAGMENT_KEY_CHARS).trimEnd();

function lineOf(text: string, at: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < at; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

export interface SourceSite { readonly site: string; readonly strong: boolean }

export function sourceSite(pool: readonly HookSource[], refusal: string): SourceSite | undefined {
  const lit = refusalLiteral(refusal);
  if (!lit.trim()) return undefined;
  const rest = refusalBody(refusal).slice(lit.length);
  const restFixed = (rest.replace(REFUSAL_DYNAMIC_RE, "").match(FIXED_CHAR_RE) ?? []).length;
  const best = new Map<string, { score: number; eligible: boolean }>();
  for (const head of sourceHeads(refusal)) {
    for (const s of pool) {
      if (!sourceContainsHead(s, head)) continue;
      const starts: number[] = [];
      if (s.laisora) for (const q of LITERAL_OPENERS) for (let i = s.text.indexOf(q + head); i >= 0; i = s.text.indexOf(q + head, i + 1)) starts.push(i + 1);
      else for (let i = s.text.indexOf(head); i >= 0; i = s.text.indexOf(head, i + 1)) starts.push(i);
      for (const st of starts) {
        const frags = literalFragments(s.text, st);
        const first = frags[0];
        let common = 0;
        while (common < lit.length && common < first.length && lit[common] === first[common]) common++;
        const score = Math.min(1, common / lit.length, common / Math.max(first.length, 1));
        const later = frags.slice(1).map(fragmentKey).filter((k) => k.length >= FRAGMENT_KEY_MIN);
        const laterOk = later.length ? later.some((k) => rest.includes(k)) : restFixed < FRAGMENT_KEY_MIN;
        const eligible = score >= SITE_STRONG_COVERAGE && laterOk;
        const site = `${s.path}:${lineOf(s.text, st)}`;
        const prev = best.get(site);
        if (!prev || Number(eligible) - Number(prev.eligible) > 0 || (eligible === prev.eligible && score > prev.score)) best.set(site, { score, eligible });
      }
    }
    if (best.size) break;
  }
  const ranked = [...best].sort((a, b) => Number(b[1].eligible) - Number(a[1].eligible) || b[1].score - a[1].score);
  if (!ranked.length) return undefined;
  const strong = ranked[0][1].eligible && !ranked.slice(1).some(([, v]) => v.eligible);
  return { site: ranked[0][0], strong };
}

export function resolveHookOwner(refusal: string, sources: readonly HookSource[], cwd?: string, home: string = os.homedir()): { owner: string; sources: string[]; site?: string; siteStrong?: boolean } {
  const script = hookCommandScript(refusal, cwd, home);
  const withSite = (owner: string, list: string[], pool: readonly HookSource[]) => {
    const s = sourceSite(pool, refusal);
    return s ? { owner, sources: list, site: s.site, siteStrong: s.strong } : { owner, sources: list };
  };
  if (script) return withSite(script, [script], sources.filter((s) => pathKey(s.path) === pathKey(script)));
  for (const head of sourceHeads(refusal)) {
    const hits = sources.filter((s) => sourceContainsHead(s, head));
    if (!hits.length) continue;
    const scripts = hits.filter((s) => !s.laisora);
    const ordered = [...scripts, ...hits.filter((s) => s.laisora)];
    return withSite(scripts.length ? scripts[0].path : "LAISORA", ordered.map((s) => s.path), ordered);
  }
  const tag = /^\[([\w.-]{2,60})\]/.exec(refusal)?.[1];
  if (tag) {
    const byName = sources.filter((s) => !s.laisora && path.basename(s.path).toLowerCase().includes(tag.toLowerCase()));
    if (byName.length) return { owner: byName[0].path, sources: byName.map((s) => s.path) };
    return { owner: `unresolved [${tag}]`, sources: [] };
  }
  return { owner: "unresolved", sources: [] };
}

type PatternBase = Classified | { kind: "candidate" | "slow"; owner: string; detail: string; sample: string; uncertain?: string; script?: string };

function newPattern(base: PatternBase, key: string): ScanPattern {
  return { id: "", key, kind: base.kind, owner: base.owner, detail: base.detail, sample: base.sample, ...(base.uncertain ? { uncertain: base.uncertain } : {}), ...(base.script ? { script: base.script } : {}), variants: new Map(), durationsSec: [], backgrounded: 0, classifierChecked: 0, shapes: new Map(), recovery: [], recoveryExplored: 0, unrecovered: 0, count: 0, sessions: new Set(), retries: 0, retriesSame: 0, first: null, last: null, days: new Map(), actors: { main: 0, subagent: 0 }, tools: new Map(), locations: [] };
}

function bump(p: ScanPattern, loc: ScanLocation, session: string, variant?: string): void {
  p.count++;
  p.sessions.add(session);
  const date = loc.at ? loc.at.slice(0, 10) : null;
  if (variant !== undefined) {
    const v = p.variants.get(variant) ?? { count: 0, first: null, last: null };
    v.count++;
    if (date && (!v.first || date < v.first)) v.first = date;
    if (date && (!v.last || date > v.last)) v.last = date;
    p.variants.set(variant, v);
  }
  if (date && (!p.first || date < p.first)) p.first = date;
  if (date && (!p.last || date > p.last)) p.last = date;
  if (date) p.days.set(date, (p.days.get(date) ?? 0) + 1);
  p.actors[loc.actor]++;
  p.tools.set(loc.tool, (p.tools.get(loc.tool) ?? 0) + 1);
  p.locations.push(loc);
}

export async function scanTranscripts(opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const stats: ScanStats = { parentFiles: 0, subagentFiles: 0, subagentForkFiles: 0, filesRead: 0, unreadableFiles: 0, bytes: 0, lines: 0, unparsable: 0, oversizedLines: 0, duplicateRecords: 0, toolResults: 0, errorResults: 0, excludedImprovementSessions: 0, excludedImprovementAgents: 0, firstDate: null, lastDate: null, runtimeSec: 0 };
  const fileList = listTranscriptFiles(opts.projectsDir);
  stats.parentFiles = fileList.filter((f) => f.label === "parent").length;
  stats.subagentFiles = fileList.length - stats.parentFiles;
  stats.subagentForkFiles = fileList.filter((f) => f.isFork).length;

  const excluded = new Set<string>();
  for (const f of fileList.filter((x) => x.label === "parent")) {
    try {
      for await (const { rec } of jsonLines(f.full, stats, IMPROVEMENT_MARKER_SCAN_LINES)) if (rec && isImprovementRecord(rec)) { excluded.add(f.session); break; }
    } catch { /* unreadable: counted in the scan pass */ }
  }
  stats.excludedImprovementSessions = excluded.size;
  const previous = await earlierVerdicts(fileList.filter((f) => f.label === "parent" && excluded.has(f.session)));
  const excludedAgents = new Set<string>();
  const agentId = (f: FileEntry): string => f.label.replace(/^agent-|\.jsonl$/g, "");
  const subagents = fileList.filter((x) => x.label !== "parent" && !excluded.has(x.session));
  for (const f of subagents) {
    try {
      for await (const { rec } of jsonLines(f.full, stats, AGENT_PROMPT_SCAN_LINES)) {
        if (rec?.type !== "user") continue;
        if (isImprovementDelegation(notificationText(rec))) excludedAgents.add(`${f.session}|${agentId(f)}`);
        break;
      }
    } catch { /* unreadable: counted in the scan pass */ }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const f of subagents) if (f.parentAgentId && excludedAgents.has(`${f.session}|${f.parentAgentId}`) && !excludedAgents.has(`${f.session}|${agentId(f)}`)) { excludedAgents.add(`${f.session}|${agentId(f)}`); grew = true; }
  }
  stats.excludedImprovementAgents = excludedAgents.size;
  const files = fileList.filter((f) => !excluded.has(f.session) && !(f.label !== "parent" && excludedAgents.has(`${f.session}|${agentId(f)}`)));
  stats.unparsable = 0;
  stats.oversizedLines = 0;

  const origin = new Map<string, number>();
  const credited = new Set<string>();
  const cwds = new Set<string>();
  const checks = files.map((_, i) => ({ i, raw: 0, credited: 0, creditedFromForkCopy: 0, readable: true }));
  const originOrder = files.map((_, i) => i).sort((a, b) => Number(files[a].isFork) - Number(files[b].isFork) || files[a].depth - files[b].depth);
  const scratch: ScanStats = { ...stats };
  for (const i of originOrder) {
    const f = files[i];
    try {
      for await (const { rec } of jsonLines(f.full, scratch)) {
        if (!rec || rec.forkedFrom) continue;
        if (typeof rec.cwd === "string" && cwds.size < 500) cwds.add(rec.cwd);
        const k = dedupKeyOf(rec);
        const fresh = k !== undefined && !origin.has(k);
        if (fresh) origin.set(k!, i);
        if (!f.isFork || fresh) checks[i].raw += errorBlocks(rec);
      }
    } catch {
      checks[i].readable = false;
    }
  }

  const patterns = new Map<string, ScanPattern>();
  const candidates = new Map<string, ScanPattern>();
  const slow = new Map<string, ScanPattern>();
  const waitCalls = { count: 0, sessions: new Set<string>() };
  const unansweredQuestions = Object.fromEntries(ASK_UNANSWERED_KINDS.map((kind) => [kind, 0])) as Record<AskUnansweredKind, number>;
  const seenNotifications = new Set<string>();
  const seenHookEvents = new Set<string>();
  const countedResults = new Set<string>();
  const addCandidate = (sig: MaskedSignal, loc: ScanLocation, session: string): ScanPattern | undefined => {
    const key = `${sig.marker} | ${sig.owner} | ${reasonSignature(sig.reason) ?? sig.reason.slice(0, SIGNATURE_CHARS)}`;
    const once = `${key} | ${loc.path} | ${loc.line}`;
    if (countedResults.has(once)) return undefined;
    countedResults.add(once);
    let p = candidates.get(key);
    if (!p) candidates.set(key, (p = newPattern({ kind: "candidate", owner: sig.owner, detail: `${sig.marker}: ${sig.reason}`, sample: sig.reason, ...(sig.uncertain ? { uncertain: sig.uncertain } : {}), ...(sig.script ? { script: sig.script } : {}) }, key)));
    bump(p, loc, session, sig.reason);
    return p;
  };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const actor = f.label === "parent" ? "main" : "subagent";
    const uses = new Map<string, ToolUse>();
    const useOrder: ToolUse[] = [];
    const pendingRetry: { name: string; inp: string; idx: number; pattern: ScanPattern }[] = [];
    const pendingCandidate: { name: string; inp: string; idx: number; keys: Set<string>; sig: MaskedSignal; loc: ScanLocation }[] = [];
    let lastResultAt: string | null = null;
    const failures: { pattern: ScanPattern; idx: number }[] = [];
    const trackUse = (b: any, at: string | null): ToolUse => {
      const u: ToolUse = { name: String(b.name), input: b.input, inp: JSON.stringify(b.input ?? {}).slice(0, 4000), idx: useOrder.length, at };
      uses.set(b.id, u);
      useOrder.push(u);
      return u;
    };
    try {
      stats.bytes += fs.statSync(f.full).size;
      for await (const { lineNo, rec } of jsonLines(f.full, stats)) {
        stats.lines++;
        if (!rec) continue;
        const dedupKey = dedupKeyOf(rec);
        const content = rec.message?.content;
        if (dedupKey) {
          const originFile = origin.get(dedupKey);
          const own = originFile === undefined ? !credited.has(dedupKey) : originFile === i && !credited.has(dedupKey);
          if (!own) {
            stats.duplicateRecords++;
            if (rec.type === "assistant" && Array.isArray(content)) for (const b of content) if (b?.type === "tool_use") trackUse(b, typeof rec.timestamp === "string" ? rec.timestamp : null);
            continue;
          }
          credited.add(dedupKey);
        }
        const at = typeof rec.timestamp === "string" ? rec.timestamp : null;
        const day = at?.slice(0, 10) ?? null;
        if (day && (!stats.firstDate || day < stats.firstDate)) stats.firstDate = day;
        if (day && (!stats.lastDate || day > stats.lastDate)) stats.lastDate = day;
        if (rec.type === "assistant" && Array.isArray(content)) {
          for (const b of content) {
            if (b?.type !== "tool_use") continue;
            const u = trackUse(b, at);
            for (let k = pendingRetry.length - 1; k >= 0; k--) {
              const pr = pendingRetry[k];
              if (u.idx - pr.idx > RETRY_WINDOW) { pendingRetry.splice(k, 1); continue; }
              if (pr.name === u.name && similarity(pr.inp, u.inp) >= RETRY_SIM) { pr.pattern.retries++; if (pr.inp === u.inp) pr.pattern.retriesSame++; pendingRetry.splice(k, 1); }
            }
            let uKeys: Set<string> | undefined;
            for (let k = pendingCandidate.length - 1; k >= 0; k--) {
              const pc = pendingCandidate[k];
              if (u.idx - pc.idx > CANDIDATE_RETRY_WINDOW) { pendingCandidate.splice(k, 1); continue; }
              const sharesCommand = isShellTool(u.name) && [...(uKeys ??= retryKeys(u.input, u.name))].some((key) => pc.keys.has(key));
              if (pc.name === u.name && (sharesCommand || similarity(pc.inp, u.inp) >= CANDIDATE_RETRY_SIM)) {
                const confirmed = addCandidate(pc.sig, pc.loc, f.session);
                if (confirmed) failures.push({ pattern: confirmed, idx: pc.idx });
                pendingCandidate.splice(k, 1);
              }
            }
          }
          continue;
        }
        const notes = notificationText(rec);
        if (notes.includes("<task-notification>")) {
          for (const n of taskNotifications(sanitizeText(notes))) {
            const key = notificationKey(n);
            if (seenNotifications.has(key)) continue;
            seenNotifications.add(key);
            const use = n.toolUseId ? uses.get(n.toolUseId) : undefined;
            const sig = notificationSignal(n, use);
            if (sig) addCandidate(sig, { path: f.full, ref: `${f.ref}:${lineNo}`, line: lineNo, at, actor, tool: sig.tool }, f.session);
          }
        }
        const hookEvent = hookAttachment(rec);
        if (hookEvent && !seenHookEvents.has(hookEvent.key)) {
          seenHookEvents.add(hookEvent.key);
          const script = projectHookScript(hookEvent.command, typeof rec.cwd === "string" ? rec.cwd : undefined);
          const c: Classified = { kind: hookEvent.kind, owner: script ?? (hookEvent.command || "hook"), detail: hookEvent.detail, sample: hookEvent.sample };
          const key = `${c.kind} | ${c.owner} | ${c.detail}`;
          let p = patterns.get(key);
          if (!p) patterns.set(key, (p = { ...newPattern(c, key), ownerFixed: true }));
          bump(p, { path: f.full, ref: `${f.ref}:${lineNo}`, line: lineNo, at, actor, tool: hookEvent.hookName }, f.session);
        }
        if (rec.type !== "user" || !Array.isArray(content)) continue;
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          stats.toolResults++;
          const text = sanitizeText(textOf(b.content));
          const use = uses.get(b.tool_use_id);
          const loc: ScanLocation = { path: f.full, ref: `${f.ref}:${lineNo}`, line: lineNo, at, actor, tool: use?.name ?? "?" };
          if (use && isShellTool(use.name) && (!b.is_error || /^Exit code \d+/.test(text))) {
            const input = (use.input ?? {}) as { command?: unknown; run_in_background?: unknown };
            const start = use.at && lastResultAt && lastResultAt > use.at ? lastResultAt : use.at;
            const sec = start && at ? (Date.parse(at) - Date.parse(start)) / 1000 : NaN;
            const backgrounded = BACKGROUNDED_RE.test(text.slice(0, MASKED_SCAN_CHARS));
            const so = input.run_in_background !== true && (backgrounded || sec >= SLOW_CALL_SEC) ? slowOwner(input.command, use.name) : undefined;
            if (so?.wait) {
              waitCalls.count++;
              waitCalls.sessions.add(f.session);
            } else if (so) {
              let p = slow.get(so.owner);
              if (!p) slow.set(so.owner, (p = newPattern({ kind: "slow", owner: so.owner, detail: so.owner.replace(/^cmd:/, "").replace(/^chain:/, "chain: "), sample: typeof input.command === "string" ? input.command.slice(0, 200) : "" }, so.owner)));
              bump(p, loc, f.session, so.uncertain ?? SINGLE_CALL);
              if (Number.isFinite(sec)) p.durationsSec.push(Math.round(sec));
              if (backgrounded) p.backgrounded++;
              if ((rec as ToolFailureRecord).permissionDecision?.reasonType === "classifier") p.classifierChecked++;
            }
          }
          if (at && (!lastResultAt || at > lastResultAt)) lastResultAt = at;
          if (b.is_error) {
            stats.errorResults++;
            const c = classify(text, rec, use);
            const script = c.kind === "hook_denial" ? hookCommandScript(c.sample, typeof rec.cwd === "string" ? rec.cwd : undefined) : undefined;
            if (script) c.owner = script;
            const key = `${c.kind} | ${c.owner} | ${c.detail}`;
            let p = patterns.get(key);
            if (!p) patterns.set(key, (p = { ...newPattern(c, key), ...(script ? { ownerFixed: true } : {}) }));
            bump(p, loc, f.session);
            if (use) { use.outcome = "fail"; failures.push({ pattern: p, idx: use.idx }); }
            if (c.kind === "hook_denial" && use) { const shape = commandShape(use.name, use.input); const cur = p.shapes.get(shape); if (cur) cur.count++; else p.shapes.set(shape, { count: 1, ref: loc.ref }); }
            if (rec.forkedFrom) checks[i].creditedFromForkCopy++;
            else checks[i].credited++;
            if (use) pendingRetry.push({ name: use.name, inp: use.inp, idx: use.idx, pattern: p });
          } else if (use) {
            if (use.name === "AskUserQuestion") for (const kind of askUnansweredQuestions(singleToolUseResult(content, rec.toolUseResult)).values()) unansweredQuestions[kind]++;
            const sigs = maskedSignals(text, use.name, use.input);
            use.outcome = sigs.length ? "fail" : "ok";
            for (const sig of sigs) {
              if (!MASKED_MARKERS_NEEDING_RETRY.has(sig.marker)) { const confirmed = addCandidate(sig, loc, f.session); if (confirmed) failures.push({ pattern: confirmed, idx: use.idx }); }
              else pendingCandidate.push({ name: use.name, inp: use.inp, idx: use.idx, keys: retryKeys(use.input, use.name), sig, loc });
            }
          }
        }
      }
      measureRecovery(useOrder, failures);
      stats.filesRead++;
    } catch {
      stats.unreadableFiles++;
      checks[i].readable = false;
    }
  }

  const mismatches = checks.filter((c) => c.readable && c.raw !== c.credited).map((c) => ({ file: files[c.i].full, rawNonForkErrors: c.raw, credited: c.credited }));
  const selfCheck: SelfCheck = {
    filesChecked: checks.filter((c) => c.readable).length,
    mismatchFiles: mismatches.length,
    rawNonForkErrors: checks.reduce((a, c) => a + c.raw, 0),
    creditedNonFork: checks.reduce((a, c) => a + c.credited, 0),
    creditedFromForkCopyWithoutOrigin: checks.reduce((a, c) => a + c.creditedFromForkCopy, 0),
    mismatches: mismatches.slice(0, 50),
  };

  const { sources, settingsFiles } = discoverHookSources(opts.configDir, cwds, opts.laisoraSources);
  const byPriority = (a: ScanPattern, b: ScanPattern) => b.sessions.size - a.sessions.size || b.count - a.count;
  const pats = [...patterns.values()].sort(byPriority);
  const groups = new Map<string, { owner: string; sources: Set<string>; patterns: ScanPattern[] }>();
  for (const p of pats.filter((x) => x.kind === "hook_denial" || x.kind === "hook_failure")) {
    const fixedSite = p.ownerFixed ? sourceSite(sources.filter((s) => pathKey(s.path) === pathKey(p.owner)), p.sample) : undefined;
    const r = p.ownerFixed
      ? { owner: p.owner, sources: [p.owner], ...(fixedSite ? { site: fixedSite.site, siteStrong: fixedSite.strong } : {}) }
      : resolveHookOwner(p.sample, sources);
    p.owner = r.owner;
    if (r.site) { p.site = r.site; p.siteStrong = r.siteStrong === true; }
    let g = groups.get(r.owner);
    if (!g) groups.set(r.owner, (g = { owner: r.owner, sources: new Set(), patterns: [] }));
    r.sources.forEach((s) => g!.sources.add(s));
    g.patterns.push(p);
  }
  const hookGroups: HookGroup[] = [...groups.values()]
    .map((g) => ({ id: "", owner: g.owner, sources: [...g.sources], patterns: g.patterns, gates: hookGates(g.patterns) }))
    .sort((a, b) => b.patterns.reduce((n, p) => n + p.count, 0) - a.patterns.reduce((n, p) => n + p.count, 0));
  const cands = [...candidates.values()].sort(byPriority);
  const slowCalls = [...slow.values()].sort((a, b) => byPriority(a, b) || b.backgrounded - a.backgrounded);
  const failureClasses = buildFailureClasses(pats, cands);
  const owners = maskedOwners(cands, pats);
  const causes = buildCauses(pats, cands);
  const collisions = assignIds(hookGroups, pats, cands, owners, slowCalls, failureClasses, causes);
  stats.runtimeSec = +((now() - t0) / 1000).toFixed(1);
  return { stats, selfCheck, previous, idCollisions: collisions, patterns: pats, candidates: cands, maskedOwners: owners, causes, slowCalls, waitCalls: { count: waitCalls.count, conversations: waitCalls.sessions.size }, unansweredQuestions, failureClasses, hookGroups, hookSourcesRead: sources.map((s) => s.path), settingsFilesRead: settingsFiles };
}

const total = (ps: readonly ScanPattern[]): number => ps.reduce((n, p) => n + p.count, 0);

export function hookGates(patterns: readonly ScanPattern[]): HookGate[] {
  const bySite = new Map<string, ScanPattern[]>();
  const gates: HookGate[] = [];
  for (const p of patterns) {
    if (!p.site || !p.siteStrong) { gates.push({ site: undefined, patterns: [p] }); continue; }
    const list = bySite.get(p.site);
    if (list) list.push(p);
    else { const fresh = [p]; bySite.set(p.site, fresh); gates.push({ site: p.site, patterns: fresh }); }
  }
  for (const g of gates) g.patterns.sort((a, b) => (a.first ?? "").localeCompare(b.first ?? ""));
  return gates.sort((a, b) => total(b.patterns) - total(a.patterns));
}

const ANY_ERROR_CLASS = "any failure";

const detailReason = (detail: string): string => detail.replace(/^(?:exit \S+|[\w-]+):\s*/, "");

export interface MaskedOwner { id: string; readonly owner: string; readonly patterns: ScanPattern[]; readonly sessions: Set<string>; readonly count: number }

export const REASON_FAMILY_PREFIX = "reason:";

export function ownerGroupKey(p: ScanPattern): string {
  if (!p.owner.startsWith("chain:") && !p.owner.includes("$")) return p.owner;
  const reason = detailReason(p.detail);
  return `${REASON_FAMILY_PREFIX}${reasonSignature(reason) ?? reason.slice(0, SIGNATURE_CHARS)}`;
}

export function maskedOwners(cands: readonly ScanPattern[], pats: readonly ScanPattern[] = []): MaskedOwner[] {
  const byOwner = new Map<string, ScanPattern[]>();
  const oneOff = pats.filter((p) => LISTED_FROM_MIN_CONVERSATIONS.includes(p.kind as PatternKind) && !isListed(p));
  for (const p of [...cands, ...oneOff]) { const key = ownerGroupKey(p); byOwner.set(key, [...(byOwner.get(key) ?? []), p]); }
  return [...byOwner].map(([owner, ps]) => ({
    id: "", owner, patterns: [...ps].sort((a, b) => b.sessions.size - a.sessions.size || b.count - a.count),
    sessions: new Set(ps.flatMap((p) => [...p.sessions])), count: total(ps),
  })).sort((a, b) => b.sessions.size - a.sessions.size || b.count - a.count);
}

export function splitKeyOf(detail: string, errorClass: string): string {
  const reason = detailReason(detail);
  const token = errorClass.split(" ")[errorClass.startsWith("FAIL ") ? 1 : 0] ?? "";
  const at = token ? reason.indexOf(token) : -1;
  const after = (at >= 0 ? reason.slice(at + token.length) : reason).replace(/^[\s:,.\-\]\[)(]+/, "");
  return after.split(/\s+/).filter(Boolean).slice(0, SPLIT_WORDS).join(" ");
}

export function buildFailureClasses(pats: readonly ScanPattern[], cands: readonly ScanPattern[] = []): FailureClass[] {
  type Member = { p: ScanPattern; tier: string };
  const groups = new Map<string, { head: string; errorClass: string; members: Member[] }>();
  const add = (m: Member, head: string, errorClass: string): void => {
    const key = `${head} | ${errorClass}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { head, errorClass, members: [] }));
    g.members.push(m);
  };
  const rare: Member[] = [
    ...pats.filter((p) => LISTED_FROM_MIN_CONVERSATIONS.includes(p.kind as PatternKind) && !isListed(p)).map((p) => ({ p, tier: p.kind as string })),
    ...cands.filter((p) => p.sessions.size < IMPROVEMENT_MIN_CONVERSATIONS).map((p) => ({ p, tier: "masked" })),
  ];
  for (const m of rare) {
    if (m.p.owner.startsWith("chain:")) continue;
    const sig = reasonSignature(detailReason(m.p.detail));
    if (sig) add(m, commandClass(m.p.owner), sig);
    if (m.p.script && m.tier !== "masked") add(m, m.p.script, sig ?? ANY_ERROR_CLASS);
  }
  const make = (head: string, errorClass: string, members: readonly Member[], split?: string): FailureClass => {
    const sessions = new Set(members.flatMap(({ p }) => [...p.sessions]));
    return { id: "", tier: [...new Set(members.map(({ tier }) => tier))].sort().join("+"), head, errorClass, ...(split ? { split } : {}), patterns: members.map(({ p }) => p), sessions, count: members.reduce((n, { p }) => n + p.count, 0) };
  };
  const out: FailureClass[] = [];
  for (const g of groups.values()) {
    let rest = g.members;
    if (g.members.length > CLASS_MEMBER_CAP) {
      const buckets = new Map<string, Member[]>();
      for (const m of g.members) { const k = splitKeyOf(m.p.detail, g.errorClass); buckets.set(k, [...(buckets.get(k) ?? []), m]); }
      const kept = [...buckets].filter(([k, ms]) => k && ms.length > 1);
      for (const [k, ms] of kept) out.push(make(g.head, g.errorClass, ms, k));
      const used = new Set(kept.flatMap(([, ms]) => ms));
      rest = g.members.filter((m) => !used.has(m));
      if (kept.length && rest.length) { out.push(make(g.head, g.errorClass, rest, OTHER_REASONS)); continue; }
    }
    if (rest.length) out.push(make(g.head, g.errorClass, rest));
  }
  return out
    .filter((c) => c.patterns.length > 1 && c.sessions.size >= IMPROVEMENT_MIN_CONVERSATIONS)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.count - a.count);
}

export const STABLE_ID_HEX = 8;
const STABLE_ID_RE = new RegExp(`\\b[A-Z]-[0-9a-f]{${STABLE_ID_HEX}}\\b`);

export function stableId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, STABLE_ID_HEX)}`;
}

const KIND_PREFIX: Partial<Record<ScanPattern["kind"], string>> = {
  hook_denial: "H", hook_failure: "H", classifier_denial: "C", permission_prompt: "P", safety_check: "Y", nonzero_exit: "E", mcp_tool_error: "M", other: "O",
  builtin_tool_error: "B", classifier_unavailable: "N", candidate: "R", slow: "S",
};

export interface IdCollision { readonly id: string; readonly keys: readonly string[] }

export function idCollisions(assigned: readonly { readonly id: string; readonly key: string }[]): IdCollision[] {
  const keysOf = new Map<string, Set<string>>();
  for (const { id, key } of assigned) keysOf.set(id, (keysOf.get(id) ?? new Set()).add(key));
  return [...keysOf].filter(([, keys]) => keys.size > 1).map(([id, keys]) => ({ id, keys: [...keys] }));
}

function assignIds(hookGroups: readonly HookGroup[], pats: readonly ScanPattern[], cands: readonly ScanPattern[], owners: readonly MaskedOwner[], slowCalls: readonly ScanPattern[], classes: readonly FailureClass[], causes: readonly Cause[]): IdCollision[] {
  const assigned: { id: string; key: string }[] = [];
  const give = (prefix: string, key: string): string => { const id = stableId(prefix, key); assigned.push({ id, key }); return id; };
  for (const p of [...pats, ...cands, ...slowCalls]) { const pre = KIND_PREFIX[p.kind]; if (pre) p.id = give(pre, p.key); }
  for (const g of hookGroups) g.id = give("H", `group:${g.owner}`);
  for (const o of owners) o.id = give("U", o.owner);
  for (const c of classes) c.id = give("K", `${c.head} | ${c.errorClass} | ${c.split ?? ""}`);
  for (const c of causes) c.id = give("X", c.family);
  return idCollisions(assigned);
}

export function isListed(p: ScanPattern): boolean {
  if (LISTED_IN_ANY_CONVERSATION.includes(p.kind as PatternKind)) return true;
  return LISTED_FROM_MIN_CONVERSATIONS.includes(p.kind as PatternKind) && p.sessions.size >= IMPROVEMENT_MIN_CONVERSATIONS;
}

const md = (s: string): string => sanitizeText(s).replace(/\|/g, "\\|").replace(/`/g, "'");

export function compactDays(days: ReadonlyMap<string, number>, limit = INDEX_DAYS): string {
  const entries = [...days].sort(([a], [b]) => a.localeCompare(b));
  const shown = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  const body = shown.map(([d, n]) => `${d.slice(5)}:${n}`).join(" ");
  return entries.length > limit ? `(${entries.length - limit} earlier days in patterns.json) ${body}` : body;
}

function splitOf(map: ReadonlyMap<string, number>): string {
  return [...map].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
}

function spreadLocations(locations: readonly ScanLocation[]): string[] {
  const sessionsOf = new Set<string>();
  const locs: string[] = [];
  for (const l of locations) {
    const session = l.ref.split(":")[0];
    if (sessionsOf.has(session)) continue;
    sessionsOf.add(session);
    locs.push(l.ref);
    if (locs.length >= INDEX_LOCATIONS) break;
  }
  return locs;
}

const VARIANTS_SHOWN = 2;
const VARIANT_CHARS = 60;
const siteLabel = (site: string): string => { const m = /^(.*):(\d+)$/.exec(site); return m ? `${path.basename(m[1])}:${m[2]}` : site; };

function patternLine(p: ScanPattern, withDays: boolean, indent = ""): string {
  const candidate = p.kind === "candidate";
  const parts = [
    `${p.count} in ${p.sessions.size} conv`,
    ...(candidate ? [] : [`retried ${p.retries} (same input ${p.retriesSame})`]),
    `${p.first ?? "?"}..${p.last ?? "?"}`,
    `main ${p.actors.main} / subagent ${p.actors.subagent}`,
    ...(p.tools.size === 1 ? [] : [`tools: ${splitOf(p.tools)}`]),
  ];
  if (withDays) parts.push(`days: ${compactDays(p.days)}`);
  if (candidate && p.variants.size > 1) {
    const others = [...p.variants].filter(([v]) => !p.detail.endsWith(v)).sort((a, b) => b[1].count - a[1].count).slice(0, VARIANTS_SHOWN);
    parts.push(`${p.variants.size} reasons, also: ${others.map(([v, s]) => `"${md(v.slice(0, VARIANT_CHARS))}" ${s.count}`).join("; ")}`);
  }
  parts.push(`at ${spreadLocations(p.locations).join(", ")}`);
  const ownerTag = p.kind === "hook_denial" || p.kind === "classifier_denial" || p.kind === "classifier_unavailable" ? "" : ` \`${md(p.owner)}\``;
  const recovery = p.kind === "hook_denial" ? recoveryNote([p]) : "";
  return `${indent}- **${p.id}**${ownerTag} ${md(markCut(p.detail))}${p.uncertain ? ` (${md(p.uncertain)})` : ""} — ${parts.join(" · ")}${recovery}`;
}

const SHAPES_SHOWN = 6;
const SHAPE_HEADS = 2;

function pathKind(file: unknown): string {
  if (typeof file !== "string" || !file) return "?";
  const p = file.replace(/\\+/g, "/");
  const dot = /\/\.claude\/(hooks|rules|skills|agents|commands)\//.exec(p)?.[1];
  if (dot) return `.claude/${dot}`;
  if (/\/\.claude\/settings[\w.-]*\.json$/.test(p)) return ".claude/settings";
  if (/(?:^|\/)(?:CLAUDE|AGENTS)\.md$/.test(p)) return "CLAUDE.md";
  if (/\/memory\//.test(p)) return "memory";
  const ext = /\.([A-Za-z0-9]+)$/.exec(p)?.[1];
  return ext ? `*.${ext}` : "other";
}

export function commandShape(tool: string, input: unknown): string {
  const inp = (input ?? {}) as { command?: unknown; file_path?: unknown; notebook_path?: unknown };
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return `${tool} ${pathKind(inp.file_path ?? inp.notebook_path)}`;
  if (!isShellTool(tool) || typeof inp.command !== "string") return tool;
  const cmd = inp.command;
  const segs = splitCommand(cmd, tool);
  const heads = [...new Set(programIndexes(segs, tool).map((i) => {
    const w = segmentWord(segs[i].text);
    if (w !== "git") return w;
    const sub = /^git\s+(?:-C\s+\S+\s+)?(\S+)(?:\s+(pop|apply|drop|push|list))?/.exec(segmentBody(segs[i].text));
    return sub ? `git ${sub[1]}${sub[1] === "stash" && sub[2] ? ` ${sub[2]}` : ""}` : "git";
  }))];
  const flags: string[] = [];
  if (/\bgit\s+(?:-C\s+\S+\s+)?stash\b(?!\s+(?:pop|apply|list|show|drop))/.test(cmd) && /\bgit\s+(?:-C\s+\S+\s+)?stash\s+(?:pop|apply)\b/.test(cmd)) flags.push("stash round trip");
  if (/\brm\s+-\w*[rR]/.test(cmd) || /Remove-Item\b[^|;]*-Recurse/.test(cmd)) flags.push("recursive delete");
  if (/(?:^|[^0-9&>])>{1,2}(?!&)\s*[^\s&|]/.test(cmd.replace(/2>&1|>\s*\/dev\/null|>\s*\$null/g, ""))) flags.push("redirect");
  return `${tool} ${heads.slice(0, SHAPE_HEADS).join(" + ") || "?"}${heads.length > SHAPE_HEADS ? " + …" : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

function shapeLine(ps: readonly ScanPattern[]): string | undefined {
  const all = new Map<string, { count: number; ref: string }>();
  for (const p of ps) for (const [k, v] of p.shapes) { const cur = all.get(k); if (cur) cur.count += v.count; else all.set(k, { ...v }); }
  if (all.size < 2) return undefined;
  const ranked = [...all].sort((a, b) => b[1].count - a[1].count);
  return `  - stopped operations (${all.size} shapes): ${ranked.slice(0, SHAPES_SHOWN).map(([k, v]) => `${md(k)} ×${v.count} at ${v.ref}`).join("; ")}${ranked.length > SHAPES_SHOWN ? `; ${ranked.length - SHAPES_SHOWN} more` : ""}`;
}

function gateLines(gate: HookGate): string[] {
  const ps = gate.patterns;
  const p0 = ps[0];
  const site = gate.site ? ` · site ${md(siteLabel(gate.site))}` : p0.site ? ` · prefix-only site ${md(siteLabel(p0.site))}` : "";
  const shapes = shapeLine(ps);
  if (ps.length === 1) return [patternLine(p0, true) + site, ...(shapes ? [shapes] : [])];
  const sessions = new Set(ps.flatMap((p) => [...p.sessions]));
  const first = ps.map((p) => p.first ?? "").filter(Boolean).sort()[0] ?? "?";
  const last = ps.map((p) => p.last ?? "").filter(Boolean).sort().pop() ?? "?";
  return [
    `- one gate${site}, ${ps.length} refusal texts — ${total(ps)} stops in ${sessions.size} conv · ${first}..${last} · retried ${ps.reduce((n, p) => n + p.retries, 0)} (same input ${ps.reduce((n, p) => n + p.retriesSame, 0)})${recoveryNote(ps)}`,
    ...ps.map((p) => patternLine(p, true, "  ")),
    ...(shapes ? [shapes] : []),
  ];
}

function slowLine(p: ScanPattern): string {
  const d = [...p.durationsSec].sort((a, b) => a - b);
  const median = d.length ? d[Math.floor(d.length / 2)] : undefined;
  const parts = [
    `${p.count} in ${p.sessions.size} conv`,
    `moved to background ${p.backgrounded}`,
    `auto mode classifier checked ${p.classifierChecked}`,
    median === undefined ? "duration ?" : `median ${median} s, max ${d[d.length - 1]} s`,
    `${p.first ?? "?"}..${p.last ?? "?"}`,
    `main ${p.actors.main} / subagent ${p.actors.subagent}`,
    `at ${spreadLocations(p.locations).join(", ")}`,
  ];
  const chainLists = [...p.variants].filter(([v]) => v !== SINGLE_CALL).sort((a, b) => b[1].count - a[1].count);
  const chainCalls = chainLists.reduce((n, [, s]) => n + s.count, 0);
  const kind = chainCalls ? `${chainCalls} of the calls are chains where other commands may hold the time: ${chainLists.slice(0, VARIANTS_SHOWN).map(([v, s]) => `${md(v.replace(/^chain not attributed: /, ""))} ×${s.count}`).join("; ")}` : "";
  return `- **${p.id}** \`${md(p.detail)}\`${kind ? ` (${kind})` : ""} — ${parts.join(" · ")}`;
}

const REFUSAL_REASON_RE = /\b(?:refused|refusing|rejected|denied|not allowed|blocked|precondition|aborted)\b|拒否|中止|停止/i;

export function markCut(text: string, max = Infinity): string {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return /[（(「\[]\s*…?$/.test(cut) ? `${cut} [text cut off here]` : cut;
}

function ownerLine(o: MaskedOwner): string {
  const shown = o.patterns.slice(0, OWNER_REASONS_SHOWN);
  const markers = new Map<string, number>();
  for (const p of o.patterns) { const m = p.detail.split(":")[0]; markers.set(m, (markers.get(m) ?? 0) + p.count); }
  const reasons = shown.map((p) => `**${p.id}** "${md(markCut(detailReason(p.detail), OWNER_REASON_CHARS))}" ${p.count} in ${p.sessions.size} conv at ${p.locations[0]?.ref ?? "?"}`);
  const more = o.patterns.length > shown.length ? `; ${o.patterns.length - shown.length} more reasons` : "";
  const chain = o.patterns.find((p) => p.uncertain)?.uncertain;
  return `- **${o.id}** \`${md(o.owner)}\`${chain ? ` (${md(chain)})` : ""} — ${o.count} results in ${o.sessions.size} conv, ${o.patterns.length} distinct reasons · markers: ${splitOf(markers)} · ${reasons.join("; ")}${more}${recoveryNote(o.patterns)}`;
}


export interface Cause { id: string; readonly family: string; readonly patterns: ScanPattern[]; readonly sessions: Set<string>; readonly days: Set<string>; readonly count: number }

const NAMED_ERROR_RE = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b|\b(ERR_[A-Z][A-Z_]{2,})\b|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:error|failed|failure))\b/;
const CAUSE_WORDS = 2;
const CAUSE_PREFIX_WORDS = 3;
const CROSS_TOOL_PATH_HINTS = new Set([ENV_MANGLED_ARGUMENT, "non-ASCII name shown escaped"]);
const isEnvironmentCause = (family: string): boolean => CROSS_TOOL_PATH_HINTS.has(family) || /Git Bash path|codec|\bcp\d+\b/.test(family);
const INLINE_HEAD_RE = /\s-(?:inline|heredoc)$/;

export function causeFamily(reason: string): string | undefined {
  const core = lineCore(reason);
  if (FAIL_LINE_RE.test(core) || ESBUILD_ERROR_RE.test(core) || CODE_LINE_RE.test(core)) return reasonSignature(reason);
  const pathHint = /\[path: ([^\]]+)\]/.exec(reason)?.[1];
  if (pathHint && CROSS_TOOL_PATH_HINTS.has(pathHint)) return pathHint;
  const plain = reason.replace(/\s*\[(?:path|missing): [^\]]+\]/g, "");
  if (/\$'\\[0-9N]/.test(plain)) return "non-ASCII name shown escaped";
  if (/\uFFFD/.test(plain)) return /\uFFFD[\s.…]*$/.test(plain) ? "truncated multibyte text" : "garbled characters in output";
  const missing = /\[missing: ([^\]]+)\]/.exec(reason)?.[1];
  const named = NAMED_ERROR_RE.exec(reason);
  if (named) {
    const cls = named[1] ?? named[2] ?? named[3];
    if (missing) return `${cls} ${missing}`;
    if (pathHint) return `${cls} ${pathHint}`;
    const codec = /'(\w+)' codec/.exec(reason)?.[1];
    if (codec) return `${cls} ${codec}`;
    const after = reason.slice(named.index + cls.length).replace(/^[\]\s:,(\[]+/, "").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, CAUSE_WORDS).join(" ");
    return after ? `${cls} ${after}` : cls;
  }
  const prefix = looksLikeCode(core) ? null : /^(fatal|error|npm ERR!|npm error|[\w.-]{2,40}):\s*(.*)$/.exec(core);
  const words = prefix ? prefix[2].split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z-]*[,:]?$/.test(w)).slice(0, CAUSE_PREFIX_WORDS).map((w) => w.replace(/[,:]$/, "")) : [];
  return prefix && words.length ? `${prefix[1]}: ${words.join(" ")}` : undefined;
}

export function buildCauses(pats: readonly ScanPattern[], cands: readonly ScanPattern[]): Cause[] {
  const groups = new Map<string, ScanPattern[]>();
  const members = [...pats.filter((p) => LISTED_FROM_MIN_CONVERSATIONS.includes(p.kind as PatternKind)), ...cands];
  for (const p of members) {
    const reason = detailReason(p.detail);
    const family = INLINE_HEAD_RE.test(commandClass(p.owner)) && /\bSyntaxError\b/.test(reason) ? "inline code SyntaxError" : causeFamily(reason);
    if (family) groups.set(family, [...(groups.get(family) ?? []), p]);
  }
  return [...groups].map(([family, ps]) => ({
    id: "", family, patterns: ps, sessions: new Set(ps.flatMap((p) => [...p.sessions])), days: new Set(ps.flatMap((p) => [...p.days.keys()])), count: total(ps),
  })).sort((a, b) => b.sessions.size - a.sessions.size || b.count - a.count);
}

const CAUSE_SPANS_SHOWN = 8;
const CAUSE_TAIL_MIN_CONVERSATIONS = 3;
const CAUSE_TAIL_SPANS = 2;
const SLOW_TAIL_MIN_CONVERSATIONS = 3;

const spannedIds = (c: Cause, spanOf: (p: ScanPattern) => string): string[] => [...new Set(c.patterns.map(spanOf).filter(Boolean))];

function causeLine(c: Cause, spanOf: (p: ScanPattern) => string): string {
  const spans = spannedIds(c, spanOf);
  const locs = spreadLocations(c.patterns.flatMap((p) => p.locations)).slice(0, 1);
  const id = /^FAIL (\S+)$/.exec(c.family)?.[1];
  const family = id && failFamily(id) !== id ? ` (test family ${md(failFamily(id))})` : "";
  const messages = c.family === "inline code SyntaxError" ? ` (messages: ${[...new Set(c.patterns.map((p) => detailReason(p.detail).replace(/^.*?SyntaxError:?\s*/, "").slice(0, 30)))].slice(0, 3).map((m) => `"${md(m)}"`).join(", ")})` : "";
  return `- **${c.id}** \`${md(c.family)}\`${family}${messages} — ${c.count} results in ${c.sessions.size} conv over ${c.days.size} days, last ${[...c.days].sort().pop() ?? "?"}, ${c.patterns.length} patterns · spans ${spans.slice(0, CAUSE_SPANS_SHOWN).join(", ")}${spans.length > CAUSE_SPANS_SHOWN ? `, +${spans.length - CAUSE_SPANS_SHOWN} more` : ""}${recoveryNote(c.patterns)} · at ${locs.join(", ")}`;
}

export interface EarlierAnalysis { readonly conversation: string; readonly at: string | null; readonly state: "no_block" | "unreadable" | "used"; readonly reason?: string }

export interface PreviousVerdicts {
  readonly earlier: readonly EarlierAnalysis[];
  readonly entries: readonly ImprovementVerdict[];
  readonly invalid: readonly string[];
}

async function lastBlockOf(file: string): Promise<{ at: string | null; block?: string; error?: string }> {
  const scratch = { oversizedLines: 0, unparsable: 0 } as ScanStats;
  let lastAt: string | null = null;
  let blockAt: string | null = null;
  let block: string | undefined;
  try {
    for await (const { rec } of jsonLines(file, scratch)) {
      if (!rec) continue;
      const at = typeof rec.timestamp === "string" ? rec.timestamp : null;
      if (at && (!lastAt || at > lastAt)) lastAt = at;
      const content = rec.type === "assistant" ? rec.message?.content : undefined;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        const found = b?.type === "text" && typeof b.text === "string" ? lastVerdictsBlock(b.text) : undefined;
        if (found !== undefined) { block = found; blockAt = at; }
      }
    }
  } catch (e) {
    return { at: blockAt ?? lastAt, error: e instanceof Error ? e.message : String(e) };
  }
  return block !== undefined ? { at: blockAt, block } : { at: lastAt };
}

async function earlierVerdicts(analyses: readonly FileEntry[]): Promise<PreviousVerdicts> {
  const read = await Promise.all(analyses.map(async (f) => ({ f, ...(await lastBlockOf(f.full)) })));
  read.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const earlier: EarlierAnalysis[] = [];
  for (const x of read) {
    const base = { conversation: x.f.session.slice(0, 8), at: x.at };
    if (x.error !== undefined) { earlier.push({ ...base, state: "unreadable", reason: x.error }); continue; }
    if (x.block === undefined) { earlier.push({ ...base, state: "no_block" }); continue; }
    const parsed = parseVerdicts(x.block);
    if ("error" in parsed) { earlier.push({ ...base, state: "unreadable", reason: parsed.error }); continue; }
    earlier.push({ ...base, state: "used" });
    return { earlier, entries: parsed.entries, invalid: parsed.invalid };
  }
  return { earlier, entries: [], invalid: [] };
}

export interface FixCounts { readonly before: number; readonly after: number; readonly afterConversations: number; readonly undated: number }

export function countsAround(locations: readonly ScanLocation[], fixAt: string): FixCounts {
  const fix = Date.parse(fixAt);
  let before = 0, after = 0, undated = 0;
  const conversations = new Set<string>();
  for (const l of locations) {
    const at = l.at ? Date.parse(l.at) : NaN;
    if (Number.isNaN(at)) undated++;
    else if (at > fix) { after++; conversations.add(l.ref.split(":")[0]); }
    else before++;
  }
  return { before, after, afterConversations: conversations.size, undated };
}

function itemLocations(r: ScanResult): Map<string, () => ScanLocation[]> {
  const m = new Map<string, () => ScanLocation[]>();
  const flat = (ps: readonly ScanPattern[]) => (): ScanLocation[] => ps.flatMap((p) => p.locations);
  for (const p of [...r.patterns, ...r.candidates, ...r.slowCalls]) if (p.id) m.set(p.id, () => p.locations);
  for (const o of r.maskedOwners) m.set(o.id, flat(o.patterns));
  for (const c of r.causes) m.set(c.id, flat(c.patterns));
  for (const c of r.failureClasses) m.set(c.id, flat(c.patterns));
  for (const g of r.hookGroups) m.set(g.id, flat(g.patterns));
  return m;
}

const PREV_REASON_CHARS = 120;
const INDEX_BUILTIN = 16;
const BOLD_ID_RE = new RegExp(`\\*\\*(${STABLE_ID_RE.source})\\*\\*`, "g");

function previousText(v: ImprovementVerdict, locations: readonly ScanLocation[] | undefined, records: string): string {
  const head = `${v.verdict}${v.group ? ` ${v.group}` : ""}${v.status ? ` (${v.status})` : ""} "${md(markCut(v.reason, PREV_REASON_CHARS))}"`;
  let fix = "";
  if (v.fixCommit || v.fixDate) {
    const c = v.fixDate && locations ? countsAround(locations, v.fixDate) : undefined;
    fix = ` · fix ${md(v.fixCommit ?? "?")} at ${md(v.fixDate ?? "?")}${c ? `: ${c.before} before, ${c.after} after in ${c.afterConversations} conv${c.undated ? `, ${c.undated} undated` : ""}` : ""}`;
  }
  const last = locations ? locations.reduce<string | null>((m, l) => (l.at && (!m || l.at > m) ? l.at : m), null) : null;
  const seen = !locations ? ` · not in this scan (records ${records})` : ` · ${locations.length} in this scan, last seen ${last?.slice(0, 10) ?? "?"}`;
  return `${head}${fix}${seen}`;
}

export interface IndexContext { readonly generatedAt: string; readonly projectsDir: string }

export function renderIndex(r: ScanResult, ctx: IndexContext): string {
  const s = r.stats;
  const prev = r.previous;
  const prevById = new Map<string, ImprovementVerdict>();
  for (const e of prev.entries) if (!prevById.has(e.id)) prevById.set(e.id, e);
  const locationsOf = itemLocations(r);
  const records = `${s.firstDate ?? "?"}..${s.lastDate ?? "?"}`;
  const listedIds = new Set<string>();
  const prevOf = (id: string): string => {
    const v = prevById.get(id);
    return v ? previousText(v, locationsOf.get(id)?.(), records) : "";
  };
  const prevNote = (id: string): string => {
    listedIds.add(id);
    const text = prevOf(id);
    return text ? ` · prev: ${text}` : "";
  };
  const tailNote = (id: string): string => {
    listedIds.add(id);
    const text = prevOf(id);
    return text ? ` (prev: ${text})` : "";
  };
  const ownerOfPattern = new Map<ScanPattern, string>();
  for (const o of r.maskedOwners) for (const p of o.patterns) ownerOfPattern.set(p, o.id);
  const spanOf = (p: ScanPattern): string => ownerOfPattern.get(p) ?? p.id;
  const listed = r.patterns.filter(isListed);
  const byKind = (k: PatternKind) => listed.filter((p) => p.kind === k);
  const convs = (ps: readonly ScanPattern[]) => new Set(ps.flatMap((p) => [...p.sessions])).size;
  const out: string[] = [];
  out.push("# Improvement analysis index", "");
  out.push(`Generated ${ctx.generatedAt} from ${ctx.projectsDir}: ${s.parentFiles} conversations, ${s.subagentFiles} subagent files (${s.subagentForkFiles} forks), ${(s.bytes / 1e9).toFixed(2)} GB, records ${s.firstDate ?? "?"}..${s.lastDate ?? "?"}, ${s.errorResults} failed tool results, scan ${s.runtimeSec} s.`);
  out.push(`Not read: ${s.excludedImprovementSessions} earlier improvement-analysis conversations and ${s.excludedImprovementAgents} analysis subagent files, ${s.unreadableFiles} unreadable files, ${s.unparsable} unparsable lines, ${s.oversizedLines} oversized lines.`);
  out.push("Location = `<conversation id prefix>:<parent | subagent file>:<line>`. Open it with the record command in brief.md. patterns.json (same folder) has every location of every pattern with its absolute path and timestamp; days are MM-DD:count.");
  for (const c of r.idCollisions) out.push(`Warning: id ${c.id} is shared by ${c.keys.length} different grouping keys, so their lines and previous verdicts are merged under it: ${c.keys.map((k) => `"${md(k)}"`).join(", ")}.`);
  const accountingAt = out.length;
  out.push("");
  const previousAt = out.length;
  out.push("", `Recovery: "rec m/p" = tool calls until the same command next succeeded (median/p75), "expl" = share of those recoveries with file reading or searching in between, "unrec" = failures not followed by a success of the same command within ${RECOVERY_WINDOW} calls.`, "");

  out.push("## Hooks and gates (every stop, any number of conversations)", "");
  out.push("Stops whose refusal texts match the same source literal for most of its fixed part (and of theirs) are one gate entry, with each refusal text and its date range under it; a text that stops while another of the same entry continues is a rewording, not a fix. 'prefix-only site' marks a pattern whose text shares only its start with that source line: it is not merged, check the source before treating it as the same gate.", "");
  if (!r.hookGroups.length) out.push("- none", "");
  r.hookGroups.forEach((g) => {
    const ps = g.patterns;
    const retried = ps.reduce((n, p) => n + p.retries, 0);
    out.push(`### ${g.id} ${md(g.owner)} — ${total(ps)} stops in ${convs(ps)} conversations, retried ${retried}${prevNote(g.id)}`);
    out.push(g.sources.length ? `source: ${g.sources.map(md).join(", ")}` : "source: not resolved (search the hook scripts and settings files listed at the end for the refusal text)");
    for (const gate of g.gates) out.push(...gateLines(gate));
    out.push("");
  });

  const minConv = `${IMPROVEMENT_MIN_CONVERSATIONS}+ conversations`;
  const anyCount = (title: string, k: PatternKind): void => { out.push(title, "", ...(byKind(k).length ? byKind(k).map((p) => patternLine(p, true)) : ["- none"]), ""); };
  anyCount("## Auto mode classifier denials (each reason, any number of conversations)", "classifier_denial");
  anyCount("## Permission prompts not granted (each prompt kind, any number of conversations; a permission rule candidate, not a user refusal)", "permission_prompt");
  anyCount("## Claude Code safety checks (each command, any number of conversations)", "safety_check");
  out.push(`## MCP tool errors in ${minConv}`, "");
  out.push(...(byKind("mcp_tool_error").length ? byKind("mcp_tool_error").map((p) => patternLine(p, true)) : ["- none"]), "");

  const causes = r.causes.filter((c) => c.sessions.size >= IMPROVEMENT_MIN_CONVERSATIONS);
  const listedCauses = causes.slice(0, INDEX_CAUSES);
  const causeOf = new Map<ScanPattern, string>();
  for (const c of listedCauses) for (const p of c.patterns) causeOf.set(p, c.id);
  const coverNote = (ps: readonly ScanPattern[]): string => {
    const ids = [...new Set(ps.map((p) => causeOf.get(p)).filter((x): x is string => !!x))];
    if (!ids.length) return "";
    return ps.every((p) => causeOf.has(p)) ? ` · covered by ${ids.join(", ")}` : ` · partly in ${ids.join(", ")}`;
  };
  const fullyCovered = (ps: readonly ScanPattern[]): boolean => ps.every((p) => causeOf.has(p));
  const failureLine = (p: ScanPattern): string => (fullyCovered([p]) ? `- **${p.id}** \`${md(p.owner)}\` ${md(p.detail.slice(0, COMPACT_DETAIL_CHARS))} — ${p.count} in ${p.sessions.size} conv${coverNote([p])}` : patternLine(p, false) + coverNote([p]));
  const ownerEntry = (o: MaskedOwner): string => (fullyCovered(o.patterns) ? `- **${o.id}** \`${md(o.owner)}\` — ${o.count} results in ${o.sessions.size} conv, ${o.patterns.length} reasons${recoveryNote(o.patterns)}${coverNote(o.patterns)}` : ownerLine(o) + coverNote(o.patterns));
  out.push(`## Causes in ${minConv} (one cause = an error class with its decisive token, a failing test id, an upper-case code, or a program's diagnostic prefix, rolled up across command failures, masked and one-off results; ranked by conversations)`, "");
  out.push(...(listedCauses.length ? listedCauses.map((c) => causeLine(c, spanOf)) : ["- none"]));
  const causeTail = causes.slice(INDEX_CAUSES).filter((c) => c.sessions.size >= CAUSE_TAIL_MIN_CONVERSATIONS || isEnvironmentCause(c.family));
  if (causeTail.length) out.push(`- more causes in ${CAUSE_TAIL_MIN_CONVERSATIONS}+ conversations (and environment causes in 2+; id key results/conversations: spanned ids): ${causeTail.map((c) => `${c.id} ${md(c.family)} ${c.count}/${c.sessions.size}: ${spannedIds(c, spanOf).slice(0, CAUSE_TAIL_SPANS).join(",")}${tailNote(c.id)}`).join("; ")}`);
  if (causes.length > listedCauses.length + causeTail.length) out.push(`- ${causes.length - listedCauses.length - causeTail.length} more causes in fewer conversations in patterns.json (causes)`);
  out.push("");

  out.push(`## Command failures (nonzero exit) in ${minConv}`, "");
  out.push(...(byKind("nonzero_exit").length ? byKind("nonzero_exit").map(failureLine) : ["- none"]), "");
  if (byKind("other").length) out.push(`## Other failed results in ${minConv}`, "", ...byKind("other").map(failureLine), "");
  const builtin = r.patterns.filter((p) => p.kind === "builtin_tool_error");
  const builtinMin = builtin.filter((p) => p.sessions.size >= IMPROVEMENT_MIN_CONVERSATIONS);
  const builtinListed = builtinMin.slice(0, INDEX_BUILTIN);
  out.push(`## Claude Code built-in tool errors in ${minConv} (the tool's own error result; the agent's misuse or a Claude Code defect)`, "");
  out.push(...(builtinListed.length ? builtinListed.map((p) => patternLine(p, false)) : ["- none"]));
  if (builtinMin.length > builtinListed.length) out.push(`- ${builtinMin.length - builtinListed.length} more in ${minConv} in patterns.json`);
  out.push("");

  const attributedOwner = (o: MaskedOwner): boolean => !o.owner.startsWith(REASON_FAMILY_PREFIX) && !o.owner.startsWith("tool:mcp__");
  const owners = r.maskedOwners.filter((o) => o.sessions.size >= IMPROVEMENT_MIN_CONVERSATIONS && attributedOwner(o));
  const listedOwners = owners.slice(0, INDEX_MASKED_OWNERS);
  const tail = owners.slice(INDEX_MASKED_OWNERS).filter((o) => o.sessions.size >= OWNER_TAIL_MIN_CONVERSATIONS || o.patterns.some((p) => REFUSAL_REASON_RE.test(p.detail)));
  const mcpAll = r.maskedOwners.filter((o) => o.owner.startsWith("tool:mcp__"));
  const mcpOwners = mcpAll.filter((o) => o.sessions.size >= IMPROVEMENT_MIN_CONVERSATIONS);
  const unlisted = r.maskedOwners.filter((o) => attributedOwner(o) && !listedOwners.includes(o) && !tail.includes(o));
  out.push(`## Masked failures and one-off command failures by owner in ${minConv} (masked = result not marked as an error, but the output shows a failure; one-off = a command failure, MCP or other error whose own pattern is in fewer conversations; confirm in the records)`, "");
  out.push(`Markers ${[...MASKED_MARKERS_NEEDING_RETRY].join(", ")} count only when the same command (same script path, or the same command text) was run again within ${CANDIDATE_RETRY_WINDOW} calls; the others count on their own (printed-status = the command echoed a nonzero status it captured). Echoed statuses of predicates and read-only commands are ignored, and their missing-file or no-match messages are not markers; their own usage, syntax and environment errors are. Each result counts once per entry. Failures whose command could not be told (unattributed chains, unresolved variables) are not owner lines; they are counted under Causes by reason.`, "");
  out.push(...(listedOwners.length ? listedOwners.map(ownerEntry) : ["- none"]));
  if (tail.length) out.push(`- more owners in ${OWNER_TAIL_MIN_CONVERSATIONS}+ conversations, or 2+ with a refusal or precondition message (open from patterns.json maskedOwners by id): ${tail.map((o) => `${o.id} \`${md(o.owner)}\` ${o.sessions.size}c/${o.count}r${tailNote(o.id)}`).join("; ")}`);
  out.push(`- not listed (fewer conversations; in patterns.json maskedOwners): ${unlisted.reduce((n, o) => n + o.count, 0)} results, ${unlisted.length} owners`);
  out.push("");

  out.push(`## MCP and external tool results that report failure inside an ok result (every owner in ${minConv})`, "");
  out.push(...(mcpOwners.length ? mcpOwners.map(ownerEntry) : ["- none"]));
  out.push(`- in fewer conversations (in patterns.json maskedOwners): ${mcpAll.length - mcpOwners.length} owners`, "");

  const slowListed = r.slowCalls.filter((p) => p.sessions.size >= IMPROVEMENT_MIN_CONVERSATIONS);
  out.push(`## Slow or backgrounded shell calls by the slow segment's command in ${minConv} (moved to the background by the timeout, or ${SLOW_CALL_SEC} s or more from call to result; the time includes any auto mode classifier or permission prompt wait; "chain:" lines list every heavy command when the slow one could not be told)`, "");
  out.push(...(slowListed.length ? slowListed.slice(0, INDEX_SLOW).map(slowLine) : ["- none"]));
  out.push(`- wait loops and long sleeps (not listed): ${r.waitCalls.count} calls in ${r.waitCalls.conversations} conversations`);
  const slowTail = slowListed.slice(INDEX_SLOW).filter((p) => p.sessions.size >= SLOW_TAIL_MIN_CONVERSATIONS);
  if (slowTail.length) out.push(`- more slow heads in ${SLOW_TAIL_MIN_CONVERSATIONS}+ conversations (id head calls/conversations): ${slowTail.map((p) => `${p.id} ${md(p.detail)} ${p.count}/${p.sessions.size}${tailNote(p.id)}`).join("; ")}`);
  if (slowListed.length > INDEX_SLOW + slowTail.length) out.push(`- ${slowListed.length - INDEX_SLOW - slowTail.length} more slow command heads in fewer conversations in patterns.json`);
  out.push("");

  const need = {
    H: r.hookGroups.reduce((n, g) => n + g.patterns.length, 0), C: byKind("classifier_denial").length, P: byKind("permission_prompt").length, Y: byKind("safety_check").length, M: byKind("mcp_tool_error").length,
    X: listedCauses.length + causeTail.length, "E/O not covered": [...byKind("nonzero_exit"), ...byKind("other")].filter((p) => !fullyCovered([p])).length,
    U: listedOwners.filter((o) => !fullyCovered(o.patterns)).length, "MCP/external": mcpOwners.filter((o) => !fullyCovered(o.patterns)).length, S: Math.min(slowListed.length, INDEX_SLOW) + slowTail.length,
    B: builtinListed.length,
  };

  const notListed = (k: PatternKind) => r.patterns.filter((p) => p.kind === k);
  const builtinRest = builtin.filter((p) => !builtinListed.includes(p));
  out.push("## Counted but not listed", "");
  out.push(`- Claude Code built-in tool errors not listed above: ${total(builtinRest)} in ${convs(builtinRest)} conversations, ${builtinRest.length} patterns`);
  out.push(`- Auto mode classifier gave no verdict (transient, not a judgement): ${total(notListed("classifier_unavailable"))} in ${convs(notListed("classifier_unavailable"))} conversations`);
  out.push(`- Refused or interrupted by the user: ${total(notListed("user_rejected"))}`);
  out.push(`- Questions the user left unanswered (not refusals; the call succeeded): ${ASK_UNANSWERED_KINDS.map((kind) => `${kind} ${r.unansweredQuestions[kind]}`).join(", ")}`);
  out.push(`- Failure classes (cross-command groupings) are in patterns.json (failureClasses); Causes above replace them in this index.`);
  out.push("");
  out.push("## Hook sources and settings files read", "");
  out.push(`- settings: ${r.settingsFilesRead.map(md).join(", ") || "none"}`);
  out.push(`- hook scripts: ${r.hookSourcesRead.map(md).join(", ") || "none"}`);
  for (let i = 0; i < out.length; i++) {
    const ids = [...new Set([...out[i].matchAll(BOLD_ID_RE)].map((m) => m[1]))];
    ids.forEach((id, k) => {
      listedIds.add(id);
      const text = prevOf(id);
      if (text) out[i] += k === 0 ? ` · prev: ${text}` : ` · prev ${id}: ${text}`;
    });
  }
  const notShown = previousNotShown(prev, listedIds);
  out[previousAt] = previousSection(prev, notShown, prevOf, (id) => locationsOf.has(id)).join("\n");
  const allNeed = { ...need, "previous not shown": notShown.open.length };
  out[accountingAt] = `Accounting: ${Object.values(allNeed).reduce((n, v) => n + v, 0)} entries are needed (${Object.entries(allNeed).map(([k, v]) => `${k} ${v}`).join(", ")}), each backed by at least one opened record; ids in the cause and slow tails may be grouped when they share a checked reason.`;
  return out.join("\n") + "\n";
}

function previousNotShown(prev: PreviousVerdicts, listedIds: ReadonlySet<string>): { open: ImprovementVerdict[]; closed: ImprovementVerdict[] } {
  const missing = [...new Map(prev.entries.filter((e) => !listedIds.has(e.id)).map((e) => [e.id, e])).values()];
  return { open: missing.filter((e) => e.verdict !== "excluded"), closed: missing.filter((e) => e.verdict === "excluded") };
}

function previousSection(prev: PreviousVerdicts, notShown: ReturnType<typeof previousNotShown>, prevOf: (id: string) => string, inScan: (id: string) => boolean): string[] {
  const lines = ["", "## Previous verdicts", ""];
  if (!prev.earlier.length) return [...lines, "- none: no earlier analysis conversation is in the records, so no id carries a previous verdict.", ""];
  const when = (a: EarlierAnalysis): string => `${md(a.conversation)} (${a.at ?? "?"})`;
  for (const a of prev.earlier) {
    if (a.state === "no_block") lines.push(`- ${when(a)}: earlier analysis conversation without a verdicts block; skipped.`);
    else if (a.state === "unreadable") lines.push(`- ${when(a)}: its verdicts block could not be read (${md(a.reason ?? "?")}); skipped.`);
  }
  const used = prev.earlier.find((a) => a.state === "used");
  if (!used) return [...lines, `- no earlier analysis conversation has a readable verdicts block, so no id carries a previous verdict.`, ""];
  const count = (k: ImprovementVerdict["verdict"]): number => prev.entries.filter((e) => e.verdict === k).length;
  lines.push(`- ${when(used)}: verdicts used: ${VERDICT_KINDS.map((k) => `${count(k)} ${k}`).join(", ")}. "prev:" beside an id carries that verdict.${prev.invalid.length ? ` ${prev.invalid.length} entries could not be read: ${prev.invalid.map(md).join(", ")}.` : ""}`, "");
  lines.push(`Previous findings and not-investigated entries whose id is not shown in this index: ${notShown.open.length}`);
  lines.push(...notShown.open.map((e) => `- ${md(e.id)} prev: ${prevOf(e.id)}`));
  if (notShown.closed.length) lines.push(`- previous exclusions whose id is not shown in this index: ${notShown.closed.map((e) => `${md(e.id)}${inScan(e.id) ? "" : " (not in this scan)"}`).join(", ")}`);
  return [...lines, ""];
}

export function patternsJson(r: ScanResult, ctx: IndexContext): string {
  const plain = (p: ScanPattern) => ({
    id: p.id || undefined, kind: p.kind, owner: p.owner, detail: p.detail, sample: sanitizeText(p.sample), uncertain: p.uncertain, site: p.site, siteStrong: p.site ? p.siteStrong === true : undefined, script: p.script,
    variants: p.variants.size ? Object.fromEntries(p.variants) : undefined,
    durationsSec: p.durationsSec.length ? p.durationsSec : undefined, backgrounded: p.backgrounded || undefined, classifierChecked: p.classifierChecked || undefined,
    recovery: p.recovery.length || p.unrecovered ? { calls: p.recovery, explored: p.recoveryExplored, unrecovered: p.unrecovered } : undefined,
    count: p.count, conversations: [...p.sessions], retries: p.retries, first: p.first, last: p.last,
    days: Object.fromEntries([...p.days].sort(([a], [b]) => a.localeCompare(b))), actors: p.actors, tools: Object.fromEntries(p.tools),
    locations: p.locations.map((l) => ({ path: l.path, line: l.line, ref: l.ref, at: l.at, actor: l.actor, tool: l.tool })),
  });
  return JSON.stringify({
    generatedAt: ctx.generatedAt, projectsDir: ctx.projectsDir, stats: r.stats,
    hookGroups: r.hookGroups.map((g) => ({ id: g.id, owner: g.owner, sources: g.sources, gates: g.gates.map((gate) => ({ site: gate.site, patterns: gate.patterns.map((p) => p.id) })) })),
    patterns: r.patterns.map(plain), maskedCandidates: r.candidates.map(plain), slowCalls: r.slowCalls.map(plain), waitCalls: r.waitCalls,
    causes: r.causes.map((c) => ({ id: c.id, family: c.family, count: c.count, conversations: [...c.sessions], days: [...c.days].sort(), patterns: c.patterns.map((p) => p.id || `${p.kind}: ${p.detail}`) })),
    maskedOwners: r.maskedOwners.map((o) => ({ id: o.id, owner: o.owner, conversations: [...o.sessions], count: o.count, patterns: o.patterns.map((p) => p.id) })),
    failureClasses: r.failureClasses.map((c) => ({ id: c.id, tier: c.tier, head: c.head, errorClass: c.errorClass, split: c.split, count: c.count, conversations: [...c.sessions], patterns: c.patterns.map((p) => ({ owner: p.owner, detail: p.detail, locations: p.locations.map((l) => l.ref) })) })),
    settingsFilesRead: r.settingsFilesRead, hookSourcesRead: r.hookSourcesRead,
  }, null, 1) + "\n";
}
