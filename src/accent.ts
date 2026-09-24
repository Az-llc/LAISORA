export const ACCENT_COLORS = ["theme", "blue", "orange", "pink", "green", "custom"] as const;
export type AccentColor = (typeof ACCENT_COLORS)[number];
export type AccentTheme = "light" | "dark" | "high-contrast";
export const ACCENT_PRESETS = {
  blue: { light: "#005FB8", dark: "#4DAAFC" },
  orange: { light: "#A84B00", dark: "#F5A35C" },
  pink: { light: "#B12C65", dark: "#F18AB5" },
  green: { light: "#24733F", dark: "#75C991" },
} as const;
export interface AccentSettings {
  accentColor: AccentColor;
  accentCustomLight: string;
  accentCustomDark: string;
}
export type AccentSetting = keyof AccentSettings;
export const DEFAULT_ACCENT_SETTINGS: AccentSettings = {
  accentColor: "theme",
  accentCustomLight: ACCENT_PRESETS.orange.light,
  accentCustomDark: ACCENT_PRESETS.orange.dark,
};
// focusBorder first: most built-in themes leave textLink.foreground undefined, so it stays VS Code's default blue in every theme.
export const THEME_ACCENT = "var(--vscode-focusBorder, var(--vscode-textLink-foreground))";

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === "string" && (ACCENT_COLORS as readonly string[]).includes(value);
}
export function isCustomAccent(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
export function isAccentSettingValue(setting: unknown, value: unknown): boolean {
  return setting === "accentColor" ? isAccentColor(value)
    : (setting === "accentCustomLight" || setting === "accentCustomDark") && isCustomAccent(value);
}
export function isAccentSettings(value: unknown): value is AccentSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as AccentSettings;
  return isAccentColor(settings.accentColor) && typeof settings.accentCustomLight === "string" && typeof settings.accentCustomDark === "string";
}
export function resolveAccent(settings: AccentSettings, theme: AccentTheme): string {
  if (theme === "high-contrast" || settings.accentColor === "theme") return THEME_ACCENT;
  if (settings.accentColor === "custom") {
    const value = theme === "light" ? settings.accentCustomLight : settings.accentCustomDark;
    return isCustomAccent(value) ? value : THEME_ACCENT;
  }
  return ACCENT_PRESETS[settings.accentColor]?.[theme] ?? THEME_ACCENT;
}
