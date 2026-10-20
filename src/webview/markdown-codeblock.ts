import * as l10n from "@vscode/l10n";
import { closeGlyphButton } from "./close-button";

export const COLLAPSE_LINE_LIMIT = 12;
export const PREVIEW_LINE_COUNT = 8;
export const TAB_SIZE = 4;

export function codeLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function leadingColumns(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += TAB_SIZE - (col % TAB_SIZE);
    else if (ch === "　") col += 2;
    else return col;
  }
  return 0;
}

const SEGMENT_BREAK = /(?<=[/\\])(?=[\w<$.])|(?<=\.)(?=[A-Z<$])/u;

function appendWithBreaks(row: HTMLElement, text: string): void {
  const parts = text.split(SEGMENT_BREAK);
  parts.forEach((part, i) => {
    if (i > 0) row.appendChild(document.createElement("wbr"));
    row.appendChild(document.createTextNode(part));
  });
}

export function renderCodeLines(target: HTMLElement, content: string, className: string): number {
  const lines = codeLines(content);
  const lastTerminated = content.endsWith("\n");
  target.replaceChildren(...lines.map((text, i) => {
    const row = document.createElement("span");
    row.className = className;
    appendWithBreaks(row, text);
    if (i < lines.length - 1 || lastTerminated) row.appendChild(document.createTextNode("\n"));
    const indent = leadingColumns(text);
    if (indent > 0) row.style.setProperty("--code-indent", `${indent}ch`);
    return row;
  }));
  return lines.length;
}

export interface WrapDefault {
  get(): boolean;
  set(wrapped: boolean): void;
}

export interface CodeBlockDeps {
  createCopyButton(className: string, idleTitle: string, source: () => string): { button: HTMLButtonElement; status: HTMLElement };
  wrapDefault: WrapDefault;
}

export interface CodeBlockOptions {
  collapsible: boolean;
  key: string | undefined;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

const CODE_ACTION_ICONS = {
  copy: "M6 5V2.5h7.5V10H11M2.5 5.5H10v8H2.5z",
  check: "M3 8l3 3 7-7",
  error: "M8 3v6M8 12v.5",
  preview: "M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zm9 0a2 2 0 1 0-4 0 2 2 0 0 0 4 0",
  open: "M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4",
  wrap: "M2 3.5h12M2 7h9a3 3 0 0 1 0 6H8m2-2-2 2 2 2M2 10.5h3",
  nowrap: "M2 3.5h12M2 7h12m-2-2 2 2-2 2M2 10.5h7M15 1.5v13",
};

export function codeActionIcon(kind: keyof typeof CODE_ACTION_ICONS): SVGSVGElement {
  const svg = svgElement("svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = svgElement("path");
  path.setAttribute("d", CODE_ACTION_ICONS[kind]);
  svg.appendChild(path);
  return svg;
}

function lineCountText(count: number): string {
  return count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
}

function blockLabel(lang: string | undefined, lineCount: number | undefined): string {
  const parts = [lang ?? "", lineCount === undefined ? "" : lineCountText(lineCount)].filter((p) => p !== "");
  return parts.join(" · ");
}

export const MAX_REMEMBERED_CODE_WRAPS = 2000;

const blockWraps = new Map<string, boolean>();

export function codeBlockKey(tabId: string, replyId: string, offset: number): string {
  return JSON.stringify([tabId, replyId, offset]);
}

export function forgetCodeBlockStates(tabId: string, replyId?: string): void {
  for (const key of blockWraps.keys()) {
    const [keyTab, keyReply] = JSON.parse(key) as [string, string, number];
    if (keyTab === tabId && (replyId === undefined || keyReply === replyId)) blockWraps.delete(key);
  }
}

function rememberWrap(key: string, wrapped: boolean): void {
  blockWraps.delete(key);
  blockWraps.set(key, wrapped);
  if (blockWraps.size > MAX_REMEMBERED_CODE_WRAPS) blockWraps.delete(blockWraps.keys().next().value!);
}

function wrapToggle(pre: HTMLElement, deps: CodeBlockDeps, key: string | undefined): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "code-wrap-button";
  button.setAttribute("aria-label", l10n.t("Wrap lines"));
  const apply = (wrapped: boolean): void => {
    pre.classList.toggle("is-wrapped", wrapped);
    button.setAttribute("aria-pressed", String(wrapped));
    button.title = wrapped ? l10n.t("Disable line wrapping") : l10n.t("Wrap lines");
    button.replaceChildren(codeActionIcon(wrapped ? "wrap" : "nowrap"));
  };
  button.addEventListener("click", () => {
    const wrapped = !pre.classList.contains("is-wrapped");
    apply(wrapped);
    if (key !== undefined) rememberWrap(key, wrapped);
    deps.wrapDefault.set(wrapped);
  });
  const remembered = key === undefined ? undefined : blockWraps.get(key);
  const initial = remembered ?? deps.wrapDefault.get();
  if (key !== undefined && remembered === undefined) rememberWrap(key, initial);
  apply(initial);
  return button;
}

const FOCUSABLE_CODE_CONTROLS = ["code-wrap-button", "code-copy-button", "codeblock-open", "artifact-preview-button"];

export interface CodeFocus {
  key: string;
  control: string | undefined;
}

function findCodeBlock(root: ParentNode, key: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("pre.codeblock[data-code-key]")).find((pre) => pre.dataset.codeKey === key);
}

export function captureCodeFocus(container: HTMLElement): CodeFocus | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return undefined;
  const pre = active.closest<HTMLElement>("pre.codeblock[data-code-key]");
  if (!pre?.dataset.codeKey) return undefined;
  return { key: pre.dataset.codeKey, control: active === pre ? undefined : FOCUSABLE_CODE_CONTROLS.find((c) => active.classList.contains(c)) };
}

export function restoreCodeFocus(root: ParentNode, focus: CodeFocus | undefined): boolean {
  if (focus === undefined) return false;
  const pre = findCodeBlock(root, focus.key);
  if (pre === undefined) return false;
  const target = focus.control === undefined
    ? (pre.classList.contains("is-collapsed") ? pre : pre.querySelector<HTMLElement>(".codeblock-open"))
    : pre.querySelector<HTMLElement>(`.${focus.control}`);
  target?.focus({ preventScroll: true });
  return target !== null && target !== undefined;
}

export function assembleCodeBlock(
  pre: HTMLElement,
  codeEl: HTMLElement,
  actions: HTMLElement,
  lang: string | undefined,
  content: string,
  deps: CodeBlockDeps,
  options: CodeBlockOptions
): void {
  if (options.key !== undefined) pre.dataset.codeKey = options.key;
  const lineCount = renderCodeLines(codeEl, content, "code-line");
  const collapsed = options.collapsible && lineCount > COLLAPSE_LINE_LIMIT;

  const head = document.createElement("div");
  head.className = "codeblock-head";
  const label = document.createElement("span");
  label.className = "l-label codeblock-lang";
  label.textContent = blockLabel(lang, collapsed ? lineCount : undefined);
  head.appendChild(label);

  const wrap = wrapToggle(pre, deps, options.key);

  const openTitle = l10n.t("Open full view");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "codeblock-open";
  open.title = openTitle;
  open.setAttribute("aria-label", openTitle);
  open.setAttribute("aria-haspopup", "dialog");
  const show = (): void => openCodeReader(collapsed ? pre : open, options.key, lang, content, deps, pre.classList.contains("is-wrapped"));
  open.addEventListener("click", show);

  if (collapsed) {
    pre.classList.add("is-collapsed");
    pre.style.setProperty("--codeblock-preview-lines", String(PREVIEW_LINE_COUNT));
    open.append(openTitle, codeActionIcon("open"));
    head.append(open, actions, wrap);
    pre.tabIndex = 0;
    pre.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === pre) {
        e.preventDefault();
        show();
      }
    });
    const more = document.createElement("button");
    more.type = "button";
    more.className = "codeblock-more";
    more.tabIndex = -1;
    more.setAttribute("aria-hidden", "true");
    more.addEventListener("click", show);
    pre.append(head, codeEl, more);
  } else {
    open.appendChild(codeActionIcon("open"));
    actions.prepend(open);
    head.append(actions, wrap);
    pre.append(head, codeEl);
  }
}

let reader: CodeReader | undefined;

export function openCodeReader(opener: HTMLElement, key: string | undefined, lang: string | undefined, content: string, deps: CodeBlockDeps, wrapped: boolean): void {
  reader ??= new CodeReader(deps);
  reader.open(opener, key, lang, content, wrapped);
}

class CodeReader {
  private readonly root: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly label: HTMLElement;
  private readonly copySlot: HTMLElement;
  private readonly wrap: HTMLButtonElement;
  private readonly max: HTMLButtonElement;
  private readonly close: HTMLButtonElement;
  private readonly code: HTMLElement;
  private content = "";
  private opener: HTMLElement | undefined;
  private openerKey: string | undefined;

  constructor(private readonly deps: CodeBlockDeps) {
    this.root = document.createElement("section");
    this.root.className = "work-inspector code-reader";
    this.root.hidden = true;
    const scrim = document.createElement("div");
    scrim.className = "wi-scrim";
    scrim.addEventListener("click", () => this.hide());
    this.pop = document.createElement("div");
    this.pop.className = "wi-pop";
    this.pop.setAttribute("role", "dialog");
    this.pop.setAttribute("aria-modal", "true");
    this.pop.setAttribute("aria-labelledby", "code-reader-label");
    this.pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.hide();
      }
    });

    const head = document.createElement("header");
    head.className = "wi-head";
    const line = document.createElement("div");
    line.className = "wi-head-line";
    this.label = document.createElement("span");
    this.label.className = "l-label code-reader-label";
    this.label.id = "code-reader-label";
    const actions = document.createElement("div");
    actions.className = "wi-actions code-reader-actions";
    this.copySlot = document.createElement("span");
    this.copySlot.className = "code-reader-copy";
    this.wrap = document.createElement("button");
    this.wrap.type = "button";
    this.wrap.className = "wi-act";
    this.wrap.textContent = l10n.t("Wrap lines");
    this.wrap.addEventListener("click", () => this.setWrapped(!this.code.classList.contains("is-wrapped")));
    this.max = document.createElement("button");
    this.max.type = "button";
    this.max.className = "wi-act wi-max";
    this.max.title = l10n.t("Maximize / restore");
    this.max.setAttribute("aria-label", this.max.title);
    const maxIcon = document.createElement("span");
    maxIcon.className = "wi-max-icon";
    this.max.append(maxIcon);
    this.max.addEventListener("click", () => this.setMaximized(!this.pop.classList.contains("max")));
    this.close = document.createElement("button");
    this.close.type = "button";
    this.close.className = "wi-act wi-close";
    this.close.setAttribute("aria-keyshortcuts", "Escape");
    closeGlyphButton(this.close, l10n.t("Close (Esc)"));
    this.close.addEventListener("click", () => this.hide());
    actions.append(this.copySlot, this.wrap, this.max, this.close);
    line.append(this.label, actions);
    head.appendChild(line);

    const body = document.createElement("div");
    body.className = "wi-body code-reader-body";
    this.code = document.createElement("code");
    this.code.className = "code-reader-code";
    body.appendChild(this.code);
    this.pop.append(head, body);
    this.root.append(scrim, this.pop);
    document.body.appendChild(this.root);
  }

  open(opener: HTMLElement, key: string | undefined, lang: string | undefined, content: string, wrapped: boolean): void {
    this.opener = opener;
    this.openerKey = key;
    this.content = content;
    const { button, status } = this.deps.createCopyButton("wi-act code-reader-copy-button", l10n.t("Copy code block"), () => this.content);
    this.copySlot.replaceChildren(button, status);
    const lineCount = renderCodeLines(this.code, content, "code-reader-line");
    this.label.textContent = blockLabel(lang, lineCount);
    this.code.style.setProperty("--code-reader-digits", String(String(lineCount).length));
    this.setWrapped(wrapped);
    this.setMaximized(false);
    this.root.hidden = false;
    this.code.parentElement!.scrollTo(0, 0);
    this.close.focus();
  }

  private hide(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    const opener = this.opener;
    const key = this.openerKey;
    this.opener = undefined;
    this.openerKey = undefined;
    if (opener?.isConnected) opener.focus();
    else if (key !== undefined) restoreCodeFocus(document, { key, control: undefined });
  }

  private setWrapped(wrapped: boolean): void {
    this.code.classList.toggle("is-wrapped", wrapped);
    this.wrap.setAttribute("aria-pressed", String(wrapped));
  }

  private setMaximized(maximized: boolean): void {
    this.pop.classList.toggle("max", maximized);
    this.max.setAttribute("aria-pressed", String(maximized));
  }
}
