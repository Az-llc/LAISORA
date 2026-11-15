import { configurationBound, configurationDefault } from "./configuration-defaults";

export const EVENT_LIMIT_DEFAULT = configurationDefault<number>("history.eventLimit");
export const EVENT_LIMIT_MIN = configurationBound("history.eventLimit", "minimum");
export const EVENT_LIMIT_MAX = configurationBound("history.eventLimit", "maximum");

export function isEventLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= EVENT_LIMIT_MIN && value <= EVENT_LIMIT_MAX;
}

export function resolveEventLimit(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  const truncated = Math.trunc(n);
  return isEventLimit(truncated) ? truncated : EVENT_LIMIT_DEFAULT;
}
