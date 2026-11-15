import { ASK_MARKS_MAX, type AskMarkEdit, type AskMarks, type AskStateKey } from "./protocol";

export type { AskStateKey } from "./protocol";

export interface AskIdentity { readonly message?: string; readonly content: string }

export interface AskResolutionRecord {
  readonly identity: AskIdentity;
  readonly resolution: "replied" | "superseded";
  readonly at: number;
}

export function encodeAskDismissal(identity: AskIdentity): string {
  return JSON.stringify(identity.message === undefined ? { c: identity.content } : { m: identity.message, c: identity.content });
}

export function encodeAskResolution(record: AskResolutionRecord): string {
  return JSON.stringify({ ...JSON.parse(encodeAskDismissal(record.identity)), r: record.resolution, t: record.at });
}

export function decodeAskResolution(entry: string): AskResolutionRecord | undefined {
  try {
    const value = JSON.parse(entry) as { m?: unknown; c?: unknown; r?: unknown; t?: unknown };
    if (typeof value.c !== "string" || (value.m !== undefined && typeof value.m !== "string") ||
      (value.r !== "replied" && value.r !== "superseded") || typeof value.t !== "number") return undefined;
    return { identity: typeof value.m === "string" ? { message: value.m, content: value.c } : { content: value.c }, resolution: value.r, at: value.t };
  } catch {
    return undefined;
  }
}

export function askResolutionKey(record: AskResolutionRecord): string {
  return record.identity.message ?? `content:${record.identity.content}`;
}

export function mergeAskResolutions(old: readonly string[], updates: readonly AskResolutionRecord[], withdrawn: readonly AskResolutionRecord[] = []): string[] {
  const entries = new Map<string, string>();
  for (const encoded of old) {
    const record = decodeAskResolution(encoded);
    if (record) entries.set(askResolutionKey(record), encoded);
  }
  for (const record of withdrawn) entries.delete(askResolutionKey(record));
  for (const record of updates) {
    if (record.identity.message) entries.delete(`content:${record.identity.content}`);
    entries.set(askResolutionKey(record), encodeAskResolution(record));
  }
  return [...entries.values()].slice(-ASK_MARKS_MAX);
}

export function askStateLookup<T>(key: AskStateKey, entries: Readonly<Record<string, T>> | undefined, tags: Readonly<Record<string, string>> | undefined): { message: string; value: T } | undefined {
  if (entries === undefined) return undefined;
  const direct = entries[key.message];
  if (direct !== undefined) return (tags?.[key.message] ?? key.tag) === key.tag ? { message: key.message, value: direct } : undefined;
  if (!key.onlyInRecord) return undefined;
  const record = key.message.slice(0, key.message.lastIndexOf("#") + 1);
  const carried = Object.entries(entries).filter(([message]) => message.startsWith(record) && tags?.[message] === key.tag);
  return carried.length === 1 ? { message: carried[0][0], value: carried[0][1] } : undefined;
}

export function askStateWrite<T>(key: AskStateKey, entries: Readonly<Record<string, T>> | undefined, tags: Readonly<Record<string, string>> | undefined, value: T, max: number): { entries: Record<string, T>; tags: Record<string, string> } {
  const carried = askStateLookup(key, entries, tags)?.message;
  const drop = new Set([key.message, ...(carried === undefined ? [] : [carried])]);
  const kept = Object.entries(entries ?? {}).filter(([message]) => !drop.has(message));
  const nextEntries = Object.fromEntries([...kept, [key.message, value]].slice(-max)) as Record<string, T>;
  const nextTags: Record<string, string> = {};
  for (const message of Object.keys(nextEntries)) {
    const tag = message === key.message ? key.tag : tags?.[message];
    if (tag !== undefined) nextTags[message] = tag;
  }
  return { entries: nextEntries, tags: nextTags };
}

const decodedResolutions = (entries: readonly string[]): AskResolutionRecord[] =>
  entries.flatMap((entry) => decodeAskResolution(entry) ?? []);

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

function unionAskMarks(kept: AskMarks, old: AskMarks): AskMarks {
  const checked = Object.fromEntries([...Object.entries(old.checked).filter(([message]) => !(message in kept.checked)), ...Object.entries(kept.checked)].slice(-ASK_MARKS_MAX));
  const checkedTags: Record<string, string> = {};
  const checkedPosted: Record<string, true> = {};
  for (const message of Object.keys(checked)) {
    const tag = message in kept.checked ? kept.checkedTags[message] : old.checkedTags[message];
    if (tag !== undefined) checkedTags[message] = tag;
    if (kept.checkedPosted[message] === true || old.checkedPosted[message] === true) checkedPosted[message] = true;
  }
  return {
    dismissed: [...new Set([...old.dismissed, ...kept.dismissed])].slice(-ASK_MARKS_MAX),
    resolved: mergeAskResolutions(old.resolved, decodedResolutions(kept.resolved)),
    checked, checkedTags, checkedPosted,
  };
}

export function applyAskMarkEdit(marks: AskMarks, edit: AskMarkEdit): AskMarks {
  switch (edit.kind) {
    case "check": {
      if (edit.ifAbsent && askStateLookup(edit.key, marks.checked, marks.checkedTags) !== undefined) return marks;
      const written = askStateWrite(edit.key, marks.checked, marks.checkedTags, [...edit.steps], ASK_MARKS_MAX);
      const checkedPosted: Record<string, true> = {};
      for (const message of Object.keys(written.entries)) {
        if (message === edit.key.message ? edit.posted : marks.checkedPosted[message] === true) checkedPosted[message] = true;
      }
      return { ...marks, checked: written.entries, checkedTags: written.tags, checkedPosted };
    }
    case "dismiss": {
      const known = new Set(marks.dismissed);
      if (edit.messages.every((message) => known.has(message))) return marks;
      return { ...marks, dismissed: [...new Set([...marks.dismissed, ...edit.messages])].slice(-ASK_MARKS_MAX) };
    }
    case "resolve": {
      const resolved = mergeAskResolutions(marks.resolved, decodedResolutions(edit.records), decodedResolutions(edit.withdrawn));
      return sameStrings(resolved, marks.resolved) ? marks : { ...marks, resolved };
    }
    case "legacy":
      return unionAskMarks(marks, edit.marks);
  }
}
