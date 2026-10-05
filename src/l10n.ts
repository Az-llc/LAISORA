import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

export function initHostL10n(): void {
  l10n.config({ contents: vscode.l10n?.bundle ?? {} });
}
