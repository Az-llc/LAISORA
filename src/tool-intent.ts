import { redactAbsolutePaths } from "./path-redaction";
import { isExternalRunTool } from "./orchestration-executors";
import { isDelegationTool } from "./claude-tool-names";

const INTENT_FIELDS = ["description", "subagent_type", "agent_key", "effort", "target", "prompt", "file_path", "pattern", "url", "query"] as const;
export type ToolIntentInput = Partial<Record<typeof INTENT_FIELDS[number], string>>;

export function isToolIntentInput(value: unknown): value is ToolIntentInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    (!Object.prototype.propertyIsEnumerable.call(input, "description") || typeof input.description === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "subagent_type") || typeof input.subagent_type === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "agent_key") || typeof input.agent_key === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "effort") || typeof input.effort === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "target") || typeof input.target === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "prompt") || typeof input.prompt === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "file_path") || typeof input.file_path === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "pattern") || typeof input.pattern === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "url") || typeof input.url === "string") &&
    (!Object.prototype.propertyIsEnumerable.call(input, "query") || typeof input.query === "string") &&
    Object.keys(input).every(key => (INTENT_FIELDS as readonly string[]).includes(key))
  );
}

export const basename = (value: string): string => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
export const firstLine = (value: string): string => value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";

export function captureToolIntentInput(name: string, input: unknown): ToolIntentInput | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const fields: readonly (typeof INTENT_FIELDS[number])[] = isExternalRunTool(name)
    ? ["target", "description", "prompt"]
    : isDelegationTool(name) ? ["description", "subagent_type", "agent_key", "effort"]
    : name === "Bash" || name === "PowerShell" ? ["description"]
    : name === "Read" || name === "Edit" || name === "Write" ? ["file_path"]
    : name === "Grep" || name === "Glob" ? ["pattern"]
    : name === "WebFetch" ? ["url"] : name === "WebSearch" ? ["query"] : [];
  const result: ToolIntentInput = {};
  for (const key of fields) {
    const value = source[key];
    if (typeof value !== "string" || !value.trim()) continue;
    result[key] = redactAbsolutePaths(key === "prompt" ? firstLine(value)
      : key === "file_path" || name === "Glob" && key === "pattern" ? basename(value) : value.trim());
  }
  return Object.keys(result).length ? result : undefined;
}

export function conductorStopTarget(toolName: string, inputPreview: string): string | undefined {
  if (toolName !== "TaskStop") return undefined;
  try {
    const taskId = (JSON.parse(inputPreview) as { task_id?: unknown }).task_id;
    return typeof taskId === "string" && taskId !== "" ? taskId : undefined;
  } catch {
    return undefined;
  }
}
