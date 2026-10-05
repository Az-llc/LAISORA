import { configureWebviewL10n } from "./l10n";

declare const __LAISORA_L10N_JA_BUNDLE__: string;

export function selectWebviewL10nBundle(lang: string): Record<string, string> {
  if (!lang.toLowerCase().startsWith("ja")) return {};
  return JSON.parse(__LAISORA_L10N_JA_BUNDLE__) as Record<string, string>;
}

configureWebviewL10n(selectWebviewL10nBundle(document.documentElement.lang));
