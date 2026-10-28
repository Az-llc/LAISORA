import { foldPlanUsage, type PlanUsageAccumulator } from "./plan-usage";
import { isChildCall } from "./spans";
import type { AssistantUsage } from "./protocol";
import type { SemanticEvidenceIndex } from "./evidence-index";
import { isLlmAnalysisExecution, type NormalizedEvent } from "./protocol";
import { createExecLogMarkState, foldExecLogMarks, type ExecLogMark } from "./exec-log-marks";
import { emptyKeyedLog, keyedGet, keyedSet, keyedValues, launchItemNumber, type KeyedLog } from "./time-buckets";
import { isExternalRunTool, type ExternalRunOutcome } from "./orchestration-executors";
import { isFailedToolResult, isInterruptedWhileRunning, isRejectedBeforeRun, taskNotificationOutcome, taskNotificationTerminal } from "./tool-result-signals";
import { bookkeepingIntent, MAX_EVICTED_LAUNCHES } from "./work-model";

export interface AnalysisToolRecord {
  itemNumber?: number;
  startedAt?: number;
  finishedAt?: number;
  failed: boolean;
  marks: ExecLogMark[];
  bookkeeping?: true;
}

export interface ExternalRunCall {
  toolUseId: string;
  target?: string;
  startedAt: number;
  endedAt?: number;
  outcome?: ExternalRunOutcome;
  backgroundTaskId?: string;
  rejectedBeforeRun?: true;
}

export interface SessionFactsAccumulator {
  planUsage?: PlanUsageAccumulator;
  subagentUsage?: ReadonlyMap<string, PlanUsageAccumulator>;
  analysisTools?: KeyedLog<AnalysisToolRecord>;
  taskLaunches?: ReadonlyMap<string, string>;
  externalRunCalls?: KeyedLog<ExternalRunCall>;
  toolCalls: number;
}

function notifiedOutcome(status: string | undefined): ExternalRunOutcome | undefined {
  const outcome = taskNotificationOutcome(status);
  return outcome === "completed" ? "ok" : outcome;
}

function foldExternalRunCalls(log: KeyedLog<ExternalRunCall> | undefined, event: NormalizedEvent | { kind: string; [key: string]: unknown }): KeyedLog<ExternalRunCall> | undefined {
  if (typeof event.timestamp !== "number") return log;
  if (event.kind === "tool_call_started" && typeof event.toolName === "string" && isExternalRunTool(event.toolName) && typeof event.toolUseId === "string") {
    const started = event as Extract<NormalizedEvent, { kind: "tool_call_started" }>;
    const target = started.intentInput?.target;
    return keyedSet(log ?? emptyKeyedLog<ExternalRunCall>(), started.toolUseId, { toolUseId: started.toolUseId, startedAt: event.timestamp, ...(target ? { target } : {}) });
  }
  if (event.kind !== "tool_call_finished" || log === undefined) return log;
  const finished = event as Extract<NormalizedEvent, { kind: "tool_call_finished" }>;
  const call = keyedGet(log, finished.toolUseId);
  if (call !== undefined) {
    if (isRejectedBeforeRun(finished)) return keyedSet(log, call.toolUseId, { ...call, endedAt: event.timestamp, rejectedBeforeRun: true });
    if (finished.backgroundTaskId !== undefined && finished.isError !== true) return keyedSet(log, call.toolUseId, { ...call, backgroundTaskId: finished.backgroundTaskId });
    return keyedSet(log, call.toolUseId, { ...call, endedAt: event.timestamp, outcome: isInterruptedWhileRunning(finished) ? "stopped" : finished.isError ? "failed" : "ok" });
  }
  const notified = finished.taskNotification;
  const background = notified === undefined ? undefined : keyedValues(log).find(value => value.backgroundTaskId === notified.agentId && value.outcome === undefined);
  const outcome = notifiedOutcome(notified?.status);
  return background === undefined || outcome === undefined ? log : keyedSet(log, background.toolUseId, { ...background, endedAt: event.timestamp, outcome });
}

export function initialSessionFacts(): SessionFactsAccumulator {
  return {
    toolCalls: 0,
  };
}

export function foldSessionFacts(
  acc: SessionFactsAccumulator,
  event: NormalizedEvent | { kind: string; timestamp?: number; [key: string]: unknown }
): SessionFactsAccumulator {
  let subagentUsage = acc.subagentUsage;
  if (event.kind === "assistant_usage" && typeof event.parentToolUseId === "string" && typeof event.messageId === "string" && typeof event.timestamp === "number") {
    subagentUsage = new Map(subagentUsage).set(event.parentToolUseId,
      foldPlanUsage(subagentUsage?.get(event.parentToolUseId), event.messageId, event.timestamp, (event.usage ?? {}) as AssistantUsage));
  }
  let analysisTools = acc.analysisTools;
  let taskLaunches = acc.taskLaunches;
  const finished = event.kind === "tool_call_finished" ? event as Extract<NormalizedEvent, { kind: "tool_call_finished" }> : undefined;
  const notification = finished?.taskNotification;
  if (notification !== undefined) {
    const launch = notification.toolUseId ?? taskLaunches?.get(notification.agentId);
    const record = launch === undefined || analysisTools === undefined ? undefined : keyedGet(analysisTools, launch);
    if (record !== undefined && taskNotificationTerminal(notification.status) === "failed") {
      analysisTools = keyedSet(analysisTools!, launch!, { ...record, failed: true });
    }
  } else if (finished !== undefined && finished.isError !== true) {
    const taskId = finished.asyncLaunchedAgentId ?? finished.backgroundTaskId;
    if (taskId !== undefined) {
      const launches = new Map(taskLaunches).set(taskId, finished.toolUseId);
      for (const oldest of launches.keys()) {
        if (launches.size <= MAX_EVICTED_LAUNCHES) break;
        launches.delete(oldest);
      }
      taskLaunches = launches;
    }
  }
  if (notification === undefined && (event.kind === "tool_call_started" || event.kind === "tool_call_finished") && typeof event.toolUseId === "string" && typeof event.timestamp === "number") {
    const log = analysisTools ?? emptyKeyedLog<AnalysisToolRecord>();
    const previous = keyedGet(log, event.toolUseId);
    const started = event.kind === "tool_call_started" && typeof event.toolName === "string"
      ? event as Extract<NormalizedEvent, { kind: "tool_call_started" }> : undefined;
    const itemNumber = started !== undefined && !isChildCall(started.parentToolUseId) ? launchItemNumber(started) : undefined;
    analysisTools = keyedSet(log, event.toolUseId, {
      ...previous,
      ...(itemNumber === undefined ? {} : { itemNumber }),
      ...(started !== undefined && bookkeepingIntent(started) !== undefined ? { bookkeeping: true as const } : {}),
      ...(event.kind === "tool_call_started" ? { startedAt: event.timestamp } : { finishedAt: event.timestamp }),
      failed: finished !== undefined ? isFailedToolResult(finished) : previous?.failed ?? false,
      marks: event.kind === "tool_call_finished" ? foldExecLogMarks(createExecLogMarkState(), event as NormalizedEvent).marks : previous?.marks ?? [],
    });
  }
  return {
    subagentUsage,
    analysisTools,
    taskLaunches,
    externalRunCalls: foldExternalRunCalls(acc.externalRunCalls, event),
    toolCalls: acc.toolCalls + (isLlmAnalysisExecution(event) ? 1 : 0),
    planUsage: event.kind === "assistant_usage" && !isChildCall(event.parentToolUseId as string | null | undefined) && typeof event.messageId === "string" && typeof event.timestamp === "number"
      ? foldPlanUsage(acc.planUsage, event.messageId, event.timestamp, (event.usage ?? {}) as AssistantUsage)
      : acc.planUsage,
  };
}

export interface SessionFacts {
  toolCalls: number;
  coverage: {
    eventLogTrimmed: boolean;
    longGapsDropped: number;
  };
}

export function deriveSessionFacts(
  acc: SessionFactsAccumulator,
  evidence: SemanticEvidenceIndex,
  options?: { eventLogTrimmed?: boolean }
): SessionFacts {
  return {
    toolCalls: acc.toolCalls,
    coverage: {
      eventLogTrimmed: options?.eventLogTrimmed ?? false,
      longGapsDropped: evidence.coverage.longGaps,
    },
  };
}
