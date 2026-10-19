export const FILE_WRITING_TOOLS = ["Edit", "Write", "MultiEdit"] as const;

const FILE_WRITING_TOOL_SET: ReadonlySet<string> = new Set(FILE_WRITING_TOOLS);

export function isFileWritingTool(toolName: string): boolean {
  return FILE_WRITING_TOOL_SET.has(toolName);
}
