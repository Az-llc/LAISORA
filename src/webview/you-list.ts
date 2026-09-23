import * as l10n from "@vscode/l10n";
import type { YouItem, YouItemsReader } from "./you-items";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) {
    element.textContent = text;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) element.lang = "ja";
  }
  return element;
}

export class YouList {
  readonly element = node("section", "you-section");
  private readonly unsubscribe: () => void;

  constructor(reader: YouItemsReader, navigate: (item: YouItem) => void, onCount?: (count: number, total: number) => void,
    listResolved = true) {
    this.element.lang = document.documentElement.lang;
    this.element.setAttribute("aria-label", "YOU");
    let signature = "";
    const render = (): void => {
      const items = reader.get();
      const next = JSON.stringify(items);
      if (signature === next) return;
      signature = next;
      const open = items.filter(item => item.resolvedAt === undefined);
      const resolved = items.filter(item => item.resolvedAt !== undefined);
      onCount?.(open.length, items.length);
      const head = node("header", "plan-section-head");
      const label = node("div", "plan-top");
      label.append(node("span", "you-label", "YOU"));
      head.append(label, node("h3", "you-heading", l10n.t("Your decisions, approvals and checks")),
        node("p", "you-lede", open.length ? l10n.t("{0} waiting", open.length) : ""));
      const list = node("div", "you-section-body");
      this.element.replaceChildren(head, list);
      if (!open.length) list.append(node("p", "you-empty", l10n.t("Nothing is waiting on you")));
      for (const item of open.length ? [...open, ...(listResolved ? resolved : [])] : []) {
        const row = node("div", `you-item${item.resolvedAt === undefined ? "" : " you-resolved"}`);
        row.dataset.youId = item.id;
        const square = node("span", "you-square");
        square.setAttribute("aria-hidden", "true");
        const body = node("div", "you-body");
        const kind = item.kind === "approve" ? l10n.t("Approval") : item.kind === "decide" ? l10n.t("Decision") : l10n.t("Machine check");
        body.append(node("div", "you-kind", item.resolvedAt === undefined ? kind : l10n.t("{0} · Resolved", kind)));
        const title = node("div", "you-title");
        const link = node("button", "you-link", item.anchor.approvalRef ? l10n.t("↗ Card") : l10n.t("↗ Message"));
        link.type = "button";
        link.setAttribute("aria-label", l10n.t("Go to: {0}", item.title));
        link.onclick = () => navigate(item);
        title.append(node("strong", "you-title-text", item.title), link);
        body.append(title);
        const summary = item.options?.map(option => option.label).join(" / ")
          ?? item.steps?.map(step => `${step.do} — ${step.look}`).join(" / ");
        if (summary) body.append(node("p", "you-summary", summary));
        row.append(square, body);
        list.append(row);
      }
    };
    this.unsubscribe = reader.subscribe(render);
    render();
  }

  destroy(): void { this.unsubscribe(); }
}
