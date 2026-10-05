import { HUMAN_REJECTED_TOOL_RESULT_RE } from "./guardrail";
import type { NormalizedEvent } from "./protocol";
import * as l10n from "@vscode/l10n";

export type ExecLogMarkFamily = "failure" | "convention";

export interface ExecLogMark {
  toolUseId: string;
  turnId: string;
  family: ExecLogMarkFamily;
  label: string;
  findingAnchor?: string;
  ordinalLabel: string;
}

export interface ExecLogFindingView {
  anchor: string;
  family: ExecLogMarkFamily;
  label: string;
  count: number;
  numberDigits: string;
  countUnit: string;
  evidenceLabel: string;
  category?: string;
  fixCandidate?: string;
}

export const MAX_EXEC_LOG_MARKS = 4096;

export function execLogFindingsEmptyLabel(): string {
  return l10n.t("No matching records");
}

interface FailureRule {
  anchor: string;
  label: string;
  category?: string;
  fixCandidate?: string;
  pattern: RegExp;
}

interface ConventionRule {
  anchor: string;
  label: string;
  category?: string;
  fixCandidate?: string;
  toolName: string;
  matches(input: string): boolean;
}

const FAILURE_RULES: readonly FailureRule[] = [
  { anchor: "fail:rejected", get label() { return l10n.t("A human stopped the execution"); }, pattern: HUMAN_REJECTED_TOOL_RESULT_RE },
  { anchor: "fail:guard", get label() { return l10n.t("A guard stopped the execution"); }, pattern: /This agent is isolated in the worktree|Refusing to use|Blocked: / },
  { anchor: "fail:read-first", get label() { return l10n.t("Tried to modify a file that had not been read"); }, get category() { return l10n.t("Rule"); }, get fixCandidate() { return l10n.t("Read before Edit or Write"); }, pattern: /File has not been read yet/ },
  { anchor: "fail:edit", get label() { return l10n.t("The Edit target did not match the actual file"); }, pattern: /String to replace not found|old_string and new_string are exactly the same/ },
  { anchor: "fail:script", get label() { return l10n.t("A script failed with a runtime error"); }, pattern: /Traceback \(most recent call last\)/ },
  { anchor: "fail:syntax", get label() { return l10n.t("The executed code had a syntax error"); }, get category() { return l10n.t("Rule"); }, get fixCandidate() { return l10n.t("How shell arguments are written (quoting, heredocs)"); }, pattern: /unexpected EOF while looking for matching|unterminated|SyntaxError/ },
  { anchor: "fail:permission", get label() { return l10n.t("The harness denied the execution"); }, get category() { return l10n.t("Settings"); }, get fixCandidate() { return l10n.t("permissions.allow in settings.json"); }, pattern: /Permission for this action was denied by/ },
  { anchor: "fail:limit", get label() { return l10n.t("Could not read because the tool limit was exceeded"); }, pattern: /File content \([^)]*\) exceeds maximum/ },
  { anchor: "fail:input", get label() { return l10n.t("The tool input did not match the expected format"); }, pattern: /InputValidationError/ },
  { anchor: "fail:path", get label() { return l10n.t("The specified path was not found"); }, get category() { return l10n.t("Project"); }, get fixCandidate() { return l10n.t("The working directory description in CLAUDE.md"); }, pattern: /File does not exist|current working directory is/ },
  { anchor: "fail:env", get label() { return l10n.t("Unrecoverable (environment)"); }, pattern: /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|socket hang up|certificate has expired|curl: \(\d+\)|is not installed\.|Command timed out after|search timed out after|auto mode cannot determine|EPERM|Permission denied/ },
];

const CONVENTION_RULES: readonly ConventionRule[] = [
  { anchor: "rule:git-add-all", get label() { return l10n.t("git add -A without a pathspec"); }, get category() { return l10n.t("Project"); }, get fixCandidate() { return l10n.t("Do not use git add -A"); }, toolName: "Bash", matches: stagesWholeTree },
  { anchor: "rule:blocking-task-output", get label() { return l10n.t("Waited with TaskOutput block=true"); }, category: "skill", get fixCandidate() { return l10n.t("Do not wait for background subagents with a blocking TaskOutput"); }, toolName: "TaskOutput", matches: (input) => /"?block"?\s*:\s*true\b/.test(input) },
  { anchor: "rule:ps-prompt", get label() { return l10n.t("Called an interactive PowerShell prompt"); }, category: "skill", get fixCandidate() { return l10n.t("Do not pass prompts to a headless CLI through PowerShell text input"); }, toolName: "PowerShell", matches: (input) => /Read-Host|Get-Credential/.test(input) },
];

function stagesWholeTree(input: string): boolean {
  for (const m of input.replace(/\\[nrt]/g, "\n").matchAll(/git\s+add\b([^\n;|&"']*)/g)) {
    const args = m[1].split(/\s+/).filter((t) => t.length > 0 && t !== "--");
    if (!args.includes("-A") && !args.includes("--all")) continue;
    if (args.includes("-n") || args.includes("--dry-run")) continue;
    if (args.some((t) => !t.startsWith("-"))) continue;
    return true;
  }
  return false;
}

export interface ExecLogMarkState {
  marks: ExecLogMark[];
  droppedCount: number;
}

export function createExecLogMarkState(): ExecLogMarkState {
  return { marks: [], droppedCount: 0 };
}

function push(state: ExecLogMarkState, mark: Omit<ExecLogMark, "ordinalLabel">): ExecLogMarkState {
  if (state.marks.length >= MAX_EXEC_LOG_MARKS) return { ...state, droppedCount: state.droppedCount + 1 };
  let ordinal = 1;
  for (const m of state.marks) if (m.findingAnchor === mark.findingAnchor) ordinal += 1;
  return { ...state, marks: [...state.marks, { ...mark, ordinalLabel: `#${ordinal}` }] };
}

export function foldExecLogMarks(state: ExecLogMarkState, event: NormalizedEvent): ExecLogMarkState {
  if (event.kind === "tool_call_started") {
    const input = `${event.inputSummary ?? ""}\n${event.inputPreview}`;
    let next = state;
    for (const rule of CONVENTION_RULES) {
      if (rule.toolName !== event.toolName || !rule.matches(input)) continue;
      next = push(next, { toolUseId: event.toolUseId, turnId: event.turnId, family: "convention", label: rule.label, findingAnchor: rule.anchor });
    }
    return next;
  }
  if (event.kind === "tool_call_finished") {
    if (event.isError !== true) return state;
    const rule = FAILURE_RULES.find((r) => r.pattern.test(event.resultPreview));
    if (rule === undefined) return state;
    return push(state, { toolUseId: event.toolUseId, turnId: event.turnId, family: "failure", label: rule.label, findingAnchor: rule.anchor });
  }
  return state;
}

export function deriveExecLogFindings(marks: readonly ExecLogMark[]): ExecLogFindingView[] {
  const counts = new Map<string, number>();
  for (const m of marks) {
    if (m.findingAnchor === undefined) continue;
    counts.set(m.findingAnchor, (counts.get(m.findingAnchor) ?? 0) + 1);
  }
  const out: ExecLogFindingView[] = [];
  const view = (rule: FailureRule | ConventionRule, family: ExecLogMarkFamily, count: number, index: number): ExecLogFindingView => ({
    anchor: rule.anchor,
    family,
    label: rule.label,
    count,
    numberDigits: String(index).padStart(2, "0"),
    countUnit: count === 1 ? l10n.t("time") : l10n.t("times"),
    evidenceLabel: count === 1 ? l10n.t("1 execution log line") : l10n.t("{0} execution log lines", count),
    ...(rule.category !== undefined ? { category: rule.category } : {}),
    ...(rule.fixCandidate !== undefined ? { fixCandidate: rule.fixCandidate } : {}),
  });
  let failureIndex = 0;
  for (const rule of FAILURE_RULES) {
    const count = counts.get(rule.anchor);
    if (count !== undefined) out.push(view(rule, "failure", count, ++failureIndex));
  }
  let conventionIndex = 0;
  for (const rule of CONVENTION_RULES) {
    const count = counts.get(rule.anchor);
    if (count !== undefined) out.push(view(rule, "convention", count, ++conventionIndex));
  }
  return out;
}

export const FAILURE_SUMMARY_TOP_COUNT = 3;

export interface FailureKindView {
  anchor: string;
  label: string;
  count: number;
}

export interface FailureSummaryView {
  failCount: number;
  toolCount: number;
  failPercent: number | null;
  top: FailureKindView[];
  rest: FailureKindView[];
  restCount: number;
}

export function deriveFailureSummary(
  findings: readonly ExecLogFindingView[],
  phases: ReadonlyArray<{ toolCount: number; childToolCount: number; failCount: number; childFailCount: number }>
): FailureSummaryView {
  let toolCount = 0;
  let failCount = 0;
  for (const p of phases) {
    toolCount += p.toolCount + p.childToolCount;
    failCount += p.failCount + p.childFailCount;
  }
  const kinds = findings
    .filter((f) => f.family === "failure")
    .map((f): FailureKindView => ({ anchor: f.anchor, label: f.label, count: f.count }))
    .sort((a, b) => b.count - a.count);
  const rest = kinds.slice(FAILURE_SUMMARY_TOP_COUNT);
  return {
    failCount,
    toolCount,
    failPercent: toolCount > 0 ? (failCount / toolCount) * 100 : null,
    top: kinds.slice(0, FAILURE_SUMMARY_TOP_COUNT),
    rest,
    restCount: rest.length,
  };
}
