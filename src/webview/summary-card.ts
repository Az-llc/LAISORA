import * as l10n from "@vscode/l10n";

export type SummaryTone = "added" | "removed" | "muted";

export function summaryStat(parts: readonly { readonly text: string; readonly tone: SummaryTone }[]): HTMLElement {
  const stat = document.createElement("span");
  stat.className = "edit-summary-stat";
  for (const part of parts) {
    const node = document.createElement("span");
    node.className = `edit-summary-${part.tone}`;
    node.textContent = part.text;
    stat.append(node);
  }
  return stat;
}

export function summaryCardShell(card: HTMLElement, title: string, ...headExtras: HTMLElement[]): { head: HTMLElement; list: HTMLUListElement } {
  card.classList.add("edit-summary");
  card.setAttribute("aria-label", title);
  const head = document.createElement("div");
  head.className = "edit-summary-head";
  const titleEl = document.createElement("span");
  titleEl.className = "edit-summary-title";
  titleEl.textContent = title;
  head.append(titleEl, ...headExtras);
  const list = document.createElement("ul");
  list.className = "edit-summary-list";
  card.append(head, list);
  return { head, list };
}

export function summaryFold(card: HTMLElement, overflow: readonly HTMLElement[], total: number, expanded: boolean, changed?: (expanded: boolean) => void,
  foldedLabel: (hidden: number, total: number) => string = (_hidden, all) => l10n.t("Show all ({0})", all)): void {
  if (overflow.length === 0) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "edit-summary-toggle";
  const apply = (expand: boolean) => {
    for (const item of overflow) item.hidden = !expand;
    toggle.setAttribute("aria-expanded", expand ? "true" : "false");
    toggle.textContent = expand ? l10n.t("Show fewer") : foldedLabel(overflow.length, total);
  };
  apply(expanded);
  toggle.addEventListener("click", () => {
    const expand = toggle.getAttribute("aria-expanded") !== "true";
    apply(expand);
    changed?.(expand);
  });
  card.appendChild(toggle);
}
