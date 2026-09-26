import type { NormalizedEvent } from "./protocol";

export interface EventWindow {
  events: NormalizedEvent[];
  droppedCount: number;
  // 単一巨大ターン分岐で先頭へ戻した turn_started が居るか。true のとき events は
  // 連続していない（先頭と2件目の間に窓外のイベントがある）。履歴の遡り要求はここを
  // 見て anchor を選ぶ: 先頭を anchor にすると窓外の区間が hasMore:false で silent に
  // 落ちる
  backfilledHead: boolean;
}

// bounded event log と webview 同期再生で同じ規則を使う。別実装にすると片方だけ直す事故が起きる。
// 返す配列は必ず max 件以下で、かつ先頭が turn_started であるか、先頭より前に turn_started が
// 存在しないかのどちらかになる。この不変条件が崩れると tab.ts の onAssistantTextDelta が
// turnId 照合に失敗し、delta を全て捨てて本文が消える。
export function windowEvents(events: NormalizedEvent[], max: number): EventWindow {
  if (max <= 0) return { events: [], droppedCount: events.length, backfilledHead: false };
  if (events.length <= max) return { events, droppedCount: 0, backfilledHead: false };

  const minimumCut = events.length - max;
  let cut = minimumCut;
  while (cut < events.length && events[cut].kind !== "turn_started") cut++;
  if (cut < events.length) return { events: events.slice(cut), droppedCount: cut, backfilledHead: false };

  // 単一巨大ターン。境界が後ろに無いので直前の turn_started を先頭へ戻す。
  // 戻すぶん1件多く落として max を超えないようにする。
  const boundary = findLastTurnStart(events, minimumCut);
  if (!boundary) {
    return { events: events.slice(minimumCut), droppedCount: minimumCut, backfilledHead: false };
  }
  // droppedCount は利用者へ出す「省略した件数」なので、先頭へ戻した turn_started を差し引いた正味にする
  const kept = [boundary, ...events.slice(minimumCut + 1)];
  return { events: kept, droppedCount: events.length - kept.length, backfilledHead: true };
}

function findLastTurnStart(events: NormalizedEvent[], before: number): NormalizedEvent | undefined {
  for (let i = Math.min(before, events.length) - 1; i >= 0; i--) {
    if (events[i].kind === "turn_started") return events[i];
  }
  return undefined;
}
