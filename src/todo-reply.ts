import type { ConversationMessage } from "./conversation-history";
import { parseTodoChangeId, todoToolName, WORK_MEMO_SECTIONS, type TodoDocument } from "./todo-model";

export const TODO_REPLY_EXCERPT_MAX = 300;
export const TODO_REPLY_MEMO_SECTIONS = WORK_MEMO_SECTIONS.filter(section => section !== "next");

export function todoReplyText(messages: readonly Pick<ConversationMessage, "uuid" | "role" | "text">[], uuid: string): string | undefined {
  const text = messages.find(message => message.uuid === uuid && message.role === "assistant")?.text.trim();
  return text ? text : undefined;
}

export function todoReplyExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TODO_REPLY_EXCERPT_MAX ? `${flat.slice(0, TODO_REPLY_EXCERPT_MAX)}…` : flat;
}

export function todoFromReplyInstruction(request: { excerpt: string; linked?: { id: string; title: string }; start: boolean }): string {
  const linked = request.linked
    ? ` This conversation is linked to the item "${request.linked.id}" (“${request.linked.title}”); that is a placement signal, not a required parent.`
    : "";
  return [
    "The user pressed a button on one of your earlier replies in this conversation to put its topic into ToDo. That reply contains:",
    `> ${request.excerpt}`,
    "",
    `1. Add exactly one new ToDo item for the topic of that reply with ${todoToolName("add")}, placed by the tool's usual placement rules for what the topic is.${linked} Add no sub-items.`,
    `2. Write that item's work memo with ${todoToolName("write_memo")} in one call with the sections ${TODO_REPLY_MEMO_SECTIONS.join(", ")}, including how the topic got to where it stands. Write it so that a new conversation that cannot read this conversation can continue the topic from the memo alone.`,
    "3. Then reply in one line naming the item and where it was placed. Do not start working on the topic.",
    ...(request.start ? ["", "After this turn LAISORA opens the item in a new conversation, so add only that one item in this turn."] : []),
  ].join("\n");
}

export function todoItemsAddedInTurn(document: TodoDocument, sessionId: string, sinceRevision: number): string[] {
  const added = new Set(document.changes
    .filter(change => change.author === "claude" && change.field === "item" && change.before === null && parseTodoChangeId(change.id).revision > sinceRevision)
    .map(change => change.itemId));
  const items = document.items.filter(item => added.has(item.id) && item.deletedAt === undefined && item.source?.sessionId === sessionId);
  const ids = new Set(items.map(item => item.id));
  return items.filter(item => item.parentId === null || !ids.has(item.parentId)).map(item => item.id);
}
