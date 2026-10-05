import * as l10n from "@vscode/l10n";
import { DEFAULT_ACCENT_SETTINGS, isCustomAccent, resolveAccent, THEME_ACCENT, type AccentColor, type AccentSetting, type AccentSettings } from "../accent";
import { installAccent } from "./accent";
import { onUserLabelChange, userLabel } from "./user-label";

interface SettingsControls {
  row(card: HTMLElement, label: string, description: string, control: HTMLElement, focusTarget?: () => HTMLElement | undefined): HTMLElement;
  rowNote(text: HTMLElement, className: string, note: string): HTMLElement;
}

function accentDescription(): string {
  return l10n.t("Colour used for {0}, the current step and heading lines. The send button and keyboard focus rings keep the theme colours.", userLabel());
}

export function createAccentSettings(root: HTMLElement, write: (setting: AccentSetting, value: string) => number, { row, rowNote }: SettingsControls): (settings?: AccentSettings, replyTo?: number) => void {
  let pending: number | undefined;
  let restoreFocus: HTMLElement | undefined;
  const choice = document.createElement("div");
  choice.id = "setting-accent-color";
  choice.className = "settings-swatches";
  choice.setAttribute("role", "radiogroup");
  const swatches = ([
    ["theme", l10n.t("Follow theme")],
    ["blue", l10n.t("Blue")],
    ["orange", l10n.t("Orange")],
    ["pink", l10n.t("Pink")],
    ["green", l10n.t("Green")],
    ["custom", l10n.t("Custom colour")],
  ] as Array<[AccentColor, string]>).map(([value, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-swatch";
    button.dataset.value = value;
    button.setAttribute("role", "radio");
    button.tabIndex = -1;
    button.disabled = true;
    const mark = document.createElement("span");
    mark.className = "settings-accent-swatch";
    mark.setAttribute("aria-hidden", "true");
    button.append(mark, document.createTextNode(text));
    choice.appendChild(button);
    return { value, button, mark };
  });
  const checkedSwatch = (): HTMLElement | undefined => swatches.find(({ button }) => button.getAttribute("aria-checked") === "true")?.button;
  const accentText = row(root, l10n.t("Accent colour"), accentDescription(), choice, () => checkedSwatch() ?? swatches[0].button);
  accentText.parentElement!.classList.add("settings-row-stack");
  const accentDescriptionEl = accentText.children[1] as HTMLElement;
  onUserLabelChange(() => { accentDescriptionEl.textContent = accentDescription(); });
  const markChecked = (value: AccentColor): void => {
    for (const { value: candidate, button } of swatches) {
      button.setAttribute("aria-checked", String(candidate === value));
      button.tabIndex = candidate === value ? 0 : -1;
    }
  };
  const choose = (value: AccentColor): void => {
    if (pending !== undefined || value === checkedSwatch()?.dataset.value) return;
    markChecked(value);
    customRow.hidden = value !== "custom";
    pending = write("accentColor", value);
    lock();
  };
  for (const { value, button } of swatches) button.addEventListener("click", () => choose(value));
  choice.addEventListener("keydown", (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || pending !== undefined) return;
    event.preventDefault();
    const from = swatches.findIndex(({ button }) => button === document.activeElement);
    const next = swatches[(Math.max(from, 0) + step + swatches.length) % swatches.length];
    next.button.focus();
    choose(next.value);
  });
  const custom = document.createElement("div");
  custom.className = "settings-accent-custom";
  custom.setAttribute("role", "group");
  const customText = row(root, l10n.t("Custom colour"), l10n.t("Use separate colours for light and dark themes. Enter them in #RRGGBB format."), custom, () => fields[0].input);
  const customRow = customText.parentElement!;
  customRow.hidden = true;
  const fields = ([
    ["accentCustomLight", l10n.t("Light")],
    ["accentCustomDark", l10n.t("Dark")],
  ] as const).map(([key, text]) => {
    const field = document.createElement("div");
    const label = document.createElement("label");
    label.className = "l-label";
    label.textContent = text;
    label.htmlFor = `setting-${key}`;
    const line = document.createElement("div");
    line.className = "settings-accent-input";
    const swatch = document.createElement("span");
    swatch.className = "settings-accent-swatch";
    swatch.setAttribute("aria-hidden", "true");
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.className = "settings-input";
    input.type = "text";
    input.placeholder = "#RRGGBB";
    input.pattern = "#[0-9a-fA-F]{6}";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.disabled = true;
    const error = rowNote(customText, "settings-row-description", "");
    error.hidden = true;
    error.setAttribute("aria-live", "polite");
    input.setAttribute("aria-describedby", `${custom.getAttribute("aria-describedby")} ${error.id}`);
    const validate = (): void => {
      const valid = isCustomAccent(input.value);
      input.setAttribute("aria-invalid", String(!valid));
      error.textContent = valid ? "" : `${text}: ${l10n.t("Enter a colour in #RRGGBB format.")}`;
      error.hidden = valid;
      swatch.style.backgroundColor = valid ? input.value : THEME_ACCENT;
    };
    input.addEventListener("input", validate);
    input.addEventListener("change", () => {
      if (isCustomAccent(input.value)) {
        pending = write(key, input.value);
        lock();
      }
    });
    line.append(swatch, input);
    field.append(label, line);
    custom.appendChild(field);
    return { key, input, validate };
  });
  function lock(): void {
    const controls: Array<HTMLButtonElement | HTMLInputElement> = [...swatches.map(({ button }) => button), ...fields.map(({ input }) => input)];
    if (pending !== undefined) restoreFocus = controls.find((control) => control === document.activeElement) ?? restoreFocus;
    for (const control of controls) control.disabled = pending !== undefined;
    if (pending === undefined) {
      restoreFocus?.focus();
      restoreFocus = undefined;
    }
  }
  const apply = installAccent((settings, kind) => {
    for (const { value, mark } of swatches) mark.style.backgroundColor = resolveAccent({ ...settings, accentColor: value }, kind);
  });
  return (settings = DEFAULT_ACCENT_SETTINGS, replyTo) => {
    if (pending === replyTo) pending = undefined;
    apply(settings);
    if (pending !== undefined) return;
    markChecked(settings.accentColor);
    customRow.hidden = settings.accentColor !== "custom";
    for (const { key, input, validate } of fields) {
      if (document.activeElement !== input || replyTo !== undefined) input.value = settings[key];
      validate();
    }
    lock();
  };
}
