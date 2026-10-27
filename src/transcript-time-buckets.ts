import { displayedAncestorUsageGap, subagentDetailUnreadCount, type NormalizedEvent, type RestoredAgent, type TimeBucketsCoverage } from "./protocol";
import { isChildCall } from "./spans";
import type { RosterSource } from "./roster-evidence";
import { readSessionHistory, readSubagentAgents, subagentReadGaps, type HistoryEvent, type SessionHistoryRead, type SubagentRestore, type UsageScanOwner } from "./session-transcript";
import {
  attachTimeBucketRequestNumbers,
  createTimeBucketState,
  currentGenerationRecords,
  deriveTimeBuckets,
  foldTimeBuckets,
  pushModelMark,
  projectWorkBlockTokens,
  seedUnknownLaunchers,
  unknownLaunchers,
  type ChildTranscriptSpan,
  type ModelMark,
  type TimeBucketView,
} from "./time-buckets";

import { foldPlanUsage, projectPlanUsage, type PlanUsageAccumulator } from "./plan-usage";

import { createWorkModelState, reduceWorkModel } from "./work-model";

export interface TranscriptIds {
  conversationId: string;
  generation: number;
}

export function childSpansOf(
  agents: ReadonlyArray<{ toolUseId: string; startedAt?: number; endedAt?: number }>,
  readAt: number
): ChildTranscriptSpan[] {
  return agents.map((a) => ({
    toolUseId: a.toolUseId,
    ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
    ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
    readAt,
  }));
}

export function withRecordedRuns(childSpans: readonly ChildTranscriptSpan[], view: TimeBucketView): ChildTranscriptSpan[] {
  const rows = new Map([...view.agents, ...view.nestedAgents ?? []].map((agent) => [agent.toolUseId, agent]));
  return childSpans.map((span) => {
    const row = rows.get(span.toolUseId);
    return row?.earlierRuns === undefined ? span : { ...span, runs: { earlierRuns: row.earlierRuns, ...(row.resumedAt === undefined ? {} : { resumedAt: row.resumedAt }) } };
  });
}

export function timeBucketsFromHistory(
  events: readonly HistoryEvent[],
  childSpans: readonly ChildTranscriptSpan[],
  ids: TranscriptIds,
  restoredAgents: readonly RestoredAgent[] = []
): TimeBucketView {
  const records = currentGenerationRecords(events);
  let state = seedUnknownLaunchers(createTimeBucketState(), unknownLaunchers(restoredAgents, records));
  let requests = createWorkModelState();
  let modelMarks: ModelMark[] = [];
  let currentModel: string | undefined;
  let markedInTurn = false;
  let usage: PlanUsageAccumulator | undefined;
  let seq = 0;
  for (const e of records) {
    const body = e.body;
    if (body.kind === "turn_started") markedInTurn = false;
    if (body.kind === "model_observed") {
      if (e.timestamp > 0) {
        currentModel = body.model;
        modelMarks = pushModelMark(modelMarks, e.timestamp, body.model, markedInTurn);
        markedInTurn = true;
      }
      continue;
    }
    if (
      currentModel !== undefined &&
      e.timestamp > 0 &&
      (body.kind === "assistant_text_delta" || (body.kind === "tool_call_started" && !isChildCall(body.parentToolUseId)))
    ) {
      modelMarks = pushModelMark(modelMarks, e.timestamp, currentModel, markedInTurn);
      markedInTurn = true;
    }
    const ev = {
      ...e.body,
      timestamp: e.timestamp,
      seq: ++seq,
      backendId: "claude",
      conversationId: ids.conversationId,
      generation: ids.generation,
    } as NormalizedEvent;
    state = foldTimeBuckets(state, ev, { childSpans, modelMarks });
    if (ev.kind === "assistant_usage" && !isChildCall(ev.parentToolUseId)) usage = foldPlanUsage(usage, ev.messageId, e.timestamp, ev.usage);
    if (ev.kind === "turn_started" || ev.kind === "user_message") {
      requests = reduceWorkModel(requests, ev);
      state = attachTimeBucketRequestNumbers(state, requests.requests ?? []);
    }
  }
  const view = deriveTimeBuckets(state, { childSpans, modelMarks, streamOpen: false });
  return projectWorkBlockTokens(view, projectPlanUsage(usage, view.blocks));
}

export interface TranscriptTimeBucketsRead {
  rosterSources?: RosterSource[];
  childSpans?: ChildTranscriptSpan[];
  view: TimeBucketView | undefined;
  coverage: TimeBucketsCoverage | undefined;
}

export function subagentReadCoverage(history: Pick<SessionHistoryRead, "unreadSubagentIds" | "usageOnlySubagentIds" | "usagePendingSubagentIds" | "usageReadSubagentIds">,
  restored: Pick<SubagentRestore, "readError" | "unreadAgentIds">): TimeBucketsCoverage {
  return { ...(restored.readError !== undefined ? { subagentReadError: restored.readError } : {}),
    unreadSubagentCount: subagentDetailUnreadCount(subagentReadGaps(history, restored)) };
}

export async function readTranscriptTimeBucketsWithCoverage(
  file: string,
  isAllowedPath: (p: string) => boolean,
  ids: TranscriptIds,
  generationSessionId?: string,
  usageScanOwner?: UsageScanOwner
): Promise<TranscriptTimeBucketsRead> {
  const history = await readSessionHistory(file, isAllowedPath, { ...(generationSessionId === undefined ? {} : { generationSessionId }),
    ...(usageScanOwner === undefined ? {} : { usageScanOwner }), largeChildUsage: "read" });
  const sessionReadError = history.readError ?? history.subagentsReadError;
  if (sessionReadError !== undefined) return { view: undefined, coverage: { sessionReadError }, rosterSources: history.rosterSources };
  return transcriptTimeBucketsOf(history, await readSubagentAgents(file, isAllowedPath), ids);
}

export function transcriptTimeBucketsOf(
  history: SessionHistoryRead,
  restored: SubagentRestore,
  ids: TranscriptIds
): TranscriptTimeBucketsRead {
  const ancestorUsageReadError = displayedAncestorUsageGap(history.coverage);
  const subagentCoverage = subagentReadCoverage(history, restored);
  const childSpans = childSpansOf(restored.agents, restored.readAt);
  const view = timeBucketsFromHistory(history.events, childSpans, ids, restored.agents);
  return {
    view,
    childSpans: withRecordedRuns(childSpans, view),
    rosterSources: history.rosterSources,
    coverage: ancestorUsageReadError === undefined ? subagentCoverage : { ...subagentCoverage, ancestorUsageReadError },
  };
}

export async function readTranscriptTimeBuckets(
  file: string,
  isAllowedPath: (p: string) => boolean,
  ids: TranscriptIds,
  generationSessionId?: string
): Promise<TimeBucketView | undefined> {
  return (await readTranscriptTimeBucketsWithCoverage(file, isAllowedPath, ids, generationSessionId)).view;
}
