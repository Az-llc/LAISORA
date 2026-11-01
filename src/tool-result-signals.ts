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
const HOOK_EVENTS = [HOOK_DENIAL_EVENT, "PostToolUse", "PermissionRequest", "UserPromptSubmit", "Stop", "SubagentStop"] as const;
type HookEvent = typeof HOOK_EVENTS[number];
const HOOK_DENIAL_SUFFIX = " hook error:";
export function hookDenialText(toolName: string, reason: string): string {
  return `${HOOK_DENIAL_EVENT}:${toolName}${HOOK_DENIAL_SUFFIX} ${reason}`;
}
const HOOK_DENIAL = String.raw`${escapeRegExp(HOOK_DENIAL_EVENT)}(?::\S+)?${escapeRegExp(HOOK_DENIAL_SUFFIX)}`;
const HARNESS_DENIED = "Permission for this action was denied by";
const INPUT_VALIDATION = "InputValidationError|Invalid arguments for tool";
const AUTO_MODE_COULD_NOT_EVALUATE = "Auto mode could not evaluate this action";
export const AUTO_MODE_UNEVALUATED = `${AUTO_MODE_COULD_NOT_EVALUATE} and is blocking it for safety`;
const CLASSIFIER_GAVE_NO_VERDICT = "auto mode classifier gave no verdict";
const CLASSIFIER_NO_VERDICT = `The server-side ${CLASSIFIER_GAVE_NO_VERDICT}`;
const CLASSIFIER_UNAVAILABLE_RE = new RegExp([CLASSIFIER_GAVE_NO_VERDICT, "classifier:auto-mode:unavailable", AUTO_MODE_COULD_NOT_EVALUATE].map(escapeRegExp).join("|"));
const CLASSIFIER_DENIAL_RE = /denied by the Claude Code auto mode classifier\. Reason: ([^\n]*?)(?:\. If you have| IMPORTANT|$)/;
const SAFETY_CHECK = "built-in Claude Code safety check";
const SAFETY_BOILERPLATE_RE = new RegExp(String.raw`^\s*Permission for this command was denied by a ${escapeRegExp(SAFETY_CHECK)}, not by the user\.\s*`);
const PERMISSION_PROMPT_RE = /The following part requires approval:[^\n]{0,80}|requested permissions to \w+ (?:from|to|in) [^\n,]{0,120}, but you haven't granted it yet|requires approval[^\n]{0,60}/;
const HOOK_ERROR_RE = new RegExp(String.raw`^(${HOOK_EVENTS.join("|")})(?::\S+)?${escapeRegExp(HOOK_DENIAL_SUFFIX)} ([\s\S]*)$`);
const EXIT_CODE_RE = /^Exit code (\d+)/;
const AGENT_TYPE_NOT_FOUND = String.raw`Agent type '[^'\n]*' not found\. Available agents:`;
const ISOLATION_WORKTREE_REFUSED = String.raw`Refusing to use [^\n]* as an isolation worktree:`;

export function laisoraDenialMessage(): string {
  return l10n.t("Denied by the LAISORA user");
}
const LAISORA_DENIALS = [enLaisoraDenial, jaLaisoraDenial].map(escapeRegExp);

const anchored = (...parts: string[]): RegExp => new RegExp(`^(?:${parts.join("|")})`);

export const HUMAN_REJECTED_TOOL_RESULT_RE = anchored(PERMISSION_REFUSED, USER_INTERRUPTED);
export const HARNESS_DENIED_TOOL_RESULT_RE = new RegExp(HARNESS_DENIED);
export const INPUT_VALIDATION_TOOL_RESULT_RE = new RegExp(INPUT_VALIDATION);
const REJECTED_BEFORE_RUN_RE = anchored(HOOK_DENIAL, HARNESS_DENIED, INPUT_VALIDATION, AUTO_MODE_UNEVALUATED,
  CLASSIFIER_NO_VERDICT, AGENT_TYPE_NOT_FOUND, ISOLATION_WORKTREE_REFUSED, ...LAISORA_DENIALS);

export function stripToolUseErrorTags(text: string): string {
  return text.replace(/<\/?tool_use_error>/g, "");
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

export const isShellTool = (tool: string): boolean => tool === "Bash" || tool === "PowerShell";

export type ToolFailure =
  | { kind: "classifier_unavailable" }
  | { kind: "classifier_denial"; reason: string | undefined }
  | { kind: "safety_check"; message: string }
  | { kind: "permission_prompt"; prompt: string }
  | { kind: "user_rejected" }
  | { kind: "hook_denial"; event: HookEvent | undefined; body: string }
  | { kind: "nonzero_exit"; code: number }
  | { kind: "mcp_tool_error" | "builtin_tool_error" | "other" };

export type ToolFailureKind = ToolFailure["kind"];

export interface ToolFailureRecord {
  permissionDecision?: { reasonType?: string; source?: string; decision?: string; classifierCategory?: string };
  toolDenialKind?: unknown;
}

export function classifyToolFailure(rawText: string, toolName: string | undefined, record: ToolFailureRecord = {}): ToolFailure {
  const text = stripToolUseErrorTags(rawText).trimStart();
  const pd = record.permissionDecision;
  const denial = record.toolDenialKind;
  const hook = HOOK_ERROR_RE.exec(text);
  if (hook) return { kind: "hook_denial", event: hook[1] as HookEvent, body: hook[2] };
  if (CLASSIFIER_UNAVAILABLE_RE.test(text) || denial === "automode-unavailable") return { kind: "classifier_unavailable" };
  const classifier = CLASSIFIER_DENIAL_RE.exec(text);
  if (classifier || denial === "automode-blocked") {
    return { kind: "classifier_denial", reason: classifier ? classifier[1].replace(/^\[|\]$/g, "") : pd?.classifierCategory || undefined };
  }
  if (pd?.reasonType === "safetyCheck" || text.includes(SAFETY_CHECK)) return { kind: "safety_check", message: text.replace(SAFETY_BOILERPLATE_RE, "") };
  const prompt = PERMISSION_PROMPT_RE.exec(text);
  if (prompt) return { kind: "permission_prompt", prompt: prompt[0] };
  if (denial === "user-rejected" || isCliRejectionText(text) || isLaisoraDenialText(text) || isInterruptedWhileRunning({ isError: true, resultPreview: text })) {
    return { kind: "user_rejected" };
  }
  if (pd?.source === "hook" && pd?.decision !== "accept") return { kind: "hook_denial", event: undefined, body: text };
  const tool = toolName || undefined;
  const exit = tool !== undefined && isShellTool(tool) ? EXIT_CODE_RE.exec(text) : null;
  if (exit) return { kind: "nonzero_exit", code: Number(exit[1]) };
  return { kind: tool?.startsWith("mcp__") ? "mcp_tool_error" : tool === undefined || tool === "?" || isShellTool(tool) ? "other" : "builtin_tool_error" };
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
