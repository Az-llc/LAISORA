import type { AnalysisFactsView } from "../analysis-facts-view";
import type { L3ReportPayload, LlmFindingReportView } from "../protocol";
import { renderLlmActionView } from "./llm-action-view";
import { vscode } from "./dom";
import * as l10n from "@vscode/l10n";

function makeEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function llmRunControl(
  tabId: string,
  view: LlmFindingReportView | undefined,
  llmAnalysisEnabled: boolean | undefined,
  turnRunning: boolean,
  llmRunning: boolean,
  llmTargets: AnalysisFactsView["llmTargets"] | undefined
): HTMLElement {
  const box = makeEl("div", "llm-run");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "llm-run-btn";
  btn.textContent = l10n.t("Run LLM Analysis");
  let note = l10n.t("Running consumes tokens");
  if (llmRunning) {
    box.dataset.runState = "in-flight";
    btn.disabled = true;
    btn.textContent = l10n.t("Analyzing…");
    btn.title = l10n.t("Running LLM analysis");
  } else if (llmAnalysisEnabled === false || view?.state === "disabled") {
    box.dataset.runState = "disabled";
    btn.disabled = true;
    btn.title = l10n.t("The setting laisora.workLog.llmAnalysis is disabled");
  } else if (llmTargets === undefined) {
    box.dataset.runState = "no-facts";
    btn.disabled = true;
    btn.title = l10n.t("Cannot run yet because facts have not been generated");
    note = l10n.t("Cannot run yet because facts have not been generated (available once the record is derived)");
  } else if (view?.state === "attached" && view.attached.freshness === "current") {
    box.dataset.runState = "completed";
    btn.disabled = true;
    btn.title = l10n.t("Already run for this record (can run again as work progresses)");
    note = l10n.t("Already run for this record (can run again as work progresses)");
  } else if (turnRunning) {
    box.dataset.runState = "running";
    btn.disabled = true;
    btn.title = l10n.t("Cannot start while a turn is running (available after the turn completes)");
  } else {
    box.dataset.runState = "ready";
  }
  btn.onclick = () => {
    vscode.postMessage({ type: "llmAnalysisRequest", tabId });
    box.dataset.runState = "in-flight";
    btn.disabled = true;
    btn.textContent = l10n.t("Analyzing…");
    btn.title = l10n.t("Running LLM analysis");
  };
  box.appendChild(btn);
  box.appendChild(makeEl("span", "llm-run-note", note));
  return box;
}

export function renderAnalysisFactsView(
  container: HTMLElement,
  payload: L3ReportPayload | undefined,
  tabId: string,
  llmAnalysisEnabled?: boolean,
  turnRunning = false,
  llmRunning = false,
  evidenceNavigation?: { has(toolUseId: string): boolean; navigate(toolUseId: string): void },
  llmContainer: HTMLElement = container
): void {
  container.textContent = "";
  if (llmContainer !== container) llmContainer.textContent = "";
  if (payload === undefined || payload.facts === undefined) {
    container.dataset.facts = "absent";
    const llmSection = makeEl("div", "af-llm-section");
    const entry = makeEl("div", "llm-entry");
    entry.appendChild(
      llmRunControl(tabId, undefined, llmAnalysisEnabled, turnRunning, llmRunning, undefined)
    );
    llmSection.appendChild(entry);
    llmContainer.appendChild(llmSection);
    return;
  }

  container.dataset.facts = "present";
  const facts = payload.facts;
  const llm = payload.llm;

  if (facts.coverageNote) {
    const covEl = makeEl("div", "af-coverage-note", facts.coverageNote);
    container.appendChild(covEl);
  }

  if (facts.learning) {
    const learning = makeEl("section", "af-learning wa-fsec");
    learning.dataset.state = facts.learning.state;
    if (facts.learning.empty === true) learning.dataset.empty = "true";
    const head = makeEl("div", "wa-code");
    head.id = `af-learning-h-${tabId}`;
    head.append(makeEl("b", undefined, "LEARN"), makeEl("span", "wa-code-s", l10n.t("Learning record")));
    learning.setAttribute("aria-labelledby", head.id);
    learning.appendChild(head);
    if (facts.learning.note) learning.appendChild(makeEl("div", "af-learning-note", facts.learning.note));
    for (const line of facts.learning.lines) learning.appendChild(makeEl("div", "af-learning-line", line));
    container.appendChild(learning);
  }

  const llmSection = makeEl("div", "af-llm-section");
  const entry = makeEl("div", "llm-entry");
  entry.appendChild(
    llmRunControl(
      tabId,
      llm,
      llmAnalysisEnabled,
      turnRunning,
      llmRunning,
      facts.llmTargets
    )
  );
  llmSection.appendChild(entry);
  const llmBox = makeEl("div", "llm-findings");
  llmSection.appendChild(llmBox);
  llmContainer.appendChild(llmSection);
  renderLlmActionView(llmBox, llm, llmAnalysisEnabled, tabId, payload.analysis.semanticHash, evidenceNavigation, {
    row: entry,
    targets: facts.llmTargets,
  });
}
