import type { NormalizedEvent } from "../protocol";
import type { AskBlock } from "./ask-parser";

export interface YouItem {
  readonly id: string;
  readonly kind: "approve" | "decide" | "check";
  readonly title: string;
  readonly options?: readonly { readonly label: string; readonly description: string }[];
  readonly steps?: readonly { readonly do: string; readonly look: string }[];
  readonly createdAt: number;
  readonly resolvedAt?: number;
  readonly resolution?: "replied" | "resolved";
  readonly anchor: { readonly id: string; readonly approvalRef?: string };
}

export interface YouItemsReader {
  get(): readonly YouItem[];
  subscribe(listener: () => void): () => void;
}

export interface AskPosition {
  replyId: string;
  offset: number;
  createdAt: number;
  order?: number;
  generation?: number;
}

export function youAnchor(tabId: string, id: string): string {
  return `you-${encodeURIComponent(tabId)}-${encodeURIComponent(id)}`;
}

export function createYouItems(tabId: string) {
  const items = new Map<string, YouItem>();
  const positions = new Map<string, AskPosition>();
  const replies = new Map<string, { at: number; order?: number; generation?: number }>();
  const resolutions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };
  const resolveAsk = (id: string, item: YouItem): YouItem => {
    const position = positions.get(id)!;
    const reply = [...replies.values()].filter((r) =>
      position.order !== undefined && r.order !== undefined && position.generation === r.generation
        ? r.order > position.order
        : position.createdAt > 0 && r.at > position.createdAt
    ).sort((a, b) => a.at - b.at)[0];
    return reply ? { ...item, resolvedAt: reply.at, resolution: "replied" } : item;
  };
  const reply = (id: string, at: number, order?: number, generation?: number): void => {
    replies.set(id, { at, order, generation });
    for (const [key, item] of items) if (positions.has(key)) items.set(key, resolveAsk(key, item));
    notify();
  };
  const reader: YouItemsReader = {
    get: () => [...items.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    reader,
    reply,
    retain(replyId: string, from: number, to: number, ids: ReadonlySet<string>): void {
      let changed = false;
      for (const [id, position] of positions) {
        if (position.replyId === replyId && position.offset >= from && position.offset < to && !ids.has(id)) {
          positions.delete(id);
          items.delete(id);
          changed = true;
        }
      }
      if (changed) notify();
    },
    observe(ev: NormalizedEvent): void {
      if (ev.kind === "approval_request") {
        const id = `approval:${ev.requestId}`;
        const resolvedAt = resolutions.get(ev.requestId);
        items.set(id, {
          id, kind: ev.questions ? "decide" : "approve",
          title: ev.questions?.questions.map((q) => q.question).join(" / ") ?? ev.inputSummary ?? ev.toolName,
          options: ev.questions?.questions.flatMap((q) => q.options.map((o) => ({ label: o.label, description: o.description ?? "" }))),
          createdAt: ev.timestamp, anchor: { id: youAnchor(tabId, id), approvalRef: ev.requestId },
          ...(resolvedAt !== undefined ? { resolvedAt, resolution: "resolved" as const } : {}),
        });
        notify();
      } else if (ev.kind === "approval_resolved") {
        resolutions.set(ev.requestId, ev.timestamp);
        const id = `approval:${ev.requestId}`;
        const item = items.get(id);
        if (item) items.set(id, { ...item, resolvedAt: ev.timestamp, resolution: "resolved" });
        notify();
      } else if (ev.kind === "user_message") {
        reply(`event:${ev.generation}:${ev.seq}`, ev.sentAt ?? ev.timestamp, ev.seq, ev.generation);
      } else if (ev.kind === "replayed_message" && ev.role === "user") {
        reply(ev.uuid ?? `event:${ev.generation}:${ev.seq}`, ev.recordedAt ?? ev.sentAt ?? 0, ev.seq, ev.generation);
      }
    },
    ask(ask: AskBlock, position: AskPosition): string {
      const id = `ask:${position.replyId}:${position.offset}`;
      const previous = positions.get(id);
      if (previous) position = previous;
      positions.set(id, position);
      const item: YouItem = {
        id, kind: ask.kind, title: ask.title, createdAt: position.createdAt,
        anchor: { id: youAnchor(tabId, id) },
        ...(ask.kind === "decide" ? { options: ask.options.map((o) => ({ label: o.label, description: o.effect })) } : { steps: ask.steps }),
      };
      const next = resolveAsk(id, item);
      if (JSON.stringify(items.get(id)) !== JSON.stringify(next)) { items.set(id, next); notify(); }
      return item.anchor.id;
    },
  };
}
