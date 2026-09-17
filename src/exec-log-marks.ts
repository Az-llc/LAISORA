// 実行ログの行に付ける印（R-TAB-06）の producer。入力は L1.5 の NormalizedEvent 列（history / live 共通）で、
// ツール入力の要約・結果本文・is_error という観測だけから決める（R-OPS-01）。
// evidenceHash / semanticHash の入力には入れない（hash 射影は evidence-index.ts の hashProjection と
// semantic-model.ts の入力列で列挙式）。
import { HUMAN_REJECTED_TOOL_RESULT_RE } from "./guardrail";
import type { NormalizedEvent } from "./protocol";
import * as l10n from "@vscode/l10n";

export type ExecLogMarkFamily = "failure" | "convention";

export interface ExecLogMark {
  toolUseId: string;
  turnId: string;
  family: ExecLogMarkFamily;
  label: string;
  // 分析タブ側の所見の anchor。producer は必ず付ける。無い印は表示側が貼らない
  findingAnchor?: string;
}

// 分析タブに出す所見の見出し（印の飛び先）。count は今回のセッションで印が付いた行数。
// label は観測した事象、fixCandidate は「その事象でよくある直す先」の候補で、断定ではない（R-DSP-01）。
// category は候補の置き場所のタグ（プロジェクト / ルール / 設定 / skill）で、候補の無い分類には付けない
export interface ExecLogFindingView {
  anchor: string;
  family: ExecLogMarkFamily;
  label: string;
  count: number;
  category?: string;
  fixCandidate?: string;
}

export const MAX_EXEC_LOG_MARKS = 4096;

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

// 失敗の分類。label は結果本文から観測できる事象だけを言い、原因は fixCandidate へ落とす（R-DSP-01。R-53 D-4 / D-6 / D-11）。
// **並び順が判定の一部**: 複数の規則に当たる行には先頭の 1 つだけが付く。特異な規則が先。
// 特に fail:script は fail:syntax より前に置く。Python の Traceback は末尾が SyntaxError のことがあり、
// 後ろに置くと実行時エラー 18 件（実測）に「シェル引数の書き方」が候補として付く（R-53 D-4 の欠陥そのもの）。
// パターンはハーネス／ツールが出す定型文に固定する。一般英単語（permission・not allowed 等）へ広げると
// diff 出力中のソース識別子にまで当たる（R-53 D-6 実測 5/13 が偽）
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

// 規約違反。label は観測した操作、fixCandidate が規約の文。規則表は手で選んだ 3 件で固定されており、
// CLAUDE.md / rule の本文は読まない（読む機構が無い）。見出しと注記でその範囲を超えた主張をしない
const CONVENTION_RULES: readonly ConventionRule[] = [
  { anchor: "rule:git-add-all", get label() { return l10n.t("git add -A without a pathspec"); }, get category() { return l10n.t("Project"); }, get fixCandidate() { return l10n.t("Do not use git add -A"); }, toolName: "Bash", matches: stagesWholeTree },
  { anchor: "rule:blocking-task-output", get label() { return l10n.t("Waited with TaskOutput block=true"); }, category: "skill", get fixCandidate() { return l10n.t("Do not wait for background subagents with a blocking TaskOutput"); }, toolName: "TaskOutput", matches: (input) => /"?block"?\s*:\s*true\b/.test(input) },
  { anchor: "rule:ps-prompt", get label() { return l10n.t("Called an interactive PowerShell prompt"); }, category: "skill", get fixCandidate() { return l10n.t("Do not pass prompts to a headless CLI through PowerShell text input"); }, toolName: "PowerShell", matches: (input) => /Read-Host|Get-Credential/.test(input) },
];

// 規約の趣旨は「別セッションが同一ワークツリーで作業しうるので、commit へ全ツリーを巻き込まない」。
// `-A` の字面ではなく pathspec の有無で判定する（実測 40 件中 38 件は範囲限定・1 件は --dry-run。R-53 D-8）。
// inputPreview は input の JSON なので、コマンド中の改行は `\n` の 2 文字で入る。区切りに直さないと
// 次のコマンド名が pathspec に見えて、唯一の真の違反（`git add -A\ngit status`）が落ちる
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

function push(state: ExecLogMarkState, mark: ExecLogMark): ExecLogMarkState {
  if (state.marks.length >= MAX_EXEC_LOG_MARKS) return { ...state, droppedCount: state.droppedCount + 1 };
  return { ...state, marks: [...state.marks, mark] };
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
    // 失敗の分類は is_error を前提にする。結果本文の文字列一致だけだと成功した行に印が付き、
    // 印の率が情報量を失う（R-TAB-06）
    if (event.isError !== true) return state;
    // 1 行に複数の失敗分類を付けない（プローブのソースに検出語が含まれるだけで、パス / シェル / Edit / 環境 が同時に付く。R-TAB-06）。
    // 複数に当たったときは FAILURE_RULES の並び（特異な順）の先頭が勝つ
    const rule = FAILURE_RULES.find((r) => r.pattern.test(event.resultPreview));
    // 「失敗（分類なし）」には印を付けない。押しても分析タブに飛び先が無い（R-TAB-06）
    if (rule === undefined) return state;
    return push(state, { toolUseId: event.toolUseId, turnId: event.turnId, family: "failure", label: rule.label, findingAnchor: rule.anchor });
  }
  return state;
}

// 所見の見出し。順序は規則表の順（失敗の分類 → 規約違反）で、印が 0 件の規則は出さない
export function deriveExecLogFindings(marks: readonly ExecLogMark[]): ExecLogFindingView[] {
  const counts = new Map<string, number>();
  for (const m of marks) {
    if (m.findingAnchor === undefined) continue;
    counts.set(m.findingAnchor, (counts.get(m.findingAnchor) ?? 0) + 1);
  }
  const out: ExecLogFindingView[] = [];
  const view = (rule: FailureRule | ConventionRule, family: ExecLogMarkFamily, count: number): ExecLogFindingView => ({
    anchor: rule.anchor,
    family,
    label: rule.label,
    count,
    ...(rule.category !== undefined ? { category: rule.category } : {}),
    ...(rule.fixCandidate !== undefined ? { fixCandidate: rule.fixCandidate } : {}),
  });
  for (const rule of FAILURE_RULES) {
    const count = counts.get(rule.anchor);
    if (count !== undefined) out.push(view(rule, "failure", count));
  }
  for (const rule of CONVENTION_RULES) {
    const count = counts.get(rule.anchor);
    if (count !== undefined) out.push(view(rule, "convention", count));
  }
  return out;
}
