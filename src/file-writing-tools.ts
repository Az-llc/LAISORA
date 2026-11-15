export const FILE_WRITING_TOOLS = ["Edit", "Write", "MultiEdit"] as const;
export const NOTEBOOK_EDIT_TOOL = "NotebookEdit";
export const FILE_CHANGING_TOOLS = [...FILE_WRITING_TOOLS, NOTEBOOK_EDIT_TOOL] as const;
export const FILE_TARGET_TOOLS = ["Read", ...FILE_CHANGING_TOOLS] as const;

const FILE_WRITING_TOOL_SET: ReadonlySet<string> = new Set(FILE_WRITING_TOOLS);
export const FILE_CHANGING_TOOL_SET: ReadonlySet<string> = new Set(FILE_CHANGING_TOOLS);
export const FILE_TARGET_TOOL_SET: ReadonlySet<string> = new Set(FILE_TARGET_TOOLS);

export function isFileWritingTool(toolName: string): boolean {
  return FILE_WRITING_TOOL_SET.has(toolName);
}

export function isFileChangingTool(toolName: string): boolean {
  return FILE_CHANGING_TOOL_SET.has(toolName);
}
