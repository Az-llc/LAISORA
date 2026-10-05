import * as l10n from "@vscode/l10n";

export function failureCount(count: number): HTMLElement {
  const value = document.createElement("span");
  if (count > 0) {
    const mark = document.createElement("span");
    mark.className = "wi-x";
    mark.textContent = "✗";
    value.append(mark, " ");
  }
  value.append(l10n.t("{0} items", count));
  return value;
}
