// 状況タブの時間 4 区分をセッション自身の JSONL から導出する（U-1 案 b）。
// live のターン境界（user_message / turn_started）は継承時刻で fold 由来の値が inherited になるため、
// history と同じ readSessionHistory を通して読み直す。開き方（新規 / resume）で値が変わらない（R-TAB-07）
import type { NormalizedEvent, TimeBucketsCoverage } from "./protocol";
import { readSessionHistory, readSubagentAgents, type HistoryEvent } from "./session-transcript";
import {
  createTimeBucketState,
  deriveTimeBuckets,
  foldTimeBuckets,
  type ChildTranscriptSpan,
  type TimeBucketView,
} from "./time-buckets";

export interface TranscriptIds {
  conversationId: string;
  generation: number;
}

// サブエージェント棒の端点は子 transcript の最初 / 最後のレコード時刻。起動 ACK や子ツール終端から作らない（R-DSP-17）
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
  let seq = 0;
  for (const e of events) {
    const ev = {
      ...e.body,
      timestamp: e.timestamp,
      seq: ++seq,
      backendId: "claude",
      conversationId: ids.conversationId,
      generation: ids.generation,
    } as NormalizedEvent;
    state = foldTimeBuckets(state, ev);
  }
  return deriveTimeBuckets(state, { childSpans });
}

export interface TranscriptTimeBucketsRead {
  view: TimeBucketView | undefined;
  // undefined = 欠落なし。読めなかった subagents/ を 0 本として view へ畳まない（R-23）
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
  // subagents/ の一覧が読めない場合も view を作らない（子を 0 本として描くと直列に見える。R-23 / TB-41）
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
