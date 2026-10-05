import { redactAbsolutePaths } from "./path-redaction";
import { subagentResultForDisplay } from "./subagent-result";
import type { TaskNotificationInfo } from "./protocol";

export const RESULT_PREVIEW_MAX = 2000;

export function boundedDisplayText(text: string): string {
  const display = redactAbsolutePaths(subagentResultForDisplay(text));
  let end = Math.min(display.length, RESULT_PREVIEW_MAX);
  if (end < display.length && /[\uD800-\uDBFF]/.test(display[end - 1])) end--;
  return end === display.length ? display : `${display.slice(0, end)}\n[${display.length - end} characters omitted]`;
}

export function toolResultPreview(content: unknown): string {
  if (typeof content === "string") return boundedDisplayText(content);
  if (!Array.isArray(content)) return "";
  const text = content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
  const images = content.filter(b => b?.type === "image").length;
  const marker = images === 0 ? "" : images === 1 ? "[Image]" : `[${images} images]`;
  return [boundedDisplayText(text), marker].filter(Boolean).join("\n");
}

export function taskNotificationDisplayFields(summary: unknown, result: unknown): Pick<TaskNotificationInfo, "summary" | "result"> {
  return {
    ...(typeof summary === "string" && summary.trim() ? { summary: boundedDisplayText(summary.trim()) } : {}),
    ...(typeof result === "string" && result.trim() ? { result: boundedDisplayText(result.trim()) } : {}),
  };
}

export function taskNotificationPreview(notification: TaskNotificationInfo): string {
  return [notification.summary ? `Summary: ${notification.summary}` : "", notification.result ? `Result: ${notification.result}` : ""].filter(Boolean).join("\n");
}

export function localCommandOutput(record: Record<string, unknown>): string | undefined {
  if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true || typeof record.parent_tool_use_id === "string") return undefined;
  const origin = record.origin as { kind?: unknown } | undefined;
  if (origin && origin.kind !== "human") return undefined;
  const command = record.commandRun as { command?: unknown } | undefined;
  if (command?.command === "/compact" || command?.command === "compact") return undefined;
  let text: string;
  if (record.type === "system" && (record.subtype === "local_command" || record.subtype === "local_command_output")) {
    if (typeof record.content !== "string") return undefined;
    text = record.content;
  } else if (record.type === "user") {
    const message = record.message as { content?: unknown } | undefined;
    const content = message?.content;
    text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(b => b?.type === "text" && typeof b.text === "string" && b.text.trimStart().startsWith("<local-command-stdout>"))
        .map(b => b.text).join("\n") : "";
    if (!/^\s*<local-command-stdout>/.test(text)) return undefined;
  } else return undefined;
  const wrapped = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/.exec(text);
  if (text.trimStart().startsWith("<local-command-stdout>") && !wrapped) return undefined;
  const output = (wrapped ? wrapped[1] : text).trim();
  return output ? boundedDisplayText(output) : undefined;
}

