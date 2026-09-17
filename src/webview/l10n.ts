import * as l10n from "@vscode/l10n";

// Call before the first render; `@vscode/l10n` has no reload, later calls replace the bundle for future t() only
export function configureWebviewL10n(bundle: Record<string, string> | undefined): void {
  l10n.config({ contents: bundle ?? {} });
}
