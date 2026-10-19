import { isComposingKey } from "./composing";
import * as l10n from "@vscode/l10n";
import type { TodoDetailMessage, WebviewToHost } from "../protocol";
import { TODO_BRIEF_MAX } from "../todo-model";
import { todoButton, todoCloseButton, todoEl as el } from "./todo-edit";

export class TodoBriefSheet {
  readonly root: HTMLElement;
  private itemId: string | null = null;
  private title = "";
  private text: string | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly post: (message: WebviewToHost) => void) {
    this.root = el("aside", "todo-sheet todo-brief");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", l10n.t("Brief for the child conversation"));
    this.root.hidden = true;
    this.root.addEventListener("keydown", (e) => {
      if (isComposingKey(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.send();
      }
    });
  }

  get waitingFor(): string | null {
    return this.itemId !== null && this.text === null ? this.itemId : null;
  }

  open(itemId: string): void {
    if (this.itemId === null) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.itemId = itemId;
    this.text = null;
    this.title = "";
    this.root.hidden = false;
    this.render();
    this.post({ type: "todoDetailRequest", id: itemId });
  }

  apply(message: TodoDetailMessage): void {
    if (message.id !== this.itemId || this.text !== null) return;
    if (!message.item?.splitBrief) {
      this.close();
      return;
    }
    this.title = message.item.title;
    this.text = message.item.splitBrief;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLTextAreaElement>(".todo-brief-text")?.focus());
  }

  close(): void {
    if (this.itemId === null) return;
    this.itemId = null;
    this.text = null;
    this.root.hidden = true;
    this.root.replaceChildren();
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    this.returnFocus = null;
  }

  private send(): void {
    const id = this.itemId;
    const brief = this.text?.trim();
    if (id === null || !brief) return;
    this.post({ type: "todoOpenConversation", itemId: id, fresh: true, brief: brief.slice(0, TODO_BRIEF_MAX) });
    this.close();
  }

  private render(): void {
    const scroll = el("div", "todo-sheet-scroll");
    const head = el("header", "todo-sheet-head");
    head.append(el("h2", "todo-where todo-sheet-heading", l10n.t("Split into a child conversation")), todoCloseButton(() => this.close()));
    if (this.text === null) {
      scroll.append(el("p", "todo-note", l10n.t("Loading…")));
      this.root.replaceChildren(head, scroll);
      return;
    }
    scroll.append(el("p", "todo-sheet-hint", l10n.t("“{0}” starts in a new child conversation with this brief. Edit it before opening; the sent brief stays in the item's history.", this.title)));
    const area = el("textarea", "todo-sheet-memo todo-brief-text");
    area.value = this.text;
    area.rows = 18;
    area.maxLength = TODO_BRIEF_MAX;
    area.spellcheck = false;
    area.setAttribute("aria-label", l10n.t("Brief"));
    area.addEventListener("input", () => { this.text = area.value; });
    scroll.append(area);
    const foot = el("div", "todo-sheet-foot");
    foot.append(todoButton("todo-sheet-btn primary", l10n.t("Open the child conversation"), () => this.send(), l10n.t("Open (Ctrl+Enter)")));
    this.root.replaceChildren(head, scroll, foot);
  }
}
