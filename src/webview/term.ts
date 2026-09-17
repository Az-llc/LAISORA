import * as l10n from "@vscode/l10n";

// 用語の注記（R-DSP-12）。難しい語は平易語へ言い換えず、破線下線＋マウスオーバーで説明する。
// 注記は語の意味の説明であって別名ではない（R-DSP-13: 言い換え・造語を作らない）
// キーは英語の正準語。呼び出し側は termSpan(キー) と l10n.t(キー) の両方で同じ英語リテラルを使う
export const TERM_NOTES = {
  "Waiting for your answer": {
    label: l10n.t("Waiting for your answer"),
    note: l10n.t("Time the LLM spent waiting for a person to answer a question it asked with AskUserQuestion"),
  },
  "Waiting for reply": {
    label: l10n.t("Waiting for reply"),
    note: l10n.t("Time from the end of the LLM's response until the person's next message"),
  },
  "Subagent": {
    label: l10n.t("Subagent"),
    note: l10n.t("A separate LLM started by the main LLM with the Agent tool. Runs in parallel"),
  },
  "Background": {
    label: l10n.t("Background"),
    note: l10n.t("A run started with Bash run_in_background that keeps working after the tool response returns. Asynchronous Agent tool launches are counted as subagents"),
  },
  "Request block": {
    label: l10n.t("Request block"),
    note: l10n.t("One unit from a person's message to the next person's message"),
  },
  "effort": {
    label: "effort",
    note: l10n.t("Setting for how much computation reasoning uses (low / medium / high, etc.)"),
  },
  "Isolated run": {
    label: l10n.t("Isolated run"),
    note: l10n.t("Whether the subagent ran in a dedicated working tree (worktree)"),
  },
  "LLM generation": {
    label: l10n.t("LLM generation"),
    note: l10n.t("Time the LLM spent generating responses and tool calls (the remainder of a turn after tool execution and waiting for confirmation)"),
  },
  "Tool execution": {
    label: l10n.t("Tool execution"),
    note: l10n.t("Time from calling a tool until its result returns"),
  },
  "Baseline": {
    label: l10n.t("Baseline"),
    note: l10n.t("The set of past sessions used for comparison"),
  },
  "exposure n": {
    label: l10n.t("exposure n"),
    note: l10n.t("Number of baseline sessions in which the metric could be measured"),
  },
  "nonzero n": {
    label: l10n.t("nonzero n"),
    note: l10n.t("Number of baseline sessions in which the metric was not 0"),
  },
} satisfies Record<string, { label: string; note: string }>;

// termSpan へ翻訳済みの語を渡すと注記が消える。キー以外を型で弾く
export type TermKey = keyof typeof TERM_NOTES;

export function termSpan(term: TermKey): Node {
  const entry = TERM_NOTES[term];
  // 説明文の無い語には破線下線を付けない。装飾だけ付けると説明があると誤らせる（R-DSP-12）
  if (entry === undefined) return document.createTextNode(term);
  const el = document.createElement("span");
  el.className = "term-note";
  el.tabIndex = 0;
  el.title = entry.note;
  el.setAttribute("aria-description", entry.note);
  el.textContent = entry.label;
  return el;
}
