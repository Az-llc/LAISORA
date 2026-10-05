import * as l10n from "@vscode/l10n";

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
    note: l10n.t("A separate LLM started by the main LLM with the Agent tool, or an external agent started in the background. Runs in parallel"),
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
    note: l10n.t("Time the LLM spent generating responses and tool calls (the remainder of a turn after tool execution, waiting for subagents and waiting for confirmation)"),
  },
  "Tool execution": {
    label: l10n.t("Tool execution"),
    note: l10n.t("Time from calling a tool until its result returns. Waiting for a subagent started with the Agent tool or for an external agent is not included"),
  },
  "Waiting for subagent": {
    label: l10n.t("Waiting for subagent"),
    note: l10n.t("Time the main LLM waited for the result of a subagent it started with the Agent tool or of an external agent, while no other tool was running"),
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

export type TermKey = keyof typeof TERM_NOTES;

export function termSpan(term: TermKey): Node {
  const entry = TERM_NOTES[term];
  if (entry === undefined) return document.createTextNode(term);
  const el = document.createElement("span");
  el.className = "term-note";
  el.tabIndex = 0;
  el.title = entry.note;
  el.setAttribute("aria-description", entry.note);
  el.textContent = entry.label;
  return el;
}
