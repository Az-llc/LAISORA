import * as l10n from "@vscode/l10n";
import type { TodoEdit, TodoListItem, TodoSessionLinkView, TodoTabItem, WebviewToHost } from "../protocol";
import { todoAgentItemId } from "../todo-model";
import { TODO_STATE_LABELS, todoButton, todoEl as el } from "./todo-edit";
import { todoGroupColor } from "./todo-row-view";
import { todoItemPath } from "./todo-rows";
import { MARKS } from "./marks";

export interface TodoLinkHub {
  enabled(): boolean;
  items(): readonly TodoListItem[];
  tabItem(tabId: string): TodoTabItem | undefined;
  tabsOfItem(itemId: string): string[];
  tabTitle(tabId: string): string | undefined;
  deletedTab(tabId: string): boolean;
  sessionLink(sessionId: string): TodoSessionLinkView | undefined;
  numberOf(id: string): string;
  groupColorOf(name: string | undefined): number | null;
  openDetail(id: string): void;
  splitChild(id: string): void;
  openConversation(id: string): void;
  activateTab(tabId: string): void;
  reveal(id: string): void;
  showTodoTab(): void;
  splitDeclined(id: string): boolean;
  declineSplit(id: string): void;
  edit(edit: TodoEdit): void;
  post(message: WebviewToHost): void;
  onChange(listener: () => void): void;
}

let hub: TodoLinkHub | null = null;

export function initTodoLinks(next: TodoLinkHub): void {
  hub = next;
}

export function todoLinkHub(): TodoLinkHub | null {
  return hub !== null && hub.enabled() ? hub : null;
}

export function todoItemOf(id: string): TodoListItem | undefined {
  return todoLinkHub()?.items().find(item => item.id === id);
}

export function todoItemLabel(item: Pick<TodoListItem, "id" | "title">): string {
  const number = todoLinkHub()?.numberOf(item.id) ?? "";
  return number ? `#${number} ${item.title}` : item.title;
}

export function todoRootOf(id: string): TodoListItem | undefined {
  const items = todoLinkHub()?.items() ?? [];
  return todoItemPath(items, id)[0];
}

export function todoGroupCss(item: TodoListItem | undefined): string {
  const group = item === undefined ? undefined : todoRootOf(item.id)?.group;
  return todoGroupColor(todoLinkHub()?.groupColorOf(group) ?? null);
}

export interface TodoTabMarks {
  readonly color: string;
  readonly child: boolean;
  readonly tooltip: string;
}

function tabLinkedItem(links: TodoLinkHub, tabId: string): TodoListItem | undefined {
  const entry = links.tabItem(tabId);
  return entry === undefined ? undefined : links.items().find(candidate => candidate.id === entry.itemId);
}

export function todoTabMarks(tabId: string, title: string, extras: { readonly runningAgents: number }): TodoTabMarks | null {
  const links = todoLinkHub();
  if (!links) return null;
  const item = tabLinkedItem(links, tabId);
  if (!item) {
    const outside = links.deletedTab(tabId) ? l10n.t("ToDo item: deleted item") : l10n.t("Group: outside ToDo");
    return { color: "", child: false, tooltip: [title, outside].join("\n") };
  }
  const items = links.items();
  const path = todoItemPath(items, item.id);
  const root = path[0];
  const lines = [title, l10n.t("State: {0}", TODO_STATE_LABELS[item.state]()), root.group ? l10n.t("Group: {0}", root.group) : l10n.t("Group: no group")];
  if (item.parentId !== null) {
    lines.push(l10n.t("Parent conversation: {0}", parentConversationTitle(links, root)));
  } else {
    const children = items.filter(candidate => candidate.id !== item.id && candidate.talk !== undefined && todoItemPath(items, candidate.id)[0]?.id === item.id).length;
    lines.push(l10n.t("Subagents running: {0} · Child conversations: {1}", extras.runningAgents, children));
  }
  lines.push(l10n.t("ToDo path: {0}", path.map(step => todoItemLabel(step)).join(` ${MARKS.pathSeparator} `)));
  return { color: todoGroupColor(links.groupColorOf(root.group)), child: item.parentId !== null, tooltip: lines.join("\n") };
}

export function renderTodoCrumbs(container: HTMLElement, tabId: string): void {
  container.replaceChildren();
  const links = todoLinkHub();
  const item = links ? tabLinkedItem(links, tabId) : undefined;
  if (!links || !item) {
    container.hidden = !(links?.deletedTab(tabId) ?? false);
    if (!container.hidden) container.append(el("span", "todo-crumb todo-crumb-deleted", l10n.t("Linked to a deleted ToDo item")));
    return;
  }
  container.hidden = false;
  const path = todoItemPath(links.items(), item.id);
  const root = path[0];
  const dot = el("span", "todo-dot todo-crumb-dot");
  dot.setAttribute("aria-hidden", "true");
  dot.style.setProperty("--todo-gc", todoGroupColor(links.groupColorOf(root.group)));
  container.append(dot, el("span", "todo-crumb-group", root.group ?? l10n.t("No group")));
  const sep = () => { const node = el("span", "todo-crumb-sep", MARKS.pathSeparator); node.setAttribute("aria-hidden", "true"); return node; };
  if (item.parentId !== null) {
    container.append(sep(), todoButton("todo-crumb todo-crumb-up", `↑ ${todoItemLabel(root)}`, () => {
      const parentTab = links.tabsOfItem(root.id)[0];
      if (parentTab !== undefined) links.activateTab(parentTab);
      else links.openConversation(root.id);
    }, l10n.t("Go to the parent conversation's tab")));
  }
  for (const step of item.parentId !== null ? path.slice(1) : path) {
    container.append(sep(), todoButton("todo-crumb", todoItemLabel(step), () => links.openDetail(step.id), l10n.t("Open the details of the ToDo item “{0}”", step.title)));
  }
}

export interface TodoHistoryLink {
  readonly itemId?: string;
  readonly text: string;
  readonly color: string;
  readonly child: boolean;
  readonly parentTitle?: string;
}

export function todoHistoryLink(sessionId: string): TodoHistoryLink | undefined {
  const links = todoLinkHub();
  const link = links?.sessionLink(sessionId);
  if (!links || !link) return undefined;
  if ("deleted" in link) return { text: l10n.t("Deleted item: {0}", link.deleted), color: "", child: false };
  const item = links.items().find(candidate => candidate.id === link.itemId);
  return item ? itemHistoryLink(links, item) : undefined;
}

export function todoTabHistoryLink(tabId: string): TodoHistoryLink | undefined {
  const links = todoLinkHub();
  if (!links) return undefined;
  const item = tabLinkedItem(links, tabId);
  if (item) return itemHistoryLink(links, item);
  return links.deletedTab(tabId) ? { text: l10n.t("Linked to a deleted ToDo item"), color: "", child: false } : undefined;
}

function itemHistoryLink(links: TodoLinkHub, item: TodoListItem): TodoHistoryLink {
  const root = todoItemPath(links.items(), item.id)[0];
  return { itemId: item.id, text: todoItemLabel(item), color: todoGroupColor(links.groupColorOf(root.group)), child: item.parentId !== null,
    ...(item.parentId !== null ? { parentTitle: parentConversationTitle(links, root) } : {}) };
}

export function todoAgentText(text: string): string {
  return todoAgentItemId(text)?.rest ?? text;
}

function parentConversationTitle(links: TodoLinkHub, root: TodoListItem): string {
  const parentTab = links.tabsOfItem(root.id)[0];
  return (parentTab !== undefined ? links.tabTitle(parentTab) : undefined) ?? root.title;
}

export function todoAgentItem(tabId: string, description: string | undefined): { readonly item: TodoListItem; readonly rest: string } | undefined {
  const links = todoLinkHub();
  const marker = todoAgentItemId(description);
  const entry = links?.tabItem(tabId);
  if (!links || !marker || !entry) return undefined;
  const items = links.items();
  const item = items.find(candidate => candidate.id === marker.id);
  if (!item || item.id === entry.itemId || !todoItemPath(items, item.id).some(step => step.id === entry.itemId)) return undefined;
  return { item, rest: marker.rest };
}

export function todoAgentLabel(tabId: string, description: string | undefined, running: boolean): HTMLElement | null {
  const links = todoLinkHub();
  const found = todoAgentItem(tabId, description);
  if (!links || !found) return null;
  const { item } = found;
  const wrap = el("span", "todo-agent-link");
  wrap.style.setProperty("--todo-gc", todoGroupCss(item));
  const open = todoButton("todo-link todo-agent-item", todoItemLabel(item), () => links.openDetail(item.id), l10n.t("Open the details of the ToDo item “{0}”", item.title));
  wrap.append(open);
  if (item.talk !== undefined) {
    wrap.append(todoButton("todo-link", l10n.t("Open the child conversation"), () => links.openConversation(item.id)));
  } else if (running) {
    wrap.append(todoButton("todo-link", l10n.t("Split and open"), () => links.splitChild(item.id), l10n.t("Split this sub-item into its own child conversation")));
  }
  for (const button of Array.from(wrap.querySelectorAll("button"))) button.addEventListener("click", event => { event.stopPropagation(); event.preventDefault(); });
  return wrap;
}
