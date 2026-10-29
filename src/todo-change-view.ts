import * as l10n from "@vscode/l10n";
import type { TodoBatchRevert, TodoChangeView } from "./protocol";
import { isClaudeOwnChange, isTodoGroupName, TODO_ACKNOWLEDGE_MAX, todoChangeReverted, parseTodoChangeId, revertBlock, TODO_RECENT_CLAUDE_MS, todoGroupsOf, todoItemNumbers, todoItemPath, todoParentPlace, todoPlaceText, todoRevertUnitBlock, WORK_MEMO_SECTIONS,
  type TodoChange, type TodoChangePlace, type TodoDocument, type TodoItem, type TodoMemoSection, type TodoRevertBlock } from "./todo-model";

export const TODO_CLAUDE_CHANGES_MAX = 200;
const TODO_CHANGE_TEXT_MAX = 400;
const TODO_MEMO_VERSION_TEXT_MAX = 4000;

function recentClaudeChanges(document: TodoDocument): TodoChange[] {
  const since = Date.now() - TODO_RECENT_CLAUDE_MS;
  return document.changes.slice(-TODO_CLAUDE_CHANGES_MAX).filter(change => isClaudeOwnChange(change) && change.at >= since);
}

export const todoRevertView = (block: TodoRevertBlock | null): "ok" | TodoRevertBlock => block ?? "ok";

const unitKey = (change: Pick<TodoChange, "id" | "itemId">) => change.itemId === "" ? change.id : `${parseTodoChangeId(change.id).revision}:${change.itemId}`;

export function todoRevisionUnitOf(document: TodoDocument, change: TodoChange): TodoChange[] {
  const revision = parseTodoChangeId(change.id).revision;
  return change.itemId === "" ? [change]
    : document.changes.filter(entry => entry.itemId === change.itemId && parseTodoChangeId(entry.id).revision === revision && isClaudeOwnChange(entry));
}

export function todoRecentClaudeUnits(document: TodoDocument): TodoChange[][] {
  const units = new Map<string, TodoChange[]>();
  for (const change of recentClaudeChanges(document)) {
    const key = unitKey(change);
    if (!units.has(key)) units.set(key, todoRevisionUnitOf(document, change));
  }
  return [...units.values()];
}

export function todoClaudeRecent(document: TodoDocument): number[] {
  return todoRecentClaudeUnits(document).filter(unit => unit.some(change => !change.field.startsWith("workMemo.") && !todoChangeReverted(document.changes, change)))
    .map(unit => unit[0].at).slice(-TODO_ACKNOWLEDGE_MAX);
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

export const todoClipped = (text: string | null, max: number) => text !== null && text.length > max ? `${text.slice(0, max)}…` : text;

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

export function todoChangeView(document: TodoDocument, change: TodoChange, revert?: TodoRevertBlock | null): TodoChangeView {
  const item = document.items.find(entry => entry.id === change.itemId);
  const block = revert !== undefined ? revert : isClaudeOwnChange(change) ? revertBlock(document, change, "claude") : undefined;
  const max = change.field.startsWith("workMemo.") ? TODO_MEMO_VERSION_TEXT_MAX : TODO_CHANGE_TEXT_MAX;
  const basis = change.basis ?? (item?.placement && item.placement.at === change.at && (change.field === "item" || change.field === "position" || change.field === "group") ? item.placement.basis : undefined);
  return {
    id: change.id, at: change.at, author: change.author, itemId: change.itemId, itemTitle: item?.title ?? "", field: change.field,
    before: todoClipped(changeValue(document, item, change, change.before), max), after: todoClipped(changeValue(document, item, change, change.after), max),
    ...(change.cascade ? { cascade: true as const } : {}),
    ...(block !== undefined ? { revert: todoRevertView(block) } : {}),
    ...(change.acknowledged ? { acknowledged: true as const } : {}),
    ...(basis ? { basis } : {}),
    ...(change.by ? { by: change.by } : {}),
    ...changePlaces(document, item, change),
  };
}

export function todoClaudeChanges(document: TodoDocument): { changes: TodoChangeView[]; batches: TodoBatchRevert[] } {
  const own = document.changes.filter(isClaudeOwnChange).slice(-TODO_CLAUDE_CHANGES_MAX);
  const revisions = new Map<number, TodoChange[]>();
  for (const change of own) revisions.set(parseTodoChangeId(change.id).revision, [...revisions.get(parseTodoChangeId(change.id).revision) ?? [], change]);
  const batches = [...revisions].filter(([, changes]) => changes.length > 1).map(([revision]) => ({ revision, revert: todoRevertView(todoRevertUnitBlock(document, todoRevisionChanges(document, [revision]))) }));
  return { changes: [...own].reverse().map(change => todoChangeView(document, change, todoRevertUnitBlock(document, todoRevisionUnitOf(document, change)))), batches };
}

export function todoRevisionChanges(document: TodoDocument, revisions: readonly number[]): TodoChange[] {
  const wanted = new Set(revisions);
  return document.changes.filter(change => wanted.has(parseTodoChangeId(change.id).revision) && isClaudeOwnChange(change));
}

export interface TodoClaudeChangeUnit {
  readonly revision: number;
  readonly changes: readonly TodoChangeView[];
  readonly revert: "ok" | TodoRevertBlock;
  readonly write?: "ok" | TodoRevertBlock;
}

export function todoClaudeChangeUnits(document: TodoDocument): TodoClaudeChangeUnit[] {
  const { changes, batches } = todoClaudeChanges(document);
  const units = new Map<string, TodoChangeView[]>();
  for (const view of changes) units.set(unitKey(view), [...units.get(unitKey(view)) ?? [], view]);
  return [...units.values()].map(views => {
    const revision = parseTodoChangeId(views[0].id).revision;
    const write = batches.find(batch => batch.revision === revision)?.revert;
    return { revision, changes: [...views].reverse(), revert: views[0].revert ?? "ok", ...(write !== undefined ? { write } : {}) };
  });
}
