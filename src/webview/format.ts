import { summarizeToolInput } from "../protocol";

// ツール要約: 表示用の1行を返す。
// ホストが切り詰め前の完全な入力から算出した inputSummary を最優先で使う。
// これが無い場合のみ inputPreview を自前パースし、それも失敗したら
// 先頭60字にフォールバックする。inputPreview は500字切り詰めでJSONが壊れているため、
// パース経路は「短い入力のツールなら偶然通る」程度の保険でしかない。
export function toolSummary(ev: { toolName: string; inputPreview: string; inputSummary?: string }): string {
  if (ev.inputSummary) return ev.inputSummary;
  const { toolName, inputPreview } = ev;
  const fallback = () => (inputPreview.length > 60 ? `${inputPreview.slice(0, 60)}…` : inputPreview);
  try {
    return summarizeToolInput(toolName, JSON.parse(inputPreview)) ?? fallback();
  } catch {
    return fallback();
  }
}

// 経過時間表示: 10秒未満は小数第1位、60秒未満は整数秒、以降は分秒（例: 1.2s / 42s / 2m5s）
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  const s = Math.round(totalSec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

// トークン数表示: 1000以上は k表記(小数第1位)、未満はそのまま（例: 45231 -> 45.2k tok / 320 -> 320 tok）
export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

// 数値・時刻の書式ロケール。表示言語の正本は document.documentElement.lang
export function uiLocale(): string {
  // 検査ページの一部は document.documentElement を持たない。lang 未設定は en
  const lang = typeof document === "undefined" ? "" : (document.documentElement?.lang ?? "");
  return lang.toLowerCase().startsWith("ja") ? "ja-JP" : "en-US";
}

export function formatDateTime(ms: number | null): string {
  if (ms === null) return "?";
  return new Date(ms).toLocaleString(uiLocale(), { hour12: false });
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function dayClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock(ms)}`;
}

// 発言・返信フッターの日時（R-CNV-15 / R-CNV-16）。当日でも日付を省かない。
// toLocaleString へ任せると en-US で "9/18, 14:35" になり表記が言語で割れるので手で組む
export function monthDayClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(ms)}`;
}

