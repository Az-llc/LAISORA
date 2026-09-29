// 状況タブの時間 4 区分をセッション自身の JSONL から導出する（U-1 案 b）。
// live のターン境界（user_message / turn_started）は継承時刻で fold 由来の値が inherited になるため、
// history と同じ readSessionHistory を通して読み直す。開き方（新規 / resume）で値が変わらない（R-TAB-07）
import type { NormalizedEvent, TimeBucketsCoverage } from "./protocol";
import { readSessionHistory, readSubagentAgents, type HistoryEvent } from "./session-transcript";
import {
  attachTimeBucketRequestNumbers,
  createTimeBucketState,
  deriveTimeBuckets,
  foldTimeBuckets,
  pushModelMark,
  type ChildTranscriptSpan,
  type ModelMark,
  type TimeBucketView,
} from "./time-buckets";

import { createWorkModelState, reduceWorkModel } from "./work-model";

export interface TranscriptIds {
  conversationId: string;
  generation: number;
}

// R-DSP-49: childSpansOf; src/time-buckets.ts#deriveTimeBuckets
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
  let seq = 0;
  for (const e of events) {
    const body = e.body;
    if (body.kind === "turn_started") markedInTurn = false;
    // model の観測は foldTimeBuckets（evidence-index 経由で semantic の導出に入る）へ渡さず、読み直しの側だけで拾う。
    // model_observed は変化した記録にしか出ないので、応答ごとの model は「直前の変化の model」で、
    // 応答記録ごとの観測はメインの本文・ツール呼び出しのイベントの時刻で取る。変化点だけで割ると、
    // 同じターンで A の応答の後に B へ変わったとき A の生成まで B に数える
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
    state = foldTimeBuckets(state, ev);
    if (ev.kind === "turn_started" || ev.kind === "user_message") {
      requests = reduceWorkModel(requests, ev);
      state = attachTimeBucketRequestNumbers(state, requests.requests ?? []);
    }
  }
  return deriveTimeBuckets(state, { childSpans, modelMarks });
}

export interface TranscriptTimeBucketsRead {
  view: TimeBucketView | undefined;
  // undefined = 欠落なし。読めなかった subagents/ を 0 本として view へ畳まない（R-DSP-11）
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
  ids: TranscriptIds
): Promise<TranscriptTimeBucketsRead> {
  const history = await readSessionHistory(file, isAllowedPath);
  // 読めなかった transcript から 0 件の 4 区分を作らない。fold 由来の値（inherited）に留める（R-DSP-11）
  // subagents/ の一覧が読めない場合も view を作らない（子を 0 本として描くと直列に見える。TB-41）
  const sessionReadError = history.readError ?? history.subagentsReadError;
  if (sessionReadError !== undefined) return { view: undefined, coverage: { sessionReadError } };
  const restored = await readSubagentAgents(file, isAllowedPath);
  return {
    view: timeBucketsFromHistory(history.events, childSpansOf(restored.agents), ids),
    coverage: subagentReadCoverage(restored),
  };
}

export async function readTranscriptTimeBuckets(
  file: string,
  isAllowedPath: (p: string) => boolean,
  ids: TranscriptIds
): Promise<TimeBucketView | undefined> {
  return (await readTranscriptTimeBucketsWithCoverage(file, isAllowedPath, ids)).view;
}
