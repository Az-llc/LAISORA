import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type Interned = "exposure" | "episode-state" | "measurement" | "episode";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
export interface LedgerContext { v: 3; k: "context"; t: Interned; id: string; f: string[]; p: JsonObject; tk?: string[] }
export type LedgerLine = { kind: "dictionary"; id: string; fresh: boolean } | { kind: "record"; value: unknown; contexts: string[] } | { kind: "invalid" };

const INTERNED = new Set<string>(["exposure", "episode-state", "measurement", "episode"]);
const ENVELOPE = new Set(["kind", "v", "at", "opId"]);
const EXPOSURE_PER_RECORD = new Set(["session", "observedModel", "observedEffort", "attestation", "outcome", "reason"]);
const EPISODE_STATE_CONTEXT = new Set(["conversation", "recipient", "run"]);
const MEASUREMENT_CONTEXT = new Set(["conversation", "run", "counts", "tags"]);

const plain = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(name => typeof name === "string") && new Set(value).size === value.length;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function contextId(t: string, f: readonly string[], p: JsonObject, tk?: readonly string[]): string {
  return createHash("sha256").update(canonical({ domain: "laisora-ledger-context", t, f, p, ...(tk ? { tk } : {}) })).digest("hex").slice(0, 32);
}
function context(t: Interned, f: string[], p: JsonObject, tk?: string[]): LedgerContext {
  return { v: 3, k: "context", t, id: contextId(t, f, p, tk), f, p, ...(tk ? { tk } : {}) };
}

function split(record: JsonObject, inContext: (key: string) => boolean): { f: string[]; p: JsonObject; d: JsonObject } {
  const p: JsonObject = {}, d: JsonObject = {};
  for (const [key, value] of Object.entries(record)) {
    if (ENVELOPE.has(key)) continue;
    if (inContext(key)) p[key] = value; else d[key] = value;
  }
  return { f: Object.keys(record), p, d };
}

export function encodeLedgerFrame(input: unknown, known: (id: string) => boolean): { text: string; contexts: LedgerContext[] } {
  const record = JSON.parse(JSON.stringify(input)) as JsonObject;
  const contexts: LedgerContext[] = [];
  const define = (entry: LedgerContext) => { if (!known(entry.id) && !contexts.some(other => other.id === entry.id)) contexts.push(entry); return entry.id; };
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const finish = (ref: JsonObject) => ({ text: contexts.map(line).join("") + line(ref), contexts });
  const envelope = (c: string, extra: JsonObject = {}) => ({ v: 3, k: "ref", c,
    ...(record.at !== undefined ? { a: record.at } : {}), ...(record.opId !== undefined ? { o: record.opId } : {}), ...extra });
  switch (record.kind) {
    case "episode":
      return finish({ v: 3, k: "ref", c: define(context("episode", Object.keys(record), record)) });
    case "exposure": {
      const { f, p, d } = split(record, key => !EXPOSURE_PER_RECORD.has(key));
      return finish(envelope(define(context("exposure", f, p)), Object.keys(d).length ? { d } : {}));
    }
    case "episode-state": {
      const episode = plain(record.episode) ? define(context("episode", Object.keys(record.episode), record.episode)) : undefined;
      const { f, p, d } = split(record, key => EPISODE_STATE_CONTEXT.has(key));
      delete d.episode;
      return finish(envelope(define(context("episode-state", f, p)), { ...(Object.keys(d).length ? { d } : {}), ...(episode ? { e: episode } : {}) }));
    }
    case "measurement": {
      const { f, p, d } = split(record, key => MEASUREMENT_CONTEXT.has(key));
      const tags = plain(record.tags) ? record.tags : undefined;
      const toolUse = tags && Object.hasOwn(tags, "toolUse") ? tags.toolUse : undefined;
      if (tags && toolUse !== undefined) p.tags = Object.fromEntries(Object.entries(tags).filter(([key]) => key !== "toolUse"));
      const id = define(context("measurement", f, p, toolUse !== undefined ? Object.keys(tags!) : undefined));
      return finish(envelope(id, { ...(Object.keys(d).length ? { d } : {}), ...(toolUse !== undefined ? { u: toolUse } : {}) }));
    }
    default:
      return finish({ v: 3, k: "record", r: record });
  }
}

export class LedgerV3Decoder {
  private readonly dictionary: Map<string, LedgerContext>;
  private readonly conflicted = new Set<string>();
  constructor(entries: Iterable<LedgerContext> = []) { this.dictionary = new Map([...entries].map(entry => [entry.id, entry])); }
  static restore(entries: readonly unknown[], conflicted: readonly unknown[] = []): LedgerV3Decoder | undefined {
    const decoder = new LedgerV3Decoder();
    for (const entry of entries) if (decoder.decode(entry).kind !== "dictionary") return undefined;
    for (const id of conflicted) { if (!hex(id) || !decoder.dictionary.has(id) || decoder.conflicted.has(id)) return undefined; decoder.conflicted.add(id); }
    return decoder;
  }
  has(id: string): boolean { return this.dictionary.has(id); }
  get size(): number { return this.dictionary.size; }
  get entries(): Iterable<LedgerContext> { return this.dictionary.values(); }
  get conflictedIds(): Iterable<string> { return this.conflicted; }
  clone(): LedgerV3Decoder {
    const copy = new LedgerV3Decoder(this.dictionary.values());
    for (const id of this.conflicted) copy.conflicted.add(id);
    return copy;
  }
  decode(value: unknown): LedgerLine {
    if (!plain(value) || value.v !== 3) return { kind: "invalid" };
    if (value.k === "context") return this.define(value);
    if (value.k === "record") return plain(value.r) && Object.keys(value).length === 3 ? { kind: "record", value: value.r, contexts: [] } : { kind: "invalid" };
    if (value.k !== "ref" || typeof value.c !== "string") return { kind: "invalid" };
    const expanded = this.expand(value);
    return expanded ? { kind: "record", value: expanded, contexts: typeof value.e === "string" ? [value.c, value.e] : [value.c] } : { kind: "invalid" };
  }
  private define(value: JsonObject): LedgerLine {
    if (Object.keys(value).some(key => !["v", "k", "t", "id", "f", "p", "tk"].includes(key)) || typeof value.t !== "string" || !INTERNED.has(value.t)
      || !hex(value.id) || !names(value.f) || !plain(value.p) || value.tk !== undefined && !names(value.tk)) return { kind: "invalid" };
    const tk = value.tk as string[] | undefined;
    if (contextId(value.t, value.f, value.p, tk) !== value.id) return { kind: "invalid" };
    const entry: LedgerContext = { v: 3, k: "context", t: value.t as Interned, id: value.id, f: value.f, p: value.p, ...(tk ? { tk } : {}) };
    const prior = this.dictionary.get(value.id);
    if (prior && !isDeepStrictEqual(prior, entry)) { this.conflicted.add(value.id); return { kind: "invalid" }; }
    if (!prior) this.dictionary.set(value.id, entry);
    return { kind: "dictionary", id: value.id, fresh: !prior };
  }
  private expand(ref: JsonObject): JsonObject | undefined {
    if (Object.keys(ref).some(key => !["v", "k", "c", "a", "o", "d", "e", "u"].includes(key)) || this.conflicted.has(ref.c as string)) return undefined;
    const entry = this.dictionary.get(ref.c as string);
    if (!entry || ref.d !== undefined && !plain(ref.d)) return undefined;
    const d = (ref.d ?? {}) as JsonObject;
    if (Object.keys(d).some(key => !entry.f.includes(key) || Object.hasOwn(entry.p, key))) return undefined;
    if (ref.e !== undefined && !(entry.t === "episode-state" && entry.f.includes("episode"))) return undefined;
    if (ref.u !== undefined && !entry.tk?.includes("toolUse")) return undefined;
    const result: JsonObject = {};
    for (const key of entry.f) {
      if (Object.hasOwn(d, key)) result[key] = d[key];
      else if (key === "tags" && entry.tk) {
        if (ref.u === undefined || !plain(entry.p.tags)) return undefined;
        const tags = entry.p.tags;
        result.tags = Object.fromEntries(entry.tk.map(name => [name, name === "toolUse" ? ref.u as Json : tags[name]]));
      } else if (Object.hasOwn(entry.p, key)) result[key] = entry.p[key];
      else if (key === "kind") result.kind = entry.t;
      else if (key === "v") result.v = 2;
      else if (key === "at" && ref.a !== undefined) result.at = ref.a;
      else if (key === "opId" && ref.o !== undefined) result.opId = ref.o;
      else if (key === "episode" && typeof ref.e === "string") {
        const episode = this.dictionary.get(ref.e);
        if (!episode || episode.t !== "episode") return undefined;
        const expanded = this.expand({ v: 3, k: "ref", c: ref.e });
        if (!expanded) return undefined;
        result.episode = expanded;
      } else return undefined;
    }
    return result;
  }
}
