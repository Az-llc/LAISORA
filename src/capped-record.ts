export interface CappedEntries<T> {
  entries: Record<string, T>;
  evicted: number;
}

export function withLatestWritten<T>(
  entries: Readonly<Record<string, T>>,
  updates: ReadonlyArray<readonly [string, T]>,
  max: number
): CappedEntries<T> {
  const moved = new Set(updates.map(([key]) => key));
  const list = [...Object.entries(entries).filter(([key]) => !moved.has(key)), ...updates];
  const kept = list.slice(-max);
  return { entries: Object.fromEntries(kept), evicted: list.length - kept.length };
}

export function withOldestEvicted<T>(
  entries: Readonly<Record<string, T>>,
  updates: ReadonlyArray<readonly [string, T]>,
  max: number,
  age: (value: T) => number
): CappedEntries<T> {
  const out: Record<string, T> = { ...entries };
  for (const [key, value] of updates) out[key] = value;
  const keys = Object.keys(out);
  if (keys.length <= max) return { entries: out, evicted: 0 };
  keys.sort((a, b) => age(out[a]) - age(out[b]));
  const evicted = keys.slice(0, keys.length - max);
  for (const key of evicted) delete out[key];
  return { entries: out, evicted: evicted.length };
}
