import { markLaisoraInput, type LaisoraInput } from "./laisora-input";
import { todoToolName } from "./todo-model";
import { SUMMARY_FENCE_INFO, SUMMARY_KEYS, SUMMARY_STATES, SUMMARY_WAIT_KINDS } from "./summary-block";

export type ClosingSummaryWork = "single" | "continued";

export const CLOSING_SUMMARY_SETTING_KEY = "claude.closingSummary";

export function closingSummaryEnabled(get: (key: typeof CLOSING_SUMMARY_SETTING_KEY) => unknown): boolean {
  return get(CLOSING_SUMMARY_SETTING_KEY) === true;
}

export const CLEAR_WORK_INSTRUCTION = "a clear work instruction (the user asks you to change, build, investigate or produce something)";
export const NOT_A_WORK_INSTRUCTION = "A question, a conversation, a confirmation or feedback on earlier work is not a work instruction";

const HANDOFF_CONTINUE_MARK = markLaisoraInput({ kind: "handoffContinue", closingSummary: false }, "").trim();
const HANDOFF_NOTICE = "a LAISORA handoff notice (a machine-generated LAISORA notice that this conversation will be handed off to a fresh session)";
const WAIT_REASONS = "a step that needs the user's approval, or a decision or real-machine check you asked of the user";
const CONTINUED_WORK_LASTS = "It stays continued work until the user gives a new work instruction; the user's answer to a decision, check or approval does not end it.";
const SCOPES: Record<ClosingSummaryWork, readonly string[]> = {
  single: [
    `Closing summary: when work begun from ${CLEAR_WORK_INSTRUCTION} ends, or stops to wait for the user (${WAIT_REASONS}), end the final reply of that turn with a closing summary.`,
    "This applies to work the user started with a work instruction in this conversation, not to continued work.",
    `Continued work is work this conversation continues after a handoff because of LAISORA's automatic continuation message (the message that starts with ${HANDOFF_CONTINUE_MARK}). ${CONTINUED_WORK_LASTS} Continued work gets a closing summary only when that message asks for one.`,
  ],
  continued: [
    `Closing summary: when the work this message asks you to continue ends, or has completely stopped to wait for the user (${WAIT_REASONS}), end the final reply of that turn with a closing summary.`,
    "Completely stopped means nothing you started is still running (no agents, background tasks or external runs) and no part of the work can go on without the user's answer. A turn in which you ask the user but go on with a stated default or other independent work gets no summary.",
    `The work this message asks you to continue is continued work. ${CONTINUED_WORK_LASTS}`,
  ],
};
const HANDOFF_RECORD = "When a LAISORA handoff notice arrives, include in the record it asks for everything done since the user's last work instruction, including what earlier conversations did according to any handoff material you received, so that a later conversation can summarize the whole work.";

const K = SUMMARY_KEYS;
const DONE_PARTS: readonly (readonly [string, string])[] = [
  [K.summary, "the result in one or two sentences: finished, and the outcome"],
  [K.done, "what was done"],
  [K.verified, "what was verified"],
  [K.unverified, "what was not verified"],
  [K.left, "what is left"],
];
const WAITING_PARTS: readonly (readonly [string, string])[] = [
  [K.progress, "what was done so far"],
  [K.waiting, "each decision, real-machine check or approval it waits for, by its title only"],
];
const partList = (parts: readonly (readonly [string, string])[]): string => parts.map(([key, what]) => `${key} (${what})`).join(", ");

const SUMMARY_BLOCK_FORMAT = [
  `Write the closing summary as one fenced code block whose language is exactly ${SUMMARY_FENCE_INFO}. Inside it: one key: value per line; a value is plain text or a JSON double-quoted string, and a plain value must not start with |, >, &, * or !; a list key has no value and its items follow on lines of exactly two spaces and "- ".`,
  `${K.state}: ${SUMMARY_STATES.done} when the work ended, ${SUMMARY_STATES.waiting} when it stops to wait for the user.`,
  `For ${SUMMARY_STATES.done}: ${partList(DONE_PARTS.slice(0, 1))}, then the lists ${partList(DONE_PARTS.slice(1))}; leave out a list that has nothing to say, key and all, and never write an item that only says there is nothing.`,
  `For ${SUMMARY_STATES.waiting}: the list ${partList(WAITING_PARTS.slice(0, 1))}, then the list ${partList(WAITING_PARTS.slice(1))}: each entry is "  - ${K.kind}: ${SUMMARY_WAIT_KINDS.decide}" for a decision, "  - ${K.kind}: ${SUMMARY_WAIT_KINDS.check}" for a real-machine check, or "  - ${K.kind}: ${SUMMARY_WAIT_KINDS.approve}" for an approval, and the next line "    ${K.title}: " with the exact title you gave that decision or check, or a short title of the approval.`,
  `LAISORA shows the block as a card; a block that does not follow this form shows as raw code. Example:\n\`\`\`${SUMMARY_FENCE_INFO}\n${K.state}: ${SUMMARY_STATES.done}\n${K.summary}: The export now writes CSV; all checks pass.\n${K.done}:\n  - Added the CSV writer\n${K.verified}:\n  - Unit checks pass\n${K.unverified}:\n  - Large files on a real machine\n\`\`\``,
].join("\n");

export const REMOTE_ORIGIN_SUMMARY_INSTRUCTION = (): string => [
  `In this turn, if you write a closing summary, write it in this plain Markdown form instead of a ${SUMMARY_FENCE_INFO} block:`,
  `a bold line naming the report in the user's language (finished, or waiting for the user), then for each part with content its name in bold in the user's language and a bullet list. Finished: ${partList(DONE_PARTS)}. Waiting: ${partList(WAITING_PARTS)}, each marked as a decision, real-machine check or approval.`,
].join(" ");

export function closingSummaryInstruction(work: ClosingSummaryWork, linked: boolean): string {
  const continued = work === "continued";
  const sources = linked ? "the handoff material and the linked TODO item's work memo" : "the handoff material";
  return [
    ...SCOPES[work],
    ...continued ? [`The summary covers the whole work since the user's last work instruction, including what earlier conversations did, taken from ${sources}.`] : [],
    `Write it in the user's language for a reader who did not follow the work: outcomes, not a log. Make every other tool call of the turn first (${linked ? "step updates, the work memo, the item state" : "such as step updates"}); the summary is the last thing in the reply.`,
    SUMMARY_BLOCK_FORMAT,
    `Exception to the summary being last: when you ask for the wait through a tool call (AskUserQuestion), write the ${SUMMARY_STATES.waiting} summary before that call.`,
    `Do not write it in a turn that ends only to wait for agents or background tasks you started, in the reply to ${HANDOFF_NOTICE}, or for anything that is not such work. ${NOT_A_WORK_INSTRUCTION}.`,
    ...continued ? [HANDOFF_RECORD] : [],
    ...linked ? [`Also write the closing summary into the linked TODO item's work memo with one ${todoToolName("write_memo")} call, made before the summary text, using sections: ${K.summary}, ${K.done}, ${K.verified} and ${K.unverified} (or ${K.progress}) into current; ${K.left} into next; ${K.waiting} into open.`] : [],
  ].join("\n");
}

export function continuedWorkSummaryIn(input: LaisoraInput): boolean {
  return input.kind === "handoffContinue" && input.closingSummary;
}

export function continuedWorkSummaryAfterSend(send: { sent: boolean; sameGeneration: boolean; input: LaisoraInput | undefined }): boolean {
  return send.sent && send.sameGeneration && send.input !== undefined && continuedWorkSummaryIn(send.input);
}
