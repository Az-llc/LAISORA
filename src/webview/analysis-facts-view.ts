import type { L3ReportPayload } from "../protocol";

export function renderAnalysisFactsView(container: HTMLElement, payload: L3ReportPayload | undefined): void {
  container.textContent = "";
  if (payload === undefined || payload.facts === undefined) {
    container.dataset.facts = "absent";
    return;
  }
  container.dataset.facts = "present";
  if (payload.facts.coverageNote) {
    const covEl = document.createElement("div");
    covEl.className = "af-coverage-note";
    covEl.textContent = payload.facts.coverageNote;
    container.appendChild(covEl);
  }
}
