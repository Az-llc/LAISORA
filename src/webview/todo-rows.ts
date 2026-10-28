import type { TodoGuessView, TodoListItem, TodoMarkInfo, TodoTalk } from "../protocol";
import type { TodoCaptured } from "../todo-model";
import { todoFinishedIds, todoGroupOrderOf, todoItemNumbers, todoItemPath, todoScopeIds, type TodoPriority, type TodoState } from "../todo-model";

export { todoGroupOrderOf, todoItemPath } from "../todo-model";

export type TodoDrawerScope = "mine" | "all";

export function todoDrawerScope(linkedItemId: string | undefined, chosen: TodoDrawerScope | undefined): string | undefined {
  return linkedItemId !== undefined && chosen !== "all" ? linkedItemId : undefined;
}

export const TODO_DUE_FILTERS = ["all", "today", "tomorrow", "week", "overdue"] as const;
export type TodoDueFilter = typeof TODO_DUE_FILTERS[number];

export interface TodoDoneFold {
  readonly open: ReadonlySet<string>;
  readonly keep: ReadonlySet<string>;
}

export interface TodoListOptions {
  readonly group: string | null;
  readonly due: TodoDueFilter;
  readonly collapsed: ReadonlySet<string>;
  readonly today: string;
  readonly colors: ReadonlyMap<string, number>;
  readonly scope?: string;
  readonly inline?: TodoInsertSlot;
  readonly emptyGroups?: boolean;
  readonly only?: ReadonlySet<string>;
  readonly foldDone?: TodoDoneFold;
  readonly foldedGroups?: ReadonlySet<string>;
}

export function todoRootGroup(items: readonly Pick<TodoListItem, "id" | "parentId" | "group">[], id: string | null): string | null {
  return id === null ? null : todoItemPath(items, id)[0]?.group ?? null;
}

export function todoGroupEndIndex(siblings: readonly Pick<TodoListItem, "group">[], group: string | null): number {
  const last = siblings.map(item => (item.group ?? null) === group).lastIndexOf(true);
  return last < 0 ? -1 : last + 1;
}

export const todoSiblingKey = (parentId: string | null, group: string | null) => parentId ?? `group:${JSON.stringify(group)}`;
export const todoSectionKey = (group: string | null) => JSON.stringify(group);

export interface TodoFoldMark {
  readonly at: number;
  readonly depth: number;
  readonly key: string;
  readonly count: number;
}

export interface TodoInsertSlot {
  readonly parentId: string | null;
  readonly group: string | null;
  readonly before: string | null;
}

export interface TodoInlinePlacement {
  readonly family: number;
  readonly row: number | null;
  readonly depth: number;
}

export interface TodoRowView {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly number: string;
  readonly title: string;
  readonly state: TodoState;
  readonly due?: string;
  readonly start?: string;
  readonly priority?: TodoPriority;
  readonly guess?: TodoGuessView;
  readonly held: boolean;
  readonly talk?: TodoTalk;
  readonly claude?: readonly TodoMarkInfo[];
  readonly captured?: TodoCaptured;
  readonly color: number | null;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly context: boolean;
  readonly children?: { readonly done: number; readonly total: number };
}

export interface TodoFamilyView {
  readonly doing: boolean;
  readonly color: number | null;
  readonly rows: readonly TodoRowView[];
  readonly folds: readonly TodoFoldMark[];
}

export interface TodoSectionView {
  readonly group: string | null;
  readonly key: string;
  readonly color: number | null;
  readonly count: number;
  readonly open: number;
  readonly ids: readonly string[];
  readonly folded: boolean;
  readonly families: readonly TodoFamilyView[];
  readonly doneFold?: { readonly key: string; readonly count: number };
  readonly inline?: TodoInlinePlacement;
}

export interface TodoListView {
  readonly groups: ReadonlyArray<{ readonly name: string; readonly color: number | null }>;
  readonly group: string | null;
  readonly headed: boolean;
  readonly total: number;
  readonly open: number;
  readonly sections: readonly TodoSectionView[];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function dateOfKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysKey(key: string, days: number): string {
  const date = dateOfKey(key);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

export function weekEndKey(today: string): string {
  return addDaysKey(today, (7 - dateOfKey(today).getDay()) % 7);
}

export function msUntilNextLocalDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function dueMatcher(filter: TodoDueFilter, today: string): (item: Pick<TodoListItem, "state" | "due" | "start">) => boolean {
  if (filter === "all") return () => true;
  const tomorrow = addDaysKey(today, 1);
  const weekEnd = weekEndKey(today);
  const on = (item: Pick<TodoListItem, "due" | "start">, test: (key: string) => boolean) => [item.due, item.start].some(key => key !== undefined && test(key));
  return item => {
    if (item.state === "done") return false;
    switch (filter) {
      case "overdue": return item.due !== undefined && item.due < today;
      case "today": return on(item, key => key === today);
      case "tomorrow": return on(item, key => key === tomorrow);
      case "week": return on(item, key => key >= today && key <= weekEnd);
    }
  };
}

export function dueMatches(item: Pick<TodoListItem, "state" | "due" | "start">, filter: TodoDueFilter, today: string): boolean {
  return dueMatcher(filter, today)(item);
}

export type TodoCountItem = Pick<TodoListItem, "id" | "parentId" | "state" | "completion" | "due" | "start">;

export function todoDueCounts(items: readonly TodoCountItem[], today: string): Record<TodoDueFilter, number> {
  const finished = todoFinishedIds(items);
  const open = items.filter(item => !finished.has(item.id));
  const counts = {} as Record<TodoDueFilter, number>;
  for (const filter of TODO_DUE_FILTERS) counts[filter] = filter === "all" ? open.length : open.filter(dueMatcher(filter, today)).length;
  return counts;
}

export function todoGroupChipCounts(sections: readonly Pick<TodoSectionView, "group" | "open">[]): { readonly all: number; readonly of: (group: string) => number } {
  return {
    all: sections.reduce((sum, section) => sum + section.open, 0),
    of: group => sections.find(section => section.group === group)?.open ?? 0,
  };
}

export function todoOpenCount(items: readonly Pick<TodoListItem, "id" | "parentId" | "state" | "completion">[]): number {
  const finished = todoFinishedIds(items);
  return items.filter(item => !finished.has(item.id)).length;
}

export function todoFinishedCount(items: readonly Pick<TodoListItem, "id" | "parentId" | "state" | "completion">[]): number {
  return items.length - todoOpenCount(items);
}

export function todoDueFilterShown(filter: TodoDueFilter, counts: Record<TodoDueFilter, number>, chosen: TodoDueFilter): boolean {
  return filter !== "overdue" || counts.overdue > 0 || chosen === "overdue";
}

export function todoUniqueGroupName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let index = 2; ; index++) if (!names.has(`${base} ${index}`)) return `${base} ${index}`;
}

export function todoFreshItems(previous: readonly Pick<TodoListItem, "id">[] | null, next: readonly Pick<TodoListItem, "id" | "by">[]): string[] {
  if (previous === null) return [];
  const known = new Set(previous.map(item => item.id));
  return next.filter(item => item.by === "claude" && !known.has(item.id)).map(item => item.id);
}

export function todoNewlyDone(previous: readonly Pick<TodoListItem, "id" | "state">[], next: readonly Pick<TodoListItem, "id" | "state">[]): string[] {
  const before = new Map(previous.map(item => [item.id, item.state]));
  return next.filter(item => item.state === "done" && before.has(item.id) && before.get(item.id) !== "done").map(item => item.id);
}

function placeInline(families: readonly TodoFamilyView[], group: string | null, slot: TodoInsertSlot | undefined): { inline: TodoInlinePlacement } | {} {
  if (!slot) return {};
  if (slot.parentId === null) {
    if (slot.group !== group) return {};
    const at = slot.before === null ? -1 : families.findIndex(family => family.rows[0]?.id === slot.before);
    return { inline: { family: at < 0 ? families.length : at, row: null, depth: 0 } };
  }
  for (let family = 0; family < families.length; family++) {
    const rows = families[family].rows;
    const parent = rows.findIndex(row => row.id === slot.parentId);
    if (parent < 0) continue;
    const depth = rows[parent].depth + 1;
    if (rows[parent].collapsed) return {};
    const before = slot.before === null ? -1 : rows.findIndex((row, index) => index > parent && row.id === slot.before && row.depth === depth);
    if (before >= 0) return { inline: { family, row: before, depth } };
    let end = parent + 1;
    while (end < rows.length && rows[end].depth >= depth) end++;
    return { inline: { family, row: end, depth } };
  }
  return {};
}

export type TodoSlotItem = Pick<TodoListItem, "id" | "parentId" | "group">;

export const todoSiblings = (items: readonly TodoSlotItem[], parentId: string | null, group: string | null | undefined) =>
  items.filter(item => item.parentId === parentId && (parentId !== null || group === undefined || (item.group ?? null) === group));

export function todoInsertPosition(items: readonly TodoSlotItem[], slot: TodoInsertSlot): number | undefined {
  const siblings = todoSiblings(items, slot.parentId, undefined);
  const before = slot.before === null ? -1 : siblings.findIndex(item => item.id === slot.before);
  if (before >= 0) return before;
  if (slot.parentId !== null) return undefined;
  const end = todoGroupEndIndex(siblings, slot.group);
  return end < 0 ? undefined : end;
}

export function todoSlotNear(items: readonly TodoSlotItem[], id: string, where: "above" | "below"): TodoInsertSlot | undefined {
  const item = items.find(entry => entry.id === id);
  if (!item) return undefined;
  const siblings = todoSiblings(items, item.parentId, undefined);
  const next = siblings[siblings.indexOf(item) + 1];
  return { parentId: item.parentId, group: item.parentId === null ? item.group ?? null : null, before: where === "above" ? item.id : next?.id ?? null };
}

export function todoSlotIndent(items: readonly TodoSlotItem[], slot: TodoInsertSlot, direction: 1 | -1): TodoInsertSlot | undefined {
  if (direction === 1) {
    const siblings = todoSiblings(items, slot.parentId, slot.group);
    const at = slot.before === null ? siblings.length : siblings.findIndex(item => item.id === slot.before);
    const above = siblings[(at < 0 ? siblings.length : at) - 1];
    return above ? { parentId: above.id, group: null, before: null } : undefined;
  }
  const parent = slot.parentId === null ? undefined : items.find(item => item.id === slot.parentId);
  if (!parent) return undefined;
  const siblings = todoSiblings(items, parent.parentId, undefined);
  const after = siblings[siblings.indexOf(parent) + 1];
  return { parentId: parent.parentId, group: parent.parentId === null ? parent.group ?? null : null, before: after?.id ?? null };
}

export function deriveTodoList(items: readonly TodoListItem[], options: TodoListOptions): TodoListView {
  const byId = new Map(items.map(item => [item.id, item]));
  const parentOf = (item: TodoListItem) => item.parentId !== null && byId.has(item.parentId) ? item.parentId : null;
  const children = new Map<string | null, TodoListItem[]>();
  for (const item of items) {
    const parent = parentOf(item);
    let list = children.get(parent);
    if (!list) children.set(parent, list = []);
    list.push(item);
  }
  const finished = todoFinishedIds(items);
  const roots = children.get(null) ?? [];
  const rootsByGroup = new Map<string | null, TodoListItem[]>();
  for (const root of roots) {
    const key = root.group ?? null;
    let list = rootsByGroup.get(key);
    if (!list) rootsByGroup.set(key, list = []);
    list.push(root);
  }
  const sectionKeys = todoGroupOrderOf(roots.map(root => root.group), options.colors.keys());
  const knownGroups = sectionKeys.filter((key): key is string => key !== null);
  const numbers = todoItemNumbers(items, options.colors.keys());
  const colorOf = (group: string | undefined) => group === undefined ? null : options.colors.get(group) ?? null;

  const filtering = options.due !== "all" || options.only !== undefined;
  const scope = options.scope === undefined ? undefined : todoScopeIds(items, options.scope);
  const restricted = filtering || scope !== undefined;
  const keep = new Set<string>();
  const hits = new Set<string>();
  if (restricted) {
    const matches = dueMatcher(options.due, options.today);
    for (const item of items) {
      if ((scope && !scope.has(item.id)) || (options.due !== "all" && finished.has(item.id)) || !matches(item) || (options.only && !options.only.has(item.id))) continue;
      hits.add(item.id);
      for (let at: TodoListItem | undefined = item; at && !keep.has(at.id); at = byId.get(parentOf(at) ?? "")) keep.add(at.id);
    }
  }
  const fold = restricted ? undefined : options.foldDone;
  const shownOf = (list: readonly TodoListItem[], key: string): { shown: Set<TodoListItem>; hidden: number } => {
    if (!fold || fold.open.has(key)) return { shown: new Set(list), hidden: 0 };
    const shown = new Set(list.filter(item => item.state !== "done" || fold.keep.has(item.id)));
    return { shown, hidden: list.length - shown.size };
  };

  const visited = new Set<string>();
  const familyOf = (root: TodoListItem, rootColor: number | null): TodoFamilyView => {
    const rows: TodoRowView[] = [];
    const folds: TodoFoldMark[] = [];
    const visit = (item: TodoListItem, depth: number, inherited: number | null) => {
      if (visited.has(item.id) || (restricted && !keep.has(item.id))) return;
      visited.add(item.id);
      const kids = children.get(item.id) ?? [];
      const collapsible = !filtering && kids.length > 0 && (scope === undefined || scope.has(item.id));
      const collapsed = collapsible && options.collapsed.has(item.id);
      const color = item.group !== undefined ? colorOf(item.group) : inherited;
      rows.push({
        id: item.id, parentId: parentOf(item), depth, number: numbers.get(item.id) ?? "", title: item.title, state: item.state,
        ...(item.due !== undefined ? { due: item.due } : {}), ...(item.start !== undefined ? { start: item.start } : {}),
        ...(item.priority !== undefined ? { priority: item.priority } : {}), ...(item.guess !== undefined ? { guess: item.guess } : {}),
        held: item.state !== "done" && finished.has(item.id),
        ...(item.talk !== undefined ? { talk: item.talk } : {}), ...(item.markInfo?.length ? { claude: item.markInfo } : {}), ...(item.captured !== undefined ? { captured: item.captured } : {}),
        color, collapsible, collapsed, context: restricted && !hits.has(item.id),
        ...(depth === 0 && kids.length > 0 ? { children: { done: kids.filter(kid => finished.has(kid.id)).length, total: kids.length } } : {}),
      });
      if (collapsed) return;
      const key = todoSiblingKey(item.id, null);
      const { shown, hidden } = shownOf(kids, key);
      for (const kid of kids) if (shown.has(kid)) visit(kid, depth + 1, color);
      if (hidden > 0) folds.push({ at: rows.length, depth: depth + 1, key, count: hidden });
    };
    visit(root, 0, rootColor);
    return { doing: root.state === "doing", color: rootColor, rows, folds };
  };

  const tally = (root: TodoListItem, counted: Set<string>, ids: string[]): { count: number; open: number } => {
    let count = 0, open = 0;
    const stack = [root];
    while (stack.length) {
      const item = stack.pop()!;
      if (counted.has(item.id)) continue;
      counted.add(item.id);
      if (scope === undefined || scope.has(item.id)) {
        count++;
        ids.push(item.id);
        if (!finished.has(item.id)) open++;
      }
      stack.push(...(children.get(item.id) ?? []));
    }
    return { count, open };
  };

  const group = options.group !== null && knownGroups.includes(options.group) ? options.group : null;
  const counted = new Set<string>();
  const sections: TodoSectionView[] = [];
  for (const key of sectionKeys) {
    if (group !== null && key !== group) continue;
    const color = key === null ? null : colorOf(key);
    const sectionRoots = rootsByGroup.get(key) ?? [];
    let count = 0, open = 0;
    const ids: string[] = [];
    for (const root of sectionRoots) {
      const t = tally(root, counted, ids);
      count += t.count;
      open += t.open;
    }
    const doneKey = todoSiblingKey(null, key);
    const { shown, hidden } = shownOf(sectionRoots, doneKey);
    const families = sectionRoots.filter(root => shown.has(root)).map(root => familyOf(root, color)).filter(family => family.rows.length > 0);
    const placed = placeInline(families, key, options.inline);
    const keepEmpty = !restricted && options.emptyGroups === true && key !== null;
    if (families.length === 0 && hidden === 0 && !("inline" in placed) && !keepEmpty) continue;
    const sectionKey = todoSectionKey(key);
    sections.push({ group: key, key: sectionKey, color, count, open, ids, folded: !restricted && options.foldedGroups?.has(sectionKey) === true,
      families, ...(hidden > 0 ? { doneFold: { key: doneKey, count: hidden } } : {}), ...placed });
  }
  const inline = options.inline;
  if (inline && inline.parentId === null && !sections.some(section => section.inline)) {
    sections.push({ group: inline.group, key: todoSectionKey(inline.group), color: inline.group === null ? null : colorOf(inline.group), count: 0, open: 0, ids: [], folded: false,
      families: [], inline: { family: 0, row: null, depth: 0 } });
  }

  return {
    groups: knownGroups.map(name => ({ name, color: colorOf(name) })),
    group,
    headed: knownGroups.length > 0,
    total: scope?.size ?? items.length,
    open: items.filter(item => !finished.has(item.id) && (scope === undefined || scope.has(item.id))).length,
    sections,
  };
}
