import { extractArtifactAccesses, projectArtifactAccess, PROGRESS_WIRE_TOOL_NAME } from "./artifact-access";
import type { EffectCoverage, HostArtifactAccess, ProjectedArtifactAccess } from "./artifact-access";
import { redactAbsolutePaths, redactOptional } from "./path-redaction";
import type { DelegationInfo, ProgressEmission, ProgressState, TaskNotificationInfo } from "./protocol";
import { parseTaskIntentFromRawInput } from "./work-model";
import type { TaskIntent } from "./work-model";
import { taskNotificationDisplayFields } from "./transcript-display";
import { isExternalRunTool } from "./orchestration-executors";

export interface Stage0ToolFields {
  delegation?: DelegationInfo;
  taskIntentStructured?: TaskIntent;
  artifacts: ProjectedArtifactAccess[];
  effectCoverage: EffectCoverage;
  hostArtifacts: HostArtifactAccess[];
  progressEmission?: ProgressEmission;
}

const PROGRESS_STRING_CAP = 500;
const PROGRESS_EVIDENCE_MAX = 8;
const PROGRESS_STATES: ReadonlySet<string> = new Set(["active", "blocked", "review", "done"]);

function normalizeProgressString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactAbsolutePaths(value.trim()).slice(0, PROGRESS_STRING_CAP).trim();
  return redacted === "" ? undefined : redacted;
}

export function extractProgressEmission(
  toolName: string,
  input: Record<string, unknown> | undefined
): ProgressEmission | undefined {
  if (toolName !== PROGRESS_WIRE_TOOL_NAME) return undefined;
  if (!input || typeof input !== "object") return undefined;
  if (input.pp !== "pp1") return undefined;
  let taskId: string | undefined;
  if ("task_id" in input) {
    taskId = normalizeProgressString(input.task_id);
    if (taskId === undefined) return undefined;
  }
  const state = typeof input.state === "string" && PROGRESS_STATES.has(input.state) ? (input.state as ProgressState) : undefined;
  if (state === undefined) return undefined;
  const activity = normalizeProgressString(input.activity);
  const blocker = normalizeProgressString(input.blocker);
  const next = normalizeProgressString(input.next);
  let evidence: string[] | undefined;
  if (Array.isArray(input.evidence)) {
    evidence = input.evidence
      .slice(0, PROGRESS_EVIDENCE_MAX)
      .map((e) => normalizeProgressString(e))
      .filter((e): e is string => e !== undefined);
    if (evidence.length === 0) evidence = undefined;
  }
  return {
    pp: "pp1",
    ...(taskId !== undefined ? { taskId } : {}),
    state,
    ...(activity !== undefined ? { activity } : {}),
    ...(blocker !== undefined ? { blocker } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(next !== undefined ? { next } : {}),
  };
}

function redactTaskIntent(intent: TaskIntent | undefined): TaskIntent | undefined {
  if (!intent) return undefined;
  if (intent.kind === "todo") {
    return { ...intent, items: intent.items.map(item => ({
      ...item,
      taskKey: `todo:${redactAbsolutePaths(item.taskKey.slice("todo:".length))}`,
      description: redactAbsolutePaths(item.description),
      activeForm: redactOptional(item.activeForm),
    })) };
  }
  if (intent.kind === "create") {
    return { ...intent, subject: redactAbsolutePaths(intent.subject), activeForm: redactOptional(intent.activeForm) };
  }
  return { ...intent, taskKey: `task:${redactAbsolutePaths(intent.taskKey.slice("task:".length))}`, subject: redactOptional(intent.subject),
    activeForm: redactOptional(intent.activeForm) };
}

export function extractStage0ToolFields(
  toolName: string,
  input: Record<string, unknown> | undefined,
  toolUseId: string,
  baseDir: string
): Stage0ToolFields {
  const isAgentTool = toolName === "Task" || toolName === "Agent";

  let delegation: DelegationInfo | undefined;
  if (isAgentTool && input) {
    const subagentType = typeof input.subagent_type === "string" ? redactAbsolutePaths(input.subagent_type) : undefined;
    const subagentModel =
      typeof input.model === "string" && input.model && input.model !== "inherit" ? redactAbsolutePaths(input.model) : undefined;
    const isBackground = input.run_in_background === true ? true : undefined;
    let description: string | undefined;
    if (typeof input.description === "string") {
      const trimmed = redactAbsolutePaths(input.description.trim()).slice(0, 200).trim();
      if (trimmed !== "") description = trimmed;
    }
    if (subagentType !== undefined || subagentModel !== undefined || isBackground !== undefined || description !== undefined) {
      delegation = {
        ...(subagentType !== undefined ? { subagentType } : {}),
        ...(subagentModel !== undefined ? { subagentModel } : {}),
        ...(isBackground !== undefined ? { isBackground } : {}),
        ...(description !== undefined ? { description } : {}),
      };
    }
  }

  const taskIntentStructured = redactTaskIntent(parseTaskIntentFromRawInput(toolName, input, toolUseId));
  const extraction = extractArtifactAccesses(toolName, input, baseDir);
  const progressEmission = extractProgressEmission(toolName, input);

  return {
    delegation,
    taskIntentStructured,
    artifacts: extraction.artifacts.map(projectArtifactAccess),
    effectCoverage: extraction.effectCoverage,
    hostArtifacts: extraction.artifacts,
    ...(progressEmission !== undefined ? { progressEmission } : {}),
  };
}

export interface ResumeSignals {
  asyncLaunchedAgentId?: string;
  resumedAgentId?: string;
  backgroundTaskId?: string;
}

export const RESUME_SIGNAL_TOOL_NAMES: ReadonlySet<string> = new Set(["Task", "Agent", "SendMessage", "Bash"]);
export const isResumeSignalToolName = (name: string): boolean =>
  RESUME_SIGNAL_TOOL_NAMES.has(name) || /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name) || isExternalRunTool(name);

const BASH_BACKGROUND_ACK_RE = /^Command running in background with ID: ([A-Za-z0-9][A-Za-z0-9._-]*)\. Output is being written to:/;
const MCP_BACKGROUND_ACK_RE = /^MCP tool "([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)" is still running after \d+s\. It was moved to the background as task ([A-Za-z0-9][A-Za-z0-9._-]*) and keeps running;/;

export function extractResumeSignals(
  toolName: string | undefined,
  rawResultText: string
): ResumeSignals | undefined {
  const text = rawResultText.trimStart();
  if (toolName === "Task" || toolName === "Agent") {
    if (text.startsWith("Async agent launched successfully")) {
      const m = /^agentId:\s*([A-Za-z0-9._-]+)/m.exec(text);
      if (m) return { asyncLaunchedAgentId: m[1] };
    }
    return undefined;
  }
  if (toolName === "Bash") {
    const m = BASH_BACKGROUND_ACK_RE.exec(text);
    return m ? { backgroundTaskId: m[1] } : undefined;
  }
  if (toolName !== undefined && isExternalRunTool(toolName)) {
    const m = MCP_BACKGROUND_ACK_RE.exec(text);
    return m && (toolName === `${m[1]}__${m[2]}` || toolName.endsWith(`__${m[1]}__${m[2]}`)) ? { backgroundTaskId: m[3] } : undefined;
  }
  if (toolName?.startsWith("mcp__")) {
    const m = MCP_BACKGROUND_ACK_RE.exec(text);
    return m && toolName === `mcp__${m[1]}__${m[2]}` ? { backgroundTaskId: m[3] } : undefined;
  }
  if (toolName === "SendMessage") {
    if (text.startsWith("{") && text.includes('"resumedAgentId"')) {
      try {
        const obj: unknown = JSON.parse(rawResultText);
        if (
          typeof obj === "object" &&
          obj !== null &&
          (obj as Record<string, unknown>).success === true &&
          typeof (obj as Record<string, unknown>).resumedAgentId === "string" &&
          ((obj as Record<string, unknown>).resumedAgentId as string).length > 0
        ) {
          return { resumedAgentId: (obj as Record<string, unknown>).resumedAgentId as string };
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  return undefined;
}

const TASK_NOTIFICATION_OPEN = "<task-notification>";
const TASK_NOTIFICATION_PREAMBLE_MARKER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

export function parseTaskNotification(
  text: string,
  opts?: { trustedOrigin?: boolean }
): TaskNotificationInfo | undefined {
  let t = text.trimStart();
  if (opts?.trustedOrigin === true && t.startsWith(TASK_NOTIFICATION_PREAMBLE_MARKER)) {
    const open = t.indexOf(TASK_NOTIFICATION_OPEN);
    if (open >= 0) t = t.slice(open);
  }
  if (!t.startsWith(TASK_NOTIFICATION_OPEN)) return undefined;
  const agentId = /<task-id>([^<]+)<\/task-id>/.exec(t)?.[1]?.trim();
  if (!agentId) return undefined;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(t)?.[1]?.trim();
  const status = /<status>([^<]+)<\/status>/.exec(t)?.[1]?.trim();
  const resultEnd = t.lastIndexOf("</result>");
  const resultStart = t.indexOf("<result>");
  const result = resultStart >= 0 && resultEnd >= resultStart ? t.slice(resultStart + "<result>".length, resultEnd) : undefined;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(resultStart >= 0 ? t.slice(0, resultStart) : t)?.[1];
  const outside = resultEnd >= 0 ? t.slice(resultEnd + "</result>".length) : t.includes("<result>") ? "" : t;
  const tokensText = /<usage>[^]*?<subagent_tokens>(\d+)<\/subagent_tokens>/.exec(outside)?.[1];
  const tokens = tokensText === undefined ? undefined : Number(tokensText);
  return {
    agentId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(status ? { status } : {}),
    ...(tokens !== undefined && Number.isSafeInteger(tokens) ? { tokens } : {}),
    ...taskNotificationDisplayFields(summary, result),
  };
}
