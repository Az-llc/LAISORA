import * as l10n from "@vscode/l10n";

export const USAGE_LIMIT_RESET_NOTICE = "Your claude.ai usage limit has reset.";

export type LaisoraInput =
  | { readonly kind: "resume" }
  | { readonly kind: "todo"; readonly title: string }
  | { readonly kind: "todoFromReply"; readonly start: boolean };

const LAISORA_INPUT_HEAD = /^\[LAISORA:(resume|todo|todoFromReply)\](?: ([^\n]*))?\n/;
const TODO_FROM_REPLY_START = "start";

function laisoraInputLabel(input: LaisoraInput): string {
  if (input.kind === "todo") return ` ${input.title.replace(/\s+/g, " ").trim()}`;
  if (input.kind === "todoFromReply" && input.start) return ` ${TODO_FROM_REPLY_START}`;
  return "";
}

export function markLaisoraInput(input: LaisoraInput, text: string): string {
  return `[LAISORA:${input.kind}]${laisoraInputLabel(input)}\n${text}`;
}

export function parseLaisoraInput(recorded: string): { input: LaisoraInput; text: string } | undefined {
  const trimmed = recorded.trimStart();
  const head = LAISORA_INPUT_HEAD.exec(trimmed);
  if (!head) return undefined;
  const input: LaisoraInput = head[1] === "todo" ? { kind: "todo", title: head[2] ?? "" }
    : head[1] === "todoFromReply" ? { kind: "todoFromReply", start: head[2] === TODO_FROM_REPLY_START }
    : { kind: "resume" };
  return { input, text: trimmed.slice(head[0].length) };
}

export function isLaisoraInputText(recorded: string): boolean {
  return parseLaisoraInput(recorded) !== undefined || recorded.trimStart().startsWith(USAGE_LIMIT_RESET_NOTICE);
}

export function laisoraInputLine(input: LaisoraInput): string | undefined {
  if (input.kind === "todo") return l10n.t("LAISORA sent Claude the brief for the ToDo item “{0}”.", input.title);
  if (input.kind === "todoFromReply") {
    return input.start
      ? l10n.t("LAISORA: Add to ToDo and start a new conversation (the topic of this reply)")
      : l10n.t("LAISORA: Add to ToDo (the topic of this reply)");
  }
  return undefined;
}
