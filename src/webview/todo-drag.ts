import { todoControlPressed, todoEl as el, type TodoPressTarget } from "./todo-edit";
import { todoDropAt, type TodoDrop, type TodoDropRow } from "./todo-organize";

export interface TodoDragHost {
  list(): HTMLElement;
  targets(): readonly string[];
  describe(ids: readonly string[], drop: TodoDrop): string;
  drop(ids: readonly string[], drop: TodoDrop): void;
  begin(): void;
  end(): void;
}

export const TODO_GRIP_CLASS = "todo-grip";

export function todoRowPressDrags(button: number, target: TodoPressTarget | null, pointerType: string): boolean {
  if (button !== 0 || todoControlPressed(target)) return false;
  return pointerType === "mouse" || target!.closest(`.${TODO_GRIP_CLASS}`) !== null;
}

const DRAG_START_PX = 4;
const DEPTH_STEP_PX = 20;
const SCROLL_EDGE_PX = 32;
const SCROLL_STEP_PX = 12;

function scrollerOf(node: HTMLElement): HTMLElement | null {
  for (let at = node.parentElement; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

let running: { readonly pointerId: number; holding(): boolean; abandon(): void } | null = null;

export function startTodoDrag(host: TodoDragHost, rowId: string, start: PointerEvent): void {
  if (running) {
    if (running.pointerId !== start.pointerId && running.holding()) return;
    running.abandon();
  }
  const list = host.list();
  let holder: HTMLElement | null = null;
  let ids: readonly string[] = [];
  let startDepth = 0;
  let moving = new Set<string>();
  let parents = new Map<string, string | null>();
  let scroller: HTMLElement | null = null;
  const dragged = (id: string) => {
    const seen = new Set<string>();
    for (let at: string | null = id; at !== null && !seen.has(at); at = parents.get(at) ?? null) {
      if (moving.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const line = el("div", "todo-drop-line");
  const label = el("span", "todo-drop-label");
  line.append(label);
  let active = false;
  let pointer = { x: start.clientX, y: start.clientY };
  let current: TodoDrop | null = null;
  let frame = 0;

  const clearMarks = () => {
    for (const node of Array.from(list.querySelectorAll(".todo-drop-parent"))) node.classList.remove("todo-drop-parent");
  };
  const update = () => {
    const sections = Array.from(list.querySelectorAll<HTMLElement>(".todo-section"));
    if (sections.length === 0) return;
    const section = sections.find(node => pointer.y <= node.getBoundingClientRect().bottom) ?? sections[sections.length - 1];
    const rows = Array.from(section.querySelectorAll<HTMLElement>(".todo-row[data-id]")).filter(node => !dragged(node.dataset.id!));
    const rects = rows.map(node => node.getBoundingClientRect());
    const index = rects.filter(rect => (rect.top + rect.bottom) / 2 < pointer.y).length;
    const data: TodoDropRow[] = rows.map(node => ({ id: node.dataset.id!, depth: Number(node.dataset.depth ?? 0) }));
    const group = JSON.parse(section.dataset.group ?? "null") as string | null;
    current = todoDropAt(data, index, startDepth + (pointer.x - start.clientX) / DEPTH_STEP_PX, group);
    const listRect = list.getBoundingClientRect();
    const sectionRows = section.querySelector(".todo-rows")?.getBoundingClientRect() ?? section.getBoundingClientRect();
    const y = index < rects.length ? rects[index].top : rects.length ? rects[rects.length - 1].bottom : sectionRows.top;
    line.style.top = `${y - listRect.top}px`;
    line.style.left = `${current.depth === 0 ? 12 : 56 + (current.depth - 1) * DEPTH_STEP_PX}px`;
    label.textContent = host.describe(ids, current);
    clearMarks();
    const parent = current.slot.parentId;
    if (parent !== null) list.querySelector(`.todo-row[data-id="${CSS.escape(parent)}"]`)?.classList.add("todo-drop-parent");
  };
  const scroll = () => {
    frame = 0;
    if (!active || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    const step = pointer.y < rect.top + SCROLL_EDGE_PX ? -SCROLL_STEP_PX : pointer.y > rect.bottom - SCROLL_EDGE_PX ? SCROLL_STEP_PX : 0;
    if (step === 0) return;
    scroller.scrollTop += step;
    update();
    frame = requestAnimationFrame(scroll);
  };
  const begin = (): boolean => {
    const row = list.querySelector<HTMLElement>(`.todo-row[data-id="${CSS.escape(rowId)}"]`);
    if (!row) return false;
    active = true;
    host.begin();
    ids = host.targets();
    startDepth = Number(row.dataset.depth ?? 0);
    moving = new Set(ids);
    parents = new Map(Array.from(list.querySelectorAll<HTMLElement>(".todo-row[data-id]")).map(node => [node.dataset.id!, node.dataset.parent ?? null]));
    scroller = scrollerOf(list);
    holder = row;
    holder.setPointerCapture(start.pointerId);
    list.classList.add("todo-dragging");
    for (const node of Array.from(list.querySelectorAll<HTMLElement>(".todo-row[data-id]"))) if (dragged(node.dataset.id!)) node.classList.add("todo-dragged");
    list.append(line);
    return true;
  };
  const swallowClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const suppressClick = () => {
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
  };
  const finish = (dropIt: boolean, released: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (running === session) running = null;
    if (!active) return;
    if (frame) cancelAnimationFrame(frame);
    if (holder?.hasPointerCapture(start.pointerId)) holder.releasePointerCapture(start.pointerId);
    line.remove();
    clearMarks();
    list.classList.remove("todo-dragging");
    for (const node of Array.from(list.querySelectorAll(".todo-dragged"))) node.classList.remove("todo-dragged");
    const dropped = dropIt ? current : null;
    active = false;
    if (released) suppressClick();
    else window.addEventListener("pointerup", suppressClick, { capture: true, once: true });
    host.end();
    if (dropped) host.drop(ids, dropped);
  };
  const ours = (e: PointerEvent) => e.pointerId === start.pointerId;
  const move = (e: PointerEvent) => {
    if (!ours(e)) return;
    if ((e.buttons & 1) === 0) return finish(false, true);
    pointer = { x: e.clientX, y: e.clientY };
    if (!active && Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < DRAG_START_PX) return;
    if (!active && !begin()) return finish(false, true);
    getSelection()?.removeAllRanges();
    update();
    if (!frame) frame = requestAnimationFrame(scroll);
  };
  const up = (e: PointerEvent) => { if (ours(e)) finish(true, true); };
  const cancel = (e: PointerEvent) => { if (ours(e)) finish(false, true); };
  const key = (e: KeyboardEvent) => {
    if (!active || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    finish(false, false);
  };
  const session = { pointerId: start.pointerId, holding: () => active && holder !== null && holder.hasPointerCapture(start.pointerId), abandon: () => finish(false, true) };
  running = session;
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
