import { isComposingKey } from "./composing";
import * as l10n from "@vscode/l10n";
import { TODO_USER_MEMO_MAX, type TodoEdit, type TodoListItem } from "../protocol";
import { TODO_ESTIMATE_PATTERN, TODO_TAGS_MAX, TODO_TITLE_MAX, TODO_WAITING_MAX, type TodoPriority, type TodoState } from "../todo-model";
import {
  todoButton,
  todoCloseButton,
  todoDateInput,
  todoEl as el,
  todoGroupSelect,
  todoNewTitlePlaceholder,
  todoOverlayTop,
  todoParentSelect,
  todoPriorityOptions,
  todoRepeatOptions,
  todoSegment,
  todoSelect,
  todoStateOptions,
  todoTextField,
} from "./todo-edit";
import { todoInsertPosition, type TodoInsertSlot } from "./todo-rows";

export interface TodoSheetDraft {
  title: string;
  parentId: string | null;
  group: string | null;
  before: string | null;
  state: TodoState;
  priority: TodoPriority | "";
  start: string;
  due: string;
  userMemo: string;
  waiting: string;
  repeat: string;
  estimate: string;
  tags: string;
}

export interface TodoSheetHost {
  items(): readonly TodoListItem[];
  groups(): readonly string[];
  numberOf(id: string): string;
  send(edit: TodoEdit, done: (ok: boolean) => void): void;
  closed(draft: TodoSheetDraft | null): void;
}

export function blankTodoSheetDraft(seed: Partial<TodoSheetDraft> = {}): TodoSheetDraft {
  return { title: "", parentId: null, group: null, before: null, state: "todo", priority: "", start: "", due: "", userMemo: "",
    waiting: "", repeat: "", estimate: "", tags: "", ...seed };
}

export function todoSheetEdit(draft: TodoSheetDraft, items: readonly TodoListItem[]): Extract<TodoEdit, { kind: "add" }> | null {
  const title = draft.title.trim();
  if (!title) return null;
  const parentId = draft.parentId !== null && items.some(item => item.id === draft.parentId) ? draft.parentId : null;
  const group = parentId === null ? draft.group : null;
  const slot: TodoInsertSlot = { parentId, group, before: draft.before };
  const position = todoInsertPosition(items, slot);
  const state = draft.state;
  const priority = draft.priority || undefined;
  const due = draft.due || undefined;
  return {
    kind: "add", parentId, title,
    ...(group ? { group } : {}), ...(due ? { due } : {}), ...(draft.start ? { start: draft.start } : {}),
    ...(priority ? { priority } : {}), ...(state !== "todo" ? { state } : {}),
    ...(draft.userMemo.trim() ? { userMemo: draft.userMemo } : {}), ...(position !== undefined ? { position } : {}),
    ...(draft.waiting.trim() ? { waiting: draft.waiting.trim().slice(0, TODO_WAITING_MAX) } : {}), ...(draft.repeat ? { repeat: draft.repeat } : {}),
    ...(TODO_ESTIMATE_PATTERN.test(draft.estimate.trim()) ? { estimate: draft.estimate.trim() } : {}),
    ...(draft.tags.trim() ? { tags: draft.tags.trim().slice(0, TODO_TAGS_MAX) } : {}),
  };
}

export class TodoAddSheet {
  readonly root: HTMLElement;
  private draft: TodoSheetDraft | null = null;
  private keep = false;
  private added: string[] = [];
  private pending = false;

  constructor(private readonly host: TodoSheetHost) {
    this.root = el("aside", "todo-sheet");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", l10n.t("Add an item"));
    this.root.hidden = true;
    this.root.addEventListener("keydown", (e) => this.onKey(e));
  }

  open(draft: TodoSheetDraft): void {
    this.draft = draft;
    this.added = [];
    this.pending = false;
    this.root.hidden = false;
    this.root.style.top = `${todoOverlayTop()}px`;
    this.render();
    this.focusTitle();
  }

  close(cancelled: boolean): void {
    const draft = this.draft;
    if (!draft) return;
    this.draft = null;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.host.closed(cancelled && draft.title.trim() ? draft : null);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible || this.draft === null;
  }

  private focusTitle(): void {
    const input = this.root.querySelector<HTMLInputElement>(".todo-sheet-title");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  private onKey(e: KeyboardEvent): void {
    if (isComposingKey(e)) return;
    const target = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || target.matches("input:not([type=checkbox])"))) {
      e.preventDefault();
      this.submit();
    }
  }

  private submit(): void {
    const draft = this.draft;
    if (!draft || this.pending) return;
    const edit = todoSheetEdit(draft, this.host.items());
    if (!edit) return;
    this.pending = true;
    this.host.send(edit, ok => {
      this.pending = false;
      if (!ok || this.draft !== draft) return;
      if (!this.keep) {
        this.close(false);
        return;
      }
      this.added = [...this.added, edit.title];
      draft.title = "";
      this.render();
      this.focusTitle();
    });
  }

  private render(): void {
    const draft = this.draft;
    if (!draft) return;
    const focused = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.sheetKey : undefined;
    const rerender = () => this.render();
    const scroll = el("div", "todo-sheet-scroll");
    const head = el("header", "todo-sheet-head");
    const heading = el("h2", "todo-where todo-sheet-heading");
    heading.append(el("span", "todo-where-up", `${l10n.t("Add")} ›`), ` ${l10n.t("New item")}`);
    head.append(heading, todoCloseButton(() => this.close(true)));

    const titleLabel = el("label", "todo-sheet-field");
    const titleCaption = el("span", "todo-fl", l10n.t("Title"));
    const title = el("input", "todo-sheet-title");
    title.type = "text";
    title.value = draft.title;
    title.maxLength = TODO_TITLE_MAX;
    title.spellcheck = false;
    title.autocomplete = "off";
    title.placeholder = todoNewTitlePlaceholder();
    title.dataset.sheetKey = "title";
    title.addEventListener("input", () => {
      draft.title = title.value;
      save.disabled = !title.value.trim();
    });
    titleLabel.append(titleCaption, title);
    scroll.append(titleLabel, this.fields(draft, rerender));
    if (this.added.length) {
      const list = el("div", "todo-sheet-added");
      list.append(el("span", "todo-fl", l10n.t("Added in a row: {0}", this.added.length)));
      const ol = el("ol", "");
      for (const entry of this.added) ol.append(el("li", "", entry));
      list.append(ol);
      scroll.append(list);
    }

    const foot = el("div", "todo-sheet-foot");
    const save = todoButton("todo-sheet-btn primary", l10n.t("Add"), () => this.submit(), l10n.t("Add (Enter)"));
    save.disabled = !draft.title.trim();
    const keepLabel = el("label", "todo-sheet-keep");
    const keep = el("input", "");
    keep.type = "checkbox";
    keep.checked = this.keep;
    keep.dataset.sheetKey = "keep";
    keep.addEventListener("change", () => { this.keep = keep.checked; });
    keepLabel.append(keep, document.createTextNode(l10n.t("Keep adding")));
    foot.append(save, keepLabel);
    this.root.replaceChildren(head, scroll, foot);
    if (focused) this.root.querySelector<HTMLElement>(`[data-sheet-key="${CSS.escape(focused)}"]`)?.focus();
  }

  private fields(draft: TodoSheetDraft, rerender: () => void): HTMLElement {
    const grid = el("div", "todo-fg todo-sheet-fields");
    const field = (label: string, key: string, ...controls: HTMLElement[]) => {
      const value = el("span", "todo-fv");
      controls[0].dataset.sheetKey = key;
      value.append(...controls);
      grid.append(el("span", "todo-fl", label), value);
    };
    const items = this.host.items();
    field(l10n.t("State"), "state", todoSegment(l10n.t("State"), todoStateOptions(), draft.state, state => { draft.state = state; rerender(); }));
    field(l10n.t("Priority"), "priority", todoSegment(l10n.t("Priority"), todoPriorityOptions(), draft.priority, priority => { draft.priority = priority; rerender(); }));
    field(l10n.t("Start date"), "start", todoDateInput(l10n.t("Start date"), draft.start || undefined, start => { draft.start = start ?? ""; rerender(); }));
    field(l10n.t("Due date"), "due", todoDateInput(l10n.t("Due date"), draft.due || undefined, due => { draft.due = due ?? ""; rerender(); }));
    if (draft.parentId === null) {
      field(l10n.t("Group"), "group", todoGroupSelect(draft.group ?? undefined, this.host.groups(), group => { if (draft.group !== group) draft.before = null; draft.group = group; rerender(); }));
    } else {
      field(l10n.t("Group"), "group", el("span", "todo-ro", l10n.t("Follows the parent")));
    }
    field(l10n.t("Parent"), "parent", todoParentSelect(items, id => this.host.numberOf(id), draft.parentId, null, parentId => {
      draft.parentId = parentId;
      draft.before = null;
      rerender();
    }));
    const memo = el("textarea", "todo-sheet-memo");
    memo.rows = 3;
    memo.maxLength = TODO_USER_MEMO_MAX;
    memo.value = draft.userMemo;
    memo.spellcheck = false;
    memo.setAttribute("aria-label", l10n.t("Your memo"));
    memo.addEventListener("input", () => { draft.userMemo = memo.value; });
    field(l10n.t("Waiting on"), "waiting", todoTextField(l10n.t("Waiting on"), draft.waiting, TODO_WAITING_MAX, l10n.t("Whose reply it waits for"), value => { draft.waiting = value; }));
    field(l10n.t("Repeat"), "repeat", todoSelect(l10n.t("Repeat"), todoRepeatOptions(), draft.repeat, value => { draft.repeat = value; }));
    field(l10n.t("Estimate (hours)"), "estimate", todoTextField(l10n.t("Estimate (hours)"), draft.estimate, 7, "", value => { draft.estimate = value; }));
    field(l10n.t("Tags"), "tags", todoTextField(l10n.t("Tags"), draft.tags, TODO_TAGS_MAX, "", value => { draft.tags = value; }));
    field(l10n.t("Your memo"), "memo", memo);
    return grid;
  }
}
