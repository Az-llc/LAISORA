import * as l10n from "@vscode/l10n";
import type { LlmFindingDiagnosticsPayload } from "../protocol";

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function headEl(container: HTMLElement, title: string): HTMLElement {
  const head = el("div", "llmdiag-head");
  head.appendChild(el("span", "llmdiag-title", title));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "llmdiag-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", l10n.t("Close diagnostics"));
  close.onclick = () => {
    container.hidden = true;
  };
  head.appendChild(close);
  return head;
}

export function renderLlmDiagnosticsView(
  container: HTMLElement,
  tabId: string,
  payload: LlmFindingDiagnosticsPayload
): void {
  container.textContent = "";
  container.dataset.tabId = tabId;
  container.dataset.llmdiag = payload.state;
  container.hidden = false;

  if (payload.state === "unavailable") {
    delete container.dataset.rejected;
    container.appendChild(headEl(container, l10n.t("Could not run LLM analysis")));
    container.appendChild(el("div", "llmdiag-reason", payload.reason));
    return;
  }

  container.dataset.rejected = String(payload.rejected.length);
  container.appendChild(
    headEl(
      container,
      l10n.t("{0} rejected LLM findings / {1} candidates", payload.counts.rejected, payload.counts.candidate) +
        l10n.t("({0} schema-rejected / {1} verified)", payload.counts.schemaRejected, payload.counts.verified) +
        l10n.t("(cache {0})", payload.cacheState)
    )
  );
  for (const [reason, count] of Object.entries(payload.counts.byReason)) {
    const row = el("div", "llmdiag-reason", `${reason}: ${count}`);
    row.dataset.reason = reason;
    container.appendChild(row);
  }
  for (const item of payload.rejected) {
    const row = el("div", "llmdiag-item");
    const kind = item.finding.action.kind;
    row.dataset.kind = kind;
    row.appendChild(el("span", "llmdiag-kind", `${item.finding.title} (${kind})`));
    for (const rejection of item.rejections) {
      const chip = el("span", "llmdiag-rejection", `${rejection.check}: ${rejection.reason}`);
      chip.dataset.check = rejection.check;
      chip.dataset.reason = rejection.reason;
      if (rejection.subjectIds.length > 0) chip.dataset.subjectIds = rejection.subjectIds.join(",");
      row.appendChild(chip);
    }
    container.appendChild(row);
  }
}
