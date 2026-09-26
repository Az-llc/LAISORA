import * as l10n from "@vscode/l10n";
import { DEFAULT_ACCENT_SETTINGS, isCustomAccent, resolveAccent, THEME_ACCENT, type AccentColor, type AccentSetting, type AccentSettings } from "../accent";
import { installAccent } from "./accent";

interface SettingsControls {
  row(card: HTMLElement, label: string, description: string, control: HTMLElement, focusTarget?: () => HTMLElement | undefined): HTMLElement;
  rowNote(text: HTMLElement, className: string, note: string): HTMLElement;
  select<V extends string>(options: Array<[V, string]>): HTMLSelectElement;
}

export function createAccentSettings(root: HTMLElement, write: (setting: AccentSetting, value: string) => number, { row, rowNote, select }: SettingsControls): (settings?: AccentSettings, replyTo?: number) => void {
  let pending: number | undefined;
  let restoreFocus: HTMLInputElement | HTMLSelectElement | undefined;
  const choice = select<AccentColor>([
    ["theme", l10n.t("Follow theme")],
    ["blue", l10n.t("Blue")],
    ["orange", l10n.t("Orange")],
    ["pink", l10n.t("Pink")],
    ["green", l10n.t("Green")],
    ["custom", l10n.t("Custom colour")],
  ]);
  choice.id = "setting-accent-color";
  row(root, l10n.t("Accent colour"), l10n.t("Colour used for YOU, the current step and heading lines. The send button and keyboard focus rings keep the theme colours."), choice);
  const resolvedSwatch = document.createElement("span");
  resolvedSwatch.className = "settings-accent-swatch";
  resolvedSwatch.setAttribute("aria-hidden", "true");
  choice.parentElement!.classList.add("settings-accent-control");
  choice.parentElement!.prepend(resolvedSwatch);
  const custom = document.createElement("div");
  custom.className = "settings-accent-custom";
  custom.setAttribute("role", "group");
  const customText = row(root, l10n.t("Custom colour"), l10n.t("Use separate colours for light and dark themes. Enter them in #RRGGBB format."), custom, () => fields[0].input);
  const customRow = customText.parentElement!;
  customRow.hidden = true;
  choice.addEventListener("change", () => {
    customRow.hidden = choice.value !== "custom";
    pending = write("accentColor", choice.value);
    lock();
  });
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
    const controls = [choice, ...fields.map(({ input }) => input)];
    if (pending !== undefined) restoreFocus = controls.find((control) => control === document.activeElement) ?? restoreFocus;
    for (const control of controls) control.disabled = pending !== undefined;
    if (pending === undefined) {
      restoreFocus?.focus();
      restoreFocus = undefined;
    }
  }
  const apply = installAccent((settings, kind) => { resolvedSwatch.style.backgroundColor = resolveAccent(settings, kind); });
  return (settings = DEFAULT_ACCENT_SETTINGS, replyTo) => {
    if (pending === replyTo) pending = undefined;
    apply(settings);
    if (pending !== undefined) return;
    choice.value = settings.accentColor;
    customRow.hidden = settings.accentColor !== "custom";
    for (const { key, input, validate } of fields) {
      if (document.activeElement !== input || replyTo !== undefined) input.value = settings[key];
      validate();
    }
    lock();
  };
}
