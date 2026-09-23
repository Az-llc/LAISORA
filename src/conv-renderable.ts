import type { NormalizedEvent } from "./protocol";

// 会話面へ描ける kind の白リスト。renderPastConvEvent の判定と、遡りボタンを出すかの判定と、
// 復帰で落とした先頭側に会話イベントが在るかの Host 側判定で共有する。
// 片方だけ直すと「押しても全件 skipped になるボタン」が戻る（原因A M-4）。
// DOM に触れないのでこのモジュールは Host からも読める（webview/tab.ts に置くと読めない）
export function isConvRenderableEvent(ev: NormalizedEvent): boolean {
  if (ev.kind === "replayed_message" || ev.kind === "model_observed") return true;
  // 世代境界より前の圧縮は当世代の会話ではない（R-HND-13）。印は Host が付ける
  if (ev.kind === "compact_boundary") return ev.priorGeneration !== true;
  if (ev.kind === "user_message" || ev.kind === "assistant_text_delta") {
    return ev.provenance?.path !== "history";
  }
  return false;
}
