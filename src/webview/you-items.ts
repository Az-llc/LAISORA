import { fallbackOriginalModel, sameModel } from "../protocol";
import type { ModelFallbackState, ModelInfo } from "../protocol";
import type { NormalizedEvent, RestoredApprovalCard } from "../protocol";
import type { AskBlock } from "./ask-parser";

export interface YouItem {
  readonly id: string;
  readonly kind: "approve" | "decide" | "check" | "confirm";
  readonly title: string;
  readonly explanation?: string;
  readonly originalModel?: string;
  readonly options?: readonly { readonly label: string; readonly description: string }[];
  readonly steps?: readonly { readonly do: string; readonly look: string }[];
  readonly createdAt: number;
  readonly resolvedAt?: number;
  readonly resolution?: "replied" | "resolved" | "superseded" | "dismissed" | "historical";
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

function answers(item: YouItem, text: string): boolean {
  return item.kind === "decide" ? text.includes(`${item.title} → `) : text.includes(item.title);
}

function confirmsCompletedCheck(text: string): boolean {
  const report = text.trim();
  return /^(?:直ったのを確認した|直ったのを確認しました|修正を確認した|修正を確認しました|問題ないことを確認した|問題ないことを確認しました)[。.!！]?$/.test(report)
    || /^(?:I (?:verified|confirmed) the fix|The fix is verified)[.!]?$/i.test(report);
}

export type LocateAsk = (replyId: string, offset: number) => { readonly message: string; readonly start: number } | undefined;

export interface AskIdentity { readonly message?: string; readonly content: string }

export interface AskResolutionRecord {
  readonly identity: AskIdentity;
  readonly resolution: "replied" | "superseded";
  readonly at: number;
}

export function encodeAskResolution(record: AskResolutionRecord): string {
  return JSON.stringify({ ...JSON.parse(encodeAskDismissal(record.identity)), r: record.resolution, t: record.at });
}

function decodeAskResolution(entry: string): AskResolutionRecord | undefined {
  try {
    const value = JSON.parse(entry) as { m?: unknown; c?: unknown; r?: unknown; t?: unknown };
    if (typeof value.c !== "string" || (value.r !== "replied" && value.r !== "superseded") || typeof value.t !== "number") return undefined;
    return { identity: typeof value.m === "string" ? { message: value.m, content: value.c } : { content: value.c }, resolution: value.r, at: value.t };
  } catch {
    return undefined;
  }
}

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

export interface SavedAskDismissals {
  readonly tab?: Iterable<string>;
  readonly messages?: Iterable<string>;
  readonly resolvedTab?: Iterable<string>;
  readonly resolvedMessages?: Iterable<string>;
}

export function createYouItems(tabId: string, saved: SavedAskDismissals = {}, locate?: LocateAsk) {
  const items = new Map<string, YouItem>();
  const asks = new Map<string, YouItem>();
  const blocks = new Map<string, AskBlock>();
  const positions = new Map<string, AskPosition>();
  const messageKeys = new Map<string, string>();
  const replies = new Map<string, Ordered & { text: string }>();
  const assistantReplies = new Map<string, Ordered>();
  const resolutions = new Map<string, number>();
  const dismissals: { id?: string; message?: string; content?: string; at: number }[] =
    [...(saved.tab ?? [])].map((entry) => ({ ...decodeAskDismissal(entry), at: 0 }));
  const dismissedMessages = new Set(saved.messages ?? []);
  const savedResolutions = [...(saved.resolvedTab ?? []), ...(saved.resolvedMessages ?? [])]
    .map(decodeAskResolution).filter((entry): entry is AskResolutionRecord => entry !== undefined);
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
  const matchesIdentity = (savedIdentity: AskIdentity, identity: AskIdentity): boolean =>
    savedIdentity.message !== undefined && identity.message !== undefined
      ? savedIdentity.message === identity.message && savedIdentity.content === identity.content
      : savedIdentity.content === identity.content;
  const pendingAt = (id: string, at: Ordered, includeKnownResolution = true): boolean => {
    const position = positions.get(id)!;
    if (!isAfter(orderOf(position), at)) return false;
    const item = asks.get(id)!;
    const dismissal = dismissedAt(id);
    if (dismissal !== undefined && dismissal <= at.at) return false;
    const known = items.get(id);
    if (includeKnownResolution && known?.resolvedAt !== undefined && known.resolvedAt <= at.at && known.resolution !== "historical") return false;
    const identity = identityOf(id);
    if (savedResolutions.some((saved) => matchesIdentity(saved.identity, identity) && saved.at <= at.at)) return false;
    for (const reply of replies.values()) {
      if (isAfter(orderOf(position), reply) && isAfter(reply, at) && answers(item, reply.text)) return false;
    }
    for (const [otherId, other] of positions) {
      if (otherId !== id && other.replyId !== position.replyId && asks.get(otherId)?.title === item.title
        && isAfter(orderOf(position), orderOf(other)) && isAfter(orderOf(other), at)) return false;
    }
    return true;
  };
  const shortCheckAnswer = (id: string, item: YouItem, reply: Ordered & { text: string }): boolean => {
    if (item.kind !== "check" || !confirmsCompletedCheck(reply.text) || !pendingAt(id, reply, false)) return false;
    const position = orderOf(positions.get(id)!);
    for (const other of replies.values()) {
      if (other !== reply && isAfter(position, other) && isAfter(other, reply)) return false;
    }
    for (const otherId of asks.keys()) {
      if (otherId !== id && pendingAt(otherId, reply)) return false;
    }
    for (const other of items.values()) {
      if ((other.kind === "approve" || other.kind === "decide") && other.id.startsWith("approval:")
        && other.resolvedAt === undefined && isAfter({ at: other.createdAt }, reply)) return false;
    }
    const preceding = [...assistantReplies.entries()]
      .filter(([, seen]) => isAfter(seen, reply))
      .sort((a, b) => isAfter(b[1], a[1]) ? -1 : isAfter(a[1], b[1]) ? 1 : 0)[0];
    if (preceding === undefined || (preceding[0] !== positions.get(id)!.replyId
      && !positions.get(id)!.replyId.startsWith(`${preceding[0]}:part:`))) return false;
    return true;
  };
  const resolveAsk = (id: string, item: YouItem): YouItem => {
    const position = orderOf(positions.get(id)!);
    const replyId = positions.get(id)!.replyId;
    const candidates: { at: number; resolution: "replied" | "superseded" | "dismissed" }[] = [];
    for (const reply of replies.values()) {
      if (isAfter(position, reply) && (answers(item, reply.text) || shortCheckAnswer(id, item, reply))) candidates.push({ at: reply.at, resolution: "replied" });
    }
    for (const [otherId, other] of positions) {
      const next = orderOf(other);
      if (otherId !== id && other.replyId !== replyId && asks.get(otherId)?.title === item.title && isAfter(position, next)) {
        candidates.push({ at: next.at, resolution: "superseded" });
      }
    }
    const dismissal = dismissedAt(id);
    if (dismissal !== undefined) candidates.push({ at: dismissal, resolution: "dismissed" });
    const identity = identityOf(id);
    for (const saved of savedResolutions) {
      if (matchesIdentity(saved.identity, identity)) candidates.push({ at: saved.at, resolution: saved.resolution });
    }
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
  const assistantReply = (id: string, at: number, order?: number, generation?: number): void => {
    assistantReplies.set(id, { at, order, generation });
    if (refresh()) notify();
  };
  const reader: YouItemsReader = {
    get: () => [...items.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const restoreApproval = (card: RestoredApprovalCard, createdAt: number): void => {
    const id = `approval:${card.requestId}`;
    const existing = items.get(id);
    if (existing !== undefined && existing.resolution !== "historical") return;
    items.set(id, {
      id, kind: card.questions ? "decide" : "approve",
      title: card.questions?.questions.map((q) => q.question).join(" / ") ?? card.toolName,
      options: card.questions?.questions.flatMap((q) => q.options.map((option) => ({ label: option.label, description: option.description ?? "" }))),
      createdAt, resolvedAt: createdAt, resolution: "historical",
      anchor: { id: youAnchor(tabId, id) },
    });
    notify();
  };
  return {
    reader,
    reply,
    assistantReply,
    restoreApproval,
    fallback(state: ModelFallbackState, title: string): void {
      const ev = state.notice;
      const id = `fallback:${ev.generation}:${ev.seq}`;
      const previous = items.get(id)?.resolvedAt;
      const resolvedAt = state.resolvedAt ?? (state.reopenedAt === undefined ? previous : undefined);
      items.set(id, {
        id, kind: "confirm", title, explanation: ev.explanation ?? undefined,
        originalModel: fallbackOriginalModel(state), createdAt: ev.timestamp,
        anchor: { id: youAnchor(tabId, id) },
        ...(resolvedAt !== undefined ? { resolvedAt, resolution: "resolved" as const } : {}),
      });
      notify();
    },
    appliedModel(model: string, at: number, models: readonly ModelInfo[]): void {
      let changed = false;
      for (const [id, item] of items) {
        if (item.kind === "confirm" && item.resolvedAt === undefined && sameModel(model, item.originalModel, models)) {
          items.set(id, { ...item, resolvedAt: at, resolution: "resolved" });
          changed = true;
        }
      }
      if (changed) notify();
    },
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
      if (ev.kind === "replayed_message" && ev.restoredApproval) {
        restoreApproval(ev.restoredApproval, ev.recordedAt ?? ev.timestamp);
        return;
      }
      if (ev.kind === "approval_request") {
        const id = `approval:${ev.requestId}`;
        const existing = items.get(id);
        if (existing !== undefined && existing.resolution !== "historical") return;
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
      } else if (ev.kind === "replayed_message" && ev.role === "assistant") {
        assistantReply(ev.uuid ?? `event:${ev.generation}:${ev.seq}`, ev.recordedAt ?? ev.timestamp, ev.seq, ev.generation);
      } else if (ev.kind === "assistant_text_delta") {
        assistantReply(ev.turnId, ev.timestamp, ev.seq, ev.generation);
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
    resolutionRecords(): AskResolutionRecord[] {
      const records: AskResolutionRecord[] = [];
      for (const [id, item] of items) {
        if (!asks.has(id) || (item.resolution !== "replied" && item.resolution !== "superseded")) continue;
        records.push({ identity: identityOf(id), resolution: item.resolution, at: item.resolvedAt ?? 0 });
      }
      return records;
    },
    messageOf(anchorId: string): string | undefined {
      for (const [id, item] of asks) if (item.anchor.id === anchorId) return identityOf(id).message;
      return undefined;
    },
  };
}
