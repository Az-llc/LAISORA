import { fileRowMatchesQuery } from "../file-query";
import type { FileSuggestRow } from "../protocol";

export type FileSuggestPhase = "pending" | "shown" | "empty" | "cancelled";

export interface FileSuggest {
  phase: FileSuggestPhase;
  triggerIndex: number;
  reqId: number;
  queriedAt: number;
  items: readonly FileSuggestRow[];
  selected: number;
}

export type FileSuggestEnter = "commit" | "hold" | "send";

export const FILE_SUGGEST_HOLD_MS = 1500;

function indexOfText(rows: readonly FileSuggestRow[], row: FileSuggestRow | undefined): number {
  return row === undefined ? -1 : rows.findIndex((candidate) => candidate.text === row.text);
}

export function fileSuggestTyped(previous: FileSuggest | null, triggerIndex: number, reqId: number, query: string, now: number): FileSuggest {
  const keep = previous !== null && previous.triggerIndex === triggerIndex && previous.phase !== "cancelled";
  const items = keep ? previous.items.filter((item) => fileRowMatchesQuery(item, query)) : [];
  const highlighted = keep ? previous.items[previous.selected] : undefined;
  return { phase: "pending", triggerIndex, reqId, queriedAt: now, items, selected: indexOfText(items, highlighted) };
}

export function fileSuggestResult(state: FileSuggest, reqId: number, rows: readonly FileSuggestRow[]): FileSuggest {
  if (state.phase !== "pending" || state.reqId !== reqId) return state;
  if (rows.length === 0) return { ...state, phase: "empty", items: [], selected: -1 };
  const highlighted = state.items[state.selected];
  return { ...state, phase: "shown", items: rows, selected: Math.max(0, indexOfText(rows, highlighted)) };
}

export function fileSuggestCancelled(state: FileSuggest): FileSuggest {
  return { ...state, phase: "cancelled", items: [], selected: -1 };
}

export function fileSuggestEnter(state: FileSuggest, now: number): FileSuggestEnter {
  if ((state.phase === "pending" || state.phase === "shown") && state.items[state.selected] !== undefined) return "commit";
  return state.phase === "pending" && now - state.queriedAt < FILE_SUGGEST_HOLD_MS ? "hold" : "send";
}
