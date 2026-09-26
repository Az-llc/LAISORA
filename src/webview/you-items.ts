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
  readonly resolution?: "replied" | "resolved" | "superseded" | "dismissed";
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

interface Ordered {
  at: number;
  order?: number;
  generation?: number;
}

function isAfter(earlier: Ordered, later: Ordered): boolean {
  return earlier.order !== undefined && later.order !== undefined && earlier.generation === later.generation
    ? later.order > earlier.order
    : earlier.at > 0 && later.at > earlier.at;
}

// R-CNV-39: an ask closes only on its own answer, a later ask with the same title, or dismissal.
function answers(item: YouItem, text: string): boolean {
  return item.kind === "decide" ? text.includes(`${item.title} → `) : text.includes(item.title);
}

// The record uuid that carries the ask and where that record's text starts in the rendered reply.
export type LocateAsk = (replyId: string, offset: number) => { readonly message: string; readonly start: number } | undefined;

// R-CNV-39: the per-render ask ID differs between the live render and the history replay of the same ask,
// and the tab ID changes on window reload, so dismissals are keyed by record uuid + ordinal in that record.
// content is the fallback only when one side has no record identity.
export interface AskIdentity { readonly message?: string; readonly content: string }

export function encodeAskDismissal(identity: AskIdentity): string {
  return JSON.stringify(identity.message === undefined ? { c: identity.content } : { m: identity.message, c: identity.content });
}

function decodeAskDismissal(entry: string): { id?: string; message?: string; content?: string } {
  if (!entry.startsWith("{")) return { id: entry };
  try {
    const value = JSON.parse(entry) as { m?: unknown; c?: unknown };
    if (typeof value.c !== "string") return {};
    return typeof value.m === "string" ? { message: value.m, content: value.c } : { content: value.c };
  } catch {
    return {};
  }
}

function contentKey(ask: AskBlock): string {
  const text = JSON.stringify(ask);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export interface SavedAskDismissals { readonly tab?: Iterable<string>; readonly messages?: Iterable<string> }

export function createYouItems(tabId: string, saved: SavedAskDismissals = {}, locate?: LocateAsk) {
  const items = new Map<string, YouItem>();
  const asks = new Map<string, YouItem>();
  const blocks = new Map<string, AskBlock>();
  const positions = new Map<string, AskPosition>();
  const messageKeys = new Map<string, string>();
  const replies = new Map<string, Ordered & { text: string }>();
  const resolutions = new Map<string, number>();
  const dismissals: { id?: string; message?: string; content?: string; at: number }[] =
    [...(saved.tab ?? [])].map((entry) => ({ ...decodeAskDismissal(entry), at: 0 }));
  const dismissedMessages = new Set(saved.messages ?? []);
  const identityOf = (id: string): AskIdentity => {
    const position = positions.get(id)!;
    let message = messageKeys.get(id);
    if (message === undefined) {
      const located = locate?.(position.replyId, position.offset);
      if (located !== undefined) {
        let ordinal = 0;
        for (const other of positions.values()) {
          if (other.replyId === position.replyId && other.offset >= located.start && other.offset < position.offset) ordinal++;
        }
        message = `${located.message}#${ordinal}`;
        messageKeys.set(id, message);
      }
    }
    const content = contentKey(blocks.get(id)!);
    return message === undefined ? { content } : { message, content };
  };
  const dismissedAt = (id: string): number | undefined => {
    const identity = identityOf(id);
    if (identity.message !== undefined && dismissedMessages.has(identity.message)) return 0;
    let at: number | undefined;
    for (const entry of dismissals) {
      const hit = entry.id === id || (entry.message !== undefined && identity.message !== undefined
        ? entry.message === identity.message
        : entry.content === identity.content);
      if (hit && (at === undefined || entry.at < at)) at = entry.at;
    }
    return at;
  };
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };
  const orderOf = (position: AskPosition): Ordered => ({ at: position.createdAt, order: position.order, generation: position.generation });
  const resolveAsk = (id: string, item: YouItem): YouItem => {
    const position = orderOf(positions.get(id)!);
    const replyId = positions.get(id)!.replyId;
    const candidates: { at: number; resolution: "replied" | "superseded" | "dismissed" }[] = [];
    for (const reply of replies.values()) {
      if (isAfter(position, reply) && answers(item, reply.text)) candidates.push({ at: reply.at, resolution: "replied" });
    }
    for (const [otherId, other] of positions) {
      const next = orderOf(other);
      if (otherId !== id && other.replyId !== replyId && asks.get(otherId)?.title === item.title && isAfter(position, next)) {
        candidates.push({ at: next.at, resolution: "superseded" });
      }
    }
    const dismissal = dismissedAt(id);
    if (dismissal !== undefined) candidates.push({ at: dismissal, resolution: "dismissed" });
    const first = candidates.sort((a, b) => a.at - b.at)[0];
    return first ? { ...item, resolvedAt: first.at, resolution: first.resolution } : item;
  };
  const refresh = (): boolean => {
    let changed = false;
    for (const [id, base] of asks) {
      const next = resolveAsk(id, base);
      if (JSON.stringify(items.get(id)) !== JSON.stringify(next)) { items.set(id, next); changed = true; }
    }
    return changed;
  };
  const reply = (id: string, at: number, order?: number, generation?: number, text = ""): void => {
    replies.set(id, { at, order, generation, text });
    refresh();
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
          messageKeys.delete(id);
          asks.delete(id);
          blocks.delete(id);
          items.delete(id);
          changed = true;
        }
      }
      if (refresh() || changed) notify();
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
        reply(`event:${ev.generation}:${ev.seq}`, ev.sentAt ?? ev.timestamp, ev.seq, ev.generation, ev.text);
      } else if (ev.kind === "replayed_message" && ev.role === "user") {
        reply(ev.uuid ?? `event:${ev.generation}:${ev.seq}`, ev.recordedAt ?? ev.sentAt ?? 0, ev.seq, ev.generation, ev.text);
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
      asks.set(id, item);
      blocks.set(id, ask);
      if (refresh()) notify();
      return item.anchor.id;
    },
    dismiss(id: string): AskIdentity | undefined {
      if (!asks.has(id) || dismissedAt(id) !== undefined) return undefined;
      const identity = identityOf(id);
      dismissals.push({ id, ...identity, at: Date.now() });
      if (refresh()) notify();
      return identity;
    },
    // Call after live records get their uuid. Returns dismissals that only now have a record identity.
    relabel(): AskIdentity[] {
      const upgraded: AskIdentity[] = [];
      for (const entry of dismissals) {
        if (entry.id === undefined || entry.message !== undefined || !asks.has(entry.id)) continue;
        const identity = identityOf(entry.id);
        if (identity.message === undefined) continue;
        entry.message = identity.message;
        upgraded.push(identity);
      }
      if (refresh()) notify();
      return upgraded;
    },
    messageOf(anchorId: string): string | undefined {
      for (const [id, item] of asks) if (item.anchor.id === anchorId) return identityOf(id).message;
      return undefined;
    },
  };
}
