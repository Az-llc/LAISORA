import * as l10n from "@vscode/l10n";
import { CLI_USER_INTERRUPTED_TEXTS } from "./human-input-vocabulary";
import { "Denied by the LAISORA user" as enLaisoraDenial } from "../l10n/bundle.l10n.json";
import { "Denied by the LAISORA user" as jaLaisoraDenial } from "../l10n/bundle.l10n.ja.json";

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOOL_USE_REJECTED_HEAD = "The user doesn't want to proceed with this tool use";
export const TOOL_USE_REJECTED_TEXT = `${TOOL_USE_REJECTED_HEAD}. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`;
export const TOOL_USE_REJECTED_RESULT = "User rejected tool use";
const PERMISSION_REFUSED = `${escapeRegExp(TOOL_USE_REJECTED_HEAD)}\\b`;
export const TOOL_USE_ERROR_PREFIX = "Error: ";
const OPTIONAL_ERROR_PREFIX = `(?:${escapeRegExp(TOOL_USE_ERROR_PREFIX)})?`;
const CLI_REJECTION_RE = new RegExp(`^${OPTIONAL_ERROR_PREFIX}${escapeRegExp(TOOL_USE_REJECTED_RESULT)}\\b`);
const USER_INTERRUPTED = CLI_USER_INTERRUPTED_TEXTS.map(escapeRegExp).join("|");
const HOOK_DENIAL_EVENT = "PreToolUse";
const HOOK_DENIAL_SUFFIX = " hook error:";
export function hookDenialText(toolName: string, reason: string): string {
  return `${HOOK_DENIAL_EVENT}:${toolName}${HOOK_DENIAL_SUFFIX} ${reason}`;
}
const HOOK_DENIAL = String.raw`${escapeRegExp(HOOK_DENIAL_EVENT)}(?::\S+)?${escapeRegExp(HOOK_DENIAL_SUFFIX)}`;
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
const REJECTED_BEFORE_RUN_RE = anchored(HOOK_DENIAL, HARNESS_DENIED, INPUT_VALIDATION, AUTO_MODE_UNEVALUATED,
  CLASSIFIER_NO_VERDICT, AGENT_TYPE_NOT_FOUND, ISOLATION_WORKTREE_REFUSED, ...LAISORA_DENIALS);

export function stripToolUseErrorTags(text: string): string {
  return text.replace(/<\/?tool_use_error>/g, "");
}

export function isHookDenial(text: string): boolean {
  return HOOK_DENIAL_RE.test(stripToolUseErrorTags(text).trimStart());
}

const LAISORA_DENIAL_RE = new RegExp(`^${OPTIONAL_ERROR_PREFIX}(?:${LAISORA_DENIALS.join("|")})`);

export function isCliRejectionText(text: string): boolean {
  return CLI_REJECTION_RE.test(stripToolUseErrorTags(text).trimStart());
}

export function isLaisoraDenialText(text: string): boolean {
  return LAISORA_DENIAL_RE.test(stripToolUseErrorTags(text).trimStart());
}

type ToolResultSignal = { isError?: boolean; resultPreview: string };

export function isRejectedBeforeRun(result: ToolResultSignal): boolean {
  return result.isError === true && REJECTED_BEFORE_RUN_RE.test(stripToolUseErrorTags(result.resultPreview).trimStart());
}

export function isInterruptedWhileRunning(result: ToolResultSignal): boolean {
  return result.isError === true && HUMAN_REJECTED_TOOL_RESULT_RE.test(stripToolUseErrorTags(result.resultPreview).trimStart());
}

export function isFailedToolResult(result: ToolResultSignal): boolean {
  return result.isError === true && !isInterruptedWhileRunning(result);
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
