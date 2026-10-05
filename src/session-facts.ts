import { foldPlanUsage, type PlanUsageAccumulator } from "./plan-usage";
import type { AssistantUsage } from "./protocol";
import type { SemanticEvidenceIndex } from "./evidence-index";
import type { NormalizedEvent } from "./protocol";

export interface SessionFactsAccumulator {
  planUsage?: PlanUsageAccumulator;
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
  return {
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
