import type { NormalizedEvent, RestoredApprovalCard } from "../protocol";
import { AskAnswerTitles, askAnswerChoices, askTextFeatures, bigramSimilarity, normalizeAskText, type AskBlock, type AskTextFeatures } from "../ask-parser";
import { decodeAskResolution, type AskIdentity, type AskResolutionRecord, type AskStateKey } from "../ask-mark-edits";

export { askStateLookup, encodeAskDismissal, encodeAskResolution, type AskIdentity, type AskResolutionRecord, type AskStateKey } from "../ask-mark-edits";

export interface YouItem {
  readonly id: string;
  readonly kind: "approve" | "decide" | "check";
  readonly title: string;
  readonly options?: readonly { readonly label: string; readonly description: string }[];
  readonly steps?: readonly { readonly do: string; readonly look: string }[];
  readonly createdAt: number;
  readonly resolvedAt?: number;
  readonly resolution?: "replied" | "resolved" | "superseded" | "dismissed" | "historical";
  readonly turn?: string;
  readonly anchor: { readonly id: string; readonly approvalRef?: string };
}

export function isWaitingYouItem(item: YouItem): boolean {
  return item.resolvedAt === undefined;
}

export const ASK_STALE_LATER_REPLIES = 2;
export const ASK_STALE_MS = 7 * 24 * 60 * 60_000;
export type AskStale = "age" | "moved-on";

export const isDeclaredAsk = (item: YouItem): boolean => item.anchor.approvalRef === undefined && item.resolution !== "historical";

export function askStale(item: YouItem, siblings: readonly YouItem[], now: number): AskStale | null {
  if (!isDeclaredAsk(item) || item.createdAt <= 0) return null;
  if (now - item.createdAt >= ASK_STALE_MS) return "age";
  const later = new Set(siblings.filter(other => isDeclaredAsk(other) && other.createdAt > item.createdAt && other.turn !== item.turn).map(other => other.turn ?? other.id));
  return later.size >= ASK_STALE_LATER_REPLIES ? "moved-on" : null;
}

export function nextAskStaleAt(items: readonly YouItem[], now: number): number | null {
  let next: number | null = null;
  for (const item of items) {
    const at = item.createdAt + ASK_STALE_MS;
    if (isWaitingYouItem(item) && isDeclaredAsk(item) && item.createdAt > 0 && at > now) next = Math.min(next ?? Infinity, at);
  }
  return next;
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

interface Reply extends Ordered {
  readonly text: string;
  readonly remote: boolean;
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
  let titleIndex: AskAnswerTitles | undefined;
  const answerTitles = (): AskAnswerTitles => titleIndex ??= new AskAnswerTitles([...asks.values()].flatMap((ask) => ask.kind === "decide" ? [ask.title] : []));
  const items = new Map<string, YouItem>();
  const asks = new Map<string, YouItem>();
  const positions = new Map<string, AskPosition>();
  const registered = new Map<string, number>();
  let registrations = 0;
  const messageKeys = new Map<string, string>();
  const replies = new Map<string, Reply>();
  const replyIdsByUuid = new Map<string, string>();
  const completedChecks = new Map<string, number>();
  const contents = new Map<string, string>();
  const features = new Map<string, AskFeatures>();
  const replaceableWith = new Map<string, Set<string>>();
  const answeredAt = new Map<string, number>();
  const unticked = new Map<string, YouItem>();
  const anchors = new Map<string, string>();
  const resolutions = new Map<string, number>();
  const dismissals: { id?: string; message?: string; content?: string; at: number }[] =
    [...(saved.tab ?? [])].map((entry) => ({ ...decodeAskDismissal(entry), at: 0 }));
  const dismissedMessages = new Set(saved.messages ?? []);
  const savedResolutions = new Map<string, AskResolutionRecord[]>();
  const savedResolutionEntries = new Set<string>();
  const addSavedResolution = (entry: string): boolean => {
    if (savedResolutionEntries.has(entry)) return false;
    savedResolutionEntries.add(entry);
    const record = decodeAskResolution(entry);
    if (record === undefined) return false;
    const list = savedResolutions.get(record.identity.content) ?? [];
    list.push(record);
    savedResolutions.set(record.identity.content, list);
    return true;
  };
  for (const entry of [...(saved.resolvedTab ?? []), ...(saved.resolvedMessages ?? [])]) addSavedResolution(entry);
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
  const presentedAfter = (earlierId: string, laterId: string): boolean => {
    const earlier = positions.get(earlierId)!;
    const later = positions.get(laterId)!;
    if (earlier.replyId === later.replyId) return later.offset > earlier.offset;
    if (isAfter(orderOf(earlier), orderOf(later))) return true;
    if (isAfter(orderOf(later), orderOf(earlier))) return false;
    return registered.get(laterId)! > registered.get(earlierId)!;
  };
  const replyBetween = (earlier: Ordered, later: Ordered): boolean => {
    for (const reply of replies.values()) if (isAfter(earlier, reply) && isAfter(reply, later)) return true;
    return false;
  };
  const turnOf = (id: string): string => {
    const position = orderOf(positions.get(id)!);
    let last: [string, Reply] | undefined;
    for (const entry of replies) if (isAfter(entry[1], position) && (last === undefined || isAfter(last[1], entry[1]))) last = entry;
    return last?.[0] ?? "";
  };
  const answers = (item: YouItem, reply: Reply): boolean => item.kind === "decide" && askAnswerChoices(item.title, reply.text, answerTitles()).length > 0;
  const track = (id: string): void => {
    const position = orderOf(positions.get(id)!);
    const item = asks.get(id)!;
    const later = item.kind === "decide" ? [...replies.values()].filter((reply) => isAfter(position, reply)) : [];
    let next: Reply | undefined;
    for (const reply of later) if (next === undefined || isAfter(reply, next)) next = reply;
    let at: number | undefined;
    for (const reply of later) {
      const closes = reply.remote ? !isAfter(next!, reply) : answers(item, reply);
      if (closes && (at === undefined || reply.at < at)) at = reply.at;
    }
    if (at === undefined) answeredAt.delete(id); else answeredAt.set(id, at);
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
      if (otherId === id || other.kind !== own.kind || (own.kind === "decide" && otherPosition.replyId === position.replyId)) continue;
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
      if (item.kind === "check" ? presentedAfter(id, otherId) : isAfter(position, next) && replyBetween(position, next)) consider(next.at, "superseded");
    }
    const dismissal = dismissedAt(id);
    if (dismissal !== undefined) consider(dismissal, "dismissed");
    const identity = identityOf(id);
    for (const saved of savedResolutions.get(identity.content) ?? []) {
      if (saved.resolution === "replied" && item.kind !== "decide") continue;
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
      let next: YouItem = completed !== undefined && (base.resolvedAt === undefined || completed <= base.resolvedAt)
        ? { ...item, resolvedAt: completed, resolution: "replied" as const } : base;
      const turn = turnOf(id);
      if (next.turn !== turn) next = { ...next, turn };
      const shown = items.get(id);
      if (shown === undefined || shown.turn !== next.turn || shown.title !== next.title || shown.kind !== next.kind || shown.createdAt !== next.createdAt
        || shown.resolvedAt !== next.resolvedAt || shown.resolution !== next.resolution || shown.options !== next.options || shown.steps !== next.steps) {
        items.set(id, next);
        changed = true;
      }
    }
    return changed;
  };
  const reply = (id: string, at: number, order?: number, generation?: number, text = "", remote = false): void => {
    const replaced = replies.has(id);
    const entry: Reply = { at, order, generation, text, remote };
    replies.set(id, entry);
    const windowsMove = remote || [...replies.values()].some((other) => other.remote && isAfter(entry, other));
    for (const [askId, item] of asks) {
      if (replaced) track(askId);
      else if (isAfter(orderOf(positions.get(askId)!), entry)) {
        if (windowsMove) track(askId);
        else {
          const previous = answeredAt.get(askId);
          if (answers(item, entry) && (previous === undefined || at < previous)) answeredAt.set(askId, at);
        }
      }
    }
    refresh();
    notify();
  };
  const reorderAfter = (moved: AskPosition): void => {
    for (const [other, position] of positions) {
      if (position.replyId === moved.replyId && position.offset > moved.offset && messageKeys.has(other) && locate?.(position.replyId, position.offset) !== undefined) messageKeys.delete(other);
    }
  };
  const drop = (id: string): void => {
    const dropped = positions.get(id);
    positions.delete(id);
    registered.delete(id);
    if (dropped) reorderAfter(dropped);
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
    unticked.delete(id);
  };
  const reader: YouItemsReader = {
    get: () => [...items.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const adoptSaved = (next: Pick<SavedAskDismissals, "messages" | "resolvedMessages">): void => {
    const before = dismissedMessages.size;
    for (const message of next.messages ?? []) dismissedMessages.add(message);
    let added = dismissedMessages.size !== before;
    for (const entry of next.resolvedMessages ?? []) added = addSavedResolution(entry) || added;
    if (added && refresh()) notify();
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
    tick(anchorId: string, complete: boolean, at = Date.now()): void {
      const id = askIdOf(anchorId);
      if (id === undefined) return;
      const steps = asks.get(id)!.steps;
      if (steps === undefined || steps.length === 0) return;
      if (!complete) completedChecks.delete(id);
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
      } else if (ev.kind === "user_message" && ev.cancelled !== true) {
        const id = `event:${ev.generation}:${ev.seq}`;
        if (ev.uuid !== undefined) replyIdsByUuid.set(ev.uuid, id);
        reply(id, ev.sentAt ?? ev.timestamp, ev.seq, ev.generation, ev.text, ev.remote === true);
      } else if (ev.kind === "replayed_message" && ev.role === "user") {
        reply(ev.uuid ?? `event:${ev.generation}:${ev.seq}`, ev.recordedAt ?? ev.sentAt ?? 0, ev.seq, ev.generation, ev.text, ev.remote === true);
      }
    },
    ask(ask: AskBlock, position: AskPosition): string {
      const id = `ask:${position.replyId}:${position.offset}`;
      const previous = positions.get(id);
      if (previous) position = previous;
      positions.set(id, position);
      if (!previous) {
        registered.set(id, registrations++);
        reorderAfter(position);
      }
      const content = contentKey(ask);
      const known = asks.get(id);
      if (known !== undefined && contents.get(id) === content) {
        if (refresh()) notify();
        return known.anchor.id;
      }
      const item: YouItem = {
        id, kind: ask.kind, title: ask.title, createdAt: position.createdAt,
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
      adoptSaved({ messages });
    },
    adoptSaved,
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
    withdrawReplies(uuids: readonly string[]): void {
      let changed = false;
      for (const uuid of uuids) {
        const id = replyIdsByUuid.get(uuid);
        replyIdsByUuid.delete(uuid);
        if (id !== undefined && replies.delete(id)) changed = true;
      }
      if (!changed) return;
      for (const askId of asks.keys()) track(askId);
      refresh();
      notify();
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
    stateKeyOf(anchorId: string): AskStateKey | undefined {
      const id = askIdOf(anchorId);
      const message = id === undefined ? undefined : identityOf(id).message;
      if (message === undefined) return undefined;
      const tagOf = (askId: string): string => `${asks.get(askId)!.kind}:${normalizeAskText(asks.get(askId)!.title)}`;
      const tag = tagOf(id!);
      const replyId = positions.get(id!)!.replyId;
      const same = [...positions].filter(([other, position]) => position.replyId === replyId && tagOf(other) === tag).length;
      return { message, tag, onlyInRecord: same === 1 };
    },
  };
}
