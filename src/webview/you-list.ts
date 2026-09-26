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
    dismiss?: (item: YouItem) => void) {
    this.element.lang = document.documentElement.lang;
    this.element.setAttribute("aria-label", "YOU");
    let signature = "";
    const render = (force = false): void => {
      const items = reader.get();
      const next = JSON.stringify(items);
      if (!force && signature === next) return;
      signature = next;
      const open = items.filter(item => item.resolvedAt === undefined);
      // R-DSP-33: a dismissed ask leaves the list; it is not a resolved item.
      const resolved = items.filter(item => item.resolvedAt !== undefined && item.resolution !== "dismissed");
      const folded = this.element.dataset.resolvedOpen !== "true";
      onCount?.(open.length, items.length);
      const head = node("header", "plan-section-head");
      const label = node("div", "plan-top");
      label.append(node("span", "you-label", "YOU"));
      head.append(label, node("h3", "you-heading", l10n.t("Your decisions, approvals and checks")),
        node("p", "you-lede", open.length ? l10n.t("{0} waiting", open.length) : ""));
      const list = node("div", "you-section-body");
      this.element.replaceChildren(head, list);
      const appendRows = (entries: readonly YouItem[]): void => { for (const item of entries) {
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
        // R-CNV-39: only rendered asks can be dismissed; approvals are resolved by the Host.
        if (dismiss && !item.anchor.approvalRef && item.resolvedAt === undefined) {
          const remove = node("button", "you-dismiss", "×");
          remove.type = "button";
          remove.title = l10n.t("Remove from the list");
          remove.setAttribute("aria-label", l10n.t("Remove from the list: {0}", item.title));
          remove.onclick = () => {
            const index = open.indexOf(item);
            dismiss(item);
            const rows = this.element.querySelectorAll<HTMLElement>(".you-item:not(.you-resolved)");
            const next = rows[Math.min(index, rows.length - 1)];
            (next?.querySelector<HTMLElement>(".you-dismiss") ?? next?.querySelector<HTMLElement>(".you-link"))?.focus();
          };
          title.append(remove);
        }
        body.append(title);
        const summary = item.options?.map(option => option.label).join(" / ")
          ?? item.steps?.map(step => `${step.do} — ${step.look}`).join(" / ");
        if (summary) body.append(node("p", "you-summary", summary));
        row.append(square, body);
        list.append(row);
      } };
      if (resolved.length) {
        // R-DSP-33: resolved items fold into one counted line heading the list, like PLAN's completed steps.
        const toggle = node("button", "plan-done-toggle you-resolved-toggle", `✓ ${l10n.t("{0} resolved", String(resolved.length))} ${folded ? "▸" : "▾"}`);
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(!folded));
        toggle.onclick = () => {
          this.element.dataset.resolvedOpen = String(folded);
          render(true);
          this.element.querySelector<HTMLElement>(".you-resolved-toggle")?.focus();
        };
        list.append(toggle);
        if (!folded) appendRows(resolved);
      }
      if (open.length) appendRows(open);
      else list.append(node("p", "you-empty", l10n.t("Nothing is waiting on you")));
    };
    this.unsubscribe = reader.subscribe(() => render());
    render();
  }

  destroy(): void { this.unsubscribe(); }
}
