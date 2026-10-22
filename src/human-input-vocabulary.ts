import type { ImageRefInfo } from "./protocol";
import { isLaisoraInputText } from "./laisora-input";

export const INJECTED_TAG_RE =
  /^<\/?(?:laisora-handoff|laisora-steer|command-message|command-name|command-args|local-command-[a-z-]+|system-reminder|task-notification)[\s>]/i;
export const QUEUED_COMMAND_TYPE = "queued_command";
export const STEER_TAG_RE = /^<\/?laisora-steer[\s>]/i;
export const LAISORA_ENVELOPE_RE = /^<\/?laisora-(?:handoff|steer)[\s>]/i;
export const COMMAND_ARGS_RE = /<command-args\b[^>]*>([\s\S]*?)<\/command-args>/i;
export const COMMAND_NAME_RE = /<command-name\b[^>]*>\s*\/?([^<\s]+)/i;
export const PURE_COMMAND_WRAPPER_RE = new RegExp(
  "^/(?:model|effort|color|clear|compact|context|help|init|login|logout|memory|permissions|" +
    "plan|resume|status|terminal-setup|vim|voice)\\s*$",
  "i"
);

export const CLI_USER_INTERRUPTED_TEXTS: readonly string[] = [
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
];

const CLI_SYNTHETIC_EXACT_TEXTS: readonly string[] = [
  ...CLI_USER_INTERRUPTED_TEXTS,
  "[Request interrupted: the session ended before this agent finished. Nobody asked it to stop.]",
  "[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]",
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
  "[Tool call result not in this copy: this session was copied from another session before that session recorded this call's result. The call may have finished there, may still be running there, or may never have run. Check whether it took effect before relying on it or running it again.]",
];

export const CLI_SYNTHETIC_PREFIXED_TEXTS: readonly string[] = [
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  "[Tool call skipped: the turn was stopped before this call ran, by the check whose denial is on another call in this batch. Nothing refused this call and it had no effects; re-run it if still needed.]",
  "[Tool call skipped: the turn ended to deliver the message that follows before this call ran. Nothing refused it; re-run it if still needed.]",
];

export const CLI_SYNTHETIC_USER_TEXTS: readonly string[] = [...CLI_SYNTHETIC_EXACT_TEXTS, ...CLI_SYNTHETIC_PREFIXED_TEXTS];

function isCliSyntheticUserText(text: string): boolean {
  const trimmed = text.trim();
  return CLI_SYNTHETIC_EXACT_TEXTS.includes(trimmed) || CLI_SYNTHETIC_PREFIXED_TEXTS.some((prefix) => trimmed.startsWith(prefix));
}

export function isInjectedContextBlockText(text: string): boolean {
  return text.startsWith("<ide_") || text.startsWith("<system-reminder>");
}

export function isCliSyntheticUserContent(content: unknown): boolean {
  if (typeof content === "string") return isCliSyntheticUserText(content);
  if (!Array.isArray(content)) return false;
  const blocks = content.filter((block) => {
    const b = block as { type?: unknown; text?: unknown } | null;
    return !(b?.type === "text" && typeof b.text === "string" && isInjectedContextBlockText(b.text));
  });
  return blocks.length > 0 && blocks.every((block) => {
    const b = block as { type?: unknown; text?: unknown; is_error?: unknown; content?: unknown } | null;
    const text = b?.type === "text" ? b.text : b?.type === "tool_result" && b.is_error === true ? b.content : undefined;
    return typeof text === "string" && isCliSyntheticUserText(text);
  });
}

const NON_HUMAN_COMMAND_NAMES = new Set(["rename"]);

const RAW_COMMAND_NAME_RE = /^\/([^\s]+)/;

export function isNonHumanCommandName(name: string | undefined): boolean {
  return name !== undefined && NON_HUMAN_COMMAND_NAMES.has(name.toLowerCase());
}

export function isNonHumanCommandInput(text: string): boolean {
  return isNonHumanCommandName(RAW_COMMAND_NAME_RE.exec(text.trim())?.[1]);
}

export function joinTextBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function isGapBoundaryText(text: string): boolean {
  if (text === "") return false;
  if (STEER_TAG_RE.test(text)) return false;
  if (INJECTED_TAG_RE.test(text)) {
    return !isNonHumanCommandName(COMMAND_NAME_RE.exec(text)?.[1]);
  }
  return PURE_COMMAND_WRAPPER_RE.test(text);
}

export function isPureCommandWrapper(text: string): boolean {
  return PURE_COMMAND_WRAPPER_RE.test(text.trim());
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null ? value as Record<string, any> : null;
}

export function contentText(content: unknown, trim = true): string {
  if (typeof content === "string") return trim ? content.trim() : content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === "object" && block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string";
    })
    .map((block) => block.text)
    .filter((text) => !isInjectedContextBlockText(text))
    .join("\n");
  return trim ? text.trim() : text;
}

export function extractImageRefs(
  content: unknown,
  uuid: string | undefined
): ImageRefInfo[] | undefined {
  if (!uuid || !Array.isArray(content)) return undefined;
  const refs: ImageRefInfo[] = [];
  let imageIndex = 0;
  for (const block of content) {
    const rec = asRecord(block);
    if (rec?.type !== "image") continue;
    const source = asRecord(rec.source);
    if (source?.type === "base64" && typeof source.media_type === "string") {
      const mt = source.media_type;
      if (mt === "image/png" || mt === "image/jpeg" || mt === "image/gif" || mt === "image/webp") {
        refs.push({
          ref: { kind: "record", uuid, index: imageIndex },
          mediaType: mt,
        });
      }
    }
    imageIndex++;
  }
  return refs.length > 0 ? refs : undefined;
}

function extractUserRecordText(obj: Record<string, unknown>): string | null {
  if (obj.type !== "user" || obj.isSidechain) return null;
  if (obj.isCompactSummary === true) return null;
  const origin = asRecord(obj.origin);
  if (origin && origin.kind !== "human") return null;
  const text = contentText(asRecord(obj.message)?.content);
  if (!text) {
    if (joinTextBlocks(asRecord(obj.message)?.content).trim()) return null;
    return extractImageRefs(asRecord(obj.message)?.content, typeof obj.uuid === "string" ? obj.uuid : undefined) ? "" : null;
  }
  if (text.startsWith("<local-command-stdout>")) return null;
  if (LAISORA_ENVELOPE_RE.test(text)) return null;
  if (INJECTED_TAG_RE.test(text)) {
    const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim();
    const command = COMMAND_NAME_RE.exec(text)?.[1];
    if (!args || (command && PURE_COMMAND_WRAPPER_RE.test(`/${command}`))) return null;
    if (isNonHumanCommandName(command)) return null;
    return args;
  }
  if (text.startsWith("Caveat:") || text.startsWith("Base directory for this skill:")) return null;
  if (isCliSyntheticUserContent(asRecord(obj.message)?.content)) return null;
  return text;
}

export function extractHumanUserText(obj: Record<string, unknown>): string | null {
  const record = extractQueuedPromptRecord(obj) ?? obj;
  return record.isMeta === true || isLaisoraInputRecord(record) ? null : extractUserRecordText(record);
}

function isLaisoraInputRecord(record: Record<string, unknown>): boolean {
  const text = extractUserRecordText(record);
  return text !== null && isLaisoraInputText(text);
}

export function extractQueuedPromptRecord(obj: Record<string, unknown>): Record<string, unknown> | null {
  const attachment = asRecord(obj.attachment);
  if (obj.type !== "attachment" || attachment?.type !== QUEUED_COMMAND_TYPE || attachment.commandMode !== "prompt") return null;
  if (obj.isSidechain === true || obj.isMeta === true || attachment.isMeta === true) return null;
  const origin = asRecord(attachment.origin) ?? asRecord(obj.origin);
  if (origin && origin.kind !== "human") return null;
  return { ...obj, type: "user", origin, message: { content: attachment.prompt } };
}

export function extractCliInsertedUserText(obj: Record<string, unknown>): string | null {
  return obj.isMeta === true || isLaisoraInputRecord(obj) ? extractUserRecordText(obj) : null;
}
