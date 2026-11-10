import { redactAbsolutePaths } from "./path-redaction";

export const TOOL_INPUT_PREVIEW_MAX = 500;
export const TODO_WRITE_INPUT_PREVIEW_MAX = 20_000;

export function toolInputPreview(toolName: string, input: unknown): string {
  return redactAbsolutePaths(JSON.stringify(input)).slice(0, toolName === "TodoWrite" ? TODO_WRITE_INPUT_PREVIEW_MAX : TOOL_INPUT_PREVIEW_MAX);
}
