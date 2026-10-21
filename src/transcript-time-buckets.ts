import { displayedAncestorUsageGap, type NormalizedEvent, type TimeBucketsCoverage } from "./protocol";
import type { RosterSource } from "./roster-evidence";
import { readSessionHistory, readSubagentAgents, type HistoryEvent, type SessionHistoryRead, type SubagentRestore } from "./session-transcript";
import {
  attachTimeBucketRequestNumbers,
  createTimeBucketState,
  currentGenerationRecords,
  deriveTimeBuckets,
  foldTimeBuckets,
  pushModelMark,
  projectWorkBlockTokens,
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
  agents: ReadonlyArray<{ toolUseId: string; startedAt?: number; endedAt?: number }>
): ChildTranscriptSpan[] {
  return agents.map((a) => ({
    toolUseId: a.toolUseId,
    ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
    ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
  }));
}

export function timeBucketsFromHistory(
  events: readonly HistoryEvent[],
  childSpans: readonly ChildTranscriptSpan[],
  ids: TranscriptIds
): TimeBucketView {
  let state = createTimeBucketState();
  let requests = createWorkModelState();
  let modelMarks: ModelMark[] = [];
  let currentModel: string | undefined;
  let markedInTurn = false;
  let usage: PlanUsageAccumulator | undefined;
  let seq = 0;
  for (const e of currentGenerationRecords(events)) {
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
      (body.kind === "assistant_text_delta" || (body.kind === "tool_call_started" && body.parentToolUseId === null))
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
    if (ev.kind === "assistant_usage" && ev.parentToolUseId === null) usage = foldPlanUsage(usage, ev.messageId, e.timestamp, ev.usage);
    if (ev.kind === "turn_started" || ev.kind === "user_message") {
      requests = reduceWorkModel(requests, ev);
      state = attachTimeBucketRequestNumbers(state, requests.requests ?? []);
    }
  }
  const view = deriveTimeBuckets(state, { childSpans, modelMarks });
  return projectWorkBlockTokens(view, projectPlanUsage(usage, view.blocks));
}

export interface TranscriptTimeBucketsRead {
  rosterSources?: RosterSource[];
  view: TimeBucketView | undefined;
  coverage: TimeBucketsCoverage | undefined;
}

export function subagentReadCoverage(restored: {
  readError?: string;
  transcriptReadFailureCount: number;
  omittedTranscriptCount: number;
  malformedMetaCount: number;
}): TimeBucketsCoverage | undefined {
  const coverage: TimeBucketsCoverage = {
    ...(restored.readError !== undefined ? { subagentReadError: restored.readError } : {}),
    ...(restored.transcriptReadFailureCount > 0 ? { transcriptReadFailureCount: restored.transcriptReadFailureCount } : {}),
    ...(restored.omittedTranscriptCount > 0 ? { omittedTranscriptCount: restored.omittedTranscriptCount } : {}),
    ...(restored.malformedMetaCount > 0 ? { malformedMetaCount: restored.malformedMetaCount } : {}),
  };
  return Object.keys(coverage).length > 0 ? coverage : undefined;
}

export async function readTranscriptTimeBucketsWithCoverage(
  file: string,
  isAllowedPath: (p: string) => boolean,
  ids: TranscriptIds,
  generationSessionId?: string
): Promise<TranscriptTimeBucketsRead> {
  const history = await readSessionHistory(file, isAllowedPath, generationSessionId === undefined ? undefined : { generationSessionId });
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
  const subagentCoverage = subagentReadCoverage(restored);
  return {
    view: timeBucketsFromHistory(history.events, childSpansOf(restored.agents), ids),
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
