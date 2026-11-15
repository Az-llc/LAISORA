import * as l10n from "@vscode/l10n";

export function todoGroupLabel(group?: string | null): string {
  return group ?? l10n.t("No group");
}
