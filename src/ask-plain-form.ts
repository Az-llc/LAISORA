import * as l10n from "@vscode/l10n";

export const PLAIN_ASK_HEADING = "###";

export const PLAIN_ASK_MARK = {
  decide: "🔷",
  check: "✅",
  rejected: "⛔",
  recommended: "⭐",
  pros: "＋",
  cons: "－",
  look: "👀",
  default: "➡",
} as const;

export const PLAIN_ASK_PROS_MARKS: readonly string[] = [PLAIN_ASK_MARK.pros, "+"];
export const PLAIN_ASK_CONS_MARKS: readonly string[] = [PLAIN_ASK_MARK.cons, "-", "\u2212"];

const VARIATION_SELECTOR = "\uFE0F";

export function afterPlainAskMark(text: string, mark: string): string | undefined {
  if (!text.startsWith(mark)) return undefined;
  let rest = text.slice(mark.length);
  if (rest.startsWith(VARIATION_SELECTOR)) rest = rest.slice(VARIATION_SELECTOR.length);
  if (rest !== "" && !/^\s/.test(rest)) return undefined;
  return rest.trim();
}

export function afterAnyPlainAskMark(text: string, marks: readonly string[]): string | undefined {
  for (const mark of marks) {
    const rest = afterPlainAskMark(text, mark);
    if (rest !== undefined) return rest;
  }
  return undefined;
}

export function isPlainAskMarkOnly(text: string, mark: string): boolean {
  return afterPlainAskMark(text.trim(), mark) === "";
}

export function withoutPlainAskMarkAtEnds(text: string, mark: string): string {
  let rest = text.trim();
  for (const end of [mark + VARIATION_SELECTOR, mark]) {
    if (rest.startsWith(end)) rest = rest.slice(end.length).trim();
    if (rest.endsWith(end)) rest = rest.slice(0, -end.length).trim();
  }
  return rest;
}

const PLAIN_ASK_TITLE_MARKS = [PLAIN_ASK_MARK.decide, PLAIN_ASK_MARK.check, PLAIN_ASK_MARK.rejected];
const PLAIN_ASK_OPENING = new RegExp(`^ {0,3}${PLAIN_ASK_HEADING}[ \\t]+(?:${PLAIN_ASK_TITLE_MARKS.join("|")})`, "mu");
const PLAIN_ASK_CLOSING = new RegExp(`^ {0,3}${PLAIN_ASK_MARK.default}`, "u");

export function opensPlainAsk(text: string): boolean {
  return PLAIN_ASK_OPENING.test(text);
}

export function closesPlainAsk(line: string): boolean {
  return PLAIN_ASK_CLOSING.test(line);
}

export const plainAskFormat = (): string => {
  const m = PLAIN_ASK_MARK;
  return [
    l10n.t("Plain form of a decision or real-machine check, in the user's language: a level-3 heading \"### {0} \" and the title ({1} instead of {0} for a check), then the why as one or more paragraphs, then optional details as one quote block (\"> \"), then a numbered list, then a last paragraph \"{2} \" and the default, with a blank line between these parts. For a decision, each list item is one option: the label in bold, \" {3}\" after it only on the recommended option, and three nested bullets: the effect, \"{4} \" and the pros, \"{5} \" and the cons. For a check, each list item is one step: the action, and one nested bullet \"{6} \" and what to observe. Put nothing else inside.", m.decide, m.check, m.default, m.recommended, m.pros, m.cons, m.look),
    l10n.t("### {0} What should we choose?\n\nObserved: 3 of 5 runs failed (run.log). Question: retry or skip? You decide because it changes your workflow.\n\n1. **First choice** {1}\n   - What changes on your screen or in your work; the fact behind the recommendation.\n   - {2} Benefit versus the others, including other features.\n   - {3} Drawback versus the others, including other features.\n2. **Second choice**\n   - What changes for you.\n   - {2} Benefit versus the first.\n   - {3} Drawback versus the first.\n\n{4} Without an answer, I will continue with A.", m.decide, m.recommended, m.pros, m.cons, m.default),
    l10n.t("### {0} Check the result on your machine\n\nWhat I cannot verify here, and why.\n\n1. Open the changed screen.\n   - {1} Confirm the labels fit without clipping.\n2. Resize the window.\n   - {1} Confirm every action remains reachable.\n\n{2} While awaiting the result, I will continue with the independent work.", m.check, m.look, m.default),
  ].join("\n\n");
};
