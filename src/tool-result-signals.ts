import * as l10n from "@vscode/l10n";
import { CLI_USER_INTERRUPTED_TEXTS } from "./human-input-vocabulary";
import { "Denied by the LAISORA user" as enLaisoraDenial } from "../l10n/bundle.l10n.json";
import { "Denied by the LAISORA user" as jaLaisoraDenial } from "../l10n/bundle.l10n.ja.json";

// Tool result text the harness writes for calls that were refused, stopped or rejected, used to classify failures.
const PERMISSION_REFUSED = String.raw`The user doesn't want to proceed with this tool use\b`;
const CLI_REJECTION_RE = /^(?:Error: )?User rejected tool use\b/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const USER_INTERRUPTED = CLI_USER_INTERRUPTED_TEXTS.map(escapeRegExp).join("|");
const HOOK_DENIAL = String.raw`PreToolUse(?::[\w|*]+)? hook error:`;
const HARNESS_DENIED = "Permission for this action was denied by";
const INPUT_VALIDATION = "InputValidationError|Invalid arguments for tool";
export const AUTO_MODE_UNEVALUATED = "Auto mode could not evaluate this action and is blocking it for safety";
const CLASSIFIER_NO_VERDICT = "The server-side auto mode classifier gave no verdict";
const AGENT_TYPE_NOT_FOUND = String.raw`Agent type '[^'\n]*' not found\. Available agents:`;
const ISOLATION_WORKTREE_REFUSED = String.raw`Refusing to use [^\n]* as an isolation worktree:`;

export function laisoraDenialMessage(): string {
  return l10n.t("Denied by the LAISORA user");
}
const LAISORA_DENIALS = [enLaisoraDenial, jaLaisoraDenial].map(escapeRegExp);

const anchored = (...parts: string[]): RegExp => new RegExp(`^(?:${parts.join("|")})`);

export const HUMAN_REJECTED_TOOL_RESULT_RE = anchored(PERMISSION_REFUSED, USER_INTERRUPTED);
export const HOOK_DENIAL_RE = anchored(HOOK_DENIAL);
export const HARNESS_DENIED_TOOL_RESULT_RE = new RegExp(HARNESS_DENIED);
export const INPUT_VALIDATION_TOOL_RESULT_RE = new RegExp(INPUT_VALIDATION);
const REJECTED_BEFORE_RUN_RE = anchored(HOOK_DENIAL, PERMISSION_REFUSED, HARNESS_DENIED, INPUT_VALIDATION, AUTO_MODE_UNEVALUATED,
  CLASSIFIER_NO_VERDICT, AGENT_TYPE_NOT_FOUND, ISOLATION_WORKTREE_REFUSED, ...LAISORA_DENIALS);

export function stripToolUseErrorTags(text: string): string {
  return text.replace(/<\/?tool_use_error>/g, "");
}

export function isHookDenial(text: string): boolean {
  return HOOK_DENIAL_RE.test(stripToolUseErrorTags(text).trimStart());
}

const LAISORA_DENIAL_RE = new RegExp(`^(?:Error: )?(?:${LAISORA_DENIALS.join("|")})`);

export function isCliRejectionText(text: string): boolean {
  return CLI_REJECTION_RE.test(stripToolUseErrorTags(text).trimStart());
}

export function isLaisoraDenialText(text: string): boolean {
  return LAISORA_DENIAL_RE.test(stripToolUseErrorTags(text).trimStart());
}

export function isRejectedBeforeRun(result: { isError?: boolean; resultPreview: string }): boolean {
  return result.isError === true && REJECTED_BEFORE_RUN_RE.test(stripToolUseErrorTags(result.resultPreview).trimStart());
}

export type TaskTerminal = "completed" | "failed" | "stale";

export type TaskNotificationOutcome = "completed" | "failed" | "stopped";

export function taskNotificationOutcome(status: string | undefined): TaskNotificationOutcome | undefined {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "stopped" || status === "killed" ? "stopped" : undefined;
}

export function taskNotificationTerminal(status: string | undefined): TaskTerminal {
  const outcome = taskNotificationOutcome(status);
  return outcome === "completed" || outcome === "failed" ? outcome : "stale";
}
