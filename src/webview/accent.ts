import { DEFAULT_ACCENT_SETTINGS, resolveAccent, type AccentSettings, type AccentTheme } from "../accent";

export function accentTheme(body: HTMLElement): AccentTheme {
  if (body.classList.contains("vscode-high-contrast") || body.classList.contains("vscode-high-contrast-light")) return "high-contrast";
  if (body.classList.contains("vscode-light")) return "light";
  return body.classList.contains("vscode-dark") ? "dark" : "high-contrast";
}

export function installAccent(onChange?: (settings: AccentSettings, theme: AccentTheme) => void): (settings?: AccentSettings) => void {
  let current = DEFAULT_ACCENT_SETTINGS;
  const apply = (): void => {
    const theme = accentTheme(document.body);
    document.documentElement.style.setProperty("--laisora-accent", resolveAccent(current, theme));
    onChange?.(current, theme);
  };
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  apply();
  return (settings = DEFAULT_ACCENT_SETTINGS) => { current = settings; apply(); };
}
