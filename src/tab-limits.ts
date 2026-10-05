export const TAB_LIMIT_DEFAULT = 20;
export const TAB_LIMIT_MIN = 1;
export const SCOPE_MAX_PER_TAB = 2;

export function resolveTabLimit(value: unknown, fallback: number = TAB_LIMIT_DEFAULT): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const truncated = Math.trunc(n);
  if (truncated < TAB_LIMIT_MIN) return fallback;
  return truncated;
}

export function scopeMaxForTabs(tabLimit: number, openTabCount: number): number {
  return Math.max(tabLimit, openTabCount) * SCOPE_MAX_PER_TAB;
}
