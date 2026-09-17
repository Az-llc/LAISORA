import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

// Modules shared with the webview / test bundles call `@vscode/l10n` instead of `vscode.l10n`.
// vscode.l10n.bundle is undefined for the default language; an empty bundle makes t() return the key.
// `vscode.l10n?` は engines ^1.90 では常に存在するが、Host を偽 vscode で起動する検査
// （verify-{webview,gateway,history,llm}-wiring 等）は l10n 名前空間を持たない。`?.` を外すと
// それらが activate の時点で TypeError で全滅する
export function initHostL10n(): void {
  l10n.config({ contents: vscode.l10n?.bundle ?? {} });
}
