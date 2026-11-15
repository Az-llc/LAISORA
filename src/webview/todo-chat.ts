import * as l10n from "@vscode/l10n";
import { TODO_CHANGES_REQUEST_MAX, type HostToWebview, type TodoChangeView, type TodoListItem, type TodoStartView } from "../protocol";
import { parseTodoChangeId, TODO_CARD_TOOLS, TODO_TIDY_TOOL, todoCardTree, todoGenerations, todoRefResolves, todoWriteResultRef, type TodoCardMark, type TodoGeneration, type TodoCardRow, type TodoRevertBlock, type TodoStartKind, type TodoWriteResultRef } from "../todo-model";
import { formatDateTime } from "./l10n";
import { summaryCardShell, summaryFold, summaryStat, type SummaryTone } from "./summary-card";
import { describeTodoChange, TODO_MEMO_LABELS, TODO_REVERT_BLOCK_TEXT, todoButton, todoGenerationField } from "./todo-edit";
import { todoGroupCss, todoItemLabel, todoItemOf, todoLinkHub } from "./todo-links";
import { todoItemPath } from "./todo-rows";
import { element as el } from "./element";
import { todoGroupLabel } from "../todo-labels";

type CardCall =
  | { readonly state: "pending"; readonly tidy: boolean }
  | { readonly state: "written"; readonly tidy: boolean; readonly ref: TodoWriteResultRef }
  | { readonly state: "failed"; readonly tidy: boolean }
  | { readonly state: "unrecorded"; readonly tidy: boolean };

const TODO_CARD_FOLDED_ROWS = 6;
const cards = new Set<HTMLElement>();
const cardCalls = new WeakMap<HTMLElement, Map<string, CardCall>>();
const statusEls = new WeakMap<HTMLElement, HTMLElement>();
const unfolded = new WeakSet<HTMLElement>();
const unresolvedRows = new WeakSet<HTMLElement>();
const views = new Map<string, TodoChangeView>();
const turnReverts = new Map<string, "ok" | TodoRevertBlock>();
const answeredRevisions = new Set<number>();
let viewsGenerations: readonly TodoGeneration[] = todoGenerations({});
let storeRevision = -1;
let requestSeq = 0;
let flushQueued = false;
type AskState = { readonly at: number; readonly answered: boolean };
const asks = new Map<string, AskState>();
const pendingAsks = new Map<string, number>();
type ChangesAsked = { at: number; readonly keys: readonly string[]; readonly groups: readonly (readonly number[])[]; readonly received: Set<string> };
const inFlight = new Map<number, ChangesAsked>();
const toAsk = new Set<HTMLElement>();

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
    : isError ? { state: "failed", tidy: call.tidy } : { state: "unrecorded", tidy: call.tidy });
  if (live && ref !== undefined) cardStatus(card).textContent = l10n.t("Wrote to ToDo.");
  renderCard(card);
  if (ref) queueRequest([card]);
}

export function todoCardHidden(states: readonly CardCall["state"][]): boolean {
  return states.length > 0 && states.every(state => state === "failed");
}

function cardRefs(card: HTMLElement): TodoWriteResultRef[] {
  return [...cardCalls.get(card)?.values() ?? []].flatMap(call => call.state === "written" ? [call.ref] : []);
}

function cardRevisions(card: HTMLElement): number[] {
  return [...new Set(cardRefs(card).flatMap(ref => "revision" in ref ? [ref.revision] : []))].sort((a, b) => a - b);
}

const refResolves = (ref: Extract<TodoWriteResultRef, { revision: number }>) => todoRefResolves(viewsGenerations, ref.generation, ref.revision);

function cardTarget(card: HTMLElement): { revisions: number[]; generation?: string } | undefined {
  const refs = cardRefs(card).flatMap(ref => "revision" in ref ? [ref] : []);
  const generations = new Set(refs.map(ref => ref.generation));
  if (refs.length === 0 || !refs.every(refResolves) || generations.size !== 1) return undefined;
  const [generation] = generations;
  return { revisions: cardRevisions(card), ...todoGenerationField(generation) };
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
    if (!refResolves(ref)) { lost++; continue; }
    const found = revisionIds(ref.revision);
    if (found.length === 0) lost++;
    ids.push(...found);
  }
  return { ids, legacy, waiting, lost };
}

const idAsk = (id: string) => `id:${id}`;
const turnAsk = (revisions: readonly number[]) => `turn:${turnKey(revisions)}`;

function legacyIds(card: HTMLElement): string[] {
  return [...new Set(cardRefs(card).flatMap(ref => "ids" in ref ? ref.ids : []))];
}

function cardAskKeys(card: HTMLElement): string[] {
  const revisions = cardRevisions(card);
  return [...legacyIds(card).map(idAsk), ...revisions.length ? [turnAsk(revisions)] : []];
}

function askDue(key: string): boolean {
  const askedAt = pendingAsks.get(key);
  if (askedAt !== undefined && askedAt >= storeRevision) return false;
  const state = asks.get(key);
  return state === undefined || state.at < storeRevision;
}

function askFresh(key: string): boolean {
  const state = asks.get(key);
  return state !== undefined && state.answered && state.at >= storeRevision;
}

function settleAsks(asked: ChangesAsked, at: number, answered: boolean): void {
  for (const key of asked.keys) {
    if (pendingAsks.get(key) === asked.at) pendingAsks.delete(key);
    if (answered || (asks.get(key)?.at ?? -1) < at) asks.set(key, { at, answered });
  }
}

function noteStoreRevision(revision: number): void {
  if (revision <= storeRevision) return;
  storeRevision = revision;
  for (const card of [...cards]) if (!card.isConnected && card.dataset.seen === "1") cards.delete(card);
  dropUnreferencedViews();
  for (const card of cards) if (cardAskKeys(card).some(askDue)) renderCard(card);
  queueRequest([...cards]);
}

function retryFailedAsks(): void {
  let failed = false;
  for (const [key, state] of [...asks]) if (!state.answered) { asks.delete(key); failed = true; }
  if (failed) queueRequest([...cards]);
}

function resetAsks(): void {
  asks.clear();
  pendingAsks.clear();
  inFlight.clear();
  storeRevision = -1;
}

export function receiveTodoChanges(message: Extract<HostToWebview, { type: "todoChanges" }>): void {
  const asked = inFlight.get(message.requestId);
  if (!asked) return;
  if ("unreadable" in message) {
    inFlight.delete(message.requestId);
    settleAsks(asked, storeRevision, false);
    return;
  }
  if (!message.more) inFlight.delete(message.requestId);
  if (message.revision < asked.at) {
    resetAsks();
    if (message.more) inFlight.set(message.requestId, asked);
  } else if (message.revision < storeRevision) {
    if (!message.more) {
      for (const key of asked.keys) if (pendingAsks.get(key) === asked.at) pendingAsks.delete(key);
      queueRequest([...cards]);
    }
    return;
  }
  for (const key of asked.keys) if (pendingAsks.get(key) === asked.at) pendingAsks.set(key, message.revision);
  asked.at = message.revision;
  noteStoreRevision(message.revision);
  viewsGenerations = todoGenerations({ generations: message.generations });
  for (const change of message.changes) {
    views.set(change.id, change);
    asked.received.add(change.id);
  }
  for (const turn of message.turns ?? []) turnReverts.set(turnKey(turn.revisions), turn.revert);
  if (!message.more) {
    const ids = new Set(asked.keys);
    const revisions = new Set(asked.groups.flat());
    for (const id of [...views.keys()]) if (!asked.received.has(id) && (ids.has(idAsk(id)) || revisions.has(parseTodoChangeId(id).revision))) views.delete(id);
    for (const revision of revisions) answeredRevisions.add(revision);
    settleAsks(asked, message.revision, true);
    retryFailedAsks();
  }
  for (const card of cards) renderCard(card);
}

export function refreshTodoToolCards(store: { readonly enabled: boolean; readonly revision: number; readonly readable: boolean }): void {
  if (!store.enabled) {
    resetAsks();
    return;
  }
  for (const card of cards) if (unresolvedRows.has(card)) renderCard(card);
  if (store.readable) retryFailedAsks();
  noteStoreRevision(store.revision);
}

function dropUnreferencedViews(): void {
  const refs = [...cards].flatMap(cardRefs);
  const ids = new Set(refs.flatMap(ref => "ids" in ref ? ref.ids : []));
  const revisions = new Set(refs.flatMap(ref => "revision" in ref ? [ref.revision] : []));
  const turns = new Set([...cards].map(card => turnKey(cardRevisions(card))));
  const keys = new Set([...cards].flatMap(cardAskKeys));
  for (const id of [...views.keys()]) if (!ids.has(id) && !revisions.has(parseTodoChangeId(id).revision)) views.delete(id);
  for (const revision of [...answeredRevisions]) if (!revisions.has(revision)) answeredRevisions.delete(revision);
  for (const key of [...turnReverts.keys()]) if (!turns.has(key)) turnReverts.delete(key);
  for (const key of [...asks.keys()]) if (!keys.has(key)) asks.delete(key);
  for (const key of [...pendingAsks.keys()]) if (!keys.has(key)) pendingAsks.delete(key);
  for (const [requestId, asked] of [...inFlight]) if (!asked.keys.some(key => keys.has(key))) inFlight.delete(requestId);
}

function queueRequest(asking: readonly HTMLElement[]): void {
  for (const card of asking) toAsk.add(card);
  if (flushQueued || toAsk.size === 0) return;
  flushQueued = true;
  queueMicrotask(flushRequests);
}

function flushRequests(): void {
  flushQueued = false;
  const links = todoLinkHub();
  if (!links) {
    toAsk.clear();
    return;
  }
  const ids: string[] = [];
  const groups: number[][] = [];
  const keys = new Set<string>();
  let total = 0;
  for (const card of [...toAsk]) {
    let rest = false;
    for (const id of legacyIds(card)) {
      const key = idAsk(id);
      if (keys.has(key) || !askDue(key)) continue;
      if (ids.length >= TODO_CHANGES_REQUEST_MAX) { rest = true; break; }
      ids.push(id);
      keys.add(key);
    }
    const revisions = cardRevisions(card);
    const key = turnAsk(revisions);
    if (revisions.length && !keys.has(key) && askDue(key)) {
      const taken = revisions.slice(-TODO_CHANGES_REQUEST_MAX);
      if (groups.length > 0 && total + taken.length > TODO_CHANGES_REQUEST_MAX) rest = true;
      else {
        groups.push(taken);
        total += taken.length;
        keys.add(key);
      }
    }
    if (!rest) toAsk.delete(card);
  }
  if (keys.size === 0) return;
  for (const key of keys) pendingAsks.set(key, storeRevision);
  const requestId = ++requestSeq;
  inFlight.set(requestId, { at: storeRevision, keys: [...keys], groups, received: new Set() });
  links.post({ type: "todoChangesRequest", requestId, ids, ...(groups.length ? { revisions: groups } : {}) });
  if (toAsk.size) queueRequest([]);
}

const CARD_SIGN: Record<TodoCardMark, string> = { "-": "−", "+": "＋", "~": "～" };
const CARD_TONE: Record<TodoCardMark, SummaryTone> = { "-": "removed", "+": "added", "~": "muted" };

function groupOrderOf(items: readonly TodoListItem[], numberOf: (id: string) => string): string[] {
  const roots = items.filter(item => item.parentId === null && item.group !== undefined).sort((a, b) => Number(numberOf(a.id)) - Number(numberOf(b.id)));
  return [...new Set(roots.map(item => item.group!))];
}

function renderCard(card: HTMLElement): void {
  const links = todoLinkHub();
  const calls = [...cardCalls.get(card)?.values() ?? []];
  if (card.isConnected) card.dataset.seen = "1";
  card.hidden = todoCardHidden(calls.map(call => call.state));
  if (card.hidden) { card.replaceChildren(); return; }
  if (!links) return;
  const { ids, legacy, waiting, lost } = cardIds(card);
  const changes = ids.flatMap(id => views.get(id) ?? []).filter(change => !change.cascade);
  const missing = ids.length - ids.filter(id => views.has(id)).length + lost;
  const items = links.items();
  const numberOf = (id: string) => links.numberOf(id);
  const rows = todoCardTree(changes, items, groupOrderOf(items, numberOf), id => numberOf(id) || undefined);
  if (rows.some(row => row.itemId !== undefined && row.mark !== "-" && (todoItemOf(row.itemId) === undefined || !numberOf(row.itemId)))) unresolvedRows.add(card);
  else unresolvedRows.delete(card);
  const tidied = calls.some(call => call.tidy && (call.state === "written" || call.state === "unrecorded"));
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
  if (waiting && rows.length === 0) card.append(el("p", "todo-tool-note", l10n.t("Loading…")));
  else if (missing > 0 && !waiting) card.append(el("p", "todo-tool-note", l10n.t("These changes are no longer kept in the ToDo history.")));
  else if (rows.length === 0 && !calls.some(call => call.state === "pending")) card.append(el("p", "todo-tool-note", l10n.t("No change recorded.")));
  card.append(cardStatus(card));
}

function revertAllEl(card: HTMLElement, changes: readonly TodoChangeView[], legacy: readonly string[]): HTMLElement | null {
  const links = todoLinkHub()!;
  const own = changes.filter(change => change.author === "claude");
  if (own.length === 0) return null;
  if (own.every(change => change.revert === "reverted")) return el("span", "todo-tool-state", l10n.t("Taken back"));
  const target = legacy.length === 0 ? cardTarget(card) : undefined;
  if (legacy.length > 0 ? cardRefs(card).some(ref => "revision" in ref) : target === undefined) return null;
  const takeAllBack = () => todoButton("todo-link todo-tool-revert", l10n.t("Take all back"),
    () => links.edit(target ? { kind: "revertClaude", ...target } : { kind: "revertClaude", changeIds: own.map(change => change.id).slice(0, TODO_CHANGES_REQUEST_MAX) }),
    l10n.t("Take back everything this turn wrote to ToDo (your own undo is not used)"));
  if (!cardAskKeys(card).every(askFresh)) {
    const unanswered = takeAllBack();
    unanswered.disabled = true;
    return unanswered;
  }
  const block = target ? turnReverts.get(turnKey(target.revisions)) : own.find(change => change.revert !== "ok")?.revert ?? "ok";
  if (block === "ok") return takeAllBack();
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
  const label = row.itemId === undefined ? todoGroupLabel(row.group) : row.title;
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

export type TodoHeadKind = "linked" | "emptyHint" | "none";

export function todoHeadKind(tab: { linked: boolean; laisoraPurpose: boolean }): TodoHeadKind {
  if (tab.linked) return "linked";
  return tab.laisoraPurpose ? "none" : "emptyHint";
}

export function renderTodoHead(head: HTMLElement, tabId: string, laisoraPurpose: boolean): void {
  const links = todoLinkHub();
  head.replaceChildren();
  if (!links) { head.hidden = true; return; }
  const entry = links.tabItem(tabId);
  const item = entry ? todoItemOf(entry.itemId) : undefined;
  const kind = todoHeadKind({ linked: entry !== undefined && item !== undefined, laisoraPurpose });
  if (kind !== "linked" || !entry || !item) {
    head.hidden = kind !== "emptyHint";
    if (kind === "emptyHint") head.append(el("p", "todo-empty-hint", l10n.t("Paste an image or describe the work, and Claude puts it into ToDo directly. Take it all back from the ToDo card in the conversation, or one change at a time from History.")));
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
    acts.append(todoButton("todo-link", l10n.t("Split and open"), () => links.splitChild(item.id)),
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
