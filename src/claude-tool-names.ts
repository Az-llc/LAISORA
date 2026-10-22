import { isExternalRunTool } from "./orchestration-executors";

export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

export function isDelegationTool(toolName: string): boolean {
  return DELEGATION_TOOL_NAMES.has(toolName);
}

export function isDelegationLaunchTool(toolName: string): boolean {
  return isDelegationTool(toolName) || isExternalRunTool(toolName);
}

export function isTaskTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.has(toolName);
}

export function isCountedExternalRunCall(call: { toolName: string; rejectedBeforeRun?: boolean }): boolean {
  return isExternalRunTool(call.toolName) && call.rejectedBeforeRun !== true;
}

export function delegationCount(counts: { agentCount: number; externalRunCount?: number }): number {
  return counts.agentCount + (counts.externalRunCount ?? 0);
}
