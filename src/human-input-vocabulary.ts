export const INJECTED_TAG_RE =
  /^<\/?(?:laisora-handoff|laisora-steer|command-message|command-name|local-command-[a-z-]+|system-reminder|task-notification)[\s>]/i;
export const STEER_TAG_RE = /^<\/?laisora-steer[\s>]/i;
export const LAISORA_ENVELOPE_RE = /^<\/?laisora-(?:handoff|steer)[\s>]/i;
export const COMMAND_ARGS_RE = /<command-args\b[^>]*>([\s\S]*?)<\/command-args>/i;
export const COMMAND_NAME_RE = /<command-name\b[^>]*>\s*\/?([^<\s]+)/i;
export const PURE_COMMAND_WRAPPER_RE = new RegExp(
  "^/(?:model|effort|color|clear|compact|context|help|init|login|logout|memory|permissions|" +
    "plan|resume|status|terminal-setup|vim|voice)\\s*$",
  "i"
);

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
