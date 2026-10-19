import * as l10n from "@vscode/l10n";
import { TODO_CHANGES_REQUEST_MAX, type TodoChangeView, type TodoListItem, type TodoStartView, type TodoTurnRevert } from "../protocol";
import { parseTodoChangeId, TODO_CARD_TOOLS, TODO_CLAUDE_DEPTH_MAX, TODO_TIDY_TOOL, todoCardTree, todoFailureOf, todoWriteResultRef, type TodoCardMark, type TodoCardRow, type TodoRevertBlock, type TodoStartKind, type TodoWriteResultRef } from "../todo-model";
import { formatDateTime } from "./l10n";
import { summaryCardShell, summaryFold, summaryStat, type SummaryTone } from "./summary-card";
import { describeTodoChange, TODO_MEMO_LABELS, TODO_REVERT_BLOCK_TEXT, todoButton, todoEl as el } from "./todo-edit";
import { todoGroupCss, todoItemLabel, todoItemOf, todoLinkHub } from "./todo-links";
import { todoItemPath } from "./todo-rows";

type CardCall =
  | { readonly state: "pending"; readonly tidy: boolean }
  | { readonly state: "written"; readonly tidy: boolean; readonly ref: TodoWriteResultRef }
  | { readonly state: "failed"; readonly tidy: boolean; readonly text: string }
  | { readonly state: "unrecorded"; readonly tidy: boolean };

const TODO_CARD_FOLDED_ROWS = 6;
const cards = new Set<HTMLElement>();
const cardCalls = new WeakMap<HTMLElement, Map<string, CardCall>>();
const statusEls = new WeakMap<HTMLElement, HTMLElement>();
const unfolded = new WeakSet<HTMLElement>();
const views = new Map<string, TodoChangeView>();
const turnReverts = new Map<string, "ok" | TodoRevertBlock>();
let viewsRevision = -1;
let requestSeq = 0;
let requested = new Set<string>();
let requestedTurns = new Map<string, readonly number[]>();
let sentTurns = new Set<string>();
let answeredRevisions = new Set<number>();
let inFlight = new Map<number, readonly (readonly number[])[]>();
let flushQueued = false;

export function isTodoWriteTool(toolName: string): boolean {
  return todoLinkHub() !== null && TODO_CARD_TOOLS.includes(toolName);
}

export function todoToolCard(toolUseId: string, toolName: string): HTMLElement {
  const card = el("section", "todo-tool-card");
  cards.add(card);
  cardCalls.set(card, new Map());
  addTodoToolCall(card, toolUseId, toolName);
  return card;
}

export function addTodoToolCall(card: HTMLElement, toolUseId: string, toolName: string): void {
  const calls = cardCalls.get(card);
  if (!calls || calls.has(toolUseId)) return;
  calls.set(toolUseId, { state: "pending", tidy: toolName === TODO_TIDY_TOOL });
  renderCard(card);
}

function cardStatus(card: HTMLElement): HTMLElement {
  let status = statusEls.get(card);
  if (!status) {
    status = el("span", "todo-tool-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    statusEls.set(card, status);
  }
  return status;
}

export function setTodoToolCardResult(card: HTMLElement, toolUseId: string, result: string | undefined, isError: boolean, live = true): void {
  const calls = cardCalls.get(card);
  const call = calls?.get(toolUseId);
  if (!calls || !call) return;
  const ref = isError ? undefined : todoWriteResultRef(result);
  calls.set(toolUseId, ref !== undefined ? { state: "written", tidy: call.tidy, ref }
    : isError ? { state: "failed", tidy: call.tidy, text: result ?? "" } : { state: "unrecorded", tidy: call.tidy });
  if (live) cardStatus(card).textContent = isError ? todoCardFailureText(result) : l10n.t("Wrote to ToDo.");
  renderCard(card);
  if (ref) queueRequest([card]);
}

function cardRefs(card: HTMLElement): TodoWriteResultRef[] {
  return [...cardCalls.get(card)?.values() ?? []].flatMap(call => call.state === "written" ? [call.ref] : []);
}

function cardRevisions(card: HTMLElement): number[] {
  return [...new Set(cardRefs(card).flatMap(ref => "revision" in ref ? [ref.revision] : []))].sort((a, b) => a - b);
}

const turnKey = (revisions: readonly number[]) => revisions.join(",");

function revisionIds(revision: number): string[] {
  return [...views.keys()].filter(id => parseTodoChangeId(id).revision === revision).sort((a, b) => parseTodoChangeId(a).index - parseTodoChangeId(b).index);
}

function cardIds(card: HTMLElement): { ids: string[]; legacy: string[]; waiting: boolean; lost: number } {
  const ids: string[] = [];
  const legacy: string[] = [];
  let waiting = false, lost = 0;
  for (const ref of cardRefs(card)) {
    if ("ids" in ref) { ids.push(...ref.ids); legacy.push(...ref.ids); continue; }
    if (!answeredRevisions.has(ref.revision)) { waiting = true; continue; }
    const found = revisionIds(ref.revision);
    if (found.length === 0) lost++;
    ids.push(...found);
  }
  return { ids, legacy, waiting, lost };
}

export function receiveTodoChanges(message: { readonly requestId: number; readonly revision: number; readonly changes: readonly TodoChangeView[]; readonly turns?: readonly TodoTurnRevert[]; readonly more?: true }): void {
  const asked = inFlight.get(message.requestId);
  if (!message.more) inFlight.delete(message.requestId);
  if (message.revision < viewsRevision) {
    if (asked && !message.more) {
      for (const group of asked) sentTurns.delete(turnKey(group));
      queueRequest([...cards]);
    }
    return;
  }
  viewsRevision = message.revision;
  for (const change of message.changes) views.set(change.id, change);
  for (const turn of message.turns ?? []) turnReverts.set(turnKey(turn.revisions), turn.revert);
  if (asked && !message.more) for (const group of asked) for (const revision of group) answeredRevisions.add(revision);
  for (const card of cards) renderCard(card);
}

export function refreshTodoToolCards(revision: number): void {
  if (revision === viewsRevision) return;
  views.clear();
  turnReverts.clear();
  requested = new Set();
  requestedTurns = new Map();
  sentTurns = new Set();
  answeredRevisions = new Set();
  inFlight = new Map();
  for (const card of [...cards]) if (!card.isConnected && card.dataset.seen === "1") cards.delete(card);
  queueRequest([...cards]);
}

function queueRequest(asking: readonly HTMLElement[]): void {
  for (const card of asking) {
    for (const ref of cardRefs(card)) if ("ids" in ref) for (const id of ref.ids) { if (!views.has(id)) requested.add(id); }
    const revisions = cardRevisions(card);
    if (revisions.length && !sentTurns.has(turnKey(revisions))) requestedTurns.set(turnKey(revisions), revisions);
  }
  if (flushQueued || (requested.size === 0 && requestedTurns.size === 0)) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const links = todoLinkHub();
    if (!links) return;
    const ids = [...requested].slice(0, TODO_CHANGES_REQUEST_MAX);
    requested = new Set([...requested].slice(TODO_CHANGES_REQUEST_MAX));
    const groups: number[][] = [];
    let total = 0;
    for (const [key, group] of requestedTurns) {
      if (groups.length > 0 && total + group.length > TODO_CHANGES_REQUEST_MAX) break;
      const taken = group.slice(-TODO_CHANGES_REQUEST_MAX);
      groups.push(taken);
      total += taken.length;
      requestedTurns.delete(key);
      sentTurns.add(key);
    }
    const requestId = ++requestSeq;
    inFlight.set(requestId, groups);
    links.post({ type: "todoChangesRequest", requestId, ids, ...(groups.length ? { revisions: groups } : {}) });
    if (requested.size || requestedTurns.size) queueRequest([]);
  });
}

const CARD_SIGN: Record<TodoCardMark, string> = { "-": "−", "+": "＋", "~": "～" };
const CARD_TONE: Record<TodoCardMark, SummaryTone> = { "-": "removed", "+": "added", "~": "muted" };

function groupOrderOf(items: readonly TodoListItem[], numberOf: (id: string) => string): string[] {
  const roots = items.filter(item => item.parentId === null && item.group !== undefined).sort((a, b) => Number(numberOf(a.id)) - Number(numberOf(b.id)));
  return [...new Set(roots.map(item => item.group!))];
}

const UNSTABLE_TEXT: Record<string, () => string> = {
  doing: () => l10n.t("Left it as it is: work on it is in progress."),
  touched: () => l10n.t("Left it as it is: you changed it recently."),
  pinned: () => l10n.t("Left it as it is: you moved it recently."),
  moved: () => l10n.t("Left it as it is: it was moved recently."),
};

const FAILURE_TEXT: Record<string, () => string> = {
  "user-item": () => l10n.t("Left your item as it is."),
  "group-has-user-items": () => l10n.t("Did not delete the group: it holds your items."),
  "duplicate-title": () => l10n.t("Not added: the same item is already there."),
  "unknown-group": () => l10n.t("Not written: no group matched."),
  "near-group": () => l10n.t("Not written: no group matched."),
  "too-deep": () => l10n.t("Not written: deeper than {0} levels.", TODO_CLAUDE_DEPTH_MAX),
  "title-repeats": () => l10n.t("Not written: the title did not follow the rules."),
  "title-state": () => l10n.t("Not written: the title did not follow the rules."),
  "outside-linked": () => l10n.t("Not marked done: it is outside this conversation's item."),
  "merge-done": () => l10n.t("Not merged: done items stay."),
};

export function todoCardFailureText(text: string | undefined): string {
  const failure = todoFailureOf(text);
  if (failure?.error === "unstable" && failure.word !== undefined && UNSTABLE_TEXT[failure.word]) return UNSTABLE_TEXT[failure.word]();
  if (failure?.error.startsWith("store-")) return l10n.t("Could not write to the ToDo list.");
  const known = failure ? FAILURE_TEXT[failure.error] : undefined;
  return known ? known() : l10n.t("Failed to write to ToDo.");
}

function renderCard(card: HTMLElement): void {
  const links = todoLinkHub();
  const calls = [...cardCalls.get(card)?.values() ?? []];
  if (card.isConnected) card.dataset.seen = "1";
  if (!links) return;
  const { ids, legacy, waiting, lost } = cardIds(card);
  const changes = ids.flatMap(id => views.get(id) ?? []).filter(change => !change.cascade);
  const missing = ids.length - ids.filter(id => views.has(id)).length + lost;
  const items = links.items();
  const numberOf = (id: string) => links.numberOf(id);
  const rows = todoCardTree(changes, items, groupOrderOf(items, numberOf), id => numberOf(id) || undefined);
  const tidied = calls.some(call => call.tidy && call.state === "written");
  const stat = summaryStat((["-", "+", "~"] as const).flatMap(mark => {
    const count = rows.filter(row => row.mark === mark).length;
    return count ? [{ text: `${CARD_SIGN[mark]}${count}`, tone: CARD_TONE[mark] }] : [];
  }));
  const title = rows.length ? tidied ? l10n.t("Tidied up ToDo") : l10n.t("Updated ToDo") : l10n.t("ToDo writes");
  card.replaceChildren();
  const back = rows.length ? revertAllEl(card, changes, legacy) : null;
  const { list } = summaryCardShell(card, title, ...(rows.length ? [stat] : []), ...(back ? [back] : []));
  const overflow: HTMLElement[] = [];
  rows.forEach((row, index) => {
    const node = rowEl(row);
    if (index >= TODO_CARD_FOLDED_ROWS) overflow.push(node);
    list.append(node);
  });
  summaryFold(card, overflow, rows.length, unfolded.has(card), expand => { if (expand) unfolded.add(card); else unfolded.delete(card); },
    hidden => l10n.t("⋯ {0} more · Show all", hidden));
  const failures = new Map<string, string[]>();
  for (const call of calls) if (call.state === "failed") failures.set(todoCardFailureText(call.text), [...failures.get(todoCardFailureText(call.text)) ?? [], call.text]);
  for (const [line, raw] of failures) {
    const node = el("p", "todo-tool-error", line);
    node.title = raw.filter(Boolean).join("\n");
    card.append(node);
  }
  if (calls.some(call => call.state === "pending")) card.append(el("p", "todo-tool-note", l10n.t("Writing to ToDo…")));
  else if (waiting && rows.length === 0) card.append(el("p", "todo-tool-note", l10n.t("Loading…")));
  else if (missing > 0 && !waiting) card.append(el("p", "todo-tool-note", l10n.t("These changes are no longer kept in the ToDo history.")));
  else if (rows.length === 0 && failures.size === 0) card.append(el("p", "todo-tool-note", l10n.t("No change recorded.")));
  card.append(cardStatus(card));
}

function revertAllEl(card: HTMLElement, changes: readonly TodoChangeView[], legacy: readonly string[]): HTMLElement | null {
  const links = todoLinkHub()!;
  const own = changes.filter(change => change.author === "claude");
  if (own.length === 0) return null;
  if (own.every(change => change.revert === "reverted")) return el("span", "todo-tool-state", l10n.t("Taken back"));
  const revisions = cardRevisions(card);
  const byRevision = legacy.length === 0 && revisions.length > 0;
  const block = byRevision ? turnReverts.get(turnKey(revisions)) : own.find(change => change.revert !== "ok")?.revert ?? "ok";
  if (block === "ok") {
    return todoButton("todo-link todo-tool-revert", l10n.t("Take all back"),
      () => links.edit(byRevision ? { kind: "revertClaude", revisions } : { kind: "revertClaude", changeIds: own.map(change => change.id).slice(0, TODO_CHANGES_REQUEST_MAX) }),
      l10n.t("Take back everything this turn wrote to ToDo (your own undo is not used)"));
  }
  if (block === undefined || block === "not-target") return null;
  const state = el("span", "todo-tool-state", TODO_REVERT_BLOCK_TEXT[block]());
  if (block === "in-use") state.title = l10n.t("A group that still has items is not undone; move or delete its items first.");
  return state;
}

function rowHover(row: TodoCardRow<TodoChangeView>): string {
  const lines = [
    ...(row.previousTitle !== undefined ? [l10n.t("Before: {0}", row.previousTitle)] : []),
    ...new Set(row.changes.filter(change => change.field !== "item").map(describeTodoChange)),
  ];
  const at = Math.max(0, ...row.changes.map(change => change.at));
  return [...lines, ...(at > 0 ? [formatDateTime(at)] : [])].join("\n");
}

function rowEl(row: TodoCardRow<TodoChangeView>): HTMLElement {
  const links = todoLinkHub()!;
  const node = el("li", "");
  const line = el("div", `edit-summary-row todo-card-row${row.mark ? "" : " todo-card-context"}${row.mark === "-" ? " todo-card-removed" : ""}${row.itemId === undefined ? " todo-card-group" : ""}`);
  line.style.setProperty("--todo-depth", String(row.depth));
  node.append(line);
  const reverted = row.changes.length > 0 && row.changes.every(change => change.revert === "reverted");
  line.classList.toggle("undone", reverted);
  line.append(el("span", "todo-card-num", row.number));
  const live = row.itemId !== undefined && row.mark !== "-" ? todoItemOf(row.itemId) : undefined;
  const label = row.itemId === undefined ? row.group ?? l10n.t("No group") : row.title;
  if (live) {
    const open = todoButton("todo-link todo-card-title edit-summary-name", label, () => links.reveal(live.id), l10n.t("Show this item in the conversation's ToDo drawer"));
    open.style.setProperty("--todo-gc", todoGroupCss(live));
    line.append(open);
  } else {
    line.append(el("span", "todo-card-title edit-summary-name", label));
  }
  if (row.mark) line.append(el("span", `todo-card-mark edit-summary-${CARD_TONE[row.mark]}`, CARD_SIGN[row.mark]));
  const hover = rowHover(row);
  if (hover) line.title = hover;
  return node;
}

const START_LABELS: Record<TodoStartKind, () => string> = {
  start: () => l10n.t("Started from ToDo"),
  continue: () => l10n.t("Continued from ToDo in a new conversation"),
  child: () => l10n.t("Split from ToDo as a child conversation"),
};

export function renderTodoHead(head: HTMLElement, tabId: string): void {
  const links = todoLinkHub();
  head.replaceChildren();
  if (!links) { head.hidden = true; return; }
  const entry = links.tabItem(tabId);
  const item = entry ? todoItemOf(entry.itemId) : undefined;
  if (!entry || !item) {
    head.hidden = false;
    head.append(el("p", "todo-empty-hint", l10n.t("Paste an image or describe the work, and Claude puts it into ToDo directly. Take it all back from the ToDo card in the conversation, or one change at a time from History.")));
    return;
  }
  head.hidden = entry.start === undefined && (entry.splits ?? []).length === 0;
  if (entry.start) head.append(startCard(item.id, entry.start, entry.decisions));
  for (const split of entry.splits ?? []) {
    const child = todoItemOf(split.itemId);
    if (!child) continue;
    const line = el("div", "todo-split-line");
    line.style.setProperty("--todo-gc", todoGroupCss(child));
    line.append(el("span", "todo-split-text", l10n.t("Split {0} into a child conversation; only its brief was passed.", todoItemLabel(child))),
      todoButton("todo-link", l10n.t("Open"), () => links.openConversation(child.id), l10n.t("Go to the child conversation's tab")));
    head.append(line);
  }
}

function startCard(itemId: string, start: TodoStartView, decisions: string | undefined): HTMLElement {
  const item = todoItemOf(itemId)!;
  const card = el("section", "todo-start-card");
  card.style.setProperty("--todo-gc", todoGroupCss(item));
  card.append(el("div", "todo-start-head", START_LABELS[start.kind]()));
  const memo = (label: string, text: string | undefined) => {
    const row = el("div", "todo-start-memo");
    row.append(el("span", "todo-start-label", label), el("span", "todo-start-text", text ?? l10n.t("None yet")));
    return row;
  };
  card.append(memo(TODO_MEMO_LABELS.current(), start.current), memo(TODO_MEMO_LABELS.next(), start.next));
  const passed = document.createElement("details");
  passed.className = "todo-start-passed";
  const summary = document.createElement("summary");
  summary.textContent = l10n.t("What was passed to the conversation");
  passed.append(summary, el("div", "todo-start-item", todoItemLabel(item)), el("pre", "todo-start-brief", start.brief));
  if (start.stale) passed.append(el("div", "todo-start-stale", l10n.t("The work memo may have been out of date when this conversation started.")));
  card.append(passed);
  if (decisions !== undefined) card.append(memo(l10n.t("Decided (current)"), decisions));
  return card;
}

export function todoSplitCard(itemId: string, reason: string, tabId: string | undefined): HTMLElement {
  const card = el("div", "todo-split-card");
  card.dataset.todoSplitItem = itemId;
  card.dataset.todoSplitReason = reason;
  if (tabId !== undefined) card.dataset.todoSplitTab = tabId;
  splitCards.add(card);
  fillSplitCard(card);
  return card;
}

function splitTarget(card: HTMLElement): TodoListItem | undefined {
  const links = todoLinkHub();
  const item = todoItemOf(card.dataset.todoSplitItem ?? "");
  const tabId = card.dataset.todoSplitTab;
  if (!links || !item || item.parentId === null || tabId === undefined) return undefined;
  const owner = links.tabItem(tabId)?.itemId;
  return owner !== undefined && owner !== item.id && todoItemPath(links.items(), item.id).some(step => step.id === owner) ? item : undefined;
}

function fillSplitCard(card: HTMLElement): void {
  const item = splitTarget(card);
  card.hidden = item === undefined;
  if (!item) { card.replaceChildren(); return; }
  card.style.setProperty("--todo-gc", todoGroupCss(item));
  let acts = card.querySelector<HTMLElement>(".todo-split-acts");
  if (!acts) {
    acts = el("div", "todo-split-acts");
    card.replaceChildren(el("div", "todo-split-head", l10n.t("Suggestion: split into a child conversation")), el("div", "todo-split-item", todoItemLabel(item)),
      el("div", "todo-split-reason", card.dataset.todoSplitReason ?? ""), acts);
  }
  fillSplitActs(acts, item.id);
}

const splitCards = new Set<HTMLElement>();

function fillSplitActs(acts: HTMLElement, itemId: string): void {
  const links = todoLinkHub();
  const item = todoItemOf(itemId);
  acts.replaceChildren();
  if (!links || !item) return;
  if (item.talk !== undefined) {
    acts.append(todoButton("todo-link", l10n.t("Open"), () => links.openConversation(item.id), l10n.t("Go to the child conversation's tab")));
  } else if (links.splitDeclined(item.id)) {
    acts.append(el("span", "todo-note", l10n.t("Kept in the parent conversation")));
  } else {
    acts.append(todoButton("todo-link", l10n.t("Split and open…"), () => links.splitChild(item.id)),
      todoButton("todo-link", l10n.t("Keep working in the parent"), () => links.declineSplit(item.id)));
  }
}

export function refreshTodoSplitCards(): void {
  for (const card of [...splitCards]) {
    if (!card.isConnected) { if (card.dataset.seen === "1") splitCards.delete(card); continue; }
    card.dataset.seen = "1";
    fillSplitCard(card);
  }
}
