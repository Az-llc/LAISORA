import type { NormalizedEvent, RestoredApprovalCard } from "../protocol";
import { AskAnswerTitles, askAnswerChoices, askTextFeatures, bigramSimilarity, normalizeAskText, otherReplyAsksBack, type AskBlock, type AskTextFeatures } from "../ask-parser";

export interface YouItem {
  readonly id: string;
  readonly kind: "approve" | "decide" | "check";
  readonly title: string;
  readonly options?: readonly { readonly label: string; readonly description: string }[];
  readonly steps?: readonly { readonly do: string; readonly look: string }[];
  readonly createdAt: number;
  readonly resolvedAt?: number;
  readonly resolution?: "replied" | "resolved" | "superseded" | "dismissed" | "historical";
  readonly awaitingDetail?: true;
  readonly turn?: string;
  readonly anchor: { readonly id: string; readonly approvalRef?: string };
}

export function isWaitingYouItem(item: YouItem): boolean {
  return item.resolvedAt === undefined;
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
  turn?: string;
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

export const DECIDE_TITLE_SIMILARITY_MIN = 0.9;
export const DECIDE_TITLE_CONTAINMENT_MIN_CHARS = 8;
export const DECIDE_TITLE_CONTAINMENT_MIN_RATIO = 0.6;
export const DECIDE_OPTION_SET_TITLE_SIMILARITY_MIN = 0.5;

interface AskFeatures extends AskTextFeatures {
  readonly kind: AskBlock["kind"];
  readonly title: string;
  readonly options: string;
}

function askFeatures(ask: AskBlock): AskFeatures {
  const options = ask.kind === "decide" ? [...new Set(ask.options.map((option) => normalizeAskText(option.label)))].sort().join("\n") : "";
  return { kind: ask.kind, title: ask.title, ...askTextFeatures(ask.title), options };
}

function similarTitles(a: AskFeatures, b: AskFeatures): boolean {
  const [shorter, longer] = a.normalized.length <= b.normalized.length ? [a, b] : [b, a];
  if (shorter.normalized === "") return false;
  const contained = shorter.normalized.length >= DECIDE_TITLE_CONTAINMENT_MIN_CHARS
    && shorter.normalized.length >= DECIDE_TITLE_CONTAINMENT_MIN_RATIO * longer.normalized.length
    && longer.normalized.includes(shorter.normalized);
  return contained || bigramSimilarity(a, b) >= DECIDE_TITLE_SIMILARITY_MIN;
}

function replaceable(a: AskFeatures, b: AskFeatures): boolean {
  if (a.kind !== b.kind) return false;
  if (a.title === b.title) return true;
  return a.kind === "decide" && (similarTitles(a, b)
    || (a.options !== "" && a.options === b.options && bigramSimilarity(a, b) >= DECIDE_OPTION_SET_TITLE_SIMILARITY_MIN));
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

export function createYouItems(tabId: string, saved: SavedAskDismissals = {}, locate?: LocateAsk, otherChoice?: string) {
  const isDetailRequest = (choice: string): boolean => otherChoice !== undefined && otherReplyAsksBack(choice, otherChoice);
  let titleIndex: AskAnswerTitles | undefined;
  const answerTitles = (): AskAnswerTitles => titleIndex ??= new AskAnswerTitles([...asks.values()].flatMap((ask) => ask.kind === "decide" ? [ask.title] : []));
  const answers = (item: YouItem, text: string): boolean => item.kind !== "decide" || askAnswerChoices(item.title, text, answerTitles()).some((choice) => !isDetailRequest(choice));
  const requestsDetail = (item: YouItem, text: string): boolean => item.kind === "decide" && askAnswerChoices(item.title, text, answerTitles()).some(isDetailRequest);
  const items = new Map<string, YouItem>();
  const asks = new Map<string, YouItem>();
  const positions = new Map<string, AskPosition>();
  const messageKeys = new Map<string, string>();
  const replies = new Map<string, Ordered & { text: string }>();
  const completedChecks = new Map<string, number>();
  const contents = new Map<string, string>();
  const features = new Map<string, AskFeatures>();
  const replaceableWith = new Map<string, Set<string>>();
  const answeredAt = new Map<string, number>();
  const detailAt = new Map<string, number>();
  const unticked = new Map<string, YouItem>();
  const anchors = new Map<string, string>();
  const resolutions = new Map<string, number>();
  const dismissals: { id?: string; message?: string; content?: string; at: number }[] =
    [...(saved.tab ?? [])].map((entry) => ({ ...decodeAskDismissal(entry), at: 0 }));
  const dismissedMessages = new Set(saved.messages ?? []);
  const savedResolutions = new Map<string, AskResolutionRecord[]>();
  for (const entry of [...(saved.resolvedTab ?? []), ...(saved.resolvedMessages ?? [])]) {
    const record = decodeAskResolution(entry);
    if (record === undefined) continue;
    const list = savedResolutions.get(record.identity.content) ?? [];
    list.push(record);
    savedResolutions.set(record.identity.content, list);
  }
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
    const content = contents.get(id)!;
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
  const askIdOf = (anchorId: string): string | undefined => anchors.get(anchorId);
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };
  const orderOf = (position: AskPosition): Ordered => ({ at: position.createdAt, order: position.order, generation: position.generation });
  const replyBetween = (earlier: Ordered, later: Ordered): boolean => {
    for (const reply of replies.values()) if (isAfter(earlier, reply) && isAfter(reply, later)) return true;
    return false;
  };
  const replyTime = (id: string, matches: (item: YouItem, text: string) => boolean): number | undefined => {
    const position = orderOf(positions.get(id)!);
    const item = asks.get(id)!;
    let at: number | undefined;
    for (const reply of replies.values()) {
      if (isAfter(position, reply) && matches(item, reply.text) && (at === undefined || reply.at < at)) at = reply.at;
    }
    return at;
  };
  const track = (id: string): void => {
    for (const [times, matches] of [[answeredAt, answers], [detailAt, requestsDetail]] as const) {
      const at = replyTime(id, matches);
      if (at === undefined) times.delete(id); else times.set(id, at);
    }
  };
  const unlink = (id: string): void => {
    for (const other of replaceableWith.get(id) ?? []) replaceableWith.get(other)?.delete(id);
    replaceableWith.delete(id);
  };
  const link = (id: string): void => {
    unlink(id);
    const position = positions.get(id)!;
    const own = features.get(id)!;
    const linked = new Set<string>();
    for (const [otherId, other] of features) {
      const otherPosition = positions.get(otherId)!;
      if (otherId === id || other.kind !== own.kind || otherPosition.replyId === position.replyId) continue;
      if (!replaceable(own, other)) continue;
      linked.add(otherId);
      replaceableWith.get(otherId)?.add(id);
    }
    replaceableWith.set(id, linked);
  };
  const resolveUnticked = (id: string, item: YouItem): YouItem => {
    const position = orderOf(positions.get(id)!);
    let first: { at: number; resolution: "replied" | "superseded" | "dismissed" } | undefined;
    const consider = (at: number, resolution: "replied" | "superseded" | "dismissed"): void => {
      if (first === undefined || at < first.at) first = { at, resolution };
    };
    const answered = answeredAt.get(id);
    if (answered !== undefined) consider(answered, "replied");
    for (const otherId of replaceableWith.get(id) ?? []) {
      const next = orderOf(positions.get(otherId)!);
      if (isAfter(position, next) && replyBetween(position, next)) consider(next.at, "superseded");
    }
    const dismissal = dismissedAt(id);
    if (dismissal !== undefined) consider(dismissal, "dismissed");
    const identity = identityOf(id);
    for (const saved of savedResolutions.get(identity.content) ?? []) {
      if (saved.identity.message === undefined || identity.message === undefined || saved.identity.message === identity.message) {
        consider(saved.at, saved.resolution);
      }
    }
    return first ? { ...item, resolvedAt: first.at, resolution: first.resolution } : item;
  };
  const refresh = (): boolean => {
    let changed = false;
    for (const [id, item] of asks) {
      const base = resolveUnticked(id, item);
      unticked.set(id, base);
      const completed = completedChecks.get(id);
      const settled = completed !== undefined && (base.resolvedAt === undefined || completed <= base.resolvedAt)
        ? { ...item, resolvedAt: completed, resolution: "replied" as const } : base;
      const next = settled.resolvedAt === undefined && detailAt.has(id) ? { ...settled, awaitingDetail: true as const } : settled;
      const shown = items.get(id);
      if (shown === undefined || shown.title !== next.title || shown.kind !== next.kind || shown.createdAt !== next.createdAt
        || shown.resolvedAt !== next.resolvedAt || shown.resolution !== next.resolution || shown.options !== next.options || shown.steps !== next.steps
        || shown.awaitingDetail !== next.awaitingDetail) {
        items.set(id, next);
        changed = true;
      }
    }
    return changed;
  };
  const reply = (id: string, at: number, order?: number, generation?: number, text = ""): void => {
    const replaced = replies.has(id);
    const entry = { at, order, generation, text };
    replies.set(id, entry);
    for (const [askId, item] of asks) {
      if (replaced) track(askId);
      else if (isAfter(orderOf(positions.get(askId)!), entry)) {
        for (const [times, matches] of [[answeredAt, answers], [detailAt, requestsDetail]] as const) {
          const previous = times.get(askId);
          if (matches(item, text) && (previous === undefined || at < previous)) times.set(askId, at);
        }
      }
    }
    refresh();
    notify();
  };
  const drop = (id: string): void => {
    positions.delete(id);
    messageKeys.delete(id);
    unlink(id);
    anchors.delete(asks.get(id)!.anchor.id);
    asks.delete(id);
    titleIndex = undefined;
    items.delete(id);
    completedChecks.delete(id);
    contents.delete(id);
    features.delete(id);
    answeredAt.delete(id);
    detailAt.delete(id);
    unticked.delete(id);
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
    restoreApproval,
    tick(anchorId: string, ticked: (step: number) => boolean, at = Date.now()): void {
      const id = askIdOf(anchorId);
      if (id === undefined) return;
      const steps = asks.get(id)!.steps;
      if (steps === undefined || steps.length === 0) return;
      if (!steps.every((_, step) => ticked(step))) completedChecks.delete(id);
      else if (!completedChecks.has(id)) completedChecks.set(id, at);
      if (refresh()) notify();
    },
    retain(replyId: string, from: number, to: number, ids: ReadonlySet<string>): void {
      let changed = false;
      for (const [id, position] of positions) {
        if (position.replyId === replyId && position.offset >= from && position.offset < to && !ids.has(id)) {
          drop(id);
          changed = true;
        }
      }
      if (refresh() || changed) notify();
    },
    withdraw(anchorId: string): void {
      const id = askIdOf(anchorId);
      if (id === undefined) return;
      drop(id);
      refresh();
      notify();
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
      }
    },
    ask(ask: AskBlock, position: AskPosition): string {
      const id = `ask:${position.replyId}:${position.offset}`;
      const previous = positions.get(id);
      if (previous) position = previous;
      positions.set(id, position);
      const content = contentKey(ask);
      const known = asks.get(id);
      if (known !== undefined && contents.get(id) === content) {
        if (refresh()) notify();
        return known.anchor.id;
      }
      const item: YouItem = {
        id, kind: ask.kind, title: ask.title, createdAt: position.createdAt, turn: position.turn ?? position.replyId,
        anchor: { id: youAnchor(tabId, id) },
        ...(ask.kind === "decide" ? { options: ask.options.map((o) => ({ label: o.label, description: o.effect })) } : { steps: ask.steps }),
      };
      asks.set(id, item);
      titleIndex = undefined;
      anchors.set(item.anchor.id, id);
      contents.set(id, content);
      features.set(id, askFeatures(ask));
      track(id);
      link(id);
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
    dismissMessages(messages: Iterable<string>): void {
      const before = dismissedMessages.size;
      for (const message of messages) dismissedMessages.add(message);
      if (dismissedMessages.size !== before && refresh()) notify();
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
      for (const [id, item] of unticked) {
        if (item.resolution !== "replied" && item.resolution !== "superseded") continue;
        records.push({ identity: identityOf(id), resolution: item.resolution, at: item.resolvedAt ?? 0 });
      }
      return records;
    },
    messageOf(anchorId: string): string | undefined {
      const id = askIdOf(anchorId);
      return id === undefined ? undefined : identityOf(id).message;
    },
  };
}
