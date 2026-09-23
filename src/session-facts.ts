import type { PersonalBaseline } from "./analysis";
import { foldPlanUsage, type PlanUsageAccumulator } from "./plan-usage";
import type { AssistantUsage } from "./protocol";
import type { SemanticEvidenceIndex } from "./evidence-index";
import { HUMAN_REJECTED_TOOL_RESULT_RE } from "./guardrail";
import type { NormalizedEvent } from "./protocol";

export interface SessionFactsAccumulator {
  planUsage?: PlanUsageAccumulator;
  firstAt: number | null;
  lastAt: number | null;
  toolCalls: number;
  toolFails: number;
  toolsByName: Record<string, { calls: number; fails: number }>;
  openToolNames: Record<string, string>;
  outputTokens: number | null;
  hasOutputTokens: boolean;
}

export function initialSessionFacts(): SessionFactsAccumulator {
  return {
    firstAt: null,
    lastAt: null,
    toolCalls: 0,
    toolFails: 0,
    toolsByName: {},
    openToolNames: {},
    outputTokens: null,
    hasOutputTokens: false,
  };
}

// windowMs の端点にする kind（tool・user・turn イベントのみ。
// assistant_usage / conversation_* / guardrail-only kind は含めない）
function isWindowKind(kind: string): boolean {
  return kind.startsWith("tool_call_") || kind === "user_message" || kind.startsWith("turn_");
}

export function foldSessionFacts(
  acc: SessionFactsAccumulator,
  event: NormalizedEvent | { kind: string; timestamp?: number; [key: string]: unknown }
): SessionFactsAccumulator {
  const ts =
    isWindowKind(event.kind) && typeof event.timestamp === "number" && event.timestamp > 0
      ? event.timestamp
      : null;
  let firstAt = acc.firstAt;
  let lastAt = acc.lastAt;

  if (ts !== null) {
    if (firstAt === null || ts < firstAt) firstAt = ts;
    if (lastAt === null || ts > lastAt) lastAt = ts;
  }

  let toolCalls = acc.toolCalls;
  let toolFails = acc.toolFails;
  let toolsByName = acc.toolsByName;
  let openToolNames = acc.openToolNames;
  let outputTokens = acc.outputTokens;
  let hasOutputTokens = acc.hasOutputTokens;

  if (event.kind === "tool_call_started") {
    toolCalls++;
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    const toolUseId = typeof event.toolUseId === "string" ? event.toolUseId : "";
    if (toolUseId !== "") {
      openToolNames = { ...openToolNames, [toolUseId]: toolName };
    }
    const current = toolsByName[toolName] ?? { calls: 0, fails: 0 };
    toolsByName = {
      ...toolsByName,
      [toolName]: { calls: current.calls + 1, fails: current.fails },
    };
  } else if (event.kind === "tool_call_finished") {
    const toolUseId = typeof event.toolUseId === "string" ? event.toolUseId : "";
    const toolName = openToolNames[toolUseId] ?? "unknown";
    if (toolUseId !== "") {
      const { [toolUseId]: _, ...restOpen } = openToolNames;
      openToolNames = restOpen;
    }
    const isError = event.isError === true;
    const resultPreview = typeof event.resultPreview === "string" ? event.resultPreview : "";
    const isHumanRejected = HUMAN_REJECTED_TOOL_RESULT_RE.test(resultPreview);
    if (isError && !isHumanRejected) {
      toolFails++;
      const current = toolsByName[toolName] ?? { calls: 0, fails: 0 };
      toolsByName = {
        ...toolsByName,
        [toolName]: { calls: current.calls, fails: current.fails + 1 },
      };
    }
  } else if (event.kind === "assistant_usage") {
    const parentToolUseId = event.parentToolUseId ?? null;
    const usage = event.usage as { outputTokens?: number } | undefined;
    if (parentToolUseId === null && typeof usage?.outputTokens === "number") {
      hasOutputTokens = true;
      outputTokens = (outputTokens ?? 0) + usage.outputTokens;
    }
  }

  return {
    firstAt,
    lastAt,
    toolCalls,
    toolFails,
    toolsByName,
    openToolNames,
    outputTokens,
    hasOutputTokens,
    planUsage: event.kind === "assistant_usage" && typeof event.messageId === "string" && typeof event.timestamp === "number"
      ? foldPlanUsage(acc.planUsage, event.messageId, event.timestamp, (event.usage ?? {}) as AssistantUsage)
      : acc.planUsage,
  };
}

export interface SessionFacts {
  windowMs: number | null;
  activeMs: number | null;
  waitMs: number;
  waitCount: number;
  outputTokens: number | null;
  baselineMultiple: number | null;
  toolCalls: number;
  toolFails: number;
  failsByTool: { tool: string; fails: number; calls: number }[];
  coverage: {
    eventLogTrimmed: boolean;
    longGapsDropped: number;
  };
}

export function deriveSessionFacts(
  acc: SessionFactsAccumulator,
  evidence: SemanticEvidenceIndex,
  baseline: PersonalBaseline | null,
  options?: { eventLogTrimmed?: boolean }
): SessionFacts {
  const windowMs =
    acc.firstAt === null || acc.lastAt === null ? null : Math.max(0, acc.lastAt - acc.firstAt);

  let waitMs = 0;
  for (const g of evidence.longGaps) waitMs += g.durationMs;
  waitMs += evidence.droppedLongGapMs;
  const waitCount = evidence.longGaps.length + evidence.coverage.longGaps;
  const activeMs = windowMs === null ? null : Math.max(0, windowMs - waitMs);

  let baselineMultiple: number | null = null;
  const baselineTokens = baseline?.metrics?.outputTokens;
  if (acc.outputTokens !== null && typeof baselineTokens === "number" && baselineTokens > 0) {
    baselineMultiple = acc.outputTokens / baselineTokens;
  }

  const failsByTool: { tool: string; fails: number; calls: number }[] = [];
  for (const [tool, counts] of Object.entries(acc.toolsByName)) {
    if (counts.fails > 0) {
      failsByTool.push({ tool, fails: counts.fails, calls: counts.calls });
    }
  }
  failsByTool.sort((a, b) => b.fails - a.fails || b.calls - a.calls || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));

  return {
    windowMs,
    activeMs,
    waitMs,
    waitCount,
    outputTokens: acc.outputTokens,
    baselineMultiple,
    toolCalls: acc.toolCalls,
    toolFails: acc.toolFails,
    failsByTool,
    coverage: {
      eventLogTrimmed: options?.eventLogTrimmed ?? false,
      longGapsDropped: evidence.coverage.longGaps,
    },
  };
}
