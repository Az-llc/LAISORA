import { isComposingKey } from "./composing";
import * as l10n from "@vscode/l10n";
import type { TodoEdit } from "../protocol";
import { TODO_GROUP_MAX, TODO_TITLE_MAX, type TodoState } from "../todo-model";
import { formatTodoDay, openTodoMenu, todoCapturedText, todoMarkText, todoRecentMarks, TODO_PRIORITY_LABELS, TODO_STATE_KEYS as STATE_KEYS, TODO_STATE_LABELS, todoButton, todoControlPressed, todoDateEl, todoPlayButton, todoEl as el, todoGuessMark, todoStateIcon, todoStateMenu, todoMenuToggle, todoTalkMark, todoTitleEdit } from "./todo-edit";
import { todoAskNoteEl, todoAskRowEl, type TodoAskActions, type TodoAskRow } from "./todo-asks";
import { TODO_GRIP_CLASS, todoRowPressDrags } from "./todo-drag";
import { localDateKey, type TodoFamilyView, type TodoRowView, type TodoSectionView } from "./todo-rows";

export const todoGroupColor = (color: number | null) => color === null ? "" : `var(--l-todo-group-${color})`;

export interface TodoRowHost {
  openDetail(id: string): void;
  edit(edit: TodoEdit): void;
  toggleCollapsed(id: string): void;
  openConversation(id: string): void;
  render(): void;
  asks?(id: string): readonly TodoAskRow[];
  askNote?(id: string): string | undefined;
  readonly askActions?: TodoAskActions;
  readonly insert?: TodoRowInsert;
  readonly organize?: TodoRowOrganize;
  readonly groups?: TodoRowGroups;
  showDone?(key: string): void;
  claudeSeenAt?(): number;
}

export interface TodoRowGroups {
  toggle(section: TodoSectionView): void;
  rename(group: string): void;
  renaming(): string | null;
  renameDraft(): string | undefined;
  setRenameDraft(text: string): void;
  commitRename(group: string, to: string | null, refocus: boolean): void;
  menu(group: string, anchor: HTMLElement, point?: { x: number; y: number }): void;
  status(section: TodoSectionView): { readonly running: number; readonly waiting: number; readonly unread: number };
}

export interface TodoRowOrganize {
  setState(ids: readonly string[], state: TodoState | "toggle-done"): void;
  step(ids: readonly string[], direction: -1 | 1): void;
  indent(ids: readonly string[], direction: -1 | 1): void;
  remove(ids: readonly string[]): void;
  menu(id: string, ids: readonly string[], anchor: HTMLElement, point?: { x: number; y: number }): void;
  drag(id: string, targets: () => readonly string[], event: PointerEvent): void;
  selectionChanged(): void;
}

export interface TodoRowInsert {
  near(id: string, where: "above" | "below"): void;
  atEnd(group: string | null): void;
  inputRow(depth: number): HTMLElement;
}

const TODO_NEXT_STATE: Record<TodoState, TodoState> = { todo: "doing", doing: "done", done: "todo" };

export class TodoRowRenderer {
  private editingTitle: string | null = null;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  readonly selected = new Set<string>();
  private anchor: string | null = null;

  constructor(private readonly host: TodoRowHost, private readonly container: () => HTMLElement, private readonly focusPrefix = "") {}

  targets(id: string): string[] {
    return this.selected.has(id) && this.selected.size > 1 ? [...this.selected] : [id];
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.syncSelection();
  }

  prune(live: ReadonlySet<string>): void {
    let changed = false;
    for (const id of this.selected) if (!live.has(id)) { this.selected.delete(id); changed = true; }
    if (changed) this.syncSelection();
  }

  private visibleRows(): HTMLElement[] {
    return Array.from(this.container().querySelectorAll<HTMLElement>(".todo-row[data-id]"));
  }

  private focusRow(id: string | undefined): void {
    if (id === undefined) return;
    (this.container().querySelector(`.todo-row[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  }

  private syncSelection(): void {
    for (const node of this.visibleRows()) {
      const on = this.selected.has(node.dataset.id!);
      node.classList.toggle("selected", on);
      if (this.host.organize) node.setAttribute("aria-selected", on ? "true" : "false");
    }
    this.host.organize?.selectionChanged();
  }

  private selectRange(to: string): void {
    const ids = this.visibleRows().map(node => node.dataset.id!);
    const from = ids.indexOf(this.anchor ?? to);
    const end = ids.indexOf(to);
    if (end < 0) return;
    const [a, b] = from < 0 ? [end, end] : [Math.min(from, end), Math.max(from, end)];
    this.selected.clear();
    for (const id of ids.slice(a, b + 1)) this.selected.add(id);
    this.syncSelection();
  }

  private toggleSelected(id: string): void {
    if (!this.selected.delete(id)) this.selected.add(id);
    this.anchor = id;
    this.syncSelection();
  }

  private setState(row: TodoRowView, state: TodoState | "toggle-done"): void {
    const ids = this.targets(row.id);
    const organize = this.host.organize;
    if (organize && ids.length > 1) organize.setState(ids, state);
    else if (state !== "toggle-done" && state !== row.state) this.host.edit({ kind: "setState", id: row.id, state });
  }

  private onRowKey(e: KeyboardEvent, row: TodoRowView, node: HTMLElement): void {
    const organize = this.host.organize;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const rows = this.visibleRows();
    const index = rows.indexOf(node);
    const go = (target: HTMLElement | undefined) => {
      if (!target) return;
      e.preventDefault();
      if (e.shiftKey && organize) {
        this.anchor ??= row.id;
        this.selectRange(target.dataset.id!);
      } else if (!e.shiftKey) {
        this.anchor = target.dataset.id!;
      }
      target.focus();
    };
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey && organize) {
      e.preventDefault();
      organize.step(this.targets(row.id), e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "ArrowUp" && !e.altKey) {
      go(rows[index - 1]);
    } else if (e.key === "ArrowDown" && !e.altKey) {
      go(rows[index + 1]);
    } else if (e.key === "Home" && organize) {
      go(rows[0]);
    } else if (e.key === "End" && organize) {
      go(rows[rows.length - 1]);
    } else if (e.key === "ArrowLeft" && plain) {
      e.preventDefault();
      if (row.collapsible && !row.collapsed) this.host.toggleCollapsed(row.id);
      else this.focusRow(row.parentId ?? undefined);
    } else if (e.key === "ArrowRight" && plain) {
      e.preventDefault();
      if (row.collapsible && row.collapsed) this.host.toggleCollapsed(row.id);
      else if (Number(rows[index + 1]?.dataset.depth) > row.depth) rows[index + 1].focus();
    } else if (e.key === "Tab" && organize && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      organize.indent(this.targets(row.id), e.shiftKey ? -1 : 1);
    } else if (STATE_KEYS[e.key] && plain) {
      e.preventDefault();
      this.setState(row, STATE_KEYS[e.key]);
    } else if (e.key === " " && plain) {
      e.preventDefault();
      if (organize && this.targets(row.id).length > 1) this.setState(row, "toggle-done");
      else {
        const button = node.querySelector<HTMLElement>(".todo-state-btn");
        if (button) todoStateMenu(button, row.state, next => this.setState(row, next));
      }
    } else if (((e.key === "d" || e.key === "D") && plain && organize) || (e.key === "Enter" && e.altKey)) {
      e.preventDefault();
      this.host.openDetail(row.id);
    } else if (e.key === "F2") {
      e.preventDefault();
      this.editTitle(row.id);
    } else if (e.key === "Enter" && plain) {
      e.preventDefault();
      if (row.depth === 0 && !row.context) this.host.openConversation(row.id);
      else this.host.openDetail(row.id);
    } else if ((e.key === "n" || e.key === "N") && plain && this.host.insert) {
      e.preventDefault();
      this.host.insert.near(row.id, "below");
    } else if (e.key === "Delete" && plain && organize) {
      e.preventDefault();
      organize.remove(this.targets(row.id));
    } else if (e.key === "/" && plain && organize) {
      e.preventDefault();
      organize.menu(row.id, this.targets(row.id), node);
    } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey) && !e.altKey && organize) {
      e.preventDefault();
      this.selected.clear();
      for (const other of rows) this.selected.add(other.dataset.id!);
      this.syncSelection();
    } else if (e.key === "Escape" && this.selected.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      this.clearSelection();
    }
  }

  editTitle(id: string): void {
    clearTimeout(this.openTimer);
    this.editingTitle = id;
    this.host.render();
  }

  sectionEl(section: TodoSectionView, headed: boolean): HTMLElement {
    const wrap = el("div", "todo-section");
    wrap.dataset.group = JSON.stringify(section.group);
    if (section.color !== null) wrap.style.setProperty("--todo-gc", todoGroupColor(section.color));
    const folded = this.host.groups !== undefined && section.folded;
    if (headed) wrap.append(this.headingEl(section, folded));
    if (folded) return wrap;
    const list = el("div", "todo-rows");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", section.group ?? l10n.t("ToDo list"));
    const insert = this.host.insert;
    const inline = insert ? section.inline : undefined;
    section.families.forEach((family, index) => {
      if (inline?.row === null && inline.family === index) list.append(insert!.inputRow(0));
      list.append(this.familyEl(family, inline?.row !== null && inline?.family === index ? inline : undefined));
    });
    if (inline?.row === null && inline.family >= section.families.length) list.append(insert!.inputRow(0));
    wrap.append(list);
    return wrap;
  }

  private headingEl(section: TodoSectionView, folded: boolean): HTMLElement {
    const head = el("div", "todo-group");
    head.setAttribute("role", "heading");
    head.setAttribute("aria-level", "3");
    const bar = el("span", "todo-group-bar");
    bar.setAttribute("aria-hidden", "true");
    head.append(bar);
    const groups = this.host.groups;
    const name = section.group ?? l10n.t("No group");
    const count = el("span", "todo-group-count", section.count === 1 ? l10n.t("1 item · {0} open", section.open) : l10n.t("{0} items · {1} open", section.count, section.open));
    if (!groups) {
      head.append(el("span", "todo-group-name", name), count);
      return head;
    }
    const fold = todoButton("todo-group-fold", "", () => groups.toggle(section), folded ? l10n.t("Show the group") : l10n.t("Fold the group"));
    fold.setAttribute("aria-expanded", folded ? "false" : "true");
    fold.setAttribute("aria-label", `${name} — ${fold.title}`);
    fold.dataset.focusKey = this.key("group", section.key);
    head.addEventListener("click", (e) => { if (!todoControlPressed(e.target as HTMLElement)) groups.toggle(section); });
    head.append(fold);
    const group = section.group;
    if (group !== null && groups.renaming() === group) {
      const input = el("input", "todo-group-rename");
      input.type = "text";
      const draft = groups.renameDraft();
      input.value = draft ?? group;
      input.dataset.focusKey = this.key("grouprename", group);
      input.addEventListener("input", () => groups.setRenameDraft(input.value));
      input.maxLength = TODO_GROUP_MAX;
      input.spellcheck = false;
      input.setAttribute("aria-label", l10n.t("Group name"));
      let done = false;
      const finish = (save: boolean, refocus: boolean) => {
        if (done) return;
        done = true;
        groups.commitRename(group, save ? input.value : null, refocus);
      };
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (isComposingKey(e)) return;
        if (e.key === "Enter") { e.preventDefault(); finish(true, true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false, true); }
      });
      input.addEventListener("blur", () => setTimeout(() => { if (input.isConnected) finish(true, false); }, 0));
      head.append(input);
    } else if (group !== null) {
      const label = todoButton("todo-group-name todo-group-name-btn", group, () => groups.rename(group), l10n.t("Press to rename the group"));
      label.dataset.focusKey = this.key("groupname", group);
      head.append(label);
    } else {
      head.append(el("span", "todo-group-name", name));
    }
    if (folded) {
      const status = groups.status(section);
      const parts = [
        status.running > 0 ? l10n.t("{0} working", status.running) : null,
        status.waiting > 0 ? l10n.t("{0} waiting for you", status.waiting) : null,
        status.unread > 0 ? l10n.t("{0} unread", status.unread) : null,
      ].filter((part): part is string => part !== null);
      if (parts.length) head.append(el("span", "todo-group-status", parts.join(" · ")));
    }
    head.append(count);
    if (group !== null) {
      const more = todoMenuToggle("todo-group-more", l10n.t("Group menu"), button => groups.menu(group, button));
      head.append(more);
      head.addEventListener("contextmenu", (e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        e.preventDefault();
        groups.menu(group, more, { x: e.clientX, y: e.clientY });
      });
    }
    return head;
  }

  private familyEl(family: TodoFamilyView, inline?: { readonly row: number | null; readonly depth: number }): HTMLElement {
    const wrap = el("div", `todo-family${family.doing ? " doing" : ""}${family.color !== null ? " grouped" : ""}`);
    wrap.setAttribute("role", "none");
    if (family.color !== null) wrap.style.setProperty("--todo-gc", todoGroupColor(family.color));
    family.rows.forEach((row, index) => {
      if (inline?.row === index) wrap.append(this.host.insert!.inputRow(inline.depth));
      wrap.append(row.depth === 0 ? this.topRowEl(row) : this.subRowEl(row));
      const actions = this.host.askActions;
      if (row.context || !actions) return;
      const note = this.host.askNote?.(row.id);
      if (note !== undefined) wrap.append(todoAskNoteEl(note, row.depth));
      for (const ask of this.host.asks?.(row.id) ?? []) wrap.append(todoAskRowEl(ask, row.depth, actions, (kind, id) => this.key(kind, id)));
    });
    if (inline !== undefined && inline.row !== null && inline.row >= family.rows.length) wrap.append(this.host.insert!.inputRow(inline.depth));
    return wrap;
  }

  private key(kind: string, id: string): string {
    return `${this.focusPrefix}${kind}:${id}`;
  }

  private titleEl(row: TodoRowView): HTMLElement {
    if (this.editingTitle !== row.id) {
      const title = el("span", "todo-title", row.title);
      if (row.captured !== undefined) title.title = todoCapturedText(row.captured);
      title.addEventListener("dblclick", () => this.editTitle(row.id));
      return title;
    }
    const input = el("input", "todo-title-in");
    input.type = "text";
    input.value = row.title;
    input.maxLength = TODO_TITLE_MAX;
    input.spellcheck = false;
    input.setAttribute("aria-label", l10n.t("Title"));
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.editingTitle = null;
      const edit = save ? todoTitleEdit(row, input.value) : null;
      if (edit) this.host.edit(edit);
      this.host.render();
      (this.container().querySelector(`[data-id="${CSS.escape(row.id)}"]`) as HTMLElement | null)?.focus();
    };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (isComposingKey(e)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
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

  private rowShell(row: TodoRowView, kind: "todo-top" | "todo-sub"): HTMLElement {
    const node = el("div", `todo-row ${kind} st-${row.state}${row.context ? " context" : ""}`);
    node.setAttribute("role", "listitem");
    node.setAttribute("aria-level", String(row.depth + 1));
    node.style.setProperty("--todo-depth", String(row.depth));
    if (row.color !== null) node.style.setProperty("--todo-ic", todoGroupColor(row.color));
    node.dataset.id = row.id;
    node.dataset.depth = String(row.depth);
    if (row.parentId !== null) node.dataset.parent = row.parentId;
    node.dataset.focusKey = this.key("row", row.id);
    node.tabIndex = 0;
    const organize = this.host.organize;
    if (organize) {
      node.setAttribute("aria-selected", this.selected.has(row.id) ? "true" : "false");
      node.classList.toggle("selected", this.selected.has(row.id));
    }
    node.addEventListener("click", (e) => {
      if (e.detail > 1 || todoControlPressed(e.target as HTMLElement)) return;
      if (organize && (e.ctrlKey || e.metaKey)) {
        this.toggleSelected(row.id);
        return;
      }
      if (organize && e.shiftKey) {
        this.selectRange(row.id);
        return;
      }
      this.anchor = row.id;
      this.clearSelection();
      clearTimeout(this.openTimer);
      this.openTimer = setTimeout(() => this.host.openDetail(row.id), e.detail === 1 ? 250 : 0);
    });
    node.addEventListener("keydown", (e) => {
      if (e.target === node) this.onRowKey(e, row, node);
    });
    if (organize) {
      node.addEventListener("contextmenu", (e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        e.preventDefault();
        organize.menu(row.id, this.targets(row.id), node, { x: e.clientX, y: e.clientY });
      });
      node.addEventListener("pointerdown", (e) => {
        if (todoRowPressDrags(e.button, e.target as HTMLElement, e.pointerType)) organize.drag(row.id, () => this.targets(row.id), e);
      });
      const grip = el("span", TODO_GRIP_CLASS);
      grip.title = l10n.t("Drag to move (with its sub-items)");
      grip.setAttribute("aria-hidden", "true");
      node.append(grip);
    }
    return node;
  }

  private dueEl(row: TodoRowView): HTMLElement {
    const due = todoDateEl(row, localDateKey(new Date()), "todo-due");
    if (due.childElementCount > 0) {
      due.title = [row.start !== undefined ? l10n.t("Start {0}", formatTodoDay(row.start, "full")) : null, row.due !== undefined ? l10n.t("Due {0}", formatTodoDay(row.due, "full")) : null]
        .filter(Boolean).join("\n");
      if (row.guess?.due) due.append(todoGuessMark(row.guess.due));
    }
    return due;
  }

  private marksEl(row: TodoRowView): HTMLElement[] {
    const marks: HTMLElement[] = [];
    if (row.priority === "p0") {
      const top = el("span", "todo-p0", TODO_PRIORITY_LABELS.p0());
      if (row.guess?.priority) top.append(todoGuessMark(row.guess.priority));
      marks.push(top);
    } else if (row.guess?.priority && row.priority) {
      const mark = el("span", "todo-prio", row.priority.toUpperCase());
      mark.append(todoGuessMark(row.guess.priority));
      marks.push(mark);
    }
    const recent = todoRecentMarks(row.claude ?? [], this.host.claudeSeenAt?.() ?? 0, Date.now());
    if (recent.length) {
      const dot = todoButton("todo-claude-dot", "", () => openTodoMenu(dot, recent.map(info => ({ label: todoMarkText(info), value: l10n.t("Take back"),
        run: () => this.host.edit({ kind: "revertClaude", changeIds: [...info.ids] }) })), l10n.t("Changed by Claude")));
      dot.title = recent.map(todoMarkText).join("\n");
      dot.setAttribute("aria-label", l10n.t("Changed by Claude: {0}", dot.title));
      marks.push(dot);
    }
    if (row.held) {
      const held = el("span", "todo-held", l10n.t("Done with its parent"));
      held.title = l10n.t("Its parent was marked done, so this is counted as finished. It keeps its own state: {0}", TODO_STATE_LABELS[row.state]());
      marks.push(held);
    }
    return marks;
  }

  private stateEl(row: TodoRowView): HTMLElement {
    const state = todoButton("todo-state todo-state-btn", "", () => this.setState(row, TODO_NEXT_STATE[row.state]));
    state.dataset.focusKey = this.key("state", row.id);
    state.setAttribute("aria-label", l10n.t("State: {0} (press to change)", TODO_STATE_LABELS[row.state]()));
    state.title = state.getAttribute("aria-label")!;
    state.append(todoStateIcon(row.state));
    return state;
  }

  private twistyEl(row: TodoRowView): HTMLElement {
    if (!row.collapsible) return el("span", "todo-twisty-gap");
    const twisty = el("button", "todo-twisty");
    twisty.type = "button";
    twisty.dataset.focusKey = this.key("twisty", row.id);
    twisty.setAttribute("aria-expanded", row.collapsed ? "false" : "true");
    const label = row.collapsed ? l10n.t("Show sub-items") : l10n.t("Hide sub-items");
    twisty.setAttribute("aria-label", label);
    twisty.title = label;
    twisty.addEventListener("click", () => this.host.toggleCollapsed(row.id));
    return twisty;
  }

  private waiting(row: TodoRowView): boolean {
    return !row.context && (this.host.asks?.(row.id) ?? []).some(ask => ask.stale === null);
  }

  private talkEl(row: TodoRowView, dotOnly = false): HTMLElement | null {
    return todoTalkMark(row.talk, this.waiting(row), dotOnly);
  }

  private playEl(row: TodoRowView): HTMLButtonElement {
    const button = todoPlayButton(row.talk, () => this.host.openConversation(row.id));
    button.dataset.focusKey = this.key("play", row.id);
    return button;
  }

  private topRowEl(row: TodoRowView): HTMLElement {
    const node = this.rowShell(row, "todo-top");
    const body = el("div", "todo-body");
    const line = el("div", "todo-line");
    const title = el("span", "todo-title-wrap");
    title.append(this.titleEl(row), ...this.marksEl(row));
    line.append(title, this.dueEl(row), this.stateEl(row));
    body.append(line);
    const meta = el("div", "todo-meta");
    const merged = row.children !== undefined && !this.waiting(row);
    if (row.children) {
      meta.append(this.twistyEl(row));
      const dot = merged ? this.talkEl(row, true) : null;
      if (dot) meta.append(dot);
      meta.append(el("span", "todo-kids", l10n.t("Sub-items {0}/{1}", row.children.done, row.children.total)));
    }
    const talk = merged ? null : this.talkEl(row);
    if (talk) meta.append(talk);
    if (!row.context) meta.append(this.playEl(row));
    if (meta.childElementCount > 0) body.append(meta);
    node.append(el("span", "todo-num", row.number), body);
    return node;
  }

  private subRowEl(row: TodoRowView): HTMLElement {
    const node = this.rowShell(row, "todo-sub");
    const title = el("span", "todo-sub-title");
    const text = el("span", "todo-sub-text");
    text.append(this.titleEl(row), ...this.marksEl(row));
    const talk = this.talkEl(row);
    if (talk) text.append(talk);
    title.append(text);
    node.append(el("span", "todo-num", row.number), title, this.dueEl(row), this.twistyEl(row), this.stateEl(row));
    return node;
  }
}
