import { randomUUID } from "node:crypto";

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

// v4 F-2/F-13/F-14: hydration 中でも操作可能性・ターン終了に直結するので即時表示する。
// commands_changed は Tab.handleEvent が受け付けない kind なので既存 "commands" post を使う（別扱い）
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
  // resume で復元したサブエージェント階層。reducer の外に置くのは、深い階層の agent が
  // 親JSONLに一切現れず WorkSignal を起こせないため
  restoredAgents: RestoredAgent[] = [];
  guardrail: GuardrailState = createGuardrailState();
  guardrailLiveSince?: number;
  // live fold で作成・更新された signal（warn / 自動実行の対象）。history 由来は入らない。
  // 時刻比較（lastAt >= guardrailLiveSince）だと resume 直後に同時刻の history signal が live 扱いになる
  liveGuardrailSignalIds = new Set<string>();
  readonly guardrailRunner = new SessionGuardrail(this, () => this.semantic.semanticDerivation());
  readonly semantic: SessionSemantic;
  readonly analysisStore: SessionAnalysisStore;
  readonly llmRunner: SessionLlm;
  readonly summaryRunner: SessionSummaryWiring;
  sessionFacts: SessionFactsAccumulator = initialSessionFacts();
  // MED-1: 現在の live CLI プロセスで ACK/再開を観測した async 委任の transcriptAgentId。
  // resume 復元・旧プロセス由来の未終端委任を streamOpen だけで running と再主張しないための
  // 制限集合。プロセス交代（generation++）と論理セッション初期化で必ず空へ戻す
  liveDelegationAgentIds = new Set<string>();
  // 集合は in-place 変更のため、memoize の鍵には版数を使う
  liveDelegationRev = 0;
  backgroundActivity: BackgroundActivityState = createBackgroundActivityState();
  // pushEvent が引き取ったが、まだ foldEvidence へ渡していない longGap 境界（r2 M-2）
  timestampContractViolations = 0;
  lastEventTimestamp?: number;
  carriedGapBoundaries: number[] = [];
  // キャッシュ・実行中は Session が所有し Session と共に死ぬ。
  readonly llmCache = new LlmFindingCache();
  llmRun: {
    base: SemanticModelPayload;
    abort: AbortController;
    progress?: { value: LlmAnalysisRunProgress; observedAtMs: number };
  } | null = null;
  // セッション概要の要約（R-DSP-25）。保存の正本は globalState で、これはその写し
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
  // 分析入力の被覆行（Host が組む文字列）。artifact には保存しないので再起動後の復元分には無い
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
  // ensureConversation の並行呼び出しで CLI が二重起動しないよう直列化（レビューP2-1）
  starting: Promise<void> | null = null;
  // closeTab 後に進行中の send がプロンプトを投入しないための閉鎖フラグ（codexレビューC1-2）
  closed = false;
  // /clear 処理中フラグ。並行 send がクリア中の会話へ投入・再生成しないためのガード（レビューAR-C1）
  clearing = false;
  // 現在有効な Conversation の ID。旧世代の遅延イベント混入防止（codexレビューC3-1）
  expectedConversationId: string | null = null;
  // このセッションから切り離した Conversation の ID（FP-1 / codexレビューC3-1）。
  // resetLogicalSession で消してはいけない: resume 再利用は破棄の完了を待たずに進むため、
  // expectedConversationId が null の窓で瀕死の旧 CLI のイベントが世代ガードを素通りする
  readonly detachedConversationIds = new Set<string>();
  cwd = "";
  // trim で auth_status イベントが消えても snapshot が退行しないよう別途退避（レビューR2-4）
  auth: AuthStatus | null = null;
  lastContextTotalTokens: number | null = null;

  // 初回発言からの自動命名がまだ行われていないか（Claude拡張と同様の挙動）
  autoTitled = false;
  // 初回ターン完了後のタブ名付け直しが済んだか。autoTitled とは別に持つ
  // （autoTitled を条件にすると初回発言の名前で固定され、履歴一覧と食い違う — R-SES-05）。
  // 立てるのは refreshTabTitle が実際に名前を解決できたときだけ。呼び出し前に立てると、
  // SDK が一度応えなかっただけでその論理セッションの間ずっと名前が固定される
  titleRefreshed = false;
  // 付け直しの起動中フラグ。turn_completed が続けて流れても SDK 呼び出しを 1 本に保つ
  titleRefreshing = false;
  // 現在の権限モード（初期値は Claude Code 設定の permissions.defaultMode と同期）
  permissionMode: PermissionModeId = resolveInitialMode();
  commands: SlashCommandInfo[] = [];
  models: ModelInfo[] = [];
  // supportedModels() の生の一覧。rows を組み直す入力
  discoveredModels: Pick<ModelInfo, "id" | "label" | "description" | "resolvedModel">[] = [];
  modelOverride: string | null | undefined;
  // 会話を起動した時点で実際に使った model / effort（継承元）。
  // undefined = このタブはまだ一度も起動していない
  effectiveModel: string | null | undefined;
  effectiveEffort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  // resolveSettings から起動時またはモデル変更時に固定した、表示専用の設定値。
  // SDK 起動 options / 実効観測には使わない。
  configuredEffort: ConfiguredEffort | undefined;
  configuredEffortSnapshot: ConfiguredEffortSnapshot | undefined;
  configuredEffortGeneration = 0;
  // 実行中 CLI の get_settings が返した applied.effort / applied.model と、設定に effort が無いときだけ applied.effort を採った表示専用の既定値
  appliedEffort: ConfiguredEffort | null | undefined;
  appliedModel: string | undefined;
  defaultEffort: ConfiguredEffort | undefined;
  // resume 用: 次回 ensureConversation でこのセッションIDを引き継ぐ
  resumeSessionId: string | undefined;
  handoffSource?: {
    sessionId: string;
    title?: string;
    compact?: { preTokens: number; postTokens: number };
    utteranceCount?: number;
  };
  // 過去ログ読み取り中フラグ。clearing は読み取り前に降りるため、これが無いと同じタブへ
  // 二重 resume が入り、バックエンドと表示が別セッションになる
  resuming = false;
  // resume fast path の取引状態。失敗後も retry のために保持し、論理セッション初期化で捨てる
  hydration: ResumeHydration | null = null;
  // v4 F-9: hydration 失敗後は retry 成功まで状況の数値を確定値として出さない
  hydrationCoverageUnconfirmed = false;
  // resume 元のセッションJSONLパス（作業ログからの分析導線に使う）
  resumeFilePath: string | undefined;
  // LAISORA がこのタブへ指定した effort。undefined は未指定または明示的な既定。
  effortOverride: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  // 同じタブの model / effort SDK変更を直列化する。互いの適用・canonical保存先が交差しない。
  profileChangeTail: Promise<void> = Promise.resolve();
  // 最後に履歴窓へ登録した events の指紋。null は「未登録」。値の意味は
  // historyWindowFingerprint 側にある（件数と両端の識別子）
  historyFingerprint: string | null = null;
  // resume で画面へ出した会話メッセージの uuid を**古い順**に並べたもの。会話の遡りは
  // 先頭から順に登録側で探し、最初に見つかったものの手前から始める。
  // 件数で起点を決めると、画面へ出した側（readSessionTranscript）と登録側
  // （readConversationMessages）の集合の差だけ欠落か重複が出る（両者は uuid 重複除去・
  // sidechain の扱い・uuid 欠落レコードの扱いが違う）。先頭1件だけに賭けないのは、
  // その1件がたまたま集合の差に当たると遡りが恒久的に行き止まりになるため。
  // 空配列は「resume していない」= 会話の遡りの対象外
  conversationAnchorUuids: string[] = [];
  // 会話履歴を登録したときに読めなかった行・uuid の無い発言。全 page の coverage に載せる（R-32）
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

  // 論理セッションの初期化はこのメソッドだけで行う。EventLog と WorkModel を別々に消すと
  // 会話Aの phase・集計が会話Bへ残る。ensureConversationInner の generation++ は同じ論理
  // セッションのCLI再起動なので、こちらを通してはいけない（通すと再起動で集計が消える）。
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
    this.defaultEffort = undefined;
    this.configuredEffortGeneration += 1;
    this.store.post({ type: "configuredEffortChanged", tabId: this.tabId, effort: null });
    this.workModel = createWorkModelState();
    this.evidenceIndex = createEvidenceIndex();
    this.sessionFacts = initialSessionFacts();
    this.restoredAgents = [];
    // 旧セッションの導出結果・失敗の申告を新セッションへ持ち越さない（/clear またぎで旧 semantic が stale として出る。W-SD-3）
    this.semantic.semanticMemo = null;
    this.semantic.semanticDerivationFailedLast = false;
    this.semantic.lastGoodSemanticPayload = undefined;
    this.semantic.transcriptTimeBuckets = undefined;
    this.semantic.transcriptTimeBucketsCoverage = undefined;
    this.semantic.transcriptTimeBucketsDirty = false;
    this.semantic.clearTranscriptTimeBucketsTimer();
    // 旧会話の要約を新会話の ID で保存・表示しない（AUDIT-04。W-SUM-6）
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
    // キャッシュを捨ててよいのはここだけ。設定 off / タブ閉鎖で捨てると、同じ作業ログの
    // 再分析に再課金する（キーは semanticHash 基準なので内容が変わらない限り当たる）。
    // clear() は entries だけを消して inFlight を残すため、中断は必ず上の abort が行う
    this.llmCache.clear();
  }

  // 通常の履歴 resume で unused warmup タブを再利用するときだけ使う。/clear は利用者が
  // このタブで明示選択した profile を次の会話へ保持するため、この処理を含めない。
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

  // 設定 off 用。支払い済みの結果と cache は残し、飛行中だけ止める（再度 on にしたとき既存結果を再利用する）。
  // 中断した実行を積み直さないのは requestLlmAnalysis の await 直後のガードの役目で、
  // ここで結果を null にすることに頼っていない
  abortLlmAnalysisRun(): void {
    this.llmRun?.abort.abort();
  }

  // 登録するのは常に全件（this.events）。snapshot が運ぶ配列はこれと同一か、その**末尾側の
  // 連続部分**でなければならない（復帰の restoreSnapshot は末尾側だけを運ぶ）。cursor は
  // 識別子で引くので位置は問わないが、webview が持たないイベントを anchor にできてしまうと
  // chunk が重複・欠落する。registerHistoryWindow は識別子重複で throw し、その場合は
  // 古い登録が残るので明示的に捨てる。
  // 内容が変わっていなければ登録し直さない: registerHistoryWindow は dropScope 経由で
  // そのスコープの cursor を全部落とすので、snapshot を出すたびに登録すると遡り途中の
  // webview の cursor が invalid-cursor になる。scope 上限の退避で登録が消えて
  // いることがあるため、指紋一致だけでなく hasHistoryWindow も見る
  registerHistorySnapshot(): void {
    // 空の登録は作らない。anchor が1件も解決しない窓なので使い道が無く、作ると
    // clear 直後の要求が history-unavailable ではなく unknown-anchor へ化ける
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

  // v4 F-7 / FP-2: Phase 3 post 後の catch-up。work / semantic は各一度だけ
  flushHydrationPosts(h: ResumeHydration): void {
    if (h.workPostDirty) {
      h.workPostDirty = false;
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

  // snapshot の全生成元がこれを通す（生成元ごとに組むと 1 つだけ載せ漏れ、そのタブの点灯が再生頼みに戻る）。
  // ストリームが閉じていれば空を運ぶ: 旧プロセスの背景は実行継続を証明できず、窓内の再生が点けた分も消す（R-SES-02）
  backgroundActivitySnapshot(): BackgroundActivitySnapshot {
    return this.streamOpen() ? backgroundActivitySnapshotOf(this.backgroundActivity) : emptyBackgroundActivitySnapshot();
  }

  // 裁定H-1 の streamOpen: イベントストリームが導出時点で継続中か。
  // live アタッチ中（起動中含む）だけ true。終端後・replay 中・CLI 死亡後は false
  //（実行継続を証明できない async 委任を running と主張しないため）
  streamOpen(): boolean {
    if (this.closed) return false;
    if (this.starting !== null) return true;
    return this.conversation !== null && !this.conversation.isClosed;
  }

  // 現在の呼び出し元は supportedCommands の初回取得のみ（commands_changed は foldEventState 内で
  // 同処理を行う）。初回取得側は CLI 初期化直後の一時的な空を呼び出し前に length===0 で弾く
  applyCommandList(cmds: SlashCommandInfo[]): void {
    const visible = cmds.filter((command) => !isInternalSlashCommand(command));
    const hidden = cmds.filter((command) => isInternalSlashCommand(command));
    // 落としたものはログに残す。サイレントに消すと SDK 更新で新しい内部コマンドが増えたときに
    // 誰も気づけない。
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
      // longGap の境界時刻（裁定C2）。live は claude-normalizer の NormalizedOutMeta、
      // history は HistoryEvent.gapBoundaries が供給する。イベントを生まないレコードを
      // 走査へ渡す唯一の経路なので、ここで落とすと live/history で gap が割れる
      gapBoundaries?: readonly number[];
    },
    // v4 F-5: hydration 中の送信経路（case "send"）だけが渡す。journal entry に載せて
    // 失敗確定時に楽観バブルの撤去先を特定する
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
    // v4 F-4: hydration 失敗後の live event は Session へ fold しつつ persistent journal
    // へも積む。retry 成功時に履歴の後ろへ再採番して合成するのがこの journal
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

  // v4 F-1: hydration 中の live event は Session へ fold せず arrival order で積む。
  // 世代違いの棄却と timestamp gate の判定はここで一度だけ行い、Phase 3 の fold では再評価しない
  private journalLiveEvent(
    h: ResumeHydration,
    partial: NormalizedEventBody & { provenance?: EventProvenance },
    conversationId?: string,
    meta?: EventMeta,
    clientToken?: string
  ): void {
    // FP-1 / codexレビューC3-1: 切り離した Conversation のイベントは journal にも積まない。
    // journal は meta.gapBoundaries を replay へ運ぶ唯一の経路なので、破棄側へ倒しても
    // entry を積むと別会話の境界が新しい論理セッションの longGap 集計へ入る
    if (conversationId !== undefined && this.detachedConversationIds.has(conversationId)) {
      output.appendLine(`[${this.title}] [drop] detached conversation event: ${partial.kind}`);
      return;
    }
    // 旧 Conversation の遅延イベントを新世代へ混入させない（codexレビューC3-1）。
    // hydration 中の CLI 再起動は継続扱いなので expectedConversationId は buffering 中に
    // 入れ替わりうる。判定を replay へ残すと再起動の前後どちらかが丸ごと消える
    const stale = Boolean(
      conversationId &&
        this.expectedConversationId &&
        conversationId !== this.expectedConversationId
    );
    // foldEventState の早期 return と同じ順序で判定する。guardrail-only / commands_changed は
    // timestamp gate へ到達せず seq も進めない。
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
    // 破棄する entry も journal へ積む。meta.gapBoundaries を replay 側へ渡す唯一の経路で、
    // 捨てると委任待ちが longGap として過大報告される
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
      // v4 F-14: 内部コマンド filter は共有し、候補だけを既存経路で即時反映する。
      // 正式な fold は Phase 3 の journal replay 一回だけ
      const visible = partial.commands.filter((command) => !isInternalSlashCommand(command));
      this.store.post({ type: "commands", tabId: this.tabId, commands: visible });
      return;
    }
    // v4 F-14: guardrail fold / assistant_usage は history と live を合成した後に一度だけ（GR-31）
    if (guardrailOnly) return;
    h.acceptedSinceBuffering += 1;
    if (!RESUME_DISPLAY_BYPASS_KINDS.has(partial.kind)) return;
    entry.displayed = true;
    const ev = {
      ...partial,
      backendId: "claude",
      conversationId: conversationId ?? this.conversation?.conversationId ?? "pending",
      generation: this.generation,
      // 失敗確定時の live commit と同じ基準で採番する。到着時 verdict をそのまま使い
      // （EventMeta.arrivalJudged）replay で再判定しないので、seq を進める entry の集合が
      // 到着時と replay 時で一致し、失敗経路では本番 seq と一致する。
      // 成功時は Phase 3 の tabCleared が DOM ごと置換するため衝突しない
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
    // 履歴窓の登録はここでしか行わない。events を webview へ渡す唯一の場所なので、
    // 「登録した配列 = webview が受け取った配列」が構造的に保証されるのはここだけ。
    // 呼び出し側（init / tabCreated / tabCleared）へ個別に足すと将来の追加で漏れる
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
        // Runtime observations stay in auth; configModel is the resolved startup setting.
        permissionMode: this.permissionMode,
        commands: this.commands.length > 0 ? this.commands : undefined,
        models: this.models.length > 0 ? this.models : undefined,
        configEffort: this.configuredEffort,
        defaultEffort: this.defaultEffort,
        appliedModel: this.appliedModel,
        configModel: this.configuredEffortSnapshot?.resolvedModel,
        modelOverride: this.modelOverride,
        effortOverride: this.effortOverride,
        resumeSessionId: this.resumeSessionId,
        resumeFilePath: this.resumeFilePath,
        handoffSource: this.handoffSource,
        workModel: this.semantic.projectedWorkModel(),
        semanticView,
        semanticModel: semanticView ? this.semantic.semanticModelPostPayload() : undefined,
        llmAnalysisEnabled: llmAnalysisEnabled(),
        ...this.llmAnalysisSnapshotFields(),
        sessionSummary: this.summaryRunner.hydratedSessionSummary() ?? undefined,
        sessionSummaryRunning: this.summaryRun !== null,
        // 分析が off の間は診断も表示不可。通常 UI 面は state:"disabled" へ落ちるので、
        // 診断面だけ LLM 生成文を残すと「機能を止めたのに生の棄却理由が画面に残る」
        llmDiagnostics: llmDiagnosticsAudience() !== "off" && llmAnalysisEnabled(),
        backgroundActivity: this.backgroundActivitySnapshot(),
        events: this.events,
        ...(this.hydration === null ? {} : { resumeHydration: this.hydrationSnapshotState() }),
      },
    };
  }

  // v4 F-12: hydration 中の init / 再表示はここを通す。previewMessages には journal で
  // 確定した live 発言を arrival 順で足す（reload で送信済みの発言が消えないように）
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

  // v4 F-12: auth / commands は journal 側にしか無い（hydration 中は Session へ fold しない）。
  // reload 時の snapshot で最新の投影へ戻さないと、bypass で画面に出ていた値が消える
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
    // failed は commit 済み live event を events で運ぶ。preview 側にも journal 由来の
    // user 発言を足すと reload で同じ発言が二重に出る
    if (h.failureReason === undefined) {
      return { phase: "failed", previewMessages: h.previewMessages };
    }
    return {
      phase: "failed",
      previewMessages: h.previewMessages,
      failureReason: h.failureReason,
    };
  }

  // FP-3 / HW-22: 履歴窓を登録しない表示専用 snapshot。snapshot() は登録と搬送が
  // 不可分なので loading / failed でそちらを通してはならない
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
        configModel: this.configuredEffortSnapshot?.resolvedModel,
        modelOverride: this.modelOverride,
        effortOverride: this.effortOverride,
        resumeSessionId: this.resumeSessionId,
        resumeFilePath: this.resumeFilePath,
        handoffSource: this.handoffSource,
        // v4 F-9: 未走査件数は不明なので droppedEventCount を捏造しない
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
        // v4 F-8: failed は commit 済み live event を載せる（reload で消えない）。
        // loading は必ず空配列
        events: loading ? [] : this.events,
        resumeHydration: this.hydrationSnapshotState(),
      },
    };
  }

  // 復帰の init で「見ていないタブ」を積むための最小 snapshot。
  // 履歴窓を登録しない（HW-22: 登録した配列と webview が受け取った配列の同一性が
  // 構造的に保証されるのは snapshot() だけで、ここは events を渡さない）。
  // プロジェクション（workModel / semanticModel）も events も乗せないのがこの型の存在理由で、
  // 中身は tabRestored が後から運ぶ。空の events を「0 件」と見せないのは webview 側の責任
  // （R-TAB-08 / R-CNV-02 のインジケーター）
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
        configModel: this.configuredEffortSnapshot?.resolvedModel,
        modelOverride: this.modelOverride,
        effortOverride: this.effortOverride,
        resumeSessionId: this.resumeSessionId,
        resumeFilePath: this.resumeFilePath,
        handoffSource: this.handoffSource,
        // semanticView / llmDiagnostics / llmAnalysisEnabled を省くと、webview の applyLlmDiagnosticsMode が明示 off を undefined で上書きして診断面が戻る。
        // ここは設定読みだけで導出が無いので省く理由も無い
        semanticView: semanticViewEnabled(),
        llmAnalysisEnabled: llmAnalysisEnabled(),
        ...this.llmAnalysisSnapshotFields(),
        sessionSummary: this.summaryRunner.hydratedSessionSummary() ?? undefined,
        sessionSummaryRunning: this.summaryRun !== null,
        llmDiagnostics: llmDiagnosticsAudience() !== "off" && llmAnalysisEnabled(),
        // events を運ばないので、背景だけが動くタブのドットはこれでしか点かない（R-SES-02）
        backgroundActivity: this.backgroundActivitySnapshot(),
        events: [],
      },
    };
  }

  // 復帰の init が「見ているタブ」へ積む snapshot。events は末尾側だけを運び、落とした
  // 先頭側は履歴窓（snapshot() が登録した this.events）から webview が遡って埋める。
  // 導出（workModel / semanticModel）は memo が効くので落とさない — 落とすと状況の数字が
  // 一度「集計がありません」へ落ちる（R-TAB-07 の部分集計の露出）。削るのは搬送と同期再生の
  // 対象になる events だけ。
  // windowEvents を通すのは、先頭が turn_started であるという不変条件を第2実装にしないため
  // （破ると tab.ts の turnId 照合が落ちて assistant の本文が全消滅する）
  restoreSnapshot(): TabSnapshot {
    const h = this.hydration;
    if (h !== null && h.phase !== "complete") return this.resumePreviewSnapshot(h);
    const full = this.snapshot();
    if (this.events.length <= RESTORE_TAIL_EVENT_MAX) return full;
    const tail = windowEvents(this.events, RESTORE_TAIL_EVENT_MAX);
    // 現在の windowEvents は max より長い入力へ必ず 1 件以上の droppedCount を返すので
    // ここは通らない。残すのは protocol.ts の headOmitted ガードが count>=1 を要求するためで、
    // 0 を載せた init は isHostToWebview に丸ごと弾かれて画面が空になる
    if (tail.droppedCount <= 0) return full;
    const kept = new Set(tail.events);
    // 落とした区間に会話面へ描ける kind が1件も無ければ、webview に会話の追走を
    // 始めさせない（全件 skipped で終わる追走を起こさない — 原因A M-4）
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

  // v4 F-8: init / 再表示 / 設定変更の全経路がここを通る
  snapshotForSurface(): TabSnapshot {
    const h = this.hydration;
    if (h !== null && h.phase !== "complete") return this.resumePreviewSnapshot(h);
    return this.snapshot();
  }

  // v4 F-8/F-9/F-10: 読取失敗・取消・retry 失敗の唯一の出口。
  // tabCleared は送らない（live 会話と楽観バブルを壊す）。部分集計は確定させない
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
        // 破棄する entry でも境界は引き取る。捨てると委任待ちが longGap として
        // 過大報告される（foldEventState が早期 return より前に harvest するのと同じ理由）
        if (entry.meta?.gapBoundaries !== undefined && entry.meta.gapBoundaries.length > 0) {
          this.carriedGapBoundaries.push(...entry.meta.gapBoundaries);
        }
        if (entry.verdict === "dropped-timestamp") droppedByGate += 1;
        continue;
      }
      // 1 件の例外で以降の entry と後始末を巻き添えにしない。抜けると liveCommitCursor が
      // 進まないまま resuming が true で残り、retry が同じ entry を二重 fold する
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
    // 到着時に一度だけ数えた違反を live 側へ引き渡す（Phase 3 の fold は再評価しない・F-1）
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
    // v4 F-3: post で例外が出ても resuming を残さない。post より前で降ろす
    this.resuming = false;
    // v4 F-15: 履歴側 resolver が使えないので live 候補で命名する
    if (!this.autoTitled && h.liveTitleCandidate) {
      this.title = displayTitleFromSummary(h.liveTitleCandidate, this.tabId);
      this.autoTitled = true;
      if (surface) this.store.post({ type: "tabRenamed", tabId: this.tabId, title: this.title });
    }
    if (surface) {
      // 楽観バブルは確定 user_message で「置換」する。webview は
      // rejected / accepted-nonhuman でしか撤去せず（src/webview/main.ts の
      // sendDisposition 分岐）、いずれも removeOptimisticBubble を呼ぶだけで他の副作用は
      // 持たないため、撤去用にこの値を再利用する。events post より前に出すこと
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
      // 失敗した状況の数字（未確定表示）を一度だけ届ける。fold は suppressPost で
      // 抑止しているので、これが唯一の post 経路になる
      h.workPostDirty = true;
      h.semanticPostDirty = true;
      // タブ閉鎖による中止では post しない。SessionStore.post は閉じたタブを弾かないので
      // 消えたタブ宛の workModel が全 surface へ流れる
      this.flushHydrationPosts(h);
      // buffer 中に抑止した live のターン境界を回収する
      this.semantic.scheduleTranscriptTimeBuckets();
    }
  }

  async disposeConversation(): Promise<void> {
    // 起動中なら完了を待ってから破棄（レビューP2R2-1a: start中のcloseTabで孤児CLIが残る）
    while (this.starting) await this.starting;
    const conv = this.detachConversation();
    if (conv) await conv.dispose();
  }

  // Session から Conversation を切り離す唯一の場所。破棄は呼び出し側が行う
  // （closeTab / clear は disposeConversation が同期的に、resume 再利用は
  // disposeDetachedConversation が背後で）。
  // expectedConversationId も切り離し対象に入れるのは、起動中（this.starting）の
  // Conversation が this.conversation にまだ現れないため（ensureConversationInner は
  // start の前に expected を入れる）
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
    // 起動中なら完了を待ってから破棄（レビューP2R2-1a: start中の破棄で孤児CLIが残る）
    while (this.starting) await this.starting;
    // レビューAR-C1: 待機中に旧世代の start が完了して掴まれていたら破棄する。
    // 切り離し後に新しい論理セッションが作った Conversation は生かす必要があるので、
    // 切り離し済み ID のものだけを対象にする
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

// 「まだ何にも使っていないタブ」か。履歴からの復元先として上書きしてよいかの判定に使う。
// 起動直後に自動生成される「会話 1」は事前起動（warmup）で conversation_opened /
// auth_status / rate_limit などのイベントを持つため、events が空かどうかでは判定できない。
// ユーザーの痕跡（発言・復元済みの履歴・ツール実行）が一切なく、実行中でもないことを見る。
export function isUnusedSession(s: Session): boolean {
  if (s.closed || s.clearing || s.resuming) return false;
  if (s.conversation && s.conversation.state !== "idle") return false;
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
