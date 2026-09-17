import * as l10n from "@vscode/l10n";
import { vscode } from "./dom";
import { parseHostFileLinkTarget, parseMarkdown, type MdNode } from "./markdown-ast";

const artifactIds = new WeakMap<HTMLElement, string[]>();
const SVG_NS = "http://www.w3.org/2000/svg";

function codeActionIcon(kind: "copy" | "check" | "error" | "preview" | "wrap"): SVGSVGElement {
  const paths = {
    copy: "M6 5V2.5h7.5V10H11M2.5 5.5H10v8H2.5z",
    check: "M3 8l3 3 7-7",
    error: "M8 3v6M8 12v.5",
    preview: "M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zm9 0a2 2 0 1 0-4 0 2 2 0 0 0 4 0",
    wrap: "M2 3.5h12M2 7h9a3 3 0 0 1 0 6H8m2-2-2 2 2 2M2 10.5h3",
  };
  const svg = svgElement("svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = svgElement("path");
  path.setAttribute("d", paths[kind]);
  svg.appendChild(path);
  return svg;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

function linkKindIcon(kind: "file" | "web" | "mail"): SVGSVGElement {
  const paths = {
    file: "M3 1.75h6l4 4v8.5H3zM9 1.75v4h4",
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

export function renderMarkdownInto(container: HTMLElement, src: string, tabId?: string): void {
  container.textContent = "";
  const containerArtifactIds = artifactIds.get(container) ?? [];
  artifactIds.set(container, containerArtifactIds);
  let fencedIndex = 0;

  const nodes = parseMarkdown(src);

  function renderNode(node: MdNode, target: HTMLElement): void {
    switch (node.type) {
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
        codeEl.textContent = content;
        pre.appendChild(codeEl);

        const actions = document.createElement("div");
        actions.className = "artifact-preview-actions";
        const wrap = document.createElement("button");
        wrap.type = "button";
        wrap.className = "code-wrap-button";
        wrap.title = l10n.t("Wrap lines");
        wrap.setAttribute("aria-label", wrap.title);
        wrap.setAttribute("aria-pressed", "false");
        wrap.appendChild(codeActionIcon("wrap"));
        wrap.addEventListener("click", () => {
          const enabled = pre.classList.toggle("is-wrapped");
          wrap.setAttribute("aria-pressed", String(enabled));
          wrap.title = enabled ? l10n.t("Disable line wrapping") : l10n.t("Wrap lines");
          wrap.setAttribute("aria-label", wrap.title);
        });
        actions.appendChild(wrap);
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "code-copy-button";
        copy.appendChild(codeActionIcon("copy"));
        copy.title = l10n.t("Copy code block");
        copy.setAttribute("aria-label", copy.title);
        const status = document.createElement("span");
        status.className = "code-copy-status";
        status.setAttribute("role", "status");
        copy.addEventListener("click", async () => {
          copy.disabled = true;
          try {
            await navigator.clipboard.writeText(content);
            copy.replaceChildren(codeActionIcon("check"));
            copy.dataset.copyState = "copied";
            status.textContent = l10n.t("Copied");
            copy.title = l10n.t("Copied");
          } catch {
            copy.replaceChildren(codeActionIcon("error"));
            copy.dataset.copyState = "failed";
            status.textContent = l10n.t("Copy failed");
            copy.title = l10n.t("Copy failed") + ". " + l10n.t("Select the text and copy it manually, or try again.");
          } finally {
            copy.setAttribute("aria-label", copy.title);
            copy.disabled = false;
          }
        });
        actions.appendChild(copy);
        actions.appendChild(status);
        pre.appendChild(actions);

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
        let externalProtocol: "http:" | "https:" | "mailto:" | undefined;
        try {
          const protocol = new URL(node.href).protocol;
          if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
            externalProtocol = protocol;
          }
        } catch {
          externalProtocol = undefined;
        }
        if (externalProtocol !== undefined) {
          const a = document.createElement("a");
          a.href = node.href;
          a.rel = "noopener noreferrer";
          if (node.title) a.title = node.title;
          a.appendChild(linkKindIcon(externalProtocol === "mailto:" ? "mail" : "web"));
          for (const child of node.children) renderNode(child, a);
          target.appendChild(a);
        } else if (tabId !== undefined && parseHostFileLinkTarget(node.href) !== null) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "file-link";
          if (node.title) button.title = node.title;
          button.addEventListener("click", () => {
            vscode.postMessage({ type: "openFile", tabId, target: node.href });
          });
          button.appendChild(linkKindIcon("file"));
          for (const child of node.children) renderNode(child, button);
          target.appendChild(button);
        } else {
          for (const child of node.children) renderNode(child, target);
        }
        break;
      }
      case "table": {
        const table = document.createElement("table");
        table.className = "md-table";
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
}
