import * as l10n from "@vscode/l10n";

export const CLOSE_GLYPH = "×";

export function closeGlyphButton<T extends HTMLButtonElement>(button: T, title = l10n.t("Close"), label = l10n.t("Close")): T {
  button.textContent = CLOSE_GLYPH;
  button.title = title;
  button.setAttribute("aria-label", label);
  return button;
}
