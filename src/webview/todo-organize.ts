import type { TodoListItem } from "../protocol";
import type { TodoBatchStep, TodoState } from "../todo-model";
import { todoScopeIds } from "../todo-model";
import { todoGroupEndIndex, todoGroupOrderOf, todoSiblings, todoSlotIndent, todoSlotNear, type TodoInsertSlot, type TodoSlotItem } from "./todo-rows";

export type TodoOrganizeItem = TodoSlotItem & Pick<TodoListItem, "state">;

export function todoGroupOrder(items: readonly TodoSlotItem[], stored: readonly string[] = []): Array<string | null> {
  const ids = new Set(items.map(item => item.id));
  return todoGroupOrderOf(items.filter(item => item.parentId === null || !ids.has(item.parentId)).map(item => item.group), stored);
}

export function todoVisualOrder(items: readonly TodoSlotItem[], stored: readonly string[] = []): string[] {
  const ids = new Set(items.map(item => item.id));
  const children = new Map<string | null, TodoSlotItem[]>();
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId) ? item.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (item: TodoSlotItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    order.push(item.id);
    for (const child of children.get(item.id) ?? []) visit(child);
  };
  for (const group of todoGroupOrder(items, stored)) for (const root of children.get(null) ?? []) if ((root.group ?? null) === group) visit(root);
  return order;
}

export function todoSelectionRoots(items: readonly TodoSlotItem[], ids: Iterable<string>, stored: readonly string[] = []): string[] {
  const chosen = new Set(ids);
  const byId = new Map(items.map(item => [item.id, item]));
  const covered = (id: string) => {
    const seen = new Set<string>();
    for (let at = byId.get(id)?.parentId ?? null; at !== null && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
      if (chosen.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  return todoVisualOrder(items, stored).filter(id => chosen.has(id) && !covered(id));
}

export function todoMoveSteps(items: readonly TodoSlotItem[], ids: Iterable<string>, slot: TodoInsertSlot, stored: readonly string[] = []): TodoBatchStep[] {
  const roots = todoSelectionRoots(items, ids, stored);
  const moving = new Set(roots.flatMap(id => [...todoScopeIds(items, id)]));
  if (slot.parentId !== null && moving.has(slot.parentId)) return [];
  const staying = todoSiblings(items, slot.parentId, undefined).filter(item => !moving.has(item.id));
  let before: string | null;
  if (slot.before !== null && !moving.has(slot.before)) {
    before = slot.before;
  } else if (slot.before !== null) {
    const all = todoSiblings(items, slot.parentId, undefined);
    const from = all.findIndex(item => item.id === slot.before);
    before = all.slice(from + 1).find(item => !moving.has(item.id))?.id ?? null;
  } else if (slot.parentId === null) {
    const end = todoGroupEndIndex(staying, slot.group);
    before = end < 0 ? null : staying[end]?.id ?? null;
  } else {
    before = null;
  }
  const byId = new Map(items.map(item => [item.id, item]));
  return roots.flatMap(id => {
    const item = byId.get(id)!;
    const steps: TodoBatchStep[] = [{ kind: "move", id, parentId: slot.parentId, before }];
    const group = slot.parentId === null ? slot.group : null;
    if ((item.group ?? null) !== group) steps.push({ kind: "update", id, group });
    return steps;
  });
}

function blockOf(items: readonly TodoSlotItem[], ids: Iterable<string>, stored: readonly string[]): { roots: TodoSlotItem[]; siblings: TodoSlotItem[]; first: number; last: number } | undefined {
  const byId = new Map(items.map(item => [item.id, item]));
  const roots = todoSelectionRoots(items, ids, stored).map(id => byId.get(id)!);
  if (roots.length === 0) return undefined;
  const parentId = roots[0].parentId;
  const group = roots[0].group ?? null;
  if (roots.some(item => item.parentId !== parentId || (parentId === null && (item.group ?? null) !== group))) return undefined;
  const siblings = todoSiblings(items, parentId, parentId === null ? group : undefined);
  const indexes = roots.map(item => siblings.indexOf(item)).sort((a, b) => a - b);
  return { roots, siblings, first: indexes[0], last: indexes[indexes.length - 1] };
}

export function todoStepSlot(items: readonly TodoSlotItem[], ids: Iterable<string>, direction: -1 | 1, stored: readonly string[] = []): TodoInsertSlot | undefined {
  const block = blockOf(items, ids, stored);
  if (!block) return undefined;
  const chosen = new Set(block.roots.map(item => item.id));
  const { siblings, roots } = block;
  const parentId = roots[0].parentId;
  const group = parentId === null ? roots[0].group ?? null : null;
  if (direction === -1) {
    const previous = siblings.slice(0, block.first).reverse().find(item => !chosen.has(item.id));
    if (previous) return { parentId, group, before: previous.id };
  } else {
    const later = siblings.slice(block.last + 1).filter(item => !chosen.has(item.id));
    if (later.length) return { parentId, group, before: later[1]?.id ?? null };
  }
  if (parentId !== null) {
    return todoSlotNear(items, parentId, direction === 1 ? "below" : "above");
  }
  const order = todoGroupOrder(items, stored);
  const neighbour = order[order.indexOf(group) + direction];
  if (neighbour === undefined) return undefined;
  if (direction === -1) return { parentId: null, group: neighbour, before: null };
  const firstRoot = todoSiblings(items, null, neighbour)[0];
  return { parentId: null, group: neighbour, before: firstRoot?.id ?? null };
}

export function todoIndentSlot(items: readonly TodoSlotItem[], ids: Iterable<string>, direction: -1 | 1, stored: readonly string[] = []): TodoInsertSlot | undefined {
  const block = blockOf(items, ids, stored);
  if (!block) return undefined;
  const first = block.roots[0];
  return todoSlotIndent(items, { parentId: first.parentId, group: first.parentId === null ? first.group ?? null : null, before: block.siblings[block.first].id }, direction);
}

export function todoGroupSteps(items: readonly TodoSlotItem[], ids: Iterable<string>, group: string | null, stored: readonly string[] = []): TodoBatchStep[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const roots = todoSelectionRoots(items, ids, stored);
  const nested = roots.filter(id => byId.get(id)!.parentId !== null);
  const steps: TodoBatchStep[] = roots.flatMap(id => byId.get(id)!.parentId === null && (byId.get(id)!.group ?? null) !== group ? [{ kind: "update" as const, id, group }] : []);
  return nested.length ? [...steps, ...todoMoveSteps(items, nested, { parentId: null, group, before: null }, stored)] : steps;
}

export function todoStateSteps(items: readonly TodoOrganizeItem[], ids: Iterable<string>, state: TodoState | "toggle-done", stored: readonly string[] = []): TodoBatchStep[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const roots = todoSelectionRoots(items, ids, stored);
  const target: TodoState = state !== "toggle-done" ? state : roots.every(id => byId.get(id)!.state === "done") ? "todo" : "done";
  return roots.filter(id => byId.get(id)!.state !== target).map(id => ({ kind: "setState", id, state: target }));
}

export interface TodoDropRow {
  readonly id: string;
  readonly depth: number;
}

export interface TodoDrop {
  readonly slot: TodoInsertSlot;
  readonly depth: number;
}

export function todoDropAt(rows: readonly TodoDropRow[], index: number, desiredDepth: number, group: string | null): TodoDrop {
  const at = Math.max(0, Math.min(index, rows.length));
  const previous = rows[at - 1];
  const next = rows[at];
  const max = previous ? previous.depth + 1 : 0;
  const min = next ? Math.min(next.depth, max) : 0;
  const depth = Math.max(min, Math.min(max, Math.round(desiredDepth)));
  const before = next && next.depth === depth ? next.id : null;
  if (depth === 0) return { depth, slot: { parentId: null, group, before } };
  let parentId: string | null = null;
  for (let scan = at - 1; scan >= 0; scan--) {
    if (rows[scan].depth === depth - 1) { parentId = rows[scan].id; break; }
  }
  return { depth, slot: { parentId, group: null, before } };
}
