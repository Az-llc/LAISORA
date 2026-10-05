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

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  const s = Math.round(totalSec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function dayClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock(ms)}`;
}

export function monthDayClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(ms)}`;
}

