import { randomUUID } from "node:crypto";
import { projectPlanUsage } from "./plan-usage";

import * as l10n from "@vscode/l10n";
import {
  type OwnerState,
  type PersistedAnalysisArtifact,
  type PersistenceReason,
  type PersistenceState,
} from "./analysis-persistence";
import {
  backgroundActivitySnapshotOf,
  createBackgroundActivityState,
  emptyBackgroundActivitySnapshot,
  type BackgroundActivitySnapshot,
  type BackgroundActivityState,
} from "./background-activity";
import { resolveInitialMode, type ConfiguredEffort, type ConfiguredEffortSnapshot } from "./claude-settings";
import { ClaudeConversation } from "./claudeHost";
import type { LearningFacts } from "./learning";
import { isConvRenderableEvent } from "./conv-renderable";
import { releaseConversationHistory } from "./conversation-history";
import { createEvidenceIndex, type SemanticEvidenceIndex } from "./evidence-index";
import {
  foldEventState,
  type EventMeta,
  type FoldEffect,
} from "./event-fold";
import { windowEvents } from "./event-window";
import {
  createGuardrailState,
  type GuardrailState,
} from "./guardrail";
import {
  hasHistoryWindow,
  historyWindowFingerprint,
  registerHistoryWindow,
  releaseHistoryWindow,
} from "./history-window";
import { output } from "./host-context";
import { LlmFindingCache } from "./llm-analysis-client";
import {
  AuthStatus,
  EventProvenance,
  GUARDRAIL_ONLY_EVENT_KINDS,
  ModelInfo,
  NormalizedEvent,
  NormalizedEventBody,
  PermissionModeId,
  RESUME_PREVIEW_MESSAGE_MAX,
  RestoredAgent,
  ResumeHydrationSnapshotState,
  ResumePreviewMessage,
  SemanticModelPayload,
  SlashCommandInfo,
  TabSnapshot,
  LlmUnavailableReason,
  type LlmAnalysisRunProgress,
  isInternalSlashCommand,
  projectWorkModel,
  requiresTimestamp,
} from "./protocol";
import type { ResumeHydration, HydrationJournalEntry, HydrationVerdict } from "./resume-hydration";
import { SessionAnalysisStore } from "./session-analysis-store";
import { initialSessionFacts, type SessionFactsAccumulator } from "./session-facts";
import { SessionGuardrail } from "./session-guardrail";
import { SessionLlm } from "./session-llm";
import { displayTitleFromSummary } from "./session-list";
import { refreshTabTitle } from "./session-list-wiring";
import {
  SessionSemantic,
  llmAnalysisEnabled,
  llmDiagnosticsAudience,
  semanticViewEnabled,
} from "./session-semantic";
import { SessionSummaryWiring } from "./session-summary-wiring";
import {
  RESTORE_TAIL_EVENT_MAX,
  SessionStore,
  currentScopeMax,
} from "./store-surfaces";
import {
  createWorkModelState,
  type WorkModelState,
} from "./work-model";
import type { HostArtifactAccess } from "./artifact-access";

// RESUME_DISPLAY_BYPASS_KINDS は復元待ちでも操作を続けるための表示経路。正式な反映は journalLiveEvent の記録から行う。
const RESUME_DISPLAY_BYPASS_KINDS: ReadonlySet<string> = new Set([
  "approval_request",
  "approval_resolved",
  "permission_denied",
  "error",
  "turn_interrupted",
  "auth_status",
  "rate_limit",
]);

export class Session {
  readonly tabId = randomUUID();
  title: string;
  events: NormalizedEvent[] = [];
  workModel: WorkModelState = createWorkModelState();
  evidenceIndex: SemanticEvidenceIndex = createEvidenceIndex();
  // 親の記録だけでは深い階層を復元できないため、restoredAgents を別に保持する。
  restoredAgents: RestoredAgent[] = [];
  guardrail: GuardrailState = createGuardrailState();
  guardrailLiveSince?: number;
  // イベント由来の liveGuardrailSignalIds は時刻比較で登録しない（src/event-fold.ts#foldEventState）。履歴と現在の観測は同時刻になりうる。
  liveGuardrailSignalIds = new Set<string>();
  readonly guardrailRunner = new SessionGuardrail(this, () => this.semantic.semanticDerivation());
  readonly semantic: SessionSemantic;
  readonly analysisStore: SessionAnalysisStore;
  readonly llmRunner: SessionLlm;
  readonly summaryRunner: SessionSummaryWiring;
  sessionFacts: SessionFactsAccumulator = initialSessionFacts();
  readonly learningFacts?: () => LearningFacts | undefined = () => this.conversation?.learningFacts;
  // 旧プロセスの委任を実行中と再主張しないための liveDelegationAgentIds（verify-webview-wiring#S3-5）。
  liveDelegationAgentIds = new Set<string>();
  // liveDelegationAgentIds は同じ集合を変更するため、導出のキャッシュには liveDelegationRev を使う。
  liveDelegationRev = 0;
  backgroundActivity: BackgroundActivityState = createBackgroundActivityState();
  timestampContractViolations = 0;
  lastEventTimestamp?: number;
  carriedGapBoundaries: number[] = [];
  readonly llmCache = new LlmFindingCache();
  llmRun: {
    base: SemanticModelPayload;
    abort: AbortController;
    progress?: { value: LlmAnalysisRunProgress; observedAtMs: number };
  } | null = null;
  // R-DSP-25: sessionSummary を保存の正本にしない（src/session-summary-wiring.ts#SESSION_SUMMARY_STORE_KEY）。
  sessionSummary: { text: string; model: string } | null = null;
  summaryRun: AbortController | null = null;
  llmResult: {
    base: SemanticModelPayload;
    view: {
      analysisRunId: string;
    };
    generatedAt: number;
  } | null = null;
  logicalGeneration = 1;
  ownerState: OwnerState = { kind: "unresolved" };
  baseRefByArtifactId = new Map<string, SemanticModelPayload>();
  inputCoverageLabelByArtifactId = new Map<string, string>();
  pendingPersistence: Array<{ artifact: PersistedAnalysisArtifact; logicalGeneration: number; seq: number }> = [];
  pendingSeqCounter = 0;
  persistedArtifacts: PersistedAnalysisArtifact[] = [];
  persistenceStateByArtifactId = new Map<string, { state: PersistenceState; reason?: PersistenceReason | "conflicted" }>();
  selectedArtifactId: string | null = null;
  lastAttemptFailedReason: LlmUnavailableReason | null = null;
  seq = 0;
  generation = 1;
  conversation: ClaudeConversation | null = null;
  // 起動待ちは src/conversation-lifecycle.ts#ensureConversation と共有し、並行送信による重複起動を防ぐ。
  starting: Promise<void> | null = null;
  closed = false;
  clearing = false;
  expectedConversationId: string | null = null;
  // detachedConversationIds は resetLogicalSession で消さない。破棄待ちの旧会話も拒否する。
  readonly detachedConversationIds = new Set<string>();
  cwd = "";
  // events の切り詰め後も認証表示を保持するため、snapshot は auth を使う。
  auth: AuthStatus | null = null;
  lastContextTotalTokens: number | null = null;

  autoTitled = false;
  // R-SES-05: autoTitled と titleRefreshed を兼用しない。名前の解決完了は src/session-list-wiring.ts#refreshTabTitle が決める。
  titleRefreshed = false;
  titleRefreshing = false;
  permissionMode: PermissionModeId = resolveInitialMode();
  commands: SlashCommandInfo[] = [];
  models: ModelInfo[] = [];
  discoveredModels: Pick<ModelInfo, "id" | "label" | "description" | "resolvedModel">[] = [];
  modelOverride: string | null | undefined;
  effectiveModel: string | null | undefined;
  effectiveEffort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  // configuredEffort は表示専用。起動設定へ流用せず、src/claude-settings.ts#effortDisplayFromSnapshot の判定に従う。
  configuredEffort: ConfiguredEffort | undefined;
  configuredEffortSnapshot: ConfiguredEffortSnapshot | undefined;
  configuredEffortGeneration = 0;
  appliedEffort: ConfiguredEffort | null | undefined;
  appliedModel: string | undefined;
  modelFallback?: import("./protocol").ModelFallbackState;
  fallbackRevert: { conversation: ClaudeConversation; turnId: string | null; originalModel: string; priorOverride: string | null | undefined } | undefined;
  recordedModel: string | undefined;
  defaultEffort: ConfiguredEffort | undefined;
  resumeSessionId: string | undefined;
  handoffSource?: {
    sessionId: string;
    title?: string;
    compact?: { preTokens: number; postTokens: number };
    utteranceCount?: number;
    detailRunId?: string;
    decisionCount?: number;
  };
  // 復元中の再利用は resuming で防ぐ。clearing は記録の読み取り前に解除される（src/resume-hydration.ts#openResumedSession）。
  resuming = false;
  hydration: ResumeHydration | null = null;
  // 復元失敗後の部分値を確定表示へ戻さないための hydrationCoverageUnconfirmed。
  hydrationCoverageUnconfirmed = false;
  resumeFilePath: string | undefined;
  effortOverride: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  profileChangeTail: Promise<void> = Promise.resolve();
  historyFingerprint: string | null = null;
  // conversationAnchorUuids は件数へ置き換えない。表示側と登録側で読める記録が異なる（src/conversation-history.ts#registerConversationHistory）。
  conversationAnchorUuids: string[] = [];
  // R-DSP-03: 読めなかった記録を完全な履歴と見せないための conversationHistoryGaps。
  conversationHistoryGaps: { malformedLineCount: number; droppedWithoutUuidCount: number } | undefined = undefined;

  constructor(private readonly store: SessionStore, index: number) {
    this.title = l10n.t("Conversation {0}", index);
    this.semantic = new SessionSemantic(this, store);
    this.analysisStore = new SessionAnalysisStore(this, store);
    this.llmRunner = new SessionLlm(this, store);
    this.summaryRunner = new SessionSummaryWiring(this, store);
  }

  get lastRecordedEventTimestamp(): number | undefined {
    return this.lastEventTimestamp;
  }

  // 同じ会話のプロセス再起動で resetLogicalSession を呼ばない。履歴の継続を保つ。
  resetLogicalSession(): void {
    this.hydration = null;
    this.hydrationCoverageUnconfirmed = false;
    this.expectedConversationId = null;
    this.titleRefreshed = false;
    this.titleRefreshing = false;
    this.generation += 1;
    this.logicalGeneration += 1;
    this.ownerState = { kind: "unresolved" };
    this.baseRefByArtifactId.clear();
    this.inputCoverageLabelByArtifactId.clear();
    this.pendingPersistence = [];
    this.pendingSeqCounter = 0;
    this.persistedArtifacts = [];
    this.persistenceStateByArtifactId.clear();
    this.selectedArtifactId = null;
    this.lastAttemptFailedReason = null;
    this.events = [];
    this.seq = 0;
    this.lastEventTimestamp = undefined;
    this.timestampContractViolations = 0;
    this.carriedGapBoundaries = [];
    this.lastContextTotalTokens = null;
    this.configuredEffort = undefined;
    this.configuredEffortSnapshot = undefined;
    this.appliedEffort = undefined;
    this.appliedModel = undefined;
    this.modelFallback = undefined;
    this.fallbackRevert = undefined;
    this.recordedModel = undefined;
    this.defaultEffort = undefined;
    this.configuredEffortGeneration += 1;
    this.store.post({ type: "configuredEffortChanged", tabId: this.tabId, effort: null });
    this.workModel = createWorkModelState();
    this.evidenceIndex = createEvidenceIndex();
    this.sessionFacts = initialSessionFacts();
    this.restoredAgents = [];
    // 旧会話の導出結果を持ち越さない（verify-llm-wiring#W-SD-3）。
    this.semantic.semanticMemo = null;
    this.semantic.semanticDerivationFailedLast = false;
    this.semantic.lastGoodSemanticPayload = undefined;
    this.semantic.transcriptTimeBuckets = undefined;
    this.semantic.transcriptTimeBucketsCoverage = undefined;
    this.semantic.transcriptTimeBucketsDirty = false;
    this.semantic.clearTranscriptTimeBucketsTimer();
    // 要約のリセットを外すと旧会話の内容が残る（verify-llm-wiring#W-SUM-6c）。
    this.summaryRunner.resetForLogicalSession();
    this.resumeSessionId = undefined;
    this.handoffSource = undefined;
    this.resumeFilePath = undefined;
    releaseHistoryWindow(historyScopeKey(this));
    releaseHistoryWindow(historyTranscriptScopeKey(this));
    this.historyFingerprint = null;
    releaseConversationHistory(historyScopeKey(this));
    this.conversationAnchorUuids = [];
    this.conversationHistoryGaps = undefined;
    this.clearLiveDelegations();
    this.backgroundActivity = createBackgroundActivityState();
    this.semantic.clearSemanticModelPostTimer();
    this.guardrail = createGuardrailState();
    this.guardrailRunner.notifiedGuardrailSignalIds.clear();
    this.guardrailLiveSince = undefined;
    this.liveGuardrailSignalIds.clear();
    this.guardrailRunner.guardrailLedger = {};
    this.guardrailRunner.reportedSignalIds.clear();
    this.guardrailRunner.pendingReportSignalIds = [];
    this.guardrailRunner.lastReportedDroppedSignalCount = 0;
    this.guardrailRunner.generationSentSignalIds.clear();
    this.guardrailRunner.clearGuardrailRefreshTimer();
    this.guardrailRunner.clearGuardrailTickTimer();
    this.discardLlmAnalysis();
    // src/llm-analysis-client.ts#LlmFindingCache.clear は実行中の処理を中断しないため、先に discardLlmAnalysis を通す。
    this.llmCache.clear();
  }

  // resetDiscardedProfileForResume は履歴の再利用用。明示選択した設定を引き継ぐ resetLogicalSession には含めない。
  resetDiscardedProfileForResume(): void {
    this.modelOverride = undefined;
    this.effortOverride = undefined;
    this.effectiveModel = undefined;
    this.effectiveEffort = undefined;
  }

  discardLlmAnalysis(): void {
    this.abortLlmAnalysisRun();
    this.llmResult = null;
  }

  // 設定の再有効化で支払い済みの結果を使えるよう、abortLlmAnalysisRun では結果とキャッシュを保持する。
  abortLlmAnalysisRun(): void {
    this.llmRun?.abort.abort();
  }

  // 窓取りは連続とは限らないため、搬送する範囲は src/event-window.ts#windowEvents に従う。
  registerHistorySnapshot(): void {
    if (this.events.length === 0) return;
    const scopeKey = historyScopeKey(this);
    const fingerprint = historyWindowFingerprint(this.events);
    if (this.historyFingerprint === fingerprint && hasHistoryWindow(scopeKey)) return;
    try {
      registerHistoryWindow(scopeKey, this.events, currentScopeMax());
      this.historyFingerprint = fingerprint;
    } catch (error) {
      releaseHistoryWindow(scopeKey);
      this.historyFingerprint = null;
      output.appendLine(`[${this.title}] 履歴chunkの索引作成に失敗: ${String(error)}`);
    }
  }

  clearLiveDelegations(): void {
    if (this.liveDelegationAgentIds.size === 0) return;
    this.liveDelegationAgentIds.clear();
    this.liveDelegationRev += 1;
  }

  flushHydrationPosts(h: ResumeHydration): void {
    if (h.workPostDirty) {
      h.workPostDirty = false;
      this.store.post({ type: "planUsage", tabId: this.tabId,
        state: projectPlanUsage(this.sessionFacts.planUsage, this.evidenceIndex.timeBuckets.blocks) });
      this.store.post({ type: "workModel", tabId: this.tabId, model: this.semantic.projectedWorkModel() });
    }
    if (h.semanticPostDirty) {
      h.semanticPostDirty = false;
      if (semanticViewEnabled()) {
        const model = this.semantic.semanticModelPostPayload();
        if (model !== undefined) {
          this.store.post({ type: "semanticModel", tabId: this.tabId, model });
        }
      }
    }
    for (const msg of h.persistencePosts.values()) this.store.post(msg);
    h.persistencePosts.clear();
  }

  // R-SES-02: 旧プロセスの背景活動を再主張しないため、backgroundActivitySnapshot は streamOpen を参照する。
  backgroundActivitySnapshot(): BackgroundActivitySnapshot {
    return this.streamOpen() ? backgroundActivitySnapshotOf(this.backgroundActivity) : emptyBackgroundActivitySnapshot();
  }

  streamOpen(): boolean {
    if (this.closed) return false;
    if (this.starting !== null) return true;
    return this.conversation !== null && !this.conversation.isClosed;
  }

  applyCommandList(cmds: SlashCommandInfo[]): void {
    const visible = cmds.filter((command) => !isInternalSlashCommand(command));
    const hidden = cmds.filter((command) => isInternalSlashCommand(command));
    if (hidden.length > 0) {
      output.appendLine(
        `[${this.title}] internal slash commands filtered from suggest: ${hidden.map((command) => command.name).join(", ")}`
      );
    }
    this.commands = visible;
    this.store.post({ type: "commands", tabId: this.tabId, commands: visible });
  }

  pushEvent(
    partial: NormalizedEventBody & { provenance?: EventProvenance },
    conversationId?: string,
    meta?: {
      timestamp?: number;
      hostArtifacts?: HostArtifactAccess[];
      suppressPost?: boolean;
      gapBoundaries?: readonly number[];
    },
    clientToken?: string
  ): void {
    const h = this.hydration;
    if (h !== null && h.buffering) {
      this.journalLiveEvent(h, partial, conversationId, meta, clientToken);
      return;
    }
    const before = this.timestampContractViolations;
    const { effects } = foldEventState(this, partial, conversationId, meta);
    this.executeFoldEffects(effects);
    if (h !== null && h.phase === "failed") {
      h.journal.push({
        journalEventId: `${h.attemptId}#${++h.journalSeq}`,
        partial,
        conversationId,
        meta,
        verdict: this.timestampContractViolations > before ? "dropped-timestamp" : "accepted",
        displayed: true,
      });
      h.liveCommitCursor = h.journal.length;
    }
  }

  // 到着時の判定を再生時にやり直さない。復元待ちの間にも会話プロセスは交代しうる（src/event-fold.ts#EventMeta）。
  private journalLiveEvent(
    h: ResumeHydration,
    partial: NormalizedEventBody & { provenance?: EventProvenance },
    conversationId?: string,
    meta?: EventMeta,
    clientToken?: string
  ): void {
    // 切り離した会話の扱いは detachedConversationIds。
    if (conversationId !== undefined && this.detachedConversationIds.has(conversationId)) {
      output.appendLine(`[${this.title}] [drop] detached conversation event: ${partial.kind}`);
      return;
    }
    const stale = Boolean(
      conversationId &&
        this.expectedConversationId &&
        conversationId !== this.expectedConversationId
    );
    // 到着時の判定順序は src/event-fold.ts#foldEventState に合わせる。
    const guardrailOnly = GUARDRAIL_ONLY_EVENT_KINDS.has(partial.kind);
    const commandsChanged = partial.kind === "commands_changed";
    let verdict: HydrationVerdict = "accepted";
    if (stale) {
      verdict = "dropped-stale";
      output.appendLine(`[${this.title}] [drop] stale event from old conversation: ${partial.kind}`);
    } else if (!guardrailOnly && !commandsChanged) {
      if (
        meta?.timestamp === undefined &&
        requiresTimestamp(partial.kind) &&
        h.arrivalTimestamp !== undefined
      ) {
        verdict = "dropped-timestamp";
        output.appendLine(
          `[${this.title}] [contract] ${partial.kind} に timestamp が無い（実時計で補完しない・破棄）`
        );
      } else if (meta?.timestamp !== undefined) {
        h.arrivalTimestamp = meta.timestamp;
      }
    }
    // 棄却した記録の境界も finalizeHydrationFailure へ運び、待ち時間の集計に使う。
    const entry: HydrationJournalEntry = {
      journalEventId: `${h.attemptId}#${++h.journalSeq}`,
      partial,
      conversationId,
      meta,
      verdict,
      displayed: false,
      ...(clientToken === undefined ? {} : { clientToken }),
    };
    h.journal.push(entry);
    if (verdict !== "accepted") return;
    if (commandsChanged) {
      const visible = partial.commands.filter((command) => !isInternalSlashCommand(command));
      this.store.post({ type: "commands", tabId: this.tabId, commands: visible });
      return;
    }
    if (guardrailOnly) return;
    h.acceptedSinceBuffering += 1;
    if (!RESUME_DISPLAY_BYPASS_KINDS.has(partial.kind)) return;
    entry.displayed = true;
    const ev = {
      ...partial,
      backendId: "claude",
      conversationId: conversationId ?? this.conversation?.conversationId ?? "pending",
      generation: this.generation,
      // 失敗時にも表示済みのイベントを同定できるよう、finalizeHydrationFailure と採番を合わせる。
      seq: h.liveSeqBase + h.acceptedSinceBuffering,
      timestamp: meta?.timestamp ?? h.arrivalTimestamp ?? 0,
    } as NormalizedEvent;
    this.store.post({
      type: "resumeHydrationState",
      tabId: this.tabId,
      displayEvent: { journalEventId: entry.journalEventId, event: ev },
    });
  }

  private executeFoldEffects(effects: readonly FoldEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "log":
          output.appendLine(effect.message);
          break;
        case "schedule_guardrail_refresh":
          this.guardrailRunner.scheduleGuardrailRefresh();
          break;
        case "schedule_guardrail_tick":
          this.guardrailRunner.scheduleGuardrailTick();
          break;
        case "post_commands":
          this.store.post({ type: "commands", tabId: effect.tabId, commands: effect.commands });
          break;
        case "resolve_owner":
          this.analysisStore.resolveOwnerFromAuthStatus(effect.sessionId, effect.logicalGeneration);
          break;
        case "refresh_tab_title":
          void refreshTabTitle(this);
          break;
        case "schedule_transcript_time_buckets":
          this.semantic.scheduleTranscriptTimeBuckets();
          break;
        case "post_events":
          this.store.post({ type: "events", tabId: effect.tabId, events: effect.events });
          break;
        case "schedule_work_model_post":
          this.semantic.scheduleWorkModelPost();
          break;
        case "schedule_semantic_model_post":
          this.semantic.scheduleSemanticModelPost();
          break;
      }
    }
  }

  private llmAnalysisSnapshotFields(): {
    llmAnalysisRunning: boolean;
    llmAnalysisProgress?: LlmAnalysisRunProgress;
  } {
    const run = this.llmRun;
    if (run === null) return { llmAnalysisRunning: false };
    const observed = run.progress;
    if (observed === undefined) return { llmAnalysisRunning: true };
    return {
      llmAnalysisRunning: true,
      llmAnalysisProgress: {
        ...observed.value,
        elapsedMs: observed.value.elapsedMs + Math.max(0, Date.now() - observed.observedAtMs),
      },
    };
  }

  snapshot(): TabSnapshot {
    this.registerHistorySnapshot();
    const semanticView = semanticViewEnabled();
    return {
      tabId: this.tabId,
      title: this.title,
      state: {
        conversationId: this.conversation?.conversationId ?? null,
        cwd: this.cwd,
        turnState: this.conversation?.state ?? "idle",
        auth: this.auth,
        permissionMode: this.permissionMode,
        commands: this.commands.length > 0 ? this.commands : undefined,
        models: this.models.length > 0 ? this.models : undefined,
        configEffort: this.configuredEffort,
        defaultEffort: this.defaultEffort,
        appliedModel: this.appliedModel,
        modelFallback: this.modelFallback,
        appliedEffort: this.appliedEffort,
        recordedModel: this.recordedModel,
        configModel: this.configuredEffortSnapshot?.resolvedModel,
        modelOverride: this.modelOverride,
        effortOverride: this.effortOverride,
        resumeSessionId: this.resumeSessionId,
        resumeFilePath: this.resumeFilePath,
        handoffSource: this.handoffSource,
        workModel: this.semantic.projectedWorkModel(),
        planUsage: projectPlanUsage(this.sessionFacts.planUsage, this.evidenceIndex.timeBuckets.blocks),
        semanticView,
        semanticModel: semanticView ? this.semantic.semanticModelPostPayload() : undefined,
        llmAnalysisEnabled: llmAnalysisEnabled(),
        ...this.llmAnalysisSnapshotFields(),
        sessionSummary: this.summaryRunner.hydratedSessionSummary() ?? undefined,
        sessionSummaryRunning: this.summaryRun !== null,
        llmDiagnostics: llmDiagnosticsAudience() !== "off" && llmAnalysisEnabled(),
        backgroundActivity: this.backgroundActivitySnapshot(),
        events: this.events,
        ...(this.hydration === null ? {} : { resumeHydration: this.hydrationSnapshotState() }),
      },
    };
  }

  // 再表示で送信済みの発言を失わないため、hydrationPreviewMessages は到着記録も参照する。
  hydrationPreviewMessages(h: ResumeHydration): ResumePreviewMessage[] {
    const merged: ResumePreviewMessage[] = [...h.previewMessages];
    for (const entry of h.journal) {
      if (entry.verdict !== "accepted" || entry.partial.kind !== "user_message") continue;
      const text = entry.partial.text;
      if (typeof text !== "string" || text.length === 0) continue;
      merged.push({
        uuid: entry.journalEventId,
        role: "user",
        text,
        ...(entry.partial.imageRefs && entry.partial.imageRefs.length > 0
          ? { imageRefs: entry.partial.imageRefs }
          : {}),
      });
    }
    return merged.length > RESUME_PREVIEW_MESSAGE_MAX
      ? merged.slice(merged.length - RESUME_PREVIEW_MESSAGE_MAX)
      : merged;
  }

  // 復元待ちの再表示で即時表示の値を失わないため、hydrationProjected は到着記録も参照する。
  private hydrationProjected(h: ResumeHydration): {
    auth: AuthStatus | null;
    commands: SlashCommandInfo[];
    lastContextTotalTokens: number | null;
  } {
    let auth = this.auth;
    let commands = this.commands;
    let lastContextTotalTokens = this.lastContextTotalTokens;
    for (const entry of h.journal) {
      if (entry.verdict !== "accepted") continue;
      if (entry.partial.kind === "auth_status") auth = entry.partial.auth;
      else if (entry.partial.kind === "commands_changed") {
        commands = entry.partial.commands.filter((command) => !isInternalSlashCommand(command));
      } else if (entry.partial.kind === "context_usage") {
        lastContextTotalTokens = entry.partial.totalTokens;
      }
    }
    return { auth, commands, lastContextTotalTokens };
  }

  private hydrationSnapshotState(): ResumeHydrationSnapshotState | undefined {
    const h = this.hydration;
    if (h === null) return undefined;
    if (h.phase === "complete") return { phase: "complete" };
    if (h.phase === "loading") {
      return { phase: "loading", previewMessages: this.hydrationPreviewMessages(h) };
    }
    if (h.failureReason === undefined) {
      return { phase: "failed", previewMessages: h.previewMessages };
    }
    return {
      phase: "failed",
      previewMessages: h.previewMessages,
      failureReason: h.failureReason,
    };
  }

  // 未確定の記録は resumePreviewSnapshot で表示する。
  resumePreviewSnapshot(h: ResumeHydration): TabSnapshot {
    const loading = h.phase !== "failed";
    const base = projectWorkModel(this.workModel, this.restoredAgents);
    const projected = this.hydrationProjected(h);
    return {
      tabId: this.tabId,
      title: this.title,
      state: {
        conversationId: this.conversation?.conversationId ?? null,
        cwd: this.cwd,
        turnState: this.conversation?.state ?? "idle",
        auth: projected.auth,
        permissionMode: this.permissionMode,
        commands: projected.commands.length > 0 ? projected.commands : undefined,
        models: this.models.length > 0 ? this.models : undefined,
        configEffort: this.configuredEffort,
        defaultEffort: this.defaultEffort,
        appliedModel: this.appliedModel,
        modelFallback: this.modelFallback,
        appliedEffort: this.appliedEffort,
        recordedModel: this.recordedModel,
        configModel: this.configuredEffortSnapshot?.resolvedModel,
        modelOverride: this.modelOverride,
        effortOverride: this.effortOverride,
        resumeSessionId: this.resumeSessionId,
        resumeFilePath: this.resumeFilePath,
        handoffSource: this.handoffSource,
        workModel: {
          ...base,
          coverage: {
            ...base.coverage,
            summary: "prefix-truncated",
            details: "prefix-truncated",
            hydrationUnconfirmed: loading ? "loading" : "failed",
            ...(loading ? { source: "event-tail" as const } : {}),
          },
        },
        semanticView: semanticViewEnabled(),
        llmAnalysisEnabled: llmAnalysisEnabled(),
        ...this.llmAnalysisSnapshotFields(),
        sessionSummary: this.summaryRunner.hydratedSessionSummary() ?? undefined,
        sessionSummaryRunning: this.summaryRun !== null,
        llmDiagnostics: llmDiagnosticsAudience() !== "off" && llmAnalysisEnabled(),
        backgroundActivity: this.backgroundActivitySnapshot(),
        // 復元失敗後の送信済みの発言は events を参照する。
        events: loading ? [] : this.events,
        resumeHydration: this.hydrationSnapshotState(),
      },
    };
  }

  // R-TAB-08 / R-CNV-02: deferredSnapshot の空の記録を読了と見せない。中身は src/store-surfaces.ts#SessionStore.drainRestoreFill が運ぶ。
  deferredSnapshot(): TabSnapshot {
    return {
      tabId: this.tabId,
      title: this.title,
      deferred: true,
      state: {
        conversationId: this.conversation?.conversationId ?? null,
        cwd: this.cwd,
        turnState: this.conversation?.state ?? "idle",
        auth: this.auth,
        permissionMode: this.permissionMode,
        commands: this.commands.length > 0 ? this.commands : undefined,
        models: this.models.length > 0 ? this.models : undefined,
        configEffort: this.configuredEffort,
        defaultEffort: this.defaultEffort,
        appliedModel: this.appliedModel,
        modelFallback: this.modelFallback,
        appliedEffort: this.appliedEffort,
        recordedModel: this.recordedModel,
        configModel: this.configuredEffortSnapshot?.resolvedModel,
        modelOverride: this.modelOverride,
        effortOverride: this.effortOverride,
        resumeSessionId: this.resumeSessionId,
        resumeFilePath: this.resumeFilePath,
        handoffSource: this.handoffSource,
        semanticView: semanticViewEnabled(),
        llmAnalysisEnabled: llmAnalysisEnabled(),
        ...this.llmAnalysisSnapshotFields(),
        sessionSummary: this.summaryRunner.hydratedSessionSummary() ?? undefined,
        sessionSummaryRunning: this.summaryRun !== null,
        llmDiagnostics: llmDiagnosticsAudience() !== "off" && llmAnalysisEnabled(),
        // R-SES-02: 再生する記録のない面でも backgroundActivitySnapshot で背景活動を復元する。
        backgroundActivity: this.backgroundActivitySnapshot(),
        events: [],
      },
    };
  }

  // R-TAB-07: 搬送の窓取りで集計を部分値へ戻さない。窓の選択は src/event-window.ts#windowEvents に委ねる。
  restoreSnapshot(): TabSnapshot {
    const h = this.hydration;
    if (h !== null && h.phase !== "complete") return this.resumePreviewSnapshot(h);
    const full = this.snapshot();
    if (this.events.length <= RESTORE_TAIL_EVENT_MAX) return full;
    const tail = windowEvents(this.events, RESTORE_TAIL_EVENT_MAX);
    // 省略件数の受理条件は src/protocol.ts#isHostToWebview に従う。
    if (tail.droppedCount <= 0) return full;
    const kept = new Set(tail.events);
    let hasConvEvent = false;
    for (const ev of this.events) {
      if (kept.has(ev)) continue;
      if (isConvRenderableEvent(ev)) {
        hasConvEvent = true;
        break;
      }
    }
    return {
      ...full,
      state: {
        ...full.state,
        headOmitted: {
          count: tail.droppedCount,
          hasConvEvent,
          backfilledHead: tail.backfilledHead,
        },
        events: tail.events,
      },
    };
  }

  snapshotForSurface(): TabSnapshot {
    const h = this.hydration;
    if (h !== null && h.phase !== "complete") return this.resumePreviewSnapshot(h);
    return this.snapshot();
  }

  // 失敗後の部分値の扱いは hydrationCoverageUnconfirmed。
  finalizeHydrationFailure(h: ResumeHydration, reason: string, surface: boolean): void {
    h.buffering = false;
    h.phase = "failed";
    h.failureReason = reason;
    const undisplayed: NormalizedEvent[] = [];
    const withdrawTokens: string[] = [];
    let droppedByGate = 0;
    for (let i = h.liveCommitCursor; i < h.journal.length; i++) {
      const entry = h.journal[i];
      if (entry.verdict !== "accepted") {
        if (entry.meta?.gapBoundaries !== undefined && entry.meta.gapBoundaries.length > 0) {
          this.carriedGapBoundaries.push(...entry.meta.gapBoundaries);
        }
        if (entry.verdict === "dropped-timestamp") droppedByGate += 1;
        continue;
      }
      try {
        const { normalizedEvent, effects } = foldEventState(
          this,
          entry.partial,
          entry.conversationId,
          { ...(entry.meta ?? {}), suppressPost: true, arrivalJudged: true }
        );
        this.executeFoldEffects(effects);
        if (normalizedEvent !== null && !entry.displayed) {
          undisplayed.push(normalizedEvent);
          if (entry.clientToken !== undefined) withdrawTokens.push(entry.clientToken);
        }
      } catch (error) {
        output.appendLine(`[${this.title}] hydration failure fold failed: ${String(error)}`);
      }
    }
    this.timestampContractViolations += droppedByGate;
    h.liveCommitCursor = h.journal.length;
    this.hydrationCoverageUnconfirmed = true;
    this.workModel = {
      ...this.workModel,
      coverage: {
        ...this.workModel.coverage,
        hydrationUnconfirmed: "failed",
        summary: "prefix-truncated",
        details: "prefix-truncated",
      },
    };
    this.resuming = false;
    if (!this.autoTitled && h.liveTitleCandidate) {
      this.title = displayTitleFromSummary(h.liveTitleCandidate, this.tabId);
      this.autoTitled = true;
      if (surface) this.store.post({ type: "tabRenamed", tabId: this.tabId, title: this.title });
    }
    if (surface) {
      // 確定した発言を届ける前に楽観表示を撤去する（finalizeHydrationFailure）。
      for (const clientToken of withdrawTokens) {
        this.store.post({
          type: "resumeHydrationState",
          tabId: this.tabId,
          sendDisposition: { clientToken, disposition: "accepted-nonhuman" },
        });
      }
      if (undisplayed.length > 0) {
        this.store.post({ type: "events", tabId: this.tabId, events: undisplayed });
      }
      this.store.post({
        type: "resumeHydrationState",
        tabId: this.tabId,
        phase: "failed",
        reason,
      });
      h.workPostDirty = true;
      h.semanticPostDirty = true;
      // 閉じたタブへの配送は src/store-surfaces.ts#SessionStore.post が拒否しないため、surface の判定内で通知する。
      this.flushHydrationPosts(h);
      this.semantic.scheduleTranscriptTimeBuckets();
    }
  }

  async disposeConversation(): Promise<void> {
    while (this.starting) await this.starting;
    const conv = this.detachConversation();
    if (conv) await conv.dispose();
  }

  // 起動途中の会話も切り離し対象にする。src/conversation-lifecycle.ts#ensureConversationInner は開始前に expectedConversationId を設定する。
  detachConversation(): ClaudeConversation | null {
    const conv = this.conversation;
    this.conversation = null;
    if (conv) this.detachedConversationIds.add(conv.conversationId);
    if (this.expectedConversationId) this.detachedConversationIds.add(this.expectedConversationId);
    this.guardrailRunner.clearGuardrailTickTimer();
    this.guardrailRunner.settleConversationLost();
    return conv;
  }

  async disposeDetachedConversation(conv: ClaudeConversation | null): Promise<void> {
    if (conv) await conv.dispose();
    while (this.starting) await this.starting;
    const adopted = this.conversation;
    if (adopted !== null && this.detachedConversationIds.has(adopted.conversationId)) {
      this.conversation = null;
      await adopted.dispose();
    }
  }
}

export function historyScopeKey(session: Session): string {
  return session.tabId;
}

export function historyTranscriptScopeKey(session: Session): string {
  return `${historyScopeKey(session)}:transcript`;
}

// isUnusedSession を記録の空判定へ置き換えない。事前起動だけでもイベントが残る。
export function isUnusedSession(s: Session): boolean {
  if (s.closed || s.clearing || s.resuming) return false;
  if (s.conversation && s.conversation.state !== "idle") return false;
  // R-HND-09: 記録を読めなくても引き継ぎカードを上書きしないため、handoffSource を確認する。
  if (s.handoffSource !== undefined) return false;
  const used = s.events.some(
    (e) =>
      e.kind === "user_message" ||
      e.kind === "replayed_message" ||
      e.kind === "assistant_text_delta" ||
      e.kind === "tool_call_started" ||
      e.kind === "turn_started"
  );
  return !used;
}
