import { parseBlockFields, type BlockEntry, type BlockSchema } from "./ask-parser";

export const SUMMARY_FENCE_INFO = "laisora-summary";

export const SUMMARY_STATES = { done: "done", waiting: "waiting" } as const;
export const SUMMARY_WAIT_KINDS = { decide: "decide", check: "check", approve: "approve" } as const;
export const SUMMARY_KEYS = {
  state: "state",
  summary: "summary",
  done: "done",
  verified: "verified",
  unverified: "unverified",
  left: "left",
  progress: "progress",
  waiting: "waiting",
  kind: "kind",
  title: "title",
} as const;

export type SummaryWaitKind = typeof SUMMARY_WAIT_KINDS[keyof typeof SUMMARY_WAIT_KINDS];
export interface SummaryWait { readonly kind: SummaryWaitKind; readonly title: string }

export type SummaryBlock =
  | { readonly state: "done"; readonly summary: string; readonly done: readonly string[]; readonly verified: readonly string[]; readonly unverified: readonly string[]; readonly left: readonly string[] }
  | { readonly state: "waiting"; readonly progress: readonly string[]; readonly waiting: readonly SummaryWait[] };

const K = SUMMARY_KEYS;
const DONE_LISTS = [K.done, K.verified, K.unverified, K.left] as const;
const SUMMARY_SCHEMA: BlockSchema = {
  root: [K.state, K.summary],
  lists: { [K.done]: "scalar", [K.verified]: "scalar", [K.unverified]: "scalar", [K.left]: "scalar", [K.progress]: "scalar", [K.waiting]: [K.kind, K.title] },
};

const isWaitKind = (value: string | undefined): value is SummaryWaitKind => Object.values<string>(SUMMARY_WAIT_KINDS).includes(value ?? "");

export function parseSummaryBlock(source: string): SummaryBlock | null {
  const fields = parseBlockFields(source, SUMMARY_SCHEMA);
  if (fields === null) return null;
  const scalars = (key: string): string[] | null => {
    const items = fields.lists.get(key) ?? [];
    return items.every((item) => typeof item === "string") ? items as string[] : null;
  };
  const present = (keys: readonly string[]): boolean => keys.some((key) => fields.lists.has(key));
  if (fields.root[K.state] === SUMMARY_STATES.done) {
    const summary = fields.root[K.summary];
    const [done, verified, unverified, left] = DONE_LISTS.map(scalars);
    if (!summary || present([K.progress, K.waiting]) || !done || !verified || !unverified || !left) return null;
    return { state: "done", summary, done, verified, unverified, left };
  }
  if (fields.root[K.state] === SUMMARY_STATES.waiting) {
    const progress = scalars(K.progress);
    const entries = fields.lists.get(K.waiting) ?? [];
    if (fields.root[K.summary] !== undefined || present(DONE_LISTS) || !progress || entries.length === 0) return null;
    const waiting: SummaryWait[] = [];
    for (const entry of entries) {
      if (typeof entry === "string") return null;
      const { kind, title } = entry as BlockEntry;
      if (!isWaitKind(kind) || !title) return null;
      waiting.push({ kind, title });
    }
    return { state: "waiting", progress, waiting };
  }
  return null;
}
