import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type { AskUserQuestionSpec } from "./protocol";
import { laisoraDenialMessage } from "./tool-result-signals";
import { isCommandInput } from "./human-input-vocabulary";

export const ASK_UNANSWERED_KINDS = ["skipped", "replied_in_chat", "dismissed"] as const;
export type AskUnansweredKind = typeof ASK_UNANSWERED_KINDS[number];

export function isAskUnansweredKind(value: unknown): value is AskUnansweredKind {
  return (ASK_UNANSWERED_KINDS as readonly unknown[]).includes(value);
}

export const APPROVAL_RESOLVED_BY = {
  user: "user",
  chat: "chat",
  turnEnd: "turn-end",
  interrupt: "interrupt",
  dispose: "dispose",
  withdrawn: "withdrawn",
} as const;

type SentUnansweredKind = Exclude<AskUnansweredKind, "dismissed">;

const ASK_UNANSWERED_BY: ReadonlyMap<string, SentUnansweredKind> = new Map([
  [APPROVAL_RESOLVED_BY.user, "skipped"],
  [APPROVAL_RESOLVED_BY.chat, "replied_in_chat"],
]);

const ASK_UNANSWERED_MODEL_TEXT: Readonly<Record<SentUnansweredKind, string>> = {
  skipped: "(not answered: the user skipped this question; do not assume an answer)",
  replied_in_chat: "(not answered: the user replied in the chat instead; read the user's next message)",
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function askUnansweredQuestions(toolUseResult: unknown): Map<string, AskUnansweredKind> {
  const out = new Map<string, AskUnansweredKind>();
  const annotations = asObject(asObject(toolUseResult)?.annotations);
  for (const [question, annotation] of Object.entries(annotations ?? {})) {
    const kind = asObject(annotation)?.unanswered;
    if (isAskUnansweredKind(kind)) out.set(question, kind);
  }
  return out;
}

export function askUnansweredOf(toolUseResult: unknown): AskUnansweredKind | undefined {
  return askUnansweredQuestions(toolUseResult).values().next().value;
}

export function questionsRepliedInChat(
  text: string,
  unansweredCapable: boolean,
  pending: readonly { requestId: string; question: boolean }[]
): string[] {
  if (!unansweredCapable || isCommandInput(text)) return [];
  return pending.filter((p) => p.question).map((p) => p.requestId);
}

export interface ApprovalOutcome {
  behavior: "allow" | "deny";
  answers?: Record<string, string>;
  resolvedBy?: string;
}

export function approvalPermission(
  input: Record<string, unknown>,
  questions: AskUserQuestionSpec | undefined,
  decision: ApprovalOutcome,
  unansweredCapable: boolean
): { permission: PermissionResult; unanswered?: AskUnansweredKind } {
  if (decision.behavior === "allow") {
    return { permission: { behavior: "allow", updatedInput: decision.answers ? { ...input, answers: decision.answers } : input } };
  }
  const denied = { permission: { behavior: "deny", message: laisoraDenialMessage() } as PermissionResult };
  const kind = decision.resolvedBy !== undefined ? ASK_UNANSWERED_BY.get(decision.resolvedBy) : undefined;
  const texts = [...new Set(questions?.questions.map((q) => q.question) ?? [])];
  if (kind === undefined || !unansweredCapable || texts.length === 0) return denied;
  const annotations = asObject(input.annotations) ?? {};
  return {
    unanswered: kind,
    permission: {
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: Object.fromEntries(texts.map((q) => [q, ASK_UNANSWERED_MODEL_TEXT[kind]])),
        annotations: { ...annotations, ...Object.fromEntries(texts.map((q) => [q, { ...asObject(annotations[q]), unanswered: kind }])) },
      },
    },
  };
}
