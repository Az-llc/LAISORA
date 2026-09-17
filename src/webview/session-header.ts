import * as l10n from "@vscode/l10n";
import type { WebviewToHost } from "../protocol";

export interface SessionMenuExtra { label: string; icon: string; run: () => void }
let sessionMenuExtras: (() => SessionMenuExtra[]) | null = null;
export function setSessionMenuExtras(provider: (() => SessionMenuExtra[]) | null): void { sessionMenuExtras = provider; }

export function createSessionHeader(tabId: string, title: string, send: (message: WebviewToHost) => void) {
  const root = document.createElement("div");
  root.className = "session-heading";
  const label = document.createElement("span");
  label.className = "session-heading-title";
  const updateTitle = (value: string) => { title = value; label.textContent = value; label.title = value; };
  updateTitle(title);
  const menu = document.createElement("details");
  menu.className = "session-actions";
  const toggle = document.createElement("summary");
  toggle.textContent = "☰";
  toggle.title = l10n.t("Session actions");
  toggle.setAttribute("aria-label", toggle.title);
  const panel = document.createElement("div");
  panel.className = "session-actions-panel";
  const form = document.createElement("form");
  form.className = "session-rename-form";
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "text";
  input.required = true;
  input.setAttribute("aria-label", l10n.t("Session name"));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "session-rename-icon";
  edit.textContent = "\u270e";
  edit.title = l10n.t("Rename session");
  edit.setAttribute("aria-label", edit.title);
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  const closeForm = (focus = false) => {
    form.hidden = true; label.hidden = false; edit.hidden = false;
    if (focus) edit.focus();
  };
  const beginEdit = () => {
    input.value = title; label.hidden = true; edit.hidden = true;
    form.hidden = false; input.focus(); input.select();
  };
  edit.onclick = beginEdit;
  form.onsubmit = event => { event.preventDefault(); };
  input.onkeydown = event => {
    // IME confirmation must not submit the session name.
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault(); event.stopPropagation();
      const value = input.value.trim();
      if (!value) return;
      send({type: "renameTab", tabId, title: value});
      closeForm(true);
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); closeForm(true);
    }
  };
  input.onblur = () => closeForm();
  form.append(input);
  const action = (text: string, icon: string, run: () => void, host: HTMLElement = panel) => {
    const button = document.createElement("button");
    button.type = "button";
    const glyph = document.createElement("span");
    glyph.textContent = icon;
    glyph.setAttribute("aria-hidden", "true");
    button.append(glyph, document.createTextNode(text));
    button.onclick = () => { menu.open = false; toggle.focus(); run(); };
    host.appendChild(button);
  };
  action(l10n.t("Rename session"), "\u270e", beginEdit);
  action(l10n.t("Hand off to a new conversation"), "⇉", () => send({type: "startHandoff", tabId}));
  action(l10n.t("Export conversation to Markdown"), "↧", () => send({type: "exportTab", tabId}));
  const extras = document.createElement("div");
  extras.className = "session-actions-extras";
  panel.appendChild(extras);
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.stopPropagation(); menu.open = false; toggle.focus(); }
  });
  menu.addEventListener("focusout", event => {
    if (!menu.contains(event.relatedTarget as Node | null)) menu.open = false;
  });
  menu.append(toggle, panel);
  menu.addEventListener("toggle", () => {
    if (!menu.open) return;
    extras.replaceChildren();
    for (const extra of sessionMenuExtras?.() ?? []) action(extra.label, extra.icon, extra.run, extras);
    panel.style.top = `${toggle.getBoundingClientRect().bottom + 2}px`;
  });
  root.append(label, edit, form);
  const mountMenu = (host: HTMLElement | null) => {
    menu.open = false;
    if (host) host.appendChild(menu);
    else menu.remove();
  };
  return {element: root, updateTitle, mountMenu};
}
