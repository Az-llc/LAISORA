import * as l10n from "@vscode/l10n";
import { summarizeToolInput } from "../protocol";

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

export interface DurationPart { value: string; unit: string }

export function durationParts(ms: number): DurationPart[] {
  const totalSec = Math.max(0, ms) / 1000;
  const tenths = Math.round(totalSec * 10) / 10;
  if (tenths < 10) return [{ value: tenths.toFixed(1), unit: l10n.t("s") }];
  const s = Math.round(totalSec);
  if (s < 60) return [{ value: String(s), unit: l10n.t("s") }];
  const m = Math.floor(s / 60);
  if (m < 60) return [{ value: String(m), unit: l10n.t("m") }, { value: String(s % 60).padStart(2, "0"), unit: l10n.t("s") }];
  return [{ value: String(Math.floor(m / 60)), unit: l10n.t("h") }, { value: String(m % 60).padStart(2, "0"), unit: l10n.t("m") }];
}

export function formatDuration(ms: number): string {
  return durationParts(ms).map(part => part.value + part.unit).join("");
}

export const APPROX_MARK = "≈";

export function approx(text: string, approximate: unknown): string {
  return approximate ? `${APPROX_MARK}${text}` : text;
}

export function approxTitle(title: string, approximate: unknown): string {
  return approximate ? `${APPROX_MARK} ${title}` : title;
}

export function approxDuration(ms: number, approximate: unknown): string {
  return approx(formatDuration(ms), approximate);
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function dayClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock(ms)}`;
}

export function clockRange(start: number, end: number | null, now = Date.now()): string {
  const other = end ?? now;
  const year = (ms: number) => new Date(ms).getFullYear();
  const stamp = year(start) !== year(other) ? (ms: number) => `${year(ms)}-${dayClock(ms)}`
    : dayClock(start).slice(0, 5) !== dayClock(other).slice(0, 5) ? dayClock : clock;
  return `${stamp(start)}–${end === null ? "" : stamp(end)}`;
}

export function monthDayClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(ms)}`;
}

