const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}
