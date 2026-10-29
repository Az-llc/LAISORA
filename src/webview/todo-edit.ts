import * as l10n from "@vscode/l10n";
import { TODO_GROUP_MAX, type TodoBatchRevert, type TodoChangeView, type TodoMarkInfo, type TodoDeletedView, type TodoEdit, type TodoEditError, type TodoEditResultMessage, type TodoListItem, type WebviewToHost } from "../protocol";
import { parseTodoChangeId, TODO_LAISORA, type TodoCaptured, type TodoPlacementBasis, TODO_CLAUDE_DEPTH_MAX, TODO_RECENT_CLAUDE_MS, TODO_DELETED_RETENTION_MS, TODO_DOC_TARGET_MAX, TODO_PRIORITIES, TODO_STATES, TODO_TITLE_MAX, WORK_MEMO_SECTIONS, type TodoPriority, type TodoRevertBlock, type TodoState, type WorkMemoSection } from "../todo-model";
import { closeGlyphButton } from "./close-button";
import { isComposingKey } from "./composing";
import { formatDateTime, uiLocale } from "./l10n";
import { addDaysKey, dateOfKey, localDateKey } from "./todo-rows";
import { MARKS } from "./marks";

const SVG_NS = "http://www.w3.org/2000/svg";
const TODO_UNDO_DEPTH = 100;

export const TODO_STATE_LABELS: Record<TodoState, () => string> = {
  todo: () => l10n.t("Not started"),
  doing: () => l10n.t("Doing"),
  done: () => l10n.t("Done"),
};

export const TODO_STATE_KEYS: Readonly<Record<string, TodoState>> = { "1": TODO_STATES[0], "2": TODO_STATES[1], "3": TODO_STATES[2] };

export const TODO_PRIORITY_LABELS: Record<TodoPriority, () => string> = {
  p0: () => l10n.t("Top priority"),
  p1: () => l10n.t("High priority"),
  p2: () => l10n.t("Medium priority"),
  p3: () => l10n.t("Low priority"),
};

export const TODO_MEMO_LABELS: Record<WorkMemoSection, () => string> = {
  current: () => l10n.t("Where it stands"),
  next: () => l10n.t("Next steps"),
  decisions: () => l10n.t("Decided"),
  open: () => l10n.t("Open points"),
  files: () => l10n.t("Files and outputs"),
};

export function todoEl<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const TODO_CONTROLS = "button, input, textarea, select, a[href], label, [contenteditable]:not([contenteditable='false']), [role='button'], [role='menuitem']";

export interface TodoPressTarget {
  closest(selectors: string): unknown;
}

export function todoControlPressed(target: TodoPressTarget | null): boolean {
  return target === null || target.closest(TODO_CONTROLS) !== null;
}

export const todoNewTitlePlaceholder = () => l10n.t("Title of the new item");

export function todoTitleEdit(item: { readonly id: string; readonly title: string }, text: string): Extract<TodoEdit, { kind: "update" }> | null {
  const title = text.trim();
  return title && title !== item.title ? { kind: "update", id: item.id, title } : null;
}

export const ACTIONS_MENU_GLYPH = "☰";

export function todoMenuToggle(className: string, label: string, open: (button: HTMLButtonElement) => void, glyph = ACTIONS_MENU_GLYPH): HTMLButtonElement {
  const button = todoButton(`todo-menu-toggle ${className}`, glyph, () => open(button), label);
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  return button;
}

export function todoButton(className: string, text: string, onPress: () => void, title?: string): HTMLButtonElement {
  const button = todoEl("button", className, text);
  button.type = "button";
  if (title) button.title = title;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onPress();
  });
  return button;
}

export function todoCloseButton(onPress: () => void, title = l10n.t("Close (Esc)")): HTMLButtonElement {
  const button = closeGlyphButton(todoButton("todo-close", "", onPress), title);
  button.setAttribute("aria-keyshortcuts", "Escape");
  return button;
}

export const TODO_NOTICE_MS = 10_000;

export function todoFillNotice(band: HTMLElement, parts: readonly (Node | string)[], close: () => void): void {
  const text = todoEl("span", "todo-notice-text");
  text.append(...parts);
  const button = todoCloseButton(close, l10n.t("Close"));
  button.removeAttribute("aria-keyshortcuts");
  band.replaceChildren(text, button);
  band.hidden = false;
}

export function todoClearNotice(band: HTMLElement, focusOwner: HTMLElement): void {
  if (band.contains(document.activeElement)) focusOwner.focus({ preventScroll: true });
  band.replaceChildren();
  band.hidden = true;
}

export function todoStateIcon(state: TodoState): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "7");
  circle.setAttribute("cy", "7");
  if (state === "todo") {
    circle.setAttribute("r", "5.6");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "1.2");
    svg.append(circle);
  } else if (state === "doing") {
    circle.setAttribute("r", "5.25");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "1.5");
    const half = document.createElementNS(SVG_NS, "path");
    half.setAttribute("d", "M7 1.75a5.25 5.25 0 0 1 0 10.5z");
    half.setAttribute("fill", "currentColor");
    svg.append(circle, half);
  } else {
    circle.setAttribute("r", "6.25");
    circle.setAttribute("fill", "currentColor");
    const check = document.createElementNS(SVG_NS, "path");
    check.setAttribute("class", "todo-check");
    check.setAttribute("d", "M4.2 7.2l2 2 3.6-4");
    check.setAttribute("fill", "none");
    check.setAttribute("stroke-width", "1.6");
    check.setAttribute("stroke-linecap", "round");
    check.setAttribute("stroke-linejoin", "round");
    svg.append(circle, check);
  }
  return svg;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatTodoDay(key: string, style: "short" | "day" | "full" = "short"): string {
  const date = dateOfKey(key);
  if (style === "day") return `${date.getMonth() + 1}/${date.getDate()}`;
  const locale = uiLocale();
  let format = dayFormatters.get(`${locale}:${style}`);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, style === "short" ? { weekday: "short" } : { dateStyle: "full" });
    dayFormatters.set(`${locale}:${style}`, format);
  }
  return style === "short" ? `${date.getMonth() + 1}/${date.getDate()} ${format.format(date)}` : format.format(date);
}

export function todoOverlayTop(): number {
  return Math.max(document.getElementById("topbar")?.getBoundingClientRect().bottom ?? 0, 0);
}

export function readImageAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

export interface TodoMenuInput {
  readonly placeholder?: string;
  readonly action: string;
  readonly preview: (value: string) => string;
  readonly submit: (value: string) => boolean;
}

export interface TodoMenuEntry {
  readonly label: string;
  readonly swatch?: string;
  readonly checked?: boolean;
  readonly run?: () => void;
  readonly children?: readonly TodoMenuEntry[];
  readonly input?: TodoMenuInput;
  readonly section?: string;
  readonly value?: string;
  readonly keys?: string;
  readonly dismiss?: { readonly label: string; readonly run: () => void };
  readonly render?: () => Node;
  readonly separator?: boolean;
}

export interface TodoMenuHandle {
  update(entries: readonly TodoMenuEntry[]): void;
}

export interface TodoMenuOptions {
  readonly filter?: boolean;
  readonly point?: { readonly x: number; readonly y: number };
  readonly title?: string;
  readonly className?: string;
  readonly onClose?: () => void;
}

let closeOpenMenu: (() => void) | null = null;

type MenuLevel = { readonly title: string; readonly entries: readonly TodoMenuEntry[] } | { readonly title: string; readonly input: TodoMenuInput };

function menuLeaves(entries: readonly TodoMenuEntry[], path: string): Array<{ label: string; entry: TodoMenuEntry }> {
  return entries.flatMap(entry => {
    const label = path ? `${path} ${MARKS.pathSeparator} ${entry.label}` : entry.label;
    return entry.children ? menuLeaves(entry.children, label) : [{ label, entry }];
  });
}

export function todoMenuMatches(entries: readonly TodoMenuEntry[], query: string): Array<{ label: string; entry: TodoMenuEntry }> {
  const needle = query.trim().toLowerCase();
  return needle ? menuLeaves(entries, "").filter(leaf => leaf.label.toLowerCase().includes(needle)) : [];
}

export function openTodoMenu(anchor: HTMLElement, entries: readonly TodoMenuEntry[], label: string, options: TodoMenuOptions = {}): TodoMenuHandle {
  closeOpenMenu?.();
  const dismissOf = new WeakMap<HTMLButtonElement, NonNullable<TodoMenuEntry["dismiss"]>>();
  const menu = todoEl("div", "todo-popmenu");
  if (options.className) menu.classList.add(options.className);
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  const stack: MenuLevel[] = [{ title: label, entries }];
  if (options.title) menu.append(todoEl("div", "todo-popmenu-title", options.title));
  const filter = options.filter ? todoEl("input", "todo-popmenu-filter") : null;
  const body = todoEl("div", "todo-popmenu-body");
  if (filter) {
    filter.type = "text";
    filter.spellcheck = false;
    filter.autocomplete = "off";
    filter.placeholder = l10n.t("Type to filter");
    filter.setAttribute("aria-label", l10n.t("Filter the menu"));
    filter.addEventListener("input", () => render(false));
    menu.append(filter);
  }
  menu.append(body);
  const close = (refocus: boolean) => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    anchor.setAttribute("aria-expanded", "false");
    if (closeOpenMenu === closeThis) closeOpenMenu = null;
    if (refocus && anchor.isConnected) anchor.focus();
    options.onClose?.();
  };
  const closeThis = () => close(false);
  const outside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  const buttons = () => Array.from(body.querySelectorAll<HTMLButtonElement>(".todo-popmenu-item"));
  const choose = (entry: TodoMenuEntry) => {
    if (entry.children) {
      stack.push({ title: entry.label, entries: entry.children });
      if (filter) filter.value = "";
      render(true);
    } else if (entry.input) {
      stack.push({ title: entry.label, input: entry.input });
      if (filter) filter.value = "";
      render(true);
    } else {
      close(true);
      entry.run?.();
    }
  };
  const back = () => {
    if (stack.length < 2) return false;
    stack.pop();
    render(true);
    return true;
  };
  const item = (text: string, entry: TodoMenuEntry) => {
    const button = todoEl("button", `todo-popmenu-item${entry.children ? " has-sub" : ""}`);
    button.type = "button";
    const name = todoEl("span", "todo-popmenu-label", entry.render ? undefined : entry.input ? `${text}…` : text);
    if (entry.render) {
      name.append(entry.render());
      button.setAttribute("aria-label", text);
    }
    if (entry.swatch) {
      const dot = todoEl("span", "todo-dot");
      dot.setAttribute("aria-hidden", "true");
      dot.style.setProperty("--todo-gc", entry.swatch);
      name.prepend(dot);
    }
    button.append(name);
    if (entry.value) button.append(todoEl("span", "todo-popmenu-value", entry.value));
    if (entry.keys) {
      button.title = entry.keys.replace("ArrowUp", "↑").replace("ArrowDown", "↓");
      button.setAttribute("aria-keyshortcuts", entry.keys);
    }
    if (entry.children) {
      const sub = todoEl("span", "todo-popmenu-sub", MARKS.submenu);
      sub.setAttribute("aria-hidden", "true");
      button.append(sub);
    }
    button.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemradio");
    if (entry.checked !== undefined) button.setAttribute("aria-checked", entry.checked ? "true" : "false");
    if (entry.children) button.setAttribute("aria-haspopup", "menu");
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      choose(entry);
    });
    if (!entry.dismiss) return button;
    const dismiss = entry.dismiss;
    dismissOf.set(button, dismiss);
    if (!entry.keys) button.setAttribute("aria-keyshortcuts", "Delete");
    const remove = closeGlyphButton(todoEl("button", "todo-popmenu-dismiss"), dismiss.label, dismiss.label);
    remove.type = "button";
    remove.tabIndex = -1;
    remove.setAttribute("aria-hidden", "true");
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      button.focus();
      dismiss.run();
    });
    const row = todoEl("div", "todo-popmenu-row");
    row.setAttribute("role", "none");
    row.append(button, remove);
    return row;
  };
  const place = () => {
    const rect = options.point ? { left: options.point.x, bottom: options.point.y } : anchor.getBoundingClientRect();
    menu.style.top = `${Math.max(4, Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 4))}px`;
    menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 4))}px`;
  };
  const render = (focusFirst: boolean) => {
    body.replaceChildren();
    const level = stack[stack.length - 1];
    const query = filter?.value ?? "";
    if (query.trim() && !("input" in level)) {
      const found = todoMenuMatches("entries" in stack[0] ? stack[0].entries : [], query);
      if (found.length === 0) body.append(todoEl("div", "todo-popmenu-empty", l10n.t("No matching command")));
      for (const leaf of found) body.append(item(leaf.label, leaf.entry));
    } else {
      if (stack.length > 1) {
        const up = todoButton("todo-popmenu-item todo-popmenu-back", `← ${level.title}`, () => back());
        up.setAttribute("role", "menuitem");
        body.append(up);
      }
      if ("input" in level) {
        const input = todoEl("input", "todo-popmenu-input");
        input.type = "text";
        input.spellcheck = false;
        input.placeholder = level.input.placeholder ?? "";
        input.setAttribute("aria-label", level.title);
        const preview = todoEl("div", "todo-popmenu-preview");
        preview.setAttribute("role", "status");
        const submit = () => { if (level.input.submit(input.value)) close(true); };
        input.addEventListener("input", () => { preview.textContent = level.input.preview(input.value); });
        input.addEventListener("keydown", (e) => {
          if (isComposingKey(e)) return;
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); }
        });
        body.append(input, preview, todoButton("todo-popmenu-item", level.input.action, submit));
        place();
        queueMicrotask(() => input.focus());
        return;
      }
      let section: string | undefined;
      for (const entry of level.entries) {
        if (entry.section !== undefined && entry.section !== section) {
          const head = todoEl("div", "todo-popmenu-section", entry.section);
          head.setAttribute("aria-hidden", "true");
          body.append(head);
        }
        section = entry.section;
        if (entry.separator) {
          const rule = todoEl("div", "todo-popmenu-sep");
          rule.setAttribute("role", "separator");
          body.append(rule);
        }
        body.append(item(entry.label, entry));
      }
    }
    place();
    if (focusFirst) {
      const list = buttons();
      (list.find(button => button.getAttribute("aria-checked") === "true" && !button.classList.contains("todo-popmenu-back"))
        ?? list.find(button => !button.classList.contains("todo-popmenu-back")) ?? list[0])?.focus();
    }
  };
  menu.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    const list = buttons();
    const active = document.activeElement as HTMLElement | null;
    const index = list.indexOf(active as HTMLButtonElement);
    const inText = active instanceof HTMLInputElement;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!back()) close(true);
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : list.length - 1;
      list[index < 0 ? (e.key === "ArrowDown" ? 0 : list.length - 1) : (index + step) % list.length]?.focus();
    } else if (e.key === "Delete" && !inText && index >= 0 && dismissOf.has(list[index])) {
      e.preventDefault();
      dismissOf.get(list[index])!.run();
    } else if (e.key === "ArrowRight" && !inText && index >= 0 && list[index].classList.contains("has-sub")) {
      e.preventDefault();
      list[index].click();
    } else if (e.key === "ArrowLeft" && !inText) {
      e.preventDefault();
      back();
    } else if (filter && !inText && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      filter.value += e.key;
      filter.focus();
      render(false);
    }
  });
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  closeOpenMenu = closeThis;
  document.addEventListener("pointerdown", outside, true);
  render(true);
  return {
    update: (next) => {
      if (!menu.isConnected) return;
      if (next.length === 0) { close(true); return; }
      const at = buttons().indexOf(document.activeElement as HTMLButtonElement);
      stack.splice(0, stack.length, { title: label, entries: next });
      render(false);
      if (at >= 0) { const list = buttons(); list[Math.min(at, list.length - 1)]?.focus(); }
    },
  };
}

export function todoSegment<T extends string>(label: string, options: ReadonlyArray<readonly [T, string, string?]>, current: T, choose: (value: T) => void): HTMLElement {
  const group = todoEl("span", "todo-seg");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (const [value, text, title] of options) {
    const button = todoButton(value === current ? "on" : "", text, () => { if (value !== current) choose(value); }, title);
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", value === current ? "true" : "false");
    group.append(button);
  }
  return group;
}

export const todoStateOptions = (): ReadonlyArray<readonly [TodoState, string]> => TODO_STATES.map(state => [state, TODO_STATE_LABELS[state]()] as const);

export const todoPriorityOptions = (): ReadonlyArray<readonly [TodoPriority | "", string, string?]> =>
  [["", l10n.t("None")], ...TODO_PRIORITIES.map(p => [p, p.toUpperCase(), TODO_PRIORITY_LABELS[p]()] as const)];

export function todoDateInput(label: string, value: string | undefined, save: (next: string | null) => void): HTMLInputElement {
  const input = todoEl("input", "todo-date");
  input.type = "date";
  input.value = value ?? "";
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => {
    const next = input.value || null;
    if (next !== (value ?? null)) save(next);
  });
  return input;
}

export function todoSelect(label: string, options: ReadonlyArray<readonly [string, string]>, value: string, choose: (value: string) => void): HTMLSelectElement {
  const select = todoEl("select", "todo-parent-in");
  select.setAttribute("aria-label", label);
  for (const [key, text] of options) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = text;
    select.append(option);
  }
  select.value = value;
  select.addEventListener("change", () => choose(select.value));
  return select;
}

export function todoTextField(label: string, value: string, maxLength: number, placeholder: string, change: (value: string) => void, commit?: (value: string) => void): HTMLInputElement {
  const input = todoEl("input", "todo-group-in");
  input.type = "text";
  input.value = value;
  input.maxLength = maxLength;
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => change(input.value));
  if (commit) {
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (e) => {
      if (isComposingKey(e)) return;
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    });
  }
  return input;
}

const NEW_GROUP = "\u0000new";

export function todoGroupSelect(value: string | undefined, groups: readonly string[], commit: (next: string | null) => void): HTMLElement {
  const wrap = todoEl("span", "todo-group-pick");
  const select = todoEl("select", "todo-group-in");
  select.setAttribute("aria-label", l10n.t("Group"));
  const option = (key: string, text: string) => {
    const node = document.createElement("option");
    node.value = key;
    node.textContent = text;
    select.append(node);
  };
  option("", l10n.t("No group"));
  for (const name of new Set([...groups, ...(value ? [value] : [])])) option(name, name);
  option(NEW_GROUP, l10n.t("＋ New group…"));
  select.value = value ?? "";
  const ask = () => {
    const input = todoEl("input", "todo-group-in");
    input.type = "text";
    input.maxLength = TODO_GROUP_MAX;
    input.spellcheck = false;
    input.placeholder = l10n.t("New group name");
    input.setAttribute("aria-label", l10n.t("New group name"));
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.replaceWith(select);
      select.value = value ?? "";
      if (save && name && name !== value) commit(name);
      else select.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (isComposingKey(e)) return;
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    select.replaceWith(input);
    queueMicrotask(() => input.focus());
  };
  select.addEventListener("change", () => {
    if (select.value === NEW_GROUP) { ask(); return; }
    const next = select.value || null;
    if (next !== (value ?? null)) commit(next);
  });
  wrap.append(select);
  return wrap;
}

const REPEAT_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

function weekdayName(day: number): string {
  return new Intl.DateTimeFormat(uiLocale(), { weekday: "long" }).format(new Date(2026, 9, 4 + day));
}

export function todoRepeatLabel(value: string): string {
  if (value === "daily") return l10n.t("Every day");
  if (value === "monthly-first") return l10n.t("The 1st of every month");
  if (value === "monthly-last") return l10n.t("The last day of every month");
  const weekly = /^weekly-([0-6])$/.exec(value);
  return weekly ? l10n.t("Every week on {0}", weekdayName(Number(weekly[1]))) : value;
}

export const todoRepeatOptions = (): ReadonlyArray<readonly [string, string]> =>
  [["", l10n.t("None")], ["daily", todoRepeatLabel("daily")], ...REPEAT_WEEKDAYS.map(day => [`weekly-${day}`, todoRepeatLabel(`weekly-${day}`)] as const),
    ["monthly-first", todoRepeatLabel("monthly-first")], ["monthly-last", todoRepeatLabel("monthly-last")]];

const DAY_MS = 86_400_000;

export type TodoDueTone = "overdue" | "today" | "tomorrow";

export interface TodoDateLine {
  readonly start?: { readonly text: string; readonly soon: boolean };
  readonly due?: { readonly text: string; readonly tone: TodoDueTone | null };
  readonly text: string;
}

export function todoDateLine(item: { readonly start?: string; readonly due?: string; readonly state: TodoState }, today: string): TodoDateLine | null {
  if (item.start === undefined && item.due === undefined) return null;
  const tomorrow = addDaysKey(today, 1);
  const open = item.state !== "done";
  const soonText = open && item.start === today ? l10n.t("Starts today") : open && item.start === tomorrow ? l10n.t("Starts tomorrow") : null;
  let due: TodoDateLine["due"];
  if (item.due !== undefined) {
    const plain = item.start !== undefined ? formatTodoDay(item.due, "day") : formatTodoDay(item.due);
    if (open && item.due < today) {
      due = { text: `${formatTodoDay(item.due, "day")} · ${l10n.t("{0} days overdue", Math.round((dateOfKey(today).getTime() - dateOfKey(item.due).getTime()) / DAY_MS))}`, tone: "overdue" };
    } else if (open && item.due === today) due = { text: l10n.t("Due today"), tone: "today" };
    else if (open && item.due === tomorrow) due = { text: `${l10n.t("Due tomorrow")} ${formatTodoDay(item.due, "day")}`, tone: "tomorrow" };
    else due = { text: plain, tone: null };
  }
  const start = item.start === undefined ? undefined
    : { text: `${soonText ?? formatTodoDay(item.start, "day")}${soonText !== null && due === undefined ? "" : " →"}`, soon: soonText !== null };
  return { ...(start ? { start } : {}), ...(due ? { due } : {}), text: [start?.text, due?.text].filter(Boolean).join(" ") };
}

export function todoDateEl(item: { readonly start?: string; readonly due?: string; readonly state: TodoState }, today: string, className: string): HTMLElement {
  const node = todoEl("span", className);
  const line = todoDateLine(item, today);
  if (line?.start) node.append(todoEl("span", line.start.soon ? "todo-date-soon" : "todo-date-start", line.start.text));
  if (line?.start && line.due) node.append(document.createTextNode(" "));
  if (line?.due) node.append(todoEl("span", `todo-date-due${line.due.tone ? ` ${line.due.tone}` : ""}`, line.due.text));
  return node;
}

export function todoSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return l10n.t("{0} min", minutes);
  const hours = minutes / 60;
  if (hours < 48) return l10n.t("{0} h", Math.round(hours * 10) / 10);
  return l10n.t("{0} days", Math.round(hours / 24 * 10) / 10);
}

export function todoGuessMark(reason: string): HTMLElement {
  const mark = todoEl("span", "todo-guess", l10n.t("Estimated"));
  mark.title = l10n.t("Estimated by Claude — {0}. Change it to clear this mark.", reason);
  return mark;
}

export function todoPlayText(talk: "linked" | "running" | undefined, subItem = false): { readonly label: string; readonly title: string } {
  if (talk !== undefined) return { label: `${MARKS.start} ${l10n.t("Continue")}`, title: l10n.t("Open the newest conversation of this item") };
  return { label: `${MARKS.start} ${l10n.t("Start")}`, title: subItem ? l10n.t("Start this sub-item in its own child conversation") : l10n.t("Open this item's parent conversation and start") };
}

export function todoPlayButton(talk: "linked" | "running" | undefined, open: () => void, subItem = false): HTMLButtonElement {
  const text = todoPlayText(talk, subItem);
  return todoButton("todo-play", text.label, open, text.title);
}

export function todoTalkMark(talk: "linked" | "running" | undefined, waiting: boolean, dotOnly = false): HTMLElement | null {
  if (talk === undefined && !waiting) return null;
  const label = waiting ? l10n.t("Waiting for your decision") : talk === "running" ? l10n.t("Its conversation is working") : l10n.t("Has a conversation");
  const mark = todoEl("span", `todo-talk ${waiting ? "waiting" : talk}`);
  mark.title = label;
  const dot = todoEl("span", "todo-talk-dot");
  dot.setAttribute("aria-hidden", "true");
  mark.append(dot);
  const word = dotOnly ? "" : waiting ? l10n.t("Waiting") : talk === "running" ? label : "";
  if (word) mark.append(todoEl("span", "todo-talk-word", word));
  else {
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", label);
  }
  return mark;
}

export function todoParentSelect(items: readonly Pick<TodoListItem, "id" | "parentId" | "title">[], numberOf: (id: string) => string,
  current: string | null, exclude: string | null, choose: (parentId: string | null) => void): HTMLSelectElement {
  const children = new Map<string | null, Array<Pick<TodoListItem, "id" | "parentId" | "title">>>();
  for (const entry of items) children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry]);
  const select = todoEl("select", "todo-parent-in");
  select.setAttribute("aria-label", l10n.t("Parent"));
  const top = document.createElement("option");
  top.value = "";
  top.textContent = l10n.t("None (top level)");
  select.append(top);
  const visit = (parentId: string | null, depth: number, seen: Set<string>) => {
    for (const entry of children.get(parentId) ?? []) {
      if (entry.id === exclude || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = `${"　".repeat(depth)}${numberOf(entry.id)} ${entry.title}`;
      select.append(option);
      visit(entry.id, depth + 1, seen);
    }
  };
  visit(null, 0, new Set());
  select.value = current ?? "";
  select.addEventListener("change", () => {
    const parentId = select.value || null;
    if (parentId !== current) choose(parentId);
  });
  return select;
}

export function todoStateMenu(anchor: HTMLElement, current: TodoState, choose: (state: TodoState) => void): void {
  openTodoMenu(anchor, TODO_STATES.map(state => ({
    label: TODO_STATE_LABELS[state](),
    checked: state === current,
    run: () => { if (state !== current) choose(state); },
  })), l10n.t("State"));
}

const ERROR_TEXT: Record<TodoEditError, () => string> = {
  "not-found": () => l10n.t("The item no longer exists."),
  deleted: () => l10n.t("The item was deleted."),
  "invalid-parent": () => l10n.t("The item cannot be moved there."),
  cycle: () => l10n.t("An item cannot be moved under itself or its own sub-items."),
  "empty-title": () => l10n.t("The title is empty."),
  "title-too-long": () => l10n.t("The title is longer than {0} characters; put details in your memo.", TODO_TITLE_MAX),
  "author-not-allowed": () => l10n.t("That field is written by Claude only."),
  "group-exists": () => l10n.t("A group with that name already exists."),
  "invalid-name": () => l10n.t("Enter a name (up to {0} characters).", TODO_GROUP_MAX),
  "too-many": () => l10n.t("Too many items in one change."),
  "too-deep": () => l10n.t("This would put an item deeper than {0} levels.", TODO_CLAUDE_DEPTH_MAX),
  "duplicate-title": () => l10n.t("An item with the same title is already there."),
  "title-state": () => l10n.t("Titles do not carry state markers."),
  "doc-not-found": () => l10n.t("That reference is no longer there."),
  "unknown-group": () => l10n.t("That group does not exist."),
  "near-group": () => l10n.t("A group with a very similar name already exists."),
  "merge-done": () => l10n.t("Done items are not merged away."),
  "not-single-child": () => l10n.t("That item does not have exactly one sub-item."),
  "unstable": () => l10n.t("Claude leaves this item where it is for now (in progress, or recently changed or moved)."),
  "in-use": () => l10n.t("Not reverted: the group still has items."),
  "invalid-doc": () => l10n.t("Enter a web address (http or https) or a file path."),
  "link-too-long": () => l10n.t("The link is longer than {0} characters.", TODO_DOC_TARGET_MAX),
  rejected: () => l10n.t("The change was not accepted."),
  "not-target": () => l10n.t("There is nothing of yours to undo there."),
  unrevertible: () => l10n.t("The earlier version is no longer kept."),
  reverted: () => l10n.t("That change was already reverted."),
  gone: () => l10n.t("The change or its item is no longer kept."),
  superseded: () => l10n.t("Not changed back: the same field was changed again afterwards."),
  disabled: () => l10n.t("ToDo is turned off in Settings."),
  store: () => l10n.t("Could not save to the ToDo list."),
};

export const todoEditErrorText = (error: TodoEditError) => ERROR_TEXT[error]();

export const TODO_REVERT_BLOCK_TEXT: Record<Exclude<TodoRevertBlock, "not-target">, () => string> = {
  unrevertible: () => l10n.t("Earlier version no longer kept"),
  reverted: () => l10n.t("Reverted"),
  gone: () => l10n.t("No longer kept"),
  superseded: () => l10n.t("Changed again afterwards"),
  "in-use": () => l10n.t("The group still has items"),
};

type TodoEditDone = (ok: boolean, changed: boolean) => void;
type Pending = { readonly role: "edit" | "revert" | "undo" | "redo"; readonly timer: ReturnType<typeof setTimeout>; done?: TodoEditDone };
export const TODO_REPLY_WAIT_MS = 20_000;

export class TodoEditClient {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private undoStack: number[] = [];
  private redoStack: number[] = [];

  constructor(private readonly post: (message: WebviewToHost) => void, private readonly notify: (notice: string | null) => void) {}

  send(edit: TodoEdit, done?: TodoEditDone): void {
    this.request(edit, edit.kind === "revertClaude" || edit.kind === "acknowledge" ? "revert" : "edit", done);
  }

  undo(): void {
    const revision = this.undoStack.pop();
    if (revision !== undefined) this.request({ kind: "undo", revision }, "undo");
  }

  redo(): void {
    const revision = this.redoStack.pop();
    if (revision !== undefined) this.request({ kind: "undo", revision }, "redo");
  }

  receive(message: TodoEditResultMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    const done = pending.done;
    pending.done = undefined;
    done?.(message.ok, message.ok && message.changed);
    if (!message.ok) {
      this.notify(todoEditErrorText(message.error));
      return;
    }
    if (message.changed && pending.role !== "revert") {
      if (pending.role === "undo") this.redoStack = [...this.redoStack, message.revision].slice(-TODO_UNDO_DEPTH);
      else this.undoStack = [...this.undoStack, message.revision].slice(-TODO_UNDO_DEPTH);
      if (pending.role === "edit") this.redoStack = [];
    }
    this.notify(message.skipped > 0 ? l10n.t("Some fields were left as they are because they were changed again afterwards.") : null);
  }

  private request(edit: TodoEdit, role: Pending["role"], done?: TodoEditDone): void {
    const requestId = `todo-${++this.seq}`;
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      const done = pending.done;
      pending.done = undefined;
      done?.(false, false);
      this.notify(l10n.t("LAISORA did not answer; the change may not have been saved."));
    }, TODO_REPLY_WAIT_MS);
    this.pending.set(requestId, { role, timer, done });
    this.post({ type: "todoEdit", requestId, edit });
    this.notify(null);
  }
}

const none = () => l10n.t("none");

function changeValueText(field: string, value: string | null): string {
  if (value === null) return none();
  if (field === "repeat") return todoRepeatLabel(value);
  if (field === "estimate") return l10n.t("{0} h", value);
  if (field === "state" && (value === "todo" || value === "doing" || value === "done")) return TODO_STATE_LABELS[value]();
  if (field === "priority" && value in TODO_PRIORITY_LABELS) return value.toUpperCase();
  if ((field === "due" || field === "start") && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatTodoDay(value);
  return value;
}

export const TODO_BASIS_LABELS: Record<TodoPlacementBasis, () => string> = {
  named: () => l10n.t("named in the request"),
  linked: () => l10n.t("from the linked item"),
  files: () => l10n.t("from the files worked on"),
  folder: () => l10n.t("from a bound folder"),
  alias: () => l10n.t("from learned words"),
  inbox: () => l10n.t("no clue, so No group"),
  tidy: () => l10n.t("in a tidy-up"),
  requested: () => l10n.t("on your request"),
};

const TODO_LAISORA_NAME = "LAISORA";

const TODO_CAPTURE_LABELS: Record<TodoCaptured["via"], () => string> = {
  user: () => l10n.t("by you"),
  claude: () => l10n.t("by Claude"),
  import: () => l10n.t("from material"),
  laisora: () => TODO_LAISORA_NAME,
};

export function todoCapturedText(captured: TodoCaptured): string {
  return l10n.t("First written as: {0} ({1}, {2})", captured.text, TODO_CAPTURE_LABELS[captured.via](), formatDateTime(captured.at));
}

export function todoRecentSince(seenAt: number, now: number): number {
  return Math.max(seenAt, now - TODO_RECENT_CLAUDE_MS);
}

export function todoRecentMarks(marks: readonly TodoMarkInfo[], seenAt: number, now: number): TodoMarkInfo[] {
  const since = todoRecentSince(seenAt, now);
  return marks.filter(info => info.at > since);
}

export function todoNextExpiry(times: readonly number[], now: number): number | undefined {
  const later = times.map(at => at + TODO_RECENT_CLAUDE_MS).filter(at => at > now);
  return later.length ? Math.min(...later) : undefined;
}

export function todoChangesText(changes: readonly Pick<TodoChangeView, "field" | "before" | "after">[]): string {
  return changes.map(describeTodoChange).join(" · ");
}

export function todoMarkText(info: TodoMarkInfo): string {
  return l10n.t("Claude: {0} · {1}", todoChangesText(info.parts), formatTodoDay(localDateKey(new Date(info.at))));
}

export function describeTodoChange(change: Pick<TodoChangeView, "field" | "before" | "after"> & { readonly cascade?: true }): string {
  const pair = () => `${changeValueText(change.field, change.before)} → ${changeValueText(change.field, change.after)}`;
  const section = WORK_MEMO_SECTIONS.find(entry => change.field === `workMemo.${entry}`);
  if (section) return l10n.t("Work memo “{0}” rewritten", TODO_MEMO_LABELS[section]());
  switch (change.field) {
    case "item": return l10n.t("Added “{0}”", change.after ?? "");
    case "title": return l10n.t("Title: {0}", pair());
    case "group": return l10n.t("Group: {0}", pair());
    case "due": return l10n.t("Due: {0}", pair());
    case "start": return l10n.t("Start: {0}", pair());
    case "priority": return l10n.t("Priority: {0}", pair());
    case "userMemo": return l10n.t("Your memo changed");
    case "waiting": return l10n.t("Waiting on: {0}", pair());
    case "repeat": return l10n.t("Repeat: {0}", pair());
    case "estimate": return l10n.t("Estimate: {0}", pair());
    case "tags": return l10n.t("Tags: {0}", pair());
    case "docLabel": return l10n.t("Reference name: {0}", pair());
    case "groups":
      if (change.before === null) return l10n.t("Created the group “{0}”", change.after ?? "");
      if (change.after === null) return l10n.t("Deleted the group “{0}”", change.before);
      return change.before !== change.after ? l10n.t("Renamed the group: {0}", pair()) : l10n.t("Changed the group “{0}”", change.after);
    case "templates": return change.after !== null ? l10n.t("Saved the template “{0}”", change.after) : l10n.t("Removed the template “{0}”", change.before ?? "");
    case "groupBindings": return change.cascade ? l10n.t("Learned from your move: {0}", changeValueText(change.field, change.after)) : l10n.t("Bound folders and words: {0}", pair());
    case "unboundFolders": return l10n.t("Folders no longer learned: {0}", changeValueText(change.field, change.after));
    case "state": return change.cascade ? l10n.t("State (automatic): {0}", pair()) : l10n.t("State: {0}", pair());
    case "position": return change.before === null || change.after === null ? l10n.t("Moved") : l10n.t("Moved: {0}", pair());
    case "deletedAt": return change.after !== null ? l10n.t("Deleted") : l10n.t("Restored");
    case "docs": return change.after !== null ? l10n.t("Added reference “{0}”", change.after) : l10n.t("Removed reference “{0}”", change.before ?? "");
  }
  return change.field;
}

export interface TodoChangeRowActions {
  readonly open?: (itemId: string) => void;
  readonly revert: (changeIds: readonly string[]) => void;
  readonly acknowledge?: (changeIds: readonly string[]) => void;
  readonly revertRevision?: (revision: number) => void;
}

export function todoRevertUnit(changes: readonly TodoChangeView[], change: TodoChangeView): TodoChangeView[] {
  if (change.author !== "claude" || change.cascade || change.itemId === "") return [change];
  const revision = parseTodoChangeId(change.id).revision;
  return changes.filter(entry => entry.author === "claude" && !entry.cascade && entry.itemId === change.itemId && parseTodoChangeId(entry.id).revision === revision);
}

export function todoChangeRow(change: TodoChangeView, actions: TodoChangeRowActions, showItem: boolean, unit: readonly TodoChangeView[] = [change]): HTMLLIElement {
  const row = todoEl("li", `todo-change${change.author === "claude" ? " by-claude" : ""}`);
  const ids = unit.map(entry => entry.id);
  row.append(
    todoEl("span", "todo-change-at", formatDateTime(change.at)),
    todoEl("span", "todo-change-who", change.author === "claude" ? "Claude" : change.by === TODO_LAISORA ? TODO_LAISORA_NAME : l10n.t("By you")),
  );
  const what = todoEl("span", "todo-change-what");
  if (showItem) {
    const open = actions.open;
    what.append(open
      ? todoButton("todo-link", change.itemTitle || l10n.t("(deleted item)"), () => open(change.itemId))
      : todoEl("span", "", change.itemTitle));
    what.append(document.createTextNode(" · "));
  }
  what.append(document.createTextNode(todoChangesText(unit)));
  const basis = unit.find(entry => entry.basis)?.basis;
  if (basis) what.append(todoEl("span", "todo-change-basis", TODO_BASIS_LABELS[basis]()));
  row.append(what);
  if (change.revert === "ok") {
    row.append(todoButton("todo-link todo-change-revert", l10n.t("Revert this change"), () => actions.revert(ids),
      l10n.t("Change back only this change by Claude")));
    const acknowledge = actions.acknowledge;
    if (acknowledge && unit.some(entry => !entry.acknowledged)) {
      row.append(todoButton("todo-link todo-change-revert", l10n.t("Mark as checked"), () => acknowledge(ids), l10n.t("Clear the “changed by Claude” mark and keep the change")));
    }
  } else if (change.revert !== undefined && change.revert !== "not-target") {
    row.append(todoEl("span", "todo-change-blocked", TODO_REVERT_BLOCK_TEXT[change.revert]()));
  }
  return row;
}

export function todoClaudeChangesView(changes: readonly TodoChangeView[], batches: readonly TodoBatchRevert[], actions: TodoChangeRowActions): HTMLElement {
  const wrap = todoEl("div", "todo-log-view");
  wrap.append(todoEl("p", "todo-log-lead", l10n.t("Changes Claude made with the ToDo tool. Revert one change at a time; your own undo does not touch them.")));
  if (changes.length === 0) {
    wrap.append(todoEl("p", "todo-note", l10n.t("Claude has not changed the ToDo list yet.")));
    return wrap;
  }
  const list = todoEl("ol", "todo-change-list");
  const revisions = new Map<number, TodoChangeView[]>();
  for (const change of changes) {
    const revision = parseTodoChangeId(change.id).revision;
    revisions.set(revision, [...revisions.get(revision) ?? [], change]);
  }
  const offered = new Set<number>();
  const shown = new Set<string>();
  for (const change of changes) {
    if (shown.has(change.id)) continue;
    const revision = parseTodoChangeId(change.id).revision;
    const together = revisions.get(revision)!;
    const batch = batches.find(entry => entry.revision === revision);
    const revertRevision = actions.revertRevision;
    if (revertRevision && batch?.revert === "ok" && together.length > 1 && !offered.has(revision)) {
      offered.add(revision);
      const head = todoEl("li", "todo-change todo-change-batch");
      head.append(todoEl("span", "todo-change-at", formatDateTime(change.at)), todoEl("span", "todo-change-what", l10n.t("{0} changes in one go", together.length)),
        todoButton("todo-link todo-change-revert", l10n.t("Take all back"), () => revertRevision(revision), l10n.t("Take back every change of this step at once")));
      list.append(head);
    }
    const unit = todoRevertUnit(changes, change);
    for (const entry of unit) shown.add(entry.id);
    list.append(todoChangeRow(change, actions, true, unit));
  }
  wrap.append(list);
  return wrap;
}

export function todoDeletedView(items: readonly TodoDeletedView[], restore: (id: string) => void): HTMLElement {
  const wrap = todoEl("div", "todo-log-view");
  wrap.append(todoEl("p", "todo-log-lead", l10n.t("Deleted items are kept for {0} days and can be restored until then.", Math.round(TODO_DELETED_RETENTION_MS / 86_400_000))));
  if (items.length === 0) {
    wrap.append(todoEl("p", "todo-note", l10n.t("No recently deleted items.")));
    return wrap;
  }
  const list = todoEl("ol", "todo-change-list");
  for (const item of items) {
    const row = todoEl("li", "todo-change todo-deleted");
    const what = todoEl("span", "todo-change-what", item.title);
    if (item.descendants > 0) what.append(todoEl("span", "todo-deleted-meta", l10n.t("{0} sub-items", item.descendants)));
    row.append(
      todoEl("span", "todo-change-at", formatDateTime(item.deletedAt)),
      what,
      todoEl("span", "todo-deleted-meta", l10n.t("Kept until {0}", formatDateTime(item.expiresAt))),
      todoButton("todo-link todo-change-revert", l10n.t("Restore"), () => restore(item.id)),
    );
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}
