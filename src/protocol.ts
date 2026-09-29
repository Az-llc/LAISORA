import { isToolIntentInput, type ToolIntentInput } from "./webview/status-line";
import { isAccentSettings, isAccentSettingValue, type AccentSettings, type AccentSetting } from "./accent";
import { normalizeSystemAppExtension } from "./file-link-open-mode";
import { isPlanUsage, type MainTokenTotal } from "./plan-usage";
import type { FailureSummaryView } from "./exec-log-marks";
import type { RoleSummaryView } from "./role-summary";
import type { ExecutorId } from "./orchestration-executors";
import { isExternalTimeout, isExternalDetection, isExternalModels, type ExternalModels, type ExternalDetection } from "./orchestration-roster";
import { isOrchestrationSettingRoster, type OrchestrationSettingRow } from "./orchestration-roster";
import { isOrchestrationView, type OrchestrationView } from "./orchestration-view";
export type { OrchestrationView } from "./orchestration-view";
// ready の cursor を Host は読まない（src/store-surfaces.ts#SessionStore.initForReady）。差分再送は配線されていない。

// work-model.ts が protocol.ts から取るのは NormalizedEvent の型だけなので、
// こちらから値を取っても実行時の循環にはならない。逆向き（work-model.ts が protocol.ts の
// 値を使う）を足すと循環するので足さないこと。
// phaseStateOf をここで再実装しない（分類の実装は work-model.ts の1つに限る）。
import * as l10n from "@vscode/l10n";
import { FILE_LINK_TARGET_MAX_LEN } from "./file-link-target";
export { FILE_LINK_TARGET_MAX_LEN } from "./file-link-target";
import { findToolPlacement, findWorkSegment, phaseStateOf } from "./work-model";
import { BACKGROUND_ACTIVITY_LIST_MAX, type BackgroundActivitySnapshot } from "./background-activity";
export { BACKGROUND_ACTIVITY_LIST_MAX } from "./background-activity";
export type { BackgroundActivitySnapshot } from "./background-activity";
import type {
  OperationKind,
  PhaseOperation,
  TaskIntent,
  TaskStatus,
  WorkCoverage,
  WorkModelState,
  WorkPhaseState,
  WorkStatus,
  WorkTotals,
} from "./work-model";
import type { EffectCoverage, ProjectedArtifactAccess } from "./artifact-access";
import type { AnalysisFactsView, SummaryAnalysisView } from "./analysis-facts-view";
// type-only に保つこと: semantic-model.ts と l3-divergence.ts は node:crypto を実行時 import しており、
// 値を取ると browser バンドル（dist/webview.js）が壊れる。
import type { Coverage, ExecutionAttemptNode, SemanticModel, SemanticNode } from "./semantic-model";
import type { L3Report, SerializationClassification } from "./l3-analysis";
import type {
  DivergenceKind,
  DivergenceKindReport,
  DivergenceRecord,
  DivergenceReport,
} from "./l3-divergence";
import type { LlmAnalysisProvenance, RejectedFinding } from "./llm-finding-verify";
import type { HandoffDecisionEntry, HandoffDecisions } from "./handoff-envelope";

// 再読込前の webview は Host と版がずれうる。src/webview/main.ts が init の protocolVersion と突き合わせて利用者へ出す。
// バリアントの追加では上げない（verify-history-wiring#W-0b）。
export const PROTOCOL_VERSION = 5;

export type BackendId = "claude" | "codex";

export type IngestionPath = "live" | "history" | "snapshot";

export interface EventProvenance {
  path: IngestionPath;
  unavailableFields?: string[];
}

export interface DelegationInfo {
  subagentType?: string;
  description?: string;
  subagentModel?: string;
  subagentEffort?: string;
  isBackground?: boolean;
}

// CLI の task-notification を写す（src/tool-observation.ts#parseTaskNotification）。toolUseId は初回完了では dispatch の id、
// resume 後は SendMessage の id を指す。
export interface TaskNotificationInfo {
  agentId: string;
  toolUseId?: string;
  status?: string;
  // 同じ agentId の再通知は置き換える量で、足し合わせない（src/work-model.ts#recordNotifiedTokens）。
  tokens?: number;
}

// 待機状態（queued）は emitter から到達不能なので加えない。受理する集合は src/tool-observation.ts#PROGRESS_STATES。
export type ProgressState = "active" | "blocked" | "review" | "done";

export interface ProgressEmission {
  pp: "pp1";
  // subagent は task id を知らずに pp1 を出すので省略できる。空の値は src/tool-observation.ts#extractProgressEmission が emission ごと捨てる（verify-progress#PX-22）。
  taskId?: string;
  state: ProgressState;
  activity?: string;
  blocker?: string;
  evidence?: string[];
  next?: string;
}

export interface EventEnvelope {
  backendId: BackendId;
  conversationId: string;
  generation: number;
  seq: number;
  timestamp: number;
  // 詳細ログのカード配置は work だけで決める（verify-detail-cards#C-1b）。保存される event に載せるので、再生も live と同じ配置になる。
  work?: WorkEventInfo;
  provenance?: EventProvenance;
}

export type NormalizedEvent = EventEnvelope & NormalizedEventBody;

export interface ModelRefusalFallback {
  originalModel: string;
  fallbackModel: string;
  category: string | null;
  explanation: string | null;
  scope: "session" | "local";
  turnId: string | null;
  refusedUserMessageUuid: string | null;
  message: string;
  // R-GW-09: set only by the Host on live session-scope fallbacks (src/conversation-lifecycle.ts#noteFallbackRevert).
  autoRevert?: FallbackAutoRevertStart;
}

export const FALLBACK_AUTO_REVERT_STARTS = ["pending", "off"] as const;
export type FallbackAutoRevertStart = (typeof FALLBACK_AUTO_REVERT_STARTS)[number];
export const FALLBACK_REVERT_OUTCOMES = ["applied", "deferred", "failed", "chosen"] as const;
export type FallbackRevertOutcome = (typeof FALLBACK_REVERT_OUTCOMES)[number];

export function sameModel(a: string | null | undefined, b: string | null | undefined, models: readonly ModelInfo[] = []): boolean {
  if (!a || !b) return false;
  const resolved = (id: string): string => models.find(row => row.id === id)?.resolvedModel ?? id;
  return resolved(a) === resolved(b);
}

// Returns the same object when nothing changes: src/webview/tab.ts#Tab.handleEvent refreshes the chrome only on a new state (verify-refusal#RF-MSAME).
export function applyFallbackModel(state: ModelFallbackState | undefined, model: string | null | undefined,
  at: number, models: readonly ModelInfo[] = []): ModelFallbackState | undefined {
  if (!state || !model) return state;
  if (state.resolvedAt === undefined && sameModel(model, fallbackOriginalModel(state), models)) {
    return { ...state, appliedModel: model, resolvedAt: at };
  }
  // R-GW-09: a resolved fallback re-opens when the session is observed on the fallback model again (verify-refusal#RF-MREOPEN1).
  if (state.resolvedAt !== undefined && sameModel(model, state.notice.fallbackModel, models) &&
    !sameModel(model, state.appliedModel, models)) {
    const { resolvedAt: _resolvedAt, autoRevert: _autoRevert, ...open } = state;
    return { ...open, appliedModel: model, reopenedAt: at };
  }
  return model === state.appliedModel ? state : { ...state, appliedModel: model };
}

export function resolveFallbackByChoice(state: ModelFallbackState | undefined, model: string | null | undefined,
  at: number): ModelFallbackState | undefined {
  if (!state) return state;
  return { ...state, appliedModel: model || state.appliedModel, resolvedAt: state.resolvedAt ?? at };
}

// R-GW-09: the model the turn started with; a later fallback in the same turn starts from the previous fallback model.
export function fallbackOriginalModel(state: ModelFallbackState): string {
  return state.turnOriginalModel ?? state.notice.originalModel;
}

// The model a notice's status line names: the restore target while the notice is the current state (verify-refusal#RF-MCOALESCE3).
export function fallbackNoticeOriginal(state: ModelFallbackState | undefined,
  notice: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): string {
  return state !== undefined && state.notice === notice ? fallbackOriginalModel(state) : notice.originalModel;
}

export function foldModelFallback(state: ModelFallbackState | undefined, event: NormalizedEvent,
  models: readonly ModelInfo[] = []): ModelFallbackState | undefined {
  if (event.kind === "model_refusal_fallback" && event.scope === "session") {
    // R-GW-09: same coalescing rule as src/conversation-lifecycle.ts#noteFallbackRevert (verify-refusal#RF-MCOALESCE).
    const coalesced = state !== undefined && state.resolvedAt === undefined && state.notice.turnId === event.turnId;
    return { notice: event, appliedModel: event.fallbackModel, ...(event.autoRevert ? { autoRevert: event.autoRevert } : {}),
      ...(coalesced ? { turnOriginalModel: fallbackOriginalModel(state) } : {}) };
  }
  if (event.kind === "model_fallback_revert") {
    if (!state || state.notice.turnId !== event.turnId) return state;
    if (event.outcome === "failed") return { ...state, autoRevert: event.outcome };
    const resolved = resolveFallbackByChoice(state, event.outcome === "chosen" ? undefined : event.originalModel, event.timestamp)!;
    return { ...resolved, autoRevert: event.outcome };
  }
  if (event.kind === "model_observed") return applyFallbackModel(state, event.model, event.timestamp, models);
  if (event.kind === "auth_status") return applyFallbackModel(state, event.auth.model, event.timestamp, models);
  return state;
}

// R-CNV-43 (verify-refusal#RF-MREVERT1)
export function fallbackNeedsConfirmation(state: ModelFallbackState): boolean {
  return state.autoRevert !== "pending" && state.autoRevert !== "applied" && state.autoRevert !== "deferred";
}

// R-GW-07 (verify-refusal#RF-MREVERT2)
export function fallbackChipWarning(state: ModelFallbackState | undefined, modelOverride: string | null | undefined,
  models: readonly ModelInfo[]): boolean {
  if (state === undefined || state.resolvedAt !== undefined) return false;
  const requested = modelOverride === null
    ? models.find(row => row.id === "default")?.resolvedModel
    : modelOverride ?? fallbackOriginalModel(state);
  return !sameModel(state.appliedModel, requested, models);
}

export interface ModelFallbackState {
  notice: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>;
  appliedModel: string;
  resolvedAt?: number;
  reopenedAt?: number;
  turnOriginalModel?: string;
  autoRevert?: FallbackAutoRevertStart | FallbackRevertOutcome;
}

// 欠けた時刻を実時計で補わない: replay が決定的でなくなり、live と history で segment の区切りが食い違う（verify-stage1-public#S1-A4mut）。
// 欠けた event は src/event-fold.ts#foldEventState が破棄する。時刻を一度も観測していない間は閉じる区切りが無いので gate しない。
export const TIMESTAMP_REQUIRED_KINDS: readonly string[] = [
  "turn_started",
  "turn_completed",
  "turn_interrupted",
  "turn_failed",
  "tool_call_started",
  "tool_call_finished",
];

export function requiresTimestamp(kind: string): boolean {
  return TIMESTAMP_REQUIRED_KINDS.includes(kind);
}

export type NormalizedEventBody =
  (
    | { kind: "conversation_opened"; cwd: string; model?: string }
    | { kind: "conversation_closed"; reason: string }
    // cliInserted: CLI が書いた isMeta の user レコードで開いたターン。本文を user_message にすると利用者の発言として集計・タイトルへ入る。
    | { kind: "turn_started"; turnId: string; cliInserted?: true }
    | { kind: "auto_resume"; state: "pending"; at: number }
    | { kind: "auto_resume"; state: "cancelled" | "fired" | "exhausted" }
    | { kind: "turn_completed"; turnId: string; usage?: UsageSnapshot }
    | { kind: "turn_interrupted"; turnId: string }
    | {
        kind: "turn_failed";
        turnId: string;
        reason: string;
        errorKind?: "usage_limit";
        // epoch ms
        resetsAt?: number | null;
        detail?: string;
      }
    | {
        kind: "api_retry";
        turnId: string | null;
        attempt: number;
        maxRetries: number;
        retryDelayMs: number;
        errorStatus?: number;
        // SDK の SDKAssistantMessageError。HTTP 応答の無いリトライでも入る。
        errorType?: string;
      }
    | { kind: "assistant_text_delta"; turnId: string; text: string }
    // 直前に流した assistant 本文の wire uuid。SDK の assistant フレームは本文の完結後に届くので、assistant_text_delta には載せられない。
    // live だけが出す: 撤回された本文は CLI が転記録から消すので history には無い。
    | { kind: "assistant_message_uuid"; turnId: string; uuid: string }
    // R-DSP-26: 置き換え側フレームの supersedes とターン末の retracted_message_uuids が同じ uuid を名乗りうる（sdk.d.ts）。
    // 消費側は同じ uuid の再到着と未知の uuid を何もせずに受ける。
    | { kind: "assistant_retracted"; turnId: string | null; uuids: string[] }
    | ({ kind: "model_refusal_fallback" } & ModelRefusalFallback)
    // R-GW-09: recorded by src/conversation-lifecycle.ts#settleFallbackRevert and src/conversation-lifecycle.ts#applyModelChange; the CLI transcript never contains it.
    | { kind: "model_fallback_revert"; turnId: string | null; originalModel: string; outcome: FallbackRevertOutcome }
    | {
        kind: "user_message";
        turnId: string | null;
        text: string;
        images?: ImageAttachment[];
        imageRefs?: ImageRefInfo[];
        // R-CNV-16: Host が送信を観測した時刻。envelope の timestamp は継承された順序用の時刻なので代用しない。
        // timestamp と名付けると EventEnvelope の spread で上書きされる。
        sentAt?: number;
      }
    // recordedAt（R-CNV-15 / R-CNV-16）: timestamp と名付けると EventEnvelope の spread で上書きされる。
    // meta.timestamp で運ぶと lastEventTimestamp が過去へ巻き戻る。
    | {
        kind: "replayed_message";
        role: "user" | "assistant";
        text: string;
        uuid?: string;
        imageRefs?: ImageRefInfo[];
        model?: string;
        recordedAt?: number;
        sentAt?: number;
      }
    | {
        kind: "tool_call_started";
        turnId: string;
        toolUseId: string;
        parentToolUseId: string | null;
        toolName: string;
        inputPreview: string;
        // inputSummary は Host が切り詰め前の入力から summarizeToolInput で作る。無いときだけ src/webview/format.ts#toolSummary が
        // 切り詰め済みの inputPreview を JSON.parse して作り直し、読めなければ生 JSON の断片を出す。
        inputSummary?: string;
        intentInput?: ToolIntentInput;
        isBackground?: boolean;
        // 起動時の宣言値。実際のモデルは後続の subagent_info が持つ。
        subagentType?: string;
        subagentModel?: string;
        subagentEffort?: string;
        delegation?: DelegationInfo;
        taskIntentStructured?: TaskIntent;
        artifacts?: ProjectedArtifactAccess[];
        effectCoverage?: EffectCoverage;
        // src/tool-observation.ts#extractProgressEmission だけが書く。inputPreview から作らない。
        progressEmission?: ProgressEmission;
      }
    // 最初の sidechain assistant の message.model。起動時の宣言値ではモデルが分からないので、観測値でカード表示を上書きする。
    // SDKAssistantMessage に effort は無いので effort は運ばない。hooks 入力の effort は src/claudeHost.ts#ClaudeConversation.observeAgentSettings が
    // オーケストレーション有効時だけ観測し、この event へは載せない。
    | { kind: "subagent_info"; turnId: string | null; toolUseId: string; model?: string; agentId?: string }
    // root message.model の観測。直前に出した model と同じなら出さない。session scope のフォールバックは
    // src/claude-normalizer.ts#ClaudeLiveNormalizer.handleRefusalNotice が出さずに直前の model を進め、
    // src/claude-normalizer.ts#ClaudeLiveNormalizer.rearmRootModelObservation の後は同じ model でも出す
    // （verify-refusal#RF-RETURN・verify-gateway-wiring#GW-RF14）。表示と foldModelFallback が読み、
    // その状態は src/conversation-lifecycle.ts#launchModel が使う。
    | { kind: "model_observed"; turnId: string | null; model: string }
    // turn 境界として扱わない。priorGeneration は src/session-transcript.ts#readSessionHistory だけが立て、
    // 会話面から外すのは src/conv-renderable.ts#isConvRenderableEvent だけ（R-HND-13）。
    | { kind: "compact_boundary"; trigger: "auto" | "manual"; preTokens?: number; priorGeneration?: true }
    | {
        kind: "tool_call_finished";
        turnId: string;
        toolUseId: string;
        isError: boolean;
        resultPreview: string;
        // 以下は切り詰め前の結果から src/tool-observation.ts#extractResumeSignals と src/tool-observation.ts#parseTaskNotification が作る。
        // resultPreview は切り詰め済みなので抽出元にしない。
        asyncLaunchedAgentId?: string;
        // resume はここでだけ確定する。tool_use の開始で確定すると、失敗した SendMessage でも再開扱いになる。
        resumedAgentId?: string;
        // 起動 ACK の id。ACK は完了ではなく、完了は taskNotification で受ける。
        backgroundTaskId?: string;
        // 対応する tool_result が無いので、この event の toolUseId は合成 ID（src/claude-normalizer.ts#ClaudeLiveNormalizer.emitTaskNotification）。
        taskNotification?: TaskNotificationInfo;
      }
    | {
        kind: "approval_request";
        turnId: string | null;
        requestId: string;
        toolName: string;
        // 要約だけで許可させないため、SDK の文脈まで含む全文を運ぶ。
        rawInputJson: string;
        // rawInputJson は文脈を連結した表示文で JSON として読めない。入力の構造を読むのは inputJson。
        inputJson?: string;
        inputSummary?: string;
        expiresAt: number | null;
        questions?: AskUserQuestionSpec;
      }
    | {
        kind: "approval_resolved";
        requestId: string;
        behavior: "allow" | "deny";
        resolvedBy: string;
        // replay で回答を再現できるよう event に残す。
        answers?: Record<string, string>;
      }
    | { kind: "permission_denied"; turnId: string | null; toolName: string; reason: string }
    | { kind: "usage_update"; scope: "turn" | "conversation"; turnId: string | null; usage: UsageSnapshot }
    // root message ごとに 1 回。assistant record の usage.output_tokens は message_start の仮値なので、live は message_delta の usage を使う。
    // subagent の message は live で取れないものがあるので、両経路とも出さない。消費側は isGuardrailOnlyEventKind で gate する（verify-guardrail-recordings#GR-34）。
    | {
        kind: "assistant_usage";
        turnId: string;
        messageId: string;
        // null 固定の型が subagent の usage を出さない不変条件を表す。string へ広げると live と history で件数がずれる。
        parentToolUseId: null;
        usage: AssistantUsage;
      }
    | {
        kind: "context_usage";
        percentage: number;
        totalTokens: number;
        maxTokens: number;
        autoCompactThreshold?: number;
        isAutoCompactEnabled: boolean;
      }
    | { kind: "auth_status"; auth: AuthStatus }
    | { kind: "commands_changed"; commands: SlashCommandInfo[] }
    // SDKBackgroundTasksChangedMessage は生きている集合の全量（sdk.d.ts）。受信側は集合ごと置き換え、開始と終了を対にして数えない。
    | {
        kind: "background_tasks";
        // ambient は CLI の housekeeping（sdk.d.ts）。実行中の表示に数えない。
        tasks: Array<{ id: string; type: string; description: string; ambient?: true }>;
      }
    | {
        kind: "error";
        message: string;
        fatal: boolean;
      }
    | {
        kind: "rate_limit";
        status: string;
        rateLimitType: string;
        utilization: number;
        resetsAt: number | null;
        isUsingOverage: boolean;
        overageInUse?: boolean;
      }
  );

export const GUARDRAIL_ONLY_EVENT_KINDS: ReadonlySet<NormalizedEventBody["kind"]> = new Set(["assistant_usage"]);

export function isGuardrailOnlyEventKind(kind: NormalizedEventBody["kind"]): boolean {
  return GUARDRAIL_ONLY_EVENT_KINDS.has(kind);
}

// AskUserQuestion ツールの質問構造（機能B）。SDK の AskUserQuestionInput（sdk-tools.d.ts）に対応。
// answers の形式は同ファイルの AskUserQuestionInput.answers（sdk-tools.d.ts:2395、canUseTool の
// updatedInput へ注入する側のメンバー）: { [question: string]: string }
// （質問文をキーに、選択ラベルまたは自由入力を値とする。multiSelect はカンマ区切り）に合わせる。
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}
export interface AskUserQuestionSpec {
  questions: AskUserQuestionItem[];
}

export interface AssistantUsage {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

// live と history の両経路がこれを通す（verify-guardrail-recordings#GR-35）。欠けた値を 0 で埋めない。
export function assistantUsageFromRaw(raw: unknown, includeOutput: boolean): AssistantUsage {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = (key: string): number | undefined =>
    typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : undefined;
  const out: AssistantUsage = {};
  const input = pick("input_tokens");
  const creation = pick("cache_creation_input_tokens");
  const read = pick("cache_read_input_tokens");
  const output = includeOutput ? pick("output_tokens") : undefined;
  if (input !== undefined) out.inputTokens = input;
  if (creation !== undefined) out.cacheCreationInputTokens = creation;
  if (read !== undefined) out.cacheReadInputTokens = read;
  if (output !== undefined) out.outputTokens = output;
  return out;
}

// 取れない値を 0 にしない（不明と区別する）。
export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalCostUsd?: number;
  raw?: unknown;
}

export interface RuntimeCapability {
  claudeCodeVersion?: string;
  tools?: string[];
}

export interface AuthStatus {
  provider: BackendId;
  credentialSource: "oauth-subscription" | "api-key" | "cloud" | "helper" | "unknown";
  billingRealm: "subscription" | "api" | "cloud" | "unknown";
  apiKeySource?: string;
  model?: string;
  // Optional runtime observation; absence is not a model-default effort claim.
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  sessionId?: string;
  verifiedAt: number;
  status: "verified" | "pending" | "error";
  detail?: string;
  runtime?: RuntimeCapability;
}

// data は data URL の接頭辞を含まない base64。
export interface ImageAttachment {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
}

export type SessionImageRef =
  | { kind: "record"; uuid: string; index: number }
  | { kind: "event"; generation: number; seq: number; index: number };

export interface ImageRefInfo {
  ref: SessionImageRef;
  mediaType: ImageAttachment["mediaType"];
}

// R-CNV-11: 未送信の添付の実体は Host が持ち、webview は描くだけ。
export interface PendingAttachmentInfo {
  id: string;
  mediaType: ImageAttachment["mediaType"];
  data: string;
}
// src/pending-attachments.ts#PendingAttachmentStore の採番と同じ字面に保つ。
export const ATTACHMENT_ID_RE = /^att-[0-9]+$/;
export const IMAGE_MAX_COUNT = 4;
// /rename の名前の上限。SDK の解決器は JSONL の末尾 64KB しか読まないので、それに収まらない名前は
// 履歴一覧で解決されずタブ名と食い違う（R-SES-05）
export const RENAME_TITLE_MAX = 2000;
export const IMAGE_MAX_BASE64_LEN = 8_000_000;
export const SEND_TEXT_MAX_LEN = 1_000_000;
// src/session-files.ts#lookupSessionFile がこの id をファイル名へ連結する。字面の判定をほかへ複製しない（複製すると片方だけ緩む）。
export const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
// 多重選択で入力欄が読めなくなる量を差し込ませない上限（R-CNV-05）。
export const PICKED_FILE_MAX_COUNT = 20;

// SDK実測: PermissionMode は auto / dontAsk を含む6値（sdk.d.ts:2092）
export type PermissionModeId =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "auto"
  | "dontAsk";
export const PERMISSION_MODES: PermissionModeId[] = [
  "default",
  "auto",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

export interface SlashCommandInfo {
  name: string;
  description: string;
  aliases?: string[];
}

// ターミナルの / ピッカーは CLI 内部の isHidden フラグで候補を絞る（バイナリ内の実装は
// `commands.filter(c => !c.isHidden)`）。しかし SDK 公開型 SlashCommand は name/description/
// argumentHint/aliases しか持たず、isHidden は SDK 境界で捨てられる。init メッセージの
// slash_commands も別基準（`userInvocable !== false`）で作られるため代用にならない
// （CLI 2.1.226 の同一セッション実測: init も supportedCommands() も同じ56件・集合も一致し、
// isHidden 付き6件が両方に含まれたまま。list-commands.ts で再現できる）。
// ⇒ クライアント側から権威データに到達する手段が無いので、以下2段構えで近似する。
//
// (1) KNOWN_HIDDEN_COMMANDS: CLI バイナリから抽出した isHidden 実値。説明文に手がかりが無い
//     ものはこれでしか弾けない（design-consent 等は文面が正規コマンドと区別できない）。
// (2) 命名規約と description の自己申告: CLI 更新で増えた未知の内部コマンドを、リスト更新前でも
//     拾うための保険。
//
// 更新方法（CLI アップグレード時に再抽出する。上記(1)はバージョン固定の実測値なので放置すると腐る）:
//   grep -a -o '.\{0,260\}isHidden:!0' "$(npm root -g)/@anthropic-ai/claude-code/bin/claude.exe" \
//     | grep -o 'name:"[a-zA-Z0-9_-]\{2,40\}"[^}]\{0,240\}isHidden:!0'
// 抽出後は実際のコマンド一覧と突き合わせ、hidden/visible の振り分けが期待通りかを確認する。
//
// 誤検知（正規コマンドを隠す）の実害はサジェストに出ないことだけなので、判定は安全側に倒す。
const KNOWN_HIDDEN_COMMANDS = new Set([
  // CLI 2.1.226 実測。supportedCommands() に現れないもの（pro-trial-expired・rate-limit-options・
  // update）は列挙しても効果が無いため入れていない。
  "__remote-workflow",
  "workflow-launch-exec",
  "design-consent",
  "design-revoke",
  "extra-usage",
  "heapdump",
]);

const INTERNAL_COMMAND_DESC_HINTS = [
  /\bevent sessions? only\b/i,
  /\bserver-launched\b/i,
  /\binternal use only\b/i,
  /\bdo not (?:use|invoke|call)\b/i,
  /^renamed to\b/i,
];

export function isInternalSlashCommand(cmd: SlashCommandInfo): boolean {
  if (KNOWN_HIDDEN_COMMANDS.has(cmd.name)) return true;
  if (cmd.name.startsWith("__")) return true;
  return INTERNAL_COMMAND_DESC_HINTS.some((re) => re.test(cmd.description));
}

// 切り詰め前の入力に対して Host で呼ぶ。inputPreview は切り詰め済みで JSON として読めないことがあり、
// src/webview/format.ts#toolSummary の作り直しは失敗すると生 JSON の断片を出す。要約できなければ null を返し、呼び出し側が代替を選ぶ。
export function summarizeToolInput(toolName: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const baseName = (fp: string): string => {
    const parts = fp.split(/[\\/]/);
    return parts[parts.length - 1] || fp;
  };
  switch (toolName) {
    case "Bash": {
      const desc = str(obj.description);
      if (desc) return desc;
      const cmd = str(obj.command);
      return cmd ? clip(cmd) : null;
    }
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const fp = str(obj.file_path);
      return fp ? baseName(fp) : null;
    }
    case "Grep":
    case "Glob":
      return str(obj.pattern);
    case "Skill":
      return str(obj.skill);
    case "WebFetch":
      return str(obj.url);
    case "WebSearch":
      return str(obj.query);
    case "Agent":
    case "Task": {
      const desc = str(obj.description) ?? str(obj.subject);
      if (desc) return desc;
      const prompt = str(obj.prompt);
      return prompt ? clip(prompt) : null;
    }
    case "TaskUpdate":
      return str(obj.subject) ?? str(obj.status);
    case "ExitPlanMode":
      return l10n.t("Approve the implementation plan");
    default:
      return null;
  }
}

// webview に VS Code の command ID を指名させない。対応は src/gateway-host-actions.ts#runHostActionMessage が持つ。
export const HOST_ACTIONS = ["openSettings", "addClaudeModel"] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

export const API_KEY_POLICIES = ["inherit", "subscriptionOnly"] as const;
export type ApiKeyPolicy = (typeof API_KEY_POLICIES)[number];
export function normalizeApiKeyPolicy(v: unknown): ApiKeyPolicy {
  return v === "subscriptionOnly" ? "subscriptionOnly" : "inherit";
}

export const COMPOSER_SEND_KEYS = ["enter", "shiftEnter"] as const;
export type ComposerSendKey = (typeof COMPOSER_SEND_KEYS)[number];
export function normalizeComposerSendKey(v: unknown): ComposerSendKey {
  return v === "shiftEnter" ? "shiftEnter" : "enter";
}

export const FILE_LINK_BOOLEAN_SETTINGS = ["fileLinkInstruction", "planInstruction", "revealInExplorer", "allowOutsideWorkspace", "confirmOutsideWorkspace", "openOutsideReadOnly"] as const;
export const FILE_LINK_SETTINGS = [...FILE_LINK_BOOLEAN_SETTINGS, "openWithSystemApp"] as const;
export type FileLinkBooleanSetting = (typeof FILE_LINK_BOOLEAN_SETTINGS)[number];
export type FileLinkSetting = (typeof FILE_LINK_SETTINGS)[number];

export const PROFILE_SOURCES = ["official", "artificialAnalysis"] as const;
export type ProfileSource = typeof PROFILE_SOURCES[number];

export function normalizeProfileSources(value: unknown): ProfileSource[] {
  const sources = PROFILE_SOURCES.filter(source => Array.isArray(value) && value.includes(source));
  return sources.length ? sources : [...PROFILE_SOURCES];
}

export function isProfileSources(value: unknown): value is ProfileSource[] {
  return Array.isArray(value) && value.length > 0 && value.length <= PROFILE_SOURCES.length
    && new Set(value).size === value.length && value.every(source => PROFILE_SOURCES.includes(source));
}

// 会話面の WebviewToHost とは受信口が別。requestId は画面が採番し、Host は書込み後の settingsState の replyTo へ写す。
export type SettingsPageToHost =
  | { type: "settingsPageReady" }
  | { type: "recheckExternalExecutors" }
  | { type: "researchModelProfiles"; targets: string[]; purpose?: "effort" }
  | { type: "previewConductorInstruction"; requestId: number; policy: string }
  | { type: "setAccentSetting"; requestId: number; setting: AccentSetting; value: string }
  | { type: "setComposerSendKey"; requestId: number; sendKey: ComposerSendKey }
  | { type: "setApiKeyPolicy"; requestId: number; policy: ApiKeyPolicy }
  | { type: "setAutoContinueAtUsageLimit"; requestId: number; enabled: boolean }
  | { type: "setRestoreTabsOnStartup"; requestId: number; enabled: boolean }
  | { type: "setLearningEnabled"; requestId: number; enabled: boolean }
  | { type: "setProfileSources"; requestId: number; sources: ProfileSource[] }
  | { type: "setOrchestrationSetting"; requestId: number; setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes"; value: unknown }
  | { type: "setFileLinkSetting"; requestId: number; setting: FileLinkBooleanSetting; enabled: boolean }
  | { type: "setFileLinkSetting"; requestId: number; setting: "openWithSystemApp"; value: string[] }
  | { type: "openVsCodeSettings" };

export interface SettingsProfileProjection {
  profileSources?: ProfileSource[];
  researchTargets?: string[];
  researchUnavailable?: string;
  effortUnavailable?: string;
  researchText?: string;
  conductorPreview?: { text: string; tokens: number };
}
export type HostToSettingsPage =
  | { type: "conductorPreview"; requestId: number; text: string; tokens: number }
  // R-DSP-01: 書込みの後も要求値ではなく、構成から読み直した実効値を返す。replyTo は書込み要求への返送だけが持つ。
  | ({ type: "settingsState"; appearance?: AccentSettings; composerSendKey: ComposerSendKey; apiKeyPolicy: ApiKeyPolicy; restoreTabsOnStartup: boolean; autoContinueAtUsageLimit: boolean; learningEnabled: boolean; replyTo?: number }
    & SettingsProfileProjection & Record<FileLinkBooleanSetting, boolean> & { openWithSystemApp: string[] } & { orchestrationEnabled: boolean; orchestrationAgents: OrchestrationSettingRow[]; orchestrationDefaults: OrchestrationSettingRow[]; conductorPolicy: string; conductorPolicyDefault: string; externalTimeoutMinutes: number; externalDetection: Record<ExecutorId, ExternalDetection>; externalModels: ExternalModels });

function isSettingsRequestId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export function isSettingsPageToHost(v: unknown): v is SettingsPageToHost {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  const t = m.type as SettingsPageToHost["type"];
  if (t === "settingsPageReady" || t === "recheckExternalExecutors" || t === "openVsCodeSettings") return hasOnlyKeys(m, ["type"]);
  if (t === "researchModelProfiles") return hasOnlyKeys(m, ["type", "targets", "purpose"]) && isProfileTargetIds(m.targets) && m.targets.length > 0
    && (m.purpose === undefined || m.purpose === "effort");
  if (t === "setProfileSources") return hasOnlyKeys(m, ["type", "requestId", "sources"]) && isSettingsRequestId(m.requestId) && isProfileSources(m.sources);
  if (t === "previewConductorInstruction") return hasOnlyKeys(m, ["type", "requestId", "policy"]) && isSettingsRequestId(m.requestId) && typeof m.policy === "string";
  if (t === "setAccentSetting") {
    return isSettingsRequestId(m.requestId) && isAccentSettingValue(m.setting, m.value) && hasOnlyKeys(m, ["type", "requestId", "setting", "value"]);
  }
  if (t === "setComposerSendKey") {
    return isSettingsRequestId(m.requestId)
      && (COMPOSER_SEND_KEYS as readonly string[]).includes(m.sendKey as string) && hasOnlyKeys(m, ["type", "requestId", "sendKey"]);
  }
  if (t === "setApiKeyPolicy") {
    return isSettingsRequestId(m.requestId)
      && (API_KEY_POLICIES as readonly string[]).includes(m.policy as string) && hasOnlyKeys(m, ["type", "requestId", "policy"]);
  }
  if (t === "setAutoContinueAtUsageLimit" || t === "setRestoreTabsOnStartup" || t === "setLearningEnabled") {
    return isSettingsRequestId(m.requestId) && typeof m.enabled === "boolean" && hasOnlyKeys(m, ["type", "requestId", "enabled"]);
  }
  if (t === "setOrchestrationSetting") {
    return isSettingsRequestId(m.requestId) && ["enabled", "agents", "conductorPolicy", "externalTimeoutMinutes"].includes(m.setting as string)
      && Object.hasOwn(m, "value") && hasOnlyKeys(m, ["type", "requestId", "setting", "value"]);
  }
  if (t === "setFileLinkSetting") {
    return isSettingsRequestId(m.requestId)
      && (m.setting === "openWithSystemApp"
        // R-CNV-20: validate chip writes again at the Host boundary; no workspace target is accepted.
        ? Array.isArray(m.value) && m.value.every((item) => typeof item === "string" && normalizeSystemAppExtension(item) === item)
          && hasOnlyKeys(m, ["type", "requestId", "setting", "value"])
        : (FILE_LINK_BOOLEAN_SETTINGS as readonly string[]).includes(m.setting as string)
          && typeof m.enabled === "boolean" && hasOnlyKeys(m, ["type", "requestId", "setting", "enabled"]));
  }
  t satisfies never;
  return false;
}

function isProfileTargetIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 300 && value.every(id => typeof id === "string" && /^(claude|codex|agy)\/[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(id));
}
function isProfileObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isSettingsProfiles(m: Record<string, unknown>): boolean {
  const preview = m.conductorPreview as Record<string, unknown> | undefined;
  return (m.researchTargets === undefined || isProfileTargetIds(m.researchTargets))
    && (m.researchUnavailable === undefined || typeof m.researchUnavailable === "string")
    && (m.effortUnavailable === undefined || typeof m.effortUnavailable === "string")
    && (m.researchText === undefined || typeof m.researchText === "string")
    && (m.profileSources === undefined || isProfileSources(m.profileSources))
    && (preview === undefined || isProfileObject(preview) && hasOnlyKeys(preview, ["text", "tokens"]) && typeof preview.text === "string" && typeof preview.tokens === "number" && Number.isFinite(preview.tokens));
}

export function isHostToSettingsPage(v: unknown): v is HostToSettingsPage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  const t = m.type as HostToSettingsPage["type"];
  if (t === "conductorPreview") return hasOnlyKeys(m, ["type", "requestId", "text", "tokens"]) && isSettingsRequestId(m.requestId)
    && typeof m.text === "string" && typeof m.tokens === "number" && Number.isFinite(m.tokens);
  if (t === "settingsState") {
    return isSettingsProfiles(m) && (m.appearance === undefined || isAccentSettings(m.appearance))
      && (COMPOSER_SEND_KEYS as readonly string[]).includes(m.composerSendKey as string)
      && (API_KEY_POLICIES as readonly string[]).includes(m.apiKeyPolicy as string)
      && typeof m.restoreTabsOnStartup === "boolean"
      && typeof m.autoContinueAtUsageLimit === "boolean" && typeof m.learningEnabled === "boolean"
      && typeof m.orchestrationEnabled === "boolean" && typeof m.conductorPolicy === "string"
      && typeof m.conductorPolicyDefault === "string"
      && isOrchestrationSettingRoster(m.orchestrationAgents) && isOrchestrationSettingRoster(m.orchestrationDefaults)
      && isExternalTimeout(m.externalTimeoutMinutes) && isExternalDetection(m.externalDetection) && isExternalModels(m.externalModels)
      && FILE_LINK_BOOLEAN_SETTINGS.every((key) => typeof m[key] === "boolean")
      && Array.isArray(m.openWithSystemApp) && m.openWithSystemApp.every((item) => typeof item === "string")
      && (m.replyTo === undefined || isSettingsRequestId(m.replyTo))
      && hasOnlyKeys(m, ["type", "appearance", "composerSendKey", "apiKeyPolicy", "restoreTabsOnStartup", "autoContinueAtUsageLimit", "learningEnabled", ...FILE_LINK_SETTINGS, "orchestrationEnabled", "orchestrationAgents", "orchestrationDefaults", "conductorPolicy", "conductorPolicyDefault", "externalTimeoutMinutes", "externalDetection", "externalModels", "replyTo", "profileSources", "researchTargets", "researchUnavailable", "effortUnavailable", "researchText", "conductorPreview"]);
  }
  t satisfies never;
  return false;
}

// tabId は Host が採番して init と tabCreated で渡す。
export type WebviewToHost =
  | { type: "ready"; cursor: { generation: number; seq: number } | null }
  // R-CNV-11: images は Host が添付スロットから詰める欄で、isWebviewToHost は images を持つ send を捨てる。
  | { type: "send"; tabId: string; text: string; clientToken?: string; images?: ImageAttachment[] }
  // 受理しなくても Host は attachments で返す（src/composer-io.ts#handleComposerMessage）。
  | { type: "attachImage"; tabId: string; mediaType: ImageAttachment["mediaType"]; data: string }
  | { type: "removeAttachment"; tabId: string; attachmentId: string }
  | { type: "startHandoff"; tabId: string }
  | { type: "cancelHandoff"; tabId: string; runId: string }
  // part は 0 起算で、順に要求する。
  | { type: "getHandoffDetail"; tabId: string; runId: string; part: number }
  | { type: "openHandoffSource"; tabId: string; sourceSessionId: string }
  | { type: "interrupt"; tabId: string }
  | { type: "cancelAutoResume"; tabId: string }
  | {
      type: "approvalDecision";
      tabId: string;
      requestId: string;
      behavior: "allow" | "deny";
      // 形式は SDK の AskUserQuestionInput.answers。deny では読まない。
      answers?: Record<string, string>;
    }
  | { type: "newTab" }
  | { type: "closeTab"; tabId: string }
  | { type: "clearTab"; tabId: string }
  | { type: "setMode"; tabId: string; mode: PermissionModeId }
  | { type: "setModel"; tabId: string; model: string | null; sessionOnly?: boolean }
  | { type: "setEffort"; tabId: string; effort: string | null }
  | { type: "queryFiles"; reqId: number; query: string }
  // imageSlots は画像として添付できる残り枚数。超えた分と画像でないものは Host がパスとして返す（src/composer-io.ts#pickComposerFiles）。
  | { type: "pickFiles"; reqId: number; imageSlots: number }
  | { type: "openFile"; tabId: string; target: string }
  | { type: "exportTab"; tabId: string }
  // R-SES-05: Host が記録へ custom-title を書き、タブ名と履歴一覧を同じ解決器で揃える。
  | { type: "renameTab"; tabId: string; title: string }
  | { type: "listSessions"; source?: "laisora" | "claude"; cursor?: string }
  // ファイルパスは webview から受け取らず、Host が解決する（src/session-files.ts#lookupSessionFile）。
  | { type: "analyzeCurrent"; tabId: string }
  // R-DSP-25: 要約のモデルは Host が決める。webview はモデルを送らない。
  | { type: "summarizeSession"; tabId: string }
  | { type: "suggestSessionName"; tabId: string }
  | { type: "openThemePicker" }
  | { type: "runHostAction"; action: "openSettings" }
  | { type: "runHostAction"; action: "addClaudeModel"; tabId: string }
  | { type: "requestCachedUsage" }
  | {
      type: "agentInspectorRequest";
      tabId: string;
      agentId: string;
      section: AgentInspectorSection;
      requestId: string;
      // Host が発行した不透明な token だけを往復する。パス・読み位置・件数は webview から受け取らない。
      cursor?: string;
    }
  // cursor は Host 発行の不透明な token、anchor は Host が既に渡した generation と seq で初回だけ使う。
  // パス・読み位置・件数は受け取らない（agentInspectorRequest と同じ規則）。
  | {
      type: "historyChunkRequest";
      tabId: string;
      requestId: string;
      cursor?: string;
      anchor?: { generation: number; seq: number };
    }
  // R-TAB-07。cursor と anchor は historyChunkRequest と同じ語彙で、どちらも無い要求も受ける。
  | {
      type: "worklogTranscriptRequest";
      tabId: string;
      requestId: string;
      cursor?: string;
      anchor?: { generation: number; seq: number };
    }
  // 表示専用: Host は transcript を読むだけで、読んだものを pushEvent へ入れない。初回は cursor 無しで送る。
  // anchorUuid は Host が既に渡した識別子で、cursor が Host 側で無効になったときの起点。無いと遡りの位置が黙って巻き戻る。
  | {
      type: "conversationHistoryRequest";
      tabId: string;
      requestId: string;
      cursor?: string;
      anchorUuid?: string;
    }
  | {
      type: "sessionImageRequest";
      tabId: string;
      requestId: string;
      ref: SessionImageRef;
    }
  | {
      type: "openSessionImage";
      tabId: string;
      ref?: SessionImageRef;
      inline?: { mediaType: ImageAttachment["mediaType"]; data: string };
    }
  | {
      type: "artifact/preview";
      lang: "html" | "svg";
      content: string;
      artifactId?: string;
    }
  // tabId 以外を受け取らない: 課金される呼び出しのパラメータと起動可否は Host が決める。
  | { type: "llmAnalysisRequest"; tabId: string }
  | { type: "setLlmAnalysisEnabled"; enabled: boolean }
  | {
      type: "startFindingSession";
      tabId: string;
      findingId: string;
      analysisRunId: string;
      semanticHash: string;
    }
  | {
      type: "prepareHistoricalDraft";
      tabId: string;
      artifactId: string;
      findingId: string;
    }
  | {
      type: "selectAnalysisArtifact";
      tabId: string;
      artifactId: string;
    }
  // first-paint の時刻は document age（performance.now）で、現在時刻を載せない。
  // orphan-turn-adopted の message は tabId と turnId だけで、本文を載せない（verify-detail-cards#OA-1）。
  | {
      type: "webviewDiagnostic";
      kind: "error" | "ready-retry" | "first-paint" | "orphan-turn-adopted";
      message: string;
    }
  // intoTabId は候補に過ぎず、使えるかは Host が src/session.ts#isUnusedSession で判定し直す。
  | { type: "resumeSession"; sessionId: string; filePath: string; intoTabId?: string }
  // live の Session を作り直さず、表示の hydration だけを再試行する。
  | { type: "resumeHydrationRetry"; tabId: string }
  // 復帰の init は ready を待たずに送るので、見ているタブを先に積むため Host が面ごとに覚える（src/store-surfaces.ts#SessionStore.restoreVisible）。
  | { type: "activeTab"; tabId: string };

export interface SessionListItem {
  originUnverified?: boolean;
  sessionId: string;
  filePath: string;
  title: string;
  cwd: string;
  mtime: number;
}

// 1 つの真偽値へ畳まない: どの段で欠けたかを画面から判別できなくなる。
// resolveFailed は getSessionInfo が例外を投げた件数だけで、要約を持たない候補は数えない。
export interface SessionScanDegradation {
  rootFailed: boolean;
  unreadableProjects: number;
  statFailed: number;
  resolveFailed: number;
  // getSessionInfo は壊れた記録に例外を投げず undefined を返すことがあり、resolveFailed は増えない。
  // これが無いと、出せなかった一覧を「見つからない」と断言する。
  unresolvedCandidates: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  olderVersion?: boolean;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

// WorkModelPayload は WorkModelState をそのまま流さない: toolPlacements は大きな内部索引で、segments は詳細カードが持つ。
// WORK_MODEL_VERSION は payload の形の版で、PROTOCOL_VERSION とは別に上げる。
export const WORK_MODEL_VERSION = 3;

// projectWorkModel と isWorkAgentNode が同じ上限を使う。ガード側だけに置くと、深い木を復元した payload が丸ごと捨てられる。
const AGENT_TREE_MAX_DEPTH = 16;

export const OPERATION_KIND_LIST: OperationKind[] = [
  "observe",
  "mutate",
  "verify",
  "delegated",
  "neutral",
  "unknown",
];

export type WorkAgentOrigin = "live" | "restored";

export interface WorkAgentNode {
  runStartedAt?: number;
  intentInput?: ToolIntentInput;
  agentId: string;
  // transcript 上の id が分かっても agentId を置き換えない。agentId は経路によらない合成 ID で、live と history の同値比較の鍵になる。
  transcriptAgentId?: string;
  parentAgentId: string | null;
  toolUseId: string;
  // 外すと親の tool 行を DOM から推定し直すことになる。
  parentToolUseId: string | null;
  spawnDepth: number;
  agentType?: string;
  description: string;
  modelDeclared?: string;
  modelMeasured?: string;
  effortDeclared?: string;
  effortMeasured?: string;
  status: WorkStatus;
  startedAt?: number;
  endedAt?: number;
  elapsedMs: number;
  tokens?: number;
  childCount: number;
  failCount: number;
  revision: number;
  origin: WorkAgentOrigin;
  children: WorkAgentNode[];
}

export type AgentInspectorSection = "overview" | "tools" | "messages" | "report";

export type AgentInspectorTruncatedReason =
  | "read-limit"
  | "record-limit"
  | "malformed-record"
  | "meta-limit"
  | "preview-limit"
  | "response-limit";

export interface AgentInspectorCoverage {
  state: "complete" | "partial";
  returnedRecords: number;
  bytesRead: number;
  fileSize: number;
  malformedRecordCount: number;
  skippedRecordCount: number;
  previewTruncatedCount?: number;
  truncatedReasons: AgentInspectorTruncatedReason[];
}

export interface AgentInspectorOverview {
  agentType?: string;
  description: string;
  instruction: string;
  modelMeasured?: string;
  effortMeasured?: string;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
  spawnedWithWorktree?: boolean;
  worktreeBranch?: string;
}

export interface AgentInspectorToolItem {
  toolUseId: string;
  toolName: string;
  timestamp?: number;
  inputSummary?: string;
  inputPreview: string;
  isError?: boolean;
  resultPreview?: string;
}

export interface AgentInspectorMessageItem {
  role: "user" | "assistant";
  timestamp?: number;
  text: string;
}

interface AgentInspectorPageBase {
  coverage: AgentInspectorCoverage;
  nextCursor?: string;
}

export type AgentInspectorPage =
  | (AgentInspectorPageBase & { section: "overview"; overview: AgentInspectorOverview })
  | (AgentInspectorPageBase & { section: "tools"; tools: AgentInspectorToolItem[] })
  | (AgentInspectorPageBase & { section: "messages"; messages: AgentInspectorMessageItem[] })
  | (AgentInspectorPageBase & { section: "report"; text: string });

export type AgentInspectorErrorReason =
  // 記録がまだ書き出されていない。待てば出る。
  | "session-unavailable"
  // R-DSP-01: 保存先の走査が失敗し、記録の有無を確かめられなかった。待っても直らないので、session-unavailable や read-failed へ畳まない。
  | "session-scan-failed"
  | "agent-unavailable"
  | "transcript-unavailable"
  | "invalid-cursor"
  | "stale-request"
  | "read-failed"
  | "response-too-large"
  | "meta-limit";

// src/history-window.ts#HistoryChunkCoverage と構造を合わせる。一致は src/history-serving.ts の代入で tsc が見るが、
// 非リテラル代入に余剰プロパティ検査は掛からないので、あちらへ足したフィールドはここへ来ないまま webview へ届かない。
export interface HistoryChunkCoveragePayload {
  returnedCount: number;
  remainingOlderCount: number;
  oldestReached: boolean;
  snapExtendedBy: number;
}

export interface HistoryChunkPagePayload {
  items: NormalizedEvent[];
  nextCursor?: string;
  hasMore: boolean;
  coverage: HistoryChunkCoveragePayload;
}

// src/history-window.ts#HistoryWindowErrorReason を含む。あちらへ足すと src/history-serving.ts の代入が落ちるが、減らしても落ちないので、
// 減らすときはここと isHostToWebview の許可を手で消す。
// R-CNV-01: response-too-large を加えない。大きなイベントは src/history-chunk-fit.ts#fitEventForTransport が切り詰めて送るので、
// この経路はサイズで失敗しない。加えると再開できない行き止まりが戻る。
export type HistoryChunkErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "ambiguous-identity"
  | "invalid-request"
  | "stale-request"
  | "host-error";

// src/conversation-history.ts#ConversationMessage と構造を合わせる。uuid は重複挿入の判定に使い、持たないレコードは運ばない。
export interface ConversationHistoryMessagePayload {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  imageRefs?: ImageRefInfo[];
  model?: string;
}

export interface ConversationHistoryPagePayload {
  items: ConversationHistoryMessagePayload[];
  nextCursor?: string;
  hasMore: boolean;
  coverage: {
    returnedCount: number;
    remainingOlderCount: number;
    oldestReached: boolean;
    // R-DSP-03: page ごとではなく transcript 全体の値。運ばないと、会話が欠けたまま読み終わった表示になる。
    malformedLineCount?: number;
    droppedWithoutUuidCount?: number;
  };
}

export type ConversationHistoryErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "invalid-request"
  // 記録が無い。遡る対象が無いので終端として扱う。
  | "session-unavailable"
  // R-CNV-02: 走査が失敗し、記録の有無を確かめられなかった。終端ではなく一過性の失敗として扱い、session-unavailable と同一視しない。
  | "session-scan-failed"
  | "read-failed"
  | "stale-request"
  | "response-too-large"
  | "host-error";

// CLI の subagent meta.json には effort と時刻が無いので、それらは同名 transcript の先頭と末尾から採る。
export interface RestoredAgent {
  agentId: string;
  parentAgentId: string | null;
  toolUseId: string;
  spawnDepth: number;
  agentType?: string;
  description: string;
  modelDeclared?: string;
  modelMeasured?: string;
  effortMeasured?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkPhaseView extends WorkTotals {
  phaseId: string;
  kind: "phase" | "rollup";
  taskKey?: string;
  occurrence?: number;
  operation: PhaseOperation;
  title: string;
  // 件数の上限は reducer 側の src/work-model.ts#MAX_PHASE_REFS が保つ。
  segmentIds: string[];
  segmentCount: number;
  turnIds: string[];
  turnCount: number;
  lastTurnId?: string;
  startedAt: number;
  endedAt?: number;
  isCurrent: boolean;
  // 判定は src/work-model.ts#phaseStateOf だけが行い、renderer は描くだけ。
  state: WorkPhaseState;
  compactedPhaseCount?: number;
  agents: WorkAgentNode[];
}

export interface WorkPlacementView {
  // rollup へ併合済みの配置は固定の phaseId を持つ（projectWorkEvent が src/work-model.ts#PhaseRef から写す）。
  phaseId: string;
  segmentId?: string;
  taskKey?: string;
  // agent の子ツールは false。agent を 1 件として数え、二重に数えない。
  counted: boolean;
  ownerToolUseId?: string;
}

export interface WorkSegmentView {
  segmentId: string;
  phaseId: string;
  taskKey?: string;
  toolCount: number;
  failCount: number;
  childFailCount: number;
  elapsedMs: number;
  runningCount: number;
  staleCount: number;
  revision: number;
}

export interface WorkAgentStateView {
  runStartedAt?: number;
  toolUseId: string;
  status: WorkStatus;
  childCount: number;
  failCount: number;
  elapsedMs: number;
  tokens?: number;
  modelMeasured?: string;
  revision: number;
}

export interface WorkTaskTotalsView {
  taskKey: string;
  toolCount: number;
  failCount: number;
  childFailCount: number;
  elapsedMs: number;
  agentTokens: number;
}

export interface WorkTaskItemView {
  taskKey: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
}

export interface WorkEventInfo {
  revision: number;
  // 変わったときだけ載り、閉じたら null。null を送らないと、ツールを使わないターンで前のカードを現在の作業として出し続ける。
  currentSegmentId?: string | null;
  // tool_call_started だけに付く。付かないものは reducer が記帳系として扱った（projectWorkEvent）。
  placement?: WorkPlacementView;
  // 変わった分だけ載る。webview は届いた分を上書きし、差分を計算しない。
  segments?: WorkSegmentView[];
  agents?: WorkAgentStateView[];
  taskTotals?: WorkTaskTotalsView[];
  // 変わったときに全量を載せる。webview は集合ごと置き換える。
  tasks?: WorkTaskItemView[];
  staled?: string[];
  pendingApprovalCount?: number;
  turnToolCount?: number;
}

export interface PlanContext {
  blockId: string; start: number; end: number; text: string; running: boolean;
}

export interface WorkModelPayload {
  requests?: import("./work-model").WorkRequestTotals[];
  planDeclaration?: { goal: string; at: number };
  planBoundaryAt?: number;
  planHistory?: import("./work-model").PlanHistoryEntry[];
  planHistoryTruncated?: boolean;
  planHistoryLostThrough?: number;
  planContext?: PlanContext;
  planTools?: Array<{ id: string; name: string; description: string; startedAt: number; intentInput?: ToolIntentInput }>;
  // R-SES-11: open foreground calls, including Agent/Task starts outside the replay window.
  runningMainTools?: Array<{ id: string; name: string; startedAt: number; intentInput?: ToolIntentInput }>;
  version: number;
  revision: number;
  coverage: WorkCoverage;
  currentPhaseId?: string;
  ambiguity?: "multiple-active-tasks";
  phases: WorkPhaseView[];
  // 親を特定できない、または AGENT_TREE_MAX_DEPTH を超えたサブエージェント。推測した親へ付けない。
  unlinkedAgents: WorkAgentNode[];
  // WorkEventInfo の tasks は変わったときにしか載らないので、再生窓から Task 更新が落ちた snapshot ではこれが唯一の復元元（verify-detail-cards#C-13）。
  tasks: WorkTaskItemView[];
  taskTotals: WorkTaskTotalsView[];
}

// canonical path を webview へ出さない。canonicalPath?: never は、未射影の HostArtifactAccess が構造的部分型として素通りするのを tsc で塞ぐ。
export type SemanticArtifactView = ProjectedArtifactAccess & { canonicalPath?: never };

export type SemanticAttemptNodeView = Omit<ExecutionAttemptNode, "artifacts"> & {
  artifacts: SemanticArtifactView[];
};

export type SemanticNodeView = Exclude<SemanticNode, ExecutionAttemptNode> | SemanticAttemptNodeView;

// DivergenceRecord の coverage は検出入力の観測度で、record の確からしさではない。これを理由に record を隠さない。
// 表示側が coverage を見て畳まないよう名前を変えて運ぶ。record を出すかは kind 側の state が決める。
export type DivergenceRecordView = Omit<DivergenceRecord, "coverage"> & {
  detectionInputCoverage: Coverage;
};

export type DivergenceKindReportView = Omit<DivergenceKindReport, "records"> & {
  records: DivergenceRecordView[];
};

export type DivergenceReportView = Omit<DivergenceReport, "kinds"> & {
  kinds: Record<DivergenceKind, DivergenceKindReportView>;
};

// L3Report は canonical path 由来の値を持たないので、nodes と違って射影しない。webview は再集計しない。
export interface L3ReportPayload {
  facts?: AnalysisFactsView;
  analysis: L3Report;
  divergences: DivergenceReportView;
  // undefined（未着）と LlmFindingReportView の各 state と、所見 0 件の attached を、それぞれ別の表示にする。
  // 棄却の件数は rejectedCount だけで運び、棄却した所見の中身は LlmFindingDiagnosticsPayload に閉じる。
  llm?: LlmFindingReportView;
}

// src/llm-report.ts#unavailableCode が src/llm-analysis-client.ts#LlmAnalysisUnavailableReason から網羅的に写す。
// string に広げない: 写像漏れを tsc が検出できず、文言の無い理由コードが画面に出る。
export type LlmUnavailableReason =
  | "not_configured"
  | "model_unresolved"
  | "client_error"
  | "timeout"
  | "parse_failed"
  | "internal_error";

export type PersistenceState = "pending" | "saved" | "rejected" | "failed";

export interface AttachedEvidenceChip {
  alias: string;
  kind: "event" | "user" | "metric" | "divergence" | "guardrail" | "file";
  label: string;
  navigateToolUseId?: string;
}

export type FindingAction =
  | { kind: "startCurrentFinding"; label: string }
  | { kind: "prepareHistoricalDraft"; label: string }
  | { kind: "none"; label: string };

export interface AttachedFindingView {
  findingId: string;
  numberLabel: string;
  // Host が 0 埋めして渡す。webview は採番しない（verify-analysis-b5-data#B5-N1）。
  numberDigits?: string;
  title: string;
  observed: string;
  impactLabel: string;
  destinationLabel: string;
  actionKindLabel: string;
  actionLine: string;
  steps: string[];
  target?: string;
  confidence: "high" | "medium" | "low";
  action: FindingAction;
  evidence: AttachedEvidenceChip[];
}

export interface HistoryOption {
  artifactId: string;
  label: string;
  // 選択中の結果の requestedModelLabel / executedModelsLabel と同じ導出（R-ANL-13）。実行 effort は記録に無い
  generatedAtLabel?: string;
  findingsCount?: number;
  requestedModel?: string;
  requestedEffort?: string;
  executedModels?: string;
  freshnessLabel?: string;
}

export interface AttachedAnalysisView {
  artifactId: string;
  freshness: "current" | "stale" | "restored-unverifiable";
  freshnessLabel: string;
  generatedAtLabel: string;
  requestedModelLabel: string;
  executedModelsLabel: string;
  persistence: PersistenceState;
  persistenceLabel: string;
  summaryLabel: string;
  findingsCount?: number;
  rejectedCount?: number;
  modelsLabel?: string;
  // null = 分析の使用量を観測していない（R-DSP-11）
  tokensLabel?: string | null;
  slicesCount?: number;
  emptyStateLabel?: string;
  // Host のメモリにだけ持つ値（src/session.ts#Session.inputCoverageLabelByArtifactId）で、再起動前の artifact には無い。
  inputCoverageLabel?: string;
  historyOptions: HistoryOption[];
  selectedArtifactId: string;
  findings: AttachedFindingView[];
}

export type LlmFindingReportView =
  | { state: "disabled" }
  | { state: "idle" }
  | { state: "running"; attached?: AttachedAnalysisView }
  | { state: "attemptFailed"; reason: LlmUnavailableReason; attached?: AttachedAnalysisView }
  | { state: "attached"; attached: AttachedAnalysisView };

export type AnalysisPanelView = LlmFindingReportView;


// 検証器の内訳はオプトインの診断面に閉じる。SemanticModelPayload から辿れる場所へ移さない。
export type LlmFindingDiagnosticsPayload =
  | { state: "unavailable"; reason: string }
  | {
      state: "completed";
      specVersion: number;
      provenance: LlmAnalysisProvenance;
      cacheState: "hit" | "miss";
      rejected: RejectedFinding[];
      // candidate は LLM が出した数で、検証器へ渡った数ではない。candidate に verified を当てるとスキーマ段の棄却が見えなくなる。
      counts: {
        candidate: number;
        schemaRejected: number;
        schemaByReason: Record<string, number>;
        verified: number;
        accepted: number;
        rejected: number;
        byReason: Record<string, number>;
      };
    };

// version は src/semantic-model.ts#SEMANTIC_MODEL_SPEC_VERSION で、PROTOCOL_VERSION とは別に上げる。
// progress は canonical path を含む Host 専用の値で、投影で落とし、型でも外す。
export interface SemanticModelPayload extends Omit<SemanticModel, "nodes" | "progress"> {
  nodes: SemanticNodeView[];
  // undefined は未着（導出前か失敗）で、指標の unavailable や観測 0 と同一視しない。
  l3?: L3ReportPayload;
  // src/transcript-time-buckets.ts が読めなかったもの。省略は欠落なし。読めなかった記録を 0 本として畳むと、並列していたセッションが直列で描かれる（R-DSP-01）。
  // 任意フィールドにはすべて webview の描き手がある（verify-work-graph#G-COV-4mut）。
  timeBucketsCoverage?: TimeBucketsCoverage;
  // 並びと集計は Host が決め、webview は集計しない（verify-no-declared#VND-S6, verify-no-declared#VND-S6b）。
  roleSummary?: RoleSummaryView;
  failureSummary?: FailureSummaryView;
  summaryAnalysis?: SummaryAnalysisView;
  // null = メインの使用量を 1 件も観測していない（R-DSP-11）
  mainTokens?: MainTokenTotal | null;
}

export interface TimeBucketsCoverage {
  sessionReadError?: string;
  subagentReadError?: string;
  transcriptReadFailureCount?: number;
  omittedTranscriptCount?: number;
  malformedMetaCount?: number;
}

export function isTimeBucketsCoverage(v: unknown): v is TimeBucketsCoverage {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return (
    isOptionalString(c.sessionReadError) &&
    isOptionalString(c.subagentReadError) &&
    (c.transcriptReadFailureCount === undefined || isNumber(c.transcriptReadFailureCount)) &&
    (c.omittedTranscriptCount === undefined || isNumber(c.omittedTranscriptCount)) &&
    (c.malformedMetaCount === undefined || isNumber(c.malformedMetaCount))
  );
}

function taskItemViews(state: WorkModelState): WorkTaskItemView[] {
  return state.tasks.map((task) => ({
    taskKey: task.taskKey,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
  }));
}

function taskTotalsView(phase: {
  taskKey?: string;
  toolCount: number;
  failCount: number;
  childFailCount: number;
  elapsedMs: number;
  agentTokens: number;
}): WorkTaskTotalsView {
  return {
    taskKey: phase.taskKey ?? "",
    toolCount: phase.toolCount,
    failCount: phase.failCount,
    childFailCount: phase.childFailCount,
    elapsedMs: phase.elapsedMs,
    agentTokens: phase.agentTokens,
  };
}

function restoredToNode(agent: RestoredAgent): WorkAgentNode {
  const elapsedMs =
    agent.startedAt !== undefined && agent.endedAt !== undefined
      ? Math.max(0, agent.endedAt - agent.startedAt)
      : 0;
  return {
    agentId: agent.agentId,
    parentAgentId: agent.parentAgentId,
    toolUseId: agent.toolUseId,
    // CLI の meta.json は親の tool_use を持たない。推定で埋めると相関先を捏造する。
    parentToolUseId: null,
    spawnDepth: agent.spawnDepth,
    agentType: agent.agentType,
    description: agent.description,
    modelDeclared: agent.modelDeclared,
    modelMeasured: agent.modelMeasured,
    effortMeasured: agent.effortMeasured,
    status: "unknown",
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    elapsedMs,
    childCount: 0,
    failCount: 0,
    revision: 0,
    origin: "restored",
    children: [],
  };
}

// 循環の辺はどちらも採らない。片側だけ採ると、読んだ順で階層が変わる。
function findCyclicRestoredIds(restoredAgents: readonly RestoredAgent[]): Set<string> {
  const byId = new Map<string, RestoredAgent>();
  for (const agent of restoredAgents) {
    if (!byId.has(agent.agentId)) byId.set(agent.agentId, agent);
  }
  const cyclic = new Set<string>();
  const settled = new Set<string>();
  const visiting = new Set<string>();
  for (const start of byId.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !settled.has(current) && !visiting.has(current)) {
      visiting.add(current);
      path.push(current);
      const parent: string | null = byId.get(current)?.parentAgentId ?? null;
      current = parent !== null && byId.has(parent) ? parent : undefined;
    }
    if (current !== undefined && visiting.has(current)) {
      for (let i = path.indexOf(current); i >= 0 && i < path.length; i++) cyclic.add(path[i]);
    }
    for (const id of path) {
      visiting.delete(id);
      settled.add(id);
    }
  }
  return cyclic;
}

// 分類と帰属をここで足さない。reducer が決めた値と restoredAgents の突き合わせだけを行う。
export function projectWorkModel(
  state: WorkModelState,
  restoredAgents: readonly RestoredAgent[] = []
): WorkModelPayload {
  const restoredByToolUseId = new Map<string, RestoredAgent>();
  const restoredById = new Map(restoredAgents.map(agent => [agent.agentId, agent]));
  for (const agent of restoredAgents) {
    if (agent.toolUseId.length > 0 && !restoredByToolUseId.has(agent.toolUseId)) {
      restoredByToolUseId.set(agent.toolUseId, agent);
    }
  }
  // meta の parentAgentId は実 ID なので、合成 ID だけで引くと深い階層の親に届かない。
  const nodeByKey = new Map<string, WorkAgentNode>();
  const levelByNode = new Map<WorkAgentNode, number>();
  const matchedRestoredIds = new Set<string>();
  const phases: WorkPhaseView[] = [];
  const unlinkedAgents: WorkAgentNode[] = [];
  let depthLimitedCount = 0;

  // AGENT_TREE_MAX_DEPTH を超える辺だけを捨てて根へ回す。木ごと拒否すると、壊れた一部のために payload 全体を失う。
  const attach = (node: WorkAgentNode, parent: WorkAgentNode | undefined, roots: WorkAgentNode[]): void => {
    if (parent === undefined || parent === node) {
      levelByNode.set(node, 0);
      roots.push(node);
      return;
    }
    const parentLevel = levelByNode.get(parent) ?? 0;
    if (parentLevel >= AGENT_TREE_MAX_DEPTH) {
      levelByNode.set(node, 0);
      depthLimitedCount++;
      unlinkedAgents.push(node);
      return;
    }
    levelByNode.set(node, parentLevel + 1);
    parent.children.push(node);
  };

  const rollup = state.rollup;
  if (rollup) {
    phases.push({
      ...rollup,
      phaseId: rollup.phaseId,
      kind: "rollup",
      operation: "unknown",
      title: rollup.title,
      segmentIds: [],
      segmentCount: 0,
      turnIds: [],
      turnCount: 0,
      isCurrent: false,
      state: phaseStateOf(rollup, false, state.turnActive),
      compactedPhaseCount: rollup.compactedPhaseCount,
      agents: [],
    });
  }

  for (const phase of state.phases) {
    const created: WorkAgentNode[] = [];
    for (const agent of phase.agents) {
      const restored = restoredByToolUseId.get(agent.toolUseId) ?? restoredById.get(agent.transcriptAgentId ?? "");
      if (restored) matchedRestoredIds.add(restored.agentId);
      const node: WorkAgentNode = {
        agentId: agent.agentId,
        intentInput: findToolPlacement(state, agent.toolUseId)?.intentInput,
        transcriptAgentId: agent.transcriptAgentId ?? restored?.agentId,
        parentAgentId: agent.parentAgentId,
        toolUseId: agent.toolUseId,
        parentToolUseId: agent.parentToolUseId,
        spawnDepth: agent.spawnDepth,
        agentType: agent.agentType ?? restored?.agentType,
        description: agent.description.length > 0 ? agent.description : restored?.description ?? "",
        modelDeclared: agent.modelDeclared ?? restored?.modelDeclared,
        modelMeasured: agent.modelMeasured ?? restored?.modelMeasured,
        effortDeclared: agent.effortDeclared,
        effortMeasured: restored?.effortMeasured,
        status: agent.status,
        runStartedAt: agent.runStartedAt ?? agent.startedAt,
        startedAt: agent.startedAt,
        endedAt: agent.endedAt,
        elapsedMs: agent.elapsedMs,
        tokens: agent.tokens,
        childCount: agent.childCount,
        failCount: agent.failCount,
        revision: agent.revision,
        origin: "live",
        children: [],
      };
      created.push(node);
      nodeByKey.set(agent.agentId, node);
      if (agent.transcriptAgentId) nodeByKey.set(agent.transcriptAgentId, node);
      if (restored) nodeByKey.set(restored.agentId, node);
    }
    const roots: WorkAgentNode[] = [];
    for (const node of created) {
      attach(node, node.parentAgentId === null ? undefined : nodeByKey.get(node.parentAgentId), roots);
    }
    const isCurrent = phase.phaseId === state.currentPhaseId;
    const { agents: _agents, ...rest } = phase;
    phases.push({
      ...rest,
      kind: "phase",
      isCurrent,
      state: phaseStateOf(phase, isCurrent, state.turnActive),
      agents: roots,
    });
  }

  const cyclicRestoredIds = findCyclicRestoredIds(restoredAgents);
  // 深い側を先に解決すると親がまだ登録されておらず、階層未確認へ落ちる。
  const pending = restoredAgents
    .filter((agent) => !matchedRestoredIds.has(agent.agentId))
    .slice()
    .sort((a, b) => a.spawnDepth - b.spawnDepth);
  for (const agent of pending) {
    const node = restoredToNode(agent);
    nodeByKey.set(agent.agentId, node);
    const parent =
      agent.parentAgentId === null || cyclicRestoredIds.has(agent.agentId)
        ? undefined
        : nodeByKey.get(agent.parentAgentId);
    attach(node, parent, unlinkedAgents);
  }

  return {
    version: WORK_MODEL_VERSION,
    // R-TAB-07: projectWorkModel
    requests: state.coverage.summary === "complete" && !state.coverage.hydrationUnconfirmed
      ? state.requests?.filter(request => !request.incomplete).map(({ command: _command, cliInserted: _cliInserted, incomplete: _incomplete, ...request }) => request) : undefined,
    planDeclaration: state.planDeclaration,
    planBoundaryAt: state.planBoundaryAt,
    planHistory: state.planHistory,
    planHistoryTruncated: state.planHistoryTruncated,
    planHistoryLostThrough: state.planHistoryLostThrough,
    planTools: state.runningToolUseIds.flatMap(id => {
      const tool = findToolPlacement(state, id);
      return tool && !tool.stale && tool.parentToolUseId === null
        ? [{ id, name: tool.toolName, description: tool.description, startedAt: tool.startedAt, intentInput: tool.intentInput }] : [];
    }),
    runningMainTools: [...state.runningToolUseIds, ...state.runningAgentToolUseIds].flatMap(id => {
      const tool = findToolPlacement(state, id);
      return tool && !tool.stale && tool.parentToolUseId === null && tool.background === undefined
        ? [{ id, name: tool.toolName, startedAt: tool.startedAt, intentInput: tool.intentInput }] : [];
    }).sort((a, b) => a.startedAt - b.startedAt),
    revision: state.revision,
    coverage:
      depthLimitedCount > 0
        ? {
            ...state.coverage,
            details: "prefix-truncated",
            depthLimitedAgentCount: (state.coverage.depthLimitedAgentCount ?? 0) + depthLimitedCount,
          }
        : state.coverage,
    currentPhaseId: state.currentPhaseId,
    ambiguity: state.ambiguity,
    phases,
    unlinkedAgents,
    tasks: taskItemViews(state),
    taskTotals: state.phases
      .filter((phase) => phase.taskKey !== undefined)
      .map((phase) => taskTotalsView(phase)),
  };
}

// 変わった集計は revision の一致で選ぶ（reducer が書き換えた枝にだけ現在の revision が入る）。分類の規則をここで再実装しない。
export function projectWorkEvent(
  previousState: WorkModelState,
  nextState: WorkModelState,
  event: NormalizedEvent
): WorkEventInfo | undefined {
  // 本文デルタには segment が変わったときだけ載せる。毎回載せると保存と送信の量がデルタ数に比例し、
  // 丸ごと外すとツールを使わないターンで前のカードが現在の作業のまま残る。
  if (event.kind === "assistant_text_delta" && nextState.currentSegmentId === previousState.currentSegmentId) {
    return undefined;
  }
  const revision = nextState.revision;
  const info: WorkEventInfo = { revision };
  let touched = false;

  if (nextState.currentSegmentId !== previousState.currentSegmentId) {
    info.currentSegmentId = nextState.currentSegmentId ?? null;
    touched = true;
  }

  if (event.kind === "tool_call_started") {
    // 配置が無くても info は必ず付ける。付けないと webview が記帳系と配置の欠落を区別できず、ツール名の表を持つことになる。
    touched = true;
    const placement = findToolPlacement(nextState, event.toolUseId);
    if (placement !== undefined && placement.phaseRef !== undefined) {
      const segment = findWorkSegment(nextState, placement.segmentId);
      info.placement = {
        phaseId: placement.phaseRef.kind === "rollup" ? "rollup" : placement.phaseRef.phaseId,
        segmentId: placement.segmentId,
        taskKey: segment?.taskKey,
        counted: placement.counted,
        ownerToolUseId:
          placement.ownerAgentId === undefined ? undefined : event.parentToolUseId ?? undefined,
      };
      touched = true;
    }
  }

  if (event.kind === "turn_completed") {
    const turnToolCount = nextState.segments
      .filter((segment) => segment.turnIds.includes(event.turnId))
      .reduce((sum, segment) => sum + segment.toolCount, 0);
    if (turnToolCount > 0) {
      info.turnToolCount = turnToolCount;
      touched = true;
    }
  }

  const segments = nextState.segments.filter((segment) => segment.revision === revision);
  if (segments.length > 0) {
    info.segments = segments.map((segment) => ({
      segmentId: segment.segmentId,
      phaseId: segment.phaseId,
      taskKey: segment.taskKey,
      toolCount: segment.toolCount,
      failCount: segment.failCount,
      childFailCount: segment.childFailCount,
      elapsedMs: segment.elapsedMs,
      runningCount: segment.runningCount,
      staleCount: segment.staleCount,
      revision: segment.revision,
    }));
    touched = true;
  }

  const agents: WorkAgentStateView[] = [];
  const taskTotals: WorkTaskTotalsView[] = [];
  for (const phase of nextState.phases) {
    if (phase.revision !== revision) continue;
    if (phase.taskKey !== undefined) {
      taskTotals.push({
        taskKey: phase.taskKey,
        toolCount: phase.toolCount,
        failCount: phase.failCount,
        childFailCount: phase.childFailCount,
        elapsedMs: phase.elapsedMs,
        agentTokens: phase.agentTokens,
      });
    }
    for (const agent of phase.agents) {
      if (agent.revision !== revision) continue;
      agents.push({
        runStartedAt: agent.runStartedAt ?? agent.startedAt,
        toolUseId: agent.toolUseId,
        status: agent.status,
        childCount: agent.childCount,
        failCount: agent.failCount,
        elapsedMs: agent.elapsedMs,
        tokens: agent.tokens,
        modelMeasured: agent.modelMeasured,
        revision: agent.revision,
      });
    }
  }
  if (agents.length > 0) {
    info.agents = agents;
    touched = true;
  }
  if (taskTotals.length > 0) {
    info.taskTotals = taskTotals;
    touched = true;
  }

  if (
    nextState.tasks !== previousState.tasks ||
    nextState.tasks.some((task) => task.revision === revision)
  ) {
    info.tasks = nextState.tasks.map((task) => ({
      taskKey: task.taskKey,
      description: task.description,
      activeForm: task.activeForm,
      status: task.status,
    }));
    touched = true;
  }

  const staled: string[] = [];
  for (const toolUseId of [...previousState.runningAgentToolUseIds, ...previousState.runningToolUseIds]) {
    if (findToolPlacement(previousState, toolUseId)?.stale === true) continue;
    if (findToolPlacement(nextState, toolUseId)?.stale !== true) continue;
    staled.push(toolUseId);
  }
  if (staled.length > 0) {
    info.staled = staled;
    touched = true;
  }

  if (event.kind === "approval_request" || event.kind === "approval_resolved") {
    let pending = nextState.rollup?.pendingApprovalCount ?? 0;
    for (const phase of nextState.phases) pending += phase.pendingApprovalCount;
    info.pendingApprovalCount = pending;
    touched = true;
  }

  return touched ? info : undefined;
}

// src/webview/main.ts#REPLAY_MAX で落とした分を Host の coverage へ合流させる（verify-history-prepend#HPmut-13）。
// renderer 側で分岐すると、概要と詳細が別々の欠落判定を持つ。
export function withLocalEventDrop(
  payload: WorkModelPayload | undefined,
  droppedCount: number
): WorkModelPayload | undefined {
  if (payload === undefined || droppedCount <= 0) return payload;
  return {
    ...payload,
    coverage: {
      ...payload.coverage,
      details: "prefix-truncated",
      droppedEventCount: (payload.coverage.droppedEventCount ?? 0) + droppedCount,
    },
  };
}

const COVERAGE_COMPLETENESS = ["complete", "prefix-truncated"];
const COVERAGE_SOURCES = ["live", "provider-transcript", "event-tail"];
const COVERAGE_PHASE_HISTORY = ["complete", "prefix-compacted"];
const COVERAGE_HYDRATION_UNCONFIRMED = ["loading", "failed"];
const COVERAGE_SEMANTIC_DERIVATION_FAILED = ["stale", "unavailable"];
const WORK_STATUSES = ["running", "completed", "failed", "stale", "unknown"];
const PHASE_OPERATIONS = ["unknown", "delegated", "observe", "mutate", "verify"];
const TASK_STATUSES = ["pending", "in_progress", "completed", "unknown"];
const PHASE_STATES = ["approval", "failed", "running", "stale", "done"];

function isNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWorkCoverage(v: unknown): v is WorkCoverage {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    COVERAGE_COMPLETENESS.includes(c.summary as string) &&
    COVERAGE_COMPLETENESS.includes(c.details as string) &&
    COVERAGE_SOURCES.includes(c.source as string) &&
    COVERAGE_PHASE_HISTORY.includes(c.phaseHistory as string) &&
    isNumber(c.compactedPhaseCount) &&
    (c.droppedEventCount === undefined || isNumber(c.droppedEventCount)) &&
    (c.omittedMessageCount === undefined || isNumber(c.omittedMessageCount)) &&
    (c.omittedToolCount === undefined || isNumber(c.omittedToolCount)) &&
    (c.untrackedApprovalCount === undefined || isNumber(c.untrackedApprovalCount)) &&
    (c.untrackedBackgroundCount === undefined || isNumber(c.untrackedBackgroundCount)) &&
    (c.unreadableAgentCount === undefined || isNumber(c.unreadableAgentCount)) &&
    (c.depthLimitedAgentCount === undefined || isNumber(c.depthLimitedAgentCount)) &&
    (c.hierarchyIncomplete === undefined || c.hierarchyIncomplete === true) &&
    (c.reducerErrorCount === undefined || isNumber(c.reducerErrorCount)) &&
    (c.hydrationUnconfirmed === undefined || COVERAGE_HYDRATION_UNCONFIRMED.includes(c.hydrationUnconfirmed as string)) &&
    isOptionalString(c.historyReadError) &&
    (c.historyMalformedLineCount === undefined || isNumber(c.historyMalformedLineCount)) &&
    (c.unparsedTaskInputCount === undefined || isNumber(c.unparsedTaskInputCount)) &&
    (c.evidenceFoldErrorCount === undefined || isNumber(c.evidenceFoldErrorCount)) &&
    (c.semanticDerivationFailed === undefined ||
      COVERAGE_SEMANTIC_DERIVATION_FAILED.includes(c.semanticDerivationFailed as string))
  );
}

function isOperationCounts(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const counts = v as Record<string, unknown>;
  return OPERATION_KIND_LIST.every((kind) => isNumber(counts[kind]));
}

function isWorkAgentNode(v: unknown, depth = 0): v is WorkAgentNode {
  if (depth > AGENT_TREE_MAX_DEPTH) return false;
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    (a.intentInput === undefined || isToolIntentInput(a.intentInput)) &&
    typeof a.agentId === "string" &&
    (a.parentAgentId === null || typeof a.parentAgentId === "string") &&
    typeof a.toolUseId === "string" &&
    (a.parentToolUseId === null || typeof a.parentToolUseId === "string") &&
    isNumber(a.spawnDepth) &&
    isOptionalString(a.agentType) &&
    typeof a.description === "string" &&
    isOptionalString(a.modelDeclared) &&
    isOptionalString(a.modelMeasured) &&
    isOptionalString(a.effortDeclared) &&
    isOptionalString(a.effortMeasured) &&
    WORK_STATUSES.includes(a.status as string) &&
    (a.runStartedAt === undefined || isNumber(a.runStartedAt)) &&
    (a.startedAt === undefined || isNumber(a.startedAt)) &&
    (a.endedAt === undefined || isNumber(a.endedAt)) &&
    isNumber(a.elapsedMs) &&
    (a.tokens === undefined || isNumber(a.tokens)) &&
    isNumber(a.childCount) &&
    isNumber(a.failCount) &&
    isNumber(a.revision) &&
    (a.origin === "live" || a.origin === "restored") &&
    Array.isArray(a.children) &&
    (a.children as unknown[]).every((child) => isWorkAgentNode(child, depth + 1))
  );
}

function isWorkPhaseView(v: unknown): v is WorkPhaseView {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.phaseId === "string" &&
    (p.kind === "phase" || p.kind === "rollup") &&
    isOptionalString(p.taskKey) &&
    (p.occurrence === undefined || isNumber(p.occurrence)) &&
    PHASE_OPERATIONS.includes(p.operation as string) &&
    typeof p.title === "string" &&
    isStringArray(p.segmentIds) &&
    isNumber(p.segmentCount) &&
    isStringArray(p.turnIds) &&
    isNumber(p.turnCount) &&
    isOptionalString(p.lastTurnId) &&
    isNumber(p.startedAt) &&
    (p.endedAt === undefined || isNumber(p.endedAt)) &&
    typeof p.isCurrent === "boolean" &&
    PHASE_STATES.includes(p.state as string) &&
    (p.compactedPhaseCount === undefined || isNumber(p.compactedPhaseCount)) &&
    isNumber(p.elapsedMs) &&
    isNumber(p.toolCount) &&
    isNumber(p.failCount) &&
    isOperationCounts(p.operationCounts) &&
    isNumber(p.taskCount) &&
    isNumber(p.agentCount) &&
    isNumber(p.agentTokens) &&
    isNumber(p.childToolCount) &&
    isNumber(p.childFailCount) &&
    isNumber(p.staleCount) &&
    isNumber(p.runningCount) &&
    (p.backgroundRunningCount === undefined || isNumber(p.backgroundRunningCount)) &&
    isNumber(p.pendingApprovalCount) &&
    isNumber(p.revision) &&
    Array.isArray(p.agents) &&
    (p.agents as unknown[]).every((agent) => isWorkAgentNode(agent))
  );
}

export function isWorkModelPayload(v: unknown): v is WorkModelPayload {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    (m.requests === undefined || isArrayOf(m.requests, value => {
      if (!value || typeof value !== "object") return false;
      const request = value as Record<string, unknown>;
      return isStringArray(request.turnIds) && typeof request.number === "string" &&
        isNumber(request.toolCount) && isNumber(request.agentCount) && isNumber(request.failCount) && isNumber(request.revision);
    })) &&
    (m.planHistory === undefined || isArrayOf(m.planHistory, entry => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      return isNumber(row.at) && (row.kind === "user" || row.kind === "todos" &&
        (row.source === undefined || row.source === "tasks") && (row.created === undefined || typeof row.created === "boolean") && (row.removed === undefined || typeof row.removed === "boolean") && isArrayOf(row.items, isWorkTaskItemView) ||
        row.kind === "resume" && typeof row.agentId === "string" && typeof row.description === "string" &&
        WORK_STATUSES.includes(row.status as string) && (row.endedAt === undefined || isNumber(row.endedAt)));
    })) &&
    (m.planDeclaration === undefined || isPlanDeclaration(m.planDeclaration)) &&
    (m.planBoundaryAt === undefined || isNumber(m.planBoundaryAt)) &&
    (m.planHistoryTruncated === undefined || typeof m.planHistoryTruncated === "boolean") &&
    (m.planHistoryLostThrough === undefined || isNumber(m.planHistoryLostThrough)) &&
    (m.planContext === undefined || isPlanContext(m.planContext)) &&
    (m.runningMainTools === undefined || isArrayOf(m.runningMainTools, tool => {
      if (!tool || typeof tool !== "object") return false;
      const row = tool as Record<string, unknown>;
      return (row.intentInput === undefined || isToolIntentInput(row.intentInput)) && typeof row.id === "string" && typeof row.name === "string" && isNumber(row.startedAt);
    })) &&
    (m.planTools === undefined || isArrayOf(m.planTools, tool => {
      if (!tool || typeof tool !== "object") return false;
      const row = tool as Record<string, unknown>;
      return (row.intentInput === undefined || isToolIntentInput(row.intentInput)) && typeof row.id === "string" && typeof row.name === "string" && typeof row.description === "string" && isNumber(row.startedAt);
    })) &&
    isNumber(m.version) &&
    isNumber(m.revision) &&
    isWorkCoverage(m.coverage) &&
    isOptionalString(m.currentPhaseId) &&
    (m.ambiguity === undefined || m.ambiguity === "multiple-active-tasks") &&
    Array.isArray(m.phases) &&
    (m.phases as unknown[]).every(isWorkPhaseView) &&
    Array.isArray(m.unlinkedAgents) &&
    (m.unlinkedAgents as unknown[]).every((agent) => isWorkAgentNode(agent)) &&
    isArrayOf(m.tasks, isWorkTaskItemView) &&
    isArrayOf(m.taskTotals, isWorkTaskTotalsView)
  );
}

function isPlanContext(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.blockId === "string" && typeof row.text === "string" && isNumber(row.start) && isNumber(row.end) && typeof row.running === "boolean";
}

function isPlanDeclaration(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.goal === "string" && row.goal.trim().length > 0 && isNumber(row.at);
}

const SEMANTIC_MODES = ["recorded", "fallback"];
const SEMANTIC_NODE_KINDS = ["goal", "stage", "task", "attempt", "agentRun"];
const SEMANTIC_EDGE_KINDS = [
  "contains",
  "executes",
  "observed_before",
  "overlaps",
  "observed_data_dep",
  "resource_conflict",
  "reviews",
];
const SEMANTIC_COVERAGES = ["complete", "partial", "unavailable"];
const SEMANTIC_SOURCES = ["observed", "derived", "fallback"];
const SEMANTIC_CERTAINTIES = ["confirmed", "candidate", "unknown"];
const SEMANTIC_RECONCILE_STATES = ["consistent", "conflict", "declared_only", "observed_only", "unknown"];
const SEMANTIC_ATTEMPT_ROLES = ["implement", "research", "review", "fix", "verify", "unknown"];
const SEMANTIC_ARTIFACT_MODES = ["read", "write", "exec", "unknown"];
const SEMANTIC_REOPEN_CAUSES = ["user-change", "unknown"];
const SEMANTIC_IDENTITY_STABILITIES = ["stable", "content-derived", "unknown"];
const SEMANTIC_OWNER_STATES = ["structural", "active-task", "undetermined"];
const SEMANTIC_DEFINITION_STATES = ["recorded", "undetermined"];
const SEMANTIC_DEFINITION_STATUSES = ["planned", "active", "completed", "cancelled", "unknown"];
const L3_SERIALIZATION_CLASSIFICATIONS: readonly SerializationClassification[] = [
  "required",
  "independent-serial",
  "undetermined",
];

function isSemanticDerivation(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    SEMANTIC_SOURCES.includes(d.source as string) &&
    SEMANTIC_CERTAINTIES.includes(d.certainty as string) &&
    isOptionalString(d.note)
  );
}

function isSemanticEvidenceRef(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.kind === "event") {
    return (
      isOptionalString(r.toolUseId) &&
      isOptionalString(r.agentId) &&
      (r.seq === undefined || isNumber(r.seq))
    );
  }
  if (r.kind === "aggregate") {
    return (
      isOptionalString(r.phaseId) &&
      isOptionalString(r.segmentId) &&
      isOptionalString(r.agentId) &&
      isOptionalString(r.taskKey)
    );
  }
  return false;
}

function isSemanticFootprint(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    isStringArray(f.readSet) &&
    isStringArray(f.writeSet) &&
    isStringArray(f.execSet) &&
    typeof f.unknownEffects === "boolean" &&
    SEMANTIC_COVERAGES.includes(f.coverage as string)
  );
}

function isSemanticArtifactView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.artifactId === "string" &&
    isOptionalString(a.displayName) &&
    SEMANTIC_ARTIFACT_MODES.includes(a.mode as string) &&
    // SemanticArtifactView の canonicalPath?: never と対の実行時検査。
    !("canonicalPath" in a)
  );
}

function isSemanticWorkStatusRef(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return s.scope === "work" && WORK_STATUSES.includes(s.value as string);
}

function isSemanticTaskIdentity(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  return (
    typeof i.semanticTaskId === "string" &&
    isStringArray(i.taskKeys) &&
    SEMANTIC_IDENTITY_STABILITIES.includes(i.stability as string) &&
    SEMANTIC_COVERAGES.includes(i.identityCoverage as string)
  );
}

function isSemanticNodeView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  const baseOk =
    typeof n.nodeId === "string" &&
    SEMANTIC_NODE_KINDS.includes(n.kind as string) &&
    isOptionalString(n.parentId) &&
    typeof n.title === "string" &&
    isArrayOf(n.evidence, isSemanticEvidenceRef) &&
    isSemanticDerivation(n.derivation) &&
    (n.drilldown === "available" || n.drilldown === "aggregate-only");
  if (!baseOk) return false;
  if (n.kind === "goal") return true;
  if (n.kind === "stage") {
    return n.stageState === "undetermined";
  }
  if (n.kind === "task") {
    const summary = n.executionSummary as Record<string, unknown> | undefined;
    const window = n.executionWindow as Record<string, unknown> | undefined;
    return (
      isSemanticTaskIdentity(n.identity) &&
      SEMANTIC_DEFINITION_STATES.includes(n.definitionState as string) &&
      SEMANTIC_DEFINITION_STATUSES.includes(n.definitionStatus as string) &&
      (summary === undefined ||
        (typeof summary === "object" &&
          summary !== null &&
          isNumber(summary.attemptCount) &&
          isNumber(summary.failCount) &&
          (summary.tokens === undefined || isNumber(summary.tokens)) &&
          typeof summary.approvalPending === "boolean" &&
          (summary.footprint === undefined || isSemanticFootprint(summary.footprint)))) &&
      (window === undefined ||
        (typeof window === "object" &&
          window !== null &&
          isNumber(window.startedAt) &&
          (window.endedAt === undefined || isNumber(window.endedAt)) &&
          isNumber(window.durationUnionMs) &&
          SEMANTIC_COVERAGES.includes(window.coverage as string)))
    );
  }
  if (n.kind === "attempt") {
    const reconciled = n.reconciledRole as Record<string, unknown> | undefined;
    const actor = n.actor as Record<string, unknown> | undefined;
    const anchors = n.anchors as Record<string, unknown> | undefined;
    const result = n.result as Record<string, unknown> | undefined;
    return (
      (n.agentTypeRole === undefined || SEMANTIC_ATTEMPT_ROLES.includes(n.agentTypeRole as string)) &&
      (n.observedRole === undefined || SEMANTIC_ATTEMPT_ROLES.includes(n.observedRole as string)) &&
      typeof reconciled === "object" &&
      reconciled !== null &&
      (reconciled.value === undefined || SEMANTIC_ATTEMPT_ROLES.includes(reconciled.value as string)) &&
      SEMANTIC_RECONCILE_STATES.includes(reconciled.state as string) &&
      SEMANTIC_OWNER_STATES.includes(n.ownerState as string) &&
      (n.ordinalWithinTask === undefined || isNumber(n.ordinalWithinTask)) &&
      (actor === undefined ||
        (typeof actor === "object" &&
          actor !== null &&
          isOptionalString(actor.agentId) &&
          isOptionalString(actor.agentType) &&
          isOptionalString(actor.model) &&
          isOptionalString(actor.effort) &&
          typeof actor.measured === "boolean")) &&
      typeof anchors === "object" &&
      anchors !== null &&
      isStringArray(anchors.segmentIds) &&
      isStringArray(anchors.agentIds) &&
      isNumber(n.startedAt) &&
      (n.endedAt === undefined || isNumber(n.endedAt)) &&
      isNumber(n.elapsedMs) &&
      isSemanticWorkStatusRef(n.status) &&
      (result === undefined ||
        (typeof result === "object" &&
          result !== null &&
          isNumber(result.failCount) &&
          isNumber(result.childFailCount) &&
          (result.tokens === undefined || isNumber(result.tokens)))) &&
      isArrayOf(n.artifacts, isSemanticArtifactView) &&
      isSemanticFootprint(n.footprint)
    );
  }
  return (
    typeof n.agentId === "string" &&
    isNumber(n.spawnDepth) &&
    isOptionalString(n.parentAgentRunId) &&
    isNumber(n.elapsedMs) &&
    isSemanticWorkStatusRef(n.status)
  );
}

function isSemanticEdgeView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.edgeId === "string" &&
    typeof e.from === "string" &&
    typeof e.to === "string" &&
    SEMANTIC_EDGE_KINDS.includes(e.kind as string) &&
    isSemanticDerivation(e.derivation) &&
    (e.assertion === "observed" || e.assertion === "inferred") &&
    isArrayOf(e.evidence, isSemanticEvidenceRef)
  );
}

function isSemanticAssignment(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.assignmentId === "string" &&
    typeof a.agentRunId === "string" &&
    typeof a.taskNodeId === "string" &&
    a.source === "delegation" &&
    isNumber(a.startedAt) &&
    (a.endedAt === undefined || isNumber(a.endedAt)) &&
    isArrayOf(a.evidence, isSemanticEvidenceRef) &&
    isSemanticDerivation(a.derivation)
  );
}

function isSemanticCoverage(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    isWorkCoverage(c.base) &&
    SEMANTIC_COVERAGES.includes(c.timing as string) &&
    SEMANTIC_COVERAGES.includes(c.dependency as string) &&
    SEMANTIC_COVERAGES.includes(c.artifact as string) &&
    SEMANTIC_COVERAGES.includes(c.identity as string) &&
    SEMANTIC_COVERAGES.includes(c.detail as string)
  );
}

function isSemanticTaskReopened(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.taskKey === "string" &&
    isNumber(t.at) &&
    TASK_STATUSES.includes(t.from as string) &&
    TASK_STATUSES.includes(t.to as string) &&
    SEMANTIC_REOPEN_CAUSES.includes(t.cause as string) &&
    isArrayOf(t.evidence, isSemanticEvidenceRef)
  );
}

function isSemanticReworkCandidate(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.taskKey === "string" &&
    isNumber(r.at) &&
    typeof r.reason === "string" &&
    isArrayOf(r.evidence, isSemanticEvidenceRef)
  );
}

function isNumberRecord(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(isNumber);
}

function isL3Basis(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    isStringArray(b.nodeIds) &&
    isStringArray(b.edgeIds) &&
    isArrayOf(b.evidence, isSemanticEvidenceRef)
  );
}

// reason の語彙をここへ複製しない。複製すると追加時に静かに食い違う。表示側は未知の reason を落とさず未観測として描く。
function isL3Metric(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.metricId !== "string") return false;
  if (!isL3Basis(m.basis) || !isSemanticCoverage(m.coverage)) return false;
  if (m.counts !== undefined && !isNumberRecord(m.counts)) return false;
  if (m.state === "observed") return isNumber(m.value);
  if (m.state === "unavailable") return typeof m.reason === "string";
  return false;
}

// 指標を足すと tsc がここで落ちるよう、配列でなく Record で持つ。
const L3_METRIC_KEYS: Record<keyof L3Report["metrics"], true> = {
  longGapMs: true,
  longGapCount: true,
  failureCount: true,
  actualConcurrency: true,
  fileWriteConflictCount: true,
  resourceDependencyCount: true,
  unknownEffectRatio: true,
  observedConstraintChainMs: true,
};

type L3TaskMetricKeys = Omit<L3Report["taskMetrics"][number], "taskId">;

const L3_TASK_METRIC_KEYS: Record<keyof L3TaskMetricKeys, true> = {
  taskDurationMs: true,
  attemptCount: true,
};

function isL3TaskMetricSet(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.taskId === "string" &&
    Object.keys(L3_TASK_METRIC_KEYS).every((k) => isL3Metric(t[k]))
  );
}

function isSerializationPair(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.taskAId === "string" &&
    typeof p.taskBId === "string" &&
    L3_SERIALIZATION_CLASSIFICATIONS.includes(p.classification as SerializationClassification) &&
    isL3Basis(p.basis)
  );
}

function isSerializationAttemptPair(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.pairId === "string" &&
    typeof p.attemptAId === "string" &&
    typeof p.attemptBId === "string" &&
    L3_SERIALIZATION_CLASSIFICATIONS.includes(p.classification as SerializationClassification) &&
    isL3Basis(p.basis)
  );
}

function isL3SerializationProfile(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    isArrayOf(s.pairs, isSerializationPair) &&
    isNumberRecord(s.counts) &&
    (s.attemptPairs === undefined || isArrayOf(s.attemptPairs, isSerializationAttemptPair)) &&
    (s.attemptPairCounts === undefined || isNumberRecord(s.attemptPairCounts)) &&
    isL3Basis(s.basis) &&
    isSemanticCoverage(s.coverage) &&
    (s.state === "observed" || s.state === "unavailable") &&
    isOptionalString(s.reason)
  );
}

function isL3ParallelizationEstimate(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    (p.valueMs === undefined || isNumber(p.valueMs)) &&
    (p.estimateType === undefined || p.estimateType === "upper_bound" || p.estimateType === "model_estimate") &&
    (p.assumptions === undefined || isStringArray(p.assumptions)) &&
    (p.basis === undefined || isL3Basis(p.basis)) &&
    (p.coverage === undefined || SEMANTIC_COVERAGES.includes(p.coverage as string)) &&
    isNumber(p.undeterminedPairCount) &&
    isNumber(p.undeterminedTaskCount) &&
    isNumberRecord(p.excludedPairCounts) &&
    (p.state === "estimated" || p.state === "unavailable") &&
    isOptionalString(p.reason)
  );
}

function isL3Report(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const metrics = r.metrics as Record<string, unknown> | undefined;
  return (
    isNumber(r.specVersion) &&
    typeof r.semanticHash === "string" &&
    isArrayOf(r.taskMetrics, isL3TaskMetricSet) &&
    typeof metrics === "object" &&
    metrics !== null &&
    Object.keys(L3_METRIC_KEYS).every((k) => isL3Metric(metrics[k])) &&
    isL3SerializationProfile(r.serializationProfile) &&
    typeof r.estimates === "object" &&
    r.estimates !== null &&
    isL3ParallelizationEstimate(
      (r.estimates as Record<string, unknown>).parallelizationUpperBound
    )
  );
}

// kind を足すと tsc がここで落ちるよう、配列でなく Record で持つ。
const DIVERGENCE_KIND_KEYS: Record<DivergenceKind, true> = {
  serialization: true,
  unsupported_completion: true,
  progress_stagnation: true,
  declared_state_conflict: true,
};

// declared / observed は unknown 型の拡張点なので形を検査しない。divergenceId は緩めない（verify-work-overview#O-58b）:
// 所見は ID の引用でしか乖離へ言及できない。ID を持たない l3 は payload ごと落ち、未着の表示になる。
function isDivergenceRecordView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.divergenceId === "string" &&
    r.divergenceId.length > 0 &&
    typeof r.kind === "string" &&
    r.kind in DIVERGENCE_KIND_KEYS &&
    isStringArray(r.subjectIds) &&
    (r.magnitude === undefined || isNumber(r.magnitude)) &&
    isArrayOf(r.evidence, isSemanticEvidenceRef) &&
    SEMANTIC_COVERAGES.includes(r.detectionInputCoverage as string)
  );
}

function isDivergenceKindReportView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.kind === "string" &&
    k.kind in DIVERGENCE_KIND_KEYS &&
    (k.state === "observed" || k.state === "undetermined") &&
    isOptionalString(k.reason) &&
    isArrayOf(k.records, isDivergenceRecordView) &&
    isNumberRecord(k.counts) &&
    isSemanticCoverage(k.coverage)
  );
}

function isDivergenceReportView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  const kinds = d.kinds as Record<string, unknown> | undefined;
  return (
    isNumber(d.specVersion) &&
    typeof d.semanticHash === "string" &&
    isSemanticCoverage(d.coverage) &&
    typeof kinds === "object" &&
    kinds !== null &&
    Object.keys(DIVERGENCE_KIND_KEYS).every((k) => isDivergenceKindReportView(kinds[k])) &&
    isNumber(d.recordCount) &&
    isNumber(d.droppedRecordCount) &&
    // 診断値が欠けても l3 全体を落とさない。落とすと観測された乖離が画面から消える。
    (d.segmentAnchoredIdCount === undefined || isNumber(d.segmentAnchoredIdCount))
  );
}


function isLlmAnalysisProvenance(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    isNumber(p.semanticRevision) &&
    typeof p.semanticHash === "string" &&
    isNumber(p.analysisGeneratedAt) &&
    typeof p.modelId === "string" &&
    typeof p.promptVersion === "string"
  );
}

function isHistoryOption(v: unknown): v is HistoryOption {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.artifactId === "string" &&
    h.artifactId.length > 0 &&
    h.artifactId.length <= 200 &&
    typeof h.label === "string" &&
    h.label.length > 0 &&
    isOptionalString(h.generatedAtLabel) &&
    (h.findingsCount === undefined || isNumber(h.findingsCount)) &&
    isOptionalString(h.requestedModel) &&
    isOptionalString(h.requestedEffort) &&
    isOptionalString(h.executedModels) &&
    isOptionalString(h.freshnessLabel)
  );
}

function isAttachedEvidenceChip(v: unknown): v is AttachedEvidenceChip {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.alias === "string" &&
    c.alias.length > 0 &&
    ["event", "user", "metric", "divergence", "guardrail", "file"].includes(c.kind as string) &&
    typeof c.label === "string" &&
    c.label.length > 0 &&
    (c.navigateToolUseId === undefined ||
      (typeof c.navigateToolUseId === "string" &&
        c.navigateToolUseId.length > 0 &&
        c.navigateToolUseId.length <= 200))
  );
}

function isFindingAction(v: unknown): v is FindingAction {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    ["startCurrentFinding", "prepareHistoricalDraft", "none"].includes(a.kind as string) &&
    typeof a.label === "string" &&
    a.label.length > 0
  );
}

function isAttachedFindingView(v: unknown): v is AttachedFindingView {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if ("verdict" in f || "rejections" in f) return false;
  return (
    typeof f.findingId === "string" &&
    f.findingId.length > 0 &&
    f.findingId.length <= 64 &&
    typeof f.numberLabel === "string" &&
    f.numberLabel.length > 0 &&
    isOptionalString(f.numberDigits) &&
    typeof f.title === "string" &&
    f.title.length > 0 &&
    typeof f.observed === "string" &&
    f.observed.length > 0 &&
    typeof f.impactLabel === "string" &&
    f.impactLabel.length > 0 &&
    typeof f.destinationLabel === "string" &&
    f.destinationLabel.length > 0 &&
    typeof f.actionKindLabel === "string" &&
    f.actionKindLabel.length > 0 &&
    typeof f.actionLine === "string" &&
    f.actionLine.length > 0 &&
    isStringArray(f.steps) &&
    isOptionalString(f.target) &&
    (f.confidence === "high" || f.confidence === "medium" || f.confidence === "low") &&
    isFindingAction(f.action) &&
    isArrayOf(f.evidence, isAttachedEvidenceChip)
  );
}

function isAttachedAnalysisView(v: unknown): v is AttachedAnalysisView {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.artifactId === "string" &&
    a.artifactId.length > 0 &&
    a.artifactId.length <= 200 &&
    ["current", "stale", "restored-unverifiable"].includes(a.freshness as string) &&
    typeof a.freshnessLabel === "string" &&
    a.freshnessLabel.length > 0 &&
    typeof a.generatedAtLabel === "string" &&
    a.generatedAtLabel.length > 0 &&
    typeof a.requestedModelLabel === "string" &&
    a.requestedModelLabel.length > 0 &&
    typeof a.executedModelsLabel === "string" &&
    a.executedModelsLabel.length > 0 &&
    ["pending", "saved", "rejected", "failed"].includes(a.persistence as string) &&
    typeof a.persistenceLabel === "string" &&
    a.persistenceLabel.length > 0 &&
    typeof a.summaryLabel === "string" &&
    a.summaryLabel.length > 0 &&
    (a.findingsCount === undefined || isNumber(a.findingsCount)) &&
    (a.rejectedCount === undefined || isNumber(a.rejectedCount)) &&
    isOptionalString(a.modelsLabel) &&
    (a.tokensLabel === null || isOptionalString(a.tokensLabel)) &&
    (a.slicesCount === undefined || isNumber(a.slicesCount)) &&
    (a.emptyStateLabel === undefined ||
      (typeof a.emptyStateLabel === "string" && a.emptyStateLabel.length > 0)) &&
    (a.inputCoverageLabel === undefined ||
      (typeof a.inputCoverageLabel === "string" && a.inputCoverageLabel.length > 0)) &&
    isArrayOf(a.historyOptions, isHistoryOption) &&
    typeof a.selectedArtifactId === "string" &&
    (a.historyOptions as HistoryOption[]).some((opt) => opt.artifactId === a.selectedArtifactId) &&
    isArrayOf(a.findings, isAttachedFindingView)
  );
}

function isActionFinding(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  const impact = f.impact as Record<string, unknown> | undefined;
  const action = f.action as Record<string, unknown> | undefined;
  const calc = impact?.calculation as Record<string, unknown> | undefined;
  return (
    typeof f.title === "string" &&
    typeof f.observed === "string" &&
    typeof impact === "object" &&
    impact !== null &&
    (impact.unit === "ms" || impact.unit === "count") &&
    isNumber(impact.value) &&
    typeof calc === "object" &&
    calc !== null &&
    ["identity", "sum", "cardinality"].includes(calc.op as string) &&
    isStringArray(calc.factIds) &&
    typeof action === "object" &&
    action !== null &&
    typeof action.kind === "string" &&
    typeof action.destination === "string" &&
    isStringArray(action.steps) &&
    isOptionalString(action.target) &&
    isStringArray(f.evidenceIds) &&
    (f.confidence === "high" || f.confidence === "medium" || f.confidence === "low")
  );
}

// 棄却の中身を通常の画面へ運ぶ名前を拒否する。rejectedCount は要約行に出すので含めない。
const LLM_REPORT_BANNED_KEYS = [
  "rejected",
  "byReason",
  "diagnostics",
  "candidateCount",
];

// 自由文には LLM 本文が混ざりうるので、コードの字面であることだけを検査する。語彙は複製しない（コードを足しても payload を落とさない）。
const LLM_REASON_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function isAnalysisPanelView(v: unknown): v is AnalysisPanelView {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const state = r.state;
  if (!["disabled", "idle", "running", "attemptFailed", "attached"].includes(state as string)) return false;
  if (LLM_REPORT_BANNED_KEYS.some((k) => k in r)) return false;
  if (state === "disabled" || state === "idle") return !("attached" in r);
  if (state === "running") {
    return r.attached === undefined || isAttachedAnalysisView(r.attached);
  }
  if (state === "attemptFailed") {
    return (
      typeof r.reason === "string" &&
      LLM_REASON_CODE_RE.test(r.reason) &&
      (r.attached === undefined || isAttachedAnalysisView(r.attached))
    );
  }
  if (state === "attached") {
    return isAttachedAnalysisView(r.attached);
  }
  return false;
}

export function isLlmFindingReportView(v: unknown): v is LlmFindingReportView {
  return isAnalysisPanelView(v);
}

// check と reason の語彙を src/llm-finding-verify.ts から複製しない（isL3Metric と同じ理由）。
function isFindingRejectionView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const detail = r.detail;
  return (
    typeof r.check === "string" &&
    typeof r.reason === "string" &&
    isStringArray(r.subjectIds) &&
    (detail === undefined ||
      (typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        Object.values(detail as Record<string, unknown>).every(
          (x) => typeof x === "string" || isNumber(x)
        )))
  );
}

function isRejectedFindingView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.verdict === "rejected" &&
    isActionFinding(r.finding) &&
    isArrayOf(r.rejections, isFindingRejectionView) &&
    (r.rejections as unknown[]).length > 0
  );
}

export function isLlmFindingDiagnosticsPayload(v: unknown): v is LlmFindingDiagnosticsPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (p.state === "unavailable") return typeof p.reason === "string";
  if (p.state !== "completed") return false;
  const counts = p.counts as Record<string, unknown> | undefined;
  return (
    isNumber(p.specVersion) &&
    isLlmAnalysisProvenance(p.provenance) &&
    (p.cacheState === "hit" || p.cacheState === "miss") &&
    isArrayOf(p.rejected, isRejectedFindingView) &&
    typeof counts === "object" &&
    counts !== null &&
    isNumber(counts.candidate) &&
    isNumber(counts.schemaRejected) &&
    isNumberRecord(counts.schemaByReason) &&
    isNumber(counts.verified) &&
    isNumber(counts.accepted) &&
    isNumber(counts.rejected) &&
    isNumberRecord(counts.byReason)
  );
}

function isAnalysisLearningRANL20(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const learning = v as Record<string, unknown>;
  return hasOnlyKeys(learning, ["state", "note", "lines", "empty"])
    && (learning.state === "unobserved" || learning.state === "observed")
    && typeof learning.note === "string" && Array.isArray(learning.lines)
    && learning.lines.every(line => typeof line === "string")
    && (learning.state === "unobserved" ? learning.note.length > 0 && learning.lines.length === 0 : learning.lines.length > 0)
    // R-LRN-09: 未観測に「該当なし」を付けない
    && (learning.empty === undefined || (learning.empty === true && learning.state === "observed" && learning.lines.length === 1));
}

function isAnalysisFactsView(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  return (
    hasOnlyKeys(f, ["llmTargets", "coverageNote", "learning"]) &&
    typeof f.llmTargets === "object" &&
    f.llmTargets !== null &&
    !Array.isArray(f.llmTargets) &&
    hasOnlyKeys(f.llmTargets as Record<string, unknown>, ["toolCalls", "label"]) &&
    isNumber((f.llmTargets as Record<string, unknown>).toolCalls) &&
    typeof (f.llmTargets as Record<string, unknown>).label === "string" &&
    isOptionalString(f.coverageNote) &&
    (f.learning === undefined || isAnalysisLearningRANL20(f.learning))
  );
}

export function isL3ReportPayload(v: unknown): v is L3ReportPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    isL3Report(p.analysis) &&
    isDivergenceReportView(p.divergences) &&
    (p.facts === undefined || isAnalysisFactsView(p.facts)) &&
    (p.llm === undefined || isLlmFindingReportView(p.llm))
  );
}

export function isSemanticModelPayload(v: unknown): v is SemanticModelPayload {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    isNumber(m.version) &&
    SEMANTIC_MODES.includes(m.mode as string) &&
    isNumber(m.revision) &&
    typeof m.evidenceHash === "string" &&
    typeof m.semanticHash === "string" &&
    isArrayOf(m.nodes, isSemanticNodeView) &&
    isArrayOf(m.edges, isSemanticEdgeView) &&
    isSemanticCoverage(m.coverage) &&
    typeof m.degraded === "boolean" &&
    isNumber(m.conflictCount) &&
    isNumber(m.delegationMismatchCount) &&
    isArrayOf(m.taskReopened, isSemanticTaskReopened) &&
    isArrayOf(m.reworkCandidates, isSemanticReworkCandidate) &&
    (m.assignments === undefined || isArrayOf(m.assignments, isSemanticAssignment)) &&
    (m.l3 === undefined || isL3ReportPayload(m.l3)) &&
    (m.timeBucketsCoverage === undefined || isTimeBucketsCoverage(m.timeBucketsCoverage)) &&
    (m.timeBuckets === undefined || isTimeBucketsPayload(m.timeBuckets)) &&
    (m.roleSummary === undefined || isRoleSummaryView(m.roleSummary)) &&
    (m.failureSummary === undefined || isFailureSummaryView(m.failureSummary)) &&
    (m.summaryAnalysis === undefined || isSummaryAnalysisView(m.summaryAnalysis)) &&
    (m.mainTokens === undefined || m.mainTokens === null || isMainTokenTotal(m.mainTokens))
  );
}

const isNullableNumber = (v: unknown): boolean => v === null || isNumber(v);
const isNullableString = (v: unknown): boolean => v === null || typeof v === "string";

function isSummaryAnalysisView(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  const count = (n: unknown) => n === null || (Number.isSafeInteger(n) && (n as number) >= 0);
  const percent = (n: unknown) => isNumber(n) && (n as number) >= 0 && (n as number) <= 100;
  return count(s.improvableCount) && count(s.scriptFindingCount) && count(s.scriptCandidateCount) &&
    (s.scriptCandidatePercent === null || percent(s.scriptCandidatePercent)) &&
    (s.llmExecutionState === "idle" || s.llmExecutionState === "running" || s.llmExecutionState === "attemptFailed" || s.llmExecutionState === "disabled" || s.llmExecutionState === "attached") &&
    (s.llmState === "current" || s.llmState === "not-run" || s.llmState === "stale") &&
    count(s.llmFindingCount) && count(s.rejectedCount) && isOptionalString(s.generatedAtLabel) &&
    isArrayOf(s.llmAreas, value => {
      if (typeof value !== "object" || value === null) return false;
      const area = value as Record<string, unknown>;
      return typeof area.label === "string" && area.count !== null && count(area.count) && percent(area.percent);
    });
}

// 他の項目は webview 検査の合成 payload が部分形で送るので、形を問わない。
function isTimeBucketsPayload(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const { mainByModel: byModel, blocks } = v as Record<string, unknown>;
  const percent = (value: unknown) => isNumber(value) && (value as number) >= 0 && (value as number) <= 100;
  return (byModel === undefined || byModel === null || isMainTimeByModelView(byModel)) &&
    (blocks === undefined || isArrayOf(blocks, value => {
      if (typeof value !== "object" || value === null) return false;
      const block = value as Record<string, unknown>;
      if (block.requestNumber !== undefined && block.requestNumber !== null &&
        !(typeof block.requestNumber === "string" && /^\d+$/.test(block.requestNumber))) return false;
      if (block.processingMs !== undefined && block.processingMs !== null &&
        !(isNumber(block.processingMs) && (block.processingMs as number) >= 0)) return false;
      if (block.strip === undefined || block.strip === null) return true;
      if (typeof block.strip !== "object" || Array.isArray(block.strip)) return false;
      const strip = block.strip as Record<string, unknown>;
      return percent(strip.processingPercent) && percent(strip.replyPercent) && percent(strip.remainderPercent);
    }));
}

function isMainModelTimeEntry(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    (e.kind === "model" || e.kind === "other" || e.kind === "unknown") &&
    typeof e.label === "string" &&
    isNullableString(e.model) &&
    (e.kind === "model") === (typeof e.model === "string") &&
    isNullableNumber(e.foldedModelCount) &&
    (e.kind === "other") === (typeof e.foldedModelCount === "number") &&
    isNumber(e.generateMs) && (e.generateMs as number) >= 0 &&
    isNullableNumber(e.share) && isNullableNumber(e.percent)
  );
}

function isMainTimeByModelView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    isNumber(b.totalMs) && isNumber(b.generateMs) && isNumber(b.toolMs) &&
    isNullableNumber(b.toolShare) && isNullableNumber(b.toolPercent) &&
    isArrayOf(b.models, isMainModelTimeEntry)
  );
}
const isValueSource = (v: unknown): boolean => v === null || v === "measured" || v === "requested";

function isRoleRunView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.source === "subagent" || r.source === "external") &&
    typeof r.name === "string" &&
    typeof r.executor === "string" &&
    isNullableString(r.model) && isValueSource(r.modelSource) &&
    isNullableString(r.effort) && isValueSource(r.effortSource) &&
    typeof r.variantLabel === "string" &&
    isNumber(r.shade) &&
    isNullableNumber(r.startedAt) &&
    typeof r.running === "boolean" &&
    (r.outcome === null || ["ok", "failed", "timeout", "refused"].includes(r.outcome as string)) &&
    isNullableNumber(r.durationMs) && isNullableNumber(r.tokens) &&
    isNullableNumber(r.timePercent) && isNullableNumber(r.tokenPercent)
  );
}

function isRoleSummaryView(v: unknown): v is RoleSummaryView {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const coverage = s.externalRunsCoverage as Record<string, unknown> | undefined;
  return (
    isNumber(s.omittedSubagentCount) &&
    (coverage === undefined || (typeof coverage === "object" && coverage !== null &&
      isNumber(coverage.unreadableLines) && (coverage.unreadableLines as number) >= 0 && typeof coverage.readError === "boolean")) &&
    isArrayOf(s.roles, (role) => {
      if (typeof role !== "object" || role === null) return false;
      const r = role as Record<string, unknown>;
      return (
        isNullableString(r.role) && typeof r.label === "string" && isNumber(r.count) &&
        isNullableNumber(r.totalMs) && typeof r.totalMsPartial === "boolean" &&
        isNullableNumber(r.totalTokens) && typeof r.totalTokensPartial === "boolean" && typeof r.running === "boolean" &&
        isNullableNumber(r.timeWidthPercent) && isNullableNumber(r.tokenWidthPercent) &&
        isArrayOf(r.runs, isRoleRunView)
      );
    })
  );
}

function isFailureKindView(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return typeof k.anchor === "string" && typeof k.label === "string" && isNumber(k.count);
}

function isFailureSummaryView(v: unknown): v is FailureSummaryView {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    isNumber(f.failCount) && isNumber(f.toolCount) && isNullableNumber(f.failPercent) &&
    isArrayOf(f.top, isFailureKindView) &&
    isArrayOf(f.rest, isFailureKindView) &&
    isNumber(f.restCount)
  );
}

function isMainTokenTotal(v: unknown): v is MainTokenTotal {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return isNumber(t.tokens) && isNumber(t.cacheRead) && isNumber(t.messageCount) &&
    isNumber(t.unmeasuredMessageCount) && typeof t.partial === "boolean";
}

export type ResumeHydrationPhase = "loading" | "complete" | "failed";

export const RESUME_PREVIEW_MESSAGE_MAX = 80;

// R-HND-11: 書き直しの可能性を知らせるだけに使う。近似一致で重複を消さない（決定を取り違える）。
export const DECISIONS_REWRITE_RATIO = 0.8;

// R-HND-10: Host と webview が同じ関数で作る。固定値にしない: intoTabId で同じ tabId に別セッションが載ると、
// 古い展開部の cache が一致して別会話の本文を返す。
export function restoredHandoffRunId(forkSessionId: string): string {
  return `restored:${forkSessionId}`;
}

export interface ResumePreviewMessage {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  imageRefs?: ImageRefInfo[];
  model?: string;
}

export type ResumeHydrationSnapshotState =
  | {
      phase: "loading" | "complete";
      previewMessages?: ResumePreviewMessage[];
      failureReason?: never;
    }
  | {
      phase: "failed";
      previewMessages?: ResumePreviewMessage[];
      failureReason?: string;
    };

export interface ResumeHydrationDisplayEvent {
  journalEventId: string;
  event: NormalizedEvent;
}

export interface ResumeHydrationSendDisposition {
  clientToken: string;
  disposition: "accepted-human" | "accepted-nonhuman" | "rejected";
}

export interface LlmAnalysisRunProgress {
  stage?: "slice" | "merge";
  sliceIndex?: number;
  sliceCount?: number;
  callIndex: number;
  plannedCalls: number;
  elapsedMs: number;
}

export type HostToWebview =
  | { type: "planUsage"; tabId: string; state: import("./plan-usage").PlanUsage }
  | { type: "orchestrationView"; tabId: string; state: OrchestrationView }
  // hostWindows: the Extension Host platform, which decides the Windows-only file-link refusals (R-CNV-12). The webview
  // treats a missing value as Windows (stricter) and never infers it from its own navigator.
  | { type: "init"; protocolVersion: number; tabs: TabSnapshot[]; hostWindows?: boolean; systemAppExtensions?: string[] }
  | { type: "events"; tabId: string; events: NormalizedEvent[] }
  // 判別ユニオンで isResumeHydrationStateMessage と同じ制約を型に持たせる。
  | {
      type: "resumeHydrationState";
      tabId: string;
      phase: Exclude<ResumeHydrationPhase, "failed">;
      // 最初の描画の後に表示専用の preview を追送する欄。tabCreated と tabCleared を二度送らない。
      previewMessages?: ResumePreviewMessage[];
    }
  | {
      type: "resumeHydrationState";
      tabId: string;
      phase: "failed";
      reason?: string;
    }
  | {
      type: "resumeHydrationState";
      tabId: string;
      phase?: undefined;
      reason?: undefined;
      displayEvent: ResumeHydrationDisplayEvent;
      sendDisposition?: ResumeHydrationSendDisposition;
    }
  | {
      type: "resumeHydrationState";
      tabId: string;
      phase?: undefined;
      reason?: undefined;
      displayEvent?: undefined;
      sendDisposition: ResumeHydrationSendDisposition;
    }
  // R-HND-08: activate が false になるのは、src/handoff-runner.ts#shouldActivateForkTab が偽を返した引き継ぎタブと、
  // src/extension.ts#restorePersistedTabs が起動時に復元する先頭以外のタブだけ。他の生産者は true を送る。
  | { type: "tabCreated"; tab: TabSnapshot; activate: boolean }
  | { type: "tabClosed"; tabId: string }
  | { type: "activateTab"; tabId: string }
  // webview はタブを同じ位置で置き換える。
  | { type: "tabCleared"; tab: TabSnapshot }
  // init で deferred として送ったタブの中身。受け側は tabCleared と同じ手順で、並びとアクティブ選択を保ったまま作り直す。
  | { type: "tabRestored"; tab: TabSnapshot }
  | { type: "tabRenamed"; tabId: string; title: string }
  // 要約と逐語の本文は載せない。webview が展開したときだけ getHandoffDetail で取りに行く。
  | {
      type: "handoffStatus";
      tabId: string;
      runId: string;
      state: "running" | "failed" | "done";
      phase?: string;
      // compact 中の心拍ごとに載る。since は elapsedMs の起点。
      progress?: { heartbeats: number; elapsedMs: number; since: "compact_start" | "result" };
      reason?: string;
      detail?: string;
      message: string;
      source: { sessionId: string; title: string };
      fork?: { sessionId: string; tabId: string; title: string };
      compact?: { preTokens: number; postTokens: number };
      utteranceCount?: number;
      // JSON として読めず捨てた行数。0 は載せない。
      unreadableLineCount?: number;
      // R-HND-11 / R-HND-12: 件数だけ。本文は handoffDetail の part 0 が運ぶ。
      decisions?: {
        total: number;
        carried: number;
        extracted: number;
        removed: number;
        unknownIdRefs: number;
        warn?: { entries: number; bytes: number };
      };
    }
  // 1 通を src/handoff-runner.ts#HANDOFF_DETAIL_MAX_BYTES 以下に分ける。summary は part 0 だけが運ぶ。
  // total が 0 なのは記録を読めなかった印で、webview はその旨を出す。
  | {
      type: "handoffDetail";
      tabId: string;
      runId: string;
      part: number;
      total: number;
      summary?: string;
      utterances: { n: number; at: string; kind: "typed" | "answer"; text: string; questions?: string[] }[];
      // summary と同じく part 0 だけが運ぶ。
      decisions?: HandoffDecisions;
    }
  | { type: "modeChanged"; tabId: string; mode: PermissionModeId }
  | { type: "commands"; tabId: string; commands: SlashCommandInfo[] }
  | {
      type: "models";
      tabId: string;
      models: ModelInfo[];
    }
  // R-DSP-01: notice は Host が適用と保存を終えた後の結果文。webview は選択直後に自前で保存済みを出さない。
  | { type: "modelChanged"; tabId: string; model: string | null; notice?: string; applied?: boolean }
  | { type: "effortChanged"; tabId: string; effort: string | null; notice?: string }
  | { type: "configuredEffortChanged"; tabId: string; effort: string | null; model?: string | null; defaultEffort?: string | null; appliedModel?: string | null; appliedEffort?: string | null }
  | { type: "files"; reqId: number; paths: string[] }
  // キャンセルでも paths と images を空にして返す（無応答にしない）。
  | { type: "pickedFiles"; reqId: number; paths: string[]; images: ImageAttachment[] }
  // 差分ではなく毎回全量を送り、webview は置き換えるだけにする。
  | { type: "attachments"; tabId: string; items: PendingAttachmentInfo[] }
  // requestId は listSessions 要求ごとに増え、受け側は新しい実行より小さい requestId の行を捨てる。
  // complete が偽の到着は確認中で、全件ではない（部分応答を 0 件の根拠にしない）。
  // degraded は件数が本物でないことだけを運ぶ。complete を偽にして逃がさない（受け側が読み込み中を出し続ける）。
  | { type: "sessions"; source?: "laisora" | "claude"; nextCursor?: string; append?: boolean; requestId: number; sessions: SessionListItem[]; complete: boolean; degraded?: SessionScanDegradation }
  | { type: "analysis"; sessionId: string; filePath: string; report: unknown }
  // R-ANL-11: src/webview/main.ts#showAnalysisFailure が操作元の画面へ理由を描く。要求元の面だけへ返す（全面へ配ると別タブの分析画面に理由が出る）。
  // kind は失敗した要求で分かれ、script は analyzeCurrent、action は所見からの操作。
  | { type: "analysisFailed"; kind: "script" | "action"; tabId?: string; reason?: string }
  | { type: "composerPrefill"; tabId: string; text: string }
  | { type: "editorContext"; path: string; startLine: number; endLine: number }
  // snapshot が運ぶものと同じ projectWorkModel の出力。live の更新だけをこの経路で送る。
  | { type: "workModel"; tabId: string; model: WorkModelPayload }
  | { type: "semanticModel"; tabId: string; model: SemanticModelPayload }
  | { type: "llmAnalysisSetting"; enabled: boolean }
  // snapshot には載せない。ready の応答と設定変更の後に送る。
  | { type: "userSettings"; appearance?: AccentSettings; composerSendKey: ComposerSendKey }
  // 保存される event にしない。
  | { type: "tabNotice"; tabId: string; text: string }
  // running は snapshot の llmAnalysisRunning と同じ値。failure の limit はタイムアウト以外では欠ける。
  // R-ANL-11: refusal は実行を始めなかった理由で、failure と同居しない。未実行を分析結果として描かせないための別の欄。
  | {
      type: "llmAnalysisRunState";
      tabId: string;
      running: boolean;
      progress?: LlmAnalysisRunProgress;
      failure?: {
        reason: string;
        limit?: "per_call" | "total";
        elapsedMs: number;
        attemptedCalls: number;
        completedCalls: number;
        plannedCalls: number;
      };
      refusal?: string;
    }
  // R-DSP-25: failure の通知も既存の summary を運ぶので、保存済みの要約を消さない。saveFailed のときは保存済みと表示しない（R-DSP-01）。
  | { type: "sessionSummary"; tabId: string; running: boolean; summary?: { text: string; model: string }; saveFailed?: boolean; failure?: string }
  | { type: "sessionNameSuggestion"; tabId: string; title: string }
  | { type: "sessionNameSuggestion"; tabId: string; reason: string }
  | { type: "llmFindingDiagnostics"; tabId: string; payload: LlmFindingDiagnosticsPayload }
  | {
      type: "agentInspectorResult";
      tabId: string;
      agentId: string;
      requestId: string;
      generation: number;
      fingerprint: { size: number; mtimeMs: number };
      page: AgentInspectorPage;
    }
  | {
      type: "agentInspectorError";
      tabId: string;
      agentId: string;
      requestId: string;
      generation: number;
      reason: AgentInspectorErrorReason;
    }
  // 保存される event へ入れない: 入れると src/event-fold.ts#EVENT_LOG_MAX を跨いで coverage が反転する。
  // generation は照合に使わない（CLI の再起動で世代だけ進んでも登録は生きている）。破棄は requestId で判定する。
  | {
      type: "historyChunkResult";
      tabId: string;
      requestId: string;
      generation: number;
      page: HistoryChunkPagePayload;
    }
  | {
      type: "historyChunkError";
      tabId: string;
      requestId: string;
      generation: number;
      reason: HistoryChunkErrorReason;
    }
  // R-TAB-07。破棄は historyChunkResult と同じく requestId で判定する。
  | {
      type: "worklogTranscriptResult";
      tabId: string;
      requestId: string;
      generation: number;
      page: HistoryChunkPagePayload;
    }
  | {
      type: "worklogTranscriptError";
      tabId: string;
      requestId: string;
      generation: number;
      reason: HistoryChunkErrorReason;
    }
  // historyChunkResult と同じく、保存される event へ入れず、破棄は requestId で判定する。
  | {
      type: "conversationHistoryResult";
      tabId: string;
      requestId: string;
      generation: number;
      page: ConversationHistoryPagePayload;
    }
  | {
      type: "conversationHistoryError";
      tabId: string;
      requestId: string;
      generation: number;
      reason: ConversationHistoryErrorReason;
    }
  | {
      type: "sessionImageResult";
      tabId: string;
      requestId: string;
      mediaType: ImageAttachment["mediaType"];
      data: string;
    }
  | {
      type: "sessionImageError";
      tabId: string;
      requestId: string;
      reason: "not-found" | "read-failed" | "invalid-request";
    }
  // CLI が ~/.claude.json に残す cachedUsageUtilization から読む（src/session-files.ts#readCachedUsage）。
  | {
      type: "cachedUsage";
      fetchedAtMs: number;
      limits: Array<{ type: string; utilization: number; resetsAt: number | null }>;
    }
  | {
      type: "analysisPersistenceState";
      tabId: string;
      artifactId: string;
      persistence: PersistenceState;
      persistenceLabel: string;
    };

export interface TabSnapshot {
  tabId: string;
  title: string;
  // R-TAB-08 / R-CNV-02: 空の events は 0 件の主張ではなく、受け側は読み込み中を出す（verify-webview-wiring#sol-13d）。中身は tabRestored で後から届く。
  deferred?: true;
  state: ConversationSnapshot;
}

export interface ConversationSnapshot {
  conversationId: string | null;
  cwd: string;
  turnState: "idle" | "running" | "interrupting";
  auth: AuthStatus | null;
  // 接続前の表示用。auth が届いたらそちらを優先する。
  configModel?: string;
  configEffort?: string;
  // 設定に effort が無いとき、実行中 CLI が既定として使う effort（get_settings の applied.effort）
  defaultEffort?: string;
  // 実行中 CLI が次のリクエストで使う model（get_settings の applied.model）。resume では記録の model で、configModel より優先する
  appliedModel?: string;
  modelFallback?: ModelFallbackState;
  // get_settings の applied.effort。null = CLI が effort を送らない。configEffort / defaultEffort はこれと一致するときだけ立つ
  appliedEffort?: string | null;
  recordedModel?: string;
  permissionMode: PermissionModeId;
  commands?: SlashCommandInfo[];
  models?: ModelInfo[];
  // null は既定モデルへの上書き。
  modelOverride?: string | null;
  effortOverride?: string | null;
  resumeSessionId?: string;
  resumeFilePath?: string;
  handoffSource?: {
    sessionId: string;
    title?: string;
    compact?: { preTokens: number; postTokens: number };
    utteranceCount?: number;
    detailRunId?: string;
    // R-HND-11: 消した行を含む決定行の本数。無いと、復元したカードが決定行の展開部を作れない。
    decisionCount?: number;
  };
  resumeHydration?: ResumeHydrationSnapshotState;
  // webview にイベントの再 fold で作らせない。
  workModel?: WorkModelPayload;
  planUsage?: import("./plan-usage").PlanUsage;
  // undefined（未着）と false（設定で明示 off）を同一視しない。true で semanticModel が無ければ未着か導出失敗。
  semanticView?: boolean;
  semanticModel?: SemanticModelPayload;
  llmAnalysisEnabled?: boolean;
  llmAnalysisRunning?: boolean;
  // 実行中でも最初の呼び出し通知の前は無い。elapsedMs は snapshot の時点まで Host の時計で進めて渡す。
  llmAnalysisProgress?: LlmAnalysisRunProgress;
  // R-DSP-25: 無ければ webview は最初のプロンプトを表示する。
  sessionSummary?: { text: string; model: string };
  sessionSummaryRunning?: boolean;
  // 診断設定と分析設定の両方が on のときだけ true。false なら webview は診断パネルを DOM ごと外す。undefined は semanticView と同じく未着。
  llmDiagnostics?: boolean;
  // 省略した snapshot にだけ載せる（0 件を載せると省略なしの表現が二通りになる）。受け側は窓落ちとして数えて遡る（verify-webview-wiring#sol-15c）。
  // count は src/event-window.ts#windowEvents の droppedCount と同じ正味の件数。backfilledHead なら events の先頭は戻した turn_started で、次の要素と連続しない。
  headOmitted?: { count: number; hasConvEvent: boolean; backfilledHead: boolean };
  // R-SES-02: Host が全イベントを畳んだ背景側の現在値。webview は再生の後にこれで置き換える。空は活動なしの確定値。
  backgroundActivity?: BackgroundActivitySnapshot;
  events: NormalizedEvent[];
}

export function isWebviewToHost(v: unknown): v is WebviewToHost {
  if (typeof v !== "object" || v === null) return false;
  // as は網羅の検査のために静的型を絞るだけで、実行時の値は各分岐が検査する。
  const t = (v as { type?: unknown }).type as WebviewToHost["type"];
  const tabId = (v as { tabId?: unknown }).tabId;

  if (t === "ready") {
    const c = (v as { cursor?: unknown }).cursor;
    if (c === null || c === undefined) return true;
    return (
      typeof c === "object" &&
      typeof (c as { generation?: unknown }).generation === "number" &&
      typeof (c as { seq?: unknown }).seq === "number"
    );
  }
  if (t === "webviewDiagnostic") {
    const diagnostic = v as { kind?: unknown; message?: unknown };
    return (diagnostic.kind === "error" || diagnostic.kind === "ready-retry" ||
      diagnostic.kind === "first-paint" || diagnostic.kind === "orphan-turn-adopted") &&
      typeof diagnostic.message === "string" && diagnostic.message.length > 0 &&
      diagnostic.message.length <= 2000;
  }
  if (t === "newTab") return true;
  if (t === "setMode") {
    return (
      typeof tabId === "string" &&
      (PERMISSION_MODES as string[]).includes((v as { mode?: unknown }).mode as string)
    );
  }
  if (t === "setModel") {
    const model = (v as { model?: unknown }).model;
    const sessionOnly = (v as { sessionOnly?: unknown }).sessionOnly;
    return (
      (sessionOnly === undefined || typeof sessionOnly === "boolean") &&
      typeof tabId === "string" &&
      (model === null || (typeof model === "string" && model.length <= 100))
    );
  }
  if (t === "listSessions") {
    const q = v as { source?: unknown; cursor?: unknown };
    return (q.source === undefined || q.source === "laisora" || q.source === "claude") &&
      (q.cursor === undefined || (typeof q.cursor === "string" && /^\d+:\d+$/.test(q.cursor)));
  }
  if (t === "openFile") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "target"]);
    // R-CNV-12: reject payload smuggling and unbounded model-authored targets before Host path resolution.
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.tabId === "string" &&
      message.tabId.length > 0 &&
      message.tabId.length <= 200 &&
      typeof message.target === "string" &&
      message.target.length > 0 &&
      message.target.length <= FILE_LINK_TARGET_MAX_LEN &&
      !message.target.includes("\0")
    );
  }
  if (t === "exportTab") return typeof tabId === "string";
  if (t === "renameTab") {
    const title = (v as { title?: unknown }).title;
    return typeof tabId === "string" && typeof title === "string" && title.trim().length > 0 && title.length <= RENAME_TITLE_MAX;
  }
  if (t === "analyzeCurrent") return typeof tabId === "string";
  if (t === "suggestSessionName") return typeof tabId === "string" &&
    Object.keys(v).every(key => key === "type" || key === "tabId");
  if (t === "summarizeSession") return typeof tabId === "string";
  if (t === "openThemePicker") return true;
  if (t === "runHostAction") {
    const m = v as Record<string, unknown>;
    const action = m.action;
    if (!(HOST_ACTIONS as readonly string[]).includes(action as string)) return false;
    if (action === "addClaudeModel") return typeof tabId === "string" && tabId.length > 0
      && Object.keys(m).every((key) => key === "type" || key === "action" || key === "tabId");
    return Object.keys(m).every((key) => key === "type" || key === "action");
  }
  if (t === "requestCachedUsage") return true;
  if (t === "agentInspectorRequest") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "agentId", "section", "requestId", "cursor"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.tabId === "string" && message.tabId.length > 0 && message.tabId.length <= 200 &&
      typeof message.agentId === "string" && message.agentId.length > 0 && message.agentId.length <= 200 &&
      ["overview", "tools", "messages", "report"].includes(message.section as string) &&
      typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 100 &&
      (message.cursor === undefined ||
        (typeof message.cursor === "string" && message.cursor.length > 0 && message.cursor.length <= 512))
    );
  }
  if (t === "historyChunkRequest") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "requestId", "cursor", "anchor"]);
    if (!Object.keys(message).every((key) => allowed.has(key))) return false;
    if (typeof message.tabId !== "string" || message.tabId.length === 0 || message.tabId.length > 200) {
      return false;
    }
    if (
      typeof message.requestId !== "string" ||
      message.requestId.length === 0 ||
      message.requestId.length > 100
    ) {
      return false;
    }
    // 両方載せた要求を通すと、どちらを起点にするかで返る chunk が変わる（欠落・重複の入口）
    if ((message.cursor === undefined) === (message.anchor === undefined)) return false;
    if (message.cursor !== undefined) {
      return (
        typeof message.cursor === "string" && message.cursor.length > 0 && message.cursor.length <= 512
      );
    }
    if (typeof message.anchor !== "object" || message.anchor === null) return false;
    const anchor = message.anchor as Record<string, unknown>;
    return (
      Object.keys(anchor).length === 2 &&
      Number.isInteger(anchor.generation) &&
      Number.isInteger(anchor.seq)
    );
  }
  if (t === "worklogTranscriptRequest") {
    const message = v as Record<string, unknown>;
    const allowedKeys = new Set(["type", "tabId", "requestId", "cursor", "anchor"]);
    if (!Object.keys(message).every((key) => allowedKeys.has(key))) return false;
    if (typeof message.tabId !== "string" || message.tabId.length === 0 || message.tabId.length > 200) {
      return false;
    }
    if (
      typeof message.requestId !== "string" ||
      message.requestId.length === 0 ||
      message.requestId.length > 100
    ) {
      return false;
    }
    if (message.cursor !== undefined && message.anchor !== undefined) return false;
    if (message.cursor !== undefined) {
      return (
        typeof message.cursor === "string" && message.cursor.length > 0 && message.cursor.length <= 512
      );
    }
    if (message.anchor !== undefined) {
      if (typeof message.anchor !== "object" || message.anchor === null) return false;
      const anchor = message.anchor as Record<string, unknown>;
      return (
        Object.keys(anchor).length === 2 &&
        Number.isInteger(anchor.generation) &&
        Number.isInteger(anchor.seq)
      );
    }
    return true;
  }
  if (t === "llmAnalysisRequest") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.tabId === "string" &&
      message.tabId.length > 0 &&
      message.tabId.length <= 200
    );
  }
  if (t === "setLlmAnalysisEnabled") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "enabled"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.enabled === "boolean"
    );
  }
  if (t === "conversationHistoryRequest") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "requestId", "cursor", "anchorUuid"]);
    if (!Object.keys(message).every((key) => allowed.has(key))) return false;
    if (typeof message.tabId !== "string" || message.tabId.length === 0 || message.tabId.length > 200) {
      return false;
    }
    if (
      typeof message.requestId !== "string" ||
      message.requestId.length === 0 ||
      message.requestId.length > 100
    ) {
      return false;
    }
    // 両方載せた要求を通すと、どちらを起点にするかで返る chunk が変わる（欠落・重複の入口）
    if (message.cursor !== undefined && message.anchorUuid !== undefined) return false;
    if (
      message.cursor !== undefined &&
      !(typeof message.cursor === "string" && message.cursor.length > 0 && message.cursor.length <= 512)
    ) {
      return false;
    }
    return (
      message.anchorUuid === undefined ||
      (typeof message.anchorUuid === "string" &&
        message.anchorUuid.length > 0 &&
        message.anchorUuid.length <= 100)
    );
  }
  if (t === "sessionImageRequest") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "requestId", "ref"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.tabId === "string" &&
      message.tabId.length > 0 &&
      message.tabId.length <= 200 &&
      typeof message.requestId === "string" &&
      message.requestId.length > 0 &&
      message.requestId.length <= 100 &&
      isSessionImageRef(message.ref)
    );
  }
  if (t === "openSessionImage") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "ref", "inline"]);
    if (
      !Object.keys(message).every((key) => allowed.has(key)) ||
      typeof message.tabId !== "string" ||
      message.tabId.length === 0 ||
      message.tabId.length > 200
    ) {
      return false;
    }
    const hasRef = message.ref !== undefined;
    const hasInline = message.inline !== undefined;
    if (hasRef === hasInline) return false;
    if (hasRef) {
      return isSessionImageRef(message.ref);
    }
    if (typeof message.inline !== "object" || message.inline === null) return false;
    const inl = message.inline as Record<string, unknown>;
    const inlineAllowed = new Set(["mediaType", "data"]);
    return (
      Object.keys(inl).every((key) => inlineAllowed.has(key)) &&
      ALLOWED_IMAGE_MEDIA_TYPES.includes(inl.mediaType as ImageAttachment["mediaType"]) &&
      typeof inl.data === "string" &&
      inl.data.length > 0 &&
      inl.data.length <= IMAGE_MAX_BASE64_LEN
    );
  }
  if (t === "artifact/preview") {
    const message = v as { lang?: unknown; content?: unknown; artifactId?: unknown };
    return (
      (message.lang === "html" || message.lang === "svg") &&
      typeof message.content === "string" &&
      message.content.length <= 1_000_000 &&
      (message.artifactId === undefined ||
        (typeof message.artifactId === "string" &&
          message.artifactId.length > 0 &&
          message.artifactId.length <= 100))
    );
  }
  if (t === "resumeSession") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "sessionId", "filePath", "intoTabId"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.sessionId === "string" &&
      SESSION_ID_RE.test(message.sessionId) &&
      typeof message.filePath === "string" &&
      (message.intoTabId === undefined || typeof message.intoTabId === "string")
    );
  }
  if (t === "resumeHydrationRetry") {
    const message = v as Record<string, unknown>;
    return (
      Object.keys(message).length === 2 &&
      typeof message.tabId === "string"
    );
  }
  if (t === "activeTab") return typeof tabId === "string";
  if (t === "setEffort") {
    const effort = (v as { effort?: unknown }).effort;
    return (
      typeof tabId === "string" &&
      (effort === null || ["low", "medium", "high", "xhigh", "max"].includes(effort as string))
    );
  }
  if (t === "queryFiles") {
    return (
      typeof (v as { reqId?: unknown }).reqId === "number" &&
      typeof (v as { query?: unknown }).query === "string" &&
      (v as { query: string }).query.length <= 200
    );
  }
  if (t === "pickFiles") {
    // R-CNV-05: IMAGE_MAX_COUNT の上限を外すと Host が超過した images を返し、isHostToWebview が pickedFiles ごと落として、
    // 選んだパスが入力欄へ入らない。整数・非負の検査が守る要件は特定できていない。
    const slots = (v as { imageSlots?: unknown }).imageSlots;
    return (
      typeof (v as { reqId?: unknown }).reqId === "number" &&
      typeof slots === "number" &&
      Number.isInteger(slots) &&
      slots >= 0 &&
      slots <= IMAGE_MAX_COUNT
    );
  }
  if (t === "closeTab") return typeof tabId === "string";
  if (t === "clearTab") return typeof tabId === "string";
  if (t === "startHandoff") return typeof tabId === "string";
  if (t === "cancelHandoff") {
    return typeof tabId === "string" && typeof (v as { runId?: unknown }).runId === "string";
  }
  if (t === "getHandoffDetail") {
    const part = (v as { part?: unknown }).part;
    return (
      typeof tabId === "string" &&
      typeof (v as { runId?: unknown }).runId === "string" &&
      typeof part === "number" &&
      Number.isInteger(part) &&
      part >= 0
    );
  }
  if (t === "openHandoffSource") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "sourceSessionId"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof tabId === "string" &&
      typeof message.sourceSessionId === "string" &&
      SESSION_ID_RE.test(message.sourceSessionId)
    );
  }
  if (t === "send") {
    const message = v as Record<string, unknown>;
    // R-CNV-11: images を許可キーに戻さない（verify-attachment#AT-08）。戻すと押した瞬間の activeTabId 宛てに webview の手持ちが載り、
    // 添付が別の会話へ入る。
    const allowed = new Set(["type", "tabId", "text", "clientToken"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof tabId === "string" &&
      typeof message.text === "string" &&
      message.text.length <= SEND_TEXT_MAX_LEN &&
      (message.clientToken === undefined || typeof message.clientToken === "string")
    );
  }
  if (t === "attachImage") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "mediaType", "data"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof tabId === "string" &&
      ALLOWED_IMAGE_MEDIA_TYPES.includes(message.mediaType as ImageAttachment["mediaType"]) &&
      typeof message.data === "string" &&
      message.data.length > 0 &&
      message.data.length <= IMAGE_MAX_BASE64_LEN
    );
  }
  if (t === "removeAttachment") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "attachmentId"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof tabId === "string" &&
      typeof message.attachmentId === "string" &&
      ATTACHMENT_ID_RE.test(message.attachmentId)
    );
  }
  if (t === "cancelAutoResume") return typeof tabId === "string" && hasOnlyKeys(v as Record<string, unknown>, ["type", "tabId"]);
  if (t === "interrupt") return typeof tabId === "string";
  if (t === "approvalDecision") {
    const m = v as { requestId?: unknown; behavior?: unknown; answers?: unknown };
    if (
      typeof tabId !== "string" ||
      typeof m.requestId !== "string" ||
      (m.behavior !== "allow" && m.behavior !== "deny")
    ) {
      return false;
    }
    if (m.answers === undefined) return true;
    if (typeof m.answers !== "object" || m.answers === null) return false;
    // キー数の上限は SDK の AskUserQuestionInput が許す質問数より大きく取り、キーの水増しを拒む。
    const entries = Object.entries(m.answers as Record<string, unknown>);
    if (entries.length > 8) return false;
    return entries.every(
      ([k, val]) =>
        typeof k === "string" &&
        k.length > 0 &&
        k.length <= 2000 &&
        typeof val === "string" &&
        val.length <= 10_000
    );
  }
  if (t === "startFindingSession") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "findingId", "analysisRunId", "semanticHash"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.tabId === "string" && message.tabId.length > 0 && message.tabId.length <= 200 &&
      typeof message.findingId === "string" && message.findingId.length > 0 && message.findingId.length <= 200 &&
      typeof message.analysisRunId === "string" && message.analysisRunId.length > 0 && message.analysisRunId.length <= 200 &&
      typeof message.semanticHash === "string" && message.semanticHash.length > 0 && message.semanticHash.length <= 200
    );
  }
  if (t === "prepareHistoricalDraft") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "artifactId", "findingId"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.tabId === "string" && message.tabId.length > 0 && message.tabId.length <= 200 &&
      typeof message.artifactId === "string" && message.artifactId.length > 0 && message.artifactId.length <= 200 &&
      typeof message.findingId === "string" && message.findingId.length > 0 && message.findingId.length <= 200
    );
  }
  if (t === "selectAnalysisArtifact") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "artifactId"]);
    return (
      Object.keys(message).every((key) => allowed.has(key)) &&
      typeof message.tabId === "string" && message.tabId.length > 0 && message.tabId.length <= 200 &&
      typeof message.artifactId === "string" && message.artifactId.length > 0 && message.artifactId.length <= 200
    );
  }
  // バリアントを足して分岐を忘れると tsc がここで落ちる。
  t satisfies never;
  return false;
}

function isArrayOf(value: unknown, check: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && (value as unknown[]).every(check);
}

function isOptionalArrayOf(value: unknown, check: (item: unknown) => boolean): boolean {
  return value === undefined || isArrayOf(value, check);
}

function isAgentInspectorCoverage(value: unknown): value is AgentInspectorCoverage {
  if (typeof value !== "object" || value === null) return false;
  const coverage = value as Record<string, unknown>;
  return (
    (coverage.state === "complete" || coverage.state === "partial") &&
    isNumber(coverage.returnedRecords) && isNumber(coverage.bytesRead) && isNumber(coverage.fileSize) &&
    isNumber(coverage.malformedRecordCount) && isNumber(coverage.skippedRecordCount) &&
    isArrayOf(coverage.truncatedReasons, (reason) =>
      ["read-limit", "record-limit", "malformed-record", "meta-limit", "preview-limit", "response-limit"]
        .includes(reason as string)) &&
    (coverage.previewTruncatedCount === undefined || isNumber(coverage.previewTruncatedCount))
  );
}

function isAgentInspectorPage(value: unknown): value is AgentInspectorPage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  if (!isAgentInspectorCoverage(page.coverage)) return false;
  if (page.nextCursor !== undefined && typeof page.nextCursor !== "string") return false;
  if (page.section === "overview") {
    if (typeof page.overview !== "object" || page.overview === null) return false;
    const overview = page.overview as Record<string, unknown>;
    return typeof overview.description === "string" && typeof overview.instruction === "string";
  }
  if (page.section === "tools") {
    return isArrayOf(page.tools, (item) => {
      if (typeof item !== "object" || item === null) return false;
      const tool = item as Record<string, unknown>;
      return typeof tool.toolUseId === "string" && typeof tool.toolName === "string" &&
        typeof tool.inputPreview === "string" && isOptionalString(tool.resultPreview);
    });
  }
  if (page.section === "messages") {
    return isArrayOf(page.messages, (item) => {
      if (typeof item !== "object" || item === null) return false;
      const message = item as Record<string, unknown>;
      return (message.role === "user" || message.role === "assistant") && typeof message.text === "string";
    });
  }
  return page.section === "report" && typeof page.text === "string";
}

function isHistoryChunkCoverage(value: unknown): value is HistoryChunkCoveragePayload {
  if (typeof value !== "object" || value === null) return false;
  const coverage = value as Record<string, unknown>;
  return (
    isNumber(coverage.returnedCount) && isNumber(coverage.remainingOlderCount) &&
    typeof coverage.oldestReached === "boolean" && isNumber(coverage.snapExtendedBy)
  );
}

function isHistoryChunkPage(value: unknown): value is HistoryChunkPagePayload {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  if (!isHistoryChunkCoverage(page.coverage)) return false;
  if (page.nextCursor !== undefined && typeof page.nextCursor !== "string") return false;
  if (typeof page.hasMore !== "boolean") return false;
  return isArrayOf(page.items, isPlausibleNormalizedEvent);
}

export const ALLOWED_IMAGE_MEDIA_TYPES: readonly ImageAttachment["mediaType"][] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export function isSessionImageRef(v: unknown): v is SessionImageRef {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0) return false;
  if (r.kind === "record") {
    // uuid は Host 側で globalStorage 配下のファイル名へ連結される。長さだけを見ていると
    // `..` を含む値が境界を通り、書き出し先が images/ の外へ出る。実データは corpus 14,888 件
    // すべてが [A-Za-z0-9_-]・最大 36 文字（2026-09-04 実測）
    return (
      typeof r.uuid === "string" &&
      r.uuid.length > 0 &&
      r.uuid.length <= 100 &&
      /^[A-Za-z0-9_-]+$/.test(r.uuid) &&
      Object.keys(r).length === 3
    );
  }
  if (r.kind === "event") {
    return (
      typeof r.generation === "number" &&
      Number.isInteger(r.generation) &&
      typeof r.seq === "number" &&
      Number.isInteger(r.seq) &&
      Object.keys(r).length === 4
    );
  }
  return false;
}

export function isImageRefInfo(v: unknown): v is ImageRefInfo {
  if (typeof v !== "object" || v === null) return false;
  const info = v as Record<string, unknown>;
  return (
    ALLOWED_IMAGE_MEDIA_TYPES.includes(info.mediaType as ImageAttachment["mediaType"]) &&
    isSessionImageRef(info.ref) &&
    Object.keys(info).length === 2
  );
}

export function isImageRefInfoArray(v: unknown): v is ImageRefInfo[] {
  return Array.isArray(v) && v.every(isImageRefInfo);
}

// Host が切って送る src/history-serving.ts#CONVERSATION_TEXT_MAX 以上に保つ。下回ると正当な応答を捨て、外すと 1 chunk で postMessage を詰まらせる。
const CONVERSATION_TEXT_MAX = 20000;
const CONVERSATION_ITEMS_MAX = 500;

function isConversationHistoryMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.uuid === "string" && m.uuid.length > 0 && m.uuid.length <= 100 &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.text === "string" && m.text.length <= CONVERSATION_TEXT_MAX &&
    typeof m.timestamp === "number" &&
    (m.imageRefs === undefined || isImageRefInfoArray(m.imageRefs)) &&
    (m.model === undefined || (typeof m.model === "string" && m.model.length > 0))
  );
}

function isConversationHistoryPage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  const coverage = page.coverage as Record<string, unknown> | undefined;
  if (typeof coverage !== "object" || coverage === null) return false;
  if (
    typeof coverage.returnedCount !== "number" ||
    typeof coverage.remainingOlderCount !== "number" ||
    typeof coverage.oldestReached !== "boolean"
  ) {
    return false;
  }
  if (coverage.malformedLineCount !== undefined && !isNumber(coverage.malformedLineCount)) return false;
  if (coverage.droppedWithoutUuidCount !== undefined && !isNumber(coverage.droppedWithoutUuidCount)) return false;
  if (page.nextCursor !== undefined && typeof page.nextCursor !== "string") return false;
  if (typeof page.hasMore !== "boolean") return false;
  if (!Array.isArray(page.items) || page.items.length > CONVERSATION_ITEMS_MAX) return false;
  return (page.items as unknown[]).every(isConversationHistoryMessage);
}

function isWorkTaskItemView(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const task = item as Record<string, unknown>;
  return (
    typeof task.taskKey === "string" &&
    typeof task.description === "string" &&
    isOptionalString(task.activeForm) &&
    TASK_STATUSES.includes(task.status as string)
  );
}

function isWorkTaskTotalsView(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const totals = item as Record<string, unknown>;
  return (
    typeof totals.taskKey === "string" &&
    isNumber(totals.toolCount) &&
    isNumber(totals.failCount) &&
    isNumber(totals.childFailCount) &&
    isNumber(totals.elapsedMs) &&
    isNumber(totals.agentTokens)
  );
}

// 詳細ログはこの値だけで描くので、形が違う event は events ごと落とす。緩めると配置不明のまま描画へ進み、DOM 側の推測が復活する。
export function isWorkEventInfo(v: unknown): v is WorkEventInfo {
  if (typeof v !== "object" || v === null) return false;
  const info = v as Record<string, unknown>;
  if (!isNumber(info.revision)) return false;
  // null は segment が閉じた印。isOptionalString は null を弾くので使わない。
  if (info.currentSegmentId !== undefined && info.currentSegmentId !== null) {
    if (typeof info.currentSegmentId !== "string") return false;
  }
  if (info.placement !== undefined) {
    if (typeof info.placement !== "object" || info.placement === null) return false;
    const placement = info.placement as Record<string, unknown>;
    if (typeof placement.phaseId !== "string" || typeof placement.counted !== "boolean") return false;
    if (!isOptionalString(placement.segmentId) || !isOptionalString(placement.taskKey)) return false;
    if (!isOptionalString(placement.ownerToolUseId)) return false;
  }
  return (
    isOptionalArrayOf(info.segments, (item) => {
      if (typeof item !== "object" || item === null) return false;
      const segment = item as Record<string, unknown>;
      return (
        typeof segment.segmentId === "string" &&
        typeof segment.phaseId === "string" &&
        isOptionalString(segment.taskKey) &&
        isNumber(segment.toolCount) &&
        isNumber(segment.failCount) &&
        isNumber(segment.childFailCount) &&
        isNumber(segment.elapsedMs) &&
        isNumber(segment.runningCount) &&
        isNumber(segment.staleCount) &&
        isNumber(segment.revision)
      );
    }) &&
    isOptionalArrayOf(info.agents, (item) => {
      if (typeof item !== "object" || item === null) return false;
      const agent = item as Record<string, unknown>;
      return (
        typeof agent.toolUseId === "string" &&
        (agent.runStartedAt === undefined || isNumber(agent.runStartedAt)) &&
        (WORK_STATUSES as string[]).includes(agent.status as string) &&
        isNumber(agent.childCount) &&
        isNumber(agent.failCount) &&
        isNumber(agent.elapsedMs) &&
        (agent.tokens === undefined || isNumber(agent.tokens)) &&
        isOptionalString(agent.modelMeasured) &&
        isNumber(agent.revision)
      );
    }) &&
    isOptionalArrayOf(info.taskTotals, isWorkTaskTotalsView) &&
    isOptionalArrayOf(info.tasks, isWorkTaskItemView) &&
    isOptionalArrayOf(info.staled, (item) => typeof item === "string") &&
    (info.pendingApprovalCount === undefined || isNumber(info.pendingApprovalCount)) &&
    (info.turnToolCount === undefined || isNumber(info.turnToolCount))
  );
}

function isPlausibleNormalizedEvent(x: unknown): x is NormalizedEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  if (
    typeof e.backendId !== "string" ||
    e.backendId.length === 0 ||
    typeof e.conversationId !== "string" ||
    typeof e.generation !== "number" ||
    typeof e.seq !== "number" ||
    typeof e.timestamp !== "number" ||
    typeof e.kind !== "string" ||
    (e.kind as string).length === 0 ||
    (e.work !== undefined && !isWorkEventInfo(e.work))
  ) {
    return false;
  }
  if (e.kind === "model_refusal_fallback") {
    if (typeof e.originalModel !== "string" || typeof e.fallbackModel !== "string" ||
      (e.scope !== "session" && e.scope !== "local") ||
      (e.turnId !== null && typeof e.turnId !== "string") ||
      (e.category !== null && typeof e.category !== "string") ||
      (e.explanation !== null && typeof e.explanation !== "string") ||
      (e.refusedUserMessageUuid !== null && typeof e.refusedUserMessageUuid !== "string") || typeof e.message !== "string" ||
      (e.autoRevert !== undefined && !(FALLBACK_AUTO_REVERT_STARTS as readonly unknown[]).includes(e.autoRevert))) return false;
  }
  if (e.kind === "model_fallback_revert") {
    if ((e.turnId !== null && typeof e.turnId !== "string") || typeof e.originalModel !== "string" ||
      !(FALLBACK_REVERT_OUTCOMES as readonly unknown[]).includes(e.outcome)) return false;
  }
  if (e.kind === "user_message") {
    if (e.imageRefs !== undefined && !isImageRefInfoArray(e.imageRefs)) {
      return false;
    }
  }
  if (e.kind === "replayed_message") {
    if (e.imageRefs !== undefined && !isImageRefInfoArray(e.imageRefs)) {
      return false;
    }
    if (e.model !== undefined && (typeof e.model !== "string" || e.model.length === 0)) {
      return false;
    }
  }
  if (e.kind === "compact_boundary") {
    if (e.trigger !== "auto" && e.trigger !== "manual") return false;
    if (
      e.preTokens !== undefined &&
      (typeof e.preTokens !== "number" || !Number.isFinite(e.preTokens) || e.preTokens < 0)
    ) {
      return false;
    }
    if (e.priorGeneration !== undefined && e.priorGeneration !== true) return false;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isResumePreviewMessage(value: unknown): value is ResumePreviewMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    hasOnlyKeys(message, ["uuid", "role", "text", "imageRefs", "model"]) &&
    typeof message.uuid === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string" &&
    (message.imageRefs === undefined || isImageRefInfoArray(message.imageRefs)) &&
    (message.model === undefined || (typeof message.model === "string" && message.model.length > 0))
  );
}

function isResumeHydrationSnapshotState(value: unknown): value is ResumeHydrationSnapshotState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!hasOnlyKeys(state, ["phase", "previewMessages", "failureReason"])) return false;
  if (state.phase !== "loading" && state.phase !== "complete" && state.phase !== "failed") return false;
  if (
    state.previewMessages !== undefined &&
    (!Array.isArray(state.previewMessages) ||
      state.previewMessages.length > RESUME_PREVIEW_MESSAGE_MAX ||
      !state.previewMessages.every(isResumePreviewMessage))
  ) {
    return false;
  }
  if (state.failureReason !== undefined) {
    return state.phase === "failed" && typeof state.failureReason === "string";
  }
  return true;
}

function isResumeHydrationStateMessage(value: Record<string, unknown>): boolean {
  if (
    !hasOnlyKeys(value, [
      "type",
      "tabId",
      "phase",
      "reason",
      "displayEvent",
      "sendDisposition",
      "previewMessages",
    ])
  ) {
    return false;
  }
  if (typeof value.tabId !== "string") return false;
  const hasPhase = value.phase !== undefined;
  const hasDisplayEvent = value.displayEvent !== undefined;
  const hasSendDisposition = value.sendDisposition !== undefined;
  if (!hasPhase && !hasDisplayEvent && !hasSendDisposition) return false;
  if (
    hasPhase &&
    value.phase !== "loading" &&
    value.phase !== "complete" &&
    value.phase !== "failed"
  ) {
    return false;
  }
  if (value.reason !== undefined && (value.phase !== "failed" || typeof value.reason !== "string")) {
    return false;
  }
  if (value.previewMessages !== undefined) {
    if (value.phase !== "loading" && value.phase !== "complete") return false;
    if (
      !Array.isArray(value.previewMessages) ||
      value.previewMessages.length > RESUME_PREVIEW_MESSAGE_MAX ||
      !value.previewMessages.every(isResumePreviewMessage)
    ) {
      return false;
    }
  }
  if (hasDisplayEvent) {
    if (typeof value.displayEvent !== "object" || value.displayEvent === null || Array.isArray(value.displayEvent)) {
      return false;
    }
    const displayEvent = value.displayEvent as Record<string, unknown>;
    if (
      !hasOnlyKeys(displayEvent, ["journalEventId", "event"]) ||
      typeof displayEvent.journalEventId !== "string" ||
      !isPlausibleNormalizedEvent(displayEvent.event)
    ) {
      return false;
    }
  }
  if (hasSendDisposition) {
    if (
      typeof value.sendDisposition !== "object" ||
      value.sendDisposition === null ||
      Array.isArray(value.sendDisposition)
    ) {
      return false;
    }
    const disposition = value.sendDisposition as Record<string, unknown>;
    if (
      !hasOnlyKeys(disposition, ["clientToken", "disposition"]) ||
      typeof disposition.clientToken !== "string" ||
      (disposition.disposition !== "accepted-human" &&
        disposition.disposition !== "accepted-nonhuman" &&
        disposition.disposition !== "rejected")
    ) {
      return false;
    }
  }
  return true;
}

// count に 0 を通すと、省略なしの表現が undefined と二通りになり受け側の分岐が二重になる。
function isHeadOmitted(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const h = v as { count?: unknown; hasConvEvent?: unknown; backfilledHead?: unknown };
  return (
    typeof h.count === "number" &&
    Number.isInteger(h.count) &&
    h.count > 0 &&
    typeof h.hasConvEvent === "boolean" &&
    typeof h.backfilledHead === "boolean"
  );
}

// R-SES-02: 空の id を拒まない。src/claude-normalizer.ts は task_id の無い要素を空の id で出すので、拒むと init ごと捨てられて全タブが空になる。
function isBackgroundActivitySnapshot(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const a = v as Record<string, unknown>;
  const listOf = (x: unknown, item: (y: unknown) => boolean): boolean =>
    Array.isArray(x) && x.length <= BACKGROUND_ACTIVITY_LIST_MAX && x.every(item);
  const record = (y: unknown): y is Record<string, unknown> =>
    typeof y === "object" && y !== null && !Array.isArray(y);
  return (
    hasOnlyKeys(a, ["tasks", "finishedTaskIds", "lifecycleSeenIds", "delegations"]) &&
    listOf(a.tasks, (t) =>
      record(t) &&
      hasOnlyKeys(t, ["id", "type", "description", "ambient"]) &&
      typeof t.id === "string" &&
      typeof t.type === "string" &&
      typeof t.description === "string" &&
      (t.ambient === undefined || t.ambient === true)
    ) &&
    listOf(a.finishedTaskIds, (id) => typeof id === "string") &&
    listOf(a.lifecycleSeenIds, (id) => typeof id === "string") &&
    listOf(a.delegations, (d) =>
      record(d) &&
      hasOnlyKeys(d, ["toolUseId", "label", "agentId", "running", "background"]) &&
      typeof d.toolUseId === "string" &&
      typeof d.label === "string" &&
      (d.agentId === undefined || typeof d.agentId === "string") &&
      typeof d.running === "boolean" &&
      typeof d.background === "boolean"
    )
  );
}

function isTabSnapshotShape(x: unknown): x is TabSnapshot {
  if (typeof x !== "object" || x === null) return false;
  const t = x as { tabId?: unknown; title?: unknown; state?: unknown; deferred?: unknown };
  if (typeof t.tabId !== "string" || typeof t.title !== "string") return false;
  // false を通すと、deferred でない表現が二通りになり受け側の分岐が二重になる。
  if (t.deferred !== undefined && t.deferred !== true) return false;
  if (typeof t.state !== "object" || t.state === null) return false;
  const s = t.state as Record<string, unknown>;
  return (
    (s.conversationId === null || typeof s.conversationId === "string") &&
    typeof s.cwd === "string" &&
    (s.turnState === "idle" || s.turnState === "running" || s.turnState === "interrupting") &&
    (s.auth === null || typeof s.auth === "object") &&
    (PERMISSION_MODES as string[]).includes(s.permissionMode as string) &&
    (s.workModel === undefined || isWorkModelPayload(s.workModel)) &&
    (s.planUsage === undefined || isPlanUsage(s.planUsage)) &&
    (s.semanticView === undefined || typeof s.semanticView === "boolean") &&
    (s.semanticModel === undefined || isSemanticModelPayload(s.semanticModel)) &&
    (s.effortOverride === undefined || s.effortOverride === null || typeof s.effortOverride === "string") &&
    (s.defaultEffort === undefined || typeof s.defaultEffort === "string") &&
    (s.appliedModel === undefined || typeof s.appliedModel === "string") &&
    (s.modelFallback === undefined || (isProfileObject(s.modelFallback) &&
      isPlausibleNormalizedEvent(s.modelFallback.notice) && s.modelFallback.notice.kind === "model_refusal_fallback" &&
      s.modelFallback.notice.scope === "session" && typeof s.modelFallback.appliedModel === "string" &&
      (s.modelFallback.resolvedAt === undefined || isNumber(s.modelFallback.resolvedAt)) &&
      (s.modelFallback.reopenedAt === undefined || isNumber(s.modelFallback.reopenedAt)) &&
      (s.modelFallback.turnOriginalModel === undefined || typeof s.modelFallback.turnOriginalModel === "string") &&
      (s.modelFallback.autoRevert === undefined ||
        ([...FALLBACK_AUTO_REVERT_STARTS, ...FALLBACK_REVERT_OUTCOMES] as readonly unknown[]).includes(s.modelFallback.autoRevert)))) &&
    (s.appliedEffort === undefined || s.appliedEffort === null ||
      (typeof s.appliedEffort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(s.appliedEffort))) &&
    (s.recordedModel === undefined || typeof s.recordedModel === "string") &&
    (s.llmAnalysisEnabled === undefined || typeof s.llmAnalysisEnabled === "boolean") &&
    (s.llmAnalysisRunning === undefined || typeof s.llmAnalysisRunning === "boolean") &&
    (s.llmAnalysisProgress === undefined ||
      (s.llmAnalysisRunning === true && isLlmAnalysisRunProgress(s.llmAnalysisProgress))) &&
    (s.sessionSummary === undefined ||
      (typeof s.sessionSummary === "object" && s.sessionSummary !== null &&
        typeof (s.sessionSummary as { text?: unknown }).text === "string" &&
        typeof (s.sessionSummary as { model?: unknown }).model === "string")) &&
    (s.sessionSummaryRunning === undefined || typeof s.sessionSummaryRunning === "boolean") &&
    (s.llmDiagnostics === undefined || typeof s.llmDiagnostics === "boolean") &&
    (s.resumeHydration === undefined || isResumeHydrationSnapshotState(s.resumeHydration)) &&
    (s.headOmitted === undefined || isHeadOmitted(s.headOmitted)) &&
    (s.backgroundActivity === undefined || isBackgroundActivitySnapshot(s.backgroundActivity)) &&
    (s.handoffSource === undefined || isHandoffSource(s.handoffSource)) &&
    Array.isArray(s.events) &&
    (s.events as unknown[]).every(isPlausibleNormalizedEvent)
  );
}

function isLlmAnalysisRunProgress(value: unknown): value is LlmAnalysisRunProgress {
  if (typeof value !== "object" || value === null) return false;
  const progress = value as Record<string, unknown>;
  return (
    typeof progress.callIndex === "number" &&
    typeof progress.plannedCalls === "number" &&
    (progress.stage === undefined || progress.stage === "slice" || progress.stage === "merge") &&
    (progress.sliceIndex === undefined || (Number.isInteger(progress.sliceIndex) && (progress.sliceIndex as number) >= 1)) &&
    (progress.sliceCount === undefined || (Number.isInteger(progress.sliceCount) && (progress.sliceCount as number) >= 1)) &&
    typeof progress.elapsedMs === "number"
  );
}

function isNonNegativeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isDecisionWarn(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  return isNonNegativeInt(w.entries) && isNonNegativeInt(w.bytes);
}

function isHandoffDecisionCounts(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    isNonNegativeInt(d.total) &&
    isNonNegativeInt(d.carried) &&
    isNonNegativeInt(d.extracted) &&
    isNonNegativeInt(d.removed) &&
    isNonNegativeInt(d.unknownIdRefs) &&
    isDecisionWarn(d.warn)
  );
}

const DECISION_TAG_VALUES: readonly string[] = ["GOAL", "KILLED", "DECIDED", "DROPPED"];

function isDecisionEntryList(v: unknown): v is HandoffDecisionEntry[] {
  return (
    Array.isArray(v) &&
    v.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const e = item as Record<string, unknown>;
      return (
        typeof e.id === "string" &&
        e.id.length > 0 &&
        typeof e.t === "string" &&
        DECISION_TAG_VALUES.includes(e.t) &&
        isNonNegativeInt(e.g) &&
        typeof e.s === "string"
      );
    })
  );
}

function isHandoffDecisions(v: unknown): v is HandoffDecisions | undefined {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.preamble === "string" &&
    isDecisionEntryList(d.entries) &&
    (d.removedLastGen === undefined || isDecisionEntryList(d.removedLastGen)) &&
    isNonNegativeInt(d.carried) &&
    isNonNegativeInt(d.extracted) &&
    isNonNegativeInt(d.removed) &&
    isNonNegativeInt(d.unknownIdRefs) &&
    (d.source === "hook" || d.source === "previous_only") &&
    isDecisionWarn(d.warn)
  );
}

function isHandoffSource(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const h = v as Record<string, unknown>;
  const compact = h.compact as { preTokens?: unknown; postTokens?: unknown } | undefined;
  return typeof h.sessionId === "string" && SESSION_ID_RE.test(h.sessionId) &&
    (h.title === undefined || typeof h.title === "string") &&
    (h.detailRunId === undefined || typeof h.detailRunId === "string") &&
    (h.utteranceCount === undefined ||
      (typeof h.utteranceCount === "number" && Number.isSafeInteger(h.utteranceCount) && h.utteranceCount >= 0)) &&
    (h.decisionCount === undefined ||
      (typeof h.decisionCount === "number" && Number.isSafeInteger(h.decisionCount) && h.decisionCount >= 0)) &&
    (compact === undefined ||
      (typeof compact === "object" && compact !== null &&
        typeof compact.preTokens === "number" && Number.isFinite(compact.preTokens) && compact.preTokens >= 0 &&
        typeof compact.postTokens === "number" && Number.isFinite(compact.postTokens) && compact.postTokens >= 0));
}

function isSessionScanDegradation(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.rootFailed === "boolean" &&
    typeof d.unreadableProjects === "number" &&
    typeof d.statFailed === "number" &&
    typeof d.resolveFailed === "number" &&
    typeof d.unresolvedCandidates === "number"
  );
}

// 送信元は同じ拡張なので、目的は悪意の遮断ではなく protocol 変更時の型崩れの検出。フィールドの改名は受信時にしか検出できない。
export function isHostToWebview(v: unknown): v is HostToWebview {
  if (typeof v !== "object" || v === null) return false;
  // as は網羅の検査のために静的型を絞るだけで、実行時の値は各分岐が検査する。
  const t = (v as { type?: unknown }).type as HostToWebview["type"];
  const tabId = (v as { tabId?: unknown }).tabId;

  if (t === "planUsage") {
    return typeof tabId === "string" && Object.keys(v).length === 3
      && hasOnlyKeys(v as Record<string, unknown>, ["type", "tabId", "state"])
      && isPlanUsage((v as { state?: unknown }).state);
  }

  if (t === "orchestrationView") {
    return typeof tabId === "string" && hasOnlyKeys(v as Record<string, unknown>, ["type", "tabId", "state"])
      && isOrchestrationView((v as { state?: unknown }).state); // R-ORC-14, R-ORC-22
  }

  if (t === "init") {
    const tabs = (v as { tabs?: unknown }).tabs;
    const extensions = (v as { systemAppExtensions?: unknown }).systemAppExtensions;
    return (
      typeof (v as { protocolVersion?: unknown }).protocolVersion === "number" &&
      ((v as { hostWindows?: unknown }).hostWindows === undefined ||
        typeof (v as { hostWindows?: unknown }).hostWindows === "boolean") &&
      // R-CNV-20: init carries only normalized, non-blocked display extensions.
      (extensions === undefined || (Array.isArray(extensions) &&
        extensions.every((item) => typeof item === "string" && normalizeSystemAppExtension(item) === item))) &&
      Array.isArray(tabs) &&
      (tabs as unknown[]).every(isTabSnapshotShape)
    );
  }
  if (t === "events") {
    const events = (v as { events?: unknown }).events;
    return (
      typeof tabId === "string" &&
      Array.isArray(events) &&
      (events as unknown[]).every(isPlausibleNormalizedEvent)
    );
  }
  if (t === "resumeHydrationState") {
    return isResumeHydrationStateMessage(v as Record<string, unknown>);
  }
  if (t === "tabCreated") {
    // R-HND-08: activate の欠落を通すと、裏で開く経路が前面へ出す扱いに退化してフォーカスを奪う。
    return (
      isTabSnapshotShape((v as { tab?: unknown }).tab) &&
      typeof (v as { activate?: unknown }).activate === "boolean"
    );
  }
  if (t === "tabClosed" || t === "activateTab") return typeof tabId === "string";
  if (t === "tabCleared") return isTabSnapshotShape((v as { tab?: unknown }).tab);
  if (t === "tabRestored") return isTabSnapshotShape((v as { tab?: unknown }).tab);
  if (t === "tabRenamed") {
    return typeof tabId === "string" && typeof (v as { title?: unknown }).title === "string";
  }
  if (t === "handoffStatus") {
    const m = v as Record<string, unknown>;
    const s = m.state;
    const source = m.source as { sessionId?: unknown; title?: unknown } | undefined;
    const fork = m.fork as { sessionId?: unknown; tabId?: unknown; title?: unknown } | undefined;
    const compact = m.compact as { preTokens?: unknown; postTokens?: unknown } | undefined;
    const progress = m.progress as { heartbeats?: unknown; elapsedMs?: unknown; since?: unknown } | undefined;
    return (
      typeof tabId === "string" &&
      typeof m.runId === "string" &&
      (s === "running" || s === "failed" || s === "done") &&
      typeof m.message === "string" &&
      (m.phase === undefined || typeof m.phase === "string") &&
      (progress === undefined ||
        (typeof progress === "object" &&
          progress !== null &&
          typeof progress.heartbeats === "number" &&
          typeof progress.elapsedMs === "number" &&
          (progress.since === "compact_start" || progress.since === "result"))) &&
      (m.reason === undefined || typeof m.reason === "string") &&
      (m.detail === undefined || typeof m.detail === "string") &&
      typeof source === "object" &&
      source !== null &&
      typeof source.sessionId === "string" &&
      typeof source.title === "string" &&
      (fork === undefined ||
        (typeof fork === "object" &&
          fork !== null &&
          typeof fork.sessionId === "string" &&
          typeof fork.tabId === "string" &&
          typeof fork.title === "string")) &&
      (compact === undefined ||
        (typeof compact === "object" &&
          compact !== null &&
          typeof compact.preTokens === "number" &&
          typeof compact.postTokens === "number")) &&
      (m.utteranceCount === undefined || typeof m.utteranceCount === "number") &&
      (m.unreadableLineCount === undefined || typeof m.unreadableLineCount === "number") &&
      isHandoffDecisionCounts(m.decisions)
    );
  }
  if (t === "handoffDetail") {
    const m = v as Record<string, unknown>;
    const utterances = m.utterances;
    return (
      typeof tabId === "string" &&
      typeof m.runId === "string" &&
      typeof m.part === "number" &&
      Number.isInteger(m.part) &&
      m.part >= 0 &&
      typeof m.total === "number" &&
      Number.isInteger(m.total) &&
      m.total >= 0 &&
      (m.summary === undefined || typeof m.summary === "string") &&
      Array.isArray(utterances) &&
      utterances.every((u) => {
        const item = u as Record<string, unknown>;
        return (
          typeof item === "object" &&
          item !== null &&
          typeof item.n === "number" &&
          typeof item.at === "string" &&
          (item.kind === "typed" || item.kind === "answer") &&
          typeof item.text === "string" &&
          (item.questions === undefined ||
            (Array.isArray(item.questions) && item.questions.every((q) => typeof q === "string")))
        );
      }) &&
      isHandoffDecisions(m.decisions)
    );
  }
  if (t === "modeChanged") {
    return (
      typeof tabId === "string" &&
      (PERMISSION_MODES as string[]).includes((v as { mode?: unknown }).mode as string)
    );
  }
  if (t === "commands") {
    const commands = (v as { commands?: unknown }).commands;
    return (
      typeof tabId === "string" &&
      Array.isArray(commands) &&
      (commands as unknown[]).every(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { name?: unknown }).name === "string" &&
          typeof (c as { description?: unknown }).description === "string"
      )
    );
  }
  if (t === "models") {
    const models = (v as { models?: unknown }).models;
    return (
      typeof tabId === "string" &&
      Array.isArray(models) &&
      (models as unknown[]).every(
        (m) =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as { id?: unknown }).id === "string" &&
          typeof (m as { label?: unknown }).label === "string" &&
          typeof (m as { description?: unknown }).description === "string" &&
          ((m as { olderVersion?: unknown }).olderVersion === undefined || typeof (m as { olderVersion?: unknown }).olderVersion === "boolean")
      )
    );
  }
  if (t === "modelChanged") {
    const applied = (v as { applied?: unknown }).applied;
    if (applied !== undefined && typeof applied !== "boolean") return false;
    const model = (v as { model?: unknown }).model;
    const notice = (v as { notice?: unknown }).notice;
    return typeof tabId === "string" && (model === null || typeof model === "string") &&
      (notice === undefined || typeof notice === "string");
  }
  if (t === "effortChanged") {
    const effort = (v as { effort?: unknown }).effort;
    const notice = (v as { notice?: unknown }).notice;
    return typeof tabId === "string" && (effort === null || typeof effort === "string") &&
      (notice === undefined || typeof notice === "string");
  }
  if (t === "configuredEffortChanged") {
    const effort = (v as { effort?: unknown }).effort;
    const model = (v as { model?: unknown }).model;
    if (model !== undefined && model !== null && typeof model !== "string") return false;
    const defaultEffort = (v as { defaultEffort?: unknown }).defaultEffort;
    if (defaultEffort !== undefined && defaultEffort !== null &&
      !(typeof defaultEffort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(defaultEffort))) return false;
    const appliedModel = (v as { appliedModel?: unknown }).appliedModel;
    if (appliedModel !== undefined && appliedModel !== null && typeof appliedModel !== "string") return false;
    const appliedEffort = (v as { appliedEffort?: unknown }).appliedEffort;
    if (appliedEffort !== undefined && appliedEffort !== null &&
      !(typeof appliedEffort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(appliedEffort))) return false;
    return typeof tabId === "string" && (effort === null ||
      (typeof effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(effort)));
  }
  if (t === "files") {
    const paths = (v as { paths?: unknown }).paths;
    return (
      typeof (v as { reqId?: unknown }).reqId === "number" &&
      Array.isArray(paths) &&
      (paths as unknown[]).every((p) => typeof p === "string")
    );
  }
  if (t === "pickedFiles") {
    const paths = (v as { paths?: unknown }).paths;
    const images = (v as { images?: unknown }).images;
    // R-CNV-05: 入力欄と添付欄へ差し込む前に形を確かめる。PICKED_FILE_MAX_COUNT の上限は Host 側の切り捨てとの整合で、守る要件は特定できていない。
    return (
      typeof (v as { reqId?: unknown }).reqId === "number" &&
      Array.isArray(paths) &&
      paths.length <= PICKED_FILE_MAX_COUNT &&
      (paths as unknown[]).every((p) => typeof p === "string" && p.length > 0) &&
      Array.isArray(images) &&
      images.length <= IMAGE_MAX_COUNT &&
      (images as unknown[]).every(
        (im) =>
          typeof im === "object" &&
          im !== null &&
          ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            (im as { mediaType?: unknown }).mediaType as string
          ) &&
          typeof (im as { data?: unknown }).data === "string" &&
          (im as { data: string }).data.length <= IMAGE_MAX_BASE64_LEN
      )
    );
  }
  if (t === "attachments") {
    const items = (v as { items?: unknown }).items;
    return (
      typeof tabId === "string" &&
      Array.isArray(items) &&
      items.length <= IMAGE_MAX_COUNT &&
      (items as unknown[]).every(
        (it) =>
          typeof it === "object" &&
          it !== null &&
          typeof (it as { id?: unknown }).id === "string" &&
          ATTACHMENT_ID_RE.test((it as { id: string }).id) &&
          ALLOWED_IMAGE_MEDIA_TYPES.includes(
            (it as { mediaType?: unknown }).mediaType as ImageAttachment["mediaType"]
          ) &&
          typeof (it as { data?: unknown }).data === "string" &&
          (it as { data: string }).data.length <= IMAGE_MAX_BASE64_LEN
      )
    );
  }
  if (t === "sessions") {
    const page = v as { source?: unknown; nextCursor?: unknown; append?: unknown };
    if (page.source !== undefined && page.source !== "laisora" && page.source !== "claude") return false;
    if (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || !/^\d+:\d+$/.test(page.nextCursor))) return false;
    if (page.append !== undefined && typeof page.append !== "boolean") return false;
    const sessions = (v as { sessions?: unknown }).sessions;
    const requestId = (v as { requestId?: unknown }).requestId;
    return (
      typeof requestId === "number" &&
      Number.isInteger(requestId) &&
      requestId >= 0 &&
      typeof (v as { complete?: unknown }).complete === "boolean" &&
      isSessionScanDegradation((v as { degraded?: unknown }).degraded) &&
      Array.isArray(sessions) &&
      (sessions as unknown[]).every(
        (s) =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as { sessionId?: unknown }).sessionId === "string" &&
          typeof (s as { filePath?: unknown }).filePath === "string" &&
          typeof (s as { title?: unknown }).title === "string" &&
          typeof (s as { cwd?: unknown }).cwd === "string" &&
          typeof (s as { mtime?: unknown }).mtime === "number" &&
          ((s as { originUnverified?: unknown }).originUnverified === undefined || typeof (s as { originUnverified?: unknown }).originUnverified === "boolean")
      )
    );
  }
  if (t === "composerPrefill") {
    return typeof tabId === "string" && typeof (v as { text?: unknown }).text === "string" && (v as { text: string }).text.length <= 20_000;
  }
  if (t === "analysis") {
    // report は中身も有無も見ない（src/analysis.ts#AnalysisReport と二重に持たない）。
    return (
      typeof (v as { sessionId?: unknown }).sessionId === "string" &&
      typeof (v as { filePath?: unknown }).filePath === "string"
    );
  }
  if (t === "analysisFailed") {
    const m = v as Record<string, unknown>;
    const allowed = new Set(["type", "kind", "tabId", "reason"]);
    if (!Object.keys(m).every((key) => allowed.has(key))) return false;
    if (m.kind !== "script" && m.kind !== "action") return false;
    if (tabId !== undefined && (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 200)) return false;
    if (m.reason !== undefined && (typeof m.reason !== "string" || m.reason.length === 0)) return false;
    // 所見からの操作の拒否は必ず要求元タブと理由を持つ（無いと別タブへ出るか、無言で消える。R-ANL-11）
    return m.kind === "script" || (typeof tabId === "string" && typeof m.reason === "string");
  }
  if (t === "editorContext") {
    return (
      typeof (v as { path?: unknown }).path === "string" &&
      typeof (v as { startLine?: unknown }).startLine === "number" &&
      typeof (v as { endLine?: unknown }).endLine === "number"
    );
  }
  if (t === "workModel") {
    return typeof tabId === "string" && isWorkModelPayload((v as { model?: unknown }).model);
  }
  if (t === "semanticModel") {
    return typeof tabId === "string" && isSemanticModelPayload((v as { model?: unknown }).model);
  }
  if (t === "llmAnalysisSetting") {
    return typeof (v as { enabled?: unknown }).enabled === "boolean";
  }
  if (t === "userSettings") {
    const appearance = (v as { appearance?: unknown }).appearance;
    return (appearance === undefined || isAccentSettings(appearance))
      && (COMPOSER_SEND_KEYS as readonly string[]).includes((v as { composerSendKey?: unknown }).composerSendKey as string);
  }
  if (t === "tabNotice") {
    const text = (v as { text?: unknown }).text;
    return typeof tabId === "string" && tabId.length > 0 && typeof text === "string" && text.length > 0;
  }
  if (t === "llmAnalysisRunState") {
    const m = v as Record<string, unknown>;
    const progress = m.progress;
    const failure = m.failure as
      | {
          reason?: unknown;
          limit?: unknown;
          elapsedMs?: unknown;
          attemptedCalls?: unknown;
          completedCalls?: unknown;
          plannedCalls?: unknown;
        }
      | undefined;
    const refusal = m.refusal;
    return (
      typeof tabId === "string" &&
      typeof m.running === "boolean" &&
      (progress === undefined || isLlmAnalysisRunProgress(progress)) &&
      (failure === undefined ||
        (typeof failure === "object" &&
          failure !== null &&
          typeof failure.reason === "string" &&
          (failure.limit === undefined ||
            failure.limit === "per_call" ||
            failure.limit === "total") &&
          typeof failure.elapsedMs === "number" &&
          typeof failure.attemptedCalls === "number" &&
          typeof failure.completedCalls === "number" &&
          typeof failure.plannedCalls === "number")) &&
      // R-ANL-11: 未実行の理由を実行中・失敗と同居させない。
      (refusal === undefined ||
        (typeof refusal === "string" && refusal.length > 0 && m.running === false && failure === undefined))
    );
  }
  if (t === "sessionNameSuggestion") {
    const message = v as { title?: unknown; reason?: unknown };
    return typeof tabId === "string" && Object.keys(v).every(key => ["type", "tabId", "title", "reason"].includes(key)) &&
      ((typeof message.title === "string" && message.title.trim().length > 0 && message.title.length <= RENAME_TITLE_MAX &&
        !/[\r\n→]/.test(message.title) && message.reason === undefined) ||
       (typeof message.reason === "string" && message.reason.trim().length > 0 && message.title === undefined));
  }
  if (t === "sessionSummary") {
    const summary = (v as { summary?: unknown }).summary;
    const saveFailed = (v as { saveFailed?: unknown }).saveFailed;
    const failure = (v as { failure?: unknown }).failure;
    const running = (v as { running?: unknown }).running;
    return (
      typeof tabId === "string" &&
      typeof running === "boolean" &&
      (saveFailed === undefined || saveFailed === true) &&
      // 失敗理由は終了の便にだけ載る（実行中の便に載ると開始直後に失敗表示が出る。R-DSP-01）
      (failure === undefined || (typeof failure === "string" && failure.length > 0 && running === false)) &&
      (summary === undefined ||
        (typeof summary === "object" && summary !== null &&
          typeof (summary as { text?: unknown }).text === "string" &&
          (summary as { text: string }).text.length > 0 &&
          typeof (summary as { model?: unknown }).model === "string"))
    );
  }
  if (t === "llmFindingDiagnostics") {
    return (
      typeof tabId === "string" &&
      isLlmFindingDiagnosticsPayload((v as { payload?: unknown }).payload)
    );
  }
  if (t === "agentInspectorResult") {
    const message = v as Record<string, unknown>;
    const fingerprint = message.fingerprint as Record<string, unknown> | undefined;
    return typeof tabId === "string" && typeof message.agentId === "string" &&
      typeof message.requestId === "string" && typeof message.generation === "number" &&
      typeof fingerprint === "object" && fingerprint !== null &&
      typeof fingerprint.size === "number" && typeof fingerprint.mtimeMs === "number" &&
      isAgentInspectorPage(message.page);
  }
  if (t === "agentInspectorError") {
    const message = v as Record<string, unknown>;
    return typeof tabId === "string" && typeof message.agentId === "string" &&
      typeof message.requestId === "string" && typeof message.generation === "number" &&
      ["session-unavailable", "session-scan-failed", "agent-unavailable", "transcript-unavailable", "invalid-cursor",
        "stale-request", "read-failed", "response-too-large", "meta-limit"].includes(message.reason as string);
  }
  if (t === "historyChunkResult") {
    const message = v as Record<string, unknown>;
    return typeof tabId === "string" && typeof message.requestId === "string" &&
      typeof message.generation === "number" && isHistoryChunkPage(message.page);
  }
  if (t === "historyChunkError") {
    const message = v as Record<string, unknown>;
    return typeof tabId === "string" && typeof message.requestId === "string" &&
      typeof message.generation === "number" &&
      ["invalid-cursor", "unknown-anchor", "history-unavailable", "ambiguous-identity",
        "invalid-request", "stale-request", "host-error"].includes(
        message.reason as string
      );
  }
  if (t === "worklogTranscriptResult") {
    const message = v as Record<string, unknown>;
    return typeof tabId === "string" && typeof message.requestId === "string" &&
      typeof message.generation === "number" && isHistoryChunkPage(message.page);
  }
  if (t === "worklogTranscriptError") {
    const message = v as Record<string, unknown>;
    return typeof tabId === "string" && typeof message.requestId === "string" &&
      typeof message.generation === "number" &&
      ["invalid-cursor", "unknown-anchor", "history-unavailable", "ambiguous-identity",
        "invalid-request", "stale-request", "host-error"].includes(
        message.reason as string
      );
  }
  if (t === "conversationHistoryResult") {
    const message = v as Record<string, unknown>;
    return typeof tabId === "string" && typeof message.requestId === "string" &&
      typeof message.generation === "number" && isConversationHistoryPage(message.page);
  }
  if (t === "conversationHistoryError") {
    const message = v as Record<string, unknown>;
    return typeof tabId === "string" && typeof message.requestId === "string" &&
      typeof message.generation === "number" &&
      ["invalid-cursor", "unknown-anchor", "history-unavailable", "invalid-request",
        "session-unavailable", "session-scan-failed", "read-failed", "stale-request",
        "response-too-large", "host-error"].includes(
        message.reason as string
      );
  }
  if (t === "sessionImageResult") {
    const m = v as Record<string, unknown>;
    return (
      typeof tabId === "string" &&
      typeof m.requestId === "string" &&
      ALLOWED_IMAGE_MEDIA_TYPES.includes(m.mediaType as ImageAttachment["mediaType"]) &&
      typeof m.data === "string" &&
      m.data.length <= IMAGE_MAX_BASE64_LEN
    );
  }
  if (t === "sessionImageError") {
    const m = v as Record<string, unknown>;
    return (
      typeof tabId === "string" &&
      typeof m.requestId === "string" &&
      (m.reason === "not-found" || m.reason === "read-failed" || m.reason === "invalid-request")
    );
  }
  if (t === "cachedUsage") {
    const limits = (v as { limits?: unknown }).limits;
    return (
      typeof (v as { fetchedAtMs?: unknown }).fetchedAtMs === "number" &&
      Array.isArray(limits) &&
      (limits as unknown[]).every(
        (l) =>
          typeof l === "object" &&
          l !== null &&
          typeof (l as { type?: unknown }).type === "string" &&
          typeof (l as { utilization?: unknown }).utilization === "number" &&
          ((l as { resetsAt?: unknown }).resetsAt === null ||
            typeof (l as { resetsAt?: unknown }).resetsAt === "number")
      )
    );
  }
  if (t === "analysisPersistenceState") {
    const p = (v as { persistence?: unknown }).persistence;
    return (
      typeof tabId === "string" &&
      typeof (v as { artifactId?: unknown }).artifactId === "string" &&
      (p === "pending" || p === "saved" || p === "rejected" || p === "failed") &&
      typeof (v as { persistenceLabel?: unknown }).persistenceLabel === "string"
    );
  }

  // バリアントを足して分岐を忘れると tsc がここで落ちる。
  t satisfies never;
  return false;
}
