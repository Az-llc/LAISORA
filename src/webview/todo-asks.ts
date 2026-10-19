import * as l10n from "@vscode/l10n";
import type { AskBlock } from "../ask-parser";
import { parseMarkdown } from "../markdown-ast";
import type { TodoAskSourceMessage, TodoAskSourceMessageEnvelope, TodoAskSourceRef, TodoAskWhere, TodoTabItem, WebviewToHost } from "../protocol";
import { askOtherChoice } from "./ask-view";
import { todoButton, todoEl as el } from "./todo-edit";
import { createYouItems, isWaitingYouItem, type AskIdentity, type YouItem, type YouItemsReader } from "./you-items";
import { youWaitingKindLabel } from "./you-list";

export const TODO_ASK_OPEN_WAIT_MS = 60_000;
const TODO_ASK_JUMP_POLL_MS = 500;

export function askNodesIn(text: string): Array<{ ask: AskBlock; offset: number }> {
  const found: Array<{ ask: AskBlock; offset: number }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (node.type === "ask") { found.push({ ask: node.ask as AskBlock, offset: node.offset as number }); return; }
    for (const child of Object.values(node)) if (typeof child === "object" && child !== null) visit(child);
  };
  visit(parseMarkdown(text));
  return found.sort((a, b) => a.offset - b.offset);
}

export interface SavedMessageAskState {
  readonly dismissed: readonly string[];
  readonly resolved: readonly string[];
  readonly checked: Readonly<Record<string, readonly boolean[]>>;
}

export function recordAskStore(sessionId: string, messages: readonly TodoAskSourceMessage[], saved: SavedMessageAskState, otherChoice?: string) {
  const store = createYouItems(`record:${sessionId}`, { messages: saved.dismissed, resolvedMessages: saved.resolved }, (replyId) => ({ message: replyId, start: 0 }), otherChoice);
  let turn = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turn++;
      store.reply(message.uuid, message.timestamp, undefined, undefined, message.text);
      continue;
    }
    for (const { ask, offset } of askNodesIn(message.text)) {
      const anchor = store.ask(ask, { replyId: message.uuid, offset, createdAt: message.timestamp, turn: `turn:${turn}` });
      store.tick(anchor, (step) => saved.checked[store.messageOf(anchor) ?? ""]?.[step] === true);
    }
  }
  return store;
}

const isDeclaredAsk = (item: YouItem): boolean => item.anchor.approvalRef === undefined && item.resolution !== "historical";

export interface TodoAskRecordView {
  readonly keys: ReadonlySet<string>;
  readonly endedAt: number;
}

export function todoAskTabAdditions(items: readonly YouItem[], record: TodoAskRecordView | undefined, messageOf: (item: YouItem) => string | undefined): YouItem[] {
  return items.filter(item => {
    if (!isDeclaredAsk(item) || record === undefined) return true;
    const key = messageOf(item);
    return key !== undefined ? !record.keys.has(key) : item.createdAt > record.endedAt;
  });
}

export type TodoAskOrigin =
  | { readonly kind: "tab"; readonly tabId: string; readonly title: string }
  | { readonly kind: "record"; readonly sessionId: string; readonly where: TodoAskWhere; readonly title?: string };

export interface TodoAskEntry {
  readonly origin: TodoAskOrigin;
  readonly items: readonly YouItem[];
  readonly message?: (item: YouItem) => string | undefined;
}

export interface TodoAskSource {
  readonly itemId: string;
  readonly entries: readonly TodoAskEntry[];
  readonly unreadable?: boolean;
}

export type TodoAskStale = "age" | "moved-on";

export interface TodoAskRow {
  readonly key: string;
  readonly itemId: string;
  readonly item: YouItem;
  readonly origin: TodoAskOrigin;
  readonly message?: string;
  readonly answerOnly: boolean;
  readonly stale: TodoAskStale | null;
}

export const TODO_ASK_STALE_LATER_REPLIES = 2;
export const TODO_ASK_STALE_MS = 7 * 24 * 60 * 60_000;

export function todoAskStale(item: YouItem, siblings: readonly YouItem[], now: number): TodoAskStale | null {
  if (!isDeclaredAsk(item) || item.createdAt <= 0) return null;
  if (now - item.createdAt >= TODO_ASK_STALE_MS) return "age";
  const later = new Set(siblings.filter(other => isDeclaredAsk(other) && other.createdAt > item.createdAt && other.turn !== item.turn).map(other => other.turn ?? other.id));
  return later.size >= TODO_ASK_STALE_LATER_REPLIES ? "moved-on" : null;
}

const originKey = (origin: TodoAskOrigin): string => origin.kind === "tab" ? `tab:${origin.tabId}` : `record:${origin.sessionId}`;

export function todoAskRows(sources: readonly TodoAskSource[], now: number): { byItem: Map<string, TodoAskRow[]>; count: number; nextStaleAt: number | null; unreadable: Set<string> } {
  const byItem = new Map<string, TodoAskRow[]>();
  const unreadable = new Set<string>();
  let count = 0;
  let nextStaleAt: number | null = null;
  for (const source of sources) {
    if (source.unreadable) unreadable.add(source.itemId);
    const siblings = source.entries.flatMap(entry => entry.items);
    for (const entry of source.entries) {
      for (const item of entry.items) {
        if (!isWaitingYouItem(item)) continue;
        let rows = byItem.get(source.itemId);
        if (!rows) byItem.set(source.itemId, rows = []);
        const stale = todoAskStale(item, siblings, now);
        const message = entry.message?.(item);
        rows.push({ key: `${originKey(entry.origin)}|${item.id}`, itemId: source.itemId, item, origin: entry.origin, ...(message !== undefined ? { message } : {}),
          answerOnly: item.anchor.approvalRef !== undefined, stale });
        if (stale) continue;
        count++;
        if (isDeclaredAsk(item) && item.createdAt > 0) nextStaleAt = Math.min(nextStaleAt ?? Infinity, item.createdAt + TODO_ASK_STALE_MS);
      }
    }
  }
  for (const rows of byItem.values()) rows.sort((a, b) => Number(a.stale !== null) - Number(b.stale !== null) || a.item.createdAt - b.item.createdAt || a.key.localeCompare(b.key));
  return { byItem, count, nextStaleAt, unreadable };
}

export interface TodoAskTab {
  readonly tabId: string;
  readonly title: string;
  readonly reader: YouItemsReader;
  messageOf(item: YouItem): string | undefined;
}

export type TodoAskHistoryState = "loading" | "done" | "failed";

export interface TodoAskHost {
  tabs(): readonly TodoAskTab[];
  open(tabId: string, item: YouItem): void;
  activate(tabId: string): void;
  dismiss(tabId: string, item: YouItem): void;
  findByMessage(tabId: string, message: string): YouItem | undefined;
  historyState(tabId: string): TodoAskHistoryState;
  applyDismissals(messages: readonly string[]): void;
  persistDismissals(identities: readonly AskIdentity[]): void;
  savedState(): SavedMessageAskState;
  notice(text: string): void;
  post(message: WebviewToHost): void;
}

type RecordStore = ReturnType<typeof recordAskStore>;

interface PendingJump {
  readonly itemId: string;
  readonly message: string;
  readonly openBy: number;
  activated?: string;
}

let closedInTodo: ReadonlySet<string> = new Set();
const closedInTodoListeners = new Set<() => void>();

export function todoAsksClosedInTodo(): ReadonlySet<string> {
  return closedInTodo;
}

export function onTodoAsksClosedInTodo(listener: () => void): () => void {
  closedInTodoListeners.add(listener);
  return () => closedInTodoListeners.delete(listener);
}

function setClosedInTodo(messages: Iterable<string>): void {
  const next = new Set(messages);
  if (next.size === closedInTodo.size && [...next].every(message => closedInTodo.has(message))) return;
  closedInTodo = next;
  for (const listener of closedInTodoListeners) listener();
}

export class TodoAskBoard {
  private dismissingInTodo = false;
  private readonly todoDismissedContent = new Set<string>();
  private tabItems: readonly TodoTabItem[] = [];
  private refs: readonly TodoAskSourceRef[] = [];
  private dismissals = new Set<string>();
  private readonly records = new Map<string, { key: string; endedAt: number; store: RecordStore }>();
  private readonly failed = new Set<string>();
  private readonly requested = new Map<string, { requestId: number; key: string }>();
  private requestSeq = 0;
  private readonly subscriptions = new Map<string, { reader: YouItemsReader; unsubscribe: () => void }>();
  private pending: PendingJump | null = null;
  private pendingTimer: ReturnType<typeof setInterval> | undefined;
  private scheduled = false;

  constructor(private readonly host: TodoAskHost, private readonly changed: () => void) {}

  apply(tabItems: readonly TodoTabItem[], refs: readonly TodoAskSourceRef[], dismissals: readonly string[], closed: readonly string[]): void {
    setClosedInTodo(closed);
    this.tabItems = tabItems;
    this.refs = refs;
    const wanted = new Map(refs.map(ref => [ref.sessionId, ref]));
    for (const sessionId of [...this.records.keys(), ...this.requested.keys(), ...this.failed]) {
      if (wanted.has(sessionId)) continue;
      this.records.delete(sessionId);
      this.requested.delete(sessionId);
      this.failed.delete(sessionId);
    }
    for (const ref of refs) {
      if (ref.key === null) {
        this.records.delete(ref.sessionId);
        this.requested.delete(ref.sessionId);
        this.failed.add(ref.sessionId);
        continue;
      }
      if (this.records.get(ref.sessionId)?.key === ref.key || this.requested.get(ref.sessionId)?.key === ref.key) continue;
      const requestId = ++this.requestSeq;
      this.requested.set(ref.sessionId, { requestId, key: ref.key });
      this.host.post({ type: "todoAskSourceRequest", sessionId: ref.sessionId, requestId });
    }
    const added = dismissals.filter(message => !this.dismissals.has(message));
    this.dismissals = new Set(dismissals);
    if (added.length > 0) this.spreadDismissals(added);
    this.syncTabs();
    this.tryJump();
  }

  clear(): void {
    this.tabItems = [];
    this.refs = [];
    this.dismissals.clear();
    this.todoDismissedContent.clear();
    setClosedInTodo([]);
    this.records.clear();
    this.failed.clear();
    this.requested.clear();
    this.stopJump();
    for (const entry of this.subscriptions.values()) entry.unsubscribe();
    this.subscriptions.clear();
  }

  receive(message: TodoAskSourceMessageEnvelope): void {
    if (this.requested.get(message.sessionId)?.requestId !== message.requestId) return;
    this.requested.delete(message.sessionId);
    if (message.key === null) {
      this.records.delete(message.sessionId);
      this.failed.add(message.sessionId);
    } else {
      this.failed.delete(message.sessionId);
      const saved = this.host.savedState();
      this.records.set(message.sessionId, { key: message.key, endedAt: message.endedAt,
        store: recordAskStore(message.sessionId, message.messages, { ...saved, dismissed: [...saved.dismissed, ...this.dismissals] }, askOtherChoice()) });
    }
    this.schedule();
    this.tryJump();
  }

  noteTabDismissal(tabId: string, identity: AskIdentity): void {
    const itemId = this.tabItems.find(entry => entry.tabId === tabId)?.itemId;
    if (this.dismissingInTodo && identity.message === undefined) this.todoDismissedContent.add(identity.content);
    if (identity.message === undefined || itemId === undefined) return;
    const place = this.dismissingInTodo || this.todoDismissedContent.delete(identity.content) ? "todo" : "chat";
    this.dismissals.add(identity.message);
    if (place === "todo") setClosedInTodo([...closedInTodo, identity.message]);
    for (const record of this.records.values()) record.store.dismissMessages([identity.message]);
    this.host.post({ type: "todoAskDismiss", itemId, message: identity.message, place });
    this.schedule();
  }

  syncTabs(): void {
    const tabs = this.host.tabs();
    const present = new Set(tabs.map(tab => tab.tabId));
    for (const [tabId, entry] of this.subscriptions) {
      if (present.has(tabId)) continue;
      entry.unsubscribe();
      this.subscriptions.delete(tabId);
    }
    let added = false;
    for (const tab of tabs) {
      const known = this.subscriptions.get(tab.tabId);
      if (known?.reader === tab.reader) continue;
      known?.unsubscribe();
      added = true;
      this.subscriptions.set(tab.tabId, { reader: tab.reader, unsubscribe: tab.reader.subscribe(() => this.onTabItems()) });
    }
    if (added && this.dismissals.size > 0) this.host.applyDismissals([...this.dismissals]);
    this.schedule();
  }

  rows(liveItemIds: ReadonlySet<string>, now: number): ReturnType<typeof todoAskRows> {
    const tabs = new Map(this.host.tabs().map(tab => [tab.tabId, tab]));
    const tabsOf = new Map<string, TodoAskTab[]>();
    for (const entry of this.tabItems) {
      const tab = tabs.get(entry.tabId);
      if (!tab) continue;
      const list = tabsOf.get(entry.itemId) ?? [];
      list.push(tab);
      tabsOf.set(entry.itemId, list);
    }
    const refOf = new Map(this.refs.map(ref => [ref.itemId, ref]));
    const sources: TodoAskSource[] = [];
    for (const itemId of new Set([...refOf.keys(), ...tabsOf.keys()])) {
      if (!liveItemIds.has(itemId)) continue;
      const ref = refOf.get(itemId);
      const record = ref ? this.records.get(ref.sessionId) : undefined;
      const itemTabs = tabsOf.get(itemId) ?? [];
      const entries: TodoAskEntry[] = [];
      let view: TodoAskRecordView | undefined;
      if (ref && record) {
        const store = record.store;
        const items = store.reader.get();
        view = { endedAt: record.endedAt, keys: new Set(items.flatMap(item => store.messageOf(item.anchor.id) ?? [])) };
        entries.push({ origin: { kind: "record", sessionId: ref.sessionId, where: ref.where, ...(itemTabs[0] && ref.where === "here" ? { title: itemTabs[0].title } : {}) },
          items, message: item => store.messageOf(item.anchor.id) });
      }
      for (const tab of itemTabs) entries.push({ origin: { kind: "tab", tabId: tab.tabId, title: tab.title }, items: todoAskTabAdditions(tab.reader.get(), view, item => tab.messageOf(item)) });
      sources.push({ itemId, entries, unreadable: ref !== undefined && ref.where !== "here" && this.failed.has(ref.sessionId) });
    }
    return todoAskRows(sources, now);
  }

  answer(row: TodoAskRow): void {
    if (row.origin.kind === "tab") {
      this.host.open(row.origin.tabId, row.item);
      return;
    }
    if (row.message === undefined) return;
    this.stopJump();
    this.pending = { itemId: row.itemId, message: row.message, openBy: Date.now() + TODO_ASK_OPEN_WAIT_MS };
    this.pendingTimer = setInterval(() => this.tryJump(), TODO_ASK_JUMP_POLL_MS);
    this.host.post({ type: "todoOpenConversation", itemId: row.itemId, fresh: false });
    this.tryJump();
  }

  done(row: TodoAskRow): void {
    if (row.answerOnly) return;
    if (row.origin.kind === "tab") {
      this.dismissingInTodo = true;
      try { this.host.dismiss(row.origin.tabId, row.item); } finally { this.dismissingInTodo = false; }
      return;
    }
    const message = row.message;
    if (message === undefined) return;
    const store = this.records.get(row.origin.sessionId)?.store;
    const identity = store?.dismiss(row.item.id);
    this.dismissals.add(message);
    if (identity !== undefined) this.host.persistDismissals([identity]);
    setClosedInTodo([...closedInTodo, message]);
    this.host.applyDismissals([message]);
    this.host.post({ type: "todoAskDismiss", itemId: row.itemId, message, place: "todo" });
    this.schedule();
  }

  private spreadDismissals(messages: readonly string[]): void {
    for (const record of this.records.values()) record.store.dismissMessages(messages);
    this.host.applyDismissals(messages);
    this.schedule();
  }

  private stopJump(): void {
    clearInterval(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pending = null;
  }

  private tryJump(): void {
    const pending = this.pending;
    if (pending === null) return;
    const tabId = this.tabItems.find(entry => entry.itemId === pending.itemId && this.subscriptions.has(entry.tabId))?.tabId;
    if (tabId === undefined) {
      if (Date.now() <= pending.openBy) return;
      this.stopJump();
      this.host.notice(l10n.t("The conversation of this question did not open in this window."));
      return;
    }
    if (pending.activated !== tabId) {
      pending.activated = tabId;
      this.host.activate(tabId);
    }
    const item = this.host.findByMessage(tabId, pending.message);
    if (item) {
      this.stopJump();
      setTimeout(() => this.host.open(tabId, item), 0);
      return;
    }
    if (this.host.historyState(tabId) === "loading") return;
    this.stopJump();
    this.host.notice(l10n.t("This question could not be found in the conversation's history. Look for it in the conversation."));
  }

  private onTabItems(): void {
    this.tryJump();
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.changed();
    });
  }
}

export function todoAskOriginLabel(origin: TodoAskOrigin): string {
  if (origin.kind === "tab" || origin.title !== undefined) return l10n.t("Conversation “{0}”", origin.title!);
  return origin.where === "elsewhere" ? l10n.t("Open in another window") : origin.where === "here" ? l10n.t("Open conversation") : l10n.t("Closed conversation");
}

export interface TodoAskActions {
  answer(row: TodoAskRow): void;
  done(row: TodoAskRow): void;
}

function focusAfterRemoval(node: HTMLElement): void {
  let next: Element | null = node.nextElementSibling;
  while (next && !next.classList.contains("todo-ask") && !next.classList.contains("todo-row")) next = next.nextElementSibling;
  const target = next?.classList.contains("todo-ask") ? next.querySelector<HTMLElement>("[data-focus-key]") : null;
  let row: Element | null = node.previousElementSibling;
  while (row && !row.classList.contains("todo-row")) row = row.previousElementSibling;
  const key = (target ?? (row as HTMLElement | null))?.dataset.focusKey;
  if (key === undefined) return;
  setTimeout(() => document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus(), 0);
}

export function todoAskNoteEl(text: string, depth: number): HTMLElement {
  const node = el("div", "todo-ask todo-ask-note", text);
  node.setAttribute("role", "listitem");
  node.style.setProperty("--todo-depth", String(depth));
  return node;
}

export function todoAskRowEl(row: TodoAskRow, depth: number, actions: TodoAskActions, focusKey: (kind: string, id: string) => string): HTMLElement {
  const node = el("div", `todo-ask${row.stale ? " stale" : ""}`);
  node.setAttribute("role", "listitem");
  node.style.setProperty("--todo-depth", String(depth));
  node.dataset.askKey = row.key;
  const square = el("span", "you-square");
  square.setAttribute("aria-hidden", "true");
  const meta = el("div", "todo-ask-meta");
  if (row.stale) {
    const tag = el("span", "todo-ask-stale", l10n.t("Probably not needed"));
    tag.title = row.stale === "age"
      ? l10n.t("Asked a week or more ago and still not answered. It is not counted as waiting; mark it as done if it is settled.")
      : l10n.t("The conversation has moved on since this question. It is not counted as waiting; mark it as done if it is settled.");
    meta.append(tag);
  }
  meta.append(el("span", "todo-ask-src", todoAskOriginLabel(row.origin)));
  const acts = el("div", "todo-ask-acts");
  const answer = todoButton("todo-link", l10n.t("Answer in the conversation"), () => actions.answer(row),
    l10n.t("Go to this question in its conversation and answer there"));
  answer.dataset.focusKey = focusKey("ask-answer", row.key);
  acts.append(answer);
  if (!row.answerOnly) {
    const done = todoButton("todo-link", l10n.t("Mark as done"), () => {
      focusAfterRemoval(node);
      actions.done(row);
    }, l10n.t("Close without answering (when it was settled elsewhere). It closes in its conversation too, in every window."));
    done.dataset.focusKey = focusKey("ask-done", row.key);
    acts.append(done);
  }
  node.append(square, el("span", "you-kind", youWaitingKindLabel(row.item)), el("div", "todo-ask-q", row.item.title), meta, acts);
  return node;
}
