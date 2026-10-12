import { configurationDefault } from "./configuration-defaults";

export const EVENT_LIMIT_DEFAULT = configurationDefault<number>("history.eventLimit");
export const EVENT_LIMIT_MIN = 1000;
export const EVENT_LIMIT_MAX = 100000;

export function isEventLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= EVENT_LIMIT_MIN && value <= EVENT_LIMIT_MAX;
}

export function resolveEventLimit(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  const truncated = Math.trunc(n);
  return isEventLimit(truncated) ? truncated : EVENT_LIMIT_DEFAULT;
}
