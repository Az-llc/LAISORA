import * as l10n from "@vscode/l10n";
import { RENAME_TITLE_MAX, type HostToWebview, type WebviewToHost } from "../protocol";
import { createLoader } from "./loader";

export interface SessionMenuExtra { label: string; icon: string; run: () => void }
let sessionMenuExtras: (() => SessionMenuExtra[]) | null = null;
export function setSessionMenuExtras(provider: (() => SessionMenuExtra[]) | null): void { sessionMenuExtras = provider; }

export function sessionNameMenuPlacement(left: number, right: number, width: number, viewport: number): "right" | "left" | "inline" {
  if (viewport - right >= width) return "right";
  if (left >= width) return "left";
  return "inline";
}

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
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "session-actions-panel session-menu-surface";
  panel.setAttribute("role", "menu");
  const form = document.createElement("form");
  form.className = "session-rename-form";
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "text";
  input.required = true;
  input.maxLength = RENAME_TITLE_MAX;
  input.setAttribute("aria-label", l10n.t("Session name"));
  const pencil = document.createElement("span");
  pencil.className = "session-name-pencil";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "session-rename-icon";
  edit.textContent = "\u270e";
  edit.title = l10n.t("Session name");
  edit.setAttribute("aria-label", edit.title);
  edit.setAttribute("aria-haspopup", "menu");
  edit.setAttribute("aria-expanded", "false");
  const dropdown = document.createElement("div");
  dropdown.className = "session-name-dropdown session-menu-surface";
  dropdown.setAttribute("role", "menu");
  dropdown.hidden = true;
  pencil.append(edit, dropdown);
  const loading = document.createElement("span");
  loading.className = "session-name-loading";
  loading.hidden = true;
  loading.append(createLoader(12));
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-label", l10n.t("Suggesting session name…"));
  const failure = document.createElement("span");
  failure.className = "session-name-failure";
  failure.setAttribute("role", "status");
  failure.hidden = true;
  let pending = false;
  let composing = false;
  let focusSuggestion = false;
  const suggestionButtons: HTMLButtonElement[] = [];
  const setPending = (value: boolean) => {
    pending = value;
    loading.hidden = !value;
    for (const button of suggestionButtons) button.disabled = value;
  };
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  const closeDropdown = () => { dropdown.hidden = true; edit.setAttribute("aria-expanded", "false"); };
  const closeForm = (focus = false) => {
    focusSuggestion = false;
    form.hidden = true; label.hidden = false; pencil.hidden = false;
    if (focus) edit.focus();
  };
  const beginEdit = (value = title) => {
    setPending(false);
    failure.hidden = true;
    closeDropdown();
    input.value = value; label.hidden = true; pencil.hidden = true;
    form.hidden = false;
    if (root.getClientRects().length) { input.focus(); input.select(); }
    else focusSuggestion = true;
  };
  const suggest = () => {
    failure.hidden = true;
    setPending(true);
    send({ type: "suggestSessionName", tabId });
  };
  const receiveSuggestion = (message: Extract<HostToWebview, { type: "sessionNameSuggestion" }>) => {
    if (!pending) return;
    setPending(false);
    if ("title" in message) beginEdit(message.title);
    else {
      failure.textContent = message.reason.replace(/\s+/g, " ").trim();
      failure.title = failure.textContent;
      failure.hidden = false;
    }
  };
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
    button.setAttribute("role", "menuitem");
    if (icon) {
      const glyph = document.createElement("span");
      glyph.textContent = icon;
      glyph.setAttribute("aria-hidden", "true");
      button.append(glyph);
    }
    button.append(document.createTextNode(text));
    button.onclick = () => { closeSubmenu(); menu.open = false; closeDropdown(); (host === dropdown ? edit : toggle).focus(); run(); };
    host.appendChild(button);
    return button;
  };
  const nameItem = document.createElement("div");
  nameItem.className = "session-name-item";
  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "session-name-parent";
  nameButton.setAttribute("role", "menuitem");
  nameButton.setAttribute("aria-haspopup", "menu");
  nameButton.setAttribute("aria-expanded", "false");
  nameButton.append(document.createTextNode(l10n.t("Session name")));
  const arrow = document.createElement("span");
  arrow.textContent = "▸";
  arrow.setAttribute("aria-hidden", "true");
  nameButton.append(arrow);
  const submenu = document.createElement("div");
  submenu.className = "session-name-submenu session-menu-surface";
  submenu.setAttribute("role", "menu");
  submenu.hidden = true;
  nameItem.append(nameButton, submenu);
  panel.append(nameItem);
  const closeSubmenu = (focus = false) => {
    submenu.hidden = true;
    nameButton.setAttribute("aria-expanded", "false");
    if (focus) nameButton.focus();
  };
  const openSubmenu = (focus = false) => {
    submenu.hidden = false;
    submenu.dataset.side = "right";
    const bounds = panel.getBoundingClientRect();
    submenu.dataset.side = sessionNameMenuPlacement(bounds.left, bounds.right, submenu.getBoundingClientRect().width, document.documentElement.clientWidth);
    nameButton.setAttribute("aria-expanded", "true");
    if (focus) submenu.querySelector<HTMLButtonElement>("button")?.focus();
  };
  const openDropdown = (focus = false) => {
    menu.open = false;
    closeSubmenu();
    dropdown.hidden = false;
    dropdown.style.left = "0px";
    const bounds = dropdown.getBoundingClientRect();
    dropdown.style.left = `${Math.min(0, document.documentElement.clientWidth - bounds.right - 8)}px`;
    edit.setAttribute("aria-expanded", "true");
    if (focus) dropdown.querySelector<HTMLButtonElement>("button")?.focus();
  };
  for (const host of [submenu, dropdown]) {
    action(l10n.t("Rename"), "", () => beginEdit(), host);
    suggestionButtons.push(action(l10n.t("Suggest"), "", suggest, host));
  }
  nameButton.onmouseenter = () => openSubmenu();
  nameButton.onclick = () => openSubmenu(true);
  nameButton.onkeydown = event => {
    if (["Enter", " ", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); openSubmenu(true);
    }
  };
  nameItem.onmouseleave = () => { if (!nameItem.contains(document.activeElement)) closeSubmenu(); };
  nameItem.addEventListener("focusout", event => { if (!nameItem.contains(event.relatedTarget as Node | null)) closeSubmenu(); });
  nameItem.onkeydown = event => {
    if (!submenu.hidden && ["ArrowLeft", "Escape"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); closeSubmenu(true);
    }
  };
  edit.onmouseenter = () => openDropdown();
  edit.onclick = () => openDropdown(true);
  edit.onkeydown = event => {
    if (["Enter", " ", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); openDropdown(true);
    }
  };
  pencil.onmouseleave = () => { if (!pencil.contains(document.activeElement)) closeDropdown(); };
  pencil.addEventListener("focusout", event => { if (!pencil.contains(event.relatedTarget as Node | null)) closeDropdown(); });
  pencil.onkeydown = event => {
    if (["Escape", "ArrowLeft"].includes(event.key) && !dropdown.hidden) {
      event.preventDefault(); event.stopPropagation(); closeDropdown(); edit.focus();
    }
  };
  for (const surface of [panel, submenu, dropdown]) surface.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = Array.from(surface.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter(item => item.closest('[role="menu"]') === surface && !item.disabled);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });
  action(l10n.t("Hand off to a new conversation"), "⇉", () => send({type: "startHandoff", tabId}));
  action(l10n.t("Export conversation to Markdown"), "↧", () => send({type: "exportTab", tabId}));
  const extras = document.createElement("div");
  extras.className = "session-actions-extras";
  panel.appendChild(extras);
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSubmenu(); menu.open = false; toggle.focus(); }
    if (event.target === toggle && event.key === "ArrowDown") { event.preventDefault(); menu.open = true; nameButton.focus(); }
  });
  menu.addEventListener("focusout", event => {
    if (!menu.contains(event.relatedTarget as Node | null)) { menu.open = false; closeSubmenu(); }
  });
  menu.append(toggle, panel);
  menu.addEventListener("toggle", () => {
    toggle.setAttribute("aria-expanded", String(menu.open));
    if (!menu.open) { closeSubmenu(); return; }
    closeDropdown();
    extras.replaceChildren();
    for (const extra of sessionMenuExtras?.() ?? []) action(extra.label, extra.icon, extra.run, extras);
    panel.style.top = getComputedStyle(panel).position === "fixed" ? `${toggle.getBoundingClientRect().bottom + 2}px` : "100%";
  });
  root.append(label, pencil, form, loading, failure);
  const mountMenu = (host: HTMLElement | null) => {
    menu.open = false;
    closeSubmenu();
    closeDropdown();
    if (host) {
      host.appendChild(menu);
      if (focusSuggestion) { focusSuggestion = false; input.focus(); input.select(); }
    } else menu.remove();
  };
  return {element: root, updateTitle, mountMenu, receiveSuggestion};
}
