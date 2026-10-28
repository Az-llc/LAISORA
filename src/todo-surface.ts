import * as vscode from "vscode";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { openFileLink } from "./composer-io";
import { isInSessionStore, lookupSessionFile } from "./session-files";
import { sessionRecordId } from "./session-record";
import { RecordTailReader, TodoAskRecordReader, TodoDecisionRecorder, todoWorkTotal, todoWorkTurnReader, type TodoWorkTurns } from "./todo-ask-record";
import { parseFileLinkTarget } from "./file-link-target";
import { getLaisoraConfiguration } from "./claude-settings";
import { extensionContext, output, store } from "./host-context";
import {
  TODO_CHANGES_REQUEST_MAX,
  TODO_DETAIL_SECTIONS,
  TODO_DETAIL_SECTIONS_PREVIOUS_DEFAULTS,
  RENAME_TITLE_MAX,
  type HostToWebview,
  type TodoAskSourceMessage,
  type TodoAskSourceMessageEnvelope,
  type TodoAskSourceRef,
  type TodoAskWhere,
  type TodoChangeView,
  type TodoDeletedView,
  type TodoDetailItem,
  type TodoDetailSection,
  type TodoEdit,
  type TodoEditError,
  type TodoGroupColor,
  type TodoListItem,
  type TodoSnapshotMessage,
  type TodoTabItem,
  type TodoTemplateView,
  type TodoTurnRevert,
  type TodoBatchRevert,
  type TodoWorkView,
  type WebviewToHost,
} from "./protocol";
import * as l10n from "@vscode/l10n";
import { askOtherChoice } from "./ask-parser";
import { randomUUID } from "node:crypto";
import { sendLaisoraInput } from "./conversation-lifecycle";
import { handoffWorkMemoOf, type HandoffWorkMemo } from "./handoff-envelope";
import { openSessionById } from "./resume-hydration";
import { normalizeTitleValue } from "./session-display-title";
import { displayTitleFromSummary } from "./session-list";
import type { Session } from "./session";
import type { ClaudeConversation } from "./claudeHost";
import { openNewConversationTab, type SessionStore } from "./store-surfaces";
import { TODO_ACKNOWLEDGE_MAX, isTodoGroupName, todoChangeReverted, todoMarkChanges, todoItemNumbers, todoItemPath, todoParentPlace, todoPlaceText, todoRevertUnitBlock, type TodoChangePlace, type TodoRevertBlock, isClaudeOwnChange, TODO_RECENT_CLAUDE_MS, linkedTodoItem, parseTodoChangeId, memoStaleSince, newestConversation, todoChildBriefs, todoScopeIds, todoSessionLinks, todoStartOf, todoTabStart, revertBlock, runClaimedStart, singleFlight, TODO_CONVERSATION_SEEN_REFRESH_MS, todoConversationTarget, todoGroupsOf, todoTemplatesOf, todoTemplateSize, TODO_BRIEF_MAX, TODO_DELETED_RETENTION_MS, TODO_DOC_TARGET_MAX, TODO_IMAGE_EXTENSIONS, conversationLiveElsewhere, todoAskDismissals, todoAsksClosedInTodo, todoDecisionsToMigrate, type TodoAddNode, todoLinkedSessions, todoRecordAskSources, todoTabLinks, type TodoConversationLink, type TodoTabConversation, type TodoDoc, type TodoImageMediaType, WORK_MEMO_SECTIONS, type TodoChange, type TodoDocument, type TodoItem, type TodoMemoSection, type TodoOperation } from "./todo-model";
import { setTodoWorkspaceRoots, type TodoLinkedItem } from "./todo-mcp";
import { sharedTodoStore, TODO_ENABLED_SETTING, TodoStoreError, type TodoStore } from "./todo-store";
import { todoFromReplyInstruction, todoItemsAddedInTurn, todoReplyExcerpt, todoReplyText } from "./todo-reply";
import { readConversationMessages } from "./session-transcript";
import { admitIdleSend } from "./steering-envelope";

const TODO_SECTION_ORDER_KEY = "laisora.todo.detailSectionOrder";
const TODO_WELCOME_SEEDED_KEY = "laisora.todo.welcomeSeeded";
const TODO_DETAIL_CHANGES_MAX = 50;
const TODO_CLAUDE_CHANGES_MAX = 200;
const TODO_CHANGE_TEXT_MAX = 400;
const TODO_MEMO_VERSION_TEXT_MAX = 4000;

export function todoFeatureEnabled(cfg: Pick<vscode.WorkspaceConfiguration, "get"> = getLaisoraConfiguration()): boolean {
  return cfg.get<boolean>(TODO_ENABLED_SETTING) === true;
}

export function hostTodoStore(): TodoStore | undefined {
  return sharedTodoStore(extensionContext?.globalStorageUri?.fsPath, line => output.appendLine(line));
}

function guessView(item: TodoItem): { due?: string; priority?: string } | undefined {
  const due = item.guesses?.due?.value === item.due ? item.guesses?.due?.reason : undefined;
  const priority = item.guesses?.priority?.value === item.priority ? item.guesses?.priority?.reason : undefined;
  return due || priority ? { ...(due ? { due } : {}), ...(priority ? { priority } : {}) } : undefined;
}

function recentClaudeChanges(document: TodoDocument): TodoChange[] {
  const since = Date.now() - TODO_RECENT_CLAUDE_MS;
  return document.changes.slice(-TODO_CLAUDE_CHANGES_MAX).filter(change => isClaudeOwnChange(change) && change.at >= since);
}

const revertView = (block: TodoRevertBlock | null): "ok" | TodoRevertBlock => block ?? "ok";

function revisionUnitOf(document: TodoDocument, change: TodoChange): TodoChange[] {
  const revision = parseTodoChangeId(change.id).revision;
  return change.itemId === "" ? [change]
    : document.changes.filter(entry => entry.itemId === change.itemId && parseTodoChangeId(entry.id).revision === revision && isClaudeOwnChange(entry));
}

function recentClaudeUnits(document: TodoDocument): TodoChange[][] {
  const units = new Map<string, TodoChange[]>();
  for (const change of recentClaudeChanges(document)) {
    const key = change.itemId === "" ? change.id : `${parseTodoChangeId(change.id).revision}:${change.itemId}`;
    if (!units.has(key)) units.set(key, revisionUnitOf(document, change));
  }
  return [...units.values()];
}

function openClaudeMarks(document: TodoDocument): Map<string, Array<{ change: TodoChange; unit: TodoChange[] }>> {
  const marks = new Map<string, Array<{ change: TodoChange; unit: TodoChange[] }>>();
  for (const unit of recentClaudeUnits(document)) {
    const change = unit[0];
    if (change.itemId === "" || unit.every(entry => entry.acknowledged) || todoRevertUnitBlock(document, unit) !== null) continue;
    marks.set(change.itemId, [...(marks.get(change.itemId) ?? []), { change, unit }]);
  }
  return marks;
}

export function todoClaudeRecent(document: TodoDocument): number[] {
  return recentClaudeUnits(document).filter(unit => unit.some(change => !change.field.startsWith("workMemo.") && !todoChangeReverted(document.changes, change)))
    .map(unit => unit[0].at).slice(-TODO_ACKNOWLEDGE_MAX);
}

export function todoListItems(document: TodoDocument, running: ReadonlySet<string> = new Set()): TodoListItem[] {
  const marks = openClaudeMarks(document);
  return document.items.filter(item => item.deletedAt === undefined).map(item => {
    const guess = guessView(item);
    return {
      id: item.id, parentId: item.parentId, title: item.title, state: item.state, ...(item.completion ? { completion: item.completion } : {}),
      ...(item.group ? { group: item.group } : {}), ...(item.due ? { due: item.due } : {}), ...(item.start ? { start: item.start } : {}),
      ...(item.priority ? { priority: item.priority } : {}), ...(item.waiting ? { waiting: item.waiting } : {}), ...(item.by ? { by: item.by } : {}),
      ...(guess ? { guess } : {}), ...(marks.has(item.id) ? { marks: marks.get(item.id)!.map(entry => entry.change.id), markInfo: marks.get(item.id)!.map(({ change, unit }) => {
        const parts = todoMarkChanges(document.changes, unit).map(entry => {
          const view = changeView(document, entry);
          return { field: entry.field, before: view.before, after: view.after };
        });
        return { id: change.id, ids: unit.map(entry => entry.id), at: change.at, parts };
      }) } : {}),
      ...(item.captured && item.captured.text !== item.title ? { captured: { text: item.captured.text, at: item.captured.at, via: item.captured.via } } : {}),
      ...(running.has(item.id) ? { talk: "running" as const } : newestConversation(item) ? { talk: "linked" as const } : {}),
    };
  });
}

export function todoTemplateViews(document: TodoDocument): TodoTemplateView[] {
  return todoTemplatesOf(document).map(template => ({ id: template.id, name: template.name, title: template.root.title, size: todoTemplateSize(template.root) }));
}

function openTabs(): TodoTabConversation[] {
  return [...(store?.sessions.values() ?? [])].filter(s => !s.closed).map(s => ({
    tabId: s.tabId, itemId: s.todoItemId, sessionId: sessionRecordId(s), running: (s.conversation?.state ?? "idle") !== "idle",
  }));
}

const TODO_ASK_STAT_PARALLEL = 4;
const TODO_ASK_MISSING_RECHECK_MS = 5 * 60_000;
const askSourcePaths = new Map<string, string>();
const askSourceMissing = new Map<string, number>();
const TODO_ASK_OTHER_WINDOW_READ_MS = 10_000;
const askSourceCache = new Map<string, { key: string; size: number; endedAt: number; messages: TodoAskSourceMessage[] }>();
const askSourceReads = new Map<string, Promise<{ endedAt: number; messages: TodoAskSourceMessage[] } | undefined>>();
const askSourceReaders = new Map<string, TodoAskRecordReader>();
const askSourceShown = new Map<string, { key: string; at: number }>();
const TODO_DECISION_CURSOR_PREFIX = "laisora.todo.decisionCursor.";

const decisionRecorder = new TodoDecisionRecorder({
  enabled: () => todoFeatureEnabled() && hostTodoStore() !== undefined,
  otherChoice: askOtherChoice,
  saved: sessionId => extensionContext?.globalState.get<unknown>(`${TODO_DECISION_CURSOR_PREFIX}${sessionId}`),
  save: (sessionId, value) => {
    Promise.resolve(extensionContext?.globalState.update(`${TODO_DECISION_CURSOR_PREFIX}${sessionId}`, value))
      .catch(error => output.appendLine(`[todo] could not save where the decision records were read up to: ${String(error)}`));
  },
  knownPath: sessionId => askSourcePaths.get(sessionId),
  rememberPath: (sessionId, path) => {
    if (path === undefined) askSourcePaths.delete(sessionId);
    else askSourcePaths.set(sessionId, path);
  },
  lookup: lookupSessionFile,
  inStore: isInSessionStore,
  record: async (sessionId, decisions) => {
    const todoStore = hostTodoStore();
    const document = todoStore ? await applyHostTodoOperation(todoStore, { kind: "recordDecisions", sessionId, decisions }, "human") : undefined;
    return !document ? "failed" : linkedTodoItem(document.items, sessionId) ? "recorded" : "unlinked";
  },
  log: line => output.appendLine(line),
});
let askSourceLaterTimer: ReturnType<typeof setTimeout> | undefined;
let askSourceSessions = new Set<string>();

function askSourcePath(sessionId: string, recheck: boolean): string | undefined {
  const known = askSourcePaths.get(sessionId);
  if (known !== undefined) return known;
  const missedAt = askSourceMissing.get(sessionId);
  if (!recheck && missedAt !== undefined && Date.now() - missedAt < TODO_ASK_MISSING_RECHECK_MS) return undefined;
  const path = lookupSessionFile(sessionId).path ?? undefined;
  if (path === undefined) {
    askSourceMissing.set(sessionId, Date.now());
    return undefined;
  }
  askSourceMissing.delete(sessionId);
  askSourcePaths.set(sessionId, path);
  return path;
}

async function askSourceFile(sessionId: string, recheck = false): Promise<{ path: string; key: string; size: number } | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const path = askSourcePath(sessionId, recheck || attempt > 0);
    if (path === undefined) return undefined;
    try {
      const info = await stat(path);
      return { path, key: `${info.size}:${info.mtimeMs}`, size: info.size };
    } catch {
      askSourcePaths.delete(sessionId);
    }
  }
  return undefined;
}

async function mapLimit<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < values.length; index = next++) results[index] = await run(values[index]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function askSourceWhere(link: TodoConversationLink, tabs: readonly TodoTabConversation[], now: number): TodoAskWhere {
  if (tabs.some(tab => tab.sessionId === link.sessionId)) return "here";
  return conversationLiveElsewhere(link, TODO_WINDOW_ID, now) ? "elsewhere" : "closed";
}

const workReaders = new Map<string, RecordTailReader<TodoWorkTurns>>();

function sweepRecordReaders(document: TodoDocument, askSessions: ReadonlySet<string>): void {
  const linked = todoLinkedSessions(document.items);
  const keep: ReadonlyArray<readonly [Map<string, unknown>, ReadonlySet<string>]> = [
    [askSourcePaths, new Set([...askSessions, ...linked])], [askSourceMissing, new Set([...askSessions, ...linked])], [askSourceCache, askSessions], [askSourceReaders, askSessions], [askSourceShown, askSessions], [workReaders, linked],
  ];
  for (const [cache, sessions] of keep) for (const sessionId of cache.keys()) if (!sessions.has(sessionId)) cache.delete(sessionId);
  decisionRecorder.keepOnly(linked);
}

async function askSourceRefs(document: TodoDocument, tabs: readonly TodoTabConversation[]): Promise<TodoAskSourceRef[]> {
  const now = Date.now();
  const sources = todoRecordAskSources(document.items);
  const sessions = new Set(sources.map(source => source.link.sessionId));
  for (const sessionId of sessions) if (!askSourceSessions.has(sessionId)) askSourceMissing.delete(sessionId);
  sweepRecordReaders(document, sessions);
  askSourceSessions = sessions;
  let laterIn: number | undefined;
  const refs = await mapLimit(sources, TODO_ASK_STAT_PARALLEL, async source => {
    const sessionId = source.link.sessionId;
    const where = askSourceWhere(source.link, tabs, now);
    const shown = askSourceShown.get(sessionId);
    const running = tabs.some(tab => tab.sessionId === sessionId && tab.running);
    if (shown && where === "here" && running) return { itemId: source.itemId, sessionId, key: shown.key, where };
    if (shown && where !== "here" && now - shown.at < TODO_ASK_OTHER_WINDOW_READ_MS) {
      laterIn = Math.min(laterIn ?? Infinity, shown.at + TODO_ASK_OTHER_WINDOW_READ_MS - now);
      return { itemId: source.itemId, sessionId, key: shown.key, where };
    }
    const file = await askSourceFile(sessionId, where === "here");
    const key = file?.key ?? null;
    if (key !== null && key !== shown?.key) askSourceShown.set(sessionId, { key, at: now });
    return { itemId: source.itemId, sessionId, key, where };
  });
  if (laterIn !== undefined && askSourceLaterTimer === undefined) {
    askSourceLaterTimer = setTimeout(() => { askSourceLaterTimer = undefined; postTodoSnapshot(); }, laterIn + 50);
  }
  return refs;
}

function readAskSource(sessionId: string, file: { path: string; key: string; size: number }): Promise<{ endedAt: number; messages: TodoAskSourceMessage[] } | undefined> {
  const id = `${sessionId}|${file.key}`;
  let pending = askSourceReads.get(id);
  if (pending === undefined) {
    if (!isInSessionStore(file.path)) return Promise.resolve(undefined);
    let reader = askSourceReaders.get(sessionId);
    if (reader === undefined) askSourceReaders.set(sessionId, reader = new TodoAskRecordReader(sessionId));
    pending = reader.read(file.path, file.size).then(value => {
      if (askSourceSessions.has(sessionId)) askSourceCache.set(sessionId, { key: file.key, size: file.size, ...value });
      return value;
    }, error => {
      output.appendLine(`[todo] could not read the conversation record for its decisions: ${String(error)}`);
      return undefined;
    }).finally(() => askSourceReads.delete(id));
    askSourceReads.set(id, pending);
  }
  return pending;
}

async function prepareDecisionRecords(): Promise<void> {
  const read = await readTodoDocument("decision records");
  if (!read) return;
  if (todoDecisionsToMigrate(read.document)) await applyHostTodoOperation(read.todoStore, { kind: "migrateDecisions" }, "human");
  const linked = todoLinkedSessions(read.document.items);
  for (const key of extensionContext?.globalState.keys() ?? []) {
    if (key.startsWith(TODO_DECISION_CURSOR_PREFIX) && !linked.has(key.slice(TODO_DECISION_CURSOR_PREFIX.length))) {
      Promise.resolve(extensionContext?.globalState.update(key, undefined)).catch(error => output.appendLine(`[todo] could not drop a decision read position: ${String(error)}`));
    }
  }
  await decisionRecorder.sweep([...linked]);
}

function todoWelcomeItems(): TodoAddNode[] {
  return [{
    title: l10n.t("How to use the ToDo (mark each step done once you've read it)"),
    children: [
      { title: l10n.t("Ask Claude in a conversation to add things, or press “{0}” under a reply", l10n.t("Add to ToDo")) },
      { title: l10n.t("“{0}” on an item opens a conversation for it, and “{1}” returns to that conversation", l10n.t("Start"), l10n.t("Continue")) },
      { title: l10n.t("If you don't need the ToDo, turn off “{0}” in LAISORA settings → {1} → ToDo (laisora.{2})", l10n.t("Enable ToDo"), l10n.t("General"), TODO_ENABLED_SETTING) },
    ],
  }];
}

async function seedTodoWelcome(): Promise<void> {
  const todoStore = todoFeatureEnabled() ? hostTodoStore() : undefined;
  if (!extensionContext || !todoStore) return;
  const seeded = extensionContext.globalState.get<boolean>(TODO_WELCOME_SEEDED_KEY) === true;
  if (!await applyHostTodoOperation(todoStore, { kind: "seedWelcome", items: todoWelcomeItems(), seeded }, "human") || seeded) return;
  await Promise.resolve(extensionContext.globalState.update(TODO_WELCOME_SEEDED_KEY, true)).catch(error => output.appendLine(`[todo] could not remember the first-run guide: ${String(error)}`));
}

async function askSourceMessage(sessionId: string, requestId: number): Promise<TodoAskSourceMessageEnvelope> {
  const file = await askSourceFile(sessionId);
  if (!file) return { type: "todoAskSource", sessionId, requestId, key: null };
  const cached = askSourceCache.get(sessionId);
  const read = cached?.key === file.key ? cached : await readAskSource(sessionId, file);
  return read ? { type: "todoAskSource", sessionId, requestId, key: file.key, endedAt: read.endedAt, messages: read.messages }
    : { type: "todoAskSource", sessionId, requestId, key: null };
}

export function todoGroupColors(document: TodoDocument): TodoGroupColor[] {
  return todoGroupsOf(document).map(group => ({ name: group.name, color: group.color, ...(group.folders?.length ? { folders: group.folders.map(folder => folder.path) } : {}),
    ...(group.aliases?.length ? { aliases: group.aliases.map(alias => ({ words: alias.words, ...(alias.parentId ? { parentId: alias.parentId } : {}) })) } : {}) }));
}

let snapshotSeq = 0;

function tabItemView(document: TodoDocument, entry: { tabId: string; itemId: string }, tabs: readonly TodoTabConversation[]): TodoTabItem {
  const item = liveItem(document, entry.itemId);
  if (!item) return entry;
  const sessionId = tabs.find(tab => tab.tabId === entry.tabId)?.sessionId;
  const start = sessionId ? todoStartOf(item, sessionId) ?? todoTabStart(item, todoTabKey(entry.tabId)) : todoTabStart(item, todoTabKey(entry.tabId));
  const decisions = item.parentId === null ? item.workMemo.decisions?.text : undefined;
  const splits = item.parentId === null ? document.items.filter(child => child.parentId === item.id && child.deletedAt === undefined)
    .flatMap(child => todoChildBriefs(child).map(brief => ({ itemId: child.id, at: brief.at }))).sort((a, b) => a.at - b.at) : [];
  return {
    ...entry,
    ...(start ? { start: { at: start.at, kind: start.kind, brief: start.brief, ...(start.current ? { current: start.current } : {}), ...(start.next ? { next: start.next } : {}), ...(start.stale ? { stale: true as const } : {}) } } : {}),
    ...(start && decisions ? { decisions } : {}),
    ...(splits.length ? { splits } : {}),
  };
}

function openSessionTitle(sessionId: string): string | undefined {
  return [...(store?.sessions.values() ?? [])].find(s => !s.closed && sessionRecordId(s) === sessionId)?.title;
}

async function todoSnapshotMessage(seq: number): Promise<TodoSnapshotMessage> {
  const todoStore = todoFeatureEnabled() ? hostTodoStore() : undefined;
  if (!todoStore) return { type: "todoSnapshot", seq, enabled: false };
  let message: TodoSnapshotMessage;
  try {
    const document = await todoStore.read();
    const tabs = openTabs();
    for (const tab of tabs) if (tab.sessionId) sessionItems.set(tab.sessionId, linkedTodoItem(document.items, tab.sessionId)?.id ?? null);
    const links = todoTabLinks(document.items, tabs);
    message = {
      type: "todoSnapshot", seq, enabled: true, revision: document.revision, items: todoListItems(document, links.running), groups: todoGroupColors(document), templates: todoTemplateViews(document),
      tabItems: links.tabItems.map(entry => tabItemView(document, entry, tabs)), askSources: await askSourceRefs(document, tabs), askDismissals: todoAskDismissals(document.items), askClosedInTodo: todoAsksClosedInTodo(document.items),
      deletedTabs: links.deleted, sessions: todoSessionLinks(document.items), claudeRecent: todoClaudeRecent(document),
    };
  } catch (error) {
    output.appendLine(`[todo] could not read the store for the TODO tab: ${String(error)}`);
    message = { type: "todoSnapshot", seq, enabled: true, unreadable: true };
  }
  return todoFeatureEnabled() ? message : { type: "todoSnapshot", seq, enabled: false };
}

export function postTodoSnapshot(target?: vscode.Webview): void {
  void todoSnapshotMessage(++snapshotSeq).then(message => {
    if (!store) return;
    if (target) void store.postTo(target, message);
    else store.post(message);
  });
}

let todoWatch: { dispose(): void } | undefined;

export function syncTodoSurface(): void {
  if (!todoFeatureEnabled()) {
    disposeTodoSurface();
    postTodoSnapshot();
    return;
  }
  setTodoWorkspaceRoots(() => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));
  if (!todoWatch) {
    void prepareDecisionRecords();
    void seedTodoWelcome();
    try {
      todoWatch = hostTodoStore()?.watch(revision => {
        output.appendLine(`[todo] store changed (revision ${revision})`);
        postTodoSnapshot();
      });
    }
    catch (error) { output.appendLine(`[todo] could not watch the store: ${String(error)}`); }
  }
  ownerTimer ??= setInterval(() => refreshOwnedConversations(), TODO_CONVERSATION_SEEN_REFRESH_MS);
  postTodoSnapshot();
}

export function disposeTodoSurface(): void {
  syncDrawerKeyContext();
  todoWatch?.dispose();
  todoWatch = undefined;
  if (ownerTimer !== undefined) clearInterval(ownerTimer);
  ownerTimer = undefined;
  decisionRecorder.dispose();
}

let ownerTimer: ReturnType<typeof setInterval> | undefined;

function refreshOwnedConversations(): void {
  const todoStore = todoFeatureEnabled() ? hostTodoStore() : undefined;
  if (!todoStore) return;
  for (const s of store?.sessions.values() ?? []) {
    const sessionId = sessionRecordId(s);
    if (!s.closed && sessionId && sessionItems.get(sessionId)) void applyHostTodoOperation(todoStore, { kind: "touchConversation", sessionId, owner: TODO_WINDOW_ID }, "human");
  }
}

export async function releaseOwnedTodoConversations(): Promise<void> {
  const todoStore = todoFeatureEnabled() ? hostTodoStore() : undefined;
  if (todoStore) await applyHostTodoOperation(todoStore, { kind: "releaseOwner", owner: TODO_WINDOW_ID }, "human");
}

function memoVersionText(section: TodoMemoSection | undefined, version: unknown): string | null {
  if (typeof version !== "number" || !section) return null;
  if (section.version === version) return section.text;
  return section.history.find(entry => entry.version === version)?.text ?? null;
}

function changeValue(document: TodoDocument, item: TodoItem | undefined, change: TodoChange, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return change.field === "deletedAt" ? "deleted" : null;
  const record = value as Record<string, unknown>;
  if (change.field === "state") return typeof record.state === "string" ? record.state : null;
  if (change.field === "item") return typeof record.title === "string" ? record.title : null;
  if (change.field === "docs") return typeof record.label === "string" && record.label ? record.label : typeof record.target === "string" ? record.target : null;
  if (change.field === "docLabel") return typeof record.label === "string" ? record.label : null;
  if (change.field === "groups" || change.field === "templates") return typeof record.name === "string" ? record.name : null;
  if (change.field === "groupBindings") {
    const folders = Array.isArray(record.folders) ? record.folders.flatMap(folder => typeof folder?.path === "string" ? [folder.path] : []) : [];
    const aliases = Array.isArray(record.aliases) ? record.aliases.flatMap(alias => typeof alias?.words === "string" ? [`“${alias.words}”`] : []) : [];
    return [...folders, ...aliases].join(", ") || null;
  }
  if (change.field === "position") {
    if (record.parentId !== null && typeof record.parentId !== "string") return null;
    const numbers = numbersOf(document);
    const group = "placeGroup" in record ? typeof record.placeGroup === "string" ? record.placeGroup : null : typeof record.group === "string" ? record.group : item?.parentId === null ? item.group ?? null : null;
    return todoPlaceText(todoParentPlace(document.items, { parentId: record.parentId, group: group ?? undefined }, id => numbers.get(id) ?? ""), l10n.t("No group"));
  }
  const section = WORK_MEMO_SECTIONS.find(entry => change.field === `workMemo.${entry}`);
  return section ? memoVersionText(item?.workMemo[section], record.version) : null;
}

const clipped = (text: string | null, max: number) => text !== null && text.length > max ? `${text.slice(0, max)}…` : text;

const documentNumbers = new WeakMap<TodoDocument, Map<string, string>>();

function numbersOf(document: TodoDocument): Map<string, string> {
  let numbers = documentNumbers.get(document);
  if (!numbers) documentNumbers.set(document, numbers = todoItemNumbers(document.items.filter(item => item.deletedAt === undefined), todoGroupsOf(document).map(group => group.name)));
  return numbers;
}

const placeGroup = (group: unknown): string | null => isTodoGroupName(group) ? group : null;

function changePlace(document: TodoDocument, parentId: string | null, group: string | null): TodoChangePlace {
  if (parentId === null) return { group: placeGroup(group), path: [] };
  const path = todoItemPath(document.items, parentId);
  return { group: path[0]?.group ?? null, path: path.map(step => ({ id: step.id, title: step.title })) };
}

function changePlaces(document: TodoDocument, item: TodoItem | undefined, change: TodoChange): { from?: TodoChangePlace; to?: TodoChangePlace } {
  if (!isClaudeOwnChange(change) || !item) return {};
  const rootGroup = item.parentId === null ? item.group ?? null : null;
  const before = isRecord(change.before) ? change.before : undefined, after = isRecord(change.after) ? change.after : undefined;
  const parentOf = (record: Record<string, unknown> | undefined) => typeof record?.parentId === "string" ? record.parentId : record?.parentId === null ? null : undefined;
  const groupOf = (record: Record<string, unknown> | undefined, legacy: string | null) => record !== undefined && "placeGroup" in record
    ? typeof record.placeGroup === "string" ? record.placeGroup : null : legacy;
  switch (change.field) {
    case "item": {
      const parentId = parentOf(after);
      return parentId === undefined ? {} : { to: changePlace(document, parentId, groupOf(after, rootGroup)) };
    }
    case "position": {
      const from = parentOf(before), to = parentOf(after);
      return from === undefined || to === undefined ? {} : { from: changePlace(document, from, groupOf(before, typeof before?.group === "string" ? before.group : rootGroup)), to: changePlace(document, to, groupOf(after, rootGroup)) };
    }
    case "group": return { from: { group: placeGroup(change.before), path: [] }, to: { group: placeGroup(change.after), path: [] } };
    case "deletedAt": return change.after !== null ? { from: changePlace(document, item.parentId, item.group ?? null) } : { to: changePlace(document, item.parentId, item.group ?? null) };
  }
  return { to: changePlace(document, item.parentId, item.group ?? null) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function changeView(document: TodoDocument, change: TodoChange, revert?: TodoRevertBlock | null): TodoChangeView {
  const item = document.items.find(entry => entry.id === change.itemId);
  const block = revert !== undefined ? revert : isClaudeOwnChange(change) ? revertBlock(document, change, "claude") : undefined;
  const max = change.field.startsWith("workMemo.") ? TODO_MEMO_VERSION_TEXT_MAX : TODO_CHANGE_TEXT_MAX;
  const basis = change.basis ?? (item?.placement && item.placement.at === change.at && (change.field === "item" || change.field === "position" || change.field === "group") ? item.placement.basis : undefined);
  return {
    id: change.id, at: change.at, author: change.author, itemId: change.itemId, itemTitle: item?.title ?? "", field: change.field,
    before: clipped(changeValue(document, item, change, change.before), max), after: clipped(changeValue(document, item, change, change.after), max),
    ...(change.cascade ? { cascade: true as const } : {}),
    ...(block !== undefined ? { revert: revertView(block) } : {}),
    ...(change.acknowledged ? { acknowledged: true as const } : {}),
    ...(basis ? { basis } : {}),
    ...(change.by ? { by: change.by } : {}),
    ...changePlaces(document, item, change),
  };
}

function detailItem(document: TodoDocument, id: string): TodoDetailItem | null {
  const item = document.items.find(entry => entry.id === id && entry.deletedAt === undefined);
  if (!item) return null;
  const workMemo = Object.fromEntries(WORK_MEMO_SECTIONS.flatMap(section => {
    const memo = item.workMemo[section];
    return memo ? [[section, { text: memo.text, at: memo.at }]] : [];
  }));
  const changes = document.changes.filter(change => change.itemId === id).slice(-TODO_DETAIL_CHANGES_MAX).reverse();
  const conversations: Array<{ at: number; handoffs: number }> = [];
  for (const link of item.conversations ?? []) {
    const last = conversations.at(-1);
    if (link.via === "handoff" && last) conversations[conversations.length - 1] = { ...last, handoffs: last.handoffs + 1 };
    else conversations.push({ at: link.at, handoffs: 0 });
  }
  const guesses = guessView(item);
  const totals = descendantTotals(document, item.id);
  return {
    id: item.id, parentId: item.parentId, title: item.title, state: item.state,
    ...(item.completion ? { completion: item.completion } : {}), ...(item.group ? { group: item.group } : {}),
    ...(item.due ? { due: item.due } : {}), ...(item.start ? { start: item.start } : {}), ...(item.priority ? { priority: item.priority } : {}),
    userMemo: item.userMemo, workMemo, createdAt: item.createdAt, updatedAt: item.updatedAt,
    docs: (item.docs ?? []).map(doc => ({ id: doc.id, kind: doc.kind, target: doc.target, ...(doc.label ? { label: doc.label } : {}), at: doc.at })),
    changes: changes.map(change => changeView(document, change, isClaudeOwnChange(change) ? todoRevertUnitBlock(document, revisionUnitOf(document, change)) : undefined)),
    ...(memoStaleSince(item) !== undefined ? { memoStaleSince: memoStaleSince(item) } : {}),
    ...(item.waiting ? { waiting: item.waiting } : {}), ...(item.repeat ? { repeat: item.repeat } : {}),
    ...(item.estimate ? { estimate: item.estimate } : {}), ...(item.tags ? { tags: item.tags } : {}), ...(item.by ? { by: item.by } : {}),
    ...(guesses ? { guesses } : {}), ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}), ...(item.doneAt !== undefined ? { doneAt: item.doneAt } : {}),
    conversations, briefs: todoChildBriefs(item).map(brief => ({ at: brief.at, text: brief.brief })),
    ...(item.decisionLog?.length ? { decisionLog: item.decisionLog } : {}),
    ...(totals ? { totals } : {}),
    ...(item.source ? { source: { sessionId: item.source.sessionId, ...(openSessionTitle(item.source.sessionId) ? { title: openSessionTitle(item.source.sessionId)!.slice(0, RENAME_TITLE_MAX) } : {}) } } : {}),
  };
}

function descendantTotals(document: TodoDocument, id: string): { kids: number; done: number; firstStartedAt?: number; lastDoneAt?: number } | undefined {
  const live = document.items.filter(entry => entry.deletedAt === undefined);
  const below: TodoItem[] = [];
  for (let frontier = [id]; frontier.length;) {
    const next = live.filter(entry => entry.parentId !== null && frontier.includes(entry.parentId));
    below.push(...next);
    frontier = next.map(entry => entry.id);
  }
  if (below.length === 0) return undefined;
  const started = below.flatMap(entry => entry.startedAt !== undefined ? [entry.startedAt] : []);
  const done = below.filter(entry => entry.state === "done");
  const doneTimes = done.flatMap(entry => entry.doneAt !== undefined ? [entry.doneAt] : []);
  return { kids: below.length, done: done.length, ...(started.length ? { firstStartedAt: Math.min(...started) } : {}),
    ...(doneTimes.length && done.length === below.length ? { lastDoneAt: Math.max(...doneTimes) } : {}) };
}

async function sessionWorkTurns(sessionId: string): Promise<TodoWorkTurns | undefined> {
  const file = await askSourceFile(sessionId);
  if (!file || !isInSessionStore(file.path)) return undefined;
  let reader = workReaders.get(sessionId);
  if (reader === undefined) workReaders.set(sessionId, reader = todoWorkTurnReader());
  try {
    return await reader.read(file.path, file.size);
  } catch (error) {
    output.appendLine(`[todo] could not read a conversation record for its worked time: ${String(error)}`);
    return undefined;
  }
}

async function itemWork(document: TodoDocument, id: string): Promise<TodoWorkView | undefined> {
  const live = document.items.filter(entry => entry.deletedAt === undefined);
  const subtree = todoScopeIds(live, id);
  const sessions = (ids: Iterable<string>) => [...new Set([...ids].flatMap(itemId => (live.find(entry => entry.id === itemId)?.conversations ?? []).map(link => link.sessionId)))];
  const own = sessions([id]);
  const all = sessions(subtree);
  const turns = new Map((await mapLimit(all, TODO_WORK_READS, async sessionId => [sessionId, await sessionWorkTurns(sessionId)] as const)).flatMap(([sessionId, read]) => read ? [[sessionId, read] as const] : []));
  if (turns.size === 0) return undefined;
  const total = (list: readonly string[]) => todoWorkTotal(list.flatMap(sessionId => turns.get(sessionId) ?? []));
  return { ms: Math.round(total(own)), ...(subtree.size > 1 ? { withChildrenMs: Math.round(total(all)) } : {}) };
}

const TODO_WORK_READS = 4;

function todoStartBrief(item: TodoItem, parent: TodoItem | undefined, continued: boolean): string {
  const confirmFirst = l10n.t("Before doing any work, reply to the user with what you understand the work to be, the information that is missing, and what you will produce if you start as it stands, and wait for the user's answer.");
  if (!parent) {
    return continued
      ? [l10n.t("Continue the ToDo item “{0}” (id {1}) in this new conversation. First read the item, its memos and its references with the ToDo tool.", item.title, item.id),
        confirmFirst, l10n.t("After the user answers, carry on from where it stands.")].join(" ")
      : [l10n.t("Start the ToDo item “{0}” (id {1}). This is its parent conversation. First read the item, its memos and its references with the ToDo tool.", item.title, item.id),
        confirmFirst, l10n.t("After the user answers, plan the work.")].join(" ");
  }
  const lines: string[] = [];
  const section = (heading: string, body: readonly string[]) => { lines.push(`## ${heading}`, ...body, ""); };
  section(l10n.t("Instructions for this child"), [
    l10n.t("Work on the ToDo sub-item “{0}” (id {1}) in this child conversation.", item.title, item.id),
    ...(item.userMemo.trim() ? [l10n.t("The user's memo on it: {0}", item.userMemo.trim())] : []),
    l10n.t("First read this item, the parent's work memo and the references below."),
    confirmFirst,
    l10n.t("After the user answers, do the work."),
  ]);
  const memoSections = WORK_MEMO_SECTIONS.filter(entry => parent.workMemo[entry]?.text);
  section(l10n.t("Work memo to read"), [
    l10n.t("Read the work memo of the parent item “{0}” (id {1}) with the ToDo tool by reference; do not copy it into this item's memo.", parent.title, parent.id),
    memoSections.length ? l10n.t("It has these sections now: {0}", memoSections.join(", ")) : l10n.t("It has no sections yet."),
  ]);
  const docs = [...(item.docs ?? []), ...(parent.docs ?? [])];
  section(l10n.t("References"), docs.length
    ? docs.map(doc => `- ${doc.kind === "image" ? l10n.t("image {0}", doc.target) : doc.target}${doc.label ? ` (${doc.label})` : ""}`)
    : [l10n.t("None")]);
  section(l10n.t("Constraints"), [
    l10n.t("Only this conversation's main thread writes to the ToDo list. Questions for the user show up in ToDo; do not send anything to the parent conversation."),
    ...(item.due ? [l10n.t("Due {0}.", item.due)] : []),
  ]);
  section(l10n.t("When it is done"), [l10n.t("Set this sub-item to done with the ToDo tool when the work is finished.")]);
  section(l10n.t("Report back to the parent"), [l10n.t("Write the result into this sub-item's work memo (“current” for the outcome, “decisions” for what was decided, “files” for the files), so the parent reads it from there.")]);
  return lines.join("\n").trim().slice(0, TODO_BRIEF_MAX);
}

function claudeChanges(document: TodoDocument): { changes: TodoChangeView[]; batches: TodoBatchRevert[] } {
  const own = document.changes.filter(isClaudeOwnChange).slice(-TODO_CLAUDE_CHANGES_MAX);
  const revisions = new Map<number, TodoChange[]>();
  for (const change of own) revisions.set(parseTodoChangeId(change.id).revision, [...revisions.get(parseTodoChangeId(change.id).revision) ?? [], change]);
  const batches = [...revisions].filter(([, changes]) => changes.length > 1).map(([revision]) => ({ revision, revert: revertView(todoRevertUnitBlock(document, revisionChanges(document, [revision]))) }));
  return { changes: [...own].reverse().map(change => changeView(document, change, todoRevertUnitBlock(document, revisionUnitOf(document, change)))), batches };
}

function revisionChanges(document: TodoDocument, revisions: readonly number[]): TodoChange[] {
  const wanted = new Set(revisions);
  return document.changes.filter(change => wanted.has(parseTodoChangeId(change.id).revision) && isClaudeOwnChange(change));
}

function deletedItems(document: TodoDocument): TodoDeletedView[] {
  const byId = new Map(document.items.map(item => [item.id, item]));
  const heads = document.items.filter(item => item.deletedAt !== undefined
    && (item.parentId === null || byId.get(item.parentId)?.deletedAt !== item.deletedAt));
  const descendants = (id: string, deletedAt: number): number => document.items
    .filter(item => item.parentId === id && item.deletedAt === deletedAt)
    .reduce((count, item) => count + 1 + descendants(item.id, deletedAt), 0);
  return heads.sort((a, b) => b.deletedAt! - a.deletedAt!).map(item => ({
    id: item.id, title: item.title, ...(item.group ? { group: item.group } : {}),
    deletedAt: item.deletedAt!, expiresAt: item.deletedAt! + TODO_DELETED_RETENTION_MS, descendants: descendants(item.id, item.deletedAt!),
  }));
}

function sectionOrder(): TodoDetailSection[] {
  const stored = extensionContext?.globalState.get<unknown>(TODO_SECTION_ORDER_KEY);
  const saved = Array.isArray(stored) && TODO_DETAIL_SECTIONS_PREVIOUS_DEFAULTS.some(order => order.join() === stored.join()) ? undefined : stored;
  const known = Array.isArray(saved) ? TODO_DETAIL_SECTIONS.filter(section => saved.includes(section)).sort((a, b) => saved.indexOf(a) - saved.indexOf(b)) : [];
  for (const section of TODO_DETAIL_SECTIONS) {
    if (known.includes(section)) continue;
    const before = TODO_DETAIL_SECTIONS.slice(0, TODO_DETAIL_SECTIONS.indexOf(section)).reverse().find(entry => known.includes(entry));
    known.splice(before === undefined ? 0 : known.indexOf(before) + 1, 0, section);
  }
  return known;
}

function linkDoc(target: string, label: string | undefined): Omit<TodoDoc, "id" | "at"> | TodoEditError {
  const trimmed = target.trim();
  const labelled = label?.trim() ? { label: label.trim() } : {};
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try { url = new URL(trimmed); } catch { return "invalid-doc"; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid-doc";
    return url.href.length > TODO_DOC_TARGET_MAX ? "link-too-long" : { kind: "url", target: url.href, ...labelled };
  }
  return parseFileLinkTarget(trimmed, { windows: process.platform === "win32" }) === null ? "invalid-doc" : { kind: "file", target: trimmed, ...labelled };
}

async function operationOf(edit: TodoEdit, todoStore: TodoStore): Promise<{ operation: TodoOperation; written?: string } | TodoEditError> {
  switch (edit.kind) {
    case "undo": return { operation: { kind: "revert", mode: "undo", revision: edit.revision } };
    case "revertClaude": return { operation: "revisions" in edit ? { kind: "revert", mode: "claude", revisions: edit.revisions }
      : { kind: "revert", mode: "claude", changeIds: "changeIds" in edit ? edit.changeIds : [edit.changeId] } };
    case "addLink": {
      const doc = linkDoc(edit.target, edit.label);
      return typeof doc === "string" ? doc : { operation: { kind: "addDoc", id: edit.id, doc } };
    }
    case "addImage": {
      const data = Buffer.from(edit.data, "base64");
      if (data.length === 0) return "invalid-doc";
      const written = await todoStore.writeImage(edit.mediaType, data);
      return { written, operation: { kind: "addDoc", id: edit.id, doc: { kind: "image", target: written, mediaType: edit.mediaType, ...(edit.label?.trim() ? { label: edit.label.trim() } : {}) } } };
    }
    default: return { operation: edit };
  }
}

async function openDoc(todoStore: TodoStore, itemId: string, docId: string, sender: vscode.Webview): Promise<void> {
  const document = await todoStore.read();
  const doc = document.items.find(item => item.id === itemId)?.docs?.find(entry => entry.id === docId);
  if (!doc) return;
  if (doc.kind === "image") {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(join(todoStore.filesDirectory, doc.target)));
    return;
  }
  if (doc.kind === "url") {
    const uri = vscode.Uri.parse(doc.target);
    if (uri.scheme === "http" || uri.scheme === "https") await vscode.env.openExternal(uri);
    return;
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  await openFileLink(cwd, doc.target, store?.panel?.webview === sender);
}

type TodoMessage = Extract<WebviewToHost, { type: "todoEdit" | "todoDetailRequest" | "todoLogRequest" | "todoSectionOrder" | "todoImageRequest" | "todoOpenDoc" | "todoAskSourceRequest" | "todoAskDismiss" | "todoChangesRequest" }>;

export const TODO_DRAWER_KEY_CONTEXT = "laisora.todoDrawerKey";
let drawerKeyWebview: vscode.Webview | null = null;
let drawerKeyContext = false;

function syncDrawerKeyContext(): void {
  const next = drawerKeyWebview !== null && todoFeatureEnabled();
  if (next === drawerKeyContext) return;
  drawerKeyContext = next;
  void vscode.commands.executeCommand("setContext", TODO_DRAWER_KEY_CONTEXT, next);
}

export function setTodoDrawerFocus(webview: vscode.Webview, focused: boolean): void {
  if (focused) drawerKeyWebview = webview;
  else if (drawerKeyWebview === webview) drawerKeyWebview = null;
  else return;
  syncDrawerKeyContext();
}

export function toggleTodoDrawer(): void {
  if (drawerKeyWebview && store && todoFeatureEnabled()) void store.postTo(drawerKeyWebview, { type: "todoToggleDrawer" });
}

export function offerTodoReopen(st: SessionStore, s: Session, sender: vscode.Webview): void {
  const sessionId = sessionRecordId(s);
  if (!sessionId || !todoFeatureEnabled() || !sessionItems.get(sessionId)) return;
  const reopen = l10n.t("Reopen");
  void vscode.window.showInformationMessage(l10n.t("LAISORA: Closed the conversation of a ToDo item, “{0}”.", s.title), reopen).then(choice => {
    if (choice !== reopen) return;
    void openSessionById(st, sender, sessionId).then(opened => {
      if (opened === "not_found" || opened === "scan_failed") void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not reopen the conversation from its record."));
    });
  });
}

export async function handleTodoMessage(msg: TodoMessage, sender: vscode.Webview): Promise<void> {
  const reply = (message: HostToWebview) => { if (store) void store.postTo(sender, message); };
  const todoStore = todoFeatureEnabled() ? hostTodoStore() : undefined;
  if (msg.type === "todoSectionOrder") {
    if (todoStore) await extensionContext?.globalState.update(TODO_SECTION_ORDER_KEY, msg.order);
    return;
  }
  if (!todoStore) {
    if (msg.type === "todoEdit") reply({ type: "todoEditResult", requestId: msg.requestId, ok: false, error: "disabled" });
    return;
  }
  try {
    if (msg.type === "todoAskSourceRequest") {
      reply(await askSourceMessage(msg.sessionId, msg.requestId));
      return;
    }
    if (msg.type === "todoChangesRequest") {
      const document = await todoStore.read();
      const wanted = new Set(msg.ids);
      const revisions = new Set((msg.revisions ?? []).flat());
      const changes = document.changes.filter(change => wanted.has(change.id)
        || (revisions.has(parseTodoChangeId(change.id).revision) && isClaudeOwnChange(change))).map(change => changeView(document, change));
      const turns: TodoTurnRevert[] = (msg.revisions ?? []).map(group => ({ revisions: group, revert: revertView(todoRevertUnitBlock(document, revisionChanges(document, group))) }));
      for (let start = 0; start === 0 || start < changes.length; start += TODO_CHANGES_REQUEST_MAX) {
        const last = start + TODO_CHANGES_REQUEST_MAX >= changes.length;
        reply({ type: "todoChanges", requestId: msg.requestId, revision: document.revision, changes: changes.slice(start, start + TODO_CHANGES_REQUEST_MAX),
          ...(last && turns.length ? { turns } : {}), ...(last ? {} : { more: true as const }) });
      }
      return;
    }
    if (msg.type === "todoAskDismiss") {
      const result = await todoStore.apply({ kind: "dismissAsk", id: msg.itemId, message: msg.message, place: msg.place }, "human");
      if (!result.ok) output.appendLine(`[todo] dismissAsk was not applied: ${result.error}`);
      return;
    }
    if (msg.type === "todoImageRequest") {
      const data = await todoStore.readImage(msg.name);
      const extension = msg.name.slice(msg.name.lastIndexOf(".") + 1);
      const mediaType = (Object.keys(TODO_IMAGE_EXTENSIONS) as TodoImageMediaType[]).find(type => TODO_IMAGE_EXTENSIONS[type] === extension);
      reply(data && mediaType ? { type: "todoImage", name: msg.name, mediaType, data: data.toString("base64") } : { type: "todoImage", name: msg.name, missing: true });
      return;
    }
    if (msg.type === "todoOpenDoc") {
      await openDoc(todoStore, msg.itemId, msg.docId, sender);
      return;
    }
    if (msg.type === "todoEdit") {
      const prepared = await operationOf(msg.edit, todoStore);
      if (typeof prepared === "string") {
        reply({ type: "todoEditResult", requestId: msg.requestId, ok: false, error: prepared });
        return;
      }
      const result = await todoStore.apply(prepared.operation, "human").catch(async error => {
        if (prepared.written && !(error instanceof TodoStoreError && error.code === "uncertain")) await todoStore.removeImage(prepared.written);
        throw error;
      });
      if (!result.ok && prepared.written) await todoStore.removeImage(prepared.written);
      reply(result.ok
        ? { type: "todoEditResult", requestId: msg.requestId, ok: true, revision: result.document.revision, changed: result.changed, skipped: result.skipped ?? 0 }
        : { type: "todoEditResult", requestId: msg.requestId, ok: false, error: result.error });
      return;
    }
    const document = await todoStore.read();
    if (msg.type === "todoDetailRequest") {
      const item = detailItem(document, msg.id);
      reply({ type: "todoDetail", id: msg.id, revision: document.revision, item, sectionOrder: sectionOrder() });
      if (item) {
        const work = await itemWork(document, msg.id);
        reply({ type: "todoWork", id: msg.id, revision: document.revision, ...(work ? { work } : {}) });
      }
    } else if (msg.view === "claude") {
      reply({ type: "todoLog", view: "claude", revision: document.revision, ...claudeChanges(document) });
    } else {
      reply({ type: "todoLog", view: "deleted", revision: document.revision, items: deletedItems(document) });
    }
  } catch (error) {
    output.appendLine(`[todo] ${msg.type} failed: ${String(error instanceof TodoStoreError ? error.detail ?? error : error)}`);
    if (msg.type === "todoEdit") reply({ type: "todoEditResult", requestId: msg.requestId, ok: false, error: "store" });
    else if (msg.type === "todoAskSourceRequest") reply({ type: "todoAskSource", sessionId: msg.sessionId, requestId: msg.requestId, key: null });
    else if (msg.type === "todoChangesRequest") reply({ type: "todoChanges", requestId: msg.requestId, revision: 0, changes: [] });
  }
}

async function readTodoDocument(purpose: string): Promise<{ todoStore: TodoStore; document: TodoDocument } | undefined> {
  const todoStore = todoFeatureEnabled() ? hostTodoStore() : undefined;
  if (!todoStore) return undefined;
  try { return { todoStore, document: await todoStore.read() }; }
  catch (error) {
    output.appendLine(`[todo] could not read the store (${purpose}): ${String(error instanceof TodoStoreError ? error.detail ?? error : error)}`);
    return undefined;
  }
}

async function applyHostTodoOperation(todoStore: TodoStore, operation: TodoOperation, author: "human" | "claude"): Promise<TodoDocument | undefined> {
  try {
    const result = await todoStore.apply(operation, author);
    if (!result.ok) output.appendLine(`[todo] ${operation.kind} was not applied: ${result.error}`);
    return result.ok ? result.document : undefined;
  } catch (error) {
    output.appendLine(`[todo] ${operation.kind} failed: ${String(error instanceof TodoStoreError ? error.detail ?? error : error)}`);
    return undefined;
  }
}

const TODO_WINDOW_ID = randomUUID();

function todoTabKey(tabId: string): string {
  return `${TODO_WINDOW_ID}:${tabId}`;
}

const liveItem = (document: TodoDocument, id: string | null | undefined) =>
  id ? document.items.find(item => item.id === id && item.deletedAt === undefined) : undefined;

const sessionItems = new Map<string, string | null>();

export function noteTodoSessionEnded(s: Session): void {
  if (replyStarts.delete(s)) output.appendLine("[todo] todoFromReply: the tab closed or was cleared before the turn ended, so no item is opened");
  const sessionId = sessionRecordId(s);
  if (!sessionId) return;
  const linked = sessionItems.get(sessionId);
  sessionItems.delete(sessionId);
  decisionRecorder.ended(sessionId);
  const todoStore = linked ? hostTodoStore() : undefined;
  if (todoStore) void applyHostTodoOperation(todoStore, { kind: "releaseConversation", sessionId, owner: TODO_WINDOW_ID }, "human");
}

export function linkedTodoItemIdOf(s: Session): string | undefined {
  return todoFeatureEnabled() ? cachedItemOf(s) : undefined;
}

function cachedItemOf(s: Session): string | undefined {
  const sessionId = sessionRecordId(s);
  return s.todoItemId ?? (sessionId ? sessionItems.get(sessionId) ?? undefined : undefined);
}

export async function todoLinkedItemAtStart(s: Session): Promise<TodoLinkedItem | undefined> {
  try {
    const read = await readTodoDocument("conversation start");
    if (!read) return undefined;
    const sessionId = sessionRecordId(s);
    const linked = linkedTodoItem(read.document.items, sessionId);
    if (sessionId) sessionItems.set(sessionId, linked?.id ?? null);
    if (sessionId && linked) void applyHostTodoOperation(read.todoStore, { kind: "touchConversation", sessionId, owner: TODO_WINDOW_ID }, "human");
    const item = liveItem(read.document, s.todoItemId) ?? linked;
    if (!item) return undefined;
    const parent = liveItem(read.document, item.parentId);
    return { id: item.id, title: item.title, ...(parent ? { parent: { id: parent.id, title: parent.title } } : {}) };
  } catch (error) {
    output.appendLine(`[todo] could not resolve the item of a starting conversation: ${String(error)}`);
    return undefined;
  }
}

const linkedSessions = new WeakMap<Session, string>();

export function noteTodoConversationEvent(s: Session, ev: { kind: string; auth?: { sessionId?: string } | null }): void {
  if (!todoFeatureEnabled()) return;
  if (ev.kind === "auth_status") {
    const sessionId = ev.auth?.sessionId;
    if (!sessionId || s.todoItemId === undefined || linkedSessions.get(s) === sessionId) return;
    linkedSessions.set(s, sessionId);
    sessionItems.set(sessionId, s.todoItemId);
    const todoStore = hostTodoStore();
    if (todoStore) void applyHostTodoOperation(todoStore, { kind: "linkConversation", id: s.todoItemId, sessionId, owner: TODO_WINDOW_ID, tab: todoTabKey(s.tabId) }, "human");
    return;
  }
  if (ev.kind === "turn_started") {
    s.todoTurnStartedAt = Date.now();
    if (cachedItemOf(s) !== undefined) postTodoSnapshot();
    return;
  }
  if (ev.kind !== "turn_completed" && ev.kind !== "turn_failed" && ev.kind !== "turn_interrupted") return;
  const startedAt = s.todoTurnStartedAt;
  s.todoTurnStartedAt = undefined;
  if (cachedItemOf(s) === undefined) return;
  const sessionId = sessionRecordId(s);
  if (sessionId) void decisionRecorder.turnEnded(sessionId);
  const todoStore = hostTodoStore();
  if (startedAt === undefined || !sessionId || !todoStore) {
    postTodoSnapshot();
    return;
  }
  void applyHostTodoOperation(todoStore, { kind: "noteConversationWork", sessionId, at: startedAt }, "claude").then(() => postTodoSnapshot());
}

export async function todoHandoffMemo(sourceSessionId: string): Promise<HandoffWorkMemo | undefined> {
  const read = await readTodoDocument("handoff");
  const item = read ? linkedTodoItem(read.document.items, sourceSessionId) : undefined;
  return item ? handoffWorkMemoOf(item) : undefined;
}

export async function relinkTodoConversation(from: string, to: string): Promise<void> {
  const todoStore = todoFeatureEnabled() ? hostTodoStore() : undefined;
  if (todoStore) await applyHostTodoOperation(todoStore, { kind: "relinkConversation", from, to }, "human");
}

const startItemConversation = singleFlight<readonly [string, boolean]>();

export function openTodoConversation(st: SessionStore, msg: Extract<WebviewToHost, { type: "todoOpenConversation" }>, sender: vscode.Webview): Promise<void> {
  return startItemConversation([msg.itemId, msg.fresh], () => openTodoConversationNow(st, msg, sender));
}

function showOpenElsewhere(): void {
  void vscode.window.showInformationMessage(l10n.t("LAISORA: This ToDo item's conversation is open or starting in another window. Continue it there."));
}

async function openTodoConversationNow(st: SessionStore, msg: Extract<WebviewToHost, { type: "todoOpenConversation" }>, sender: vscode.Webview): Promise<void> {
  const read = await readTodoDocument("open a conversation");
  const item = read ? liveItem(read.document, msg.itemId) : undefined;
  if (!read || !item) return;
  const tabs = [...st.sessions.values()].filter(s => !s.closed).map(s => ({ tabId: s.tabId, itemId: s.todoItemId, sessionId: sessionRecordId(s), running: false }));
  const target = todoConversationTarget(read.document.items, item.id, tabs, msg.fresh, { owner: TODO_WINDOW_ID, now: Date.now() });
  if (target.kind === "elsewhere") {
    showOpenElsewhere();
    return;
  }
  if (target.kind === "tab") {
    await st.postTo(sender, { type: "activateTab", tabId: target.tabId });
    return;
  }
  if (target.kind === "session") {
    const opened = await openSessionById(st, sender, target.sessionId);
    if (opened === "not_found" || opened === "scan_failed") {
      void vscode.window.showWarningMessage(opened === "not_found"
        ? l10n.t("LAISORA: The conversation linked to this ToDo item was not found. Use “Continue in a new conversation” in the item's details.")
        : l10n.t("LAISORA: Could not check the conversation linked to this ToDo item. Please try again."));
    }
    return;
  }
  const started = await runClaimedStart(operation => applyHostTodoOperation(read.todoStore, operation, "human"), item.id, TODO_WINDOW_ID, randomUUID(), async () => {
    const session = openNewConversationTab(st, s => {
      s.todoItemId = item.id;
      s.title = displayTitleFromSummary(item.title, s.tabId);
      s.autoTitled = true;
      const chosen = normalizeTitleValue(item.title);
      s.unpersistedChosenTitle = chosen === null ? null : { title: chosen, failedAttempts: 0 };
    });
    if (!session) return false;
    postTodoSnapshot();
    const parent = liveItem(read.document, item.parentId);
    const brief = todoStartBrief(item, parent, item.conversations !== undefined);
    await applyHostTodoOperation(read.todoStore, { kind: "recordStart", id: item.id, start: parent ? "child" : item.conversations !== undefined || msg.fresh ? "continue" : "start", brief, tab: todoTabKey(session.tabId) }, "human");
    await sendLaisoraInput(session, { kind: "todo", title: item.title }, brief);
    return true;
  });
  if (started === "elsewhere") showOpenElsewhere();
}

const replyStarts = new WeakMap<Session, { sinceRevision: number; st: SessionStore }>();
const replyRequests = new WeakSet<Session>();

const replySessionId = (s: Session): string | undefined => s.conversation?.recordSessionId ?? sessionRecordId(s);

function liveConversation(s: Session): ClaudeConversation | undefined {
  return s.conversation !== null && !s.conversation.isClosed ? s.conversation : undefined;
}

function replyAdmission(s: Session): ReturnType<typeof admitIdleSend> {
  return admitIdleSend({ closed: s.closed || s.clearing, turnState: liveConversation(s)?.state ?? "idle" }, "todoFromReply");
}

async function replyTextOf(sessionId: string, replyId: string): Promise<string | "unreadable" | undefined> {
  const path = lookupSessionFile(sessionId).path;
  if (!path) return "unreadable";
  const read = await readConversationMessages(path, isInSessionStore, undefined, sessionId);
  if (read.readError !== undefined) {
    output.appendLine(`[todo] todoFromReply could not read the conversation record: ${read.readError}`);
    return "unreadable";
  }
  return todoReplyText(read.messages, replyId);
}

export async function todoFromReply(st: SessionStore, msg: Extract<WebviewToHost, { type: "todoFromReply" }>, s: Session): Promise<void> {
  const refuse = (why: string, notice?: string) => {
    output.appendLine(`[todo] todoFromReply refused: ${why}`);
    if (notice !== undefined) st.post({ type: "tabNotice", tabId: s.tabId, text: notice });
  };
  if (replyRequests.has(s)) return refuse("a request from this tab is still being prepared");
  const admission = replyAdmission(s);
  if (!admission.ok) return refuse(admission.message);
  if (liveConversation(s)?.hasTodoTools === false) {
    return refuse("the conversation was started without the ToDo tools", l10n.t("This conversation was started while ToDo was off, so Claude has no ToDo tools here. Resume or start the conversation again to use them."));
  }
  const sessionId = replySessionId(s);
  if (!sessionId) return refuse("the conversation has no record", l10n.t("Could not find this reply in the conversation record, so nothing was added to ToDo."));
  replyRequests.add(s);
  try {
    const read = await readTodoDocument("todo from a reply");
    if (!read) return refuse("ToDo is off or unreadable");
    const text = await replyTextOf(sessionId, msg.replyId);
    if (text === "unreadable") return refuse("the conversation record could not be read", l10n.t("Could not read the conversation record, so nothing was added to ToDo."));
    if (text === undefined) return refuse("the reply is not in the conversation record", l10n.t("Could not find this reply in the conversation record, so nothing was added to ToDo."));
    const again = replyAdmission(s);
    if (!again.ok) return refuse(again.message);
    const linked = liveItem(read.document, linkedTodoItemIdOf(s));
    const instruction = todoFromReplyInstruction({ excerpt: todoReplyExcerpt(text), ...(linked ? { linked: { id: linked.id, title: linked.title } } : {}), start: msg.start });
    if (msg.start) replyStarts.set(s, { sinceRevision: read.document.revision, st });
    else replyStarts.delete(s);
    let started = false;
    try {
      started = await sendLaisoraInput(s, { kind: "todoFromReply", start: msg.start }, instruction);
    } finally {
      if (!started && replyStarts.delete(s)) output.appendLine("[todo] todoFromReply: the request did not start a turn, so no item is opened");
    }
  } finally {
    replyRequests.delete(s);
  }
}

export function settleTodoReplyStart(s: Session, completed: boolean): void {
  const pending = replyStarts.get(s);
  if (!pending) return;
  replyStarts.delete(s);
  const sessionId = s.conversation?.recordSessionId;
  if (!completed || !sessionId) {
    output.appendLine("[todo] todoFromReply: the turn did not complete, so no item is opened");
    return;
  }
  void (async () => {
    const read = await readTodoDocument("open the item made from a reply");
    if (!read) return;
    const added = todoItemsAddedInTurn(read.document, sessionId, pending.sinceRevision);
    if (added.length !== 1) {
      output.appendLine(`[todo] todoFromReply: Claude added ${added.length} top-level items in that turn, so none is opened`);
      return;
    }
    const webview = pending.st.activeWebview;
    if (!webview) {
      output.appendLine("[todo] todoFromReply: no LAISORA view is open, so the item is not opened");
      return;
    }
    await openTodoConversation(pending.st, { type: "todoOpenConversation", itemId: added[0], fresh: false }, webview);
  })().catch(error => output.appendLine(`[todo] todoFromReply could not open the item: ${String(error)}`));
}
