import { todoEl as el } from "./todo-edit";
import { todoDropAt, type TodoDrop, type TodoDropRow } from "./todo-organize";

export interface TodoDragHost {
  list(): HTMLElement;
  describe(ids: readonly string[], drop: TodoDrop): string;
  drop(ids: readonly string[], drop: TodoDrop): void;
  end(): void;
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

export function startTodoDrag(host: TodoDragHost, row: HTMLElement, ids: readonly string[], start: PointerEvent): void {
  const handle = start.target as HTMLElement;
  const list = host.list();
  const startDepth = Number(row.dataset.depth ?? 0);
  const moving = new Set(ids);
  const parents = new Map(Array.from(list.querySelectorAll<HTMLElement>(".todo-row[data-id]")).map(node => [node.dataset.id!, node.dataset.parent ?? null]));
  const dragged = (id: string) => {
    const seen = new Set<string>();
    for (let at: string | null = id; at !== null && !seen.has(at); at = parents.get(at) ?? null) {
      if (moving.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const scroller = scrollerOf(list);
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
  const begin = () => {
    active = true;
    list.classList.add("todo-dragging");
    for (const node of Array.from(list.querySelectorAll<HTMLElement>(".todo-row[data-id]"))) if (dragged(node.dataset.id!)) node.classList.add("todo-dragged");
    list.append(line);
  };
  const finish = (dropIt: boolean) => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    if (frame) cancelAnimationFrame(frame);
    if (handle.hasPointerCapture(start.pointerId)) handle.releasePointerCapture(start.pointerId);
    line.remove();
    clearMarks();
    list.classList.remove("todo-dragging");
    for (const node of Array.from(list.querySelectorAll(".todo-dragged"))) node.classList.remove("todo-dragged");
    const dropped = dropIt && active ? current : null;
    active = false;
    host.end();
    if (dropped) host.drop(ids, dropped);
  };
  const move = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (!active && Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < DRAG_START_PX) return;
    if (!active) begin();
    update();
    if (!frame) frame = requestAnimationFrame(scroll);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  handle.setPointerCapture(start.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
