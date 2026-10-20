import { isComposingKey } from "./composing";
import * as l10n from "@vscode/l10n";
import {
  IMAGE_MAX_BASE64_LEN,
  TODO_DETAIL_SECTIONS,
  TODO_USER_MEMO_MAX,
  type TodoDetailItem,
  type TodoDetailMessage,
  type TodoWorkMessage,
  type TodoWorkView,
  type TodoDetailSection,
  type TodoDocView,
  type TodoEdit,
  type TodoImageMessage,
  type TodoListItem,
  type WebviewToHost,
} from "../protocol";
import { TODO_DOC_LABEL_MAX, TODO_DOC_TARGET_MAX, TODO_ESTIMATE_PATTERN, TODO_IMAGE_EXTENSIONS, TODO_TAGS_MAX, TODO_TIME_UNKNOWN, TODO_TITLE_MAX, TODO_WAITING_MAX, type TodoImageMediaType, type TodoState, type WorkMemoSection } from "../todo-model";
import { formatDateTime } from "./l10n";
import {
  formatTodoDay,
  isTextEntryTarget,
  openTodoMenu,
  readImageAsBase64,
  TODO_MEMO_LABELS,
  TODO_PRIORITY_LABELS,
  TODO_STATE_KEYS,
  TODO_STATE_LABELS,
  todoButton,
  todoChangeRow, todoRevertUnit,
  todoClearNotice,
  todoCloseButton,
  todoFillNotice,
  todoEl,
  todoDateInput,
  todoDateEl,
  todoGroupSelect,
  todoPlayButton,
  todoGuessMark,
  todoParentSelect,
  todoPriorityOptions,
  todoRepeatLabel,
  todoRepeatOptions,
  TODO_REPLY_WAIT_MS,
  todoSegment,
  todoSelect,
  todoSpan,
  todoStateIcon,
  todoStateMenu,
  todoStateOptions,
  todoTalkMark,
  todoTextField,
  todoMenuToggle,
  todoTitleEdit,
} from "./todo-edit";
import { todoMoveSteps } from "./todo-organize";
import { localDateKey, todoRootGroup } from "./todo-rows";

export interface TodoGroupPlaces {
  readonly folders: readonly string[];
  readonly aliases: readonly { readonly words: string; readonly parentId?: string }[];
}

export interface TodoDetailHost {
  post(message: WebviewToHost): void;
  edit(edit: TodoEdit): void;
  notify(notice: string): void;
  items(): readonly TodoListItem[];
  numberOf(id: string): string;
  colorOf(id: string): string;
  openConversation(id: string, fresh: boolean): void;
  splitChild(id: string): void;
  waiting(id: string): boolean;
  groups(): readonly string[];
  groupPlaces(group: string): TodoGroupPlaces;
}

export const TODO_HISTORY_FILTERS = ["all", "talk", "split", "handoff", "change"] as const;
export type TodoHistoryFilter = typeof TODO_HISTORY_FILTERS[number];

const SECTION_LABELS: Record<TodoDetailSection, () => string> = {
  note: () => l10n.t("Your memo"),
  now: () => l10n.t("Where it stands → Next steps"),
  memo: () => l10n.t("Claude's work memo"),
  docs: () => l10n.t("References"),
  kids: () => l10n.t("Sub-items"),
  fields: () => l10n.t("Status and dates"),
  info: () => l10n.t("More information"),
  hist: () => l10n.t("History"),
};

const FOLDABLE: ReadonlySet<TodoDetailSection> = new Set(["note", "memo", "docs", "kids", "fields", "info", "hist"]);
const isImageType = (type: string): type is TodoImageMediaType => type in TODO_IMAGE_EXTENSIONS;
const MEMO_REST: readonly WorkMemoSection[] = ["decisions", "open", "files"];
const firstLine = (text: string) => text.split("\n").find(line => line.trim()) ?? "";
const IMAGE_CACHE_MAX = 50;
const FOCUSABLE = "button:not([disabled]), input:not([disabled]):not([type=\"file\"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])";

export class TodoDetail {
  readonly root: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private id: string | null = null;
  private item: TodoDetailItem | null = null;
  private work: TodoWorkView | undefined;
  private loaded = false;
  private loadFailed = false;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private revision = -1;
  private order: TodoDetailSection[] = [...TODO_DETAIL_SECTIONS];
  private readonly expanded = new Set<TodoDetailSection>(["fields", "note", "docs", "kids"]);
  private readonly images = new Map<string, string | null>();
  private addingLink = false;
  private maximized = false;
  private editingTitle = false;
  private memoDraft: string | null = null;
  private deferred = false;
  private returnFocus: HTMLElement | null = null;
  private dragging: TodoDetailSection | null = null;
  private readonly noticeEl: HTMLElement;
  private historyFilter: TodoHistoryFilter = "all";
  private readonly openTexts = new Set<string>();
  private viewer: number | null = null;
  private editingDoc: string | null = null;

  constructor(private readonly host: TodoDetailHost) {
    this.root = todoEl("div", "todo-dlg-wrap");
    this.root.hidden = true;
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.hide();
    });
    this.dialog = todoEl("div", "todo-dlg");
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", l10n.t("Item details"));
    this.dialog.tabIndex = -1;
    this.noticeEl = todoEl("div", "todo-notice");
    this.noticeEl.setAttribute("role", "status");
    this.noticeEl.hidden = true;
    this.dialog.addEventListener("keydown", (e) => this.onKeydown(e));
    this.dialog.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData?.items ?? []).filter(entry => entry.kind === "file" && isImageType(entry.type)).map(entry => entry.getAsFile());
      if (files.length === 0) return;
      e.preventDefault();
      for (const file of files) if (file) this.addImage(file);
    });
    this.dialog.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      this.dialog.classList.add("drag-over");
    });
    this.dialog.addEventListener("dragleave", (e) => {
      if (e.target === this.dialog) this.dialog.classList.remove("drag-over");
    });
    this.dialog.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      this.dialog.classList.remove("drag-over");
      for (const file of Array.from(e.dataTransfer.files)) if (isImageType(file.type)) this.addImage(file);
    });
    this.dialog.addEventListener("focusout", () => queueMicrotask(() => {
      if (this.deferred && !isTextEntryTarget(document.activeElement)) this.render();
    }));
    this.root.append(this.dialog);
  }

  setNotice(notice: string | null): void {
    if (notice === null) todoClearNotice(this.noticeEl, this.dialog);
    else todoFillNotice(this.noticeEl, [notice], () => this.setNotice(null));
  }

  get openId(): string | null {
    return this.id;
  }

  show(id: string): void {
    if (this.id === null) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.id = id;
    this.item = null;
    this.work = undefined;
    this.loaded = false;
    this.loadFailed = false;
    this.revision = -1;
    this.editingTitle = false;
    this.memoDraft = null;
    this.viewer = null;
    this.editingDoc = null;
    this.openTexts.clear();
    this.root.hidden = false;
    this.render();
    this.dialog.focus();
    this.refresh();
  }

  hide(): void {
    if (this.id === null) return;
    this.id = null;
    this.item = null;
    clearTimeout(this.loadTimer);
    this.root.hidden = true;
    this.dialog.replaceChildren();
    this.setNotice(null);
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    this.returnFocus = null;
  }

  refresh(): void {
    const id = this.id;
    if (id === null) return;
    this.host.post({ type: "todoDetailRequest", id });
    if (this.loaded) return;
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      if (this.id !== id || this.loaded) return;
      this.loadFailed = true;
      this.render();
    }, TODO_REPLY_WAIT_MS);
  }

  private retryLoad(): void {
    this.loadFailed = false;
    this.render();
    this.refresh();
  }

  applyWork(message: TodoWorkMessage): void {
    if (message.id !== this.id || message.revision < this.revision) return;
    this.work = message.work;
    if (this.item && !this.deferred && !(this.dialog.contains(document.activeElement) && isTextEntryTarget(document.activeElement))) this.render();
  }

  apply(message: TodoDetailMessage): void {
    if (message.id !== this.id || message.revision < this.revision) return;
    if (message.item === null) this.work = undefined;
    this.revision = message.revision;
    this.item = message.item;
    this.loaded = true;
    this.loadFailed = false;
    clearTimeout(this.loadTimer);
    if (!this.dragging) this.order = [...message.sectionOrder];
    if (this.dialog.contains(document.activeElement) && isTextEntryTarget(document.activeElement)) {
      this.deferred = true;
      return;
    }
    this.render();
  }

  private edit(edit: TodoEdit): void {
    this.host.edit(edit);
  }

  applyImage(message: TodoImageMessage): void {
    const src = "missing" in message ? null : `data:${message.mediaType};base64,${message.data}`;
    this.images.delete(message.name);
    this.images.set(message.name, src);
    for (const name of this.images.keys()) {
      if (this.images.size <= IMAGE_CACHE_MAX) break;
      this.images.delete(name);
    }
    for (const img of Array.from(this.dialog.querySelectorAll<HTMLImageElement>("img[data-image]"))) {
      if (img.dataset.image !== message.name) continue;
      if (src) img.src = src;
      else img.replaceWith(todoEl("span", "todo-doc-missing", l10n.t("Image not found")));
    }
  }

  private addImage(file: File): void {
    const id = this.id;
    const type = file.type;
    if (id === null || !isImageType(type)) return;
    const tooLarge = l10n.t("The image is larger than {0} MB.", Math.floor(IMAGE_MAX_BASE64_LEN * 3 / 4 / 1_000_000));
    if (Math.ceil(file.size / 3) * 4 > IMAGE_MAX_BASE64_LEN) {
      this.host.notify(tooLarge);
      return;
    }
    this.expanded.add("docs");
    void readImageAsBase64(file).then(data => {
      if (data.length > IMAGE_MAX_BASE64_LEN) this.host.notify(tooLarge);
      else this.edit({ kind: "addImage", id, mediaType: type, data });
    }, () => this.host.notify(l10n.t("The image could not be read.")));
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Tab") {
      const focusable = Array.from(this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(node => node.offsetParent !== null || node === document.activeElement);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        this.dialog.focus();
      } else if (e.shiftKey && (active === first || active === this.dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    const state = TODO_STATE_KEYS[e.key];
    if (state && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextEntryTarget(e.target) && this.item && this.item.state !== state) {
      e.preventDefault();
      this.edit({ kind: "setState", id: this.item.id, state });
      return;
    }
    if (e.key === "Escape" && !isTextEntryTarget(e.target) && !this.editingTitle) {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    }
  }

  private render(): void {
    this.deferred = false;
    this.dialog.classList.toggle("max", this.maximized);
    if (this.id === null) return;
    const item = this.item;
    if (!item) {
      const head = todoEl("header", "todo-dlg-h");
      head.append(todoEl("div", "todo-dlg-ht", this.loaded ? l10n.t("This item was deleted or no longer exists.") : this.loadFailed ? l10n.t("The item's details could not be loaded.") : l10n.t("Loading…")),
        ...(this.loaded || !this.loadFailed ? [] : [todoButton("todo-link", l10n.t("Retry"), () => this.retryLoad())]), this.closeButton());
      this.dialog.replaceChildren(head);
      return;
    }
    const body = todoEl("div", "todo-dlg-b");
    body.append(this.noticeEl);
    for (const key of this.order) {
      const section = this.section(key, item);
      if (section) body.append(section);
    }
    const viewer = this.viewerEl(item);
    this.dialog.replaceChildren(this.header(item), body, ...(viewer ? [viewer] : []));
  }

  private closeButton(): HTMLButtonElement {
    return todoCloseButton(() => this.hide());
  }

  private header(item: TodoDetailItem): HTMLElement {
    const head = todoEl("header", "todo-dlg-h");
    head.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button, input, .todo-dlg-title")) return;
      this.toggleMaximized();
    });
    const text = todoEl("div", "todo-dlg-ht");
    const crumb = todoEl("div", "todo-dlg-crumb");
    const color = this.host.colorOf(item.id);
    if (color) {
      const dot = todoEl("span", "todo-dot");
      dot.setAttribute("aria-hidden", "true");
      dot.style.setProperty("--todo-gc", color);
      crumb.append(dot);
    }
    crumb.append(todoEl("span", "", todoRootGroup(this.host.items(), item.id) ?? item.group ?? l10n.t("No group")));
    const parent = item.parentId !== null ? this.host.items().find(entry => entry.id === item.parentId) : undefined;
    if (parent) {
      crumb.append(todoEl("span", "", "·"), todoEl("span", "", l10n.t("Parent:")),
        todoButton("todo-link", parent.title, () => this.show(parent.id), l10n.t("Open the parent's details")));
    }
    const line = todoEl("div", "todo-dlg-tl");
    if (color) line.style.setProperty("--todo-ic", color);
    line.append(this.stateButton(item.id, item.state), todoEl("span", "todo-dlg-num", this.host.numberOf(item.id)), this.titleEl(item));
    text.append(crumb, line, this.summaryEl(item));
    const more = todoMenuToggle("todo-dlg-more", l10n.t("More"), button => openTodoMenu(button, [
      ...this.conversationEntries(item),
      { label: l10n.t("Reset the section order"), run: () => this.setOrder([...TODO_DETAIL_SECTIONS]) },
      { label: this.deleteLabel(item), run: () => this.deleteItem(item) },
    ], l10n.t("More")));
    const max = todoButton("todo-dlg-max", "", () => this.toggleMaximized(), l10n.t("Maximise / restore (double-click the top)"));
    max.setAttribute("aria-pressed", this.maximized ? "true" : "false");
    max.setAttribute("aria-label", l10n.t("Maximise / restore"));
    max.append(todoEl("span", "todo-dlg-max-icon"));
    head.append(text, this.playButton(item), more, max, this.closeButton());
    return head;
  }

  private playButton(item: TodoDetailItem): HTMLButtonElement {
    const talk = this.host.items().find(entry => entry.id === item.id)?.talk;
    const subItem = item.parentId !== null;
    return todoPlayButton(talk, () => {
      if (subItem && talk === undefined) {
        this.host.splitChild(item.id);
        return;
      }
      this.hide();
      this.host.openConversation(item.id, false);
    }, subItem);
  }

  private summaryEl(item: TodoDetailItem): HTMLElement {
    const summary = todoEl("div", "todo-dlg-sum");
    const add = (node: Node) => {
      if (summary.childNodes.length) summary.append(document.createTextNode(" · "));
      summary.append(node);
    };
    if (item.priority) {
      const priority = todoEl("span", item.priority === "p0" ? "todo-p0" : "", `${item.priority.toUpperCase()} ${TODO_PRIORITY_LABELS[item.priority]()}`);
      if (item.guesses?.priority) priority.append(todoGuessMark(item.guesses.priority));
      add(priority);
    }
    const dates = todoDateEl(item, localDateKey(new Date()), "todo-dlg-dates");
    if (dates.childElementCount > 0) {
      if (item.guesses?.due) dates.append(todoGuessMark(item.guesses.due));
      add(dates);
    }
    const listed = this.host.items().find(entry => entry.id === item.id);
    const talk = todoTalkMark(listed?.talk, this.host.waiting(item.id));
    if (talk) add(talk);
    return summary;
  }

  private moveUnder(id: string, parentId: string | null): void {
    const items = this.host.items();
    const steps = todoMoveSteps(items, [id], { parentId, group: parentId === null ? todoRootGroup(items, id) : null, before: null }, this.host.groups());
    if (steps.length) this.edit({ kind: "batch", steps });
  }

  private conversationEntries(item: TodoDetailItem): Array<{ label: string; run: () => void }> {
    const linked = this.host.items().find(entry => entry.id === item.id)?.talk !== undefined;
    return linked ? [{ label: l10n.t("Continue in a new conversation"), run: () => { this.hide(); this.host.openConversation(item.id, true); } }] : [];
  }

  private toggleMaximized(): void {
    this.maximized = !this.maximized;
    this.dialog.classList.toggle("max", this.maximized);
    this.dialog.querySelector(".todo-dlg-max")?.setAttribute("aria-pressed", this.maximized ? "true" : "false");
  }

  private stateButton(id: string, state: TodoState): HTMLButtonElement {
    const button = todoButton("todo-state todo-state-btn", "", () => todoStateMenu(button, state, next => this.edit({ kind: "setState", id, state: next })));
    button.title = l10n.t("State: {0} (press to change)", TODO_STATE_LABELS[state]());
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.append(todoStateIcon(state));
    return button;
  }

  private titleEl(item: TodoDetailItem): HTMLElement {
    if (!this.editingTitle) {
      const title = todoEl("span", "todo-dlg-title", item.title);
      title.tabIndex = 0;
      title.setAttribute("role", "button");
      title.title = l10n.t("Press to edit the title");
      const start = () => {
        this.editingTitle = true;
        this.render();
      };
      title.addEventListener("click", start);
      title.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          start();
        }
      });
      return title;
    }
    const input = todoEl("input", "todo-dlg-title-in");
    input.type = "text";
    input.value = item.title;
    input.maxLength = TODO_TITLE_MAX;
    input.spellcheck = false;
    input.setAttribute("aria-label", l10n.t("Title"));
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.editingTitle = false;
      const edit = save ? todoTitleEdit(item, input.value) : null;
      if (edit) this.edit(edit);
      this.render();
      (this.dialog.querySelector(".todo-dlg-title") as HTMLElement | null)?.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (isComposingKey(e)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  private changeActions() {
    return {
      revert: (changeIds: readonly string[]) => this.edit({ kind: "revertClaude", changeIds: [...changeIds] }),
      acknowledge: (changeIds: readonly string[]) => this.edit({ kind: "acknowledge", changeIds: [...changeIds] }),
    };
  }

  private section(key: TodoDetailSection, item: TodoDetailItem): HTMLElement | null {
    const kids = this.host.items().filter(entry => entry.parentId === item.id);
    if (key === "kids" && kids.length === 0) return null;
    const section = todoEl("section", `todo-ds${this.expanded.has(key) || !FOLDABLE.has(key) ? " open" : ""}`);
    section.dataset.section = key;
    const row = todoEl("div", "todo-ds-hrow");
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      this.dragging = key;
      section.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", key);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      this.dragging = null;
      section.classList.remove("dragging");
      for (const node of Array.from(this.dialog.querySelectorAll(".drop-before, .drop-after"))) node.classList.remove("drop-before", "drop-after");
    });
    section.addEventListener("dragover", (e) => {
      if (!this.dragging || this.dragging === key) return;
      e.preventDefault();
      const after = e.offsetY > section.offsetHeight / 2;
      section.classList.toggle("drop-after", after);
      section.classList.toggle("drop-before", !after);
    });
    section.addEventListener("dragleave", () => section.classList.remove("drop-before", "drop-after"));
    section.addEventListener("drop", (e) => {
      if (!this.dragging || this.dragging === key) return;
      e.preventDefault();
      this.moveSection(this.dragging, key, section.classList.contains("drop-after"));
    });
    const grip = todoEl("span", "todo-ds-grip", "⋮⋮");
    grip.setAttribute("aria-hidden", "true");
    const head: HTMLElement = todoEl(FOLDABLE.has(key) ? "button" : "div", "todo-ds-h");
    head.tabIndex = 0;
    head.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    head.title = l10n.t("Drag the heading or press Alt+↑/↓ to reorder; the order is shared by every item");
    if (head instanceof HTMLButtonElement) {
      head.type = "button";
      head.setAttribute("aria-expanded", this.expanded.has(key) ? "true" : "false");
      head.addEventListener("click", () => {
        if (!this.expanded.delete(key)) this.expanded.add(key);
        this.render();
        (this.dialog.querySelector(`[data-section="${key}"] .todo-ds-h`) as HTMLElement | null)?.focus();
      });
      head.append(todoEl("span", "todo-ds-chev", "›"));
    }
    head.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      this.stepSection(key, e.key === "ArrowDown" ? 1 : -1);
    });
    const label = key === "now" && item.state === "done" ? l10n.t("Result") : SECTION_LABELS[key]();
    head.append(todoEl("span", "todo-ds-label", label), todoEl("span", "todo-ds-hint", this.hint(key, item, kids)));
    row.append(grip, head);
    section.append(row);
    if (this.expanded.has(key) || !FOLDABLE.has(key)) section.append(this.sectionBody(key, item, kids));
    return section;
  }

  private hint(key: TodoDetailSection, item: TodoDetailItem, kids: readonly TodoListItem[]): string {
    switch (key) {
      case "note": return this.expanded.has("note") ? "" : firstLine(item.userMemo);
      case "now": return item.memoStaleSince !== undefined ? l10n.t("May be out of date") : "";
      case "memo": return item.memoStaleSince !== undefined ? l10n.t("Written by Claude; read-only · may be out of date") : l10n.t("Written by Claude; read-only");
      case "docs": {
        const images = item.docs.filter(doc => doc.kind === "image").length;
        return item.docs.length ? l10n.t("Images {0} · links {1}", images, item.docs.length - images) : l10n.t("None yet");
      }
      case "kids": return this.kidsLine(kids);
      case "fields": return [TODO_STATE_LABELS[item.state](), item.priority?.toUpperCase(), item.due && formatTodoDay(item.due)].filter(Boolean).join(" · ");
      case "info": return [item.group, item.repeat && todoRepeatLabel(item.repeat)].filter(Boolean).join(" · ");
      case "hist": {
        const count = this.historyEntries(item).length;
        return count ? l10n.t("{0} entries", count) : l10n.t("None yet");
      }
    }
  }

  private sectionBody(key: TodoDetailSection, item: TodoDetailItem, kids: readonly TodoListItem[]): HTMLElement {
    const body = todoEl("div", "todo-ds-b");
    switch (key) {
      case "note": body.append(this.noteBody(item)); break;
      case "now":
        if (item.memoStaleSince !== undefined) body.append(this.staleNote(item.memoStaleSince));
        if (item.state === "done") {
          const result = item.workMemo.current;
          const text = todoEl("span", `todo-mt${result?.text ? "" : " empty"}`, result?.text || "—");
          const row = todoEl("div", "todo-dn-r todo-result");
          row.append(todoEl("span", "todo-mk", TODO_MEMO_LABELS.current()), text);
          body.append(row);
          break;
        }
        for (const section of ["current", "next"] as const) {
          const memo = item.workMemo[section];
          const row = todoEl("div", "todo-dn-r");
          const text = todoEl("span", `todo-dn-t${memo?.text ? "" : " empty"}`, memo?.text ? firstLine(memo.text) : "—");
          if (memo?.text) text.title = `${memo.text}\n— ${formatDateTime(memo.at)}`;
          row.append(todoEl("span", "todo-mk", TODO_MEMO_LABELS[section]()), text);
          body.append(row);
        }
        break;
      case "memo": {
        if (item.memoStaleSince !== undefined) body.append(this.staleNote(item.memoStaleSince));
        const multi = (["current", "next"] as const).filter(section => (item.workMemo[section]?.text ?? "").includes("\n"));
        for (const section of [...multi, ...MEMO_REST]) {
          const memo = item.workMemo[section];
          const row = todoEl("div", "todo-mr");
          const value = todoEl("div", "todo-mv");
          value.append(todoEl("span", "todo-mt", memo?.text || "—"));
          if (memo) value.append(todoEl("span", "todo-mb", l10n.t("Claude · updated {0}", formatDateTime(memo.at))));
          row.append(todoEl("span", "todo-mk", TODO_MEMO_LABELS[section]()), value);
          body.append(row);
        }
        break;
      }
      case "kids": {
        body.append(todoEl("p", "todo-kids-line", this.kidsLine(kids)));
        const list = todoEl("ul", "todo-kids");
        const today = localDateKey(new Date());
        for (const kid of kids) {
          const row = todoEl("li", `todo-kid st-${kid.state}`);
          const color = this.host.colorOf(kid.id);
          if (color) row.style.setProperty("--todo-ic", color);
          const open = todoButton("todo-kid-t", "", () => this.show(kid.id), l10n.t("Open the details"));
          open.append(todoEl("span", "todo-dlg-num", this.host.numberOf(kid.id)), document.createTextNode(kid.title));
          const talk = todoTalkMark(kid.talk, this.host.waiting(kid.id));
          const due = todoDateEl(kid, today, "todo-kid-due");
          row.append(this.stateButton(kid.id, kid.state), open, ...(talk ? [talk] : []), due);
          list.append(row);
        }
        body.append(list);
        break;
      }
      case "fields": body.append(this.fieldsBody(item)); break;
      case "info": body.append(this.infoBody(item)); break;
      case "docs": body.append(this.docsBody(item)); break;
      case "hist": body.append(this.historyBody(item)); break;
    }
    return body;
  }

  private kidsLine(kids: readonly TodoListItem[]): string {
    const done = kids.filter(kid => kid.state === "done").length;
    const starts = kids.flatMap(kid => kid.start ?? kid.due ?? []).sort();
    const ends = kids.flatMap(kid => kid.due ?? kid.start ?? []).sort();
    const waiting = kids.filter(kid => kid.waiting);
    return [
      l10n.t("{0}/{1} done", done, kids.length),
      starts.length ? `${formatTodoDay(starts[0], "day")} → ${formatTodoDay(ends[ends.length - 1], "day")}` : null,
      waiting.length ? l10n.t("Waiting: {0}", waiting.map(kid => `${kid.title} (${kid.waiting})`).join(", ")) : null,
    ].filter((part): part is string => part !== null).join(" · ");
  }

  private historyEntries(item: TodoDetailItem): Array<{ at: number; kinds: readonly TodoHistoryFilter[]; node: () => HTMLElement }> {
    const entries: Array<{ at: number; kinds: readonly TodoHistoryFilter[]; node: () => HTMLElement }> = [];
    const shown = new Set<string>();
    for (const change of item.changes) {
      if (shown.has(change.id)) continue;
      const unit = todoRevertUnit(item.changes, change);
      for (const entry of unit) shown.add(entry.id);
      entries.push({ at: change.at, kinds: ["change"], node: () => {
        const row = todoChangeRow(change, this.changeActions(), false, unit);
        if (change.field.startsWith("workMemo.") && change.before !== null) this.appendText(row, `v:${change.id}`, l10n.t("Show the earlier version"), l10n.t("Hide the earlier version"), change.before);
        return row;
      } });
    }
    for (const talk of item.conversations) {
      entries.push({ at: talk.at, kinds: talk.handoffs > 0 ? ["talk", "handoff"] : ["talk"], node: () => {
        const row = todoEl("li", "todo-change todo-hist-talk");
        row.append(todoEl("span", "todo-change-at", formatDateTime(talk.at)), todoEl("span", "todo-change-who", l10n.t("Conversation")),
          todoEl("span", "todo-change-what", talk.handoffs > 0 ? l10n.t("Linked a conversation · handed off {0} times", talk.handoffs) : l10n.t("Linked a conversation")));
        return row;
      } });
    }
    item.briefs.forEach((brief, index) => {
      entries.push({ at: brief.at, kinds: ["split"], node: () => {
        const row = todoEl("li", "todo-change todo-hist-split");
        row.append(todoEl("span", "todo-change-at", formatDateTime(brief.at)), todoEl("span", "todo-change-who", "LAISORA"),
          todoEl("span", "todo-change-what", l10n.t("Split into a child conversation")));
        this.appendText(row, `b:${index}:${brief.at}`, l10n.t("Open the brief"), l10n.t("Close the brief"), brief.text);
        return row;
      } });
    });
    return entries.sort((a, b) => b.at - a.at);
  }

  private appendText(row: HTMLElement, key: string, show: string, hide: string, text: string): void {
    const open = this.openTexts.has(key);
    const toggle = todoButton("todo-link todo-change-revert", open ? hide : show, () => {
      if (!this.openTexts.delete(key)) this.openTexts.add(key);
      this.render();
    });
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    row.append(toggle);
    if (open) row.append(todoEl("pre", "todo-hist-text", text));
  }

  private historyBody(item: TodoDetailItem): HTMLElement {
    const wrap = todoEl("div", "todo-hist");
    const labels: Record<TodoHistoryFilter, string> = {
      all: l10n.t("All"), talk: l10n.t("Conversations"), split: l10n.t("Splits"), handoff: l10n.t("Handoffs"), change: l10n.t("Changes"),
    };
    wrap.append(todoSegment(l10n.t("Filter the history"), TODO_HISTORY_FILTERS.map(filter => [filter, labels[filter]] as const), this.historyFilter, filter => {
      this.historyFilter = filter;
      this.render();
    }));
    const shown = this.historyEntries(item).filter(entry => this.historyFilter === "all" || entry.kinds.includes(this.historyFilter));
    if (shown.length === 0) {
      wrap.append(todoEl("p", "todo-note", l10n.t("None yet")));
      return wrap;
    }
    const list = todoEl("ol", "todo-change-list");
    for (const entry of shown) list.append(entry.node());
    wrap.append(list);
    return wrap;
  }

  private staleNote(since: number): HTMLElement {
    return todoEl("p", "todo-stale", l10n.t("Its conversation worked after this memo was written ({0}), so it may be out of date until Claude updates it.", formatDateTime(since)));
  }

  private docsBody(item: TodoDetailItem): HTMLElement {
    const wrap = todoEl("div", "todo-docs");
    const remove = (doc: TodoDocView) => todoButton("todo-link todo-doc-rm", l10n.t("Remove"), () => this.edit({ kind: "removeDoc", id: item.id, docId: doc.id }));
    const open = (doc: TodoDocView) => this.host.post({ type: "todoOpenDoc", itemId: item.id, docId: doc.id });
    const images = item.docs.filter(doc => doc.kind === "image");
    if (images.length) {
      const strip = todoEl("div", "todo-doc-images");
      for (const doc of images) {
        const figure = todoEl("figure", "todo-doc-image");
        const thumb = todoButton("todo-doc-thumb", "", () => { this.viewer = images.indexOf(doc); this.render(); }, l10n.t("Open the image"));
        thumb.setAttribute("aria-label", doc.label ?? l10n.t("Open the image"));
        const cached = this.images.get(doc.target);
        if (cached === null) thumb.append(todoEl("span", "todo-doc-missing", l10n.t("Image not found")));
        else {
          const img = document.createElement("img");
          img.alt = doc.label ?? "";
          img.dataset.image = doc.target;
          if (cached) img.src = cached;
          else this.host.post({ type: "todoImageRequest", name: doc.target });
          thumb.append(img);
        }
        const caption = todoEl("figcaption", "todo-mb");
        caption.append(this.labelEl(item.id, doc, l10n.t("Add a caption")), document.createTextNode(` · ${formatDateTime(doc.at)} `), remove(doc));
        figure.append(thumb, caption);
        strip.append(figure);
      }
      wrap.append(strip);
    }
    const links = item.docs.filter(doc => doc.kind !== "image");
    if (links.length) {
      const list = todoEl("ul", "todo-doc-links");
      for (const doc of links) {
        const row = todoEl("li", "todo-doc-link");
        const icon = todoEl("span", "todo-doc-kind", doc.kind === "url" ? "↗" : "▤");
        icon.setAttribute("aria-hidden", "true");
        const text = doc.label ?? doc.target;
        const link = this.editingDoc === doc.id ? this.labelEl(item.id, doc, "")
          : todoButton("todo-link todo-doc-open", text, () => open(doc), doc.kind === "url" ? l10n.t("Open in the browser: {0}", doc.target) : l10n.t("Open in the editor: {0}", doc.target));
        const rename = todoButton("todo-link todo-doc-rm", l10n.t("Edit the name"), () => { this.editingDoc = doc.id; this.render(); }, l10n.t("Change the name shown for this link"));
        row.append(icon, link, todoEl("span", "todo-mb", formatDateTime(doc.at)), ...(this.editingDoc === doc.id ? [] : [rename]), remove(doc));
        list.append(row);
      }
      wrap.append(list);
    }
    if (item.docs.length === 0) wrap.append(todoEl("p", "todo-note", l10n.t("None yet")));
    const actions = todoEl("div", "todo-doc-actions");
    if (this.addingLink) {
      const input = todoEl("input", "todo-doc-in");
      input.type = "text";
      input.maxLength = TODO_DOC_TARGET_MAX;
      input.spellcheck = false;
      input.placeholder = l10n.t("A web address or a workspace file");
      input.setAttribute("aria-label", l10n.t("Add a link"));
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        this.addingLink = false;
        const target = input.value.trim();
        if (save && target) this.edit({ kind: "addLink", id: item.id, target });
        this.render();
      };
      input.addEventListener("keydown", (e) => {
        if (isComposingKey(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(false));
      queueMicrotask(() => input.focus());
      actions.append(input);
    } else {
      const picker = todoEl("input", "todo-doc-file");
      picker.type = "file";
      picker.accept = Object.keys(TODO_IMAGE_EXTENSIONS).join(",");
      picker.multiple = true;
      picker.hidden = true;
      picker.addEventListener("change", () => {
        for (const file of Array.from(picker.files ?? [])) this.addImage(file);
      });
      actions.append(
        todoButton("todo-link", l10n.t("Add a link"), () => { this.addingLink = true; this.render(); }),
        todoButton("todo-link", l10n.t("Add an image"), () => picker.click(), l10n.t("Images can also be pasted (Ctrl+V) or dropped here")),
        picker,
      );
    }
    wrap.append(actions);
    return wrap;
  }

  private labelEl(itemId: string, doc: TodoDocView, empty: string, inViewer = false): HTMLElement {
    if (this.editingDoc !== doc.id || (this.viewer !== null) !== inViewer) {
      const label = todoButton("todo-link todo-doc-label", doc.label ?? empty, () => { this.editingDoc = doc.id; this.render(); }, l10n.t("Press to edit the caption"));
      return label;
    }
    const input = todoEl("input", "todo-doc-in");
    input.type = "text";
    input.value = doc.label ?? "";
    input.maxLength = TODO_DOC_LABEL_MAX;
    input.spellcheck = false;
    input.placeholder = doc.kind === "image" ? l10n.t("Caption") : l10n.t("Name shown for the link");
    input.setAttribute("aria-label", doc.kind === "image" ? l10n.t("Caption") : l10n.t("Link name"));
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.editingDoc = null;
      if (save && input.value.trim() !== (doc.label ?? "")) this.edit({ kind: "docLabel", id: itemId, docId: doc.id, label: input.value.trim() });
      this.render();
    };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (isComposingKey(e)) return;
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    queueMicrotask(() => { input.focus(); input.select(); });
    return input;
  }

  private viewerEl(item: TodoDetailItem): HTMLElement | null {
    const images = item.docs.filter(doc => doc.kind === "image");
    if (this.viewer === null || images.length === 0) return null;
    const index = Math.max(0, Math.min(this.viewer, images.length - 1));
    const doc = images[index];
    const wrap = todoEl("div", "todo-viewer");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", l10n.t("Image {0} of {1}", index + 1, images.length));
    wrap.tabIndex = -1;
    const go = (step: number, keepFocus = false) => {
      this.viewer = (index + step + images.length) % images.length;
      this.render();
      if (keepFocus) this.dialog.querySelector<HTMLElement>(`.todo-viewer-step[data-step="${step}"]`)?.focus();
    };
    const close = () => {
      this.viewer = null;
      this.render();
      (this.dialog.querySelectorAll<HTMLElement>(".todo-doc-thumb")[index] ?? this.dialog).focus();
    };
    wrap.addEventListener("keydown", (e) => {
      if (isTextEntryTarget(e.target)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    const cached = this.images.get(doc.target);
    const stage = todoEl("div", "todo-viewer-stage");
    if (cached === null) stage.append(todoEl("span", "todo-doc-missing", l10n.t("Image not found")));
    else {
      const img = document.createElement("img");
      img.alt = doc.label ?? "";
      img.dataset.image = doc.target;
      if (cached) img.src = cached;
      else this.host.post({ type: "todoImageRequest", name: doc.target });
      stage.append(img);
    }
    const bar = todoEl("div", "todo-viewer-bar");
    const where = todoEl("div", "todo-viewer-where");
    where.append(this.labelEl(item.id, doc, l10n.t("Add a caption"), true), todoEl("span", "todo-viewer-count", `${index + 1} / ${images.length}`));
    const actions = todoEl("div", "todo-viewer-actions");
    actions.append(
      todoButton("todo-text-btn", l10n.t("Open in the editor"), () => this.host.post({ type: "todoOpenDoc", itemId: item.id, docId: doc.id })),
      todoCloseButton(close),
    );
    bar.append(where, actions);
    const nav = todoEl("div", "todo-viewer-nav");
    const step = (text: string, hint: string, key: string, by: number) => {
      const button = todoButton("todo-close todo-viewer-step", text, () => go(by, true), hint);
      button.dataset.step = String(by);
      button.setAttribute("aria-keyshortcuts", key);
      button.disabled = images.length < 2;
      return button;
    };
    nav.append(step(l10n.t("‹ Previous image"), l10n.t("Previous image (←)"), "ArrowLeft", -1), step(l10n.t("Next image ›"), l10n.t("Next image (→)"), "ArrowRight", 1));
    wrap.append(bar, stage, nav);
    queueMicrotask(() => { if (!wrap.contains(document.activeElement)) wrap.focus(); });
    return wrap;
  }

  private noteBody(item: TodoDetailItem): HTMLElement {
    if (this.memoDraft === null) {
      const view = todoEl("div", `todo-note-v${item.userMemo ? "" : " empty"}`, item.userMemo);
      view.tabIndex = 0;
      view.setAttribute("role", "button");
      view.setAttribute("aria-label", l10n.t("Write your memo"));
      const start = () => {
        this.memoDraft = item.userMemo;
        this.render();
      };
      view.addEventListener("click", start);
      view.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          start();
        }
      });
      return view;
    }
    const wrap = todoEl("div", "todo-note-edit");
    const area = todoEl("textarea", "todo-note-in");
    area.value = this.memoDraft;
    area.rows = 4;
    area.maxLength = TODO_USER_MEMO_MAX;
    area.spellcheck = false;
    area.setAttribute("aria-label", l10n.t("Your memo"));
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.memoDraft = null;
      if (save && area.value !== item.userMemo) this.edit({ kind: "update", id: item.id, userMemo: area.value });
      this.render();
      (this.dialog.querySelector(".todo-note-v") as HTMLElement | null)?.focus();
    };
    area.addEventListener("input", () => { this.memoDraft = area.value; });
    area.addEventListener("keydown", (e) => {
      if (isComposingKey(e)) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    area.addEventListener("blur", () => finish(true));
    wrap.append(area);
    queueMicrotask(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
    return wrap;
  }

  private fieldGrid(): { grid: HTMLElement; field: (label: string, ...controls: Node[]) => void } {
    const grid = todoEl("div", "todo-fg");
    const field = (label: string, ...controls: Node[]) => {
      const value = todoEl("span", "todo-fv");
      value.append(...controls);
      grid.append(todoEl("span", "todo-fl", label), value);
    };
    return { grid, field };
  }

  private fieldsBody(item: TodoDetailItem): HTMLElement {
    const { grid, field } = this.fieldGrid();
    field(l10n.t("State"), todoSegment(l10n.t("State"), todoStateOptions(), item.state,
      state => this.edit({ kind: "setState", id: item.id, state })));
    field(l10n.t("Priority"), todoSegment(l10n.t("Priority"), todoPriorityOptions(), item.priority ?? "",
      priority => this.edit({ kind: "update", id: item.id, priority: priority || null })));
    field(l10n.t("Start date"), todoDateInput(l10n.t("Start date"), item.start, start => this.edit({ kind: "update", id: item.id, start })));
    field(l10n.t("Due date"), todoDateInput(l10n.t("Due date"), item.due, due => this.edit({ kind: "update", id: item.id, due })));
    return grid;
  }

  private infoBody(item: TodoDetailItem): HTMLElement {
    const { grid, field } = this.fieldGrid();
    if (item.parentId === null) {
      field(l10n.t("Group"), todoGroupSelect(item.group, this.host.groups(), group => this.edit({ kind: "update", id: item.id, group })));
    } else {
      field(l10n.t("Group"), todoEl("span", "todo-ro", l10n.t("{0} (follows the parent)", todoRootGroup(this.host.items(), item.id) ?? l10n.t("No group"))));
    }
    field(l10n.t("Parent"), todoParentSelect(this.host.items(), id => this.host.numberOf(id), item.parentId, item.id,
      parentId => this.moveUnder(item.id, parentId)));
    const text = (value: string | undefined, save: (next: string | null) => void) => (next: string) => {
      const trimmed = next.trim();
      if (trimmed !== (value ?? "")) save(trimmed || null);
    };
    field(l10n.t("Waiting on"), todoTextField(l10n.t("Waiting on"), item.waiting ?? "", TODO_WAITING_MAX, l10n.t("Whose reply it waits for"), () => {},
      text(item.waiting, waiting => this.edit({ kind: "update", id: item.id, waiting }))));
    field(l10n.t("Repeat"), todoSelect(l10n.t("Repeat"), todoRepeatOptions(), item.repeat ?? "", repeat => this.edit({ kind: "update", id: item.id, repeat: repeat || null })),
      todoEl("span", "todo-mb", l10n.t("A mark only; completing it does not create the next item")));
    field(l10n.t("Estimate (hours)"), todoTextField(l10n.t("Estimate (hours)"), item.estimate ?? "", 7, "", () => {}, text(item.estimate, estimate => {
      if (estimate === null || TODO_ESTIMATE_PATTERN.test(estimate)) this.edit({ kind: "update", id: item.id, estimate });
      else this.host.notify(l10n.t("Enter the estimate as a number of hours, such as 1.5."));
    })));
    field(l10n.t("Tags"), todoTextField(l10n.t("Tags"), item.tags ?? "", TODO_TAGS_MAX, "", () => {},
      text(item.tags, tags => this.edit({ kind: "update", id: item.id, tags }))));
    field(l10n.t("Source"), todoEl("span", "todo-ro", item.by !== "claude" ? l10n.t("Added by you")
      : item.source?.title !== undefined ? l10n.t("Added by Claude in the conversation “{0}”", item.source.title)
        : item.source ? l10n.t("Added by Claude in a conversation") : l10n.t("Added by Claude")));
    for (const [label, value] of this.timeRows(item)) field(label, todoEl("span", "todo-ro", value));
    if (item.parentId === null && item.group) {
      const group = item.group;
      const places = this.host.groupPlaces(group);
      const folders = todoEl("span", "todo-places");
      for (const path of places.folders) {
        folders.append(todoEl("span", "todo-ro", path), todoButton("todo-link", l10n.t("Remove"), () => this.edit({ kind: "groupFolderRemove", name: group, path }), l10n.t("Unbind {0}", path)));
      }
      folders.append(todoTextField(l10n.t("ToDo work folder"), "", 400, "", () => {}, value => {
        if (value.trim()) this.edit({ kind: "groupFolderAdd", name: group, path: value.trim() });
      }));
      field(l10n.t("ToDo work folder"), folders);
      if (places.aliases.length) {
        const words = todoEl("span", "todo-places");
        for (const alias of places.aliases) {
          words.append(todoEl("span", "todo-ro", alias.words), todoButton("todo-link", l10n.t("Remove"), () => this.edit({ kind: "groupAliasRemove", name: group, words: alias.words }), l10n.t("Forget “{0}”", alias.words)));
        }
        field(l10n.t("Words that file into this group"), words);
      }
    }
    return grid;
  }

  private timeRows(item: TodoDetailItem): Array<readonly [string, string]> {
    const created = item.createdAt !== TODO_TIME_UNKNOWN;
    const rows: Array<readonly [string, string]> = created ? [[l10n.t("Created"), formatDateTime(item.createdAt)]] : [];
    if (item.startedAt !== undefined) rows.push([l10n.t("Work started"), formatDateTime(item.startedAt)]);
    if (item.doneAt !== undefined) {
      rows.push([l10n.t("Done"), formatDateTime(item.doneAt)]);
      if (created) rows.push([l10n.t("Lead time"), todoSpan(item.doneAt - item.createdAt)]);
      if (item.startedAt !== undefined) rows.push([l10n.t("Start to done"), todoSpan(item.doneAt - item.startedAt)]);
    }
    const totals = item.totals;
    if (totals) {
      rows.push([l10n.t("Sub-items"), l10n.t("{0}/{1} done", totals.done, totals.kids)]);
      if (totals.firstStartedAt !== undefined) rows.push([l10n.t("First sub-item started"), formatDateTime(totals.firstStartedAt)]);
      if (totals.lastDoneAt !== undefined) rows.push([l10n.t("Last sub-item done"), formatDateTime(totals.lastDoneAt)]);
    }
    const work = this.work;
    if (work) {
      rows.push([l10n.t("Actual work"), todoSpan(work.ms)]);
      if (work.withChildrenMs !== undefined) rows.push([l10n.t("Actual work with sub-items"), todoSpan(work.withChildrenMs)]);
    }
    return rows;
  }

  private deleteLabel(item: TodoDetailItem): string {
    const count = this.descendantCount(item.id);
    return count > 0 ? l10n.t("Delete this item (and {0} sub-items)", count) : l10n.t("Delete this item");
  }

  private descendantCount(id: string): number {
    const items = this.host.items();
    let count = 0;
    const seen = new Set([id]);
    for (let frontier = [id]; frontier.length;) {
      const next = items.filter(entry => entry.parentId !== null && frontier.includes(entry.parentId) && !seen.has(entry.id)).map(entry => entry.id);
      for (const entry of next) seen.add(entry);
      count += next.length;
      frontier = next;
    }
    return count;
  }

  private deleteItem(item: TodoDetailItem): void {
    this.edit({ kind: "delete", id: item.id });
    this.hide();
  }

  private stepSection(key: TodoDetailSection, step: 1 | -1): void {
    const shown = Array.from(this.dialog.querySelectorAll<HTMLElement>("[data-section]")).map(node => node.dataset.section as TodoDetailSection);
    const index = shown.indexOf(key);
    const target = shown[index + step];
    if (index < 0 || target === undefined) return;
    this.moveSection(key, target, step > 0);
  }

  private moveSection(key: TodoDetailSection, reference: TodoDetailSection, after: boolean): void {
    if (key === reference) return;
    const order = this.order.filter(entry => entry !== key);
    order.splice(order.indexOf(reference) + (after ? 1 : 0), 0, key);
    this.setOrder(order);
    (this.dialog.querySelector(`[data-section="${key}"] .todo-ds-h`) as HTMLElement | null)?.focus();
  }

  private setOrder(order: TodoDetailSection[]): void {
    this.dragging = null;
    this.order = order;
    this.host.post({ type: "todoSectionOrder", order });
    this.render();
  }
}
