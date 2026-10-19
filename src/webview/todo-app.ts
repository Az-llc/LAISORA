import * as l10n from "@vscode/l10n";
import type { HostToWebview, TodoListItem, WebviewToHost } from "../protocol";
import { TodoBriefSheet } from "./todo-brief";
import { TodoDetail, type TodoGroupPlaces } from "./todo-detail";
import { isTextEntryTarget, TODO_NOTICE_MS, TodoEditClient } from "./todo-edit";

export interface TodoAppSource {
  items(): readonly TodoListItem[];
  numberOf(id: string): string;
  colorOf(id: string): string;
  undoKeysActive(): boolean;
}

export interface TodoAppExtras {
  waiting(id: string): boolean;
  groups(): readonly string[];
  groupPlaces(group: string): TodoGroupPlaces;
}

export type TodoAppMessage = Extract<HostToWebview, { type: "todoEditResult" | "todoDetail" | "todoWork" | "todoImage" }>;

export class TodoApp {
  readonly edits: TodoEditClient;
  readonly detail: TodoDetail;
  readonly brief: TodoBriefSheet;
  extras: TodoAppExtras = { waiting: () => false, groups: () => [], groupPlaces: () => ({ folders: [], aliases: [] }) };
  private readonly listeners = new Set<(notice: string | null) => void>();
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly post: (message: WebviewToHost) => void, private readonly source: TodoAppSource, mount: HTMLElement) {
    this.edits = new TodoEditClient(post, notice => this.notify(notice));
    this.detail = new TodoDetail({
      post,
      edit: edit => this.edits.send(edit),
      notify: notice => this.notify(notice),
      items: () => source.items(),
      numberOf: id => source.numberOf(id),
      colorOf: id => source.colorOf(id),
      openConversation: (id, fresh) => this.openConversation(id, fresh),
      splitChild: id => this.splitChild(id),
      waiting: id => this.extras.waiting(id),
      groups: () => this.extras.groups(),
      groupPlaces: group => this.extras.groupPlaces(group),
    });
    this.brief = new TodoBriefSheet(post);
    this.listeners.add(notice => this.detail.setNotice(notice));
    mount.append(this.detail.root, this.brief.root);
    document.addEventListener("keydown", (e) => this.onKeydown(e));
  }

  onNotice(listener: (notice: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  openConversation(itemId: string, fresh: boolean): void {
    this.post({ type: "todoOpenConversation", itemId, fresh });
  }

  splitChild(id: string): void {
    const item = this.source.items().find(entry => entry.id === id);
    if (!item || item.parentId === null) {
      this.notify(l10n.t("Only a sub-item can be split into a child conversation."));
      return;
    }
    this.detail.hide();
    this.brief.open(id);
  }

  open(id: string): boolean {
    if (!this.source.items().some(item => item.id === id)) return false;
    this.detail.show(id);
    return true;
  }

  receive(message: TodoAppMessage): void {
    if (message.type === "todoEditResult") this.edits.receive(message);
    else if (message.type === "todoDetail") {
      if (this.brief.waitingFor === message.id) this.brief.apply(message);
      this.detail.apply(message);
    }
    else if (message.type === "todoWork") this.detail.applyWork(message);
    else this.detail.applyImage(message);
  }

  notify(notice: string | null): void {
    clearTimeout(this.noticeTimer);
    this.noticeTimer = notice === null ? undefined : setTimeout(() => this.notify(null), TODO_NOTICE_MS);
    for (const listener of this.listeners) listener(notice);
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!(this.source.undoKeysActive() || this.detail.openId !== null) || !(e.ctrlKey || e.metaKey) || e.altKey || isTextEntryTarget(e.target)) return;
    const key = e.key.toLowerCase();
    const redo = key === "y" || (key === "z" && e.shiftKey);
    if (key !== "z" && !redo) return;
    e.preventDefault();
    if (redo) this.edits.redo();
    else this.edits.undo();
  }
}

let app: TodoApp | null = null;

export function initTodoApp(post: (message: WebviewToHost) => void, source: TodoAppSource, mount: HTMLElement = document.body): TodoApp {
  app ??= new TodoApp(post, source, mount);
  return app;
}

export function openTodoDetail(id: string): boolean {
  return app?.open(id) ?? false;
}
