import MarkdownIt, { type Token } from "markdown-it";
import { askQualityIssues, parseAskBlock, parsePlanBlock, type AskBlock, type AskQualityIssue } from "./ask-parser";
import { DEFAULT_SYSTEM_APP_EXTENSIONS } from "./file-link-open-mode";
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
  | { type: "ask"; ask: AskBlock; offset: number; rejected?: true }
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

export const ASK_FENCE_INFO = "laisora-ask";
export const ASK_REJECTED_FENCE_INFO = "laisora-ask rejected";
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

function isAskFenceInfo(info: string): boolean {
  const trimmed = info.trim();
  return trimmed === ASK_FENCE_INFO || trimmed === ASK_REJECTED_FENCE_INFO;
}

function askFences(src: string): { ask: AskBlock; startLine: number; endLine: number }[] {
  return md.parse(src, {}).flatMap((token) => {
    if (token.type !== "fence" || !isAskFenceInfo(token.info) || !token.map) return [];
    const ask = parseAskBlock(token.content);
    return ask ? [{ ask, startLine: token.map[0], endLine: token.map[1] }] : [];
  });
}

export function askBlocksIn(src: string): AskBlock[] {
  return askFences(src).map((fence) => fence.ask);
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
  return problems.length ? `${ASK_QUALITY_DENIAL_HEAD} ${problems.join(" ")} Rewrite each block in full, then continue.` : undefined;
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
  const fences = texts.map((text) => askFences(text));
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
  return texts.map((text, k) => {
    const marks = fences[k].flatMap((fence, index) => rejected.has(`${k}:${index}`) ? [{ fence, hide: laterDecide(k, index) }] : []);
    if (marks.length === 0) return text;
    const lines = text.split("\n");
    const dropped = new Set<number>();
    for (const { fence, hide } of marks) {
      if (hide) for (let line = fence.startLine; line < fence.endLine; line++) dropped.add(line);
      else lines[fence.startLine] = lines[fence.startLine].replace(new RegExp(`${ASK_FENCE_INFO}(?: rejected)?\\s*$`), ASK_REJECTED_FENCE_INFO);
    }
    const kept = lines.filter((_, line) => !dropped.has(line)).join("\n");
    return kept.trim() ? kept : null;
  });
}

export function parseMarkdown(src: string): MdNode[] {
  const tokens = md.parse(src, {});
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
        const plan = token.info.trim() === "laisora-plan" && closed ? parsePlanBlock(token.content) : null;
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
