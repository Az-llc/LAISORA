import * as l10n from "@vscode/l10n";

export const USAGE_LIMIT_RESET_NOTICE = "Your claude.ai usage limit has reset.";

export type LaisoraInput = { readonly kind: "resume" } | { readonly kind: "todo"; readonly title: string };

const LAISORA_INPUT_HEAD = /^\[LAISORA:(resume|todo)\](?: ([^\n]*))?\n/;

export function markLaisoraInput(input: LaisoraInput, text: string): string {
  const label = input.kind === "todo" ? ` ${input.title.replace(/\s+/g, " ").trim()}` : "";
  return `[LAISORA:${input.kind}]${label}\n${text}`;
}

export function parseLaisoraInput(recorded: string): { input: LaisoraInput; text: string } | undefined {
  const trimmed = recorded.trimStart();
  const head = LAISORA_INPUT_HEAD.exec(trimmed);
  if (!head) return undefined;
  const input: LaisoraInput = head[1] === "todo" ? { kind: "todo", title: head[2] ?? "" } : { kind: "resume" };
  return { input, text: trimmed.slice(head[0].length) };
}

export function isLaisoraInputText(recorded: string): boolean {
  return parseLaisoraInput(recorded) !== undefined || recorded.trimStart().startsWith(USAGE_LIMIT_RESET_NOTICE);
}

export function laisoraInputLine(input: LaisoraInput): string | undefined {
  return input.kind === "todo" ? l10n.t("LAISORA sent Claude the brief for the ToDo item “{0}”.", input.title) : undefined;
}
