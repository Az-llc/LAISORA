import * as l10n from "@vscode/l10n";
import { contributes } from "../../package.json";
import type { TodoEdit, TodoListItem } from "../protocol";
import { todoScopeIds } from "../todo-model";
import { openTodoDetail } from "./todo-app";
import { todoButton, todoCloseButton, todoEl as el, todoOverlayTop, todoStateIcon } from "./todo-edit";
import type { TodoAskActions, TodoAskRow } from "./todo-asks";
import { TodoRowRenderer } from "./todo-row-view";
import type { TodoAttention } from "./todo-view";
import { deriveTodoList, localDateKey, todoDrawerScope, type TodoDrawerScope } from "./todo-rows";

export interface TodoDrawerSource {
  readonly enabled: boolean;
  readonly items: readonly TodoListItem[];
  readonly groupColors: ReadonlyMap<string, number>;
  itemOfTab(tabId: string | null): string | undefined;
  numberOf(id: string): string;
  colorOf(id: string): string;
  edit(edit: TodoEdit): void;
  openConversation(id: string, fresh: boolean): void;
  onChange(listener: () => void): void;
  asks(id: string): readonly TodoAskRow[];
  askNote(id: string): string | undefined;
  readonly askActions: TodoAskActions;
  attention(scope: ReadonlySet<string> | null): TodoAttention;
}

export interface TodoDrawerPlace {
  rail(tabId: string): HTMLElement | null;
  readonly composer: HTMLElement;
  showInTodoTab(itemId: string | undefined): void;
}

const TODO_DRAWER_FLASH_MS = 2400;

const DRAWER_BINDING: { readonly key: string; readonly mac?: string } | undefined = contributes.keybindings.find(binding => binding.command === "laisora.todoToggleDrawer");
const onMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

const KEY_WORDS: Readonly<Record<string, { label: string; mac?: string; aria: string }>> = {
  ctrl: { label: "Ctrl", aria: "Control" },
  alt: { label: "Alt", mac: "Option", aria: "Alt" },
  shift: { label: "Shift", aria: "Shift" },
};

function todoDrawerKeyParts(): Array<{ label: string; mac?: string; aria: string }> {
  const binding = (onMac() ? DRAWER_BINDING?.mac : undefined) ?? DRAWER_BINDING?.key ?? "";
  return binding.split("+").map(part => KEY_WORDS[part] ?? { label: part.toUpperCase(), aria: part.toUpperCase() });
}

export function todoDrawerKeyLabel(): string {
  const mac = onMac();
  return todoDrawerKeyParts().map(part => mac ? part.mac ?? part.label : part.label).join("+");
}

export class TodoDrawer {
  readonly button: HTMLButtonElement;
  readonly linkButton: HTMLButtonElement;
  readonly root: HTMLElement;
  private readonly scopeEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly runningBtn: HTMLButtonElement;
  private readonly waitingBtn: HTMLButtonElement;
  private readonly cycle = { running: -1, waiting: -1 };
  private hiddenRail: HTMLElement | null = null;
  private readonly onResize = () => this.place();
  private readonly composerResize = new ResizeObserver(this.onResize);
  private readonly headEl: HTMLElement;
  private readonly marksEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly rows: TodoRowRenderer;
  private readonly scopes = new Map<string, TodoDrawerScope>();
  private readonly collapsed = new Set<string>();
  private tabId: string | null = null;
  private openNow = false;

  constructor(private readonly source: TodoDrawerSource, private readonly where: TodoDrawerPlace) {
    this.button = todoButton("todo-drawer-btn", "", () => this.toggle());
    this.button.setAttribute("aria-keyshortcuts", todoDrawerKeyParts().map(part => part.aria).join("+"));
    this.button.id = "tododrawerbtn";
    this.button.setAttribute("aria-label", l10n.t("ToDo items for this conversation"));
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-expanded", "false");
    this.button.setAttribute("aria-controls", "tododrawer");
    const icon = el("span", "l-icon l-icon-checklist");
    icon.setAttribute("aria-hidden", "true");
    this.button.append(icon);

    this.linkButton = todoButton("todo-link-chip", "", () => {
      const id = this.linkedItemId();
      if (id !== undefined) openTodoDetail(id);
    });
    this.linkButton.id = "todolinkbtn";

    this.root = el("aside", "todo-drawer");
    this.root.id = "tododrawer";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", l10n.t("ToDo items for this conversation"));
    this.root.hidden = true;
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        e.stopPropagation();
        this.setOpen(false, true);
      }
    });
    const head = this.headEl = el("header", "todo-drawer-head");
    const close = todoCloseButton(() => this.setOpen(false, true), l10n.t("Close the drawer (Esc)"));
    const toTab = todoButton("todo-text-btn todo-drawer-totab", l10n.t("To the ToDo tab"), () => {
      const scope = todoDrawerScope(this.linkedItemId(), this.tabId === null ? undefined : this.scopes.get(this.tabId));
      this.setOpen(false, false);
      this.where.showInTodoTab(scope);
    }, l10n.t("Open the shown item's details in the ToDo tab"));
    this.runningBtn = todoButton("todo-link todo-drawer-running", "", () => this.next("running"), l10n.t("Show the next item with a working conversation"));
    this.waitingBtn = todoButton("todo-link todo-drawer-waiting", "", () => this.next("waiting"), l10n.t("Show the next item waiting for your decision"));
    this.scopeEl = el("span", "todo-drawer-scope");
    this.scopeEl.setAttribute("role", "radiogroup");
    this.scopeEl.setAttribute("aria-label", l10n.t("Items shown"));
    this.countEl = el("span", "todo-drawer-count");
    const bar = el("div", "todo-drawer-bar");
    const actions = el("div", "todo-drawer-actions");
    actions.append(toTab, close);
    bar.append(el("h2", "todo-where todo-drawer-title", l10n.t("ToDo items for this conversation")), actions);
    const sub = el("div", "todo-drawer-sub");
    sub.append(this.scopeEl, this.runningBtn, this.waitingBtn, this.countEl);
    head.append(bar, sub);
    this.marksEl = el("div", "todo-drawer-marks");
    this.marksEl.hidden = true;
    this.listEl = el("div", "todo-list todo-drawer-list");
    this.root.append(head, this.marksEl, this.listEl);
    this.rows = new TodoRowRenderer({
      openDetail: id => { openTodoDetail(id); },
      edit: edit => this.source.edit(edit),
      toggleCollapsed: id => {
        if (!this.collapsed.delete(id)) this.collapsed.add(id);
        this.render();
      },
      openConversation: id => this.source.openConversation(id, false),
      render: () => this.render(),
      asks: id => this.source.asks(id),
      askNote: id => this.source.askNote(id),
      askActions: this.source.askActions,
    }, () => this.listEl, "drawer-");
    this.source.onChange(() => this.sync());
    this.sync();
  }

  get isOpen(): boolean {
    return this.openNow;
  }

  setActiveTab(tabId: string | null): void {
    if (this.tabId === tabId) return;
    this.tabId = tabId;
    this.sync();
  }

  private linkedItemId(): string | undefined {
    return this.source.itemOfTab(this.tabId);
  }

  toggle(): void {
    if (this.tabId === null) return;
    this.setOpen(!this.openNow, !this.openNow ? false : true);
  }

  reveal(id: string): void {
    if (!this.available() || !this.source.items.some(item => item.id === id)) return;
    const linked = this.linkedItemId();
    if (this.tabId !== null && linked !== undefined && !todoScopeIds(this.source.items, linked).has(id)) this.scopes.set(this.tabId, "all");
    for (const ancestor of this.ancestors(id)) this.collapsed.delete(ancestor);
    if (!this.openNow) this.setOpen(true, false);
    else this.render();
    this.flash(id);
  }

  private ancestors(id: string): string[] {
    const byId = new Map(this.source.items.map(item => [item.id, item]));
    const out: string[] = [];
    for (let at = byId.get(id)?.parentId ?? null; at !== null && !out.includes(at); at = byId.get(at)?.parentId ?? null) out.push(at);
    return out;
  }

  private flash(id: string): void {
    const row = this.listEl.querySelector<HTMLElement>(`.todo-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.add("flash");
    row.scrollIntoView({ block: "nearest" });
    setTimeout(() => row.classList.remove("flash"), TODO_DRAWER_FLASH_MS);
  }

  private scopeSet(): ReadonlySet<string> | null {
    const linked = this.linkedItemId();
    const scope = todoDrawerScope(linked, this.tabId === null ? undefined : this.scopes.get(this.tabId));
    return scope === undefined ? null : todoScopeIds(this.source.items, scope);
  }

  private next(kind: "running" | "waiting"): void {
    const ids = this.source.attention(this.scopeSet())[kind];
    if (ids.length === 0) return;
    this.cycle[kind] = (this.cycle[kind] + 1) % ids.length;
    const id = ids[this.cycle[kind]];
    for (const ancestor of this.ancestors(id)) this.collapsed.delete(ancestor);
    this.render();
    this.flash(id);
  }

  private place(): void {
    const rail = this.openNow && this.tabId !== null ? this.where.rail(this.tabId) : null;
    if (this.hiddenRail && this.hiddenRail !== rail) { this.hiddenRail.style.visibility = ""; this.hiddenRail = null; }
    this.root.classList.toggle("in-rail", rail !== null);
    const composer = this.where.composer;
    const composerTop = composer.getClientRects().length === 0 ? window.innerHeight : composer.getBoundingClientRect().top;
    this.root.style.bottom = `${Math.max(window.innerHeight - composerTop, 0)}px`;
    const overlayTop = todoOverlayTop();
    if (!rail) {
      for (const prop of ["left", "width"]) this.root.style.removeProperty(prop);
      this.root.style.top = `${overlayTop}px`;
      return;
    }
    const rect = rail.getBoundingClientRect();
    this.root.style.left = `${rect.left}px`;
    this.root.style.top = `${Math.max(overlayTop, Math.min(rect.top, composerTop - this.minHeight()))}px`;
    this.root.style.width = `${rect.width}px`;
    rail.style.visibility = "hidden";
    this.hiddenRail = rail;
  }

  private minHeight(): number {
    const row = this.listEl.querySelector(".todo-row") ?? this.listEl.firstElementChild;
    const bottom = row ? row.getBoundingClientRect().bottom + this.listEl.scrollTop : this.listEl.getBoundingClientRect().top;
    return bottom - this.headEl.getBoundingClientRect().top;
  }

  private setOpen(open: boolean, refocus: boolean): void {
    this.openNow = open && this.available();
    this.root.hidden = !this.openNow;
    this.button.setAttribute("aria-expanded", this.openNow ? "true" : "false");
    this.place();
    if (this.openNow) {
      window.addEventListener("resize", this.onResize);
      this.composerResize.observe(this.where.composer);
      this.render();
      queueMicrotask(() => (this.listEl.querySelector<HTMLElement>("[data-focus-key]") ?? this.root.querySelector<HTMLElement>("button"))?.focus());
    } else {
      window.removeEventListener("resize", this.onResize);
      this.composerResize.disconnect();
      if (refocus) this.button.focus();
    }
  }

  private available(): boolean {
    return this.source.enabled && this.tabId !== null;
  }

  private sync(): void {
    const available = this.available();
    this.button.hidden = !this.source.enabled;
    this.button.disabled = this.tabId === null;
    this.button.title = this.tabId === null ? l10n.t("The ToDo drawer opens in a conversation tab.") : l10n.t("ToDo items for this conversation ({0})", todoDrawerKeyLabel());
    const linked = available ? this.linkedItemId() : undefined;
    const item = linked === undefined ? undefined : this.source.items.find(entry => entry.id === linked);
    this.linkButton.hidden = item === undefined;
    if (item) {
      const label = l10n.t("Open the details of the ToDo item “{0}”", item.title);
      this.linkButton.replaceChildren(todoStateIcon(item.state), el("span", "todo-link-num", this.source.numberOf(item.id)), el("span", "todo-link-title", item.title));
      this.linkButton.title = label;
      this.linkButton.setAttribute("aria-label", label);
      const color = this.source.colorOf(item.id);
      if (color) this.linkButton.style.setProperty("--todo-ic", color);
      else this.linkButton.style.removeProperty("--todo-ic");
    }
    if (!available) this.setOpen(false, false);
    else if (this.openNow) { this.place(); this.render(); }
  }

  private renderScope(linked: string | undefined, chosen: TodoDrawerScope): void {
    this.scopeEl.replaceChildren();
    this.scopeEl.hidden = linked === undefined;
    if (linked === undefined) return;
    const options: ReadonlyArray<readonly [TodoDrawerScope, string]> = [["mine", l10n.t("This conversation's item")], ["all", l10n.t("All")]];
    for (const [scope, text] of options) {
      const button = todoButton(`todo-link${scope === chosen ? " on" : ""}`, text, () => {
        if (this.tabId === null || scope === chosen) return;
        this.scopes.set(this.tabId, scope);
        this.render();
        (this.scopeEl.querySelector<HTMLElement>(`[data-scope="${scope}"]`))?.focus();
      });
      button.dataset.scope = scope;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", scope === chosen ? "true" : "false");
      this.scopeEl.append(button);
    }
  }

  render(): void {
    if (!this.openNow) return;
    const linked = this.linkedItemId();
    const chosen = this.tabId === null ? undefined : this.scopes.get(this.tabId);
    const scope = todoDrawerScope(linked, chosen);
    this.renderScope(linked, scope === undefined ? "all" : "mine");
    const view = deriveTodoList(this.source.items, { group: null, due: "all", collapsed: this.collapsed, today: localDateKey(new Date()), colors: this.source.groupColors, ...(scope !== undefined ? { scope } : {}) });
    this.countEl.textContent = view.total === 1 ? l10n.t("1 item · {0} open", view.open) : l10n.t("{0} items · {1} open", view.total, view.open);
    const attention = this.source.attention(this.scopeSet());
    this.runningBtn.hidden = attention.running.length === 0;
    this.runningBtn.textContent = l10n.t("{0} working", attention.running.length);
    this.waitingBtn.hidden = attention.waitingCount === 0;
    this.waitingBtn.textContent = l10n.t("{0} waiting for you", attention.waitingCount);
    const shown = new Set(view.sections.flatMap(section => section.ids));
    const marks = this.source.items.filter(item => shown.has(item.id)).flatMap(item => item.marks ?? []);
    this.marksEl.hidden = marks.length === 0;
    this.marksEl.replaceChildren();
    if (marks.length > 0) {
      this.marksEl.append(el("span", "todo-drawer-marks-label", l10n.t("Changed by Claude: {0}", marks.length)),
        todoButton("todo-link", l10n.t("Mark all as checked"), () => this.source.edit({ kind: "acknowledge", changeIds: marks }), l10n.t("Clear the “changed by Claude” marks and keep the changes")));
    }
    this.listEl.replaceChildren();
    if (view.total === 0) this.listEl.append(el("p", "todo-note", l10n.t("No ToDo items yet. Add them in the ToDo tab or ask Claude in a conversation.")));
    else for (const section of view.sections) this.listEl.append(this.rows.sectionEl(section, view.headed && scope === undefined));
    this.place();
  }
}
