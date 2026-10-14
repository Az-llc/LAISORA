export interface AskOption {
  label: string;
  effect: string;
  pros: string;
  cons: string;
  recommended?: true;
}

export interface AskStep {
  do: string;
  look: string;
}

export type AskBlock = { title: string; why: string; default: string; details?: string } & (
  | { kind: "decide"; options: AskOption[] }
  | { kind: "check"; steps: AskStep[] }
);

function scalar(raw: string, multiline = false): string | null {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f]/.test(value)) return null;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      const forbidden = multiline ? /[\u0000-\u0009\u000b-\u001f]/ : /[\u0000-\u001f]/;
      return typeof parsed === "string" && parsed.trim() && !forbidden.test(parsed) ? parsed : null;
    } catch { return null; }
  }
  if (/^[|>&*!]/.test(value)) return null;
  return value;
}

export interface PlanBlock { goal: string }

export function normalizeAskText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

export interface AskTextFeatures {
  readonly normalized: string;
  readonly bigrams: ReadonlyMap<string, number>;
}

export function askTextFeatures(text: string): AskTextFeatures {
  const normalized = normalizeAskText(text);
  const bigrams = new Map<string, number>();
  for (let i = 0; i < normalized.length - 1; i++) bigrams.set(normalized.slice(i, i + 2), (bigrams.get(normalized.slice(i, i + 2)) ?? 0) + 1);
  return { normalized, bigrams };
}

export function bigramSimilarity(a: AskTextFeatures, b: AskTextFeatures): number {
  if (a.normalized.length < 2 || b.normalized.length < 2) return a.normalized === b.normalized ? 1 : 0;
  let shared = 0;
  for (const [bigram, count] of a.bigrams) shared += Math.min(count, b.bigrams.get(bigram) ?? 0);
  return (2 * shared) / (a.normalized.length - 1 + b.normalized.length - 1);
}

export const ASK_RESTATEMENT_SIMILARITY_MIN = 0.7;
export const ASK_RESTATEMENT_CONTAINMENT_MIN_RATIO = 0.6;

export const ASK_FACT_MARKERS: readonly RegExp[] = [
  /\p{Nd}/u,
  /`[^`]+`|「[^」]+」|『[^』]+』|"[^"]+"|“[^”]+”/u,
  /[\w.-]+[\\/][\w.-]+/u,
  /\b\w{2,}\.[A-Za-z0-9]{1,5}\b/u,
  /\b[a-z]+[A-Z]\w*|\b[A-Za-z]+_\w+|#[A-Za-z]\w*/u,
  /契約|台帳|仕様|ログ|記録|実測|\b(?:contracts?|ledger|logs?|records?|specs?|docs)\b/iu,
];

export const ASK_EMBEDDED_LATIN_WORD = /[A-Za-z]{2,}/u;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

export const ASK_WHY_NEED_PATTERN = /(?:を|か|かどうか|ことを|ものを)(?:ここで|いま|今|先に)?(?:決め|確かめ|はっきりさせ|確認し)(?:る必要があ|たい|るため|ておきたい|ます|る段階)|\b(?:need|needs|have|has|want) to (?:decide|confirm|choose|settle)\b|\bmust (?:decide|confirm|choose)\b|\bmatters? now\b/iu;

function hasFactMarker(why: string): boolean {
  return ASK_FACT_MARKERS.some((marker) => marker.test(why)) || (NON_LATIN_LETTER.test(why) && ASK_EMBEDDED_LATIN_WORD.test(why));
}

function restates(text: string, subject: string): boolean {
  const a = askTextFeatures(text);
  const b = askTextFeatures(subject);
  if (a.normalized === "" || b.normalized === "") return false;
  const [shorter, longer] = a.normalized.length <= b.normalized.length ? [a, b] : [b, a];
  return (longer.normalized.includes(shorter.normalized) && shorter.normalized.length >= ASK_RESTATEMENT_CONTAINMENT_MIN_RATIO * longer.normalized.length)
    || bigramSimilarity(a, b) >= ASK_RESTATEMENT_SIMILARITY_MIN;
}

export type AskQualityIssue =
  | { kind: "why-restates-title" }
  | { kind: "why-states-only-need" }
  | { kind: "effect-restates-label"; label: string };

export function askQualityIssues(ask: AskBlock): AskQualityIssue[] {
  if (ask.kind !== "decide") return [];
  const issues: AskQualityIssue[] = [];
  if (restates(ask.why, ask.title)) issues.push({ kind: "why-restates-title" });
  if (ASK_WHY_NEED_PATTERN.test(ask.why) && !hasFactMarker(ask.why)) issues.push({ kind: "why-states-only-need" });
  for (const option of ask.options) if (restates(option.effect, option.label)) issues.push({ kind: "effect-restates-label", label: option.label });
  return issues;
}

export function parseAskBlock(source: string): AskBlock | null {
  return parseBlock(source, "ask") as AskBlock | null;
}

export function parsePlanBlock(source: string): PlanBlock | null {
  return parseBlock(source, "plan") as PlanBlock | null;
}

function parseBlock(source: string, type: "ask" | "plan"): AskBlock | PlanBlock | null {
  const root: Record<string, string> = Object.create(null);
  const entries: Record<string, string>[] = [];
  let list: "options" | "steps" | undefined;
  let inList = false;
  let entry: Record<string, string> | undefined;
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const match = /^( *)(- )?([a-z]+):(?: (.*))?$/.exec(line);
    if (!match) return null;
    const [, indent, dash, key, raw = ""] = match;
    if (indent.length === 0 && !dash) {
      inList = false;
      if (type === "ask" && (key === "options" || key === "steps")) {
        if (list || raw.trim()) return null;
        list = key;
        inList = true;
      } else {
        if (!(type === "plan" ? ["goal"] : ["kind", "title", "why", "details", "default"]).includes(key) || Object.hasOwn(root, key)) return null;
        const value = scalar(raw, key === "details");
        if (value === null) return null;
        root[key] = value;
      }
      continue;
    }
    if (!inList || !list) return null;
    if (indent.length === 2 && dash) {
      entry = Object.create(null) as Record<string, string>;
      entries.push(entry);
    } else if (indent.length !== 4 || dash || !entry) return null;
    if (!entry || Object.hasOwn(entry, key)) return null;
    if (!(list === "options" ? ["label", "effect", "pros", "cons", "recommended"] : ["do", "look"]).includes(key)) return null;
    const value = scalar(raw);
    if (value === null || (key === "recommended" && raw !== "true")) return null;
    entry[key] = value;
  }
  if (type === "plan") return root.goal ? { goal: root.goal } : null;
  if (!root.title || !root.why || !root.default || entries.length === 0) return null;
  const base = { title: root.title, why: root.why, default: root.default, ...(root.details ? { details: root.details } : {}) };
  if (root.kind === "decide" && list === "options" && entries.every((e) => e.label && e.effect && e.pros && e.cons)) {
    return { ...base, kind: "decide", options: entries.map((e) => ({ label: e.label, effect: e.effect, pros: e.pros, cons: e.cons, ...(e.recommended ? { recommended: true as const } : {}) })) };
  }
  if (root.kind === "check" && list === "steps" && entries.every((e) => e.do && e.look)) {
    return { ...base, kind: "check", steps: entries.map((e) => ({ do: e.do, look: e.look })) };
  }
  return null;
}
