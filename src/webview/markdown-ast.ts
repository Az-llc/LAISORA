import MarkdownIt, { type Token } from "markdown-it";
import { parseAskBlock, parsePlanBlock, type AskBlock } from "./ask-parser";
import { isClosingFence } from "./commit-boundary";
import { DEFAULT_SYSTEM_APP_EXTENSIONS } from "../file-link-open-mode";
import { parseFileLinkTarget, type FileLinkPlatform, type FileLinkTarget } from "../file-link-target";

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
  lang: string;
  value: string;
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
  | { type: "ask"; ask: AskBlock; offset: number }
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

// R-CNV-12: Windows (stricter) until the Host's init says otherwise.
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
// スキーム無しの一致は www. で始まるものだけ残す。.md / .sh / .py などは実在の国別 TLD なので、
// MEMORY.md や run.sh のようなファイル名が外部ドメインへのリンクになる。core の linkify は null を受けないので配列で返す
const linkifyMatch = md.linkify.match.bind(md.linkify);
md.linkify.match = (text) => (linkifyMatch(text) ?? []).filter((m) => m.schema !== "" || /^www\./i.test(m.raw));

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
        const plan = token.info.trim() === "laisora-plan" && token.map &&
          isClosingFence(lines[token.map[1] - 1] ?? "", token.markup) ? parsePlanBlock(token.content) : null;
        if (plan) {
          const offset = lines.slice(0, token.map?.[0] ?? 0).reduce((n, line) => n + line.length + 1, 0);
          currentContainer().push({ type: "plan", goal: plan.goal, offset });
          continue;
        }
        const lang = token.info ? token.info.trim().split(/\s+/)[0].toLowerCase() : "";
        const ask = token.info.trim() === "laisora-ask" ? parseAskBlock(token.content) : null;
        if (ask) {
          const offset = src.split("\n").slice(0, token.map?.[0] ?? 0).reduce((n, line) => n + line.length + 1, 0);
          currentContainer().push({ type: "ask", ask, offset });
          continue;
        }
        currentContainer().push({
          type: "code_block",
          fenced: true,
          lang,
          value: token.content,
        });
      } else if (token.type === "code_block") {
        currentContainer().push({
          type: "code_block",
          fenced: false,
          lang: "",
          value: token.content,
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
