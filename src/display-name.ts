export const DISPLAY_NAME_MAX = 20;

function displayNameChars(value: string): string[] {
  return Array.from(value.trim());
}

export function displayNameLength(value: string): number {
  return displayNameChars(value).length;
}

export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return "";
  let result = "";
  let length = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(value.trim())) {
    length += Array.from(segment).length;
    if (length > DISPLAY_NAME_MAX) break;
    result += segment;
  }
  return (result || displayNameChars(value).slice(0, DISPLAY_NAME_MAX).join("")).trim();
}

export function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && normalizeDisplayName(value) === value;
}
