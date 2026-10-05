import type { NormalizedEvent } from "./protocol";
import * as l10n from "@vscode/l10n";

export function transportTruncatedNote(): string {
  return l10n.t("\n\n… (truncated here because a single item was too large)");
}

type TruncatableField = "text";

function truncatableField(item: NormalizedEvent): TruncatableField | undefined {
  switch (item.kind) {
    case "user_message":
    case "replayed_message":
    case "assistant_text_delta":
      return "text";
    default:
      return undefined;
  }
}

function safeCut(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function fitEventForTransport(item: NormalizedEvent, budgetBytes: number): NormalizedEvent {
  if (bytesOf(item) <= budgetBytes) return item;
  const field = truncatableField(item);
  if (field === undefined) return item;
  const original = (item as unknown as Record<string, unknown>)[field];
  if (typeof original !== "string" || original.length === 0) return item;
  const withText = (text: string) => ({ ...item, [field]: text }) as NormalizedEvent;
  const note = transportTruncatedNote();
  const floor = withText(note);
  if (bytesOf(floor) > budgetBytes) return floor;
  let lo = 0;
  let hi = original.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = safeCut(original, mid);
    if (bytesOf(withText(original.slice(0, cut) + note)) <= budgetBytes) {
      best = cut;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return withText(original.slice(0, best) + note);
}
