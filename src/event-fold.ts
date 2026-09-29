import { foldModelFallback } from "./protocol";
import type { ModelFallbackState, ModelInfo } from "./protocol";
import type { ClaudeConversation } from "./claudeHost";
import type { HostArtifactAccess } from "./artifact-access";
import { applyActivityEvent, type BackgroundActivityState } from "./background-activity";
import { attachTimeBucketRequestNumbers } from "./time-buckets";
import { foldEvidence, type SemanticEvidenceIndex } from "./evidence-index";
import { windowEvents } from "./event-window";
import { foldGuardrail, touchedSignalIds, type GuardrailState } from "./guardrail";
import {
  AuthStatus,
  EventProvenance,
  NormalizedEvent,
  NormalizedEventBody,
  SlashCommandInfo,
  isGuardrailOnlyEventKind,
  isInternalSlashCommand,
  projectWorkEvent,
  requiresTimestamp,
} from "./protocol";
import { foldSessionFacts, type SessionFactsAccumulator } from "./session-facts";
import { markEventLogTrimmed, reduceWorkModel, type WorkModelState } from "./work-model";

const EVENT_LOG_MAX = 5000; // bounded event log（件数上限。バイト上限は追跡課題）

export function trimEventLog(events: NormalizedEvent[], max = EVENT_LOG_MAX): NormalizedEvent[] {
  return windowEvents(events, max).events;
}

export function reduceWorkModelSafely(
  previousState: WorkModelState,
  event: NormalizedEvent,
  reduce: typeof reduceWorkModel = reduceWorkModel
): { state: WorkModelState; error?: unknown } {
  try { return { state: reduce(previousState, event) }; }
  catch (error) {
    // 落としたイベントの寄与は後から復元できない。coverage を complete のまま返すと、
    // 欠落した集計を完全な集計として表示することになる。
    return {
      state: {
        ...previousState,
        coverage: {
          ...previousState.coverage,
          summary: "prefix-truncated",
          details: "prefix-truncated",
          reducerErrorCount: (previousState.coverage.reducerErrorCount ?? 0) + 1,
        },
      },
      error,
    };
  }
}

export type FoldEffect =
  | { type: "log"; message: string }
  | { type: "schedule_guardrail_refresh" }
  | { type: "schedule_guardrail_tick" }
  | { type: "post_commands"; tabId: string; commands: SlashCommandInfo[] }
  | { type: "resolve_owner"; sessionId: string; logicalGeneration: number }
  | { type: "refresh_tab_title" }
  | { type: "schedule_transcript_time_buckets" }
  | { type: "post_events"; tabId: string; events: NormalizedEvent[] }
  | { type: "schedule_work_model_post" }
  | { type: "schedule_semantic_model_post" };

export interface EventFoldDraft {
  tabId: string;
  title: string;
  generation: number;
  logicalGeneration: number;
  expectedConversationId: string | null;
  detachedConversationIds: ReadonlySet<string>;
  conversation?: ClaudeConversation | null;
  seq: number;
  lastEventTimestamp?: number;
  timestampContractViolations: number;
  carriedGapBoundaries: number[];
  sessionFacts: SessionFactsAccumulator;
  guardrail: GuardrailState;
  liveGuardrailSignalIds: Set<string>;
  guardrailLiveSince?: number;
  commands: SlashCommandInfo[];
  auth: AuthStatus | null;
  modelFallback?: ModelFallbackState;
  models?: ModelInfo[];
  appliedModel?: string;
  effectiveModel?: string | null;
  lastContextTotalTokens: number | null;
  liveDelegationAgentIds: Set<string>;
  liveDelegationRev: number;
  backgroundActivity: BackgroundActivityState;
  workModel: WorkModelState;
  evidenceIndex: SemanticEvidenceIndex;
  events: NormalizedEvent[];
  titleRefreshed: boolean;
  titleRefreshing: boolean;
  resuming: boolean;
  closed: boolean;
}

export interface FoldEventResult {
  draft: EventFoldDraft;
  normalizedEvent: NormalizedEvent | null;
  effects: FoldEffect[];
}

export type EventMeta = {
  timestamp?: number;
  hostArtifacts?: HostArtifactAccess[];
  suppressPost?: boolean;
  gapBoundaries?: readonly number[];
  // v4 F-1: 世代違いの棄却と timestamp gate は journal 到着時に一度だけ評価する。
  // journal replay はその verdict をそのまま使うのでこのフラグを立てて再判定を止める。
  // 再判定すると hydration 中の CLI 再起動（F-3 で継続扱い）や history fold で進んだ
  // lastEventTimestamp によって、到着時に受理した event が replay で消える
  arrivalJudged?: boolean;
};

// Pure event state fold (GR-37)
export function foldEventState(
  draft: EventFoldDraft,
  partial: NormalizedEventBody & { provenance?: EventProvenance },
  conversationId?: string,
  meta?: EventMeta
): FoldEventResult {
  const effects: FoldEffect[] = [];

  // FP-1: 切り離した Conversation のイベントは gapBoundaries も含めて
  // 引き取らない。expectedConversationId が null の窓（resetLogicalSession 後・warmup 前）は
  // 下の世代ガードでは塞がらない。境界の持ち越しより先に落とすのは、別会話の境界を
  // carriedGapBoundaries へ入れると新しい論理セッションの時間集計が動くため
  if (conversationId !== undefined && draft.detachedConversationIds.has(conversationId)) {
    effects.push({
      type: "log",
      message: `[${draft.title}] [drop] detached conversation event: ${partial.kind}`,
    });
    return { draft, normalizedEvent: null, effects };
  }
  // 境界はイベントより先に引き取る。以降の早期 return で捨てると
  // claude-normalizer 側の pendingGapBoundaries は既にクリア済みで再送されず、
  // その分だけ live に偽の longGap が出る（r2 M-2）。
  // 破棄側へ倒さない理由: 境界の取りこぼしは longGap の過大報告（禁じられている
  // 「委任待ちを待ち時間として数える」）になり、余分に持ち越した境界は過小報告にしかならない
  if (meta?.gapBoundaries !== undefined && meta.gapBoundaries.length > 0) {
    draft.carriedGapBoundaries.push(...meta.gapBoundaries);
  }
  // 旧 Conversation の遅延イベント（auth_status/permission_denied 等）が新世代へ混入しない
  // ようにする。expected 未設定（初期化前）の間は通す。
  // journal entry は到着時に判定済み（arrivalJudged）。draft の
  // expectedConversationId は Phase 2 開始時に凍結した値なので、hydration 中に CLI が
  // 再起動していると再判定は必ず片側を誤って落とす
  if (
    meta?.arrivalJudged !== true &&
    conversationId &&
    draft.expectedConversationId &&
    conversationId !== draft.expectedConversationId
  ) {
    effects.push({
      type: "log",
      message: `[${draft.title}] [drop] stale event from old conversation: ${partial.kind}`,
    });
    return { draft, normalizedEvent: null, effects };
  }
  draft.sessionFacts = foldSessionFacts(draft.sessionFacts, {
    ...partial,
    timestamp: meta?.timestamp ?? draft.lastEventTimestamp,
  });
  if (isGuardrailOnlyEventKind(partial.kind)) {
    const ev = {
      ...partial,
      backendId: "claude",
      conversationId: conversationId ?? draft.conversation?.conversationId ?? "pending",
      generation: draft.generation,
      seq: draft.seq,
      timestamp: meta?.timestamp ?? draft.lastEventTimestamp ?? 0,
    } as NormalizedEvent;
    try {
      const before = draft.guardrail;
      draft.guardrail = foldGuardrail(draft.guardrail, { type: "event", event: ev });
      if (ev.provenance?.path === "live") {
        for (const id of touchedSignalIds(before, draft.guardrail)) draft.liveGuardrailSignalIds.add(id);
      }
    } catch (error) {
      effects.push({
        type: "log",
        message: `[${draft.title}] Guardrail fold failed: ${String(error)}`,
      });
    }
    effects.push({ type: "schedule_guardrail_refresh" });
    if (!meta?.suppressPost) effects.push({ type: "schedule_work_model_post" });
    if (partial.provenance?.path === "live") effects.push({ type: "schedule_guardrail_tick" });
    return { draft, normalizedEvent: null, effects };
  }
  if (partial.kind === "commands_changed") {
    // SDK の commands_changed は REPLACE セマンティクスで「本当に0件になった」通知を含むため
    // 空配列でも握り潰さない。初回取得（supportedCommands）側だけが呼び出し前に length===0 を
    // 弾く非対称は意図的
    const visible = partial.commands.filter((command) => !isInternalSlashCommand(command));
    const hidden = partial.commands.filter((command) => isInternalSlashCommand(command));
    if (hidden.length > 0) {
      effects.push({
        type: "log",
        message: `[${draft.title}] internal slash commands filtered from suggest: ${hidden.map((command) => command.name).join(", ")}`,
      });
    }
    draft.commands = visible;
    effects.push({
      type: "post_commands",
      tabId: draft.tabId,
      commands: visible,
    });
    return { draft, normalizedEvent: null, effects };
  }
  // semantic 境界を決めるイベントに timestamp が無いのは供給側の契約違反。
  // 実時計で補完すると replay 決定性が壊れるため fail-closed で落とす。
  // 正規の供給経路は ClaudeLiveNormalizer の直近観測時刻の継承。
  // journal entry は到着時に h.arrivalTimestamp で判定済み（arrivalJudged）。
  // replay 時の draft.lastEventTimestamp は履歴 fold で進んでいるため再判定すると
  // 判定基準が変わり、到着時に受理した event が消えて仮 seq と本番 seq が割れる
  if (
    meta?.arrivalJudged !== true &&
    meta?.timestamp === undefined &&
    requiresTimestamp(partial.kind) &&
    draft.lastEventTimestamp !== undefined
  ) {
    draft.timestampContractViolations += 1;
    effects.push({
      type: "log",
      message: `[${draft.title}] [contract] ${partial.kind} に timestamp が無い（実時計で補完しない・破棄）`,
    });
    return { draft, normalizedEvent: null, effects };
  }
  // 境界を決めないイベント（auth_status / rate_limit / assistant_text_delta 等）は
  // 直近に観測した時刻を引き継ぐ。単調で再生可能であり実時計を混ぜない
  if (meta?.timestamp !== undefined) draft.lastEventTimestamp = meta.timestamp;
  draft.seq += 1;
  const ev = {
    ...partial,
    backendId: "claude",
    conversationId: conversationId ?? draft.conversation?.conversationId ?? "pending",
    generation: draft.generation,
    seq: draft.seq,
    timestamp: meta?.timestamp ?? draft.lastEventTimestamp ?? 0,
  } as NormalizedEvent;
  const previousFallback = draft.modelFallback;
  draft.modelFallback = foldModelFallback(previousFallback, ev, draft.models);
  if (draft.modelFallback && draft.modelFallback !== previousFallback && draft.modelFallback.resolvedAt === undefined) {
    draft.appliedModel = draft.modelFallback.appliedModel;
    draft.effectiveModel = draft.modelFallback.appliedModel;
  }
  if (ev.kind === "auth_status") {
    draft.auth = ev.auth;
    if (ev.auth?.sessionId) {
      effects.push({
        type: "resolve_owner",
        sessionId: ev.auth.sessionId,
        logicalGeneration: draft.logicalGeneration,
      });
    }
  }
  if (ev.kind === "context_usage") {
    draft.lastContextTotalTokens = ev.totalTokens;
  }
  // MED-1: live 経路の ACK（asyncLaunchedAgentId）と再開成功（resumedAgentId）だけを
  // 現プロセスの実行中委任として記録する。history 再生の同じイベントは対象外。
  // path === "live" 単独条件でよい根拠（r2 N9）: live の tool_call_finished は必ず
  // claude-normalizer の emit 境界（body.provenance ?? {path:"live"}）を通って provenance を
  // 持ち、history は session-transcript が常に {path:"history"} を付ける。provenance 無し＝
  // 正規化境界を通っていないイベントであり、snapshot 等の再生経路を将来追加しても
  // fail-closed（running へ漏れない）に倒れる。undefined を live 扱いに戻さないこと
  if (ev.kind === "tool_call_finished" && !ev.isError && ev.provenance?.path === "live") {
    for (const agentId of [ev.asyncLaunchedAgentId, ev.resumedAgentId, ev.backgroundTaskId]) {
      if (agentId !== undefined && !draft.liveDelegationAgentIds.has(agentId)) {
        draft.liveDelegationAgentIds.add(agentId);
        draft.liveDelegationRev += 1;
      }
    }
  }
  const previousWorkModel = draft.workModel;
  const reduced = reduceWorkModelSafely(draft.workModel, ev);
  draft.workModel = reduced.state;
  if (reduced.error !== undefined) {
    effects.push({
      type: "log",
      message: `[${draft.title}] WorkModel reducer failed: ${String(reduced.error)}`,
    });
  }
  try {
    const boundaries = draft.carriedGapBoundaries;
    draft.carriedGapBoundaries = [];
    draft.evidenceIndex = foldEvidence(
      draft.evidenceIndex,
      ev,
      meta?.hostArtifacts,
      boundaries.length > 0 ? boundaries : undefined
    );
    if (ev.kind === "turn_started" || ev.kind === "user_message") {
      const timeBuckets = attachTimeBucketRequestNumbers(draft.evidenceIndex.timeBuckets, draft.workModel.requests ?? []);
      if (timeBuckets !== draft.evidenceIndex.timeBuckets) draft.evidenceIndex = { ...draft.evidenceIndex, timeBuckets };
    }
  } catch (error) {
    // 落としたイベントの根拠は後から復元できない。数えずに進めると L3・LLM 入力・Inspector が
    // 欠けた索引の上で「全量」として走る（R-DSP-01。G-COV-8）
    draft.workModel = {
      ...draft.workModel,
      coverage: {
        ...draft.workModel.coverage,
        evidenceFoldErrorCount: (draft.workModel.coverage.evidenceFoldErrorCount ?? 0) + 1,
      },
    };
    effects.push({
      type: "log",
      message: `[${draft.title}] EvidenceIndex fold failed: ${String(error)}`,
    });
  }
  try {
    const before = draft.guardrail;
    draft.guardrail = foldGuardrail(draft.guardrail, { type: "event", event: ev });
    // foldGuardrail は tool_call_* なら signal 未変更でも clone を返し、resume 直後の live event は
    // history 末尾と同時刻になりうる（initialObservedTimestamp 継承）。参照比較や時刻一致ではなく
    // signal 単位の実変更だけを live 観測として登録する
    if (ev.provenance?.path === "live") {
      for (const id of touchedSignalIds(before, draft.guardrail)) draft.liveGuardrailSignalIds.add(id);
    }
  } catch (error) {
    effects.push({
      type: "log",
      message: `[${draft.title}] Guardrail fold failed: ${String(error)}`,
    });
  }
  if (draft.guardrailLiveSince === undefined && ev.provenance?.path === "live") {
    draft.guardrailLiveSince = ev.timestamp;
  }
  if (ev.provenance?.path === "live") {
    effects.push({ type: "schedule_guardrail_tick" });
  }
  effects.push({ type: "schedule_guardrail_refresh" });
  // 配置と集計をイベント自身へ載せる。EventLog へ入る前に載せるので、snapshot 再生でも
  // live と同じ値が webview へ渡る（別メッセージにすると再生側だけ配置を失う）
  const work = projectWorkEvent(previousWorkModel, draft.workModel, ev);
  if (work !== undefined) ev.work = work;
  // ev.work を載せた後。委任の開始は ev.work.agents で判定するので、前に畳むと委任が 1 件も登録されない（R-SES-02）
  applyActivityEvent(draft.backgroundActivity, ev);
  const trimmed = trimEventLog([...draft.events, ev]);
  // 切り詰めた件数を集計側へ渡す。渡さないと詳細イベントを捨てたのに coverage が
  // complete のままになり、概要が「詳細: すべて表示」と嘘をつく
  draft.workModel = markEventLogTrimmed(draft.workModel, draft.events.length + 1 - trimmed.length);
  draft.events = trimmed;
  // 初回ターン完了時、通常のタブ名を履歴一覧と同じ解決器由来の名前へ付け直す（R-SES-05）。
  // R-LRN-18: research titles use a persisted custom title; refresh retries it if init could not save it.
  // live に限るのは resume の履歴再生でも turn_completed が流れるため（history 経路は
  // 常に provenance {path:"history"} を持つ）。resuming / closed 中は付け直さない
  if (
    ev.kind === "turn_completed" &&
    ev.provenance?.path === "live" &&
    !draft.titleRefreshed &&
    !draft.titleRefreshing &&
    !draft.resuming &&
    !draft.closed
  ) {
    draft.titleRefreshing = true;
    effects.push({ type: "refresh_tab_title" });
  }
  // live のターン境界で JSONL を読み直す（U-1 案 b）。history 再生（resume）の境界ごとには読まず、hydration 完了時に 1 回読む
  if (
    (ev.kind === "turn_started" ||
      ev.kind === "turn_completed" ||
      ev.kind === "turn_interrupted" ||
      ev.kind === "turn_failed") &&
    ev.provenance?.path === "live" &&
    !draft.resuming
  ) {
    effects.push({ type: "schedule_transcript_time_buckets" });
  }
  if (meta?.suppressPost !== true) {
    effects.push({
      type: "post_events",
      tabId: draft.tabId,
      events: [ev],
    });
    effects.push({ type: "schedule_work_model_post" });
    effects.push({ type: "schedule_semantic_model_post" });
  }
  return { draft, normalizedEvent: ev, effects };
}
