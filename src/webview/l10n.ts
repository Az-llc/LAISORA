import * as l10n from "@vscode/l10n";

export function configureWebviewL10n(bundle: Record<string, string> | undefined): void {
  l10n.config({ contents: bundle ?? {} });
}

export function uiLocale(): string {
  const lang = typeof document === "undefined" ? "" : (document.documentElement?.lang ?? "");
  return lang.toLowerCase().startsWith("ja") ? "ja-JP" : "en-US";
}

export function formatDateTime(ms: number | null): string {
  if (ms === null) return "?";
  return new Date(ms).toLocaleString(uiLocale(), { hour12: false });
}
