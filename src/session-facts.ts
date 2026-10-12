import { foldPlanUsage, type PlanUsageAccumulator } from "./plan-usage";
import type { AssistantUsage } from "./protocol";
import type { SemanticEvidenceIndex } from "./evidence-index";
import type { NormalizedEvent } from "./protocol";
import { createExecLogMarkState, foldExecLogMarks, type ExecLogMark } from "./exec-log-marks";
import { emptyKeyedLog, keyedGet, keyedSet, launchItemNumber, type KeyedLog } from "./time-buckets";

export interface AnalysisToolRecord {
  itemNumber?: number;
  startedAt?: number;
  finishedAt?: number;
  failed: boolean;
  marks: ExecLogMark[];
}

export interface SessionFactsAccumulator {
  planUsage?: PlanUsageAccumulator;
  subagentUsage?: ReadonlyMap<string, PlanUsageAccumulator>;
  analysisTools?: KeyedLog<AnalysisToolRecord>;
  toolCalls: number;
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
  if ((event.kind === "tool_call_started" || event.kind === "tool_call_finished") && typeof event.toolUseId === "string" && typeof event.timestamp === "number") {
    const log = analysisTools ?? emptyKeyedLog<AnalysisToolRecord>();
    const previous = keyedGet(log, event.toolUseId);
    const itemNumber = event.kind === "tool_call_started" && typeof event.toolName === "string" && (event.parentToolUseId ?? null) === null
      ? launchItemNumber(event as Extract<NormalizedEvent, { kind: "tool_call_started" }>) : undefined;
    analysisTools = keyedSet(log, event.toolUseId, {
      ...previous,
      ...(itemNumber === undefined ? {} : { itemNumber }),
      ...(event.kind === "tool_call_started" ? { startedAt: event.timestamp } : { finishedAt: event.timestamp }),
      failed: event.kind === "tool_call_finished" ? event.isError === true : previous?.failed ?? false,
      marks: event.kind === "tool_call_finished" ? foldExecLogMarks(createExecLogMarkState(), event as NormalizedEvent).marks : previous?.marks ?? [],
    });
  }
  return {
    subagentUsage,
    analysisTools,
    toolCalls: acc.toolCalls + (event.kind === "tool_call_started" ? 1 : 0),
    planUsage: event.kind === "assistant_usage" && (event.parentToolUseId ?? null) === null && typeof event.messageId === "string" && typeof event.timestamp === "number"
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
