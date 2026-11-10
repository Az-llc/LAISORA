import MarkdownIt, { type Token } from "markdown-it";
import { ASK_BLOCK_LINE, askQualityIssues, isPartialAskLine, parseAskBlock, parsePlanBlock, type AskBlock, type AskOption, type AskQualityIssue, type AskStep } from "./ask-parser";
import { afterAnyPlainAskMark, afterPlainAskMark, isPlainAskMarkOnly, opensPlainAsk, PLAIN_ASK_CONS_MARKS, PLAIN_ASK_HEADING, PLAIN_ASK_MARK, PLAIN_ASK_PROS_MARKS, withoutPlainAskMarkAtEnds } from "./ask-plain-form";
import { fenceOpening, isClosingFence } from "./commit-boundary";
import { DEFAULT_SYSTEM_APP_EXTENSIONS } from "./file-link-open-mode";
import { IMPROVEMENT_VERDICTS_FENCE } from "./improvement-brief";
import { parseFileLinkTarget, type FileLinkPlatform, type FileLinkTarget } from "./file-link-target";

export type TableAlign = "left" | "center" | "right" | undefined;

export interface MdHeadingNode {
  type: "heading";
  level: number;
  children: MdNode[];
}

export interface MdParagraphNode {
  type: "paragraph";
  tight?: boolean;
  children: MdNode[];
}

export interface MdTextNode {
  type: "text";
  value: string;
}

export interface MdStrongNode {
  type: "strong";
  children: MdNode[];
}

export interface MdEmNode {
  type: "em";
  children: MdNode[];
}

export interface MdDelNode {
  type: "del";
  children: MdNode[];
}

export interface MdCodeInlineNode {
  type: "code_inline";
  value: string;
}

export interface MdCodeBlockNode {
  type: "code_block";
  fenced: boolean;
  closed: boolean;
  lang: string;
  value: string;
  offset: number;
}

export interface MdListNode {
  type: "list";
  ordered: boolean;
  start: number;
  children: MdNode[];
}

export interface MdListItemNode {
  type: "list_item";
  checked?: boolean;
  children: MdNode[];
}

export interface MdBlockquoteNode {
  type: "blockquote";
  children: MdNode[];
}

export interface MdHrNode {
  type: "hr";
}

export interface MdLinkNode {
  type: "link";
  href: string;
  title?: string;
  children: MdNode[];
}

export interface MdTableCellNode {
  type: "table_cell";
  header: boolean;
  align?: TableAlign;
  children: MdNode[];
}

export interface MdTableRowNode {
  type: "table_row";
  children: MdTableCellNode[];
}

export interface MdTableNode {
  type: "table";
  align: TableAlign[];
  head: MdTableRowNode;
  body: MdTableRowNode[];
}

export interface MdSoftbreakNode {
  type: "softbreak";
}

export interface MdHardbreakNode {
  type: "hardbreak";
}

export type MdNode =
  | { type: "plan"; goal: string; offset: number }
  | { type: "ask"; ask: AskBlock; offset: number; rejected?: true; plain?: true }
  | { type: "todoSplit"; item: string; reason: string; offset: number }
  | MdHeadingNode
  | MdParagraphNode
  | MdTextNode
  | MdStrongNode
  | MdEmNode
  | MdDelNode
  | MdCodeInlineNode
  | MdCodeBlockNode
  | MdListNode
  | MdListItemNode
  | MdBlockquoteNode
  | MdHrNode
  | MdLinkNode
  | MdTableNode
  | MdTableRowNode
  | MdTableCellNode
  | MdSoftbreakNode
  | MdHardbreakNode;

const hostPlatform: FileLinkPlatform = { windows: true };
let fileLinkSystemAppExtensions = new Set(DEFAULT_SYSTEM_APP_EXTENSIONS);
export function setFileLinkSystemAppExtensions(extensions?: readonly string[]): void {
  fileLinkSystemAppExtensions = new Set(extensions ?? DEFAULT_SYSTEM_APP_EXTENSIONS);
}
export function fileLinkDisplayKind(target: string): "file" | "folder" | "app" {
  const resource = parseHostFileLinkTarget(target)?.resource ?? target;
  const segment = resource.split(/[\\/]/).at(-1) ?? "";
  if (/[\\/]$/.test(resource) || !segment.includes(".")) return "folder";
  const extension = segment.slice(segment.lastIndexOf(".")).toLowerCase();
  return fileLinkSystemAppExtensions.has(extension) ? "app" : "file";
}
export function setFileLinkHostPlatform(windows: boolean): void {
  hostPlatform.windows = windows;
}
export function parseHostFileLinkTarget(target: string): FileLinkTarget | null {
  return parseFileLinkTarget(target, hostPlatform);
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
const defaultValidateLink = md.validateLink.bind(md);
md.validateLink = (url) => defaultValidateLink(url) || parseHostFileLinkTarget(url)?.kind === "file-uri";
md.linkify.set({ fuzzyLink: true, fuzzyEmail: true });
const linkifyMatch = md.linkify.match.bind(md.linkify);
md.linkify.match = (text) => (linkifyMatch(text) ?? []).filter((m) => m.schema !== "" || /^www\./i.test(m.raw));

function fenceClosed(token: Token): boolean {
  if (token.map === null) return false;
  const content = token.content;
  const contentLines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return token.map[1] - token.map[0] - 1 > contentLines;
}

function blockOffset(lines: string[], token: Token): number {
  return lines.slice(0, token.map?.[0] ?? 0).reduce((n, line) => n + line.length + 1, 0);
}

function extractAlign(token: Token): TableAlign {
  const style = token.attrGet("style");
  if (typeof style !== "string") return undefined;
  const m = style.match(/text-align:\s*(left|center|right)/i);
  return m ? (m[1].toLowerCase() as "left" | "center" | "right") : undefined;
}

function parseInlineTokens(tokens: Token[]): MdNode[] {
  const rootChildren: MdNode[] = [];
  const stack: { node: MdNode & { children?: MdNode[] } }[] = [];

  const currentContainer = (): MdNode[] => {
    if (stack.length > 0) {
      const top = stack[stack.length - 1].node;
      if ("children" in top && Array.isArray(top.children)) {
        return top.children;
      }
    }
    return rootChildren;
  };

  for (const token of tokens) {
    if (token.nesting === 1) {
      let node: MdNode & { children?: MdNode[] };
      if (token.type === "strong_open") {
        node = { type: "strong", children: [] };
      } else if (token.type === "em_open") {
        node = { type: "em", children: [] };
      } else if (token.type === "s_open") {
        node = { type: "del", children: [] };
      } else if (token.type === "link_open") {
        const href = String(token.attrGet("href") ?? "");
        const rawTitle = token.attrGet("title");
        const title = rawTitle !== null && rawTitle !== undefined ? String(rawTitle) : undefined;
        node = { type: "link", href, title, children: [] };
      } else {
        node = { type: "paragraph", tight: true, children: [] };
      }
      currentContainer().push(node);
      if ("children" in node && Array.isArray(node.children)) {
        stack.push({ node });
      }
    } else if (token.nesting === -1) {
      if (stack.length > 0) {
        stack.pop();
      }
    } else {
      if (token.type === "text") {
        currentContainer().push({ type: "text", value: token.content });
      } else if (token.type === "code_inline") {
        currentContainer().push({ type: "code_inline", value: token.content });
      } else if (token.type === "softbreak") {
        currentContainer().push({ type: "softbreak" });
      } else if (token.type === "hardbreak") {
        currentContainer().push({ type: "hardbreak" });
      } else if (token.type === "image") {
        const src = String(token.attrGet("src") ?? "");
        const alt =
          token.children && token.children.length > 0
            ? token.children.map((c) => c.content).join("")
            : (token.content ?? "");
        if (src) {
          currentContainer().push({
            type: "link",
            href: src,
            children: [{ type: "text", value: alt }],
          });
        } else {
          currentContainer().push({
            type: "text",
            value: `![${alt}](${src})`,
          });
        }
      } else if (token.type === "html_inline") {
        currentContainer().push({ type: "text", value: token.content ?? "" });
      } else {
        currentContainer().push({ type: "text", value: token.content ?? "" });
      }
    }
  }
  return rootChildren;
}

interface TableBuilder {
  headRows: MdTableRowNode[];
  bodyRows: MdTableRowNode[];
  section: "head" | "body" | null;
  currentRow: MdTableCellNode[] | null;
  currentCell: MdTableCellNode | null;
}

const ASK_FENCE_INFO = "laisora-ask";
export const ASK_REJECTED_FENCE_INFO = `${ASK_FENCE_INFO} rejected`;
export const TODO_SPLIT_FENCE_INFO = "laisora-todo-split";
const TODO_SPLIT_REASON_MAX = 500;

function parseTodoSplit(content: string): { item: string; reason: string } | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { item, reason } = value as Record<string, unknown>;
    return typeof item === "string" && /^[0-9a-f]{1,64}$/.test(item) && typeof reason === "string" && reason.trim().length > 0
      ? { item, reason: reason.trim().slice(0, TODO_SPLIT_REASON_MAX) } : null;
  } catch {
    return null;
  }
}

export const PLAN_FENCE_INFO = "laisora-plan";
const LAISORA_FENCE_PREFIX = "laisora-";
const NON_ASK_LAISORA_FENCES: readonly string[] = [PLAN_FENCE_INFO, TODO_SPLIT_FENCE_INFO, IMPROVEMENT_VERDICTS_FENCE];
const FENCE_INFO_ANYWHERE = /(?:`{3,}|~{3,})([^\n`]*)/g;
const ASK_FENCE_INFO_AT_END = new RegExp(`${LAISORA_FENCE_PREFIX}\\S*(?: rejected)?\\s*$`);

function isAskFenceInfo(info: string): boolean {
  const trimmed = info.trim();
  return trimmed === ASK_REJECTED_FENCE_INFO || (trimmed.startsWith(LAISORA_FENCE_PREFIX) && !/\s/.test(trimmed) && !NON_ASK_LAISORA_FENCES.includes(trimmed));
}

export function mayHoldAskBlock(text: string): boolean {
  return [...text.matchAll(FENCE_INFO_ANYWHERE)].some((match) => isAskFenceInfo(match[1])) || opensPlainAsk(text);
}

export interface PlainAsk { readonly ask: AskBlock; readonly rejected: boolean; readonly end: number; readonly startLine: number; readonly endLine: number }

function optionHead(inline: Token): { label: string; recommended: boolean } | undefined {
  const star = PLAIN_ASK_MARK.recommended;
  const children = (inline.children ?? []).filter((child) => child.type !== "text" || child.content !== "");
  const before = children[0]?.type === "text" && isPlainAskMarkOnly(children[0].content, star);
  const open = before ? 1 : 0;
  if (children[open]?.type !== "strong_open") return undefined;
  let depth = 0;
  let close = -1;
  for (let k = open; k < children.length && close < 0; k++) {
    if (children[k].type === "strong_open") depth++;
    else if (children[k].type === "strong_close" && --depth === 0) close = k;
  }
  if (close < 0) return undefined;
  const written = children.slice(open + 1, close).map((child) => child.type === "softbreak" || child.type === "hardbreak" ? " " : child.content).join("").trim();
  const label = withoutPlainAskMarkAtEnds(written, star);
  const rest = children.slice(close + 1);
  const after = rest.length === 1 && rest[0].type === "text" && isPlainAskMarkOnly(rest[0].content, star);
  if (label === "" || label.includes(star) || (rest.length > 0 && !after)) return undefined;
  return { label, recommended: before || after || label !== written };
}

export function plainAskAt(tokens: readonly Token[], start: number): PlainAsk | null {
  const head = tokens[start];
  if (head?.type !== "heading_open" || head.markup !== PLAIN_ASK_HEADING || head.map === null || tokens[start + 2]?.type !== "heading_close") return null;
  const level = head.level;
  const heading = tokens[start + 1]?.content ?? "";
  const decideTitle = afterPlainAskMark(heading, PLAIN_ASK_MARK.decide);
  const rejectedTitle = afterPlainAskMark(heading, PLAIN_ASK_MARK.rejected);
  const checkTitle = afterPlainAskMark(heading, PLAIN_ASK_MARK.check);
  const title = decideTitle ?? rejectedTitle ?? checkTitle;
  if (!title) return null;
  const kind = checkTitle !== undefined ? "check" : "decide";
  const paragraphAt = (i: number, at: number): string | undefined =>
    tokens[i]?.type === "paragraph_open" && tokens[i].level === at && tokens[i + 1]?.type === "inline" && tokens[i + 2]?.type === "paragraph_close" ? tokens[i + 1].content : undefined;
  let i = start + 3;
  const why: string[] = [];
  for (let text = paragraphAt(i, level); text !== undefined; text = paragraphAt(i, level)) {
    why.push(text);
    i += 3;
  }
  if (why.length === 0) return null;
  let details: string | undefined;
  if (tokens[i]?.type === "blockquote_open" && tokens[i].level === level) {
    const parts: string[] = [];
    i++;
    for (let text = paragraphAt(i, level + 1); text !== undefined; text = paragraphAt(i, level + 1)) {
      parts.push(text);
      i += 3;
    }
    if (parts.length === 0 || tokens[i]?.type !== "blockquote_close") return null;
    details = parts.join("\n\n");
    i++;
  }
  const bulletsAt = (at: number, base: number): { bullets: string[]; next: number } | null => {
    if (tokens[at]?.type !== "bullet_list_open" || tokens[at].level !== base) return null;
    let k = at + 1;
    const bullets: string[] = [];
    while (tokens[k]?.type === "list_item_open") {
      const text = paragraphAt(k + 1, base + 2);
      if (text !== undefined && tokens[k + 4]?.type === "list_item_close") {
        bullets.push(text);
        k += 5;
        continue;
      }
      const marked = tokens[k + 2];
      const nested = tokens[k + 1]?.type === "bullet_list_open" && marked?.type === "list_item_open" ? paragraphAt(k + 3, base + 4) : undefined;
      if (nested === undefined || tokens[k + 6]?.type !== "list_item_close" || tokens[k + 7]?.type !== "bullet_list_close" || tokens[k + 8]?.type !== "list_item_close"
        || ![...PLAIN_ASK_PROS_MARKS, ...PLAIN_ASK_CONS_MARKS].includes(marked.markup)) return null;
      bullets.push(`${marked.markup} ${nested}`);
      k += 9;
    }
    return tokens[k]?.type === "bullet_list_close" ? { bullets, next: k + 1 } : null;
  };
  const items: { head: Token; bullets?: string[] }[] = [];
  let listEndLine = -1;
  while (tokens[i]?.type === "ordered_list_open" && tokens[i].level === level) {
    listEndLine = tokens[i].map?.[1] ?? -1;
    i++;
    while (tokens[i]?.type === "list_item_open") {
      const itemHead = tokens[i + 2];
      if (paragraphAt(i + 1, level + 2) === undefined) return null;
      i += 4;
      let bullets: string[] | undefined;
      if (tokens[i]?.type === "bullet_list_open") {
        const nested = bulletsAt(i, level + 2);
        if (nested === null) return null;
        bullets = nested.bullets;
        i = nested.next;
      }
      if (tokens[i]?.type !== "list_item_close") return null;
      i++;
      items.push({ head: itemHead, bullets });
    }
    if (tokens[i]?.type !== "ordered_list_close") return null;
    i++;
    if (tokens[i]?.type === "bullet_list_open" && tokens[i].level === level) {
      const last = items.at(-1);
      const sibling = bulletsAt(i, level);
      if (last === undefined || last.bullets !== undefined || sibling === null) return null;
      listEndLine = tokens[i].map?.[1] ?? -1;
      last.bullets = sibling.bullets;
      i = sibling.next;
    }
  }
  if (items.length === 0 || items.some((item) => item.bullets === undefined) || listEndLine < 0) return null;
  let fallback = afterPlainAskMark(paragraphAt(i, level) ?? "", PLAIN_ASK_MARK.default);
  let end = i + 2;
  let endLine = tokens[i]?.map?.[1] ?? -1;
  if (fallback === undefined) {
    const bullets = items.at(-1)!.bullets!;
    const lines = bullets.at(-1)!.split("\n");
    const at = lines.findIndex((line, k) => k > 0 && afterPlainAskMark(line, PLAIN_ASK_MARK.default) !== undefined);
    if (at < 0) return null;
    bullets[bullets.length - 1] = lines.slice(0, at).join("\n");
    fallback = afterPlainAskMark(lines.slice(at).join("\n"), PLAIN_ASK_MARK.default);
    end = i - 1;
    endLine = listEndLine;
  }
  if (!fallback || endLine < 0) return null;
  const base = { title, why: why.join("\n\n"), default: fallback, ...(details ? { details } : {}) };
  const span = { rejected: rejectedTitle !== undefined, end, startLine: head.map[0], endLine };
  if (kind === "check") {
    const steps: AskStep[] = [];
    for (const { head: itemHead, bullets = [] } of items) {
      const look = bullets.length === 1 ? afterPlainAskMark(bullets[0], PLAIN_ASK_MARK.look) : undefined;
      const action = itemHead.content.trim();
      if (!look || !action) return null;
      steps.push({ do: action, look });
    }
    return { ask: { ...base, kind: "check", steps }, ...span };
  }
  const options: AskOption[] = [];
  for (const { head: itemHead, bullets = [] } of items) {
    const optionLabel = optionHead(itemHead);
    if (optionLabel === undefined || bullets.length !== 3) return null;
    const { label, recommended } = optionLabel;
    const parts = bullets.map((bullet) => {
      const pros = afterAnyPlainAskMark(bullet, PLAIN_ASK_PROS_MARKS);
      if (pros !== undefined) return { key: "pros", text: pros };
      const cons = afterAnyPlainAskMark(bullet, PLAIN_ASK_CONS_MARKS);
      return cons !== undefined ? { key: "cons", text: cons } : { key: "effect", text: bullet.trim() };
    });
    const field = (key: string): string | undefined => {
      const found = parts.filter((part) => part.key === key);
      return found.length === 1 && found[0].text ? found[0].text : undefined;
    };
    const effect = field("effect"), pros = field("pros"), cons = field("cons");
    if (!effect || !pros || !cons) return null;
    options.push({ label, effect, pros, cons, ...(recommended ? { recommended: true as const } : {}) });
  }
  return { ask: { ...base, kind: "decide", options }, ...span };
}

const withoutCr = (line: string): string => line.endsWith("\r") ? line.slice(0, -1) : line;

function fenceLeftOpen(lines: readonly string[], from: number, marker: string): boolean {
  for (let k = from; k < lines.length; k++) {
    if (isClosingFence(withoutCr(lines[k]), marker)) return false;
    if (fenceOpening(withoutCr(lines[k]))?.info.trim()) return true;
  }
  return !(from === lines.length - 1 && isPartialAskLine(withoutCr(lines[from])));
}

export function closeAskFences(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const opening = fenceOpening(withoutCr(lines[i]));
    if (!opening) { out.push(lines[i++]); continue; }
    let end = i + 1;
    if (isAskFenceInfo(opening.info)) {
      while (end < lines.length && !isClosingFence(withoutCr(lines[end]), opening.marker) && (!lines[end].trim() || ASK_BLOCK_LINE.test(withoutCr(lines[end])))) end++;
      let last = end;
      while (last > i + 1 && !lines[last - 1].trim()) last--;
      if (end < lines.length && !isClosingFence(withoutCr(lines[end]), opening.marker) && fenceLeftOpen(lines, end, opening.marker) && parseAskBlock(lines.slice(i + 1, last).map(withoutCr).join("\n"))) {
        out.push(...lines.slice(i, last), opening.indent + opening.marker, ...lines.slice(last, end));
        i = end;
        continue;
      }
    }
    while (end < lines.length && !isClosingFence(withoutCr(lines[end]), opening.marker)) end++;
    out.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    i = end + 1;
  }
  return out.join("\n");
}

interface AskSpan { readonly ask: AskBlock; readonly startLine: number; readonly endLine: number; readonly plain: boolean }

function plainAsksIn(src: string, tokens: readonly Token[]): Map<number, PlainAsk> {
  const found = new Map<number, PlainAsk>();
  if (!opensPlainAsk(src)) return found;
  for (let i = 0; i < tokens.length; i++) {
    const plain = tokens[i].type === "heading_open" ? plainAskAt(tokens, i) : null;
    if (plain === null) continue;
    found.set(i, plain);
    i = plain.end;
  }
  return found;
}

function askSpans(source: string): AskSpan[] {
  const src = closeAskFences(source);
  const tokens = md.parse(src, {});
  const plains = plainAsksIn(src, tokens);
  const spans: AskSpan[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const plain = plains.get(i);
    if (plain !== undefined) {
      spans.push({ ask: plain.ask, startLine: plain.startLine, endLine: plain.endLine, plain: true });
      i = plain.end;
      continue;
    }
    if (token.type !== "fence" || !isAskFenceInfo(token.info) || !token.map) continue;
    const ask = parseAskBlock(token.content);
    if (ask) spans.push({ ask, startLine: token.map[0], endLine: token.map[1], plain: false });
  }
  return spans;
}

export function askBlocksIn(src: string): AskBlock[] {
  return askSpans(src).map((span) => span.ask);
}

export const ASK_QUALITY_DENIAL_HEAD = "Rejected before display: these laisora-ask decisions were not shown to the user.";

const rejectedTitleKey = (title: string): string => `${JSON.stringify(title)}: `;

function askQualityProblem(issue: AskQualityIssue): string {
  return issue.kind === "why-restates-title" ? "why restates the title; state what you observed, the exact question and why the user must decide."
    : issue.kind === "why-states-only-need" ? "why only says that a decision is needed; state what you observed (a number, a quoted name, an identifier or the source you checked) and why the user must decide."
    : `the effect of ${JSON.stringify(issue.label)} restates its label; state the concrete change to the user's screen, operation or work.`;
}

export function askQualityDenial(text: string): string | undefined {
  const problems = askBlocksIn(text).flatMap((ask) => {
    const issues = askQualityIssues(ask);
    return issues.length ? [`${rejectedTitleKey(ask.title)}${issues.map(askQualityProblem).join(" ")}`] : [];
  });
  return problems.length ? `${ASK_QUALITY_DENIAL_HEAD} ${problems.join(" ")} Rewrite each block in full, in the same form it was written in (a laisora-ask block or the plain Markdown form), then continue.` : undefined;
}

export function rejectedAskTitles(text: string): string[] {
  return askBlocksIn(text).filter((ask) => askQualityIssues(ask).length > 0).map((ask) => ask.title);
}

export function feedbackRejectedTitles(text: string, feedback: string): string[] {
  return feedback.includes(ASK_QUALITY_DENIAL_HEAD) ? askBlocksIn(text).filter((ask) => feedback.includes(rejectedTitleKey(ask.title))).map((ask) => ask.title) : [];
}

export function isRejectedAsk(ask: AskBlock, titles: readonly string[]): boolean {
  return ask.kind === "decide" && titles.includes(ask.title);
}

export interface AskRejection { readonly upTo: number; readonly titles: readonly string[] }

export function resolveRejectedAsks(texts: readonly string[], rejections: readonly AskRejection[]): (string | null)[] {
  const repaired = texts.map(closeAskFences);
  const fences = repaired.map((text) => askSpans(text));
  const rejected = new Set<string>();
  let from = 0;
  for (const rejection of [...rejections].sort((a, b) => a.upTo - b.upTo)) {
    for (let k = from; k < Math.min(rejection.upTo, texts.length); k++) {
      fences[k].forEach((fence, index) => { if (isRejectedAsk(fence.ask, rejection.titles)) rejected.add(`${k}:${index}`); });
    }
    from = Math.max(from, rejection.upTo);
  }
  const laterDecide = (k: number, index: number): boolean =>
    fences[k].some((fence, i) => i > index && fence.ask.kind === "decide") || fences.slice(k + 1).some((list) => list.some((fence) => fence.ask.kind === "decide"));
  return repaired.map((text, k) => {
    const marks = fences[k].flatMap((fence, index) => rejected.has(`${k}:${index}`) ? [{ fence, hide: laterDecide(k, index) }] : []);
    if (marks.length === 0) return texts[k];
    const lines = text.split("\n");
    const dropped = new Set<number>();
    for (const { fence, hide } of marks) {
      if (hide) for (let line = fence.startLine; line < fence.endLine; line++) dropped.add(line);
      else if (fence.plain) lines[fence.startLine] = lines[fence.startLine].replace(PLAIN_ASK_MARK.decide, PLAIN_ASK_MARK.rejected);
      else lines[fence.startLine] = lines[fence.startLine].replace(ASK_FENCE_INFO_AT_END, ASK_REJECTED_FENCE_INFO);
    }
    const kept = lines.filter((_, line) => !dropped.has(line)).join("\n");
    return kept.trim() ? kept : null;
  });
}

export function parseMarkdown(source: string): MdNode[] {
  const src = closeAskFences(source);
  const tokens = md.parse(src, {});
  const plains = plainAsksIn(src, tokens);
  const rootNodes: MdNode[] = [];
  const stack: { node: MdNode & { children?: MdNode[] }; tableBuilder?: TableBuilder }[] = [];

  const currentContainer = (): MdNode[] => {
    if (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.tableBuilder?.currentCell) {
        return top.tableBuilder.currentCell.children;
      }
      if ("children" in top.node && Array.isArray(top.node.children)) {
        return top.node.children;
      }
    }
    return rootNodes;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    const plain = plains.get(i);
    if (plain !== undefined) {
      currentContainer().push({ type: "ask", ask: plain.ask, offset: blockOffset(src.split("\n"), token), plain: true, ...(plain.rejected ? { rejected: true as const } : {}) });
      i = plain.end;
      continue;
    }

    if (token.type === "table_open") {
      const tableBuilder: TableBuilder = {
        headRows: [],
        bodyRows: [],
        section: null,
        currentRow: null,
        currentCell: null,
      };
      stack.push({
        node: {
          type: "table",
          align: [],
          head: { type: "table_row", children: [] },
          body: [],
        },
        tableBuilder,
      });
      continue;
    }

    if (token.type === "table_close") {
      const popped = stack.pop();
      if (popped?.tableBuilder) {
        const tb = popped.tableBuilder;
        const headRow = tb.headRows[0] ?? { type: "table_row", children: [] };
        const align = headRow.children.map((c) => c.align);
        const tableNode: MdTableNode = {
          type: "table",
          align,
          head: headRow,
          body: tb.bodyRows,
        };
        currentContainer().push(tableNode);
      }
      continue;
    }

    if (stack.length > 0 && stack[stack.length - 1].tableBuilder) {
      const tb = stack[stack.length - 1].tableBuilder!;
      if (token.type === "thead_open") {
        tb.section = "head";
        continue;
      }
      if (token.type === "thead_close") {
        tb.section = null;
        continue;
      }
      if (token.type === "tbody_open") {
        tb.section = "body";
        continue;
      }
      if (token.type === "tbody_close") {
        tb.section = null;
        continue;
      }
      if (token.type === "tr_open") {
        tb.currentRow = [];
        continue;
      }
      if (token.type === "tr_close") {
        const rowNode: MdTableRowNode = { type: "table_row", children: tb.currentRow ?? [] };
        if (tb.section === "head") tb.headRows.push(rowNode);
        else tb.bodyRows.push(rowNode);
        tb.currentRow = null;
        continue;
      }
      if (token.type === "th_open") {
        tb.currentCell = { type: "table_cell", header: true, align: extractAlign(token), children: [] };
        continue;
      }
      if (token.type === "th_close") {
        if (tb.currentCell && tb.currentRow) tb.currentRow.push(tb.currentCell);
        tb.currentCell = null;
        continue;
      }
      if (token.type === "td_open") {
        tb.currentCell = { type: "table_cell", header: false, align: extractAlign(token), children: [] };
        continue;
      }
      if (token.type === "td_close") {
        if (tb.currentCell && tb.currentRow) tb.currentRow.push(tb.currentCell);
        tb.currentCell = null;
        continue;
      }
      if (token.type === "inline" && tb.currentCell && token.children) {
        tb.currentCell.children.push(...parseInlineTokens(token.children));
        continue;
      }
    }

    if (token.nesting === 1) {
      let node: (MdNode & { children?: MdNode[] }) | null = null;
      if (token.type === "heading_open") {
        const level = Number(token.tag.slice(1)) || 1;
        node = { type: "heading", level, children: [] };
      } else if (token.type === "paragraph_open") {
        const tight = token.hidden === true ? true : undefined;
        node = { type: "paragraph", ...(tight ? { tight: true } : {}), children: [] };
      } else if (token.type === "bullet_list_open") {
        node = { type: "list", ordered: false, start: 1, children: [] };
      } else if (token.type === "ordered_list_open") {
        const start = Number(token.attrGet("start") ?? 1);
        node = { type: "list", ordered: true, start: isNaN(start) ? 1 : start, children: [] };
      } else if (token.type === "list_item_open") {
        node = { type: "list_item", children: [] };
      } else if (token.type === "blockquote_open") {
        node = { type: "blockquote", children: [] };
      } else {
        node = { type: "paragraph", tight: true, children: [] };
      }
      if (node) {
        currentContainer().push(node);
        if ("children" in node && Array.isArray(node.children)) {
          stack.push({ node });
        }
      }
    } else if (token.nesting === -1) {
      if (stack.length > 0) {
        stack.pop();
      }
    } else {
      if (token.type === "inline") {
        if (token.children) {
          if (
            stack.length >= 2 &&
            stack[stack.length - 2].node.type === "list_item" &&
            (stack[stack.length - 2].node as MdListItemNode).checked === undefined &&
            (stack[stack.length - 2].node as MdListItemNode).children.length === 1 &&
            stack[stack.length - 1].node.type === "paragraph" &&
            (stack[stack.length - 1].node as MdParagraphNode).children.length === 0
          ) {
            const match = token.content.match(/^\[( |x|X)\][ \t]/);
            if (match) {
              const listItem = stack[stack.length - 2].node as MdListItemNode;
              listItem.checked = match[1] === "x" || match[1] === "X";
              const inlineNodes = parseInlineTokens(token.children);
              if (inlineNodes.length > 0 && inlineNodes[0].type === "text") {
                inlineNodes[0].value = inlineNodes[0].value.slice(match[0].length);
              }
              currentContainer().push(...inlineNodes);
              continue;
            }
          }
          currentContainer().push(...parseInlineTokens(token.children));
        }
      } else if (token.type === "fence") {
        const lines = src.split("\n");
        const offset = blockOffset(lines, token);
        const closed = fenceClosed(token);
        const plan = token.info.trim() === PLAN_FENCE_INFO && closed ? parsePlanBlock(token.content) : null;
        if (plan) {
          currentContainer().push({ type: "plan", goal: plan.goal, offset });
          continue;
        }
        const split = token.info.trim() === TODO_SPLIT_FENCE_INFO && closed ? parseTodoSplit(token.content) : null;
        if (split) {
          currentContainer().push({ type: "todoSplit", ...split, offset });
          continue;
        }
        const lang = token.info ? token.info.trim().split(/\s+/)[0].toLowerCase() : "";
        const ask = isAskFenceInfo(token.info) ? parseAskBlock(token.content) : null;
        if (ask) {
          currentContainer().push({ type: "ask", ask, offset, ...(token.info.trim() === ASK_REJECTED_FENCE_INFO ? { rejected: true as const } : {}) });
          continue;
        }
        currentContainer().push({
          type: "code_block",
          fenced: true,
          closed,
          lang,
          value: token.content,
          offset,
        });
      } else if (token.type === "code_block") {
        currentContainer().push({
          type: "code_block",
          fenced: false,
          closed: false,
          lang: "",
          value: token.content,
          offset: blockOffset(src.split("\n"), token),
        });
      } else if (token.type === "hr") {
        currentContainer().push({ type: "hr" });
      } else if (token.type === "html_block") {
        currentContainer().push({ type: "text", value: token.content });
      } else {
        currentContainer().push({ type: "text", value: token.content ?? "" });
      }
    }
  }

  return rootNodes;
}
