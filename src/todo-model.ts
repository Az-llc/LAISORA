import { ASK_FENCE_INFO } from "./markdown-ast";

export const TODO_STATES = ["todo", "doing", "done"] as const;
export type TodoState = typeof TODO_STATES[number];
export type TodoAuthor = "human" | "claude";
export type TodoCompletion = "auto" | "manual";
export const WORK_MEMO_SECTIONS = ["current", "next", "decisions", "open", "files"] as const;
export type WorkMemoSection = typeof WORK_MEMO_SECTIONS[number];

export const TODO_SERVER_NAME = "laisora_todo";
export const TODO_TOOL_KINDS = ["list", "add", "update", "move", "set_state", "write_memo", "delete", "group", "tidy"] as const;
export type TodoToolKind = typeof TODO_TOOL_KINDS[number];
export const todoToolName = (kind: TodoToolKind) => `mcp__${TODO_SERVER_NAME}__${kind}`;
export const TODO_WRITE_TOOLS = TODO_TOOL_KINDS.filter(kind => kind !== "list").map(todoToolName);
export const TODO_TIDY_TOOL = todoToolName("tidy");
export const TODO_CARD_TOOLS = TODO_WRITE_TOOLS;
const TODO_RESULT_CHANGES = /^\{"changes":\[((?:"[0-9]+\.[0-9]+",?)*)\]/;
const TODO_RESULT_REVISION = /^\{"revision":([0-9]+)[,}]/;

export function todoWriteResultText(revision: number | null, body: Record<string, unknown>): string {
  return JSON.stringify({ revision: revision ?? 0, ...body });
}

export type TodoWriteResultRef = { readonly revision: number } | { readonly ids: readonly string[] };

export function todoWriteResultRef(text: string | undefined): TodoWriteResultRef | undefined {
  const trimmed = text?.trimStart();
  if (trimmed === undefined) return undefined;
  const revision = TODO_RESULT_REVISION.exec(trimmed);
  if (revision) return Number(revision[1]) === 0 ? { ids: [] } : { revision: Number(revision[1]) };
  const legacy = TODO_RESULT_CHANGES.exec(trimmed);
  return legacy ? { ids: [...legacy[1].matchAll(/"([0-9]+\.[0-9]+)"/g)].map(entry => entry[1]) } : undefined;
}

export function parseTodoChangeId(changeId: string): { readonly revision: number; readonly index: number } {
  const dot = changeId.indexOf(".");
  return { revision: Number(changeId.slice(0, dot)), index: Number(changeId.slice(dot + 1)) };
}

const todoChangeId = (revision: number, index: number) => `${revision}.${index}`;

export const isClaudeOwnChange = (change: Pick<TodoChange, "author" | "cascade">) => change.author === "claude" && !change.cascade;

const TODO_AGENT_MARKER = /\(ToDo #([0-9a-f]{1,64})\)\s*$/;

export function todoAgentMarker(id: string): string {
  return `(ToDo #${id})`;
}

export function todoAgentItemId(description: string | undefined): { readonly id: string; readonly rest: string } | undefined {
  const match = description === undefined ? null : TODO_AGENT_MARKER.exec(description);
  return match ? { id: match[1], rest: description!.slice(0, match.index).trimEnd() } : undefined;
}

export const TODO_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type TodoPriority = typeof TODO_PRIORITIES[number];
export const TODO_TEXT_FIELDS = ["title", "group", "due", "start", "priority", "userMemo", "waiting", "repeat", "estimate", "tags"] as const;
export const TODO_GROUP_MAX = 80;
export const TODO_WAITING_MAX = 80;
export const TODO_TAGS_MAX = 200;
export const TODO_ESTIMATE_PATTERN = /^\d{1,4}(\.\d{1,2})?$/;
export const TODO_REPEAT_PATTERN = /^(daily|weekly-[0-6]|monthly-first|monthly-last)$/;
export const TODO_GUESS_REASON_MAX = 200;
export const TODO_TEMPLATE_NAME_MAX = 80;
export const TODO_TEMPLATE_NODES_MAX = 200;
export const TODO_TEMPLATES_MAX = 100;
export const TODO_BRIEF_MAX = 20_000;
export const TODO_ACKNOWLEDGE_MAX = 500;
export const TODO_STARTS_MAX = 20;
export const TODO_START_KINDS = ["start", "continue", "child"] as const;
export type TodoStartKind = typeof TODO_START_KINDS[number];
export type TodoTextField = typeof TODO_TEXT_FIELDS[number];
export type TodoRevertMode = "undo" | "claude";

export const TODO_DOC_KINDS = ["url", "file", "image"] as const;
export type TodoDocKind = typeof TODO_DOC_KINDS[number];
export const TODO_IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;
export type TodoImageMediaType = keyof typeof TODO_IMAGE_EXTENSIONS;
export const TODO_IMAGE_FILE = /^(\d{13})-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;
export const TODO_DOC_TARGET_MAX = 2048;
export const TODO_DOC_LABEL_MAX = 200;

export const TODO_DUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TODO_TITLE_MAX = 200;
export const TODO_GROUP_COLOR_COUNT = 6;
export const TODO_DOCUMENT_VERSION = 1;
export const TODO_DELETED_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const TODO_MEMO_HISTORY_LIMIT = 50;
export const TODO_CHANGE_LOG_LIMIT = 1000;
export const TODO_ASK_SOURCE_MESSAGES_MAX = 2000;
export const TODO_ASK_DISMISSALS_MAX = 2000;
export const TODO_ASK_IDENTITY_MAX = 200;
export const TODO_ASK_PLACES = ["todo", "chat"] as const;
export type TodoAskPlace = typeof TODO_ASK_PLACES[number];

export interface TodoMemoVersion {
  readonly version: number;
  readonly text: string;
  readonly at: number;
}

export interface TodoMemoSection extends TodoMemoVersion {
  readonly history: readonly TodoMemoVersion[];
}

export interface TodoItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly state: TodoState;
  readonly completion?: TodoCompletion;
  readonly group?: string;
  readonly due?: string;
  readonly start?: string;
  readonly priority?: TodoPriority;
  readonly userMemo: string;
  readonly workMemo: Readonly<Partial<Record<WorkMemoSection, TodoMemoSection>>>;
  readonly waiting?: string;
  readonly repeat?: string;
  readonly estimate?: string;
  readonly tags?: string;
  readonly by?: "claude";
  readonly guesses?: TodoGuesses;
  readonly starts?: readonly TodoStart[];
  readonly source?: { readonly sessionId: string };
  readonly placedFrom?: string;
  readonly caseWords?: string;
  readonly captured?: TodoCaptured;
  readonly placement?: TodoPlacement;
  readonly pinnedAt?: number;
  readonly startedAt?: number;
  readonly doneAt?: number;
  readonly docs?: readonly TodoDoc[];
  readonly conversations?: readonly TodoConversationLink[];
  readonly pendingStart?: TodoStartClaim;
  readonly dismissedAsks?: readonly string[];
  readonly asksClosedInTodo?: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt?: number;
}

export const TODO_CAPTURE_VIA = ["user", "claude", "import"] as const;
export interface TodoCaptured {
  readonly text: string;
  readonly at: number;
  readonly via: typeof TODO_CAPTURE_VIA[number];
}

export const TODO_ADD_PLACEMENT_BASES = ["named", "linked", "files", "folder", "alias", "inbox"] as const;
export const TODO_PLACEMENT_BASES = [...TODO_ADD_PLACEMENT_BASES, "tidy", "requested"] as const;
export type TodoPlacementBasis = typeof TODO_PLACEMENT_BASES[number];
export interface TodoPlacement {
  readonly basis: TodoPlacementBasis;
  readonly at: number;
  readonly from?: TodoPlace;
}

export const TODO_STABLE_TOUCH_MS = 48 * 60 * 60_000;
export const TODO_STABLE_PIN_MS = 30 * 24 * 60 * 60_000;
export const TODO_STABLE_REMOVE_MS = 7 * 24 * 60 * 60_000;
export const TODO_RECENT_CLAUDE_MS = 2 * 24 * 60 * 60_000;

export interface TodoGuess {
  readonly value: string;
  readonly reason: string;
}

export type TodoGuessField = "due" | "priority";
export type TodoGuesses = Readonly<Partial<Record<TodoGuessField, TodoGuess>>>;

export interface TodoStart {
  readonly at: number;
  readonly kind: TodoStartKind;
  readonly brief: string;
  readonly sessionId?: string;
  readonly tab?: string;
  readonly current?: string;
  readonly next?: string;
  readonly stale?: true;
}

export interface TodoGroupFolder {
  readonly path: string;
  readonly change?: string;
}

export interface TodoGroup {
  readonly name: string;
  readonly color: number;
  readonly folders?: readonly TodoGroupFolder[];
  readonly aliases?: readonly TodoGroupAlias[];
}

export interface TodoGroupAlias {
  readonly words: string;
  readonly parentId?: string;
  readonly change?: string;
  readonly basis?: TodoPlacementBasis;
}

export interface TodoGroupRecord extends TodoGroup {
  readonly index: number;
}

export const TODO_TIDY_KINDS = ["move", "merge", "flatten", "foldDone", "rename", "add"] as const;
export interface TodoTidyNode { readonly title: string; readonly children?: readonly TodoTidyNode[] }
type TodoTidyAsked = { readonly requested?: true };
export type TodoTidyStep =
  | { readonly kind: "rename"; readonly id: string; readonly title: string }
  | { readonly kind: "add"; readonly id: string; readonly items: readonly TodoTidyNode[] }
  | ({ readonly kind: "move"; readonly id: string; readonly parentId: string | null; readonly group?: string; readonly position?: number } & TodoTidyAsked)
  | ({ readonly kind: "merge"; readonly id: string; readonly into: string; readonly flattened?: true } & TodoTidyAsked)
  | ({ readonly kind: "flatten"; readonly id: string } & TodoTidyAsked)
  | { readonly kind: "foldDone"; readonly id: string };
export const TODO_TIDY_STEPS_MAX = 50;
export const TODO_TIDY_KEPT = 50;

export interface TodoPathStep {
  readonly number: string;
  readonly title: string;
}

export interface TodoPlace {
  readonly group: string | null;
  readonly steps: readonly TodoPathStep[];
}

export interface TodoTidyRecord {
  readonly id: string;
  readonly at: number;
  readonly steps: readonly TodoTidyStep[];
  readonly revision: number;
}

export interface TodoTemplateNode {
  readonly title: string;
  readonly children?: readonly TodoTemplateNode[];
}

export interface TodoTemplate {
  readonly id: string;
  readonly name: string;
  readonly root: TodoTemplateNode;
  readonly at: number;
}

export interface TodoConversationLink {
  readonly sessionId: string;
  readonly at: number;
  readonly workedAt?: number;
  readonly owner?: string;
  readonly seenAt?: number;
  readonly via?: "handoff";
}

export interface TodoStartClaim {
  readonly owner: string;
  readonly token: string;
  readonly at: number;
}

export const TODO_CONVERSATION_LINKS_MAX = 20;
export const TODO_START_CLAIM_MS = 60_000;
export const TODO_CONVERSATION_SEEN_REFRESH_MS = 2 * 60_000;
export const TODO_CONVERSATION_LIVE_MS = 5 * 60_000;

export interface TodoDoc {
  readonly id: string;
  readonly kind: TodoDocKind;
  readonly target: string;
  readonly label?: string;
  readonly mediaType?: TodoImageMediaType;
  readonly at: number;
}

export interface TodoChange {
  readonly id: string;
  readonly at: number;
  readonly author: TodoAuthor;
  readonly itemId: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly cascade?: true;
  readonly revertible?: false;
  readonly revertOf?: string;
  readonly acknowledged?: true;
  readonly guess?: TodoGuess;
  readonly basis?: TodoPlacementBasis;
}

export interface TodoDocument {
  readonly version: typeof TODO_DOCUMENT_VERSION;
  readonly revision: number;
  readonly items: readonly TodoItem[];
  readonly changes: readonly TodoChange[];
  readonly writes?: readonly string[];
  readonly groupColors?: Readonly<Record<string, number>>;
  readonly groups?: readonly TodoGroup[];
  readonly templates?: readonly TodoTemplate[];
  readonly tidy?: readonly TodoTidyRecord[];
  readonly unboundFolders?: readonly string[];
}

export type TodoGuessReasons = { dueReason?: string; priorityReason?: string };
export type TodoUpdateOperation = { kind: "update"; basis?: TodoPlacementBasis; id: string; title?: string; group?: string | null; due?: string | null; start?: string | null; priority?: TodoPriority | null; userMemo?: string; state?: TodoState;
  waiting?: string | null; repeat?: string | null; estimate?: string | null; tags?: string | null; newGroup?: boolean; session?: string | null } & TodoGuessReasons;
export type TodoMoveOperation = { kind: "move"; id: string; parentId: string | null; position?: number; before?: string | null; restoreGroup?: string; session?: string | null; basis?: TodoPlacementBasis; allowTwin?: true; targetGroup?: string };
export type TodoSetStateOperation = { kind: "setState"; id: string; state: TodoState; session?: string | null };
export type TodoDeleteOperation = { kind: "delete"; id: string; session?: string | null };
export type TodoBatchStep = TodoUpdateOperation | TodoMoveOperation | TodoSetStateOperation | TodoDeleteOperation;
export const TODO_BATCH_MAX = 500;
export type TodoAddOperation = { kind: "add"; parentId: string | null; title: string; group?: string; due?: string; start?: string; priority?: TodoPriority; state?: TodoState; userMemo?: string; position?: number; templateId?: string;
  waiting?: string; repeat?: string; estimate?: string; tags?: string; sourceSession?: string; placedFrom?: string; caseWords?: string; newGroup?: boolean; basis?: TodoPlacementBasis; imported?: boolean } & TodoGuessReasons;
export type TodoAddNode = Omit<TodoAddOperation, "kind" | "parentId" | "position" | "templateId"> & { readonly children?: readonly TodoAddNode[] };
export const TODO_ADD_MANY_MAX = 100;
export const TODO_CLAUDE_DEPTH_MAX = 3;

export function todoAddNodeCount(nodes: readonly TodoAddNode[]): number {
  return nodes.reduce((count, node) => count + 1 + todoAddNodeCount(node.children ?? []), 0);
}

export function todoAddNodeDepth(nodes: readonly TodoAddNode[]): number {
  return nodes.reduce((depth, node) => Math.max(depth, 1 + todoAddNodeDepth(node.children ?? [])), 0);
}

export type TodoGroupOperation =
  | { kind: "groupCreate"; name: string }
  | { kind: "groupRename"; name: string; to: string }
  | { kind: "groupColor"; name: string; color: number }
  | { kind: "groupMove"; name: string; direction: -1 | 1 }
  | { kind: "groupMove"; name: string; position: number }
  | { kind: "groupDelete"; name: string }
  | { kind: "groupFolderRemove"; name: string; path: string }
  | { kind: "groupFolderAdd"; name: string; path: string }
  | { kind: "groupAliasRemove"; name: string; words: string };

export type TodoTidyOperation =
  | { kind: "tidy"; steps: readonly TodoTidyStep[] };

export type TodoOperation =
  | TodoAddOperation
  | { kind: "addMany"; parentId: string | null; items: readonly TodoAddNode[] }
  | TodoUpdateOperation
  | TodoGroupOperation
  | TodoTidyOperation
  | { kind: "templateSave"; id: string; name: string }
  | { kind: "docLabel"; id: string; docId: string; label: string }
  | { kind: "acknowledge"; changeIds: readonly string[] }
  | { kind: "recordStart"; id: string; start: TodoStartKind; brief: string; tab: string }
  | TodoMoveOperation
  | TodoSetStateOperation
  | { kind: "batch"; steps: readonly TodoBatchStep[] }
  | { kind: "writeWorkMemo"; id: string; section: WorkMemoSection; text: string }
  | { kind: "writeWorkMemos"; id: string; sections: Partial<Record<WorkMemoSection, string>> }
  | TodoDeleteOperation
  | { kind: "restore"; id: string }
  | { kind: "addDoc"; id: string; doc: Omit<TodoDoc, "id" | "at"> }
  | { kind: "removeDoc"; id: string; docId: string }
  | { kind: "linkConversation"; id: string; sessionId: string; owner?: string; tab?: string }
  | { kind: "claimStart"; id: string; owner: string; token: string }
  | { kind: "releaseStart"; id: string; token: string }
  | { kind: "touchConversation"; sessionId: string; owner: string }
  | { kind: "releaseConversation"; sessionId: string; owner: string }
  | { kind: "releaseOwner"; owner: string }
  | { kind: "relinkConversation"; from: string; to: string }
  | { kind: "noteConversationWork"; sessionId: string; at: number }
  | { kind: "dismissAsk"; id: string; message: string; place: TodoAskPlace }
  | { kind: "revert"; mode: "undo"; revision: number }
  | { kind: "revert"; mode: "claude"; changeId: string }
  | { kind: "revert"; mode: "claude"; changeIds: readonly string[] }
  | { kind: "revert"; mode: "claude"; revisions: readonly number[] };

type TodoStepOperation =
  | Exclude<TodoOperation, { kind: "revert" } | { kind: "acknowledge" } | TodoTidyOperation>
  | { kind: "tidyStep"; step: TodoTidyStep }
  | { kind: "setGroupBindings"; group: string; folders: readonly TodoGroupFolder[]; aliases: readonly TodoGroupAlias[] }
  | { kind: "setExactState"; id: string; state: TodoState; completion?: TodoCompletion; startedAt?: number | null }
  | { kind: "restoreWorkMemo"; id: string; section: WorkMemoSection; version: number | null }
  | { kind: "putDoc"; id: string; doc: TodoDoc }
  | { kind: "setGroupEntry"; current: string | null; to: TodoGroupRecord | null }
  | { kind: "setTemplate"; current: string | null; to: TodoTemplate | null }
  | { kind: "restoreItemGroup"; id: string; group: string | null }
  | (TodoUpdateOperation & { readonly restoreGuess: { readonly field: TodoGuessField; readonly guess: TodoGuess } });

export const TODO_REVERT_BLOCKS = ["not-target", "unrevertible", "reverted", "gone", "superseded", "in-use"] as const;
export type TodoRevertBlock = typeof TODO_REVERT_BLOCKS[number];

export const TODO_OPERATION_ERRORS = ["not-found", "deleted", "invalid-parent", "cycle", "empty-title", "title-too-long", "author-not-allowed", "group-exists", "invalid-name", "too-many",
  "too-deep", "duplicate-title", "title-state", "outside-linked", "user-item", "unknown-group", "near-group", "merge-done", "not-single-child", "unstable", "group-has-user-items", ...TODO_REVERT_BLOCKS] as const;
export type TodoOperationError = typeof TODO_OPERATION_ERRORS[number];

export interface TodoOperationDetail {
  readonly itemId?: string;
  readonly word?: string;
  readonly near?: readonly string[];
  readonly step?: number;
  readonly title?: string;
}

export type TodoOperationFailure = { readonly ok: false; readonly error: TodoOperationError; readonly detail?: TodoOperationDetail };

export type TodoOperationResult =
  | { readonly ok: true; readonly document: TodoDocument; readonly itemId: string; readonly changed: boolean; readonly skipped?: number }
  | TodoOperationFailure;

export interface TodoOperationContext {
  readonly author: TodoAuthor;
  readonly now: number;
  readonly newId: (taken: ReadonlySet<string>) => string;
}

export type TodoStateRecord = Pick<TodoItem, "state" | "completion"> & { readonly startedAt?: number | null };

export interface TodoStateChange {
  readonly id: string;
  readonly before: TodoStateRecord;
  readonly after: Pick<TodoItem, "state" | "completion">;
}

function stateRecord(item: TodoItem): TodoStateRecord {
  return { state: item.state, completion: item.completion, startedAt: item.startedAt ?? null };
}

export function emptyTodoDocument(): TodoDocument {
  return { version: TODO_DOCUMENT_VERSION, revision: 0, items: [], changes: [] };
}

const validColor = (color: unknown): color is number => Number.isSafeInteger(color) && (color as number) >= 1 && (color as number) <= TODO_GROUP_COLOR_COUNT;

export function unusedGroupColor(groups: readonly TodoGroup[]): number {
  const uses = Array.from({ length: TODO_GROUP_COLOR_COUNT }, (_, index) => groups.filter(group => group.color === index + 1).length);
  return uses.indexOf(Math.min(...uses)) + 1;
}

function itemGroupNames(items: readonly TodoItem[]): string[] {
  return [...new Set(items.flatMap(item => item.deletedAt === undefined && item.parentId === null && item.group !== undefined ? [item.group] : []))];
}

export function todoGroupsOf(document: Pick<TodoDocument, "items" | "groups" | "groupColors">): TodoGroup[] {
  if (document.groups) return [...document.groups];
  const groups: TodoGroup[] = [];
  const names = itemGroupNames(document.items);
  for (const name of names) {
    const kept = document.groupColors?.[name];
    if (validColor(kept)) groups.push({ name, color: kept });
  }
  for (const name of names) if (!groups.some(group => group.name === name)) groups.push({ name, color: unusedGroupColor(groups) });
  return names.map(name => groups.find(group => group.name === name)!);
}

export function todoTemplatesOf(document: Pick<TodoDocument, "templates">): TodoTemplate[] {
  return [...(document.templates ?? [])];
}

function groupRecord(groups: readonly TodoGroup[], name: string): TodoGroupRecord | null {
  const index = groups.findIndex(group => group.name === name);
  if (index < 0) return null;
  const folders = groups[index].folders;
  return { name, color: groups[index].color, ...(folders?.length ? { folders } : {}), index };
}

function withNewGroup(groups: readonly TodoGroup[], name: string, log: ChangeLog): TodoGroup[] {
  const next = [...groups, { name, color: unusedGroupColor(groups) }];
  log("", "groups", null, groupRecord(next, name));
  return next;
}

function isGroupFolders(value: unknown): value is TodoGroupFolder[] {
  return Array.isArray(value) && value.every(entry => isRecord(entry) && typeof entry.path === "string" && entry.path.length > 0 && entry.path.length <= TODO_DOC_TARGET_MAX
    && (entry.change === undefined || typeof entry.change === "string"));
}

function isGroupRecord(value: unknown): value is TodoGroupRecord {
  return isRecord(value) && typeof value.name === "string" && validColor(value.color) && typeof value.index === "number" && Number.isSafeInteger(value.index) && value.index >= 0
    && (value.folders === undefined || isGroupFolders(value.folders));
}

function isTodoTemplate(value: unknown): value is TodoTemplate {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && typeof value.at === "number" && isTemplateNode(value.root, 0);
}

function isTemplateNode(value: unknown, depth: number): value is TodoTemplateNode {
  return isRecord(value) && typeof value.title === "string" && value.title.trim().length > 0 && depth < TODO_TEMPLATE_NODES_MAX
    && (value.children === undefined || (Array.isArray(value.children) && value.children.every(child => isTemplateNode(child, depth + 1))));
}

export function todoTemplateSize(node: TodoTemplateNode): number {
  return 1 + (node.children ?? []).reduce((count, child) => count + todoTemplateSize(child), 0);
}

export function todoFinishedIds(items: readonly Pick<TodoItem, "id" | "parentId" | "state" | "completion">[]): Set<string> {
  const byId = new Map(items.map(item => [item.id, item]));
  const finished = new Set<string>();
  const memo = new Map<string, boolean>();
  const heldAbove = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const parentId = byId.get(id)?.parentId ?? null;
    const parent = parentId === null ? undefined : byId.get(parentId);
    const held = parent !== undefined && ((parent.state === "done" && parent.completion === "manual") || heldAbove(parent.id));
    memo.set(id, held);
    return held;
  };
  for (const item of items) if (item.state === "done" || heldAbove(item.id)) finished.add(item.id);
  return finished;
}

export function liveChildren(items: readonly TodoItem[], parentId: string | null): TodoItem[] {
  return items.filter(item => item.parentId === parentId && item.deletedAt === undefined);
}

export function settledParentState(parent: Pick<TodoItem, "state" | "completion">, childStates: readonly TodoState[]): Pick<TodoItem, "state" | "completion"> {
  if (childStates.length === 0) return parent;
  if (parent.state === "done" && parent.completion === "manual") return parent;
  if (childStates.every(state => state === "done")) return { state: "done", completion: "auto" };
  const started = childStates.some(state => state !== "todo");
  if (parent.state === "done") return { state: started ? "doing" : "todo", completion: undefined };
  if (parent.state === "todo" && started) return { state: "doing", completion: undefined };
  return parent;
}

export function cascadeStates(items: readonly TodoItem[], from: Iterable<string | null>, now: number): { items: TodoItem[]; changed: TodoStateChange[] } {
  const byId = new Map(items.map(item => [item.id, item]));
  const changed = new Map<string, TodoStateChange>();
  for (const start of from) {
    const seen = new Set<string>();
    for (let id = start; id !== null && !seen.has(id);) {
      seen.add(id);
      const parent = byId.get(id);
      if (!parent || parent.deletedAt !== undefined) break;
      const childStates = [...byId.values()].filter(item => item.parentId === id && item.deletedAt === undefined).map(item => item.state);
      const next = settledParentState(parent, childStates);
      if (next.state !== parent.state || next.completion !== parent.completion) {
        const before = changed.get(id)?.before ?? stateRecord(parent);
        byId.set(id, withState(parent, next, now));
        changed.set(id, { id, before, after: next });
      }
      id = parent.parentId;
    }
  }
  return { items: items.map(item => byId.get(item.id)!), changed: [...changed.values()] };
}

function withState(item: TodoItem, next: Pick<TodoItem, "state" | "completion"> & { readonly startedAt?: number | null }, now: number): TodoItem {
  const { completion: _previous, doneAt: _done, startedAt: _started, ...rest } = item;
  const startedAt = next.startedAt !== undefined ? next.startedAt ?? undefined : item.startedAt ?? (next.state !== "todo" ? now : undefined);
  const doneAt = next.state !== "done" ? undefined : item.state === "done" && item.doneAt !== undefined ? item.doneAt : now;
  return { ...rest, state: next.state, ...(next.completion ? { completion: next.completion } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}), ...(doneAt !== undefined ? { doneAt } : {}), updatedAt: now };
}

function isDescendant(items: readonly TodoItem[], candidate: string | null, ancestor: string): boolean {
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (let id = candidate; id !== null && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
    if (id === ancestor) return true;
    seen.add(id);
  }
  return false;
}

function subtreeIds(items: readonly TodoItem[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const item of items) if (item.parentId !== null && ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); grew = true; }
  }
  return ids;
}

function placeAmongSiblings(items: readonly TodoItem[], item: TodoItem, position: number | undefined): TodoItem[] {
  const others = items.filter(entry => entry.id !== item.id);
  const siblings = liveChildren(others, item.parentId);
  const anchor = position === undefined || position >= siblings.length ? undefined : siblings[Math.max(0, Math.floor(position))];
  if (!anchor) {
    const last = siblings.at(-1);
    const index = last ? others.indexOf(last) + 1 : others.length;
    return [...others.slice(0, index), item, ...others.slice(index)];
  }
  const index = others.indexOf(anchor);
  return [...others.slice(0, index), item, ...others.slice(index)];
}

function siblingPosition(items: readonly TodoItem[], item: TodoItem): number {
  return liveChildren(items, item.parentId).findIndex(entry => entry.id === item.id);
}

type MemoKept = { readonly itemId: string; readonly field: string; readonly versions: ReadonlySet<number> };
type LogExtra = { readonly guess?: TodoGuess; readonly cascade?: true; readonly basis?: TodoPlacementBasis };
type ChangeLog = (itemId: string, field: string, before: unknown, after: unknown, extra?: LogExtra) => void;
type StepMeta = { readonly groups: readonly TodoGroup[]; readonly templates: readonly TodoTemplate[]; readonly history?: readonly TodoChange[] };
type StepResult =
  | { readonly ok: true; readonly items: TodoItem[]; readonly itemId: string; readonly reevaluate: Array<string | null>; readonly memoKept?: readonly MemoKept[]; readonly unlogged?: true; readonly meta?: StepMeta }
  | TodoOperationFailure;

function guessesWith(item: Pick<TodoItem, "guesses">, field: "due" | "priority", value: string | null | undefined, reason: string | undefined): TodoGuesses | undefined {
  if (value === undefined) return item.guesses;
  const { [field]: _old, ...rest } = item.guesses ?? {};
  const next: TodoGuesses = value && reason?.trim() ? { ...rest, [field]: { value, reason: reason.trim().slice(0, TODO_GUESS_REASON_MAX) } } : rest;
  return Object.keys(next).length ? next : undefined;
}

function withGuesses(item: TodoItem, guesses: TodoGuesses | undefined): TodoItem {
  const { guesses: _old, ...rest } = item;
  return guesses ? { ...rest, guesses } : rest;
}

const groupName = (name: string) => name.trim();

function renameGroupOnItems(items: TodoItem[], from: string, to: string, now: number, log: ChangeLog | null): TodoItem[] {
  return items.map(entry => {
    if (entry.group !== from) return entry;
    if (entry.deletedAt === undefined) log?.(entry.id, "group", from, to);
    return { ...entry, group: to, updatedAt: now };
  });
}
const validGroupName = (name: string) => name.length > 0 && name.length <= TODO_GROUP_MAX;

function templateTree(items: readonly TodoItem[], id: string, budget: { left: number }): TodoTemplateNode {
  budget.left--;
  const item = items.find(entry => entry.id === id)!;
  const children: TodoTemplateNode[] = [];
  for (const child of liveChildren(items, id)) {
    if (budget.left <= 0) break;
    children.push(templateTree(items, child.id, budget));
  }
  return { title: item.title, ...(children.length ? { children } : {}) };
}

function liveParentIn(items: readonly TodoItem[], parentId: string | null): boolean {
  if (parentId === null) return true;
  const parent = items.find(item => item.id === parentId);
  return parent !== undefined && parent.deletedAt === undefined;
}

function nextMemoSection(previous: TodoMemoSection | undefined, text: string, now: number): TodoMemoSection {
  const history = previous ? [...previous.history, { version: previous.version, text: previous.text, at: previous.at }].slice(-TODO_MEMO_HISTORY_LIMIT) : [];
  return { version: (previous?.version ?? 0) + 1, text, at: now, history };
}

function memoField(field: string): WorkMemoSection | undefined {
  const section = field.startsWith("workMemo.") ? field.slice("workMemo.".length) : "";
  return (WORK_MEMO_SECTIONS as readonly string[]).includes(section) ? section as WorkMemoSection : undefined;
}

function knownGroup(groups: readonly TodoGroup[], name: string | null | undefined): string | undefined {
  return name !== null && name !== undefined && groups.some(group => group.name === name) ? name : undefined;
}

export function todoGroupOrderOf(rootGroups: Iterable<string | undefined>, stored: Iterable<string>): Array<string | null> {
  const groups = [...rootGroups];
  const named = [...new Set([...stored, ...groups.filter((group): group is string => group !== undefined)])];
  return groups.includes(undefined) ? [...named, null] : named;
}

export function todoItemPath<T extends Pick<TodoItem, "id" | "parentId">>(items: readonly T[], id: string): T[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const path: T[] = [];
  const seen = new Set<string>();
  for (let at = byId.get(id); at && !seen.has(at.id); at = at.parentId === null ? undefined : byId.get(at.parentId)) {
    seen.add(at.id);
    path.unshift(at);
  }
  return path;
}

export function todoItemNumbers(items: readonly Pick<TodoItem, "id" | "parentId" | "group">[], groupNames: Iterable<string>): Map<string, string> {
  const ids = new Set(items.map(item => item.id));
  const children = new Map<string | null, Array<Pick<TodoItem, "id" | "parentId" | "group">>>();
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId) ? item.parentId : null;
    let list = children.get(parent);
    if (!list) children.set(parent, list = []);
    list.push(item);
  }
  const roots = children.get(null) ?? [];
  const numbers = new Map<string, string>();
  const visit = (id: string, base: string) => (children.get(id) ?? []).forEach((kid, index) => {
    if (numbers.has(kid.id)) return;
    const number = `${base}.${index + 1}`;
    numbers.set(kid.id, number);
    visit(kid.id, number);
  });
  let count = 0;
  for (const key of todoGroupOrderOf(roots.map(root => root.group), groupNames)) {
    for (const root of roots.filter(entry => (entry.group ?? null) === key)) {
      count++;
      numbers.set(root.id, String(count).padStart(2, "0"));
      visit(root.id, String(count));
    }
  }
  return numbers;
}

export function todoPlaceOf(items: readonly Pick<TodoItem, "id" | "parentId" | "group" | "title">[], id: string | null, numberOf: (id: string) => string): TodoPlace {
  const path = id === null ? [] : todoItemPath(items, id);
  return { group: path[0]?.group ?? null, steps: path.map(step => ({ number: numberOf(step.id), title: step.title })) };
}

export function todoPlaceText(place: TodoPlace, noGroup: string): string {
  return [place.group ?? noGroup, ...place.steps.map(step => `${step.number} ${step.title}`.trim())].join(" › ");
}

export function todoParentPlace(items: readonly Pick<TodoItem, "id" | "parentId" | "group" | "title">[], item: Pick<TodoItem, "parentId" | "group">, numberOf: (id: string) => string): TodoPlace {
  return item.parentId === null ? { group: item.group ?? null, steps: [] } : todoPlaceOf(items, item.parentId, numberOf);
}

export function todoNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

const TODO_NEAR_KEY_MIN = 2;
const nearKeyLongEnough = (key: string) => [...key].length >= TODO_NEAR_KEY_MIN;

export function todoNearGroups(groups: readonly Pick<TodoGroup, "name">[], name: string, except?: string): string[] {
  const key = todoNameKey(name);
  if (!key) return [];
  return groups.filter(group => {
    if (group.name === name || group.name === except) return false;
    const other = todoNameKey(group.name);
    if (other === key || nameWords(group.name).includes(key) || nameWords(name).includes(other)) return true;
    const [short, long] = other.length <= key.length ? [other, key] : [key, other];
    return nearKeyLongEnough(short) && long.includes(short);
  }).map(group => group.name);
}

const nameWords = (name: string) => name.normalize("NFKC").toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean);

function claudeGroupProblem(groups: readonly TodoGroup[], name: string, newGroup: boolean | undefined): TodoOperationFailure | undefined {
  if (groups.some(group => group.name === name)) return undefined;
  const near = todoNearGroups(groups, name);
  if (near.length) return { ok: false, error: "near-group", detail: { near, word: name } };
  return newGroup ? undefined : { ok: false, error: "unknown-group", detail: { word: name } };
}

export const TODO_STATE_CHECKBOXES = ["[ ]", "[x]", "[X]"] as const;
export const TODO_STATE_WORDS = ["済", "済み", "完了", "WIP", "TODO", "DONE", "進行中", "未着手", "対応中"] as const;
export const TODO_STATE_BRACKETS = [["【", "】"], ["[", "]"], ["(", ")"], ["（", "）"]] as const;
export const TODO_STATE_TRAILING_WORDS = ["済", "済み", "完了"] as const;
export const TODO_STATE_SEPARATORS = [":", "：", "/", "・", "-"] as const;
const regexAlt = (words: readonly string[]) => `(?:${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
const regexClass = (chars: readonly string[]) => `[${chars.map(char => char.replace(/[\]\\^-]/g, "\\$&")).join("")}]`;
const TODO_STATE_BRACKETED = `${regexClass(TODO_STATE_BRACKETS.map(([open]) => open))}${regexAlt(TODO_STATE_WORDS)}${regexClass(TODO_STATE_BRACKETS.map(([, close]) => close))}`;
const TODO_TITLE_STATE = new RegExp(`^(?:${regexAlt(TODO_STATE_CHECKBOXES)}|${TODO_STATE_BRACKETED})|${TODO_STATE_BRACKETED}$|[\\s${regexClass(TODO_STATE_SEPARATORS).slice(1, -1)}]${regexAlt(TODO_STATE_TRAILING_WORDS)}$`, "u");
export const TODO_TITLE_PARTICLES = ["の", "を", "に", "で", "が", "は", "と", "へ", "や", "も", "から", "まで"] as const;

export interface TodoTitlePlace {
  readonly title: string;
  readonly parentId: string | null;
  readonly group?: string | null;
  readonly self?: string;
}

export function todoTitleProblem(items: readonly TodoItem[], place: TodoTitlePlace): TodoOperationFailure | undefined {
  if (TODO_TITLE_STATE.test(place.title.trim())) return { ok: false, error: "title-state" };
  return todoPlaceProblem(items, place);
}

function titlePlaceHeads(items: readonly TodoItem[], place: TodoTitlePlace): { readonly group: string | null; readonly heads: readonly string[] } {
  const ancestors = place.parentId === null ? [] : todoItemPath(items, place.parentId);
  const group = place.parentId === null ? place.group ?? null : ancestors[0]?.group ?? null;
  return { group, heads: [...(group !== null ? [group] : []), ...ancestors.map(entry => entry.title)] };
}

export function todoPlaceProblem(items: readonly TodoItem[], place: TodoTitlePlace): TodoOperationFailure | undefined {
  return duplicateProblem(items, { ...place, group: titlePlaceHeads(items, place).group });
}

export function todoTitleRepeat(items: readonly TodoItem[], place: TodoTitlePlace): string | undefined {
  const title = place.title.trim();
  return titlePlaceHeads(items, place).heads.find(head => todoTitleBeginsWith(title, head));
}

export function todoTitleBeginsWith(title: string, head: string): boolean {
  const headKey = todoNameKey(head);
  if (!nearKeyLongEnough(headKey) || !todoNameKey(title).startsWith(headKey)) return false;
  let end = 0;
  for (const char of title) {
    end += char.length;
    if (todoNameKey(title.slice(0, end)) !== headKey) continue;
    const rest = title.slice(end);
    if (rest === "" || /^[\s\p{P}\p{S}]/u.test(rest) || TODO_TITLE_PARTICLES.some(particle => rest.startsWith(particle))) return true;
  }
  return false;
}

export const todoTitlePlaceOf = (item: Pick<TodoItem, "id" | "title" | "parentId" | "group">): TodoTitlePlace => ({ title: item.title, parentId: item.parentId, group: item.group ?? null, self: item.id });

function duplicateProblem(items: readonly TodoItem[], place: TodoTitlePlace): TodoOperationFailure | undefined {
  const key = todoNameKey(place.title);
  const twin = sameTitled(items, place, key).find(entry => entry.state !== "done");
  return twin ? { ok: false, error: "duplicate-title", detail: { itemId: twin.id } } : undefined;
}

function sameTitled(items: readonly TodoItem[], place: TodoTitlePlace, key: string): TodoItem[] {
  return liveChildren(items, place.parentId).filter(entry => entry.id !== place.self && todoNameKey(entry.title) === key
    && (place.parentId !== null || (entry.group ?? null) === (place.group ?? null)));
}

export function todoDoneTwin(items: readonly TodoItem[], id: string): TodoItem | undefined {
  const item = items.find(entry => entry.id === id);
  return item ? sameTitled(items, todoTitlePlaceOf(item), todoNameKey(item.title)).find(entry => entry.state === "done") : undefined;
}

export const TODO_CROWDED_SIBLINGS = 8;

export interface TodoTidySignals {
  readonly sameTitle: string[][];
  readonly singleChild: string[];
  readonly crowded: string[];
  readonly repeatsPlace: string[];
}

export function todoTidySignals(items: readonly TodoItem[], roots: readonly TodoItem[], owner: string): TodoTidySignals {
  const signals: TodoTidySignals = { sameTitle: [], singleChild: [], crowded: [], repeatsPlace: [] };
  const look = (siblings: readonly TodoItem[], owner: string) => {
    const byKey = new Map<string, string[]>();
    for (const entry of siblings) byKey.set(todoNameKey(entry.title), [...byKey.get(todoNameKey(entry.title)) ?? [], entry.id]);
    for (const ids of byKey.values()) if (ids.length > 1) signals.sameTitle.push(ids);
    if (siblings.length >= TODO_CROWDED_SIBLINGS) signals.crowded.push(owner);
    for (const entry of siblings) {
      const kids = liveChildren(items, entry.id);
      if (todoTitleRepeat(items, todoTitlePlaceOf(entry)) !== undefined) signals.repeatsPlace.push(entry.id);
      if (kids.length === 1) signals.singleChild.push(entry.id);
      if (kids.length) look(kids, entry.id);
    }
  };
  look(roots, owner);
  return signals;
}

export function todoConversationFolder(groups: readonly TodoGroup[], files: readonly string[]): { readonly folder?: string; readonly group?: string } {
  const bound = new Map(files.flatMap(file => {
    const found = todoFolderGroup(groups, file);
    return found ? [[todoFolderKey(found.path), found.group] as const] : [];
  }));
  if (bound.size > 1) return {};
  const folder = todoFilesFolder(files);
  const group = [...bound.values()][0];
  return { ...(folder ? { folder } : {}), ...(group ? { group } : {}) };
}

function claudeMayChange(items: readonly TodoItem[], item: TodoItem, session: string | null | undefined): boolean {
  if (session === undefined || item.by === "claude") return true;
  const linked = linkedTodoItem(items, session ?? undefined);
  return linked !== undefined && todoScopeIds(items, linked.id).has(item.id);
}

const userItem = (item: TodoItem): TodoOperationFailure => ({ ok: false, error: "user-item", detail: { title: item.title } });

export type TodoUnstableReason = "doing" | "touched" | "pinned" | "moved";

export function todoUnstable(items: readonly TodoItem[], history: readonly TodoChange[], item: TodoItem, now: number, moving: boolean, requested = false): TodoUnstableReason | undefined {
  if ([...todoScopeIds(items, item.id)].some(id => items.find(entry => entry.id === id && entry.deletedAt === undefined)?.state === "doing")) return "doing";
  if (history.some(change => change.itemId === item.id && change.author === "human" && !change.cascade && change.field !== "item" && now - change.at < TODO_STABLE_TOUCH_MS)) return "touched";
  if (moving && item.pinnedAt !== undefined && now - item.pinnedAt < TODO_STABLE_PIN_MS) return "pinned";
  if (moving && !requested && history.some(change => change.itemId === item.id && isClaudeOwnChange(change) && (change.field === "position" || change.field === "group") && now - change.at < TODO_STABLE_REMOVE_MS)) return "moved";
  return undefined;
}

function unstableFailure(items: readonly TodoItem[], meta: StepMeta, item: TodoItem, now: number, moving: boolean, requested = false): TodoOperationFailure | undefined {
  const reason = todoUnstable(items, meta.history ?? [], item, now, moving, requested);
  return reason ? { ok: false, error: "unstable", detail: { title: item.title, word: reason } } : undefined;
}

function placeNow(items: readonly TodoItem[], groups: readonly TodoGroup[], id: string | null): TodoPlace {
  const live = items.filter(entry => entry.deletedAt === undefined);
  const numbers = todoItemNumbers(live, groups.map(group => group.name));
  return todoPlaceOf(live, id, entry => numbers.get(entry) ?? "");
}

function depthOf(items: readonly TodoItem[], id: string | null): number {
  return id === null ? 0 : todoItemPath(items, id).length;
}

function subtreeHeight(items: readonly TodoItem[], id: string): number {
  return 1 + liveChildren(items, id).reduce((height, child) => Math.max(height, subtreeHeight(items, child.id)), 0);
}

const tooDeep: TodoOperationFailure = { ok: false, error: "too-deep" };

export function todoFolderKey(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:(\/|$)/i.test(slashed) || slashed.startsWith("//") ? slashed.toLowerCase() : slashed;
}

export function todoFolderWithin(folder: string, root: string): boolean {
  const inner = todoFolderKey(folder), outer = todoFolderKey(root);
  return inner === outer || inner.startsWith(`${outer}/`);
}

export function todoFolderGroup(groups: readonly TodoGroup[], folder: string): { readonly group: string; readonly path: string } | undefined {
  let found: { group: string; path: string } | undefined;
  for (const group of groups) for (const bound of group.folders ?? []) {
    if (todoFolderWithin(folder, bound.path) && (!found || todoFolderKey(bound.path).length > todoFolderKey(found.path).length)) found = { group: group.name, path: bound.path };
  }
  return found;
}

export function todoFilesFolder(files: readonly string[]): string | undefined {
  const dirs = files.map(file => file.split(/[\\/]/).slice(0, -1));
  if (dirs.length === 0) return undefined;
  let common = dirs[0];
  for (const dir of dirs.slice(1)) {
    let same = 0;
    while (same < common.length && same < dir.length && todoFolderKey(common[same]) === todoFolderKey(dir[same])) same++;
    common = common.slice(0, same);
  }
  const separator = files[0].includes("\\") ? "\\" : "/";
  return common.filter(Boolean).length >= 2 ? common.join(separator) : undefined;
}

function withFolder(groups: readonly TodoGroup[], name: string | null, folder: TodoGroupFolder): TodoGroup[] {
  const key = todoFolderKey(folder.path);
  return groups.map(group => {
    const rest = (group.folders ?? []).filter(entry => todoFolderKey(entry.path) !== key);
    const folders = group.name === name ? [...rest, folder] : rest;
    return folders.length === (group.folders ?? []).length && group.name !== name ? group : withFolders(group, folders);
  });
}

function withAliases(group: TodoGroup, aliases: readonly TodoGroupAlias[]): TodoGroup {
  const { aliases: _old, ...rest } = group;
  return aliases.length ? { ...rest, aliases } : rest;
}

function withAlias(groups: readonly TodoGroup[], name: string, alias: TodoGroupAlias): TodoGroup[] {
  const key = todoNameKey(alias.words);
  return groups.map(group => {
    const rest = (group.aliases ?? []).filter(entry => todoNameKey(entry.words) !== key);
    return group.name === name ? withAliases(group, [...rest, alias]) : rest.length === (group.aliases ?? []).length ? group : withAliases(group, rest);
  });
}

type TodoBindings = { readonly group: string; readonly folders: readonly TodoGroupFolder[]; readonly aliases: readonly TodoGroupAlias[] };

const bindingsOf = (group: TodoGroup): TodoBindings => ({ group: group.name, folders: group.folders ?? [], aliases: group.aliases ?? [] });

function sameBindings(a: Pick<TodoBindings, "folders" | "aliases">, b: Pick<TodoBindings, "folders" | "aliases">): boolean {
  return a.folders.length === b.folders.length && a.folders.every((folder, index) => folder.path === b.folders[index].path)
    && a.aliases.length === b.aliases.length && a.aliases.every((alias, index) => alias.words === b.aliases[index].words && alias.parentId === b.aliases[index].parentId);
}

function isGroupAliases(value: unknown): value is TodoGroupAlias[] {
  return Array.isArray(value) && value.every(entry => isRecord(entry) && typeof entry.words === "string" && entry.words.length > 0 && entry.words.length <= TODO_GROUP_MAX
    && (entry.parentId === undefined || typeof entry.parentId === "string") && (entry.change === undefined || typeof entry.change === "string"));
}

function withFolders(group: TodoGroup, folders: readonly TodoGroupFolder[]): TodoGroup {
  const { folders: _old, ...rest } = group;
  return folders.length ? { ...rest, folders } : rest;
}

const TODO_LEARNING_KINDS: ReadonlySet<TodoOperation["kind"]> = new Set(["move", "update", "batch"]);

function learnBindings(groups: readonly TodoGroup[], before: readonly TodoItem[], after: readonly TodoItem[], changes: readonly Omit<TodoChange, "id">[],
  unbound: readonly string[], log: ChangeLog): { groups: TodoGroup[]; unbound: string[] } {
  let next = [...groups];
  let blocked = [...unbound];
  const moved = [...new Set(changes.filter(change => !change.cascade && change.itemId !== "" && (change.field === "position" || change.field === "group")).map(change => change.itemId))];
  for (const id of moved) {
    const item = after.find(entry => entry.id === id);
    if (!item || item.by !== "claude" || item.deletedAt !== undefined) continue;
    const group = rootOf(after, id)?.group;
    if (group === undefined) continue;
    const former = rootOf(before, id)?.group;
    const parentChanged = before.find(entry => entry.id === id)?.parentId !== item.parentId;
    const was = next, wasBlocked = blocked;
    if (item.caseWords !== undefined && (parentChanged || group !== former)) {
      next = withAlias(next, group, { words: item.caseWords, ...(item.parentId !== null ? { parentId: item.parentId } : {}), ...(item.placement ? { basis: item.placement.basis } : {}) });
    }
    const path = item.placedFrom;
    const key = path === undefined ? "" : todoFolderKey(path);
    const holdsOther = (folder: string) => next.some(entry => entry.name !== group && (entry.folders ?? []).some(bound => todoFolderKey(bound.path) !== key && todoFolderWithin(bound.path, folder)));
    if (path !== undefined && group !== former && !holdsOther(path) && !blocked.some(entry => todoFolderKey(entry) === key)) {
      const bound = next.find(entry => (entry.folders ?? []).some(folder => todoFolderKey(folder.path) === key));
      if (bound && bound.name !== group) {
        next = withFolder(next, null, { path });
        blocked = [...blocked, path];
      } else if (!bound) {
        next = withFolder(next, group, { path });
      }
    }
    next.forEach((entry, index) => { if (entry !== was[index]) log(id, "groupBindings", bindingsOf(was[index]), bindingsOf(entry), { cascade: true }); });
    if (blocked !== wasBlocked) log(id, "unboundFolders", wasBlocked, blocked, { cascade: true });
  }
  return { groups: next, unbound: blocked };
}

function forgetLearned(groups: readonly TodoGroup[], unbound: readonly string[], learned: readonly TodoChange[], log: ChangeLog): { groups: TodoGroup[]; unbound: string[] } {
  let next = [...groups];
  let blocked = [...unbound];
  const folderKey = (folder: TodoGroupFolder) => todoFolderKey(folder.path);
  const aliasKey = (alias: TodoGroupAlias) => todoNameKey(alias.words);
  for (const change of [...learned].reverse()) {
    const before = isRecord(change.before) ? change.before : undefined, after = isRecord(change.after) ? change.after : undefined;
    if (change.field === "unboundFolders" && Array.isArray(change.before) && Array.isArray(change.after)) {
      const was = blocked;
      const added = (change.after as unknown[]).filter((path): path is string => typeof path === "string" && !(change.before as unknown[]).includes(path));
      const removed = (change.before as unknown[]).filter((path): path is string => typeof path === "string" && !(change.after as unknown[]).includes(path));
      blocked = [...blocked.filter(path => !added.some(entry => todoFolderKey(entry) === todoFolderKey(path))), ...removed.filter(path => !blocked.some(entry => todoFolderKey(entry) === todoFolderKey(path)))];
      if (blocked.length !== was.length || blocked.some((path, index) => path !== was[index])) log(change.itemId, "unboundFolders", was, blocked, { cascade: true });
      continue;
    }
    if (change.field !== "groupBindings" || typeof before?.group !== "string" || !isGroupFolders(before.folders) || !isGroupAliases(before.aliases) || !isGroupFolders(after?.folders) || !isGroupAliases(after?.aliases)) continue;
    const index = next.findIndex(entry => entry.name === before.group);
    if (index < 0) continue;
    const group = next[index];
    const diff = <T>(keyOf: (entry: T) => string, current: readonly T[], was: readonly T[], now: readonly T[]) => [
      ...current.filter(entry => !now.some(other => keyOf(other) === keyOf(entry)) || was.some(other => keyOf(other) === keyOf(entry))),
      ...was.filter(entry => !now.some(other => keyOf(other) === keyOf(entry)) && !current.some(other => keyOf(other) === keyOf(entry))),
    ];
    const restored = withAliases(withFolders(group, diff(folderKey, group.folders ?? [], before.folders, after.folders)), diff(aliasKey, group.aliases ?? [], before.aliases, after.aliases));
    if (sameBindings(bindingsOf(group), bindingsOf(restored))) continue;
    log(change.itemId, "groupBindings", bindingsOf(group), bindingsOf(restored), { cascade: true });
    next = next.map((entry, at) => at === index ? restored : entry);
  }
  return { groups: next, unbound: blocked };
}

function step(items: TodoItem[], operation: TodoStepOperation, author: TodoAuthor, now: number, newId: TodoOperationContext["newId"], log: ChangeLog, meta: StepMeta): StepResult {
  const find = (id: string) => items.find(item => item.id === id);
  const unchanged = (itemId: string): StepResult => ({ ok: true, items, itemId, reevaluate: [] });
  const setGroups = (groups: readonly TodoGroup[], next: TodoItem[] = items): StepResult => ({ ok: true, items: next, itemId: "", reevaluate: [], meta: { ...meta, groups } });
  const writeMemo = (item: TodoItem, section: WorkMemoSection, text: string): StepResult => {
    const previous = item.workMemo[section];
    const written = nextMemoSection(previous, text, now);
    const field = `workMemo.${section}`;
    log(item.id, field, previous ? { version: previous.version } : null, { version: written.version });
    return { ok: true, itemId: item.id, reevaluate: [],
      memoKept: [{ itemId: item.id, field, versions: new Set([...written.history.map(entry => entry.version), written.version]) }],
      items: items.map(entry => entry.id === item.id ? { ...entry, workMemo: { ...entry.workMemo, [section]: written }, updatedAt: now } : entry) };
  };

  switch (operation.kind) {
    case "batch": {
      if (author !== "human") return { ok: false, error: "author-not-allowed" };
      let current = items;
      let first: string | undefined;
      const reevaluate: Array<string | null> = [];
      for (const entry of operation.steps) {
        const result = step(current, entry, author, now, newId, log, meta);
        if (!result.ok) return result;
        current = result.items;
        first ??= result.itemId;
        reevaluate.push(...result.reevaluate);
      }
      return { ok: true, items: current, itemId: first ?? "", reevaluate };
    }
    case "addMany": {
      if (todoAddNodeCount(operation.items) > TODO_ADD_MANY_MAX) return { ok: false, error: "too-many" };
      if (author === "claude" && depthOf(items, operation.parentId) + todoAddNodeDepth(operation.items) > TODO_CLAUDE_DEPTH_MAX) return tooDeep;
      let current = items;
      let currentMeta = meta;
      let first: string | undefined;
      const reevaluate: Array<string | null> = [];
      const plant = (parentId: string | null, nodes: readonly TodoAddNode[]): TodoOperationFailure | undefined => {
        for (const { children, ...fields } of nodes) {
          const result = step(current, { ...fields, kind: "add", parentId }, author, now, newId, log, currentMeta);
          if (!result.ok) return result;
          current = result.items;
          currentMeta = result.meta ?? currentMeta;
          first ??= result.itemId;
          reevaluate.push(...result.reevaluate);
          const failed = plant(result.itemId, children ?? []);
          if (failed) return failed;
        }
        return undefined;
      };
      const failed = plant(operation.parentId, operation.items);
      if (failed) return failed;
      return first === undefined ? { ok: false, error: "empty-title" } : { ok: true, items: current, itemId: first, reevaluate, meta: currentMeta };
    }
    case "add": {
      const title = operation.title.trim();
      if (!title) return { ok: false, error: "empty-title" };
      if (title.length > TODO_TITLE_MAX) return { ok: false, error: "title-too-long" };
      if (!liveParentIn(items, operation.parentId)) return { ok: false, error: "invalid-parent" };
      if (operation.userMemo && author !== "human") return { ok: false, error: "author-not-allowed" };
      if (operation.templateId !== undefined && author !== "human") return { ok: false, error: "author-not-allowed" };
      if ((operation.dueReason !== undefined || operation.priorityReason !== undefined || operation.sourceSession !== undefined || operation.placedFrom !== undefined || operation.caseWords !== undefined || operation.basis !== undefined || operation.imported !== undefined) && author !== "claude") return { ok: false, error: "author-not-allowed" };
      const template = operation.templateId === undefined ? undefined : meta.templates.find(entry => entry.id === operation.templateId);
      if (operation.templateId !== undefined && !template) return { ok: false, error: "not-found" };
      const group = operation.group?.trim();
      const rootGroup = group && operation.parentId === null ? group : undefined;
      let nextMeta = meta;
      if (author === "claude") {
        if (depthOf(items, operation.parentId) + 1 > TODO_CLAUDE_DEPTH_MAX) return { ...tooDeep, detail: { title } };
        const problem = (rootGroup !== undefined ? claudeGroupProblem(meta.groups, rootGroup, operation.newGroup) : undefined)
          ?? todoTitleProblem(items, { title, parentId: operation.parentId, group: rootGroup ?? null });
        if (problem) return { ...problem, detail: { ...problem.detail, title } };
        if (rootGroup !== undefined && !meta.groups.some(entry => entry.name === rootGroup)) nextMeta = { ...meta, groups: withNewGroup(meta.groups, rootGroup, log) };
      }
      const taken = new Set(items.map(item => item.id));
      const itemId = newId(taken);
      taken.add(itemId);
      const state = operation.state ?? "todo";
      const addBasis: TodoPlacementBasis = operation.basis ?? (operation.parentId !== null || group ? "named" : "inbox");
      const base: TodoItem = { id: itemId, parentId: operation.parentId, title, state, ...(state === "done" ? { completion: "manual" as const } : {}),
        userMemo: operation.userMemo ?? "", workMemo: {}, createdAt: now, updatedAt: now,
        ...(state !== "todo" ? { startedAt: now } : {}), ...(state === "done" ? { doneAt: now } : {}),
        ...(author === "claude" ? { by: "claude" as const } : {}), ...(operation.sourceSession ? { source: { sessionId: operation.sourceSession } } : {}),
        captured: { text: title, at: now, via: author === "human" ? "user" as const : operation.imported ? "import" as const : "claude" as const },
        ...(author === "claude" ? { placement: { basis: addBasis, at: now } } : {}),
        ...(operation.placedFrom ? { placedFrom: operation.placedFrom } : {}), ...(operation.caseWords?.trim() ? { caseWords: operation.caseWords.trim().slice(0, TODO_GROUP_MAX) } : {}),
        ...(group && operation.parentId === null ? { group } : {}), ...(operation.due ? { due: operation.due } : {}),
        ...(operation.start ? { start: operation.start } : {}), ...(operation.priority ? { priority: operation.priority } : {}),
        ...(operation.waiting?.trim() ? { waiting: operation.waiting.trim() } : {}), ...(operation.repeat ? { repeat: operation.repeat } : {}),
        ...(operation.estimate ? { estimate: operation.estimate } : {}), ...(operation.tags?.trim() ? { tags: operation.tags.trim() } : {}) };
      const item = withGuesses(base, guessesWith({ guesses: guessesWith(base, "due", operation.due, operation.dueReason) }, "priority", operation.priority, operation.priorityReason));
      let next = placeAmongSiblings(items, item, operation.position);
      log(itemId, "item", null, { parentId: item.parentId, title, position: siblingPosition(next, item), ...(item.parentId === null ? { placeGroup: item.group ?? null } : {}) }, author === "claude" ? { basis: addBasis } : undefined);
      const budget = { left: TODO_TEMPLATE_NODES_MAX - 1 };
      const plant = (parentId: string, nodes: readonly TodoTemplateNode[]) => {
        for (const node of nodes) {
          if (budget.left <= 0) return;
          budget.left--;
          const childId = newId(taken);
          taken.add(childId);
          const childTitle = node.title.trim().slice(0, TODO_TITLE_MAX);
          const child: TodoItem = { id: childId, parentId, title: childTitle, state: "todo", userMemo: "", workMemo: {}, createdAt: now, updatedAt: now, captured: { text: childTitle, at: now, via: "user" } };
          next = placeAmongSiblings(next, child, undefined);
          log(childId, "item", null, { parentId, title: childTitle, position: siblingPosition(next, child) });
          plant(childId, node.children ?? []);
        }
      };
      if (template) plant(itemId, template.root.children ?? []);
      return { ok: true, items: next, itemId, reevaluate: [operation.parentId], ...(nextMeta !== meta ? { meta: nextMeta } : {}) };
    }
    case "templateSave": {
      if (author !== "human") return { ok: false, error: "author-not-allowed" };
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      const name = operation.name.trim();
      if (!name || name.length > TODO_TEMPLATE_NAME_MAX) return { ok: false, error: "invalid-name" };
      const template: TodoTemplate = { id: newId(new Set(meta.templates.map(entry => entry.id))), name, at: now, root: templateTree(items, item.id, { left: TODO_TEMPLATE_NODES_MAX }) };
      log("", "templates", null, template);
      return { ok: true, items, itemId: item.id, reevaluate: [], meta: { ...meta, templates: [...meta.templates, template].slice(-TODO_TEMPLATES_MAX) } };
    }
    case "setTemplate": {
      const current = operation.current === null ? undefined : meta.templates.find(entry => entry.id === operation.current);
      if (operation.current !== null && !current) return { ok: false, error: "gone" };
      if (operation.to && meta.templates.some(entry => entry.id === operation.to!.id && entry !== current)) return { ok: false, error: "superseded" };
      const rest = meta.templates.filter(entry => entry !== current);
      log("", "templates", current ?? null, operation.to);
      return { ok: true, items, itemId: "", reevaluate: [], meta: { ...meta, templates: operation.to ? [...rest, operation.to] : rest } };
    }
    case "groupCreate": {
      const name = groupName(operation.name);
      if (!validGroupName(name)) return { ok: false, error: "invalid-name" };
      if (meta.groups.some(group => group.name === name)) return { ok: false, error: "group-exists" };
      const near = author === "claude" ? todoNearGroups(meta.groups, name) : [];
      if (near.length) return { ok: false, error: "near-group", detail: { near, word: name } };
      return setGroups(withNewGroup(meta.groups, name, log));
    }
    case "groupFolderAdd": {
      if (author !== "human") return { ok: false, error: "author-not-allowed" };
      const path = operation.path.trim();
      if (!path || path.length > TODO_DOC_TARGET_MAX) return { ok: false, error: "invalid-name" };
      if (!meta.groups.some(entry => entry.name === operation.name)) return { ok: false, error: "not-found" };
      const groups = withFolder(meta.groups, operation.name, { path });
      groups.forEach((entry, index) => { if (entry !== meta.groups[index]) log("", "groupBindings", bindingsOf(meta.groups[index]), bindingsOf(entry)); });
      return groups.every((entry, index) => entry === meta.groups[index]) ? unchanged("") : setGroups(groups);
    }
    case "groupFolderRemove":
    case "groupAliasRemove":
    case "setGroupBindings": {
      if (operation.kind !== "setGroupBindings" && author !== "human") return { ok: false, error: "author-not-allowed" };
      const group = meta.groups.find(entry => entry.name === (operation.kind === "setGroupBindings" ? operation.group : operation.name));
      if (!group) return { ok: false, error: "not-found" };
      const next = operation.kind === "setGroupBindings" ? withAliases(withFolders(group, operation.folders), operation.aliases)
        : operation.kind === "groupFolderRemove" ? withFolders(group, (group.folders ?? []).filter(folder => todoFolderKey(folder.path) !== todoFolderKey(operation.path)))
        : withAliases(group, (group.aliases ?? []).filter(alias => todoNameKey(alias.words) !== todoNameKey(operation.words)));
      if (sameBindings(bindingsOf(group), bindingsOf(next))) return unchanged("");
      log("", "groupBindings", bindingsOf(group), bindingsOf(next));
      return setGroups(meta.groups.map(entry => entry === group ? next : entry));
    }
    case "groupRename":
    case "groupColor":
    case "groupMove":
    case "groupDelete": {
      const before = groupRecord(meta.groups, operation.name);
      if (!before) return { ok: false, error: "not-found" };
      if (operation.kind === "groupColor" && author !== "human") return { ok: false, error: "author-not-allowed" };
      if (operation.kind === "groupDelete") {
        const mine = author === "claude" ? items.find(entry => entry.deletedAt === undefined && entry.by !== "claude" && rootOf(items, entry.id)?.group === operation.name) : undefined;
        if (mine) return { ok: false, error: "group-has-user-items", detail: { title: mine.title, word: operation.name } };
        const next = items.map(entry => {
          if (entry.group !== operation.name) return entry;
          log(entry.id, "group", operation.name, null);
          const { group: _group, ...rest } = entry;
          return { ...rest, updatedAt: now };
        });
        log("", "groups", before, null);
        return setGroups(meta.groups.filter(group => group.name !== operation.name), next);
      }
      if (operation.kind === "groupColor") {
        if (!validColor(operation.color)) return { ok: false, error: "invalid-name" };
        if (operation.color === before.color) return unchanged("");
        const groups = meta.groups.map(group => group.name === operation.name ? { ...group, color: operation.color } : group);
        log("", "groups", before, groupRecord(groups, operation.name));
        return setGroups(groups);
      }
      if (operation.kind === "groupMove") {
        const target = "position" in operation ? Math.min(Math.max(0, Math.floor(operation.position)), meta.groups.length - 1) : before.index + operation.direction;
        if (target < 0 || target >= meta.groups.length || target === before.index) return unchanged("");
        const groups = meta.groups.filter(group => group.name !== operation.name);
        groups.splice(target, 0, meta.groups[before.index]);
        log("", "groups", before, groupRecord(groups, operation.name));
        return setGroups(groups);
      }
      const to = groupName(operation.to);
      if (!validGroupName(to)) return { ok: false, error: "invalid-name" };
      if (to === operation.name) return unchanged("");
      if (meta.groups.some(group => group.name === to)) return { ok: false, error: "group-exists" };
      const near = author === "claude" ? todoNearGroups(meta.groups, to, operation.name) : [];
      if (near.length) return { ok: false, error: "near-group", detail: { near, word: to } };
      const groups = meta.groups.map(group => group.name === operation.name ? { ...group, name: to } : group);
      log("", "groups", before, groupRecord(groups, to));
      return setGroups(groups, renameGroupOnItems(items, operation.name, to, now, log));
    }
    case "setGroupEntry": {
      const current = operation.current === null ? null : groupRecord(meta.groups, operation.current);
      if (operation.current !== null && !current) return { ok: false, error: "gone" };
      if (operation.to && meta.groups.some(group => group.name === operation.to!.name && group.name !== operation.current)) return { ok: false, error: "superseded" };
      const groups = meta.groups.filter(group => group.name !== operation.current);
      const kept = operation.current !== null ? meta.groups.find(group => group.name === operation.current) : operation.to ?? undefined;
      const folders = kept?.folders, aliases = kept?.aliases;
      if (operation.to) groups.splice(Math.min(operation.to.index, groups.length), 0, { name: operation.to.name, color: operation.to.color, ...(folders?.length ? { folders } : {}), ...(aliases?.length ? { aliases } : {}) });
      log("", "groups", current, operation.to ? groupRecord(groups, operation.to.name) : null);
      const renamed = operation.current !== null && operation.to !== null && operation.to.name !== operation.current;
      return setGroups(groups, renamed ? renameGroupOnItems(items, operation.current!, operation.to!.name, now, null) : items);
    }
    case "restoreItemGroup": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      const target = knownGroup(meta.groups, operation.group) ?? null;
      if (item.parentId !== null || (item.group ?? null) === target) return unchanged(item.id);
      log(item.id, "group", item.group ?? null, target);
      const { group: _group, ...rest } = item;
      return { ok: true, itemId: item.id, reevaluate: [], items: items.map(entry => entry.id === item.id ? { ...rest, ...(target !== null ? { group: target } : {}), updatedAt: now } : entry) };
    }
    case "docLabel": {
      if (author !== "human") return { ok: false, error: "author-not-allowed" };
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      const doc = item.docs?.find(entry => entry.id === operation.docId);
      if (!doc) return { ok: false, error: "not-found" };
      const label = operation.label.trim().slice(0, TODO_DOC_LABEL_MAX);
      if ((doc.label ?? "") === label) return unchanged(item.id);
      log(item.id, "docLabel", { docId: doc.id, label: doc.label ?? null }, { docId: doc.id, label: label || null });
      const { label: _label, ...bare } = doc;
      const updated: TodoDoc = label ? { ...bare, label } : bare;
      return { ok: true, itemId: item.id, reevaluate: [],
        items: items.map(entry => entry.id === item.id ? { ...entry, docs: entry.docs!.map(other => other.id === doc.id ? updated : other), updatedAt: now } : entry) };
    }
    case "recordStart": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      const start: TodoStart = { at: now, kind: operation.start, brief: operation.brief.slice(0, TODO_BRIEF_MAX), tab: operation.tab,
        ...(item.workMemo.current?.text ? { current: item.workMemo.current.text } : {}), ...(item.workMemo.next?.text ? { next: item.workMemo.next.text } : {}),
        ...(memoStaleSince(item) !== undefined ? { stale: true as const } : {}) };
      const starts = trimStarts([...(item.starts ?? []), start]);
      return { ok: true, itemId: item.id, reevaluate: [], unlogged: true, items: items.map(entry => entry.id === item.id ? { ...entry, starts } : entry) };
    }
    case "update": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      if (operation.userMemo !== undefined && author !== "human") return { ok: false, error: "author-not-allowed" };
      if ((operation.dueReason !== undefined || operation.priorityReason !== undefined) && author !== "claude") return { ok: false, error: "author-not-allowed" };
      if (author === "claude" && !claudeMayChange(items, item, operation.session)) return userItem(item);
      const title = operation.title?.trim();
      if (operation.title !== undefined && !title) return { ok: false, error: "empty-title" };
      if (title !== undefined && title.length > TODO_TITLE_MAX) return { ok: false, error: "title-too-long" };
      let nextMeta = meta;
      if (author === "claude") {
        const regroup = item.parentId === null && typeof operation.group === "string" && operation.group.trim() !== "" && operation.group.trim() !== item.group ? operation.group.trim() : undefined;
        const problem = (regroup !== undefined ? claudeGroupProblem(meta.groups, regroup, operation.newGroup) : undefined)
          ?? (title !== undefined && title !== item.title ? todoTitleProblem(items, { title, parentId: item.parentId, group: regroup ?? item.group ?? null, self: item.id })
            : regroup !== undefined ? todoPlaceProblem(items, { title: item.title, parentId: null, group: regroup, self: item.id }) : undefined);
        if (problem) return { ...problem, detail: { ...problem.detail, title: problem.detail?.title ?? item.title } };
        const unstable = regroup !== undefined || (title !== undefined && title !== item.title) ? unstableFailure(items, meta, item, now, regroup !== undefined, operation.basis === "requested") : undefined;
        if (unstable) return unstable;
        if (regroup !== undefined && !meta.groups.some(entry => entry.name === regroup)) nextMeta = { ...meta, groups: withNewGroup(meta.groups, regroup, log) };
      }
      let updated: TodoItem = item;
      let touched = false;
      const set = (field: TodoTextField, value: string | null | undefined) => {
        if (value === undefined || (updated[field] || null) === (value || null)) return;
        const guess = author === "human" && (field === "due" || field === "priority") ? updated.guesses?.[field] : undefined;
        log(item.id, field, updated[field] || null, value || null, { ...(guess ? { guess } : {}), ...(field === "group" && author === "claude" ? { basis: operation.basis ?? "named" } : {}) });
        touched = true;
        const { [field]: _old, ...rest } = updated;
        updated = { ...rest, ...(value ? { [field]: value } : field === "userMemo" ? { userMemo: "" } : {}) } as TodoItem;
      };
      set("title", title);
      if (item.parentId === null) set("group", typeof operation.group === "string" ? operation.group.trim() || null : operation.group);
      set("due", operation.due);
      set("start", operation.start);
      set("priority", operation.priority);
      set("userMemo", operation.userMemo);
      set("waiting", typeof operation.waiting === "string" ? operation.waiting.trim() || null : operation.waiting);
      set("repeat", operation.repeat);
      set("estimate", operation.estimate);
      set("tags", typeof operation.tags === "string" ? operation.tags.trim() || null : operation.tags);
      let guesses = guessesWith({ guesses: guessesWith(updated, "due", operation.due, operation.dueReason) }, "priority", operation.priority, operation.priorityReason);
      if ("restoreGuess" in operation && updated[operation.restoreGuess.field] === operation.restoreGuess.guess.value) guesses = { ...guesses, [operation.restoreGuess.field]: operation.restoreGuess.guess };
      if (touched) updated = withGuesses(updated, guesses);
      const completion = operation.state === "done" ? "manual" as const : undefined;
      const restated = operation.state !== undefined && (operation.state !== updated.state || completion !== updated.completion);
      if (restated) {
        log(item.id, "state", stateRecord(updated), { state: operation.state, completion });
        updated = withState(updated, { state: operation.state!, completion }, now);
        touched = true;
      }
      if (!touched) return unchanged(item.id);
      if ((updated.group ?? null) !== (item.group ?? null)) updated = author === "human" ? { ...updated, pinnedAt: now } : { ...updated, placement: { basis: operation.basis ?? "named", at: now, from: placeNow(items, meta.groups, item.id) } };
      return { ok: true, itemId: item.id, reevaluate: restated ? [item.parentId] : [], items: items.map(entry => entry.id === item.id ? { ...updated, updatedAt: now } : entry),
        ...(nextMeta !== meta ? { meta: nextMeta } : {}) };
    }
    case "move": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      if (!liveParentIn(items, operation.parentId)) return { ok: false, error: "invalid-parent" };
      if (isDescendant(items, operation.parentId, item.id)) return { ok: false, error: "cycle" };
      if (author === "claude" && !claudeMayChange(items, item, operation.session)) return userItem(item);
      if (author === "claude" && operation.parentId === item.parentId && operation.position === undefined && operation.before === undefined) return unchanged(item.id);
      if (author === "claude" && operation.parentId !== item.parentId) {
        if (depthOf(items, operation.parentId) + subtreeHeight(items, item.id) > TODO_CLAUDE_DEPTH_MAX) return { ...tooDeep, detail: { title: item.title } };
        const problem = todoPlaceProblem(items, { title: item.title, parentId: operation.parentId, group: operation.targetGroup ?? item.group ?? null, self: item.id });
        if (problem && !(operation.allowTwin && problem.error === "duplicate-title")) return { ...problem, detail: { ...problem.detail, title: item.title } };
      }
      const { group: heldGroup, ...ungrouped } = item;
      const moved: TodoItem = operation.parentId !== null ? { ...ungrouped, parentId: operation.parentId, updatedAt: now }
        : { ...item, ...(item.group === undefined && knownGroup(meta.groups, operation.restoreGroup) !== undefined ? { group: operation.restoreGroup } : {}), parentId: operation.parentId, updatedAt: now };
      let position = operation.position;
      if (operation.before !== undefined) {
        const siblings = liveChildren(items.filter(entry => entry.id !== item.id), operation.parentId);
        const anchor = operation.before === null ? siblings.length : siblings.findIndex(entry => entry.id === operation.before);
        if (anchor < 0) return { ok: false, error: "invalid-parent" };
        position = anchor;
      }
      const next = placeAmongSiblings(items, moved, position);
      const before = { parentId: item.parentId, position: siblingPosition(items, item), ...(heldGroup !== undefined && moved.group === undefined ? { group: heldGroup } : {}),
        ...(item.parentId === null ? { placeGroup: heldGroup ?? null } : {}) };
      const after = { parentId: moved.parentId, position: siblingPosition(next, moved), ...(moved.parentId === null ? { placeGroup: moved.group ?? null } : {}) };
      if (before.parentId === after.parentId && before.position === after.position) return unchanged(item.id);
      if (author === "claude") {
        const unstable = unstableFailure(items, meta, item, now, true, operation.basis === "requested");
        if (unstable) return unstable;
      }
      log(item.id, "position", before, after, author === "claude" ? { basis: operation.basis ?? "named" } : undefined);
      const marked: TodoItem = author === "human" ? { ...moved, pinnedAt: now } : { ...moved, placement: { basis: operation.basis ?? "named", at: now, from: placeNow(items, meta.groups, item.id) } };
      return { ok: true, items: next.map(entry => entry.id === item.id ? marked : entry), itemId: item.id, reevaluate: [item.parentId, operation.parentId] };
    }
    case "setState":
    case "setExactState": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      if (author === "claude" && operation.kind === "setState" && operation.state === "done" && operation.session !== undefined) {
        const linked = linkedTodoItem(items, operation.session ?? undefined);
        if (!linked || !todoScopeIds(items, linked.id).has(item.id)) return { ok: false, error: "outside-linked", detail: { title: item.title } };
      }
      const completion = operation.state !== "done" ? undefined : operation.kind === "setExactState" ? operation.completion ?? "manual" : "manual" as const;
      const after = { state: operation.state, completion };
      if (after.state === item.state && after.completion === item.completion) return unchanged(item.id);
      log(item.id, "state", stateRecord(item), after);
      const restoredStart = operation.kind === "setExactState" && operation.startedAt !== undefined ? { startedAt: operation.startedAt } : {};
      return { ok: true, itemId: item.id, reevaluate: [item.parentId], items: items.map(entry => entry.id === item.id ? withState(entry, { ...after, ...restoredStart }, now) : entry) };
    }
    case "writeWorkMemo": {
      if (author !== "claude") return { ok: false, error: "author-not-allowed" };
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      if (item.workMemo[operation.section]?.text === operation.text) return unchanged(item.id);
      return writeMemo(item, operation.section, operation.text);
    }
    case "writeWorkMemos": {
      let current = items;
      const kept: MemoKept[] = [];
      for (const section of WORK_MEMO_SECTIONS) {
        const text = operation.sections[section];
        if (text === undefined) continue;
        const result = step(current, { kind: "writeWorkMemo", id: operation.id, section, text }, author, now, newId, log, meta);
        if (!result.ok) return result;
        current = result.items;
        kept.push(...result.memoKept ?? []);
      }
      return { ok: true, items: current, itemId: operation.id, reevaluate: [], ...(kept.length ? { memoKept: kept } : {}) };
    }
    case "restoreWorkMemo": {
      if (author !== "human") return { ok: false, error: "author-not-allowed" };
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      const text = memoVersionText(item.workMemo[operation.section], operation.version);
      if (text === undefined) return { ok: false, error: "unrevertible" };
      if ((item.workMemo[operation.section]?.text ?? "") === text) return unchanged(item.id);
      return writeMemo(item, operation.section, text);
    }
    case "delete": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      if (author === "claude" && !claudeMayChange(items, item, operation.session)) return userItem(item);
      const ids = subtreeIds(items, item.id);
      const next = items.map(entry => {
        if (!ids.has(entry.id) || entry.deletedAt !== undefined) return entry;
        log(entry.id, "deletedAt", null, now, entry.id === item.id ? undefined : { cascade: true });
        return { ...entry, deletedAt: now };
      });
      return { ok: true, items: next, itemId: item.id, reevaluate: [item.parentId] };
    }
    case "restore": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt === undefined) return unchanged(item.id);
      const ids = subtreeIds(items, item.id);
      const parentId = liveParentIn(items, item.parentId) ? item.parentId : null;
      const formerRoot = item.parentId !== null && parentId === null ? rootOf(items, item.id)?.group : undefined;
      const next = items.map(entry => {
        if (!ids.has(entry.id) || entry.deletedAt !== item.deletedAt) return entry;
        log(entry.id, "deletedAt", entry.deletedAt, null, entry.id === item.id ? undefined : { cascade: true });
        const { deletedAt: _deleted, group: own, ...rest } = entry;
        const placed = entry.id === item.id ? { ...rest, parentId } : rest;
        const group = entry.id === item.id && formerRoot !== undefined ? formerRoot : own;
        const kept = knownGroup(meta.groups, group);
        return kept !== undefined && placed.parentId === null ? { ...placed, group: kept } : placed;
      });
      if (parentId !== item.parentId) log(item.id, "position", { parentId: item.parentId }, { parentId });
      return { ok: true, items: next, itemId: item.id, reevaluate: [parentId] };
    }
    case "linkConversation": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      const last = item.conversations?.at(-1);
      if (last?.sessionId === operation.sessionId && item.pendingStart === undefined && (!operation.owner || last.owner === operation.owner) && todoTabStart(item, operation.tab) === undefined) return unchanged(item.id);
      const kept = last?.sessionId === operation.sessionId ? last : { sessionId: operation.sessionId, at: now };
      const link: TodoConversationLink = { ...kept, ...(operation.owner ? { owner: operation.owner, seenAt: now } : {}) };
      return { ok: true, itemId: item.id, reevaluate: [], unlogged: true, items: items.map(entry => {
        if (entry.id === item.id) return withStartSession(withoutClaim(withLinks(entry, [...(entry.conversations ?? []).filter(other => other.sessionId !== operation.sessionId), link])), operation.sessionId, operation.tab);
        return entry.conversations?.some(other => other.sessionId === operation.sessionId)
          ? withLinks(entry, entry.conversations.filter(other => other.sessionId !== operation.sessionId)) : entry;
      }) };
    }
    case "relinkConversation": {
      const linked = items.filter(item => item.conversations?.some(link => link.sessionId === operation.from) && !item.conversations.some(link => link.sessionId === operation.to));
      if (linked.length === 0 || operation.from === operation.to) return unchanged("");
      const ids = new Set(linked.map(item => item.id));
      return { ok: true, itemId: linked[0].id, reevaluate: [], unlogged: true,
        items: items.map(entry => ids.has(entry.id) ? withLinks(entry, [...entry.conversations!, { sessionId: operation.to, at: now, via: "handoff" }]) : entry) };
    }
    case "claimStart":
    case "releaseStart": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      if (operation.kind === "releaseStart") {
        if (item.pendingStart?.token !== operation.token) return unchanged(item.id);
        return { ok: true, itemId: item.id, reevaluate: [], unlogged: true, items: items.map(entry => entry.id === item.id ? withoutClaim(entry) : entry) };
      }
      if (item.pendingStart && item.pendingStart.token !== operation.token && startClaimFresh(item.pendingStart, now)) return unchanged(item.id);
      const claim: TodoStartClaim = { owner: operation.owner, token: operation.token, at: now };
      return { ok: true, itemId: item.id, reevaluate: [], unlogged: true, items: items.map(entry => entry.id === item.id ? { ...entry, pendingStart: claim } : entry) };
    }
    case "touchConversation":
    case "releaseConversation": {
      const item = linkedTodoItem(items, operation.sessionId);
      const link = item?.conversations?.find(entry => entry.sessionId === operation.sessionId);
      if (!item || !link) return unchanged("");
      if (operation.kind === "releaseConversation" ? link.owner !== operation.owner
        : link.owner === operation.owner && link.seenAt !== undefined && now - link.seenAt < TODO_CONVERSATION_SEEN_REFRESH_MS / 2) return unchanged(item.id);
      const { owner: _owner, seenAt: _seen, ...bare } = link;
      const next: TodoConversationLink = operation.kind === "releaseConversation" ? bare : { ...bare, owner: operation.owner, seenAt: now };
      return { ok: true, itemId: item.id, reevaluate: [], unlogged: true, items: items.map(entry => entry.id !== item.id ? entry
        : withLinks(entry, entry.conversations!.map(other => other.sessionId === operation.sessionId ? next : other))) };
    }
    case "releaseOwner": {
      const owned = (entry: TodoItem) => entry.conversations?.some(link => link.owner === operation.owner) === true;
      const first = items.find(owned);
      if (!first) return unchanged("");
      return { ok: true, itemId: first.id, reevaluate: [], unlogged: true, items: items.map(entry => !owned(entry) ? entry
        : withLinks(entry, entry.conversations!.map(link => {
          if (link.owner !== operation.owner) return link;
          const { owner: _owner, seenAt: _seen, ...bare } = link;
          return bare;
        }))) };
    }
    case "dismissAsk": {
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      if (item.dismissedAsks?.includes(operation.message)) return unchanged(item.id);
      const dismissedAsks = [...(item.dismissedAsks ?? []), operation.message].slice(-TODO_ASK_DISMISSALS_MAX);
      const kept = new Set(dismissedAsks);
      const asksClosedInTodo = [...(item.asksClosedInTodo ?? []), ...(operation.place === "todo" ? [operation.message] : [])].filter(message => kept.has(message));
      const { asksClosedInTodo: _previous, ...rest } = item;
      const next: TodoItem = { ...rest, dismissedAsks, ...(asksClosedInTodo.length ? { asksClosedInTodo } : {}) };
      return { ok: true, itemId: item.id, reevaluate: [], unlogged: true, items: items.map(entry => entry.id === item.id ? next : entry) };
    }
    case "noteConversationWork": {
      const item = linkedTodoItem(items, operation.sessionId);
      const written = item ? memoUpdatedAt(item) : undefined;
      if (!item || written === undefined || operation.at <= written || memoStaleSince(item) !== undefined) return unchanged(item?.id ?? "");
      return { ok: true, itemId: item.id, reevaluate: [], unlogged: true, items: items.map(entry => entry.id !== item.id ? entry
        : withLinks(entry, entry.conversations!.map(link => link.sessionId === operation.sessionId ? { ...link, workedAt: operation.at } : link))) };
    }
    case "tidyStep": {
      if (author !== "claude") return { ok: false, error: "author-not-allowed" };
      const tidy = operation.step;
      const sub = (entries: TodoItem[], next: TodoStepOperation, nextMeta: StepMeta = meta) => step(entries, next, author, now, newId, log, nextMeta);
      if (find(tidy.id)?.deletedAt !== undefined) return unchanged(tidy.id);
      if (tidy.kind === "foldDone") return sub(items, { kind: "setState", id: tidy.id, state: "done" });
      if (tidy.kind === "rename") return sub(items, { kind: "update", id: tidy.id, title: tidy.title });
      if (tidy.kind === "add") {
        let current = items;
        let currentMeta = meta;
        const reevaluate: Array<string | null> = [];
        const plant = (parentId: string, nodes: readonly TodoTidyNode[]): TodoOperationFailure | undefined => {
          for (const node of nodes) {
            const twin = liveChildren(current, parentId).find(entry => todoNameKey(entry.title) === todoNameKey(node.title));
            if (twin) { const failed = plant(twin.id, node.children ?? []); if (failed) return failed; continue; }
            const result = sub(current, { kind: "addMany", parentId, items: [node] }, currentMeta);
            if (!result.ok) return result;
            current = result.items;
            currentMeta = result.meta ?? currentMeta;
            reevaluate.push(...result.reevaluate);
          }
          return undefined;
        };
        if (!find(tidy.id) || find(tidy.id)!.deletedAt !== undefined) return { ok: false, error: "not-found" };
        const failed = plant(tidy.id, tidy.items);
        return failed ?? { ok: true, items: current, itemId: tidy.id, reevaluate, meta: currentMeta };
      }
      const basis: TodoPlacementBasis = "requested" in tidy && tidy.requested ? "requested" : "tidy";
      if (tidy.kind === "move") {
        const from = placeNow(items, meta.groups, tidy.id);
        const moved = sub(items, { kind: "move", id: tidy.id, parentId: tidy.parentId, basis, ...(tidy.position !== undefined ? { position: tidy.position } : {}),
          ...(tidy.parentId === null && tidy.group !== undefined ? { targetGroup: tidy.group } : {}) });
        const regrouped = !moved.ok || tidy.group === undefined || tidy.parentId !== null ? moved : sub(moved.items, { kind: "update", id: tidy.id, group: tidy.group, basis }, moved.meta ?? meta);
        if (!regrouped.ok) return regrouped;
        const reevaluate = regrouped === moved ? moved.reevaluate : [...(moved.ok ? moved.reevaluate : []), ...regrouped.reevaluate];
        return { ...regrouped, reevaluate, items: regrouped.items.map(entry => entry.id === tidy.id && entry.placement?.at === now ? { ...entry, placement: { ...entry.placement, from } } : entry) };
      }
      const into = find(tidy.kind === "merge" ? tidy.into : tidy.id);
      if (!into) return { ok: false, error: "not-found" };
      if (into.deletedAt !== undefined) return { ok: false, error: "deleted" };
      const kids = liveChildren(items, into.id);
      if (tidy.kind === "flatten" && kids.length !== 1) return { ok: false, error: "not-single-child" };
      const source = tidy.kind === "flatten" ? kids[0] : find(tidy.id);
      if (!source) return { ok: false, error: "not-found" };
      if (source.deletedAt !== undefined) return unchanged(into.id);
      if (source.id === into.id || isDescendant(items, into.id, source.id)) return { ok: false, error: "cycle" };
      if (source.state === "done") return { ok: false, error: "merge-done", detail: { title: source.title } };
      const unstable = unstableFailure(items, meta, source, now, true, basis === "requested");
      if (unstable) return unstable;
      let current = items;
      const reevaluate: Array<string | null> = [];
      const kept: MemoKept[] = [];
      const take = (result: StepResult): TodoOperationFailure | undefined => {
        if (!result.ok) return result;
        current = result.items;
        reevaluate.push(...result.reevaluate);
        kept.push(...result.memoKept ?? []);
        return undefined;
      };
      for (const child of liveChildren(items, source.id)) {
        const twin = liveChildren(current, into.id).find(entry => entry.id !== child.id && todoNameKey(entry.title) === todoNameKey(child.title));
        const failed = take(twin && child.state !== "done"
          ? sub(current, { kind: "tidyStep", step: { kind: "merge", id: child.id, into: twin.id, ...(basis === "requested" ? { requested: true as const } : {}) } })
          : sub(current, { kind: "move", id: child.id, parentId: into.id, basis, ...(twin ? { allowTwin: true as const } : {}) }));
        if (failed) return failed;
      }
      const carried = (mine: string, theirs: string) => [mine.trim() ? mine : "", `${source.title}:\n${theirs}`].filter(Boolean).join("\n\n");
      const firstWording = source.captured && source.captured.text !== source.title ? source.captured.text : "";
      for (const section of WORK_MEMO_SECTIONS) {
        const text = [source.workMemo[section]?.text?.trim() ?? "", section === "current" ? firstWording : ""].filter(Boolean).join("\n");
        if (!text) continue;
        const failed = take(sub(current, { kind: "writeWorkMemo", id: into.id, section, text: carried(current.find(entry => entry.id === into.id)!.workMemo[section]?.text ?? "", text) }));
        if (failed) return failed;
      }
      if (source.userMemo.trim()) {
        const before = current.find(entry => entry.id === into.id)!.userMemo;
        const after = carried(before, source.userMemo);
        log(into.id, "userMemo", before || null, after);
        current = current.map(entry => entry.id === into.id ? { ...entry, userMemo: after, updatedAt: now } : entry);
      }
      const failed = take(sub(current, { kind: "delete", id: source.id }));
      if (failed) return failed;
      return { ok: true, items: current, itemId: into.id, reevaluate, ...(kept.length ? { memoKept: kept } : {}) };
    }
    case "addDoc":
    case "putDoc":
    case "removeDoc": {
      if (operation.kind !== "removeDoc" && author !== "human") return { ok: false, error: "author-not-allowed" };
      const item = find(operation.id);
      if (!item) return { ok: false, error: "not-found" };
      if (item.deletedAt !== undefined) return { ok: false, error: "deleted" };
      const docs = item.docs ?? [];
      let next: readonly TodoDoc[];
      if (operation.kind === "removeDoc") {
        const doc = docs.find(entry => entry.id === operation.docId);
        if (!doc) return unchanged(item.id);
        next = docs.filter(entry => entry !== doc);
        log(item.id, "docs", doc, null);
      } else {
        const doc: TodoDoc = operation.kind === "putDoc" ? operation.doc
          : { ...operation.doc, id: newId(new Set(docs.map(entry => entry.id))), at: now };
        if (docs.some(entry => entry.id === doc.id)) return unchanged(item.id);
        next = [...docs, doc];
        log(item.id, "docs", null, doc);
      }
      return { ok: true, itemId: item.id, reevaluate: [],
        items: items.map(entry => entry.id === item.id ? { ...entry, docs: next, updatedAt: now } : entry) };
    }
  }
}

type TidyRun = { readonly ok: true; readonly items: TodoItem[]; readonly reevaluate: Array<string | null>; readonly memoKept: MemoKept[]; readonly meta: StepMeta } | TodoOperationFailure;

function runTidySteps(items: TodoItem[], steps: readonly TodoTidyStep[], now: number, newId: TodoOperationContext["newId"], log: ChangeLog, meta: StepMeta): TidyRun {
  let current = items;
  let currentMeta = meta;
  const reevaluate: Array<string | null> = [];
  const memoKept: MemoKept[] = [];
  for (const [index, entry] of steps.entries()) {
    const result = step(current, { kind: "tidyStep", step: entry }, "claude", now, newId, log, currentMeta);
    if (!result.ok) return { ...result, detail: { ...result.detail, step: index } };
    current = result.items;
    currentMeta = result.meta ?? currentMeta;
    reevaluate.push(...result.reevaluate);
    memoKept.push(...result.memoKept ?? []);
  }
  return { ok: true, items: current, reevaluate, memoKept, meta: currentMeta };
}

export function isTodoTidyStep(value: unknown): value is TodoTidyStep {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return false;
  switch (value.kind) {
    case "move": return (value.parentId === null || typeof value.parentId === "string") && (value.group === undefined || typeof value.group === "string")
      && (value.position === undefined || (Number.isSafeInteger(value.position) && (value.position as number) >= 0)) && (value.requested === undefined || value.requested === true);
    case "merge": return typeof value.into === "string" && value.into.length > 0 && (value.requested === undefined || value.requested === true) && (value.flattened === undefined || value.flattened === true);
    case "rename": return typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= TODO_TITLE_MAX;
    case "add": return Array.isArray(value.items) && value.items.length > 0 && value.items.every(isTidyNode);
    case "flatten": return value.requested === undefined || value.requested === true;
    case "foldDone": return true;
  }
  return false;
}

function isTidyNode(value: unknown): value is TodoTidyNode {
  return isRecord(value) && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= TODO_TITLE_MAX
    && (value.children === undefined || (Array.isArray(value.children) && value.children.every(isTidyNode)));
}

function isTodoTidyRecord(value: unknown): value is TodoTidyRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.at === "number"
    && Array.isArray(value.steps) && value.steps.every(isTodoTidyStep) && Number.isSafeInteger(value.revision);
}

export function isTodoDoc(value: unknown): value is TodoDoc {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && (TODO_DOC_KINDS as readonly unknown[]).includes(value.kind)
    && typeof value.target === "string" && value.target.length > 0 && value.target.length <= TODO_DOC_TARGET_MAX
    && (value.label === undefined || (typeof value.label === "string" && value.label.length <= TODO_DOC_LABEL_MAX))
    && (value.kind !== "image" || (TODO_IMAGE_FILE.test(value.target) && typeof value.mediaType === "string" && value.mediaType in TODO_IMAGE_EXTENSIONS))
    && typeof value.at === "number";
}

export interface TodoImageRef {
  readonly name: string;
  readonly deletedAt?: number;
}

export function todoImageRefs(document: Pick<TodoDocument, "items" | "changes">): TodoImageRef[] {
  const refs: TodoImageRef[] = [];
  const byId = new Map(document.items.map(item => [item.id, item]));
  const add = (doc: unknown, item: TodoItem) => {
    if (isTodoDoc(doc) && doc.kind === "image") refs.push({ name: doc.target, ...(item.deletedAt !== undefined ? { deletedAt: item.deletedAt } : {}) });
  };
  for (const item of document.items) for (const doc of item.docs ?? []) add(doc, item);
  for (const change of document.changes) {
    const item = byId.get(change.itemId);
    if (change.field === "docs" && item) { add(change.before, item); add(change.after, item); }
  }
  return refs;
}

export function liveImageNames(refs: readonly TodoImageRef[], now: number): Set<string> {
  return new Set(refs.filter(ref => ref.deletedAt === undefined || now - ref.deletedAt < TODO_DELETED_RETENTION_MS).map(ref => ref.name));
}

function withStartSession(item: TodoItem, sessionId: string, tab: string | undefined): TodoItem {
  const pending = todoTabStart(item, tab);
  if (!pending || item.starts!.some(start => start.sessionId === sessionId)) return item;
  return { ...item, starts: item.starts!.map(start => start === pending ? { ...start, sessionId } : start) };
}

export function todoTabStart(item: Pick<TodoItem, "starts">, tab: string | undefined): TodoStart | undefined {
  return tab === undefined ? undefined : [...(item.starts ?? [])].reverse().find(start => start.sessionId === undefined && start.tab === tab);
}

export function todoChildBriefs(item: Pick<TodoItem, "starts">): TodoStart[] {
  return (item.starts ?? []).filter(start => start.kind === "child");
}

export function todoStartOf(item: Pick<TodoItem, "starts">, sessionId: string | undefined): TodoStart | undefined {
  return sessionId === undefined ? undefined : item.starts?.find(start => start.sessionId === sessionId);
}

function withoutClaim(item: TodoItem): TodoItem {
  const { pendingStart: _claim, ...rest } = item;
  return rest;
}

export function startClaimFresh(claim: TodoStartClaim, now: number): boolean {
  return now - claim.at < TODO_START_CLAIM_MS;
}

export function conversationLiveElsewhere(link: TodoConversationLink, owner: string, now: number): boolean {
  return link.owner !== undefined && link.owner !== owner && link.seenAt !== undefined && now - link.seenAt < TODO_CONVERSATION_LIVE_MS;
}

function withLinks(item: TodoItem, links: readonly TodoConversationLink[]): TodoItem {
  const { conversations: _previous, ...rest } = item;
  return links.length ? { ...rest, conversations: links.slice(-TODO_CONVERSATION_LINKS_MAX) } : rest;
}

export function newestConversation(item: Pick<TodoItem, "conversations">): TodoConversationLink | undefined {
  return item.conversations?.at(-1);
}

export function linkedTodoItem<T extends Pick<TodoItem, "conversations" | "deletedAt">>(items: readonly T[], sessionId: string | undefined): T | undefined {
  if (!sessionId) return undefined;
  let found: { item: T; at: number } | undefined;
  for (const item of items) {
    if (item.deletedAt !== undefined) continue;
    const link = item.conversations?.find(entry => entry.sessionId === sessionId);
    if (link && (found === undefined || link.at > found.at)) found = { item, at: link.at };
  }
  return found?.item;
}

export function memoUpdatedAt(item: Pick<TodoItem, "workMemo">): number | undefined {
  const times = WORK_MEMO_SECTIONS.flatMap(section => item.workMemo[section] ? [item.workMemo[section]!.at] : []);
  return times.length ? Math.max(...times) : undefined;
}

export function memoStaleSince(item: Pick<TodoItem, "workMemo" | "conversations">): number | undefined {
  const written = memoUpdatedAt(item);
  if (written === undefined) return undefined;
  const after = (item.conversations ?? []).flatMap(link => link.workedAt !== undefined && link.workedAt > written ? [link.workedAt] : []);
  return after.length ? Math.min(...after) : undefined;
}

const finiteOrAbsent = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value));

function isTodoConversationLink(value: unknown): value is TodoConversationLink {
  return isRecord(value) && typeof value.sessionId === "string" && value.sessionId.length > 0 && typeof value.at === "number" && Number.isFinite(value.at)
    && finiteOrAbsent(value.workedAt) && finiteOrAbsent(value.seenAt) && (value.owner === undefined || typeof value.owner === "string")
    && (value.via === undefined || value.via === "handoff");
}

export function isTodoAskIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= TODO_ASK_IDENTITY_MAX;
}

function isTodoStartClaim(value: unknown): value is TodoStartClaim {
  return isRecord(value) && typeof value.owner === "string" && typeof value.token === "string" && typeof value.at === "number" && Number.isFinite(value.at);
}

export type TodoConversationTarget =
  | { kind: "tab"; tabId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "new" }
  | { kind: "elsewhere" };

export function todoConversationTarget(items: readonly TodoItem[], itemId: string, tabs: readonly TodoTabConversation[], fresh: boolean,
  self: { readonly owner: string; readonly now: number }): TodoConversationTarget {
  const item = items.find(entry => entry.id === itemId);
  const claimedElsewhere = item?.pendingStart !== undefined && item.pendingStart.owner !== self.owner && startClaimFresh(item.pendingStart, self.now);
  if (fresh) return claimedElsewhere ? { kind: "elsewhere" } : { kind: "new" };
  const newest = item ? newestConversation(item) : undefined;
  const current = newest && tabs.find(tab => tab.sessionId === newest.sessionId);
  if (current) return { kind: "tab", tabId: current.tabId };
  const pending = tabs.find(tab => tab.itemId === itemId && tab.sessionId === undefined);
  if (pending) return { kind: "tab", tabId: pending.tabId };
  if (claimedElsewhere) return { kind: "elsewhere" };
  if (newest) return conversationLiveElsewhere(newest, self.owner, self.now) ? { kind: "elsewhere" } : { kind: "session", sessionId: newest.sessionId };
  return { kind: "new" };
}

export type ClaimedStart = "started" | "elsewhere" | "failed";

export async function runClaimedStart(apply: (operation: TodoOperation) => Promise<TodoDocument | undefined>,
  id: string, owner: string, token: string, start: () => Promise<boolean>): Promise<ClaimedStart> {
  const claimed = await apply({ kind: "claimStart", id, owner, token });
  if (!claimed) return "failed";
  if (claimed.items.find(entry => entry.id === id)?.pendingStart?.token !== token) return "elsewhere";
  let started = false;
  try {
    started = await start();
    return started ? "started" : "failed";
  } finally {
    if (!started) await apply({ kind: "releaseStart", id, token });
  }
}

export function singleFlight<K>(): (key: K, run: () => Promise<void>) => Promise<void> {
  const running = new Map<string, Promise<void>>();
  return (key, run) => {
    const id = JSON.stringify(key);
    const current = running.get(id);
    if (current) return current;
    const started = run().finally(() => running.delete(id));
    running.set(id, started);
    return started;
  };
}

export interface TodoTabConversation {
  readonly tabId: string;
  readonly itemId?: string;
  readonly sessionId?: string;
  readonly running: boolean;
}

export function todoTabLinks(items: readonly TodoItem[], tabs: readonly TodoTabConversation[]): { tabItems: Array<{ tabId: string; itemId: string }>; running: Set<string>; deleted: string[] } {
  const live = new Set(items.filter(item => item.deletedAt === undefined).map(item => item.id));
  const tabItems: Array<{ tabId: string; itemId: string }> = [];
  const running = new Set<string>();
  const deleted: string[] = [];
  for (const tab of tabs) {
    const itemId = linkedTodoItem(items, tab.sessionId)?.id ?? (tab.itemId !== undefined && live.has(tab.itemId) ? tab.itemId : undefined);
    if (itemId === undefined) {
      if (deletedTodoItem(items, tab.sessionId) !== undefined || (tab.itemId !== undefined && items.some(item => item.id === tab.itemId))) deleted.push(tab.tabId);
      continue;
    }
    tabItems.push({ tabId: tab.tabId, itemId });
    if (tab.running) running.add(itemId);
  }
  return { tabItems, running, deleted };
}

function deletedTodoItem(items: readonly TodoItem[], sessionId: string | undefined): TodoItem | undefined {
  if (!sessionId || linkedTodoItem(items, sessionId) !== undefined) return undefined;
  return items.find(item => item.deletedAt !== undefined && item.conversations?.some(link => link.sessionId === sessionId));
}

export type TodoSessionLink = { readonly sessionId: string; readonly itemId: string } | { readonly sessionId: string; readonly deleted: string };

export function todoSessionLinks(items: readonly TodoItem[]): TodoSessionLink[] {
  const links: TodoSessionLink[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const link of item.conversations ?? []) {
      if (seen.has(link.sessionId)) continue;
      seen.add(link.sessionId);
      const live = linkedTodoItem(items, link.sessionId);
      const gone = live === undefined ? deletedTodoItem(items, link.sessionId) : undefined;
      if (live) links.push({ sessionId: link.sessionId, itemId: live.id });
      else if (gone) links.push({ sessionId: link.sessionId, deleted: gone.title });
    }
  }
  return links;
}

export function todoRecordAskSources(items: readonly TodoItem[]): Array<{ itemId: string; link: TodoConversationLink }> {
  const sources: Array<{ itemId: string; link: TodoConversationLink }> = [];
  const seen = new Set<string>();
  const finished = todoFinishedIds(items.filter(item => item.deletedAt === undefined));
  for (const item of items) {
    if (item.deletedAt !== undefined || finished.has(item.id)) continue;
    const link = newestConversation(item);
    if (link === undefined || seen.has(link.sessionId) || linkedTodoItem(items, link.sessionId)?.id !== item.id) continue;
    seen.add(link.sessionId);
    sources.push({ itemId: item.id, link });
  }
  return sources;
}

export function todoAskDismissals(items: readonly TodoItem[]): string[] {
  return items.flatMap(item => item.deletedAt === undefined ? item.dismissedAsks ?? [] : []);
}

export function todoAsksClosedInTodo(items: readonly TodoItem[]): string[] {
  return items.flatMap(item => item.deletedAt === undefined ? item.asksClosedInTodo ?? [] : []);
}

export function todoScopeIds(items: readonly Pick<TodoItem, "id" | "parentId">[], rootId: string): Set<string> {
  return items.some(item => item.id === rootId) ? subtreeIds(items as readonly TodoItem[], rootId) : new Set();
}

function memoVersionText(section: TodoMemoSection | undefined, version: number | null): string | undefined {
  if (version === null) return "";
  if (section?.version === version) return section.text;
  return section?.history.find(entry => entry.version === version)?.text;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function exactStateOf(id: string, before: Record<string, unknown>): TodoStepOperation {
  return { kind: "setExactState", id, state: before.state as TodoState, ...(before.completion === "auto" || before.completion === "manual" ? { completion: before.completion } : {}),
    ...(before.startedAt === null || (typeof before.startedAt === "number" && Number.isFinite(before.startedAt)) ? { startedAt: before.startedAt as number | null } : {}) };
}

function inverseOperation(change: TodoChange): TodoStepOperation | undefined {
  const id = change.itemId;
  const before = isRecord(change.before) ? change.before : undefined;
  if (change.field === "groups") {
    const to = isGroupRecord(change.before) ? change.before : null;
    const current = isGroupRecord(change.after) ? change.after.name : null;
    return to || current ? { kind: "setGroupEntry", current, to } : undefined;
  }
  if (change.field === "groupBindings") {
    return before && typeof before.group === "string" && isGroupFolders(before.folders) && isGroupAliases(before.aliases)
      ? { kind: "setGroupBindings", group: before.group, folders: before.folders, aliases: before.aliases } : undefined;
  }
  if (change.field === "templates") {
    const to = isTodoTemplate(change.before) ? change.before : null;
    const current = isTodoTemplate(change.after) ? change.after.id : null;
    return to || current ? { kind: "setTemplate", current, to } : undefined;
  }
  if (change.field === "docLabel") {
    return before && typeof before.docId === "string" ? { kind: "docLabel", id, docId: before.docId, label: typeof before.label === "string" ? before.label : "" } : undefined;
  }
  const section = memoField(change.field);
  if (section) return { kind: "restoreWorkMemo", id, section, version: typeof before?.version === "number" ? before.version : null };
  if (change.field === "group") return { kind: "restoreItemGroup", id, group: typeof change.before === "string" ? change.before : null };
  if ((TODO_TEXT_FIELDS as readonly string[]).includes(change.field)) {
    const value = typeof change.before === "string" ? change.before : null;
    if (change.field === "title" && value === null) return undefined;
    const update = { kind: "update", id, [change.field]: change.field === "userMemo" ? value ?? "" : value } as TodoUpdateOperation;
    const guess = change.guess;
    return (change.field === "due" || change.field === "priority") && isRecord(guess) && typeof guess.value === "string" && typeof guess.reason === "string"
      ? { ...update, restoreGuess: { field: change.field, guess: { value: guess.value, reason: guess.reason } } } : update;
  }
  switch (change.field) {
    case "state": return before && (TODO_STATES as readonly unknown[]).includes(before.state) ? exactStateOf(id, before) : undefined;
    case "position": return before && (before.parentId === null || typeof before.parentId === "string")
      ? { kind: "move", id, parentId: before.parentId, ...(typeof before.position === "number" && before.position >= 0 ? { position: before.position } : {}),
        ...(before.parentId === null && typeof before.group === "string" ? { restoreGroup: before.group } : {}) }
      : undefined;
    case "item": return { kind: "delete", id };
    case "deletedAt": return change.before === null ? { kind: "restore", id } : { kind: "delete", id };
    case "docs":
      if (isTodoDoc(change.before)) return { kind: "putDoc", id, doc: change.before };
      return isTodoDoc(change.after) ? { kind: "removeDoc", id, docId: change.after.id } : undefined;
  }
  return undefined;
}

function matchesMetaAfter(meta: StepMeta, change: TodoChange): boolean {
  if (change.field === "groupBindings") {
    const after = isRecord(change.after) ? change.after : undefined;
    const group = meta.groups.find(entry => entry.name === after?.group);
    return group !== undefined && isGroupFolders(after?.folders) && isGroupAliases(after?.aliases) && sameBindings(bindingsOf(group), { folders: after.folders, aliases: after.aliases });
  }
  if (change.field === "groups") {
    const after = isGroupRecord(change.after) ? change.after : null;
    if (!after) return isGroupRecord(change.before) && !meta.groups.some(group => group.name === (change.before as TodoGroupRecord).name);
    const now = groupRecord(meta.groups, after.name);
    const moved = isGroupRecord(change.before) && change.before.index !== after.index;
    return now !== null && now.color === after.color && (!moved || now.index === after.index);
  }
  const after = isTodoTemplate(change.after) ? change.after : null;
  if (!after) return isTodoTemplate(change.before) && !meta.templates.some(entry => entry.id === (change.before as TodoTemplate).id);
  return meta.templates.some(entry => entry.id === after.id);
}

function metaKeys(change: TodoChange): Set<string> {
  const keyOf = (value: unknown) => isGroupRecord(value) ? value.name : isTodoTemplate(value) ? value.id : isRecord(value) && typeof value.group === "string" ? value.group : undefined;
  return new Set([keyOf(change.before), keyOf(change.after)].filter((key): key is string => key !== undefined));
}

const isMetaChange = (change: Pick<TodoChange, "field">) => change.field === "groups" || change.field === "templates" || change.field === "groupBindings";

function matchesAfter(item: TodoItem, change: TodoChange): boolean {
  const after = isRecord(change.after) ? change.after : undefined;
  if (change.field === "docLabel") {
    const doc = item.docs?.find(entry => entry.id === after?.docId);
    return doc !== undefined && (doc.label ?? null) === (after?.label ?? null);
  }
  const section = memoField(change.field);
  if (section) return item.workMemo[section]?.version === after?.version;
  if ((TODO_TEXT_FIELDS as readonly string[]).includes(change.field)) return (item[change.field as TodoTextField] || null) === (change.after ?? null);
  switch (change.field) {
    case "state": return item.state === after?.state && item.completion === (after?.completion ?? undefined);
    case "position": return item.parentId === after?.parentId;
    case "item": return item.deletedAt === undefined;
    case "deletedAt": return change.after === null ? item.deletedAt === undefined : item.deletedAt === change.after;
    case "docs": {
      const docId = isTodoDoc(change.after) ? change.after.id : isTodoDoc(change.before) ? change.before.id : undefined;
      const present = (item.docs ?? []).some(doc => doc.id === docId);
      return change.after === null ? !present : present;
    }
  }
  return false;
}

function isReverted(changes: readonly TodoChange[], index: number): boolean {
  const id = changes[index].id;
  for (let at = index + 1; at < changes.length; at++) {
    if (changes[at].revertOf === id && !isReverted(changes, at)) return true;
  }
  return false;
}

export type TodoRevertDocument = Pick<TodoDocument, "items" | "changes"> & Partial<Pick<TodoDocument, "groups" | "templates" | "groupColors">>;

function createdGroupOf(change: TodoChange): string | undefined {
  return change.field === "groups" && !isGroupRecord(change.before) && isGroupRecord(change.after) ? change.after.name : undefined;
}

function groupInUse(items: readonly TodoItem[], name: string): boolean {
  return items.some(entry => entry.deletedAt === undefined && entry.group === name);
}

export function todoRestoredBy(changes: readonly TodoChange[]): Set<string> {
  return new Set(changes.filter(change => change.field === "deletedAt" && change.before === null).map(change => change.itemId));
}

export function revertBlock(document: TodoRevertDocument, change: TodoChange, mode: TodoRevertMode, deferInUse = false, restoring: ReadonlySet<string> = new Set(), batch: ReadonlySet<string> = new Set()): TodoRevertBlock | null {
  if (change.cascade || change.author !== (mode === "undo" ? "human" : "claude") || inverseOperation(change) === undefined) return "not-target";
  if (change.revertible === false) return "unrevertible";
  const index = document.changes.findIndex(entry => entry.id === change.id);
  if (index < 0) return "gone";
  if (isReverted(document.changes, index)) return "reverted";
  const other: TodoAuthor = mode === "undo" ? "claude" : "human";
  const later = document.changes.slice(index + 1);
  const revertsClaude = (entry: TodoChange) => entry.revertOf !== undefined && document.changes.find(target => target.id === entry.revertOf)?.author === "claude";
  const byOther = (entry: TodoChange) => entry.author === other && !(mode === "claude" && revertsClaude(entry));
  if (isMetaChange(change)) {
    if (!matchesMetaAfter({ groups: todoGroupsOf(document), templates: todoTemplatesOf(document) }, change)) return "superseded";
    const keys = metaKeys(change);
    if (later.some(entry => entry.field === change.field && [...metaKeys(entry)].some(key => keys.has(key)) && byOther(entry))) return "superseded";
    const created = createdGroupOf(change);
    if (!deferInUse && created !== undefined && groupInUse(document.items, created)) return "in-use";
    return null;
  }
  const item = document.items.find(entry => entry.id === change.itemId);
  if (!item) return "gone";
  const coveredLater = later.some(entry => batch.has(entry.id) && entry.itemId === change.itemId && entry.field === change.field);
  if (!coveredLater && !matchesAfter(item, change)) return "superseded";
  if (later.some(entry => entry.itemId === change.itemId && entry.field === change.field && byOther(entry) && !(mode === "claude" && entry.cascade))) return "superseded";
  if (inverseOperation(change)?.kind === "delete") {
    const subtree = subtreeIds(document.items, change.itemId);
    if (later.some(entry => subtree.has(entry.itemId) && byOther(entry))) return "superseded";
  }
  const section = memoField(change.field);
  const before = isRecord(change.before) ? change.before : undefined;
  if (section && typeof before?.version === "number" && memoVersionText(item.workMemo[section], before.version) === undefined) return "unrevertible";
  if (change.field === "position" && before && typeof before.parentId === "string" && !restoring.has(before.parentId) && !liveParentIn(document.items, before.parentId)) return "gone";
  return null;
}

export function todoRevertBlocks(document: TodoRevertDocument, targets: readonly TodoChange[], mode: TodoRevertMode, deferInUse = false): Array<TodoRevertBlock | null> {
  const restoring = todoRestoredBy(targets);
  const batch = new Set(targets.map(change => change.id));
  return targets.map(change => revertBlock(document, change, mode, deferInUse, restoring, batch));
}

export function todoRevertUnitBlock(document: TodoRevertDocument, unit: readonly TodoChange[]): TodoRevertBlock | null {
  if (unit.length === 0) return "not-target";
  const open = todoRevertOpen(document.changes, unit);
  if (open.length === 0) return "reverted";
  const blocks = todoRevertBlocks(document, open, "claude", true);
  const created = open.flatMap(change => createdGroupOf(change) ?? []);
  const leftUsing = (name: string) => document.items.some(item => item.deletedAt === undefined && item.parentId === null && item.group === name
    && !open.some(change => change.itemId === item.id && (change.field === "item" || change.field === "group")));
  return blocks.find(block => block !== null) ?? (created.some(leftUsing) ? "in-use" : null);
}

function todoRevertOpen(changes: readonly TodoChange[], targets: readonly TodoChange[]): TodoChange[] {
  return targets.filter(change => !todoChangeReverted(changes, change));
}

export function todoMarkChanges(changes: readonly TodoChange[], unit: readonly TodoChange[]): TodoChange[] {
  const open = todoRevertOpen(changes, unit);
  const moves = open.filter(change => change.field === "position" || change.field === "group");
  return open.filter(change => !moves.includes(change) || change === moves.at(-1));
}

export function todoChangeReverted(changes: readonly TodoChange[], change: TodoChange): boolean {
  const index = changes.findIndex(entry => entry.id === change.id);
  return index >= 0 && isReverted(changes, index);
}

function revertibleCascades(changes: readonly TodoChange[], reverted: readonly TodoChange[], before: readonly TodoItem[], items: readonly TodoItem[]): TodoChange[] {
  const revisionOf = (change: TodoChange) => parseTodoChangeId(change.id).revision;
  const revisions = new Set(reverted.map(revisionOf));
  const inRevision = (change: TodoChange) => revisions.has(revisionOf(change));
  const causedBy = (cascade: TodoChange) => reverted.some(change => revisionOf(change) === revisionOf(cascade)
    && (change.itemId === cascade.itemId || hasAncestorIn(before, change.itemId, new Set([cascade.itemId])) || hasAncestorIn(items, change.itemId, new Set([cascade.itemId]))
      || (change.field === "position" && isRecord(change.before) && (change.before.parentId === cascade.itemId
        || (typeof change.before.parentId === "string" && hasAncestorIn(before, change.before.parentId, new Set([cascade.itemId])))))));
  return changes.filter((change, index) => {
    if (!change.cascade || change.field !== "state" || !inRevision(change) || !causedBy(change) || !isRecord(change.before)) return false;
    if (!(TODO_STATES as readonly unknown[]).includes(change.before.state)) return false;
    const item = items.find(entry => entry.id === change.itemId);
    if (!item || item.deletedAt !== undefined || !matchesAfter(item, change)) return false;
    return !changes.slice(index + 1).some(entry => entry.itemId === change.itemId && entry.field === "state" && !inRevision(entry));
  });
}

function revertTargets(changes: readonly TodoChange[], operation: Extract<TodoOperation, { kind: "revert" }>): TodoChange[] | TodoRevertBlock {
  if (operation.mode === "claude" && "revisions" in operation) {
    const revisions = new Set(operation.revisions);
    const own = changes.filter(entry => revisions.has(parseTodoChangeId(entry.id).revision) && isClaudeOwnChange(entry));
    const open = todoRevertOpen(changes, own);
    return own.length === 0 ? "gone" : open.length ? open : own;
  }
  if (operation.mode === "claude") {
    const ids = "changeIds" in operation ? operation.changeIds : [operation.changeId];
    const found = ids.map(id => changes.find(entry => entry.id === id));
    if (found.length === 0 || found.some(change => change === undefined)) return "gone";
    const open = todoRevertOpen(changes, found as TodoChange[]);
    return open.length ? open : found as TodoChange[];
  }
  const written = changes.filter(entry => parseTodoChangeId(entry.id).revision === operation.revision);
  if (written.length === 0) return "gone";
  const own = written.filter(entry => entry.author === "human" && !entry.cascade);
  return own.length ? own : "not-target";
}

function rootOf(items: readonly TodoItem[], id: string): TodoItem | undefined {
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set<string>();
  let at = byId.get(id);
  while (at && at.parentId !== null && byId.has(at.parentId) && !seen.has(at.id)) {
    seen.add(at.id);
    at = byId.get(at.parentId);
  }
  return at;
}

function hasAncestorIn(items: readonly TodoItem[], id: string, ids: ReadonlySet<string>): boolean {
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set([id]);
  for (let at = byId.get(id)?.parentId ?? null; at !== null && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
    if (ids.has(at)) return true;
    seen.add(at);
  }
  return false;
}

export function applyTodoOperation(document: TodoDocument, operation: TodoOperation, context: TodoOperationContext): TodoOperationResult {
  const { author, now } = context;
  const items = pruneDeletedItems(document.items, now);
  const changes: Array<Omit<TodoChange, "id">> = [];
  const logTo = (revertOf?: string): ChangeLog => (itemId, field, before, after, extra) =>
    changes.push({ at: now, author, itemId, field, before, after, ...(revertOf ? { revertOf } : {}), ...(extra?.guess ? { guess: extra.guess } : {}), ...(extra?.cascade ? { cascade: true as const } : {}),
      ...(extra?.basis ? { basis: extra.basis } : {}) });
  const kept: MemoKept[] = [];
  let next = items;
  let itemId: string;
  const reevaluate: Array<string | null> = [];
  let skipped = 0;
  let unlogged = false;
  let meta: StepMeta = { groups: todoGroupsOf(document), templates: todoTemplatesOf(document), history: document.changes };

  if (operation.kind === "acknowledge") {
    if (author !== "human") return { ok: false, error: "author-not-allowed" };
    const ids = new Set(operation.changeIds);
    let marked = false;
    const acknowledged = document.changes.map(change => {
      if (!ids.has(change.id) || change.author !== "claude" || change.acknowledged) return change;
      marked = true;
      return { ...change, acknowledged: true as const };
    });
    if (!marked) return { ok: true, document, itemId: "", changed: false };
    return { ok: true, itemId: "", changed: true, document: { ...document, version: TODO_DOCUMENT_VERSION, revision: document.revision + 1, items, groups: meta.groups, changes: acknowledged } };
  }

  const proposals = document.tidy ?? [];
  let tidy: readonly TodoTidyRecord[] | undefined;
  let reverted: ReadonlySet<string> | undefined;
  if (operation.kind === "tidy") {
    if (author !== "claude") return { ok: false, error: "author-not-allowed" };
    if (operation.steps.length === 0 || operation.steps.length > TODO_TIDY_STEPS_MAX) return { ok: false, error: "too-many" };
    const flattenedBefore = (id: string) => proposals.some(record => record.steps.some(entry => entry.kind === "merge" && entry.flattened && entry.into === id
      && !items.some(item => item.id === entry.id && item.deletedAt === undefined)));
    const steps = operation.steps.flatMap((entry): TodoTidyStep[] => {
      if (entry.kind !== "flatten") return [entry];
      if (flattenedBefore(entry.id)) return [];
      const kids = liveChildren(items, entry.id);
      return kids.length === 1 ? [{ kind: "merge", id: kids[0].id, into: entry.id, flattened: true, ...(entry.requested ? { requested: true as const } : {}) }] : [entry];
    });
    const run = runTidySteps(items, steps, now, context.newId, logTo(), meta);
    if (!run.ok) return run;
    next = run.items;
    meta = run.meta;
    itemId = "";
    reevaluate.push(...run.reevaluate);
    kept.push(...run.memoKept);
    if (changes.length) {
      itemId = context.newId(new Set(proposals.map(entry => entry.id)));
      tidy = [...proposals, { id: itemId, at: now, steps, revision: document.revision + 1 }].slice(-TODO_TIDY_KEPT);
    }
  } else if (operation.kind === "revert") {
    if (author !== "human") return { ok: false, error: "author-not-allowed" };
    const found = revertTargets(document.changes, operation);
    if (typeof found === "string") return { ok: false, error: found };
    const current = { items, changes: document.changes, groups: meta.groups, templates: meta.templates };
    const purged = (change: TodoChange) => change.itemId !== "" && !items.some(item => item.id === change.itemId);
    const deletesGroup = found.some(change => change.field === "groups" && isGroupRecord(change.before) && change.after === null);
    const targets = operation.mode === "undo" && deletesGroup && found.some(change => !purged(change))
      ? found.filter(change => !purged(change)) : found;
    const blocks = todoRevertBlocks(current, targets, operation.mode, true);
    const open = targets.filter((_, index) => blocks[index] === null);
    if (open.length === 0) return { ok: false, error: blocks[0]! };
    const whole = operation.mode === "undo" ? new Set(targets.map(change => change.itemId)).size > 1 : targets.length > 1;
    if (whole && open.length < targets.length) return { ok: false, error: blocks.find(block => block !== null)! };
    skipped = targets.length - open.length;
    const deleting = new Set(open.filter(change => change.field === "deletedAt").map(change => change.itemId));
    let failure: TodoOperationError | undefined;
    const applied: TodoChange[] = [];
    const ordered = [...open].reverse();
    const bringsGroupBack = (entry: TodoChange) => entry.field === "groups" && isGroupRecord(entry.before);
    const middle = ordered.filter(entry => createdGroupOf(entry) === undefined && !bringsGroupBack(entry));
    for (const change of [...ordered.filter(bringsGroupBack), ...middle, ...ordered.filter(entry => createdGroupOf(entry) !== undefined)]) {
      if (change.field === "deletedAt" && hasAncestorIn(items, change.itemId, deleting)) { applied.push(change); continue; }
      const created = createdGroupOf(change);
      if (created !== undefined && groupInUse(next, created)) {
        if (whole || open.length === 1) return { ok: false, error: "in-use" };
        failure ??= "in-use";
        skipped++;
        continue;
      }
      const result = step(next, inverseOperation(change)!, author, now, context.newId, logTo(change.id), meta);
      if (!result.ok && whole) return result;
      if (!result.ok) { failure ??= result.error; skipped++; continue; }
      applied.push(change);
      next = result.items;
      meta = result.meta ?? meta;
      reevaluate.push(change.itemId, ...result.reevaluate);
      if (result.memoKept) kept.push(...result.memoKept);
    }
    if (changes.length === 0) return { ok: false, error: failure ?? "superseded" };
    for (const cascade of revertibleCascades(document.changes, applied, items, next).reverse()) {
      const result = step(next, exactStateOf(cascade.itemId, cascade.before as Record<string, unknown>), author, now, context.newId, logTo(cascade.id), meta);
      if (!result.ok) continue;
      next = result.items;
      reevaluate.push(cascade.itemId, ...result.reevaluate);
    }
    itemId = open[0].itemId;
    reverted = new Set(applied.map(change => change.id));
  } else {
    const result = step(items, operation, author, now, context.newId, logTo(), meta);
    if (!result.ok) return result;
    next = result.items;
    meta = result.meta ?? meta;
    itemId = result.itemId;
    unlogged = result.unlogged === true;
    reevaluate.push(...result.reevaluate);
    if (result.memoKept) kept.push(...result.memoKept);
  }

  const cascaded = cascadeStates(next, reevaluate, now);
  for (const change of cascaded.changed) changes.push({ at: now, author, itemId: change.id, field: "state", before: change.before, after: change.after, cascade: true });
  let groups = [...meta.groups];
  for (const name of itemGroupNames(cascaded.items)) if (!groups.some(group => group.name === name)) groups = withNewGroup(groups, name, logTo());
  let unbound = [...(document.unboundFolders ?? [])];
  if (reverted) {
    const revisions = new Set([...reverted].map(id => parseTodoChangeId(id).revision));
    const learned = document.changes.filter(change => change.cascade && revisions.has(parseTodoChangeId(change.id).revision) && (change.field === "groupBindings" || change.field === "unboundFolders"));
    ({ groups, unbound } = forgetLearned(groups, unbound, learned, logTo()));
  } else if (author === "human" && TODO_LEARNING_KINDS.has(operation.kind)) {
    ({ groups, unbound } = learnBindings(groups, items, cascaded.items, changes, unbound, logTo()));
  }
  if (operation.kind === "groupFolderAdd") unbound = unbound.filter(path => todoFolderKey(path) !== todoFolderKey(operation.path));
  if (changes.length === 0 && !unlogged) return { ok: true, document, itemId, changed: false };
  const revision = document.revision + 1;
  const logged = changes.map((change, index) => ({ ...change, id: todoChangeId(revision, index) }));
  const { groupColors: _legacy, unboundFolders: _unbound, ...base } = document;
  return { ok: true, itemId, changed: true, ...(skipped ? { skipped } : {}), document: {
    ...base,
    version: TODO_DOCUMENT_VERSION, revision,
    items: cascaded.items,
    groups,
    templates: meta.templates,
    ...(tidy ? { tidy } : {}),
    ...(unbound.length ? { unboundFolders: unbound } : {}),
    changes: [...kept.reduce(markUnrevertible, document.changes), ...logged].slice(-TODO_CHANGE_LOG_LIMIT),
  } };
}

function markUnrevertible(changes: readonly TodoChange[], kept: MemoKept): readonly TodoChange[] {
  return changes.map(change => {
    const version = (change.before as { version?: unknown } | null)?.version;
    return change.itemId === kept.itemId && change.field === kept.field && change.revertible === undefined && typeof version === "number" && !kept.versions.has(version)
      ? { ...change, revertible: false } : change;
  });
}

export function pruneDeletedItems(items: readonly TodoItem[], now: number): TodoItem[] {
  return items.filter(item => item.deletedAt === undefined || now - item.deletedAt < TODO_DELETED_RETENTION_MS);
}

export function parseTodoDocument(text: string, onDroppedDocs?: (count: number) => void, onDroppedLinks?: (count: number) => void): TodoDocument {
  const value = JSON.parse(text) as Partial<TodoDocument> | null;
  if (!value || value.version !== TODO_DOCUMENT_VERSION || !Number.isSafeInteger(value.revision) || !Array.isArray(value.items) || !Array.isArray(value.changes)
    || !Array.isArray(value.writes) || !value.writes.every(entry => typeof entry === "string")) {
    throw new Error("unrecognized TODO document");
  }
  for (const item of value.items) {
    if (!item || typeof item.id !== "string" || (item.parentId !== null && typeof item.parentId !== "string") || typeof item.title !== "string"
      || !TODO_STATES.includes(item.state) || typeof item.userMemo !== "string" || !item.workMemo || typeof item.workMemo !== "object") {
      throw new Error("unrecognized TODO item");
    }
  }
  let dropped = 0;
  let droppedLinks = 0;
  const items = value.items.map(item => {
    if (item.conversations !== undefined) {
      const links = Array.isArray(item.conversations) ? item.conversations.filter(isTodoConversationLink) : [];
      const lost = Array.isArray(item.conversations) ? item.conversations.length - links.length : 1;
      if (lost > 0) { droppedLinks += lost; item = withLinks(item, links); }
    }
    if (item.pendingStart !== undefined && !isTodoStartClaim(item.pendingStart)) { droppedLinks++; item = withoutClaim(item); }
    item = withKnownExtras(item);
    if (item.parentId !== null && item.group !== undefined) { const { group: _group, ...rest } = item; item = rest; }
    if (item.dismissedAsks !== undefined && !(Array.isArray(item.dismissedAsks) && item.dismissedAsks.every(isTodoAskIdentity))) {
      droppedLinks++;
      const { dismissedAsks: _dropped, asksClosedInTodo: _closed, ...rest } = item;
      item = rest;
    }
    if (item.asksClosedInTodo !== undefined && !(Array.isArray(item.asksClosedInTodo) && item.asksClosedInTodo.every((message: unknown) => typeof message === "string" && item.dismissedAsks?.includes(message) === true))) {
      droppedLinks++;
      const { asksClosedInTodo: _dropped, ...rest } = item;
      item = rest;
    }
    if (item.docs === undefined) return item;
    const docs = Array.isArray(item.docs) ? item.docs.filter(isTodoDoc) : [];
    const lost = Array.isArray(item.docs) ? item.docs.length - docs.length : 1;
    if (lost === 0) return item;
    dropped += lost;
    return { ...item, docs };
  });
  if (dropped > 0) onDroppedDocs?.(dropped);
  if (droppedLinks > 0) onDroppedLinks?.(droppedLinks);
  const { groups: rawGroups, templates: rawTemplates, tidy: rawTidy, unboundFolders: rawUnbound, ...rest } = value;
  const unboundFolders = Array.isArray(rawUnbound) ? rawUnbound.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((group, index, all): group is TodoGroup => isRecord(group) && typeof group.name === "string" && validGroupName(group.name) && validColor(group.color)
      && all.findIndex(other => isRecord(other) && other.name === group.name) === index)
      .map(group => ({ name: group.name, color: group.color, ...(isGroupFolders(group.folders) && group.folders.length ? { folders: group.folders.map(folder => ({ path: folder.path, ...(folder.change ? { change: folder.change } : {}) })) } : {}),
        ...(isGroupAliases(group.aliases) && group.aliases.length ? { aliases: group.aliases.map(alias => ({ words: alias.words, ...(alias.parentId ? { parentId: alias.parentId } : {}), ...(alias.change ? { change: alias.change } : {}),
          ...((TODO_PLACEMENT_BASES as readonly unknown[]).includes(alias.basis) ? { basis: alias.basis } : {}) })) } : {}) }))
    : undefined;
  const templates = Array.isArray(rawTemplates) ? rawTemplates.filter(isTodoTemplate) : undefined;
  const tidy = Array.isArray(rawTidy) ? rawTidy.filter(isTodoTidyRecord).map(record => ({ id: record.id, at: record.at, steps: record.steps, revision: record.revision })) : undefined;
  const changeTimes = new Map<string, number[]>();
  for (const change of value.changes as unknown[]) {
    if (!isRecord(change) || typeof change.itemId !== "string" || !isStoredTime(change.at)) continue;
    changeTimes.set(change.itemId, [...(changeTimes.get(change.itemId) ?? []), change.at]);
  }
  return { ...rest, items: items.map(item => withItemTimes(item, changeTimes.get(item.id) ?? [])), ...(groups ? { groups } : {}), ...(templates ? { templates } : {}), ...(tidy?.length ? { tidy } : {}), ...(unboundFolders.length ? { unboundFolders } : {}) } as TodoDocument;
}

export const TODO_TIME_UNKNOWN = 0;
const isStoredTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function withItemTimes(item: TodoItem, changeTimes: readonly number[]): TodoItem {
  if (isStoredTime(item.createdAt) && isStoredTime(item.updatedAt)) return item;
  const memo = Object.values(item.workMemo).flatMap(section => [section?.at, ...(Array.isArray(section?.history) ? section.history.map(entry => entry?.at) : [])]);
  const known = [item.createdAt, item.updatedAt, item.captured?.at, item.placement?.at, item.pinnedAt, item.startedAt, item.doneAt, item.deletedAt, ...memo,
    ...(item.docs ?? []).map(doc => doc.at), ...(item.conversations ?? []).map(link => link.at), ...(item.starts ?? []).map(start => start.at), ...changeTimes].filter(isStoredTime);
  const createdAt = isStoredTime(item.createdAt) ? item.createdAt : known.length ? Math.min(...known) : TODO_TIME_UNKNOWN;
  const updatedAt = isStoredTime(item.updatedAt) ? item.updatedAt : Math.max(createdAt, ...known);
  return { ...item, createdAt, updatedAt };
}

function isTodoStart(value: unknown): value is TodoStart {
  const text = (entry: unknown) => entry === undefined || typeof entry === "string";
  return isRecord(value) && typeof value.at === "number" && (TODO_START_KINDS as readonly unknown[]).includes(value.kind) && typeof value.brief === "string"
    && text(value.sessionId) && text(value.tab) && text(value.current) && text(value.next) && (value.stale === undefined || value.stale === true);
}

function trimStarts(starts: readonly TodoStart[]): TodoStart[] {
  const children = starts.filter(start => start.kind === "child").slice(-TODO_STARTS_MAX);
  const others = starts.filter(start => start.kind !== "child").slice(-TODO_STARTS_MAX);
  const kept = new Set([...children, ...others]);
  return starts.filter(start => kept.has(start));
}

function withKnownExtras(item: TodoItem): TodoItem {
  const draft: Record<string, unknown> = { ...item };
  for (const field of ["waiting", "repeat", "estimate", "tags"] as const) if (draft[field] !== undefined && typeof draft[field] !== "string") delete draft[field];
  for (const field of ["startedAt", "doneAt"] as const) if (!finiteOrAbsent(draft[field])) delete draft[field];
  if (draft.by !== undefined && draft.by !== "claude") delete draft.by;
  if (draft.starts !== undefined && !(Array.isArray(draft.starts) && draft.starts.every(isTodoStart))) delete draft.starts;
  if (Array.isArray(draft.briefs)) {
    const starts = (draft.starts ?? []) as TodoStart[];
    const legacy = draft.briefs.filter(brief => isRecord(brief) && typeof brief.at === "number" && typeof brief.text === "string" && !starts.some(start => start.kind === "child" && start.brief === brief.text))
      .map(brief => ({ at: brief.at as number, kind: "child" as const, brief: brief.text as string }));
    if (legacy.length) draft.starts = trimStarts([...starts, ...legacy].sort((a, b) => a.at - b.at));
  }
  delete draft.briefs;
  if (draft.caseWords !== undefined && !(typeof draft.caseWords === "string" && draft.caseWords.length > 0 && draft.caseWords.length <= TODO_GROUP_MAX)) delete draft.caseWords;
  if (draft.placedFrom !== undefined && !(typeof draft.placedFrom === "string" && draft.placedFrom.length > 0 && draft.placedFrom.length <= TODO_DOC_TARGET_MAX)) delete draft.placedFrom;
  if (draft.source !== undefined && !(isRecord(draft.source) && typeof draft.source.sessionId === "string" && draft.source.sessionId.length > 0)) delete draft.source;
  const isGuess = (guess: unknown) => guess === undefined || (isRecord(guess) && typeof guess.value === "string" && typeof guess.reason === "string");
  if (draft.guesses !== undefined && !(isRecord(draft.guesses) && isGuess(draft.guesses.due) && isGuess(draft.guesses.priority))) delete draft.guesses;
  return draft as unknown as TodoItem;
}

export interface TodoRecordMessage {
  readonly uuid: string;
  readonly role: string;
  readonly text: string;
  readonly timestamp: number;
}

export function todoAskSourceMessages(messages: readonly TodoRecordMessage[]): Array<TodoRecordMessage & { role: "user" | "assistant" }> {
  const spoken = messages.filter((m): m is TodoRecordMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant");
  const first = spoken.findIndex(m => m.role === "assistant" && m.text.includes(ASK_FENCE_INFO));
  if (first < 0) return [];
  return spoken.slice(first).filter(m => m.role === "user" || m.text.includes(ASK_FENCE_INFO))
    .slice(-TODO_ASK_SOURCE_MESSAGES_MAX).map(m => ({ uuid: m.uuid, role: m.role, text: m.text, timestamp: m.timestamp }));
}


export interface TodoChangePlace {
  readonly group: string | null;
  readonly path: readonly { readonly id: string; readonly title: string }[];
}

export interface TodoCardChange {
  readonly id: string;
  readonly at: number;
  readonly itemId: string;
  readonly itemTitle: string;
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly cascade?: true;
  readonly from?: TodoChangePlace;
  readonly to?: TodoChangePlace;
}

export type TodoCardMark = "+" | "-" | "~";

export interface TodoCardRow<C extends TodoCardChange = TodoCardChange> {
  readonly key: string;
  readonly depth: number;
  readonly itemId?: string;
  readonly group?: string | null;
  readonly number: string;
  readonly title: string;
  readonly mark?: TodoCardMark;
  readonly changes: readonly C[];
  readonly previousTitle?: string;
}

const TODO_CARD_MOVES: ReadonlySet<string> = new Set(["position", "group"]);

function samePlace(a: TodoChangePlace | undefined, b: TodoChangePlace | undefined): boolean {
  return a !== undefined && b !== undefined && (a.path.at(-1)?.id ?? null) === (b.path.at(-1)?.id ?? null) && (a.path.length > 0 || a.group === b.group);
}

export function todoCardTree<C extends TodoCardChange>(changes: readonly C[], live: readonly Pick<TodoItem, "id" | "parentId" | "group" | "title">[], groupOrder: readonly string[],
  numberOf: (id: string) => string | undefined): TodoCardRow<C>[] {
  type Node = { key: string; id?: string; group?: string | null; title: string; mark?: TodoCardMark; changes: C[]; previousTitle?: string; children: Node[]; seq: number; number: string };
  let seq = 0;
  const groups = new Map<string, Node>();
  const groupKey = (name: string | null) => name === null ? "none" : `g:${name}`;
  const groupNode = (name: string | null): Node => {
    let node = groups.get(groupKey(name));
    if (!node) groups.set(groupKey(name), node = { key: groupKey(name), group: name, title: name ?? "", changes: [], children: [], seq: seq++, number: "" });
    return node;
  };
  const liveById = new Map(live.map(item => [item.id, item]));
  const numberAt = (id: string, parentId: string | null) => liveById.get(id)?.parentId === parentId ? numberOf(id) ?? "" : "";
  const place = (spec: { id: string; title: string; mark: TodoCardMark; at: TodoChangePlace; changes: C[]; previousTitle?: string }) => {
    let parent = groupNode(spec.at.group);
    let parentId: string | null = null;
    for (const step of spec.at.path) {
      let found = parent.children.find(child => child.id === step.id && child.mark !== "-");
      if (!found) parent.children.push(found = { key: `c:${step.id}:${seq}`, id: step.id, title: liveById.get(step.id)?.title ?? step.title, changes: [], children: [], seq: seq++, number: numberAt(step.id, parentId) });
      parent = found;
      parentId = step.id;
    }
    const same = parent.children.find(child => child.id === spec.id && (spec.mark === "-" ? child.mark === "-" : child.mark !== "-"));
    if (same) {
      same.mark = spec.mark;
      same.changes.push(...spec.changes);
      same.previousTitle ??= spec.previousTitle;
      return;
    }
    parent.children.push({ key: `${spec.mark}:${spec.id}`, id: spec.id, title: spec.title, mark: spec.mark, changes: [...spec.changes], ...(spec.previousTitle !== undefined ? { previousTitle: spec.previousTitle } : {}),
      children: [], seq: seq++, number: spec.mark === "-" ? "" : numberAt(spec.id, parentId) });
  };
  const own = changes.filter(change => !change.cascade);
  const units = new Map<string, C[]>();
  for (const change of own) {
    const key = change.itemId === "" ? (change.field === "groups" ? `group:${change.after ?? change.before ?? ""}` : "") : `item:${change.itemId}`;
    if (key) units.set(key, [...units.get(key) ?? [], change]);
  }
  for (const [key, unit] of units) {
    if (key.startsWith("group:")) {
      const first = unit[0], last = unit.at(-1)!;
      const node = groupNode(last.after ?? first.before);
      node.mark = first.before === null ? "+" : last.after === null ? "-" : "~";
      node.changes.push(...unit);
      if (first.before !== null && last.after !== null && first.before !== last.after) node.previousTitle = first.before;
      continue;
    }
    const id = unit[0].itemId;
    const title = liveById.get(id)?.title ?? unit.at(-1)!.itemTitle;
    const titled = unit.find(change => change.field === "title");
    const previousTitle = titled && titled.before !== null && titled.before !== title ? titled.before : undefined;
    const deletion = unit.filter(change => change.field === "deletedAt").at(-1);
    const moves = unit.filter(change => TODO_CARD_MOVES.has(change.field));
    const added = unit.some(change => change.field === "item") || (deletion !== undefined && deletion.after === null);
    const current = [...unit].reverse().find(change => change.to !== undefined)?.to;
    if (deletion && deletion.after !== null) {
      const at = deletion.from ?? unit.find(change => change.field === "item")?.to;
      if (at) place({ id, title, mark: "-", at, changes: unit });
      continue;
    }
    if (added) {
      if (current) place({ id, title, mark: "+", at: current, changes: unit, ...(previousTitle !== undefined ? { previousTitle } : {}) });
      continue;
    }
    const from = moves.find(change => change.from !== undefined)?.from;
    const to = [...moves].reverse().find(change => change.to !== undefined)?.to;
    if (from && to && !samePlace(from, to)) {
      place({ id, title, mark: "-", at: from, changes: moves });
      place({ id, title, mark: "+", at: to, changes: unit, ...(previousTitle !== undefined ? { previousTitle } : {}) });
      continue;
    }
    if (current) place({ id, title, mark: "~", at: current, changes: unit, ...(previousTitle !== undefined ? { previousTitle } : {}) });
  }
  const numberKey = (node: Node) => node.number ? node.number.split(".").map(Number) : undefined;
  const order = (a: Node, b: Node) => {
    const x = numberKey(a), y = numberKey(b);
    if (x && y) {
      for (let index = 0; index < Math.max(x.length, y.length); index++) if ((x[index] ?? -1) !== (y[index] ?? -1)) return (x[index] ?? -1) - (y[index] ?? -1);
      return a.seq - b.seq;
    }
    return x ? -1 : y ? 1 : a.seq - b.seq;
  };
  const groupRank = (node: Node) => node.group === null ? Number.MAX_SAFE_INTEGER : groupOrder.includes(node.group!) ? groupOrder.indexOf(node.group!) : groupOrder.length + node.seq;
  const rows: TodoCardRow<C>[] = [];
  const emit = (node: Node, depth: number) => {
    rows.push({ key: node.key, depth, number: node.number, title: node.title, changes: node.changes, ...(node.id !== undefined ? { itemId: node.id } : { group: node.group ?? null }),
      ...(node.mark ? { mark: node.mark } : {}), ...(node.previousTitle !== undefined ? { previousTitle: node.previousTitle } : {}) });
    for (const child of [...node.children].sort(order)) emit(child, depth + 1);
  };
  for (const node of [...groups.values()].sort((a, b) => groupRank(a) - groupRank(b))) emit(node, 0);
  return rows;
}

export interface TodoFolderScope {
  readonly cwd: string;
  readonly roots: readonly string[];
  readonly home?: string;
}

export function todoBindableFolder(folder: string, scope: TodoFolderScope): boolean {
  const key = todoFolderKey(folder);
  const broad = [...scope.roots, ...(scope.home ? [scope.home] : [])].some(root => root.trim() !== "" && todoFolderKey(root) === key);
  const inside = [scope.cwd, ...scope.roots].some(root => root.trim() !== "" && todoFolderWithin(folder, root));
  return inside && !broad && key.split("/").filter(Boolean).length >= 2;
}

export function todoFailureResultText(error: string, message: string, word?: string): string {
  return JSON.stringify({ error, ...(word !== undefined ? { word } : {}), message });
}
