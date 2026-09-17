import type { NormalizedEvent } from "./protocol";
import * as l10n from "@vscode/l10n";

// 搬送予算は関門ではない。単一イベントが予算を超えても送れないことにはしない（R-CNV-01）。
// 本文を切って必ず送る。切っても収まらない種別はそのまま送る方が行き止まりより良い。
export function transportTruncatedNote(): string {
  return l10n.t("\n\n… (truncated here because a single item was too large)");
}

// 上限の無い本文を持つ種別だけを対象にする。inputPreview(500字) / resultPreview(2000字) は
// 取り込み時に切り詰め済みなので、ここへ来る大きさにはならない
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

// サロゲート対を割らない
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
  // 本文を注記だけにしても収まらないなら、この種別ではこれ以上小さくできない
  const floor = withText(note);
  if (bytesOf(floor) > budgetBytes) return floor;
  // 収まる最大の切り出し位置を二分探索する（切る位置とバイト数は単調）
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
