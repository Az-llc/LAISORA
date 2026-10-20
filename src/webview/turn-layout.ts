import { appendRecordPart, joinRecordTexts, prependRecordParts, recordSeparator, type RecordTextPart } from "../commit-boundary";

export type TurnOrder = readonly [generation: number, seq: number];

export type TurnItem =
  | { readonly kind: "text"; readonly order: TurnOrder; readonly at: number; readonly text: string; readonly recordUuid?: string | null }
  | { readonly kind: "uuid"; readonly order: TurnOrder; readonly uuid: string }
  | { readonly kind: "card"; readonly order: TurnOrder; readonly toolUseId: string };

export interface TurnParagraph {
  readonly kind: "paragraph";
  readonly key: string;
  readonly parts: RecordTextPart[];
  readonly opener: TurnOrder;
  readonly at: number;
  readonly open: boolean;
}

export interface TurnCardAnchor {
  readonly kind: "card";
  readonly toolUseId: string;
}

export type TurnSlot = TurnParagraph | TurnCardAnchor;

export interface TurnLayout {
  readonly slots: readonly TurnSlot[];
  readonly leadUuid?: string;
}

export interface TurnPrepend {
  readonly slots: readonly TurnSlot[];
  readonly prefix?: TurnParagraph;
  readonly leadUuid?: string;
}

export type EditSummaryPlace = "after-footer" | "in-frame" | "hidden";

export function compareTurnOrder(a: TurnOrder, b: TurnOrder): number {
  return a[0] - b[0] || a[1] - b[1];
}

export function breaksParagraph(item: TurnItem): boolean {
  return item.kind === "card" || (item.kind === "text" && item.recordUuid !== undefined);
}

export function paragraphKey(turnId: string, opener: TurnOrder): string {
  return `${turnId}@${opener[0]}.${opener[1]}`;
}

export function legacyAskKeys(replyId: string, livePosition: number, paragraphIndex: number, turnPosition: number): string[] {
  const at = replyId.lastIndexOf("@");
  if (at <= 0 || !/^-?\d+\.-?\d+$/.test(replyId.slice(at + 1))) return [];
  const turnId = replyId.slice(0, at);
  const live = `ask:${paragraphIndex === 0 ? turnId : `${turnId}:part:${paragraphIndex}`}:${livePosition}`;
  const history = `ask:${turnId}:${turnPosition}`;
  return live === history ? [live] : [live, history];
}

export function paragraphText(parts: readonly RecordTextPart[]): string {
  return joinRecordTexts(parts.map((part) => part.text));
}

export function labelPendingParts(parts: readonly RecordTextPart[], uuid: string): boolean {
  const last = parts.at(-1);
  if (last?.complete && last.uuid === uuid) return true;
  let i = parts.length - 1;
  while (i >= 0 && parts[i].complete) i--;
  let labelled = false;
  for (; i >= 0; i--) {
    if (parts[i].uuid !== null || parts[i].complete) break;
    parts[i].uuid = uuid;
    labelled = true;
  }
  return labelled;
}

export function deriveTurnLayout(turnId: string, items: readonly TurnItem[]): TurnLayout {
  const slots: (TurnParagraph | TurnCardAnchor)[] = [];
  const all: RecordTextPart[] = [];
  let open: { -readonly [K in keyof TurnParagraph]: TurnParagraph[K] } | null = null;
  let leadUuid: string | undefined;
  for (const item of [...items].sort((a, b) => compareTurnOrder(a.order, b.order))) {
    if (item.kind === "uuid") {
      if (all.length === 0) leadUuid ??= item.uuid;
      else labelPendingParts(all, item.uuid);
      continue;
    }
    if (breaksParagraph(item)) {
      if (open !== null) open.open = false;
      open = null;
    }
    if (item.kind === "card") {
      slots.push({ kind: "card", toolUseId: item.toolUseId });
      continue;
    }
    if (item.text.length === 0) continue;
    if (item.recordUuid !== undefined) {
      const part: RecordTextPart = { text: item.text, uuid: item.recordUuid, complete: true };
      all.push(part);
      slots.push({ kind: "paragraph", key: paragraphKey(turnId, item.order), parts: [part], opener: item.order, at: item.at, open: false });
      continue;
    }
    if (open === null) {
      open = { kind: "paragraph", key: paragraphKey(turnId, item.order), parts: [], opener: item.order, at: item.at, open: true };
      slots.push(open);
    }
    const before = open.parts.at(-1);
    appendRecordPart(open.parts, { text: item.text, uuid: null });
    const after = open.parts.at(-1)!;
    if (after !== before) all.push(after);
  }
  return leadUuid === undefined ? { slots } : { slots, leadUuid };
}

export function prependTurnLayout(turnId: string, older: readonly TurnItem[], headMergeable: boolean, leadUuid?: string): TurnPrepend {
  const items = leadUuid === undefined ? older : [...older, { kind: "uuid", order: [Infinity, Infinity], uuid: leadUuid } as const];
  const layout = deriveTurnLayout(turnId, items);
  const slots = [...layout.slots];
  const last = slots.at(-1);
  const prefix = headMergeable && last?.kind === "paragraph" && last.open ? last : undefined;
  if (prefix !== undefined) slots.pop();
  return {
    slots,
    ...(prefix === undefined ? {} : { prefix }),
    ...(layout.leadUuid === undefined ? {} : { leadUuid: layout.leadUuid }),
  };
}

export function mergedParagraph(prefix: readonly RecordTextPart[], head: readonly RecordTextPart[]): { parts: RecordTextPart[]; shift: number } {
  const parts = prependRecordParts(prefix, head);
  return { parts, shift: paragraphText(parts).length - paragraphText(head).length };
}

export function locateInParts(parts: readonly RecordTextPart[], offset: number): { message: string; start: number } | undefined | null {
  let joined = "";
  for (const part of parts) {
    joined += recordSeparator(joined);
    const start = joined.length;
    joined += part.text;
    if (offset < joined.length) return offset >= start && part.uuid !== null ? { message: part.uuid, start } : undefined;
  }
  return null;
}

export function cardHome(calls: readonly { readonly toolUseId: string; readonly order: TurnOrder }[], failed: (toolUseId: string) => boolean): string | undefined {
  let home: { readonly toolUseId: string; readonly order: TurnOrder } | undefined;
  for (const call of calls) {
    if (failed(call.toolUseId)) continue;
    if (home === undefined || compareTurnOrder(call.order, home.order) < 0) home = call;
  }
  return home?.toolUseId;
}

export interface ModelMark {
  readonly order: TurnOrder;
  readonly model: string;
  readonly turnId: string | null;
}

export function turnLabelModel(marks: readonly ModelMark[], turnId: string | null, turnStart: TurnOrder): string | undefined {
  if (turnId !== null) {
    const own = marks.find((mark) => mark.turnId === turnId);
    if (own !== undefined) return own.model;
  }
  let model: string | undefined;
  for (const mark of marks) {
    if (compareTurnOrder(mark.order, turnStart) > 0) break;
    model = mark.model;
  }
  return model;
}

export function editSummaryPlace(hasFooter: boolean, shown: boolean): EditSummaryPlace {
  if (!shown) return "hidden";
  return hasFooter ? "after-footer" : "in-frame";
}
