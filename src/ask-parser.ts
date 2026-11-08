import * as l10n from "@vscode/l10n";

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

export const askOtherChoice = (): string => l10n.t("Other");

export function askOptionLetter(index: number): string {
  let letter = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letter = String.fromCharCode(65 + (n - 1) % 26) + letter;
  return letter;
}

const ASK_ANSWER_ARROW = " → ";
const ASK_ANSWER_COLON = ":";
const ASK_ANSWER_NEXT_LINE = new RegExp(`\\r?\\n[^\\r\\n]*${ASK_ANSWER_ARROW}`);
export const ASK_ANSWER_TITLE_JOINED = /[\p{L}\p{N}]/u;
const ASK_ANSWER_COLONS = `${ASK_ANSWER_COLON}：`;
const ASK_ANSWER_HEAD = new RegExp(`^([^\\r\\n${ASK_ANSWER_COLONS}]*)[${ASK_ANSWER_COLONS}][ \\t]?`);

function titleStartsAt(text: string, title: string, at: number): boolean {
  if (at < 0 || !text.startsWith(askAnswerPrefix(title), at)) return false;
  const before = [...text.slice(Math.max(0, at - 2), at)].at(-1);
  return before === undefined || !ASK_ANSWER_TITLE_JOINED.test(before);
}

export function askAnswerPrefix(title: string): string {
  return `${title}${ASK_ANSWER_ARROW}`;
}

export function askAnswerLine(title: string, choice: string, answer: string): string {
  return `${askAnswerPrefix(title)}${choice}${ASK_ANSWER_COLON} ${answer}`;
}

export class AskAnswerTitles {
  private readonly titles: readonly string[];
  private readonly longer = new Map<string, readonly string[]>();

  constructor(titles: Iterable<string>) {
    this.titles = [...new Set(titles)];
  }

  longerThan(title: string): readonly string[] {
    let found = this.longer.get(title);
    if (found === undefined) this.longer.set(title, found = this.titles.filter(other => other.length > title.length && other.endsWith(title)));
    return found;
  }
}

const NO_OTHER_TITLES = new AskAnswerTitles([]);

export function askAnswerChoices(title: string, text: string, titles: AskAnswerTitles = NO_OTHER_TITLES): string[] {
  const prefix = askAnswerPrefix(title);
  const longer = titles.longerThan(title);
  const choices: string[] = [];
  for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, at + 1)) {
    if (!titleStartsAt(text, title, at) || longer.some(other => titleStartsAt(text, other, at - (other.length - title.length)))) continue;
    choices.push(text.slice(at + prefix.length));
  }
  return choices;
}

export function askAnswerBody(choice: string): string {
  const next = choice.search(ASK_ANSWER_NEXT_LINE);
  return next < 0 ? choice : choice.slice(0, next);
}

export function askAnswerParts(choice: string): { readonly choice: string; readonly answer: string } | undefined {
  const body = askAnswerBody(choice);
  const head = ASK_ANSWER_HEAD.exec(body);
  return head ? { choice: head[1], answer: body.slice(head[0].length) } : undefined;
}

export const OTHER_REPLY_QUESTION_PATTERN = /[？?]$|分からない|わからない|詳しく|詳細|どういう|なぜ/u;

export function otherReplyAsksBack(choice: string, otherChoice: string): boolean {
  const parts = askAnswerParts(choice);
  return parts?.choice === otherChoice && OTHER_REPLY_QUESTION_PATTERN.test(parts.answer.trim());
}

function scalar(raw: string, multiline = false): string | null {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f]/.test(value)) return null;
  if (value.startsWith('"')) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return value; }
    const forbidden = multiline ? /[\u0000-\u0009\u000b-\u001f]/ : /[\u0000-\u001f]/;
    return typeof parsed === "string" && parsed.trim() && !forbidden.test(parsed) ? parsed : null;
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

export const ASK_BLOCK_LINE = /^( *)(- )?([a-z]+):(?: (.*))?$/;
const PLAN_KEYS = ["goal"] as const;
const ASK_LIST_KEYS = ["options", "steps"] as const;
const ASK_ROOT_KEYS = ["kind", "title", "why", "details", "default", ...ASK_LIST_KEYS] as const;
const OPTION_KEYS = ["label", "effect", "pros", "cons", "recommended"] as const;
const STEP_KEYS = ["do", "look"] as const;
const KEY_TYPO_MIN_LENGTH = 3;
const ASK_KEYS: readonly string[] = [...ASK_ROOT_KEYS, ...OPTION_KEYS, ...STEP_KEYS];

export function isPartialAskLine(line: string): boolean {
  const match = /^ *(?:-(?: ([a-z]*))?|([a-z]+))$/.exec(line) ?? /^ {0,3}[`~]{1,2}$/.exec(line);
  if (!match) return false;
  const word = match[1] ?? match[2];
  return word === undefined || ASK_KEYS.some((key) => key.startsWith(word));
}

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function blockKey<K extends string>(written: string, allowed: readonly K[], present: readonly string[]): K | undefined {
  const open = allowed.filter((key) => !present.includes(key));
  const exact = allowed.find((key) => key === written);
  if (exact !== undefined) return open.includes(exact) ? exact : undefined;
  if (written.length < KEY_TYPO_MIN_LENGTH) return undefined;
  const near = open.filter((key) => oneEditApart(written, key));
  return near.length === 1 ? near[0] : undefined;
}

function parseBlock(source: string, type: "ask" | "plan"): AskBlock | PlanBlock | null {
  const root: Record<string, string> = Object.create(null);
  const entries: Record<string, string>[] = [];
  let list: "options" | "steps" | undefined;
  let inList = false;
  let entry: Record<string, string> | undefined;
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const match = ASK_BLOCK_LINE.exec(line);
    if (!match) return null;
    const [, indent, dash, written, raw = ""] = match;
    if (indent.length === 0 && !dash) {
      inList = false;
      const allowed = type === "plan" ? PLAN_KEYS : ASK_ROOT_KEYS;
      const same = blockKey(written, allowed, []);
      if (same !== undefined && Object.hasOwn(root, same) && root[same] === scalar(raw, same === "details")) continue;
      const key = blockKey(written, allowed, [...Object.keys(root), ...(list ? ASK_LIST_KEYS : [])]);
      if (key === "options" || key === "steps") {
        if (list || raw.trim()) return null;
        list = key;
        inList = true;
      } else {
        if (key === undefined) return null;
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
    if (!entry) return null;
    const allowed = list === "options" ? OPTION_KEYS : STEP_KEYS;
    const same = blockKey(written, allowed, []);
    if (same !== undefined && Object.hasOwn(entry, same) && entry[same] === scalar(raw)) continue;
    const key = blockKey(written, allowed, Object.keys(entry));
    if (key === undefined) return null;
    const value = scalar(raw);
    if (value === null) return null;
    if (key === "recommended" && value !== "true") continue;
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
