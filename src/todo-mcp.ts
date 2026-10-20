import { z } from "zod";
import * as l10n from "@vscode/l10n";
import type * as Sdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type { LearningRootGate, RootGateScope } from "./learning-mcp";
import {
  isClaudeOwnChange, linkedTodoItem, liveChildren, memoStaleSince, parseTodoChangeId, TODO_ADD_MANY_MAX, TODO_CLAUDE_DEPTH_MAX, TODO_ADD_PLACEMENT_BASES, TODO_TIDY_KINDS, TODO_TIDY_STEPS_MAX, type TodoAddNode, todoAgentMarker,
  todoBindableFolder, todoFailureResultText, TODO_STABLE_TOUCH_MS, TODO_STABLE_PIN_MS, TODO_STABLE_REMOVE_MS,
  todoConversationFolder, todoDoneTwin, todoFinishedIds, todoTidySignals, todoFolderGroup, todoGroupsOf, todoItemNumbers, todoItemPath, todoPlaceOf, todoPlaceText, todoWriteResultText, TODO_DUE_PATTERN, TODO_GROUP_MAX, TODO_GUESS_REASON_MAX,
  TODO_PRIORITIES, TODO_SERVER_NAME, TODO_STATE_BRACKETS, TODO_STATE_CHECKBOXES, TODO_STATE_SEPARATORS, TODO_STATE_TRAILING_WORDS, TODO_STATE_WORDS, TODO_TITLE_PARTICLES, todoTitlePlaceOf, todoTitleRepeat, TODO_TOOL_KINDS, todoToolName, type TodoToolKind, TODO_STATES, TODO_TITLE_MAX, TODO_WRITE_TOOLS, WORK_MEMO_SECTIONS, type WorkMemoSection, type TodoDocument, type TodoItem,
  type TodoOperation, type TodoOperationError, type TodoPlacementBasis, type TodoOperationFailure, type TodoOperationResult, type TodoRevertBlock, type TodoTidyStep,
} from "./todo-model";
import { TodoStoreError, type TodoStore } from "./todo-store";
import { TODO_SPLIT_FENCE_INFO } from "./markdown-ast";

export { TODO_SERVER_NAME } from "./todo-model";
export const TODO_WRITE_TOOL_NAMES: readonly string[] = TODO_WRITE_TOOLS;
export const TODO_TOOL_NAMES = TODO_TOOL_KINDS.map(todoToolName);

const TODO_HOUR_MS = 60 * 60_000;
const TODO_DAY_MS = 24 * TODO_HOUR_MS;
const span = (ms: number) => ms % TODO_DAY_MS === 0 ? `${ms / TODO_DAY_MS} days` : `${ms / TODO_HOUR_MS} hours`;
const TODO_DEPTH_EXAMPLE = Array.from({ length: TODO_CLAUDE_DEPTH_MAX }, (_, level) => level === 0 ? "01" : Array.from({ length: level + 1 }, (_, at) => at + 1).join(".")).join(" / ");
const TODO_STABLE_RULE = `Items in progress (or holding one), items the user changed in the last ${span(TODO_STABLE_TOUCH_MS)} and items the user moved in the last ${span(TODO_STABLE_PIN_MS)} are not moved or retitled; items you moved in the last ${span(TODO_STABLE_REMOVE_MS)} are not moved again unless requested is set because the user explicitly asked for this restructure.`;
const TODO_REQUESTED = z.literal(true).optional().describe(`Set only when the user explicitly asked for this restructure in this conversation; it lifts only the rule against moving again what you moved in the last ${span(TODO_STABLE_REMOVE_MS)}, and the change shows as done on request.`);
export const TODO_LIST_ITEMS_MAX = 150;
const TODO_SCOPE = "The user's persistent TODO list: one per PC, shared by every LAISORA window and conversation, kept across restarts. It is not this conversation's plan: use TaskCreate/TaskUpdate (or TodoWrite) for the steps of the current request, and this TODO list only for items the user asks to keep or track beyond this conversation.";
const TODO_ROOT_ONLY = "Only the main conversation may change the TODO list; a subagent reports to the main conversation, which writes.";
export const TODO_ROOT_SCOPE: RootGateScope = { tools: TODO_WRITE_TOOL_NAMES, denial: TODO_ROOT_ONLY };
const TODO_CHILD_GROUP_NOTE = "The group was not set: a sub-item follows the group of its top-level item. Set the group on the top-level item instead.";
const TODO_MEMO_STALE_NOTE = "A conversation linked to this item worked after the work memo was last written, so the memo may be out of date; check it against the current state and rewrite the sections that changed.";
const TODO_CASE_RULES = "A group is one case with its own lifetime (a product, a client case, a household area); words for a kind of list or work (roadmap, bugs, research, ideas) are never groups but top-level items inside the case. The case comes from, in this order: a case word in the request (and the aliases list returns in context), the group of the item this conversation is linked to, what the conversation is about and the folder of the files it read or edited (list's context). With any of these signals, place the item in the most likely case and tell the user in one line in their language with the path the result returns, e.g. \"<path> に入れました。違ったら言ってください\"; do not stop to ask. Use No group only when there is no signal at all. Items the user added themselves are often quick captures to be organized, not a structure to copy. In a conversation about several topics, only sub-tasks of the linked work go under the linked item; other cases go to their own group.";
const TODO_PATH_READING = "Read each item as one line: group › ancestors › title.";
const TODO_TITLE_COMPARE = "compared ignoring case, full/half width, spaces, punctuation and symbols";
const TODO_REPEAT_RULE = `${TODO_PATH_READING} A title adds only what that line does not already say. A title that obviously repeats the line (${TODO_TITLE_COMPARE}, it is its group's name or an ancestor's title, or begins with one followed by a space, punctuation, a symbol or one of ${TODO_TITLE_PARTICLES.join(" ")}) is not refused: the write result lists it under repeats with what to do, and list shows it as the repeatsPlace tidy signal.`;
const TODO_REPEAT_CHECKED: readonly TodoToolKind[] = ["add", "update", "move", "tidy"];
const TODO_REPEAT_FIX = "Each item in repeats has a title that its path already says (word = the repeated group name or ancestor title); rename it now (update, or tidy rename for the user's items) so the path reads as one line.";
const TODO_TITLE_SAME = `the same as another open item's title under the same parent (at the top level, in the same group), ${TODO_TITLE_COMPARE}`;
const TODO_STATE_MARKERS = `a state marker (case-sensitive): a leading ${TODO_STATE_CHECKBOXES.join(" ")}; ${TODO_STATE_WORDS.join(" ")} between any opening bracket ${TODO_STATE_BRACKETS.map(([open]) => open).join(" ")} and any closing bracket ${TODO_STATE_BRACKETS.map(([, close]) => close).join(" ")} at the start or end; or a trailing ${TODO_STATE_TRAILING_WORDS.join(" ")} after a space or ${TODO_STATE_SEPARATORS.join(" ")}`;
const TODO_MOVE_TITLE_RULE = `move, update changing a top-level item's group, and tidy move refuse the moved item when its title is ${TODO_TITLE_SAME} at the destination.`;
const TODO_TITLE_RULE = `${TODO_REPEAT_RULE} Refused with the reason: a title ${TODO_TITLE_SAME}; a title with ${TODO_STATE_MARKERS}; a title longer than ${TODO_TITLE_MAX} characters. ${TODO_MOVE_TITLE_RULE}`;
const TODO_TIDY_ADD_FOLD = `tidy add puts a node whose title matches an existing sub-item's (open or done, ${TODO_TITLE_COMPARE}) into that sub-item instead of adding it.`;
const TODO_ITEM_RULES = `A top-level item is a theme or deliverable worth its own conversation, a child is a task one sitting finishes, a grandchild is a step; items are at most ${TODO_CLAUDE_DEPTH_MAX} levels (${TODO_DEPTH_EXAMPLE}) and finer detail goes into the work memo. Titles state the outcome or action, one per item. ${TODO_TITLE_RULE} Reuse an item that already says the same thing instead of adding another. Set due and priority only when the source states them.`;
const TODO_IMPORT_RULES = "When turning material (a ledger, notes, an image) into items: first check which entries are still open in the source and add only those; build the skeleton first (the container and the themes the source has), and do not invent sub-items the source does not have (leave a leaf and write 分解する in its next section); write the source and how many entries you skipped and why into the parent's work memo. Decisions, questions and facts go into the work memo sections, not into items.";

export interface TodoLinkedItem {
  readonly id: string;
  readonly title: string;
  readonly parent?: { readonly id: string; readonly title: string };
}

export interface TodoConversationContext {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly roots?: readonly string[];
  readonly home?: string;
}

let workspaceRoots: () => readonly string[] = () => [];

export function setTodoWorkspaceRoots(read: () => readonly string[]): void {
  workspaceRoots = read;
}

export function todoWorkspaceRoots(): readonly string[] {
  return workspaceRoots();
}

export function todoLinkedInstruction(item: TodoLinkedItem): string {
  const which = item.parent
    ? `the TODO sub-item "${item.title}" (id ${item.id}) of "${item.parent.title}" (id ${item.parent.id}); this is its child conversation`
    : `the TODO item "${item.title}" (id ${item.id}); this is its parent conversation`;
  return [
    `This conversation is linked to ${which}.`,
    `Keep that item's work memo current with ${todoToolName("write_memo")} as the work moves (where it stands, next steps, decisions, open points, files); the memo is how later conversations and handoffs pick the work up. Read the item and its memo with ${todoToolName("list")} (id ${item.id}); its text is not repeated in this prompt.`,
    item.parent
      ? `Read the parent's work memo by reference with ${todoToolName("list")} (id ${item.parent.id}); do not copy it into this item's memo.`
      : "Sub-items can run as background agents that report back here, and you write their results into the TODO list; the user can also split a sub-item into its own child conversation.",
    ...(item.parent ? [] : [
      `When you start a subagent (Agent tool) to work on one of this item's sub-items, end the Agent call's description with ${todoAgentMarker("<sub-item id>")}, for example "Draft the outline ${todoAgentMarker("a1b2c3d4")}"; put nothing after it and never put it at the start of the description.`,
      `When a sub-item would be better worked in its own child conversation than here, you may suggest that with a fenced code block whose info string is ${TODO_SPLIT_FENCE_INFO} and whose body is one JSON object {"item": "<sub-item id>", "reason": "<one short sentence>"}; the user decides whether to split it.`,
    ]),
    `Set the item's state with ${todoToolName("set_state")} when the work on it starts and when it is done.`,
  ].join(" ");
}

const id = z.string().min(1).describe("Item id as shown by list.");
const title = z.string().min(1).max(TODO_TITLE_MAX);
const due = z.string().regex(TODO_DUE_PATTERN).describe("Due date, YYYY-MM-DD.");
const group = z.string().min(1).max(TODO_GROUP_MAX).describe("Name of an existing group (the case); sub-items follow the group of their top-level item.");
const newGroup = z.literal(true).describe("Create the group named in group because the request names a case that matches no existing group. A name close to an existing group is refused even with this.");
const position = z.number().int().min(0).optional().describe("0-based position among the new siblings; omitted = last.");
const start = z.string().regex(TODO_DUE_PATTERN).describe("Start date, YYYY-MM-DD.");
const priority = z.enum(TODO_PRIORITIES).describe("Priority: p0 = top, p1 high, p2 medium, p3 low.");
const reason = (field: string) => z.string().min(1).max(TODO_GUESS_REASON_MAX)
  .describe(`Set only when you estimated the ${field} yourself instead of being told it: the evidence in one short sentence. The user sees the ${field} marked as estimated with this reason until they change it.`);
const itemFields = { due: due.optional(), start: start.optional(), priority: priority.optional(),
  due_reason: reason("due date").optional(), priority_reason: reason("priority").optional(), group: group.optional(), new_group: newGroup.optional(),
  basis: z.enum(TODO_ADD_PLACEMENT_BASES).optional().describe("What decided the place: named = the request names it, linked = this conversation's linked item, files = the files this conversation worked on, folder = a folder binding, alias = words learned from the user's corrections, inbox = no signal (No group)."),
  imported: z.literal(true).optional().describe("Set when the item comes from material such as a ledger, notes or an image."),
  case_words: z.string().min(1).max(TODO_GROUP_MAX).optional().describe("The words of the request you took as naming the case or scope, as the user wrote them (e.g. \"laisora のバグ\"); when the user moves the item elsewhere, these words are remembered for that place.") };
const TODO_SINGLE_ADD_FIELDS = [...Object.keys(itemFields), "position"] as const;
const addNode: z.ZodType = z.strictObject({ title, ...itemFields,
  get children() { return z.array(addNode).min(1).optional().describe("Sub-items of this item, in order."); } });
const tidyNode: z.ZodType = z.strictObject({ title, get children() { return z.array(tidyNode).min(1).optional(); } });
const tidyStep = z.strictObject({
  kind: z.enum(TODO_TIDY_KINDS).describe("move = put the item under parent (null = top level, then group names its case); merge = fold the item into the item into (its sub-items and memo text go there, the item goes to recently deleted); flatten = fold the only sub-item of the item into it; foldDone = set the item done so it folds away; rename = rewrite the title as an outcome; add = add sub-items (a breakdown) under the item."),
  id,
  parent: id.nullable().optional().describe("move: new parent item id; null = top level."),
  group: group.optional().describe("move to the top level: the existing group to put it in."),
  position,
  into: id.optional().describe("merge: the item that stays."),
  title: title.optional().describe("rename: the new title."),
  items: z.array(tidyNode).min(1).optional().describe("add: the sub-items, each with optional children."),
  requested: TODO_REQUESTED,
});

const TODO_INPUTS = {
  list: { id: id.optional().describe("Read one item with its memos and subtree."),
    group: z.string().min(1).max(TODO_GROUP_MAX).optional().describe("Show this group's tree instead of the context group's."),
    all: z.literal(true).optional().describe("Show the tree of every group."),
    done: z.literal(true).optional().describe("Include done items in the tree.") },
  add: { title: title.optional().describe("Title of the single item to add; omit when items is given."), parent: id.optional().describe("Nest under this item; omitted = top level."), ...itemFields, position,
    items: z.array(addNode).min(1).optional()
      .describe(`Several items to add in this one call, in order, each with optional nested children; instead of title and the single-item fields. At most ${TODO_ADD_MANY_MAX} items in total.`) },
  update: { id, title: title.optional(), due: due.nullable().optional().describe("Due date, YYYY-MM-DD; null clears it."),
    start: start.nullable().optional().describe("Start date, YYYY-MM-DD; null clears it."), priority: priority.nullable().optional().describe("Priority; null clears it."),
    due_reason: reason("due date").optional(), priority_reason: reason("priority").optional(),
    group: group.nullable().optional().describe("Group name of a top-level item; null clears it."), new_group: newGroup.optional() },
  move: { id, parent: id.nullable().describe("New parent item id; null = top level."), position, requested: TODO_REQUESTED },
  set_state: { id, state: z.enum(TODO_STATES) },
  write_memo: { id, section: z.enum(WORK_MEMO_SECTIONS).optional().describe("The one section to rewrite; omit when sections is given."),
    text: z.string().optional().describe("Full new text of that section; replaces the current text."),
    sections: z.object(Object.fromEntries(WORK_MEMO_SECTIONS.map(section => [section, z.string().optional()]))).strict().optional()
      .describe("Several sections to rewrite in this one call, each with its full new text; instead of section and text.") },
  delete: { id },
  group: { action: z.enum(["create", "rename", "delete", "move"]), name: group.describe("The group to act on (create: the new name)."),
    to: z.string().min(1).max(TODO_GROUP_MAX).optional().describe("rename: the new name."),
    position: z.number().int().min(0).optional().describe("move: the group's new 0-based place in the group order.") },
  tidy: { steps: z.array(tidyStep).min(1).max(TODO_TIDY_STEPS_MAX).describe("The tidy-up, applied in this order.") },
} satisfies Record<TodoToolKind, Record<string, z.ZodType>>;

const TODO_DESCRIPTIONS: Record<TodoToolKind, string> = {
  list: `Read the TODO list: every group first (display order, open and done counts, empty ones included, the folders bound to it), the conversation context (cwd, the folder of the files this conversation used, the group bound to it, and words learned from the user's corrections with the place they mean), then the open items of the context group as a tree with the numbers the user sees (${TODO_DEPTH_EXAMPLE}); when the conversation has no context group or that group has no open items, the open items of every group, shortened to about ${TODO_LIST_ITEMS_MAX} items with a note, and tidy signals (same titles among siblings, a parent with one child, crowded sibling lists, titles that repeat their group or an ancestor (repeatsPlace), open items waiting in No group: file them with tidy). ${TODO_PATH_READING} Use group, all or done for more. Reading one item also returns its parent id, path, the user's memo, your work memo (with a note when later work may have made it out of date) and the item's references the user attached (links as URL or file path; images as a reference you cannot open). ${TODO_IMPORT_RULES} ${TODO_SCOPE}`,
  add: `Add an item, or several items with their sub-items through items, to the TODO list; the result gives each item's id and path. When adding more than one item, add them all in one call with items rather than one call per item. ${TODO_CASE_RULES} ${TODO_ITEM_RULES} ${TODO_SCOPE} ${TODO_ROOT_ONLY}`,
  update: `Change an item's title, due date, start date, priority or group in the TODO list. ${TODO_TITLE_RULE} ${TODO_ROOT_ONLY}`,
  move: `Move an item under another parent or to the top level of the TODO list; both parents' states are re-evaluated. Giving the same parent without position changes nothing. ${TODO_REPEAT_RULE} ${TODO_MOVE_TITLE_RULE} ${TODO_STABLE_RULE} ${TODO_ROOT_ONLY}`,
  set_state: `Set a TODO item's state (todo, doing, done). Set done directly only items under the item this conversation is linked to; for other finished items use tidy with foldDone. A child that starts makes not-started ancestors doing; when every child is done the parent becomes done, and it reopens when a child reopens unless it was set done directly. ${TODO_ROOT_ONLY}`,
  write_memo: `Rewrite one section of a TODO item's work memo, your own notes for the item (current = where the work stands, next = next steps, decisions = what was decided, open = unresolved points, files = files involved). The previous text goes to the section history. When rewriting more than one section, give them all in one call with sections rather than one call per section. The user's memo on the item is separate and read-only to you. ${TODO_ROOT_ONLY}`,
  delete: `Delete a TODO item together with all its sub-items, only when the user asks for it. They move to the user's recently deleted list, from which the user can restore them, and the user can take the deletion back from the conversation. ${TODO_ROOT_ONLY}`,
  group: `Create, rename, delete or reorder a group (a case). Create only when the request names a case that matches no existing group. Delete only a group that holds no item the user added (it is refused otherwise); its items move to No group. The colour is the user's. Each change shows in the conversation and the user can take it back. ${TODO_ROOT_ONLY}`,
  tidy: `Tidy the TODO list now, as one change the user sees in the conversation as a before/after tree and can take back in one step: file items into their case and parent (move), rewrite rough titles as outcomes (rename; the original wording is kept), break an item down (add), merge duplicates (merge), fold a single-child parent (flatten) and set finished work done (foldDone). Use it when list shows tidy signals, especially items waiting in No group, and for changes to the user's own items outside this conversation's linked item. ${TODO_STABLE_RULE} Running the same steps again changes nothing; a move to the parent an item already has, with no position, changes nothing. Sub-items with the same title as one in the item that stays are merged into it. Done items are never merged away; a merged item goes to recently deleted. ${TODO_TITLE_RULE} ${TODO_TIDY_ADD_FOLD} ${TODO_ROOT_ONLY}`,
};

const OPERATION_ERRORS: Record<Exclude<TodoOperationError, TodoRevertBlock>, string> = {
  "not-found": "No TODO item has that id; call list to get current ids.",
  deleted: "That TODO item is already deleted.",
  "invalid-parent": "The parent id does not name a live TODO item.",
  cycle: "An item cannot be moved under itself or its own descendant.",
  "empty-title": "The title is empty.",
  "title-too-long": `The title is longer than ${TODO_TITLE_MAX} characters; put details in the work memo.`,
  "author-not-allowed": "That field is not writable through this tool.",
  "group-exists": "A group with that name already exists.",
  "invalid-name": "The name is empty or too long.",
  "too-many": `At most ${TODO_ADD_MANY_MAX} items can be added in one call, and a tidy-up has at most ${TODO_TIDY_STEPS_MAX} steps; split them over several calls.`,
  "too-deep": `Items are at most ${TODO_CLAUDE_DEPTH_MAX} levels deep (${TODO_DEPTH_EXAMPLE}); put this detail in the work memo of its parent instead.`,
  "duplicate-title": "An item with the same title is already there; update or reuse it instead of adding another.",
  "title-state": `The title carries ${TODO_STATE_MARKERS}; set the state with set_state instead.`,
  "outside-linked": "Set done directly only items under the item this conversation is linked to; use tidy with foldDone for others.",
  "user-item": "The user added this item; outside this conversation's linked item you change the user's items only through tidy (move, rename, add sub-items, merge, foldDone), which the user sees and can take back.",
  "unknown-group": "No group has that name. Use an existing group, or pass new_group only when the request names a case that matches none.",
  "near-group": "The name is close to an existing group; use that group. A name this close is not created even with new_group.",
  "merge-done": "A done item is never merged away; done items stay and fold in the list.",
  "not-single-child": "flatten applies only to an item with exactly one sub-item.",
  "unstable": `${TODO_STABLE_RULE} Leave it where it is.`,
  "group-has-user-items": "The group holds items the user added; Claude deletes only a group without the user's items. Move your own items out or leave the group.",
};

const STORE_ERRORS: Record<TodoStoreError["code"], string> = {
  conflict: "The TODO list changed during the write; retry.",
  uncertain: "The TODO list changed many times while this write was in flight, so it is not known whether it applied; list the TODO list before retrying.",
  corrupt: "The TODO list file could not be read, so it was left unchanged. Tell the user.",
  io: "The TODO list could not be read or written. Tell the user.",
};

type Reply = { isError?: true; content: Array<{ type: "text"; text: string }> };
const reply = (text: string, isError = false): Reply => ({ ...(isError ? { isError: true as const } : {}), content: [{ type: "text", text }] });

interface ListView {
  readonly live: readonly TodoItem[];
  readonly numbers: ReadonlyMap<string, string>;
  readonly path: (itemId: string) => string;
}

function listView(document: TodoDocument): ListView {
  const live = document.items.filter(item => item.deletedAt === undefined);
  const numbers = todoItemNumbers(live, todoGroupsOf(document).map(entry => entry.name));
  return { live, numbers, path: itemId => todoPlaceText(todoPlaceOf(live, itemId, entry => numbers.get(entry) ?? ""), l10n.t("No group")) };
}

function itemView(view: ListView, item: TodoItem, detail: boolean, hidden: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const children = liveChildren(view.live, item.id).filter(child => !hidden.has(child.id)).map(child => itemView(view, child, false, hidden));
  return {
    id: item.id, number: view.numbers.get(item.id) ?? "", title: item.title, state: item.state,
    ...(item.due ? { due: item.due } : {}), ...(item.start ? { start: item.start } : {}), ...(item.priority ? { priority: item.priority } : {}), ...(item.group ? { group: item.group } : {}),
    ...(detail ? {
      path: view.path(item.id),
      ...(item.parentId !== null ? { parentId: item.parentId } : {}),
      userMemo: item.userMemo,
      workMemo: Object.fromEntries(WORK_MEMO_SECTIONS.flatMap(section => {
        const memo = item.workMemo[section];
        return memo ? [[section, { text: memo.text, writtenAt: new Date(memo.at).toISOString() }]] : [];
      })),
      ...(memoStaleSince(item) !== undefined ? { workMemoNote: TODO_MEMO_STALE_NOTE } : {}),
      ...(item.docs?.length ? { references: item.docs.map(doc => ({
        ...(doc.kind === "url" ? { url: doc.target } : doc.kind === "file" ? { path: doc.target } : { image: doc.target }),
        ...(doc.label ? { label: doc.label } : {}),
      })) } : {}),
    } : {}),
    ...(children.length ? { children } : {}),
  };
}

function groupViews(document: TodoDocument, view: ListView): Array<Record<string, unknown>> {
  const finished = todoFinishedIds(view.live);
  const tally = (key: string | null) => {
    const members = view.live.filter(item => (todoItemPath(view.live, item.id)[0]?.group ?? null) === key);
    return { open: members.filter(item => !finished.has(item.id)).length, done: members.filter(item => finished.has(item.id)).length };
  };
  const named = todoGroupsOf(document).map(entry => ({ name: entry.name, ...tally(entry.name), ...(entry.folders?.length ? { folders: entry.folders.map(folder => folder.path) } : {}) }));
  const loose = tally(null);
  return loose.open + loose.done > 0 ? [...named, { name: null, label: l10n.t("No group"), ...loose }] : named;
}

function contextView(document: TodoDocument, context: TodoConversationContext | undefined): Record<string, string> | undefined {
  if (!context) return undefined;
  const groups = todoGroupsOf(document);
  const files = todoConversationFolder(groups, context.files);
  const group = context.files.length ? files.group : todoFolderGroup(groups, context.cwd)?.group;
  return { cwd: context.cwd, ...(files.folder ? { filesFolder: files.folder } : {}), ...(group ? { group, groupFrom: context.files.length ? "files" : "folder" } : {}) };
}

function aliasViews(document: TodoDocument, view: ListView): Array<Record<string, string>> {
  return todoGroupsOf(document).flatMap(entry => (entry.aliases ?? []).map(alias => ({ words: alias.words, group: entry.name, ...(alias.basis ? { correctedBasis: alias.basis } : {}),
    ...(alias.parentId && view.live.some(item => item.id === alias.parentId) ? { parent: view.path(alias.parentId), parentId: alias.parentId } : {}) })));
}

function treeView(view: ListView, input: Record<string, unknown>, context: Record<string, string> | undefined, noGroupNames: readonly string[]): Record<string, unknown> {
  const finished = todoFinishedIds(view.live);
  const hidden: ReadonlySet<string> = input.done === true ? new Set() : finished;
  const roots = liveChildren(view.live, null).filter(item => !hidden.has(item.id)).sort((a, b) => Number(view.numbers.get(a.id)) - Number(view.numbers.get(b.id)));
  const asked = typeof input.group === "string" ? (noGroupNames.includes(input.group) ? null : input.group) : undefined;
  const contextGroup = context?.group;
  const chosen: string | null | undefined = input.all === true ? undefined : asked !== undefined ? asked
    : contextGroup !== undefined && roots.some(item => (item.group ?? null) === contextGroup) ? contextGroup : undefined;
  const fallback = input.all !== true && asked === undefined && chosen === undefined;
  const picked = roots.filter(item => chosen === undefined || (item.group ?? null) === chosen);
  const size = (item: TodoItem): number => 1 + liveChildren(view.live, item.id).filter(child => !hidden.has(child.id)).reduce((count, child) => count + size(child), 0);
  const shownRoots: TodoItem[] = [];
  let total = 0;
  for (const item of picked) {
    const next = size(item);
    if (fallback && shownRoots.length > 0 && total + next > TODO_LIST_ITEMS_MAX) break;
    shownRoots.push(item);
    total += next;
  }
  const omitted = picked.length - shownRoots.length;
  const waiting = liveChildren(view.live, null).filter(item => item.group === undefined && !finished.has(item.id)).length;
  const signals = todoTidySignals(view.live.filter(item => !finished.has(item.id)), shownRoots.filter(item => !finished.has(item.id)), chosen === undefined ? "" : `group:${chosen ?? ""}`);
  const notes = [
    ...(fallback ? [contextGroup !== undefined ? `The context group "${contextGroup}" has no open items, so the open items of every group are shown.` : "This conversation gives no context group, so the open items of every group are shown."] : []),
    ...(omitted > 0 ? [`${omitted} top-level items were left out to keep this short; read one group with group.`] : []),
  ];
  return {
    shown: chosen === undefined ? "all groups" : chosen ?? l10n.t("No group"), ...(input.done === true ? {} : { doneHidden: true }),
    items: shownRoots.map(item => itemView(view, item, false, hidden)),
    ...(notes.length ? { note: notes.join(" ") } : {}),
    ...(Object.values(signals).some(entries => entries.length) || waiting ? { signals: { ...signals, ...(waiting ? { noGroup: waiting } : {}) } } : {}),
  };
}

type AddInput = { readonly title?: string; readonly group?: string; readonly children?: readonly AddInput[] };

function addNodeOf(input: Record<string, unknown>, sessionId: string | undefined, placedFrom: string | undefined): TodoAddNode {
  const value = input as Record<string, never>;
  return { title: value.title, group: value.group, due: value.due, start: value.start, priority: value.priority,
    ...(value.new_group === true ? { newGroup: true } : {}), ...(placedFrom ? { placedFrom } : {}), ...(value.case_words !== undefined ? { caseWords: value.case_words } : {}), ...(value.basis !== undefined ? { basis: value.basis } : {}), ...(value.imported === true ? { imported: true } : {}),
    ...(sessionId ? { sourceSession: sessionId } : {}), ...(value.due_reason !== undefined ? { dueReason: value.due_reason } : {}), ...(value.priority_reason !== undefined ? { priorityReason: value.priority_reason } : {}),
    ...(Array.isArray(input.children) ? { children: (input.children as Record<string, unknown>[]).map(child => addNodeOf(child, sessionId, placedFrom)) } : {}) };
}

function addInputError(input: Record<string, unknown>): string | undefined {
  const items = input.items as readonly AddInput[] | undefined;
  if (items === undefined) return input.title === undefined ? "Give title for one item, or items for several." : undefined;
  const mixed = ["title", ...TODO_SINGLE_ADD_FIELDS].filter(field => input[field] !== undefined);
  return mixed.length ? `Give either title with its fields, or items with the fields inside each item, not both (${mixed.join(", ")}).` : undefined;
}

function memoInputError(input: Record<string, unknown>): string | undefined {
  const sections = input.sections as Record<string, unknown> | undefined;
  if (sections === undefined) return input.section === undefined || input.text === undefined ? "Give section and text for one section, or sections for several." : undefined;
  if (input.section !== undefined || input.text !== undefined) return "Give either section and text, or sections, not both.";
  return Object.values(sections).some(text => text !== undefined) ? undefined : "sections names no section.";
}

const GROUP_FIELDS: Record<string, readonly string[]> = { create: [], rename: ["to"], delete: [], move: ["position"] };

function groupInputError(input: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(GROUP_FIELDS, input.action as string)) return `Unknown action ${String(input.action)}.`;
  const needed = GROUP_FIELDS[input.action as string];
  const extra = ["to", "position"].filter(field => input[field] !== undefined && !needed.includes(field));
  const missing = needed.filter(field => input[field] === undefined);
  return missing.length ? `${String(input.action)} needs ${missing.join(", ")}.` : extra.length ? `${String(input.action)} takes no ${extra.join(", ")}.` : undefined;
}

function tidyInputError(input: Record<string, unknown>): string | undefined {
  const steps = input.steps as ReadonlyArray<Record<string, unknown>>;
  for (const [index, entry] of steps.entries()) {
    const fields = entry.kind === "move" ? ["parent", "group", "position", "requested"] : entry.kind === "merge" ? ["into", "requested"] : entry.kind === "flatten" ? ["requested"] : entry.kind === "rename" ? ["title"] : entry.kind === "add" ? ["items"] : [];
    const extra = ["parent", "group", "position", "into", "title", "items", "requested"].filter(field => entry[field] !== undefined && !fields.includes(field));
    if (extra.length) return `Step ${index + 1} (${String(entry.kind)}) takes no ${extra.join(", ")}.`;
    if (entry.kind === "move" && entry.parent === undefined) return `Step ${index + 1} (move) needs parent (null = top level).`;
    if (entry.kind === "merge" && entry.into === undefined) return `Step ${index + 1} (merge) needs into.`;
    if (entry.kind === "rename" && entry.title === undefined) return `Step ${index + 1} (rename) needs title.`;
    if (entry.kind === "add" && entry.items === undefined) return `Step ${index + 1} (add) needs items.`;
    if (entry.kind === "move" && entry.group !== undefined && entry.parent !== null) return `Step ${index + 1} (move) takes group only when parent is null.`;
  }
  return undefined;
}

function tidyStepOf(input: Record<string, unknown>): TodoTidyStep {
  const value = input as Record<string, never>;
  switch (value.kind as TodoTidyStep["kind"]) {
    case "move": return { kind: "move", id: value.id, parentId: value.parent ?? null, ...(value.group !== undefined ? { group: value.group } : {}), ...(value.position !== undefined ? { position: value.position } : {}), ...(value.requested === true ? { requested: true } : {}) };
    case "merge": return { kind: "merge", id: value.id, into: value.into, ...(value.requested === true ? { requested: true } : {}) };
    case "flatten": return { kind: "flatten", id: value.id, ...(value.requested === true ? { requested: true } : {}) };
    case "foldDone": return { kind: "foldDone", id: value.id };
    case "rename": return { kind: "rename", id: value.id, title: value.title };
    case "add": return { kind: "add", id: value.id, items: value.items };
  }
}

const groupBelowTop = (nodes: readonly AddInput[], nested: boolean): boolean =>
  nodes.some(node => (nested && typeof node.group === "string" && node.group.trim() !== "") || groupBelowTop(node.children ?? [], true));

function operationOf(kind: Exclude<TodoToolKind, "list">, input: Record<string, unknown>, sessionId: string | undefined, placedFrom: string | undefined, defaultGroup: string | undefined, defaultBasis: TodoPlacementBasis | undefined): TodoOperation {
  const value = input as Record<string, never>;
  const grouped = (node: Record<string, unknown>) => input.parent === undefined && node.group === undefined && defaultGroup !== undefined
    ? { ...node, group: defaultGroup, basis: node.basis ?? defaultBasis } : node;
  switch (kind) {
    case "add": return Array.isArray(input.items)
      ? { kind: "addMany", parentId: value.parent ?? null, items: (input.items as Record<string, unknown>[]).map(node => addNodeOf(grouped(node), sessionId, placedFrom)) }
      : { kind: "add", parentId: value.parent ?? null, position: value.position, ...addNodeOf(grouped({ ...input, children: undefined }), sessionId, placedFrom) };
    case "update": return { kind: "update", id: value.id, title: value.title, group: value.group, due: value.due, start: value.start, priority: value.priority,
      ...(value.new_group === true ? { newGroup: true } : {}), session: sessionId ?? null,
      ...(value.due_reason !== undefined ? { dueReason: value.due_reason } : {}), ...(value.priority_reason !== undefined ? { priorityReason: value.priority_reason } : {}) };
    case "move": return { kind: "move", id: value.id, parentId: value.parent ?? null, position: value.position, session: sessionId ?? null, ...(value.requested === true ? { basis: "requested" } : {}) };
    case "set_state": return { kind: "setState", id: value.id, state: value.state, session: sessionId ?? null };
    case "write_memo": return input.sections !== undefined
      ? { kind: "writeWorkMemos", id: value.id, sections: input.sections as Partial<Record<WorkMemoSection, string>> }
      : { kind: "writeWorkMemo", id: value.id, section: value.section, text: value.text };
    case "delete": return { kind: "delete", id: value.id, session: sessionId ?? null };
    case "group": switch (value.action as string) {
      case "create": return { kind: "groupCreate", name: value.name };
      case "rename": return { kind: "groupRename", name: value.name, to: value.to };
      case "move": return { kind: "groupMove", name: value.name, position: value.position };
      default: return { kind: "groupDelete", name: value.name };
    }
    case "tidy": return { kind: "tidy", steps: (input.steps as Record<string, unknown>[]).map(tidyStepOf) };
  }
}

function failureReply(failure: TodoOperationFailure, document: TodoDocument | undefined): Reply {
  return reply(todoFailureResultText(failure.error, failureText(failure, document), failure.error === "unstable" ? failure.detail?.word : undefined), true);
}

function failureText(failure: TodoOperationFailure, document: TodoDocument | undefined): string {
  const base = OPERATION_ERRORS[failure.error as keyof typeof OPERATION_ERRORS] ?? STORE_ERRORS.io;
  const detail = failure.detail;
  const view = document ? listView(document) : undefined;
  const parts = [
    ...(detail?.step !== undefined ? [`Step ${detail.step + 1}:`] : []),
    ...(detail?.title !== undefined ? [`"${detail.title}":`] : []),
    base,
    ...(failure.error === "unknown-group" && document ? [`Existing groups: ${todoGroupsOf(document).map(entry => entry.name).join(", ") || "none"}.`] : []),
    ...(detail?.near?.length ? [`Close existing group: ${detail.near.join(", ")}.`] : []),
    ...(detail?.itemId !== undefined && view ? [`Existing item: ${view.path(detail.itemId)} (id ${detail.itemId}).`] : []),
  ];
  return parts.join(" ");
}

function operationReply(kind: TodoToolKind, result: TodoOperationResult, input: Record<string, unknown>, document: TodoDocument | undefined): Reply {
  if (!result.ok) return failureReply(result, document);
  const view = listView(result.document);
  const item = view.live.find(entry => entry.id === result.itemId);
  const own = result.changed ? result.document.changes.filter(change => parseTodoChangeId(change.id).revision === result.document.revision && isClaudeOwnChange(change)) : [];
  const many = kind === "add" && Array.isArray(input.items);
  const groupIgnored = many ? groupBelowTop(input.items as readonly AddInput[], input.parent !== undefined)
    : (kind === "add" || kind === "update") && typeof input.group === "string" && input.group.trim() !== "" && item !== undefined && item.parentId !== null;
  const parentId = typeof input.parent === "string" ? input.parent : null;
  const added = own.flatMap(change => change.field === "item" ? view.live.filter(entry => entry.id === change.itemId && entry.parentId === parentId) : []);
  const twinWarning = (entry: TodoItem) => {
    const twin = todoDoneTwin(view.live, entry.id);
    return twin ? { warning: `A done item has the same title: ${view.path(twin.id)} (id ${twin.id}).` } : {};
  };
  const placed = (entry: TodoItem) => ({ path: view.path(entry.id), ...itemView(view, entry, false), ...twinWarning(entry) });
  const repeats = TODO_REPEAT_CHECKED.includes(kind) ? [...new Set(own.map(change => change.itemId))].flatMap(itemId => {
    const entry = view.live.find(candidate => candidate.id === itemId);
    const word = entry ? todoTitleRepeat(view.live, todoTitlePlaceOf(entry)) : undefined;
    return entry && word !== undefined ? [{ id: entry.id, path: view.path(entry.id), word }] : [];
  }) : [];
  const repeatPart = repeats.length ? { repeats, repeatNotice: TODO_REPEAT_FIX } : {};
  const body = kind === "tidy" && !result.changed ? { changed: 0, notice: "Nothing changed: every step was already in place." }
    : kind === "tidy" ? { tidy: result.itemId, steps: (input.steps as unknown[]).length, changed: own.length,
      notice: "Applied as one change. The user sees it on the conversation's ToDo card and can take it all back; tell them in one line what changed.", ...repeatPart }
    : many ? { items: added.map(placed), ...repeatPart }
    : kind === "add" && item ? { id: item.id, ...placed(item), ...repeatPart }
    : kind === "group" ? { ok: true, groups: todoGroupsOf(result.document).map(entry => entry.name) }
    : kind === "delete" ? { ok: true, id: result.itemId, deleted: result.document.changes.filter(change => parseTodoChangeId(change.id).revision === result.document.revision && change.field === "deletedAt").length }
    : { ok: true, id: result.itemId, ...(item ? { path: view.path(item.id), ...((kind === "update" || kind === "move") ? twinWarning(item) : {}) } : {}), ...repeatPart };
  return reply(todoWriteResultText(result.changed ? result.document.revision : null, groupIgnored ? { ...body, notice: TODO_CHILD_GROUP_NOTE } : body));
}

function inputError(kind: TodoToolKind, input: Record<string, unknown>): string | undefined {
  switch (kind) {
    case "add": return addInputError(input);
    case "write_memo": return memoInputError(input);
    case "group": return groupInputError(input);
    case "tidy": return tidyInputError(input);
    default: return undefined;
  }
}

export function createTodoMcpServer(sdk: Pick<typeof Sdk, "createSdkMcpServer" | "tool">, store: TodoStore, gate: LearningRootGate, log: (message: string) => void,
  sessionOf: () => string | undefined = () => undefined, contextOf: () => TodoConversationContext | undefined = () => undefined) {
  const run = async (body: () => Promise<Reply>): Promise<Reply> => {
    try { return await body(); }
    catch (error) {
      log(`[todo] tool call failed: ${String(error instanceof TodoStoreError ? error.detail ?? error : error)}`);
      const code = error instanceof TodoStoreError ? error.code : "io";
      return reply(todoFailureResultText(`store-${code}`, STORE_ERRORS[code]), true);
    }
  };
  const placement = async (kind: TodoToolKind, input: Record<string, unknown>): Promise<{ folder?: string; group?: string; basis?: TodoPlacementBasis; reason?: string }> => {
    if (kind !== "add") return {};
    const document = await store.read();
    const context = contextOf();
    const found = context?.files.length ? todoConversationFolder(todoGroupsOf(document), context.files).folder : undefined;
    const folder = found !== undefined && context && todoBindableFolder(found, { cwd: context.cwd, roots: context.roots ?? [], ...(context.home ? { home: context.home } : {}) }) ? found : undefined;
    const nodes = Array.isArray(input.items) ? input.items as AddInput[] : [input as AddInput];
    if (input.parent !== undefined || nodes.every(node => node.group !== undefined)) return { ...(folder ? { folder } : {}) };
    const live = document.items.filter(item => item.deletedAt === undefined);
    const linked = linkedTodoItem(live, sessionOf());
    const linkedGroup = linked ? todoItemPath(live, linked.id)[0]?.group : undefined;
    const bound = contextView(document, context);
    const group = linkedGroup ?? bound?.group;
    const basis: TodoPlacementBasis = linkedGroup ? "linked" : bound?.groupFrom === "files" ? "files" : "folder";
    return { ...(folder ? { folder } : {}), ...(group ? { group, basis, reason: linkedGroup ? "the group of the item this conversation is linked to" : "the group bound to this conversation's folder" } : {}) };
  };
  return sdk.createSdkMcpServer({ name: TODO_SERVER_NAME, tools: TODO_TOOL_KINDS.map(kind => sdk.tool(kind, TODO_DESCRIPTIONS[kind],
    TODO_INPUTS[kind] as Record<string, z.ZodType>,
    async (input: Record<string, unknown>, extra: unknown) => run(async () => {
      if (kind !== "list" && !gate.consume(extra)) return reply(todoFailureResultText("root-only", TODO_ROOT_ONLY), true);
      const invalid = inputError(kind, input);
      if (invalid !== undefined) return reply(todoFailureResultText("input", invalid), true);
      if (kind !== "list") {
        const place = await placement(kind, input);
        const result = await store.apply(operationOf(kind, input, sessionOf(), place.folder, place.group, place.basis), "claude");
        const reply = operationReply(kind, result, input, result.ok ? undefined : await store.read().catch(() => undefined));
        return place.reason && result.ok ? { ...reply, content: [...reply.content, { type: "text" as const, text: `Items given no group were placed in "${place.group}", ${place.reason}.` }] } : reply;
      }
      const document = await store.read();
      const view = listView(document);
      if (typeof input.id !== "string") {
        const noGroupNames = [l10n.t("No group"), "No group"];
        const names = todoGroupsOf(document).map(entry => entry.name);
        if (typeof input.group === "string" && !names.includes(input.group) && !noGroupNames.includes(input.group)) {
          return reply(todoFailureResultText("unknown-group", `No group is named "${input.group}". Existing groups: ${names.join(", ") || "none"}; ${l10n.t("No group")} holds items without a group.`), true);
        }
        const context = contextView(document, contextOf());
        const aliases = aliasViews(document, view);
        return reply(JSON.stringify({ groups: groupViews(document, view), ...(context || aliases.length ? { context: { ...context, ...(aliases.length ? { aliases } : {}) } } : {}), ...treeView(view, input, context, noGroupNames) }));
      }
      const item = view.live.find(entry => entry.id === input.id);
      return item ? reply(JSON.stringify(itemView(view, item, true))) : reply(todoFailureResultText("not-found", OPERATION_ERRORS["not-found"]), true);
    }))) });
}
