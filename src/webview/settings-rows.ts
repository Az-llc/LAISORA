import * as l10n from "@vscode/l10n";
import { DISPLAY_NAME_MAX, displayNameLength, normalizeDisplayName } from "../display-name";
import { element } from "./element";

let rowSerial = 0;

export function section(root: HTMLElement, title: string): HTMLElement {
  const id = `settings-section-${++rowSerial}`;
  const wrap = element("section", "settings-section");
  wrap.setAttribute("aria-labelledby", id);
  const heading = element("h2", "settings-section-title", title);
  heading.id = id;
  const card = element("div", "settings-card");
  wrap.append(heading, card);
  root.appendChild(wrap);
  return card;
}

export function row(card: HTMLElement, label: string, description: string, control: HTMLElement, focusTarget?: () => HTMLElement | undefined): HTMLElement {
  const serial = ++rowSerial;
  const line = element("div", "settings-row");
  const text = element("div", "settings-row-text");
  const name = element("label", "settings-row-label", label);
  name.id = `settings-label-${serial}`;
  if (focusTarget) name.addEventListener("click", () => focusTarget()?.focus());
  else name.htmlFor = control.id;
  const desc = element("div", "settings-row-description", description);
  desc.id = `settings-description-${serial}`;
  text.append(name, desc);
  control.setAttribute("aria-labelledby", name.id);
  control.setAttribute("aria-describedby", desc.id);
  const holder = element("div", "settings-row-control");
  holder.appendChild(control);
  line.append(text, holder);
  card.appendChild(line);
  return text;
}

export function rowNote(text: HTMLElement, className: string, note: string): HTMLElement {
  const el = element("div", className, note);
  el.id = `settings-note-${++rowSerial}`;
  text.appendChild(el);
  return el;
}

export function capNameInput(input: HTMLInputElement, notice: HTMLElement): void {
  const raw = input.value.replace(/[\r\n]+/g, " ");
  const entered = displayNameLength(raw);
  notice.textContent = entered > DISPLAY_NAME_MAX ? l10n.t("{0} characters were entered, so the first {1} are used.", entered, DISPLAY_NAME_MAX) : "";
  if (entered > DISPLAY_NAME_MAX) input.value = normalizeDisplayName(raw);
  else if (raw !== input.value) input.value = raw;
}

export function switchButton(id: string): HTMLButtonElement {
  const button = element("button", "l-switch");
  button.id = id;
  button.type = "button";
  button.setAttribute("role", "switch");
  button.disabled = true;
  button.appendChild(element("span", "l-switch-thumb"));
  return button;
}

export function select<V extends string>(options: Array<[V, string]>): HTMLSelectElement {
  const el = element("select", "settings-select");
  const unknown = element("option", "settings-option-unknown", "");
  unknown.value = "";
  unknown.disabled = true;
  el.appendChild(unknown);
  for (const [value, text] of options) {
    const option = element("option", "", text);
    option.value = value;
    el.appendChild(option);
  }
  el.value = "";
  el.disabled = true;
  return el;
}
