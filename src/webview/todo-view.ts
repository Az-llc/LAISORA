import { isComposingKey } from "./composing";
import * as l10n from "@vscode/l10n";
import { CLOSE_GLYPH } from "./close-button";
import type { TodoAskSourceMessageEnvelope, TodoBatchRevert, TodoChangeView, TodoDeletedView, TodoEdit, TodoListItem, TodoLogMessage, TodoLogView, TodoSessionLinkView, TodoSnapshotMessage, TodoTabItem, TodoTemplateView, WebviewToHost } from "../protocol";
import { TODO_GROUP_COLOR_COUNT, TODO_PRIORITIES, TODO_STATES, TODO_TEMPLATE_NAME_MAX, TODO_TITLE_MAX, todoFinishedIds, todoNameKey, type TodoBatchStep, type TodoState } from "../todo-model";
import type { TodoApp } from "./todo-app";
import type { AskIdentity } from "./you-items";
import { TodoAskBoard, type TodoAskActions, type TodoAskHost, type TodoAskRow } from "./todo-asks";
import {
  formatTodoDay,
  openTodoMenu,
  TODO_PRIORITY_LABELS,
  TODO_STATE_LABELS,
  todoButton,
  TODO_NOTICE_MS,
  todoClearNotice,
  todoCloseButton,
  todoFillNotice,
  todoPlayText,
  todoClaudeChangesView,
  todoDeletedView,
  todoEl as el,
  todoMenuToggle,
  todoNewTitlePlaceholder,
  todoNextExpiry,
  todoRecentSince,
  todoRevertUnit,
  type TodoMenuEntry,
} from "./todo-edit";
import { todoGroupColor as groupColor, TodoRowRenderer, type TodoRowGroups, type TodoRowInsert, type TodoRowOrganize } from "./todo-row-view";
import { startTodoDrag } from "./todo-drag";
import { todoGroupSteps, todoIndentSlot, todoMoveSteps, todoSelectionRoots, todoStateSteps, todoStepSlot, type TodoDrop } from "./todo-organize";
import {
  deriveTodoList,
  localDateKey,
  msUntilNextLocalDay,
  TODO_DUE_FILTERS,
  todoDueCounts,
  todoDueFilterShown,
  todoFreshItems,
  todoInsertPosition,
  todoNewlyDone,
  todoOpenCount,
  todoRootGroup,
  todoSectionKey,
  todoSiblingKey,
  todoSlotIndent,
  todoSlotNear,
  todoUniqueGroupName,
  type TodoDueFilter,
  type TodoInsertSlot,
} from "./todo-rows";
import { parseTodoDate, todoDatePresets } from "./todo-quick";
import { blankTodoSheetDraft, TodoAddSheet, type TodoSheetDraft } from "./todo-sheet";
import { MARKS } from "./marks";

export interface TodoViewState {
  readonly shown?: boolean;
  readonly group?: string | null;
  readonly due?: TodoDueFilter;
  readonly collapsed?: readonly string[];
  readonly foldDone?: boolean;
  readonly foldedGroups?: readonly string[];
  readonly askOnly?: boolean;
  readonly fresh?: readonly string[];
  readonly splitDeclined?: readonly string[];
  readonly historySeenAt?: number;
}

export interface TodoAttention {
  readonly running: readonly string[];
  readonly waiting: readonly string[];
  readonly waitingCount: number;
}

const TODO_UNDO_NOTICE_MS = 8000;
const TODO_FLASH_MS = 2400;
const TODO_EXPIRY_SLACK_MS = 1000;

const DUE_LABELS: Record<TodoDueFilter, () => string> = {
  all: () => l10n.t("All"),
  today: () => l10n.t("Today"),
  tomorrow: () => l10n.t("Tomorrow"),
  week: () => l10n.t("This week"),
  overdue: () => l10n.t("Overdue"),
};

const DUE_HINTS: Partial<Record<TodoDueFilter, () => string>> = {
  today: () => l10n.t("Due or starting today"),
  tomorrow: () => l10n.t("Due or starting tomorrow"),
  week: () => l10n.t("Due or starting from today through this Sunday"),
  overdue: () => l10n.t("Past the due date and not done"),
};

function readSavedState(saved: unknown): Required<Omit<TodoViewState, "shown">> & { shown: boolean } {
  const value = typeof saved === "object" && saved !== null ? saved as Record<string, unknown> : {};
  const strings = (entry: unknown) => Array.isArray(entry) ? entry.filter((id): id is string => typeof id === "string") : [];
  return {
    shown: value.shown === true,
    group: typeof value.group === "string" ? value.group : null,
    due: (TODO_DUE_FILTERS as readonly unknown[]).includes(value.due) ? value.due as TodoDueFilter : "all",
    collapsed: strings(value.collapsed),
    foldDone: value.foldDone !== false,
    foldedGroups: strings(value.foldedGroups),
    askOnly: value.askOnly === true,
    fresh: strings(value.fresh),
    splitDeclined: strings(value.splitDeclined),
    historySeenAt: typeof value.historySeenAt === "number" && Number.isFinite(value.historySeenAt) ? value.historySeenAt : 0,
  };
}

function focusKeyOf(node: Element | null): string | undefined {
  return (node?.closest("[data-focus-key]") as HTMLElement | null)?.dataset.focusKey;
}

export const TODO_TAB_LABEL = "ToDo";

export class TodoTab {
  readonly tabBtn: HTMLDivElement;
  readonly pane: HTMLElement;
  private readonly filterBtn: HTMLButtonElement;
  private readonly filterDot: HTMLElement;
  private readonly filterLabel: HTMLElement;
  private readonly menuEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private itemsNow: readonly TodoListItem[] = [];
  private tabItemsNow: readonly TodoTabItem[] = [];
  private deletedTabsNow = new Set<string>();
  private sessionsNow = new Map<string, TodoSessionLinkView>();
  private readonly splitDeclinedNow: Set<string>;
  private colors = new Map<string, number>();
  private groupFolders = new Map<string, readonly string[]>();
  private groupAliases = new Map<string, readonly { readonly words: string; readonly parentId?: string }[]>();
  private readonly listeners = new Set<() => void>();
  private seq = -1;
  private unreadable = false;
  private enabledNow = false;
  private shownNow = false;
  private group: string | null;
  private due: TodoDueFilter;
  private readonly collapsed: Set<string>;
  private readonly restoreShown: boolean;
  private restoredOnce = false;
  private midnightTimer: ReturnType<typeof setTimeout> | undefined;
  private revision = -1;
  private logRevision = -1;
  private readonly noticeEl: HTMLElement;
  private mode: "list" | TodoLogView = "list";
  private historySeenAt = 0;
  private readonly historyBtn: HTMLButtonElement;
  private readonly historyCloseBtn: HTMLButtonElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly whereEl: HTMLElement;
  private readonly searchRowEl: HTMLElement;
  private readonly historyTabsEl: HTMLElement;
  private askCount = 0;
  private query = "";
  private searchLogs: { claude?: readonly TodoChangeView[]; deleted?: readonly TodoDeletedView[] } = {};
  private readonly searchEl = el("div", "hist-search todo-search");
  private readonly searchInput = el("input", "todo-search-input");
  private log: { view: "claude"; changes: readonly TodoChangeView[]; batches: readonly TodoBatchRevert[] } | { view: "deleted"; items: readonly TodoDeletedView[] } | null = null;
  private claudeRecent: readonly number[] = [];
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly rows: TodoRowRenderer;
  private numbers = new Map<string, string>();
  private rowColors = new Map<string, number | null>();
  private readonly askBoard: TodoAskBoard;
  private askRows = new Map<string, TodoAskRow[]>();
  private askUnreadable = new Set<string>();
  private readonly youCountEl: HTMLElement;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sheet: TodoAddSheet;
  private readonly draftEl: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly chipsEl: HTMLElement;
  private actionTimer: ReturnType<typeof setTimeout> | undefined;
  private dragging = false;
  private closedDraft: TodoSheetDraft | null = null;
  private inline: (TodoInsertSlot & { text: string }) | null = null;
  private selectedRow: string | null = null;
  private foldDone: boolean;
  private readonly openDone = new Set<string>();
  private readonly keepDone = new Set<string>();
  private readonly foldedGroups: Set<string>;
  private askOnly: boolean;
  private asking = new Set<string>();
  private staleRows: TodoAskRow[] = [];
  private readonly fresh: Set<string>;
  private flash = new Set<string>();
  private previousItems: readonly TodoListItem[] | null = null;
  private renamingGroup: string | null = null;
  private renameDraft: string | undefined;
  private pendingFocus: { readonly key: string; readonly group: string } | null = null;
  private templates: readonly TodoTemplateView[] = [];
  private readonly tabCountEl: HTMLElement;
  private readonly tabFreshEl: HTMLElement;
  private readonly staleBtn: HTMLButtonElement;
  private readonly foldBtn: HTMLButtonElement;
  readonly askActions: TodoAskActions = { answer: row => this.askBoard.answer(row), done: row => this.askBoard.done(row) };
  private readonly closeMenuOutside = (event: Event) => {
    if (!this.menuEl.contains(event.target as Node) && !this.filterBtn.contains(event.target as Node)) this.closeMenu(false);
  };

  constructor(saved: unknown, private readonly hooks: { activate(): void; changed(): void; post(message: WebviewToHost): void; asks: Omit<TodoAskHost, "post" | "notice">; unreadOfTab(tabId: string): number }, private readonly app: TodoApp) {
    this.askBoard = new TodoAskBoard({ ...hooks.asks, post: message => hooks.post(message), notice: text => this.app.notify(text) }, () => this.asksChanged());
    const state = readSavedState(saved);
    this.group = state.group;
    this.due = state.due;
    this.collapsed = new Set(state.collapsed);
    this.restoreShown = state.shown;
    this.foldDone = state.foldDone;
    this.foldedGroups = new Set(state.foldedGroups);
    this.askOnly = state.askOnly;
    this.fresh = new Set(state.fresh);
    this.splitDeclinedNow = new Set(state.splitDeclined);
    this.historySeenAt = state.historySeenAt;

    this.tabBtn = el("div", "tab tab-todo", TODO_TAB_LABEL);
    this.tabCountEl = el("span", "tab-todo-count");
    this.tabFreshEl = el("span", "tab-todo-fresh");
    this.tabFreshEl.hidden = true;
    const tabIcon = el("span", "l-icon l-icon-checklist tab-todo-icon");
    tabIcon.setAttribute("aria-hidden", "true");
    this.tabBtn.prepend(tabIcon);
    this.tabBtn.append(this.tabCountEl, this.tabFreshEl);
    this.tabBtn.setAttribute("role", "tab");
    this.tabBtn.setAttribute("aria-selected", "false");
    this.tabBtn.setAttribute("aria-controls", "todo-pane");
    this.tabBtn.id = "todo-tab";
    this.tabBtn.tabIndex = 0;
    this.tabBtn.title = l10n.t("ToDo list");
    this.tabBtn.addEventListener("click", () => this.hooks.activate());
    this.tabBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.hooks.activate();
      }
    });

    this.pane = el("section", "todo-pane");
    this.pane.id = "todo-pane";
    this.pane.setAttribute("role", "tabpanel");
    this.pane.setAttribute("aria-labelledby", "todo-tab");
    this.pane.setAttribute("aria-live", "off");
    this.pane.tabIndex = -1;
    const head = el("header", "todo-head");
    this.whereEl = el("h2", "todo-where");
    this.filterBtn = el("button", "todo-filter-btn");
    this.filterBtn.type = "button";
    this.filterBtn.dataset.focusKey = "filter";
    this.filterBtn.setAttribute("aria-haspopup", "menu");
    this.filterBtn.setAttribute("aria-expanded", "false");
    this.filterDot = el("span", "todo-dot");
    this.filterDot.setAttribute("aria-hidden", "true");
    this.filterLabel = el("span", "todo-filter-label");
    const caret = el("span", "todo-caret", MARKS.dropdown);
    caret.setAttribute("aria-hidden", "true");
    this.filterBtn.append(this.filterDot, this.filterLabel, caret);
    this.filterBtn.addEventListener("click", () => this.menuOpen() ? this.closeMenu(true) : this.openMenu());
    this.filterBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !this.menuOpen()) { e.preventDefault(); this.openMenu(); }
    });
    this.menuEl = el("div", "todo-menu");
    this.menuEl.setAttribute("role", "menu");
    this.menuEl.setAttribute("aria-label", l10n.t("Filter"));
    this.menuEl.hidden = true;
    this.menuEl.addEventListener("keydown", (e) => this.onMenuKey(e));
    this.youCountEl = todoButton("todo-you-count", "", () => this.setAskOnly(!this.askOnly));
    this.youCountEl.setAttribute("aria-pressed", "false");
    this.youCountEl.dataset.focusKey = "asks";
    this.youCountEl.hidden = true;
    this.staleBtn = todoButton("todo-link todo-stale-all", "", () => {
      for (const row of this.staleRows) this.askBoard.done(row);
    }, l10n.t("Mark every “probably not needed” question as done"));
    this.staleBtn.hidden = true;
    this.foldBtn = todoButton("todo-chip todo-done-toggle", "", () => this.setFoldDone(!this.foldDone));
    this.foldBtn.dataset.focusKey = "fold";
    this.historyBtn = todoButton("todo-history-btn", "", () => this.setMode("claude"));
    this.historyBtn.dataset.focusKey = "history";
    this.historyCloseBtn = todoCloseButton(() => this.setMode("list"));
    this.historyCloseBtn.dataset.focusKey = "history";
    this.historyCloseBtn.hidden = true;
    this.historyTabsEl = el("div", "todo-history-tabs");
    this.historyTabsEl.setAttribute("role", "tablist");
    this.historyTabsEl.setAttribute("aria-label", l10n.t("History"));
    const addBtn = todoMenuToggle("todo-add-btn", l10n.t("Add an item"), button => openTodoMenu(button, [
      { label: l10n.t("New task"), run: () => this.openSheet(blankTodoSheetDraft({ group: this.defaultGroup() })) },
      { label: l10n.t("New group"), run: () => this.createGroup() },
    ], l10n.t("Add an item")), "＋");
    addBtn.dataset.focusKey = "add";
    this.addBtn = addBtn;
    const actions = el("div", "todo-actions");
    actions.append(this.youCountEl, addBtn, this.historyBtn, this.historyCloseBtn);
    this.noticeEl = el("div", "todo-notice");
    this.noticeEl.setAttribute("role", "status");
    this.noticeEl.hidden = true;
    this.draftEl = el("div", "todo-notice todo-draft");
    this.draftEl.setAttribute("role", "status");
    this.draftEl.hidden = true;
    this.selectionEl = el("div", "todo-selbar");
    this.selectionEl.setAttribute("role", "toolbar");
    this.selectionEl.setAttribute("aria-label", l10n.t("Selected items"));
    this.selectionEl.hidden = true;
    this.sheet = new TodoAddSheet({
      items: () => this.itemsNow,
      groups: () => [...this.colors.keys()],
      numberOf: id => this.numberOf(id),
      send: (edit, done) => this.app.edits.send(edit, done),
      closed: draft => this.sheetClosed(draft),
    });
    head.append(this.whereEl, actions);
    this.chipsEl = el("div", "todo-chips");
    this.searchRowEl = el("div", "todo-searchrow");
    const headWrap = el("div", "todo-headwrap");
    this.buildSearch();
    headWrap.append(head, this.menuEl, this.chipsEl, this.searchRowEl, this.historyTabsEl, this.selectionEl);
    this.listEl = el("div", "todo-list");
    this.rows = new TodoRowRenderer({
      openDetail: id => { this.openDetail(id); },
      edit: edit => this.edit(edit),
      toggleCollapsed: id => this.toggleCollapsed(id),
      openConversation: id => this.openConversation(id, false),
      render: () => this.render(),
      claudeSeenAt: () => this.historySeenAt,
      asks: id => this.asks(id),
      askNote: id => this.askNote(id),
      askActions: this.askActions,
      insert: this.insertActions,
      organize: this.organizeActions,
      groups: this.groupActions,
      showDone: key => { this.openDone.add(key); this.render(); },
    }, () => this.listEl);
    this.listEl.addEventListener("focusin", (e) => {
      const id = ((e.target as HTMLElement).closest("[data-id]") as HTMLElement | null)?.dataset.id;
      if (id !== undefined) this.selectedRow = id;
    });
    this.pane.append(headWrap, this.noticeEl, this.draftEl, this.listEl);
    this.pane.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || this.mode === "list" || isComposingKey(e)) return;
      e.preventDefault();
      this.setMode("list");
      this.focusByKey("history");
    });
    document.body.append(this.sheet.root);
    this.app.onNotice(notice => this.showNotice(notice));
    this.app.extras = { waiting: id => this.asking.has(id), groups: () => [...this.colors.keys()], groupPlaces: group => ({ folders: this.groupFolders.get(group) ?? [], aliases: this.groupAliases.get(group) ?? [] }) };
  }

  get items(): readonly TodoListItem[] {
    return this.itemsNow;
  }

  get groupColors(): ReadonlyMap<string, number> {
    return this.colors;
  }

  itemOfTab(tabId: string | null): string | undefined {
    return this.tabItem(tabId)?.itemId;
  }

  tabItem(tabId: string | null): TodoTabItem | undefined {
    return tabId === null ? undefined : this.tabItemsNow.find(entry => entry.tabId === tabId && this.itemsNow.some(item => item.id === entry.itemId));
  }

  tabsOfItem(itemId: string): string[] {
    return this.tabItemsNow.filter(entry => entry.itemId === itemId).map(entry => entry.tabId);
  }

  isDeletedTab(tabId: string): boolean {
    return this.deletedTabsNow.has(tabId);
  }

  sessionLink(sessionId: string): TodoSessionLinkView | undefined {
    return this.sessionsNow.get(sessionId);
  }

  groupColorOf(name: string | undefined): number | null {
    return name === undefined ? null : this.colors.get(name) ?? null;
  }

  splitDeclined(itemId: string): boolean {
    return this.splitDeclinedNow.has(itemId);
  }

  declineSplit(itemId: string): void {
    this.splitDeclinedNow.add(itemId);
    this.hooks.changed();
    for (const listener of this.listeners) listener();
  }

  attention(scope: ReadonlySet<string> | null): TodoAttention {
    const finished = todoFinishedIds(this.itemsNow);
    const open = this.itemsNow.filter(item => !finished.has(item.id) && (scope === null || scope.has(item.id)));
    const { byItem, count } = this.askBoard.rows(new Set(open.map(item => item.id)), Date.now());
    const waiting = new Set([...byItem.values()].flat().filter(row => row.stale === null).map(row => row.itemId));
    return { running: open.filter(item => item.talk === "running").map(item => item.id), waiting: open.filter(item => waiting.has(item.id)).map(item => item.id), waitingCount: count };
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  edit(edit: TodoEdit): void {
    this.app.edits.send(edit);
  }

  openConversation(itemId: string, fresh: boolean): void {
    this.app.openConversation(itemId, fresh);
  }

  numberOf(id: string): string {
    return this.numbers.get(id) ?? "";
  }

  colorOf(id: string): string {
    return groupColor(this.rowColors.get(id) ?? null);
  }

  asks(id: string): readonly TodoAskRow[] {
    return this.askRows.get(id) ?? [];
  }

  askNote(id: string): string | undefined {
    return this.askUnreadable.has(id) ? l10n.t("Could not read this item's conversation, so its questions are not shown.") : undefined;
  }

  noteTabDismissal(tabId: string, identity: AskIdentity): void {
    if (this.enabledNow) this.askBoard.noteTabDismissal(tabId, identity);
  }

  receiveAskSource(message: TodoAskSourceMessageEnvelope): void {
    if (this.enabledNow) this.askBoard.receive(message);
  }

  syncAskTabs(): void {
    if (this.enabledNow) this.askBoard.syncTabs();
  }

  private asksChanged(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    if (!this.enabledNow) return;
    const finished = todoFinishedIds(this.itemsNow);
    const { byItem, count, nextStaleAt, unreadable } = this.askBoard.rows(new Set(this.itemsNow.filter(item => !finished.has(item.id)).map(item => item.id)), Date.now());
    this.askUnreadable = unreadable;
    if (nextStaleAt !== null) this.staleTimer = setTimeout(() => this.asksChanged(), Math.min(Math.max(nextStaleAt - Date.now(), 0) + 1000, 2 ** 31 - 1));
    this.askRows = byItem;
    const rows = [...byItem.values()].flat();
    this.asking = new Set(rows.filter(row => row.stale === null).map(row => row.itemId));
    this.staleRows = rows.filter(row => row.stale !== null && !row.answerOnly && (row.origin.kind === "tab" || row.message !== undefined));
    if (this.askOnly && count === 0) this.askOnly = false;
    this.askCount = count;
    this.youCountEl.replaceChildren(document.createTextNode(l10n.t("Waiting for your decision")), el("span", "todo-you-n", String(count)));
    this.youCountEl.setAttribute("aria-pressed", this.askOnly ? "true" : "false");
    this.youCountEl.classList.toggle("active", this.askOnly);
    this.youCountEl.title = this.askOnly ? l10n.t("Show every item again") : l10n.t("Show only the items waiting for your decision");
    this.staleBtn.hidden = this.staleRows.length === 0;
    this.staleBtn.textContent = l10n.t("Mark the old questions done ({0})", this.staleRows.length);
    this.render();
    for (const listener of this.listeners) listener();
  }

  private setAskOnly(on: boolean): void {
    this.askOnly = on && this.asking.size > 0;
    this.youCountEl.setAttribute("aria-pressed", this.askOnly ? "true" : "false");
    this.youCountEl.classList.toggle("active", this.askOnly);
    this.render();
    this.hooks.changed();
  }

  private setFoldDone(on: boolean): void {
    this.foldDone = on;
    this.openDone.clear();
    this.closeMenu(false);
    this.render();
    this.hooks.changed();
  }

  private renderTab(): void {
    this.tabCountEl.textContent = String(todoOpenCount(this.itemsNow));
    this.tabFreshEl.hidden = this.fresh.size === 0;
    this.tabFreshEl.textContent = `+${this.fresh.size}`;
    this.tabBtn.title = this.fresh.size > 0
      ? l10n.t("ToDo list · {0} open · Claude added {1} while you were away", todoOpenCount(this.itemsNow), this.fresh.size)
      : l10n.t("ToDo list · {0} open", todoOpenCount(this.itemsNow));
  }

  receive(message: TodoLogMessage): void {
    if (this.query) {
      this.searchLogs = { ...this.searchLogs, ...(message.view === "claude" ? { claude: message.changes } : { deleted: message.items }) };
      if (message.view !== this.mode) { this.render(); return; }
    }
    if (message.view !== this.mode || message.revision < this.logRevision) return;
    this.logRevision = message.revision;
    this.log = message.view === "claude" ? { view: "claude", changes: message.changes, batches: message.batches } : { view: "deleted", items: message.items };
    this.render();
  }

  private showNotice(notice: string | null): void {
    if (notice === null) todoClearNotice(this.noticeEl, this.pane);
    else todoFillNotice(this.noticeEl, [notice], () => this.showNotice(null));
  }

  private setMode(mode: "list" | TodoLogView): void {
    if (mode !== "list" || this.mode !== "list") {
      this.historySeenAt = Date.now();
      this.hooks.changed();
    }
    this.mode = mode;
    this.log = null;
    this.logRevision = -1;
    if (mode !== "list") this.hooks.post({ type: "todoLogRequest", view: mode });
    this.render();
  }

  openDetail(id: string): boolean {
    return this.app.open(id);
  }

  get enabled(): boolean {
    return this.enabledNow;
  }

  get storeRevision(): number {
    return this.revision;
  }

  get shown(): boolean {
    return this.shownNow;
  }

  viewState(): TodoViewState {
    return { shown: this.shownNow, group: this.group, due: this.due, collapsed: [...this.collapsed], foldDone: this.foldDone,
      foldedGroups: [...this.foldedGroups], askOnly: this.askOnly, fresh: [...this.fresh], splitDeclined: [...this.splitDeclinedNow], historySeenAt: this.historySeenAt };
  }

  apply(message: TodoSnapshotMessage): { restoreShown: boolean } {
    if (message.seq < this.seq) return { restoreShown: false };
    this.seq = message.seq;
    const restoreShown = !this.restoredOnce && this.restoreShown && message.enabled;
    this.restoredOnce = true;
    if (!message.enabled) {
      this.enabledNow = false;
      this.itemsNow = [];
      this.tabItemsNow = [];
      this.deletedTabsNow = new Set();
      this.sessionsNow = new Map();
      this.colors = new Map();
      this.groupFolders = new Map();
      this.groupAliases = new Map();
      this.unreadable = false;
      this.setShown(false);
      this.sheet.close(false);
      this.app.detail.hide();
      this.mode = "list";
      this.revision = -1;
      clearTimeout(this.midnightTimer);
      this.midnightTimer = undefined;
      this.askBoard.clear();
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
      this.claudeRecent = [];
      this.askRows = new Map();
      this.askUnreadable = new Set();
      this.youCountEl.hidden = true;
      this.tabBtn.remove();
      this.pane.remove();
      for (const listener of this.listeners) listener();
      return { restoreShown };
    }
    this.enabledNow = true;
    if (this.midnightTimer === undefined) this.scheduleMidnight();
    if ("unreadable" in message) {
      this.unreadable = true;
    } else {
      this.unreadable = false;
      if (message.revision !== this.revision) {
        this.app.detail.refresh();
        if (this.mode !== "list") this.hooks.post({ type: "todoLogRequest", view: this.mode });
        if (this.query) this.requestSearchLogs();
      }
      this.revision = message.revision;
      if (this.shownNow && this.previousItems) for (const id of todoNewlyDone(this.previousItems, message.items)) this.keepDone.add(id);
      const added = this.shownNow ? [] : todoFreshItems(this.previousItems, message.items);
      for (const id of added) this.fresh.add(id);
      this.previousItems = message.items;
      this.itemsNow = message.items;
      this.claudeRecent = message.claudeRecent;
      this.scheduleExpiry();
      this.tabItemsNow = message.tabItems;
      this.deletedTabsNow = new Set(message.deletedTabs);
      this.sessionsNow = new Map(message.sessions.map(link => [link.sessionId, link]));
      this.templates = message.templates;
      this.colors = new Map(message.groups.map(group => [group.name, group.color]));
      this.groupFolders = new Map(message.groups.map(group => [group.name, group.folders ?? []]));
      this.groupAliases = new Map(message.groups.map(group => [group.name, group.aliases ?? []]));
      const live = new Set(message.items.map(item => item.id));
      for (const id of this.collapsed) if (!live.has(id)) this.collapsed.delete(id);
      let pruned = false;
      for (const id of this.fresh) if (!live.has(id)) { this.fresh.delete(id); pruned = true; }
      const sectionKeys = new Set([todoSectionKey(null), ...[...this.colors.keys()].map(todoSectionKey)]);
      for (const key of this.foldedGroups) if (!sectionKeys.has(key)) { this.foldedGroups.delete(key); pruned = true; }
      if (added.length || pruned) this.hooks.changed();
      this.rows.prune(live);
      this.askBoard.apply(message.tabItems, message.askSources, message.askDismissals, message.askClosedInTodo);
    }
    this.renderTab();
    this.asksChanged();
    return { restoreShown };
  }

  setShown(shown: boolean): void {
    const was = this.shownNow;
    this.shownNow = shown && this.enabledNow;
    if (!this.shownNow) {
      this.closeMenu(false);
      this.inline = null;
      this.rows.clearSelection();
      if (this.keepDone.size) { this.keepDone.clear(); this.render(); }
    } else if (!was && this.fresh.size > 0) {
      this.flash = new Set(this.fresh);
      this.fresh.clear();
      this.renderTab();
      this.render();
      this.hooks.changed();
    }
    this.sheet.setVisible(this.shownNow);
    this.tabBtn.classList.toggle("active", this.shownNow);
    this.tabBtn.setAttribute("aria-selected", this.shownNow ? "true" : "false");
    this.pane.classList.toggle("active", this.shownNow);
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    const now = Date.now();
    const next = todoNextExpiry([...this.claudeRecent, ...this.itemsNow.flatMap(item => (item.markInfo ?? []).map(info => info.at))], now);
    this.expiryTimer = next === undefined ? undefined : setTimeout(() => {
      this.render();
      this.scheduleExpiry();
    }, next - now + TODO_EXPIRY_SLACK_MS);
  }

  private scheduleMidnight(): void {
    this.midnightTimer = setTimeout(() => {
      this.midnightTimer = undefined;
      if (!this.enabledNow) return;
      this.render();
      this.scheduleMidnight();
    }, msUntilNextLocalDay(new Date()) + 1000);
  }

  private listView() {
    return deriveTodoList(this.itemsNow, { group: this.group, due: this.due, collapsed: this.collapsed, today: localDateKey(new Date()), colors: this.colors,
      emptyGroups: true, foldedGroups: this.foldedGroups,
      ...(this.foldDone ? { foldDone: { open: this.openDone, keep: this.keepDone } } : {}),
      ...(this.askOnly || this.query ? { only: this.onlyIds() } : {}),
      ...(this.inline ? { inline: this.inline } : {}) });
  }

  private onlyIds(): ReadonlySet<string> {
    const key = todoNameKey(this.query);
    const found = key ? this.itemsNow.filter(item => todoNameKey(item.title).includes(key)).map(item => item.id) : this.itemsNow.map(item => item.id);
    return new Set(this.askOnly ? found.filter(id => this.asking.has(id)) : found);
  }

  private buildSearch(): void {
    const icon = el("span", "l-icon l-icon-search");
    icon.setAttribute("aria-hidden", "true");
    this.searchInput.type = "search";
    this.searchInput.spellcheck = false;
    this.searchInput.autocomplete = "off";
    this.searchInput.placeholder = l10n.t("Search ToDo");
    this.searchInput.setAttribute("aria-label", l10n.t("Search ToDo, Recently deleted and Claude's moves"));
    const clear = todoButton("hist-clear", CLOSE_GLYPH, () => { this.searchInput.value = ""; this.setQuery(""); this.searchInput.focus(); }, l10n.t("Clear search"));
    clear.hidden = true;
    this.searchInput.addEventListener("input", () => { clear.hidden = this.searchInput.value === ""; this.setQuery(this.searchInput.value); });
    this.searchInput.addEventListener("keydown", event => { if (event.key === "Escape" && this.searchInput.value) { event.stopPropagation(); clear.click(); } });
    this.searchEl.append(icon, this.searchInput, clear);
  }

  private setQuery(text: string): void {
    const starting = !this.query && text.trim() !== "";
    this.query = text.trim();
    if (!this.query) this.searchLogs = {};
    if (starting) this.requestSearchLogs();
    this.render();
  }

  private requestSearchLogs(): void {
    this.hooks.post({ type: "todoLogRequest", view: "claude" });
    this.hooks.post({ type: "todoLogRequest", view: "deleted" });
  }

  private searchResults(): HTMLElement | null {
    const key = todoNameKey(this.query);
    if (!key) return null;
    const matches = (title: string) => todoNameKey(title).includes(key);
    const box = el("section", "todo-search-results");
    box.setAttribute("aria-label", l10n.t("Elsewhere"));
    const line = (text: string, action: HTMLElement | null) => {
      const row = el("div", "todo-search-row");
      const what = el("span", "todo-search-text", text);
      what.title = text;
      row.append(what, ...(action ? [action] : []));
      box.append(row);
    };
    for (const item of (this.searchLogs.deleted ?? []).filter(entry => matches(entry.title))) {
      line(l10n.t("{0}: in Recently deleted · {1}", item.title, formatTodoDay(localDateKey(new Date(item.deletedAt)))),
        todoButton("todo-link", l10n.t("Restore"), () => this.app.edits.send({ kind: "restore", id: item.id })));
    }
    const seen = new Set<string>();
    for (const change of this.searchLogs.claude ?? []) {
      if ((change.field !== "position" && change.field !== "group") || seen.has(change.itemId) || !matches(change.itemTitle)) continue;
      if (!this.itemsNow.some(entry => entry.id === change.itemId)) continue;
      seen.add(change.itemId);
      line(l10n.t("{0}: Claude moved it to {1} on {2}", change.itemTitle, change.after ?? l10n.t("No group"), formatTodoDay(localDateKey(new Date(change.at)))),
        change.revert === "ok" ? todoButton("todo-link", l10n.t("Take back"), () => this.app.edits.send({ kind: "revertClaude", changeIds: todoRevertUnit(this.searchLogs.claude ?? [], change).map(entry => entry.id) })) : null);
    }
    if (!this.searchLogs.claude || !this.searchLogs.deleted) box.append(el("p", "todo-note", l10n.t("Loading…")));
    return box.childElementCount ? box : null;
  }

  render(): void {
    if (this.dragging) return;
    const focusKey = this.pane.contains(document.activeElement) ? focusKeyOf(document.activeElement) : undefined;
    const view = this.listView();
    const full = deriveTodoList(this.itemsNow, { group: null, due: "all", collapsed: new Set(), today: localDateKey(new Date()), colors: this.colors });
    const rows = full.sections.flatMap(section => section.families.flatMap(family => family.rows));
    this.numbers = new Map(rows.map(row => [row.id, row.number]));
    this.rowColors = new Map(rows.map(row => [row.id, row.color]));
    this.renderFilterButton(view.group);
    this.renderChips(view, full);
    this.listEl.replaceChildren();
    this.renderHead();
    if (this.mode !== "list") {
      if (this.log?.view === "claude") {
        this.listEl.append(todoClaudeChangesView(this.log.changes, this.log.batches, {
          open: id => this.openDetail(id),
          revert: changeIds => this.app.edits.send({ kind: "revertClaude", changeIds: [...changeIds] }),
          revertRevision: revision => this.app.edits.send({ kind: "revertClaude", revisions: [revision] }),
        }));
      } else if (this.log?.view === "deleted") {
        this.listEl.append(todoDeletedView(this.log.items, id => this.app.edits.send({ kind: "restore", id })));
      } else {
        this.listEl.append(el("p", "todo-note", l10n.t("Loading…")));
      }
      if (focusKey !== undefined) this.focusByKey(focusKey);
      return;
    }
    if (this.unreadable) this.listEl.append(el("p", "todo-note", l10n.t("Could not read the ToDo list. The last list read is shown.")));
    if (view.total === 0 && !this.unreadable && !this.inline) {
      this.listEl.append(el("p", "todo-note", l10n.t("No ToDo items yet. Add one with the ＋ button, or ask Claude in a conversation.")));
    } else if (view.sections.length === 0) {
      this.listEl.append(el("p", "todo-note", l10n.t("No items match the filter.")));
    }
    const elsewhere = this.searchResults();
    if (elsewhere) this.listEl.prepend(elsewhere);
    for (const section of view.sections) this.listEl.append(this.rows.sectionEl(section, view.headed));
    for (const id of this.flash) this.listEl.querySelector(`.todo-row[data-id="${CSS.escape(id)}"]`)?.classList.add("flash");
    if (this.flash.size) {
      this.flash = new Set();
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => { for (const node of Array.from(this.listEl.querySelectorAll(".todo-row.flash"))) node.classList.remove("flash"); }, TODO_FLASH_MS);
    }
    const pending = this.pendingFocus;
    if (pending && this.colors.has(pending.group) && !view.sections.some(section => section.group === pending.group)) {
      this.pendingFocus = null;
      if (this.renamingGroup === pending.group) {
        this.renamingGroup = null;
        this.renameDraft = undefined;
      }
    }
    if (this.pendingFocus && this.focusByKey(this.pendingFocus.key)) this.pendingFocus = null;
    else if (focusKey !== undefined) this.focusByKey(focusKey);
    if (this.menuOpen()) this.fillMenu(view, true);
  }

  private groupItems(group: string | null): readonly TodoListItem[] {
    return group === null ? this.itemsNow : this.itemsNow.filter(item => this.rootGroupOf(item.id) === group);
  }

  private renderChips(view: ReturnType<TodoTab["listView"]>, full: ReturnType<TodoTab["listView"]>): void {
    const chip = (key: string, label: string, count: number | null, checked: boolean, run: () => void, options: { hint?: string; alert?: boolean } = {}) => {
      const node = todoButton("todo-chip", label, () => { if (!checked) run(); }, options.hint);
      node.dataset.focusKey = key;
      node.setAttribute("role", "radio");
      node.setAttribute("aria-checked", checked ? "true" : "false");
      if (count !== null) node.append(el("span", `todo-chip-n${options.alert ? " alert" : ""}`, String(count)));
      return node;
    };
    const set = (label: string, chips: HTMLElement[]) => {
      const box = el("span", "todo-chip-set");
      box.setAttribute("role", "radiogroup");
      box.setAttribute("aria-label", label);
      box.append(...chips);
      return box;
    };
    const counts = todoDueCounts(this.groupItems(view.group), localDateKey(new Date()));
    const due = el("span", "todo-chip-due");
    due.append(set(l10n.t("Filter by due date"), TODO_DUE_FILTERS.filter(filter => todoDueFilterShown(filter, counts, this.due))
      .map(filter => chip(`chip-due:${filter}`, DUE_LABELS[filter](), counts[filter], this.due === filter,
        () => this.setFilters(view.group, filter), { hint: DUE_HINTS[filter]?.(), alert: filter === "overdue" }))));
    const parts: HTMLElement[] = [];
    if (view.groups.length > 0) {
      const total = full.sections.reduce((sum, section) => sum + section.count, 0);
      const groups = set(l10n.t("Filter by group"), [
        chip("chip-group:", l10n.t("All"), total, view.group === null, () => this.setFilters(null, this.due)),
        ...view.groups.map(group => chip(`chip-group:${group.name}`, group.name, full.sections.find(section => section.group === group.name)?.count ?? 0,
          view.group === group.name, () => this.setFilters(group.name, this.due))),
      ]);
      groups.classList.add("todo-chip-groups");
      parts.push(groups);
    }
    const inbox = full.sections.find(section => section.group === null)?.open ?? 0;
    if (inbox > 0) {
      const button = todoButton("todo-chip todo-chip-inbox", l10n.t("No group"), () => {
        this.foldedGroups.delete(todoSectionKey(null));
        if (this.group !== null) this.setFilters(null, this.due);
        else this.render();
        this.listEl.querySelector<HTMLElement>(`[data-group="${CSS.escape(JSON.stringify(null))}"]`)?.scrollIntoView({ block: "start" });
      }, l10n.t("Items not placed in a group yet: {0}", inbox));
      button.append(el("span", "todo-chip-n", String(inbox)));
      parts.push(button);
    }
    const done = this.groupItems(view.group).filter(item => item.state === "done").length;
    this.foldBtn.replaceChildren(document.createTextNode(TODO_STATE_LABELS.done()), el("span", "todo-chip-n", String(done)));
    this.foldBtn.hidden = this.foldDone && done === 0;
    this.foldBtn.title = this.foldDone ? l10n.t("Show the done items") : l10n.t("Fold done items into “Show N done” at the end of each list");
    this.foldBtn.setAttribute("aria-pressed", this.foldDone ? "false" : "true");
    this.chipsEl.replaceChildren(this.filterBtn, due, ...parts, this.staleBtn);
    if (this.searchRowEl.firstChild !== this.searchEl || this.searchEl.nextSibling !== this.foldBtn) this.searchRowEl.replaceChildren(this.searchEl, this.foldBtn);
  }

  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  private templateEntries(use: (template: TodoTemplateView) => void): TodoMenuEntry[] {
    if (this.templates.length === 0) return [{ label: l10n.t("No templates yet. Save one from an item's menu.") }];
    return this.templates.map(template => ({ label: template.size > 1 ? l10n.t("{0} ({1} items)", template.name, template.size) : template.name, run: () => use(template) }));
  }

  private insertTemplate(template: TodoTemplateView, slot: TodoInsertSlot): void {
    const group = slot.parentId === null ? slot.group : null;
    const position = todoInsertPosition(this.itemsNow, slot);
    this.app.edits.send({ kind: "add", parentId: slot.parentId, title: template.title, templateId: template.id, ...(group ? { group } : {}), ...(position !== undefined ? { position } : {}) },
      (ok, changed) => { if (ok && changed) this.showAction(l10n.t("Added from the template “{0}”.", template.name), l10n.t("Undo"), () => this.app.edits.undo(), TODO_UNDO_NOTICE_MS); });
  }

  private saveTemplateEntry(id: string): TodoMenuEntry {
    const title = this.titleOf(id);
    return { label: l10n.t("Save as a template"), input: {
      placeholder: title.slice(0, TODO_TEMPLATE_NAME_MAX),
      action: l10n.t("Save"),
      preview: value => l10n.t("Name: {0} · the titles of its sub-items are saved too", (value.trim() || title).slice(0, TODO_TEMPLATE_NAME_MAX)),
      submit: value => {
        const name = (value.trim() || title).slice(0, TODO_TEMPLATE_NAME_MAX);
        this.app.edits.send({ kind: "templateSave", id, name }, (ok, changed) => { if (ok && changed) this.app.notify(l10n.t("Saved the template “{0}”.", name)); });
        return true;
      },
    } };
  }

  private createGroup(): void {
    const name = todoUniqueGroupName(l10n.t("New group"), this.colors.keys());
    this.app.edits.send({ kind: "groupCreate", name }, ok => {
      if (!ok) return;
      this.startRename(name);
    });
  }

  private groupMenu(group: string): TodoMenuEntry[] {
    const names = [...this.colors.keys()];
    const index = names.indexOf(group);
    const color = this.colors.get(group);
    return [
      { label: l10n.t("Rename the group"), run: () => this.groupActions.rename(group) },
      { label: l10n.t("Colour"), children: Array.from({ length: TODO_GROUP_COLOR_COUNT }, (_, offset) => ({
        label: l10n.t("Colour {0}", offset + 1), swatch: groupColor(offset + 1), checked: color === offset + 1,
        run: () => { if (color !== offset + 1) this.app.edits.send({ kind: "groupColor", name: group, color: offset + 1 }); },
      })) },
      ...(index > 0 ? [{ label: l10n.t("Move the group up"), run: () => this.app.edits.send({ kind: "groupMove", name: group, direction: -1 }) }] : []),
      ...(index >= 0 && index < names.length - 1 ? [{ label: l10n.t("Move the group down"), run: () => this.app.edits.send({ kind: "groupMove", name: group, direction: 1 }) }] : []),
      { label: l10n.t("Delete the group"), run: () => this.app.edits.send({ kind: "groupDelete", name: group }, (ok, changed) => {
        if (!ok || !changed) return;
        if (this.group === group) this.setFilters(null, this.due);
        this.showAction(l10n.t("Deleted the group “{0}”. Its items moved to No group.", group), l10n.t("Undo"), () => this.app.edits.undo(), TODO_UNDO_NOTICE_MS);
      }) },
    ];
  }

  private readonly groupActions: TodoRowGroups = {
    toggle: section => {
      if (!this.foldedGroups.delete(section.key)) this.foldedGroups.add(section.key);
      this.render();
      this.hooks.changed();
    },
    rename: group => this.startRename(group),
    renaming: () => this.renamingGroup,
    renameDraft: () => this.renameDraft,
    setRenameDraft: text => { this.renameDraft = text; },
    commitRename: (group, to, refocus) => {
      if (this.renamingGroup !== group) return;
      this.renamingGroup = null;
      this.renameDraft = undefined;
      const name = to?.trim();
      const focusName = (target: string) => ({ key: `groupname:${target}`, group: target });
      this.pendingFocus = refocus ? focusName(name || group) : null;
      if (name && name !== group) {
        this.app.edits.send({ kind: "groupRename", name: group, to: name }, (ok, changed) => {
          if (!ok || !changed) {
            if (this.pendingFocus?.group === name) this.pendingFocus = focusName(group);
            return;
          }
          if (this.foldedGroups.delete(todoSectionKey(group))) this.foldedGroups.add(todoSectionKey(name));
          if (this.openDone.delete(todoSiblingKey(null, group))) this.openDone.add(todoSiblingKey(null, name));
          if (this.group === group) this.group = name;
          this.hooks.changed();
          this.render();
        });
      }
      this.render();
    },
    menu: (group, anchor, point) => openTodoMenu(anchor, this.groupMenu(group), l10n.t("Group menu"), point ? { point } : {}),
    status: section => {
      const ids = new Set(section.ids);
      const attention = this.attention(ids);
      return {
        running: attention.running.length,
        waiting: attention.waiting.length,
        unread: this.tabItemsNow.filter(entry => ids.has(entry.itemId)).reduce((sum, entry) => sum + this.hooks.unreadOfTab(entry.tabId), 0),
      };
    },
  };

  private startRename(group: string): void {
    this.renamingGroup = group;
    this.renameDraft = undefined;
    this.pendingFocus = { key: `grouprename:${group}`, group };
    this.render();
  }

  private focusByKey(key: string): boolean {
    if (this.menuEl.contains(document.activeElement)) return false;
    const node = Array.from(this.pane.querySelectorAll<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)).find(entry => !entry.closest("[hidden]"));
    if (!node) return false;
    node.focus();
    if (node instanceof HTMLInputElement) {
      if (key === this.pendingFocus?.key) node.select();
      else node.setSelectionRange(node.value.length, node.value.length);
    }
    return true;
  }

  private readonly insertActions: TodoRowInsert = {
    near: (id, where) => {
      const slot = todoSlotNear(this.itemsNow, id, where);
      if (slot) this.openInline(slot, "");
    },
    atEnd: group => this.openInline({ parentId: null, group, before: null }, ""),
    inputRow: depth => this.inlineRowEl(depth),
  };

  private rootGroupOf(id: string | null): string | null {
    return todoRootGroup(this.itemsNow, id);
  }

  private groupNames(): string[] {
    return [...this.colors.keys()];
  }

  private defaultGroup(): string | null {
    if (this.group !== null && this.colors.has(this.group)) return this.group;
    return this.rootGroupOf(this.selectedRow);
  }

  private openSheet(draft: TodoSheetDraft): void {
    this.closedDraft = null;
    this.draftEl.hidden = true;
    this.inline = null;
    this.render();
    this.sheet.open(draft);
  }

  private sheetClosed(draft: TodoSheetDraft | null): void {
    this.closedDraft = draft;
    if (draft) this.showAction(l10n.t("Closed the item you were writing."), l10n.t("Bring it back"), () => { if (this.closedDraft) this.openSheet(this.closedDraft); });
    else this.hideAction();
    if (this.shownNow) this.focusByKey("add");
  }

  private showAction(text: string, action: string, run: () => void, hideAfterMs = TODO_NOTICE_MS): void {
    clearTimeout(this.actionTimer);
    todoFillNotice(this.draftEl, [text, " ", todoButton("todo-link", action, () => { this.hideAction(); run(); })], () => this.hideAction());
    this.actionTimer = setTimeout(() => this.hideAction(), hideAfterMs);
  }

  private hideAction(): void {
    clearTimeout(this.actionTimer);
    todoClearNotice(this.draftEl, this.pane);
  }

  private sendSteps(steps: readonly TodoBatchStep[], done?: string): void {
    if (steps.length === 0) return;
    this.app.edits.send({ kind: "batch", steps: [...steps] }, (ok, changed) => {
      if (ok && changed && done !== undefined) this.showAction(done, l10n.t("Undo"), () => this.app.edits.undo(), TODO_UNDO_NOTICE_MS);
    });
  }

  private moveTo(ids: readonly string[], slot: TodoInsertSlot | undefined, done?: string): void {
    if (!slot) return;
    for (let id = slot.parentId; id !== null;) {
      this.collapsed.delete(id);
      id = this.itemsNow.find(item => item.id === id)?.parentId ?? null;
    }
    this.sendSteps(todoMoveSteps(this.itemsNow, ids, slot, this.groupNames()), done);
  }

  private titleOf(id: string | null): string {
    return this.itemsNow.find(item => item.id === id)?.title ?? "";
  }

  private describeDrop(ids: readonly string[], drop: TodoDrop): string {
    if (drop.slot.parentId !== null) return l10n.t("Into “{0}”", this.titleOf(drop.slot.parentId));
    const roots = todoSelectionRoots(this.itemsNow, ids, this.groupNames()).map(id => this.itemsNow.find(item => item.id === id)!);
    const same = roots.every(item => item.parentId === null && (item.group ?? null) === drop.slot.group);
    return same ? l10n.t("Here") : l10n.t("To group “{0}”", drop.slot.group ?? l10n.t("No group"));
  }

  private renderSelection(): void {
    const count = this.rows.selected.size;
    this.selectionEl.hidden = count < 2;
    this.selectionEl.replaceChildren();
    if (count < 2) return;
    const ids = [...this.rows.selected];
    const clear = todoButton("todo-link todo-selbar-clear", l10n.t("Clear selection"), () => this.rows.clearSelection(), l10n.t("Clear selection (Esc)"));
    this.selectionEl.append(
      el("span", "todo-selbar-count", l10n.t("{0} selected", count)),
      todoButton("todo-link", l10n.t("Mark done"), () => this.sendSteps(todoStateSteps(this.itemsNow, ids, "done", this.groupNames()))),
      clear,
    );
  }

  private readonly organizeActions: TodoRowOrganize = {
    setState: (ids, state) => this.sendSteps(todoStateSteps(this.itemsNow, ids, state, this.groupNames())),
    step: (ids, direction) => this.moveTo(ids, todoStepSlot(this.itemsNow, ids, direction, this.groupNames())),
    indent: (ids, direction) => this.moveTo(ids, todoIndentSlot(this.itemsNow, ids, direction, this.groupNames())),
    remove: ids => this.sendSteps(todoSelectionRoots(this.itemsNow, ids, this.groupNames()).map(id => ({ kind: "delete", id }))),
    menu: (id, ids, anchor, point) => openTodoMenu(anchor, this.itemMenu(id, ids), l10n.t("Item menu"),
      { filter: true, ...(point ? { point } : {}), title: ids.length > 1 ? l10n.t("{0} selected", ids.length) : this.titleOf(id) }),
    drag: (row, ids, event) => {
      this.dragging = true;
      startTodoDrag({
        list: () => this.listEl,
        describe: (moving, drop) => this.describeDrop(moving, drop),
        drop: (moving, drop) => this.moveTo(moving, drop.slot, l10n.t("Moved.")),
        end: () => { this.dragging = false; this.render(); },
      }, row, ids, event);
    },
    selectionChanged: () => this.renderSelection(),
  };

  private addChild(id: string): void {
    this.openInline({ parentId: id, group: null, before: null }, "");
  }

  private itemMenu(id: string, ids: readonly string[]): TodoMenuEntry[] {
    const item = this.itemsNow.find(entry => entry.id === id);
    if (!item) return [];
    const single = todoSelectionRoots(this.itemsNow, ids, this.groupNames()).length === 1;
    const update = (fields: Omit<Extract<TodoBatchStep, { kind: "update" }>, "kind" | "id">) =>
      () => this.sendSteps(todoSelectionRoots(this.itemsNow, ids, this.groupNames()).map(target => ({ kind: "update", id: target, ...fields })));
    const today = localDateKey(new Date());
    const presets = todoDatePresets(today);
    const due = (key: string | null) => update({ due: key });
    const groups = [...this.colors.keys()];
    const conversation: TodoMenuEntry[] = !single ? [] : item.parentId === null
      ? [{ label: todoPlayText(item.talk).label, keys: "Enter", run: () => this.openConversation(id, false) }]
      : [item.talk !== undefined ? { label: l10n.t("Open the child conversation"), run: () => this.openConversation(id, false) }
        : { label: l10n.t("Start the task in a new tab"), run: () => this.app.splitChild(id) }];
    const templates = l10n.t("Template");
    const fields = l10n.t("Properties");
    const actions = l10n.t("Actions");
    return [
      ...conversation,
      ...(single ? [
        { label: l10n.t("Open details"), keys: "D", run: () => { this.openDetail(id); } },
        { label: l10n.t("Add (below)"), keys: "N", run: () => this.insertActions.near(id, "below") },
        { label: l10n.t("Add (child)"), run: () => this.addChild(id) },
        { section: templates, label: l10n.t("Insert from a template"), children: this.templateEntries(template => { const slot = todoSlotNear(this.itemsNow, id, "below"); if (slot) this.insertTemplate(template, slot); }) },
        { ...this.saveTemplateEntry(id), section: templates },
      ] : []),
      { section: fields, label: l10n.t("State"), ...(single ? { value: TODO_STATE_LABELS[item.state]() } : {}),
        children: TODO_STATES.map((state: TodoState) => ({ label: TODO_STATE_LABELS[state](), checked: single ? item.state === state : undefined, run: () => this.organizeActions.setState(ids, state) })) },
      { section: fields, label: l10n.t("Priority"), ...(single && item.priority ? { value: item.priority.toUpperCase() } : {}), children: [
        { label: l10n.t("None"), run: update({ priority: null }) },
        ...TODO_PRIORITIES.map(priority => ({ label: `${priority.toUpperCase()} ${TODO_PRIORITY_LABELS[priority]()}`, run: update({ priority }) })),
      ] },
      { section: fields, label: l10n.t("Due"), ...(single && item.due ? { value: formatTodoDay(item.due) } : {}), children: [
        { label: `${l10n.t("Today")} (${formatTodoDay(presets.today)})`, run: due(presets.today) },
        { label: `${l10n.t("Tomorrow")} (${formatTodoDay(presets.tomorrow)})`, run: due(presets.tomorrow) },
        { label: `${l10n.t("Friday this week")} (${formatTodoDay(presets.thisFriday)})`, run: due(presets.thisFriday) },
        { label: `${l10n.t("Friday next week")} (${formatTodoDay(presets.nextFriday)})`, run: due(presets.nextFriday) },
        { label: `${l10n.t("End of the month")} (${formatTodoDay(presets.monthEnd)})`, run: due(presets.monthEnd) },
        { label: l10n.t("Enter a date"), input: {
          action: l10n.t("Set as due date"),
          preview: value => {
            if (!value.trim()) return "";
            const key = parseTodoDate(value, localDateKey(new Date()));
            return key ? `→ ${formatTodoDay(key, "full")}` : l10n.t("Not readable as a date");
          },
          submit: value => {
            const key = parseTodoDate(value, localDateKey(new Date()));
            if (key) due(key)();
            return key !== undefined;
          },
        } },
        { label: l10n.t("Remove the due date"), run: due(null) },
      ] },
      { section: fields, label: l10n.t("Group"), ...(single ? { value: this.rootGroupOf(id) ?? l10n.t("No group") } : {}), children: [
        ...groups.map(group => ({ label: group, swatch: groupColor(this.colors.get(group) ?? null), run: () => this.sendSteps(todoGroupSteps(this.itemsNow, ids, group, this.groupNames())) })),
        { label: l10n.t("No group"), run: () => this.sendSteps(todoGroupSteps(this.itemsNow, ids, null, this.groupNames())) },
      ] },
      ...(single ? [{ section: actions, label: l10n.t("Edit the title"), keys: "F2", run: () => this.rows.editTitle(id) }] : []),
      { section: actions, label: l10n.t("Move up"), keys: "Alt+ArrowUp", run: () => this.organizeActions.step(ids, -1) },
      { section: actions, label: l10n.t("Move down"), keys: "Alt+ArrowDown", run: () => this.organizeActions.step(ids, 1) },
      { section: actions, label: l10n.t("Make it a sub-item"), keys: "Tab", run: () => this.organizeActions.indent(ids, 1) },
      { section: actions, label: l10n.t("Move out one level"), keys: "Shift+Tab", run: () => this.organizeActions.indent(ids, -1) },
      { section: actions, label: l10n.t("Delete"), keys: "Delete", run: () => this.organizeActions.remove(ids) },
    ];
  }

  private renderHead(): void {
    const history = this.mode !== "list";
    this.whereEl.replaceChildren(...(history ? [el("span", "todo-where-up", `ToDo ${MARKS.pathSeparator}`), document.createTextNode(` ${l10n.t("History")}`)] : []));
    this.whereEl.hidden = !history;
    this.youCountEl.hidden = history || this.askCount === 0;
    this.addBtn.hidden = history;
    this.chipsEl.hidden = history;
    this.searchRowEl.hidden = history;
    this.historyTabsEl.hidden = !history;
    this.historyTabsEl.replaceChildren();
    if (history) {
      for (const [view, label] of [["claude", l10n.t("Claude's changes")], ["deleted", l10n.t("Deleted items")]] as const) {
        const tab = todoButton("todo-history-tab", label, () => { if (this.mode !== view) this.setMode(view); });
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", this.mode === view ? "true" : "false");
        tab.dataset.focusKey = `history-tab:${view}`;
        this.historyTabsEl.append(tab);
      }
    }
    const since = todoRecentSince(this.historySeenAt, Date.now());
    const unseen = history ? 0 : this.claudeRecent.filter(at => at > since).length;
    this.historyBtn.hidden = history;
    this.historyCloseBtn.hidden = !history;
    const icon = el("span", "l-icon l-icon-history");
    icon.setAttribute("aria-hidden", "true");
    const label = unseen > 0 ? l10n.t("Claude's changes and deleted items · {0} new from Claude", unseen) : l10n.t("Claude's changes and deleted items");
    this.historyBtn.replaceChildren(icon, ...(unseen > 0 ? [el("span", "todo-history-badge", String(unseen))] : []));
    this.historyBtn.title = label;
    this.historyBtn.setAttribute("aria-label", label);
  }

  private openInline(slot: TodoInsertSlot, text: string): void {
    const previous = this.inline;
    const reopened: string[] = [];
    for (let id = slot.parentId; id !== null;) {
      if (this.collapsed.delete(id)) reopened.push(id);
      id = this.itemsNow.find(item => item.id === id)?.parentId ?? null;
    }
    this.inline = { ...slot, text };
    if (!this.listView().sections.some(section => section.inline)) {
      this.inline = previous;
      for (const id of reopened) this.collapsed.add(id);
      return;
    }
    this.render();
    if (reopened.length) this.hooks.changed();
    this.focusByKey("inline");
  }

  private endInline(): void {
    if (!this.inline) return;
    const near = this.inline.before ?? this.inline.parentId;
    this.inline = null;
    this.render();
    if (near !== null) this.focusByKey(`row:${near}`);
  }

  private saveInline(text: string): void {
    const slot = this.inline;
    if (!slot) return;
    const title = text.trim();
    if (!title) {
      this.app.notify(l10n.t("The title is empty."));
      return;
    }
    const group = slot.parentId === null ? slot.group : null;
    const position = todoInsertPosition(this.itemsNow, slot);
    slot.text = "";
    this.app.edits.send({
      kind: "add", parentId: slot.parentId, title,
      ...(group ? { group } : {}), ...(position !== undefined ? { position } : {}),
    }, ok => {
      if (!ok && this.inline === slot && slot.text === "") {
        slot.text = text;
        this.render();
      }
    });
    this.render();
    this.focusByKey("inline");
  }

  private inlineRowEl(depth: number): HTMLElement {
    const slot = this.inline!;
    const row = el("div", "todo-row todo-inline");
    row.setAttribute("role", "listitem");
    row.style.setProperty("--todo-depth", String(depth));
    const input = el("input", "todo-inline-in");
    input.type = "text";
    input.value = slot.text;
    input.maxLength = TODO_TITLE_MAX;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.dataset.focusKey = "inline";
    input.placeholder = todoNewTitlePlaceholder();
    input.setAttribute("aria-label", l10n.t("New item title"));
    input.addEventListener("input", () => { slot.text = input.value; });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (isComposingKey(e)) return;
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        this.openSheet(blankTodoSheetDraft({ title: slot.text, parentId: slot.parentId, group: slot.parentId === null ? slot.group : null, before: slot.before }));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (input.value.trim()) this.saveInline(input.value);
        else this.endInline();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.endInline();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const next = todoSlotIndent(this.itemsNow, slot, e.shiftKey ? -1 : 1);
        if (next) this.openInline(next, slot.text);
      }
    });
    row.append(input);
    return row;
  }

  private renderFilterButton(group: string | null): void {
    const phrase = [group, this.due === "all" ? null : DUE_LABELS[this.due]()].filter((part): part is string => part !== null).join(" · ");
    this.filterLabel.textContent = phrase || l10n.t("Filter");
    this.filterBtn.classList.toggle("active", phrase !== "");
    const color = group === null ? null : this.colors.get(group) ?? null;
    this.filterDot.hidden = color === null;
    this.filterDot.style.setProperty("--todo-gc", groupColor(color));
  }

  private menuOpen(): boolean {
    return !this.menuEl.hidden;
  }

  private menuItem(key: string, label: string, checked: boolean, run: () => void, options: { color?: number | null; hint?: string } = {}): HTMLButtonElement {
    const node = el("button", "todo-menu-item");
    node.type = "button";
    node.dataset.focusKey = key;
    node.setAttribute("role", "menuitemradio");
    node.setAttribute("aria-checked", checked ? "true" : "false");
    node.tabIndex = -1;
    const mark = el("span", "todo-menu-mark", checked ? "✓" : "");
    mark.setAttribute("aria-hidden", "true");
    node.append(mark);
    if (options.color !== undefined) {
      const dot = el("span", "todo-dot");
      dot.setAttribute("aria-hidden", "true");
      dot.style.setProperty("--todo-gc", groupColor(options.color));
      node.append(dot);
    }
    node.append(document.createTextNode(label));
    if (options.hint) node.title = options.hint;
    node.addEventListener("click", run);
    return node;
  }

  private menuSection(heading: string, label: string, items: HTMLElement[]): HTMLElement[] {
    const head = el("div", "todo-menu-head", heading);
    head.setAttribute("aria-hidden", "true");
    const box = el("div", "todo-menu-group");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", label);
    box.append(...items);
    return [head, box];
  }

  private fillMenu(view: ReturnType<TodoTab["listView"]>, keepFocus: boolean): void {
    const focused = keepFocus && this.menuEl.contains(document.activeElement) ? focusKeyOf(document.activeElement) : undefined;
    this.menuEl.replaceChildren();
    const counts = todoDueCounts(this.groupItems(view.group), localDateKey(new Date()));
    this.menuEl.append(...this.menuSection(l10n.t("Due"), l10n.t("Filter by due date"),
      TODO_DUE_FILTERS.filter(filter => todoDueFilterShown(filter, counts, this.due))
        .map(filter => this.menuItem(`due:${filter}`, `${DUE_LABELS[filter]()} ${counts[filter]}`, this.due === filter, () => this.setFilters(view.group, filter), { hint: DUE_HINTS[filter]?.() }))));
    if (view.groups.length > 0) {
      this.menuEl.append(...this.menuSection(l10n.t("Group"), l10n.t("Filter by group"), [
        this.menuItem("group:", l10n.t("All"), view.group === null, () => this.setFilters(null, this.due)),
        ...view.groups.map(group => this.menuItem(`group:${group.name}`, group.name, view.group === group.name, () => this.setFilters(group.name, this.due), { color: group.color })),
      ]));
    }
    this.menuEl.append(...this.menuSection(l10n.t("Done items"), l10n.t("Done items"), [
      this.menuItem("done:fold", l10n.t("Fold"), this.foldDone, () => this.setFoldDone(true)),
      this.menuItem("done:all", l10n.t("Show all"), !this.foldDone, () => this.setFoldDone(false)),
    ]));
    if (focused === undefined) return;
    const items = this.menuItems();
    (items.find(node => node.dataset.focusKey === focused) ?? items.find(node => node.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }

  private openMenu(): void {
    this.fillMenu(this.listView(), false);
    this.menuEl.style.top = `${this.filterBtn.offsetTop + this.filterBtn.offsetHeight + 4}px`;
    this.menuEl.hidden = false;
    this.filterBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this.closeMenuOutside, true);
    const items = this.menuItems();
    (items.find(node => node.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }

  private closeMenu(refocus: boolean): void {
    if (!this.menuOpen()) return;
    this.menuEl.hidden = true;
    this.menuEl.replaceChildren();
    this.filterBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.closeMenuOutside, true);
    if (refocus) this.filterBtn.focus();
  }

  private menuItems(): HTMLElement[] {
    return Array.from(this.menuEl.querySelectorAll<HTMLElement>(".todo-menu-item"));
  }

  private onMenuKey(e: KeyboardEvent): void {
    const items = this.menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeMenu(true); return; }
    if (e.key === "Tab") { this.closeMenu(false); return; }
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (move !== 0) { e.preventDefault(); items[(index + move + items.length) % items.length]?.focus(); return; }
    if (e.key === "Home" || e.key === "End") { e.preventDefault(); (e.key === "Home" ? items[0] : items[items.length - 1])?.focus(); }
  }

  private setFilters(group: string | null, due: TodoDueFilter): void {
    const fromChips = this.chipsEl.contains(document.activeElement) || this.searchRowEl.contains(document.activeElement);
    this.group = group;
    this.due = due;
    this.closeMenu(false);
    this.render();
    if (!fromChips) this.filterBtn.focus();
    this.hooks.changed();
  }

  private toggleCollapsed(id: string): void {
    if (!this.collapsed.delete(id)) this.collapsed.add(id);
    this.render();
    this.hooks.changed();
  }
}
