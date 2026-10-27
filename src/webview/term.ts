import * as l10n from "@vscode/l10n";

export const TERM_NOTES = {
  "Subagent only": {
    label: l10n.t("Subagent only"),
    note: l10n.t("Time a subagent was running while the main LLM was not generating, running a tool or waiting for a subagent"),
  },
  "Background only": {
    label: l10n.t("Background only"),
    note: l10n.t("Time a background task was running while neither the main LLM nor a subagent was working"),
  },
  "Subagent": {
    label: l10n.t("Subagent"),
    note: l10n.t("A separate LLM started by the main LLM with the Agent tool, or an external run"),
  },
  "Background": {
    label: l10n.t("Background"),
    note: l10n.t("A run started with Bash run_in_background that keeps working after the tool response returns. Asynchronous Agent tool launches are counted as subagents"),
  },
  "Processing": {
    label: l10n.t("Processing"),
    note: l10n.t("Time anything was running (LLM generation, tool execution, waiting for a subagent, subagents and background tasks), with overlapping work counted once"),
  },
  "Total work": {
    label: l10n.t("Total work"),
    note: l10n.t("LLM generation plus every tool call, subagent, background task and external run added up one by one, so work that ran in parallel is counted once for each item. Live time not observed yet is not included"),
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
    note: l10n.t("Time the LLM spent generating responses and tool calls"),
  },
  "Tool execution": {
    label: l10n.t("Tool execution"),
    note: l10n.t("Time from calling a tool until its result returns. Waiting for a subagent started with the Agent tool or for an external agent is not included"),
  },
  "Waiting for subagent": {
    label: l10n.t("Waiting for subagent"),
    note: l10n.t("Time the main LLM waited for the result of a subagent it started with the Agent tool or of an external agent, while no other tool was running"),
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

export function measuredSumNote(content: string | readonly (Node | string)[], partial: boolean | undefined): Node {
  if (!partial && typeof content === "string") return document.createTextNode(content);
  const el = document.createElement("span");
  if (typeof content === "string") el.textContent = content;
  else el.append(...content);
  if (!partial) return el;
  el.className = "term-note";
  el.title = l10n.t("Includes runs that were not measured; the value is the total of the measured runs");
  return el;
}
