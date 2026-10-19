import * as l10n from "@vscode/l10n";
import { vscode } from "./dom";
import { renderAsk, renderGoal, type AskRenderContext } from "./ask-view";
import { fileLinkDisplayKind, parseHostFileLinkTarget, parseMarkdown, type MdNode } from "../markdown-ast";
import { assembleCodeBlock, captureCodeFocus, codeActionIcon, codeBlockKey, restoreCodeFocus, svgElement, type CodeBlockDeps } from "./markdown-codeblock";

const artifactIds = new WeakMap<HTMLElement, string[]>();

const codeDeps: CodeBlockDeps = {
  createCopyButton,
  wrapDefault: {
    get: () => vscode.getState()?.codeWrap !== false,
    set: (wrapped) => vscode.setState({ ...(vscode.getState() ?? { activeTabId: null }), codeWrap: wrapped }),
  },
};

const COPY_REVERT_MS = 2000;

export function createCopyButton(
  className: string,
  idleTitle: string,
  source: () => string
): { button: HTMLButtonElement; status: HTMLElement } {
  return createCopyAction(className, idleTitle, () => navigator.clipboard.writeText(source()));
}

const COPY_FILE_PATH_TIMEOUT_MS = 10_000;
let copyFilePathSeq = 0;
const pendingCopyFilePath = new Map<number, (ok: boolean) => void>();

export function handleCopyFilePathResult(reqId: number, ok: boolean): void {
  pendingCopyFilePath.get(reqId)?.(ok);
}

function copyFilePathOnHost(tabId: string, target: string): Promise<void> {
  const reqId = ++copyFilePathSeq;
  return new Promise<void>((resolve, reject) => {
    const settle = (ok: boolean): void => {
      clearTimeout(timer);
      pendingCopyFilePath.delete(reqId);
      if (ok) resolve();
      else reject(new Error("copyFilePath refused"));
    };
    const timer = setTimeout(() => settle(false), COPY_FILE_PATH_TIMEOUT_MS);
    pendingCopyFilePath.set(reqId, settle);
    vscode.postMessage({ type: "copyFilePath", tabId, target, reqId });
  });
}

function createCopyAction(
  className: string,
  idleTitle: string,
  write: () => Promise<void>
): { button: HTMLButtonElement; status: HTMLElement } {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.appendChild(codeActionIcon("copy"));
  button.title = idleTitle;
  button.setAttribute("aria-label", idleTitle);
  const status = document.createElement("span");
  status.className = "code-copy-status";
  status.setAttribute("role", "status");
  let revertTimer: ReturnType<typeof setTimeout> | undefined;
  const revert = (): void => {
    revertTimer = undefined;
    button.replaceChildren(codeActionIcon("copy"));
    delete button.dataset.copyState;
    status.textContent = "";
    button.title = idleTitle;
    button.setAttribute("aria-label", idleTitle);
  };
  let inFlight = false;
  button.addEventListener("click", async () => {
    if (inFlight) return;
    inFlight = true;
    if (revertTimer !== undefined) clearTimeout(revertTimer);
    button.setAttribute("aria-busy", "true");
    try {
      await write();
      button.replaceChildren(codeActionIcon("check"));
      button.dataset.copyState = "copied";
      status.textContent = l10n.t("Copied");
      button.title = l10n.t("Copied");
    } catch {
      button.replaceChildren(codeActionIcon("error"));
      button.dataset.copyState = "failed";
      status.textContent = l10n.t("Copy failed");
      button.title = l10n.t("Copy failed") + ". " + l10n.t("Select the text and copy it manually, or try again.");
    } finally {
      button.setAttribute("aria-label", button.title);
      button.removeAttribute("aria-busy");
      inFlight = false;
      revertTimer = setTimeout(revert, COPY_REVERT_MS);
    }
  });
  return { button, status };
}

function linkKindIcon(kind: "file" | "folder" | "app" | "web" | "mail"): SVGSVGElement {
  const paths = {
    file: "M3 1.75h6l4 4v8.5H3zM9 1.75v4h4",
    folder: "M1.75 4V2.75h4.5l1.5 1.5h6.5v9H1.75z",
    app: "M3 6V1.75h6l4 4v8.5H8M9 1.75v4h4M1.75 10h6m-2.5-2.5L7.75 10l-2.5 2.5",
    web: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM1.9 8h12.2M8 1.75c1.55 1.7 2.35 3.78 2.35 6.25S9.55 12.55 8 14.25M8 1.75C6.45 3.45 5.65 5.53 5.65 8s.8 4.55 2.35 6.25",
    mail: "M2 3.25h12v9.5H2zM2.5 4 8 8.25 13.5 4",
  } as const;
  const svg = svgElement("svg");
  svg.classList.add("link-kind-icon", `link-kind-icon-${kind}`);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = svgElement("path");
  path.setAttribute("d", paths[kind]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.35");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function externalLinkCopyText(url: URL): string {
  if (url.protocol !== "mailto:") return url.href;
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

function appendLinkCopyButton(target: HTMLElement, idleTitle: string, write: () => Promise<void>): void {
  const { button, status } = createCopyAction("link-copy-button", idleTitle, write);
  target.appendChild(button);
  target.appendChild(status);
}

let todoSplitRenderer: ((item: string, reason: string, tabId: string | undefined) => HTMLElement) | null = null;

export function setTodoSplitRenderer(render: ((item: string, reason: string, tabId: string | undefined) => HTMLElement) | null): void {
  todoSplitRenderer = render;
}

export function renderMarkdownInto(container: HTMLElement, src: string, tabId?: string, askContext?: AskRenderContext, options?: { collapseCode?: boolean }): void {
  const collapseCode = options?.collapseCode ?? true;
  const codeReply = tabId !== undefined && askContext !== undefined && askContext.replyId !== "" ? { tabId, replyId: askContext.replyId, offset: askContext.offset ?? 0 } : undefined;
  const codeFocus = captureCodeFocus(container);
  container.textContent = "";
  const containerArtifactIds = artifactIds.get(container) ?? [];
  artifactIds.set(container, containerArtifactIds);
  let fencedIndex = 0;

  const nodes = parseMarkdown(src);

  function renderNode(node: MdNode, target: HTMLElement): void {
    switch (node.type) {
      case "plan": {
        target.appendChild(renderGoal(node.goal, node.offset, askContext));
        fencedIndex++;
        break;
      }
      case "ask": {
        target.appendChild(renderAsk(node.ask, node.offset, askContext, node.rejected === true));
        fencedIndex++;
        break;
      }
      case "todoSplit": {
        const card = todoSplitRenderer?.(node.item, node.reason, tabId) ?? null;
        if (card) target.appendChild(card);
        else renderNode({ type: "code_block", fenced: true, closed: true, lang: "json", value: JSON.stringify({ item: node.item, reason: node.reason }), offset: node.offset }, target);
        break;
      }
      case "heading": {
        const div = document.createElement("div");
        const level = Math.min(Math.max(node.level, 1), 6);
        div.className = `md-h md-h${level}`;
        for (const child of node.children) renderNode(child, div);
        target.appendChild(div);
        break;
      }
      case "paragraph": {
        if (node.tight) {
          for (const child of node.children) renderNode(child, target);
        } else {
          const div = document.createElement("div");
          div.className = "md-line";
          for (const child of node.children) renderNode(child, div);
          target.appendChild(div);
        }
        break;
      }
      case "text": {
        target.append(node.value);
        break;
      }
      case "strong": {
        const strong = document.createElement("strong");
        for (const child of node.children) renderNode(child, strong);
        target.appendChild(strong);
        break;
      }
      case "em": {
        const em = document.createElement("em");
        for (const child of node.children) renderNode(child, em);
        target.appendChild(em);
        break;
      }
      case "del": {
        const del = document.createElement("del");
        for (const child of node.children) renderNode(child, del);
        target.appendChild(del);
        break;
      }
      case "code_inline": {
        const code = document.createElement("code");
        code.className = "inline-code";
        code.textContent = node.value;
        target.appendChild(code);
        break;
      }
      case "code_block": {
        const pre = document.createElement("pre");
        pre.className = "codeblock has-code-actions";
        const lang = node.lang;
        if (lang) pre.dataset.lang = lang;
        const codeEl = document.createElement("code");
        const content = node.value;

        const actions = document.createElement("div");
        actions.className = "artifact-preview-actions";
        const { button: copy, status } = createCopyButton("code-copy-button", l10n.t("Copy code block"), () => content);
        actions.appendChild(copy);
        actions.appendChild(status);
        assembleCodeBlock(pre, codeEl, actions, lang, content, codeDeps, {
          collapsible: collapseCode && node.closed,
          key: codeReply === undefined ? undefined : codeBlockKey(codeReply.tabId, codeReply.replyId, codeReply.offset + node.offset),
        });

        if (node.fenced) {
          if (lang === "html" || lang === "svg") {
            const artifactId = containerArtifactIds[fencedIndex] ?? crypto.randomUUID();
            containerArtifactIds[fencedIndex] = artifactId;
            pre.classList.add("has-artifact-preview");
            const preview = document.createElement("button");
            preview.type = "button";
            preview.className = "artifact-preview-button";
            preview.appendChild(codeActionIcon("preview"));
            preview.title = l10n.t("Preview {0}", lang.toUpperCase());
            preview.setAttribute("aria-label", preview.title);
            preview.addEventListener("click", () => {
              vscode.postMessage({ type: "artifact/preview", lang, content, artifactId });
            });
            actions.appendChild(preview);
          }
          fencedIndex++;
        }
        target.appendChild(pre);
        break;
      }
      case "list": {
        const listEl = document.createElement(node.ordered ? "ol" : "ul");
        if (node.ordered) {
          (listEl as HTMLOListElement).start = node.start;
        }
        for (const child of node.children) renderNode(child, listEl);
        target.appendChild(listEl);
        break;
      }
      case "list_item": {
        const li = document.createElement("li");
        if (node.checked !== undefined) {
          li.className = "md-task";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.disabled = true;
          if (node.checked) input.checked = true;
          li.appendChild(input);
        }
        for (const child of node.children) renderNode(child, li);
        target.appendChild(li);
        break;
      }
      case "blockquote": {
        const bq = document.createElement("blockquote");
        bq.className = "md-quote";
        for (const child of node.children) renderNode(child, bq);
        target.appendChild(bq);
        break;
      }
      case "hr": {
        const hr = document.createElement("hr");
        hr.className = "md-hr";
        target.appendChild(hr);
        break;
      }
      case "link": {
        let externalUrl: URL | undefined;
        try {
          const url = new URL(node.href);
          if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
            externalUrl = url;
          }
        } catch {
          externalUrl = undefined;
        }
        const fileTarget = externalUrl === undefined && tabId !== undefined ? parseHostFileLinkTarget(node.href) : null;
        if (externalUrl !== undefined) {
          const a = document.createElement("a");
          a.href = node.href;
          a.rel = "noopener noreferrer";
          if (node.title) a.title = node.title;
          a.appendChild(linkKindIcon(externalUrl.protocol === "mailto:" ? "mail" : "web"));
          for (const child of node.children) renderNode(child, a);
          target.appendChild(a);
          const copyText = externalLinkCopyText(externalUrl);
          appendLinkCopyButton(target, l10n.t("Copy link"), () => navigator.clipboard.writeText(copyText));
        } else if (tabId !== undefined && fileTarget !== null) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "file-link";
          if (node.title) button.title = node.title;
          button.addEventListener("click", () => {
            vscode.postMessage({ type: "openFile", tabId, target: node.href });
          });
          const kind = fileLinkDisplayKind(node.href);
          button.dataset.linkKind = kind;
          button.appendChild(linkKindIcon(kind));
          for (const child of node.children) renderNode(child, button);
          target.appendChild(button);
          appendLinkCopyButton(target, l10n.t("Copy path"), () => copyFilePathOnHost(tabId, node.href));
        } else {
          for (const child of node.children) renderNode(child, target);
        }
        break;
      }
      case "table": {
        const table = document.createElement("table");
        table.className = "md-table";
        table.tabIndex = 0;
        const thead = document.createElement("thead");
        const headerTr = document.createElement("tr");
        node.head.children.forEach((cell, idx) => {
          const th = document.createElement("th");
          const align = cell.align ?? node.align[idx];
          if (align) th.style.textAlign = align;
          for (const child of cell.children) renderNode(child, th);
          headerTr.appendChild(th);
        });
        thead.appendChild(headerTr);
        table.appendChild(thead);

        if (node.body.length > 0) {
          const tbody = document.createElement("tbody");
          for (const row of node.body) {
            const tr = document.createElement("tr");
            row.children.forEach((cell, idx) => {
              const td = document.createElement("td");
              const align = cell.align ?? node.align[idx];
              if (align) td.style.textAlign = align;
              for (const child of cell.children) renderNode(child, td);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
        }
        target.appendChild(table);
        break;
      }
      case "softbreak":
      case "hardbreak": {
        target.appendChild(document.createElement("br"));
        break;
      }
      default: {
        if ("value" in node && typeof (node as any).value === "string") {
          target.append((node as any).value);
        } else if ("children" in node && Array.isArray((node as any).children)) {
          for (const child of (node as any).children) renderNode(child, target);
        }
        break;
      }
    }
  }

  for (const node of nodes) {
    renderNode(node, container);
  }
  restoreCodeFocus(container, codeFocus);
}
