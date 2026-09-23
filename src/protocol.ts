import { normalizeSystemAppExtension } from "./file-link-open-mode";
import { isPlanUsage } from "./plan-usage";
import type { ExecutorId } from "./orchestration-executors";
import { isExternalTimeout, isExternalDetection, isExternalModels, type ExternalModels, type ExternalDetection } from "./orchestration-roster";
import { isOrchestrationSettingRoster, type OrchestrationSettingRow } from "./orchestration-roster";
import { isOrchestrationView, type OrchestrationView } from "./orchestration-view";
export type { OrchestrationView } from "./orchestration-view";
// 拡張⇔Webview メッセージプロトコル
// マルチタブ（tabId ごとに Conversation 1本）。
// generation+seq / cursor / backendId は差分再送のための語彙として先に固定してあるが、
// 増分resume自体は未配線（ready は常に cursor:null を送り、host は毎回フルスナップショットを返す）。

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
import type { AnalysisFactsView } from "./analysis-facts-view";
// type-only に保つこと: semantic-model.ts は node:crypto を実行時 import しており、
// 値を取ると browser バンドル（dist/webview.js）が壊れる。
// l3-analysis.ts は semantic-model.ts から値を取り、l3-divergence.ts は node:crypto を
// 直接 import する（divergenceId）ので、どちらにも同じ制約が伝播する
import type { Coverage, ExecutionAttemptNode, SemanticModel, SemanticNode } from "./semantic-model";
import type { L3Report, SerializationClassification } from "./l3-analysis";
import type {
  DivergenceKind,
  DivergenceKindReport,
  DivergenceRecord,
  DivergenceReport,
} from "./l3-divergence";
// type-only に保つこと: llm-finding-verify.ts は protocol.ts を import しており、値を取ると循環する
import type { LlmAnalysisProvenance, RejectedFinding } from "./llm-finding-verify";
// type-only に保つこと: handoff-envelope.ts は handoff-accept.ts 経由で @vscode/l10n を取り込むため、
// 値を取ると browser バンドル（dist/webview.js）へ Host 専用の依存が入る
import type { HandoffDecisionEntry, HandoffDecisions } from "./handoff-envelope";

// Host と webview は同じ VSIX で出るが、webview の再読込前などに版がずれる。wire の形を変えたら版を上げる。
// webview は init で版を突き合わせ、食い違いを利用者へ出す（黙って行が消える状態にしない）。
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

// task-notification の構造化（agentId = <task-id>。toolUseId = <tool-use-id> で、
// 初回完了は dispatch の id・resume 後は SendMessage の id を指す）
export interface TaskNotificationInfo {
  agentId: string;
  toolUseId?: string;
  status?: string;
}

// Progress Protocol pp1。
// queued は emitter から到達不能のため emission enum に含めない
export type ProgressState = "active" | "blocked" | "review" | "done";

export interface ProgressEmission {
  pp: "pp1";
  // subagent は SubagentStart hook 経由で pp1 を受け取り task id を知らないため optional。
  // キーごとの欠落だけが正常系で、空文字・空白のみは emission ごと破棄する
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
  // reducer が確定した配置と集計。詳細ログの描画はここだけを見る（R1-F2）。
  // EventLog へ保存する値でもある: snapshot 再生と live で同じものを webview へ渡すため、
  // メッセージ側にだけ載せると再生時に配置が失われる
  work?: WorkEventInfo;
  provenance?: EventProvenance;
}

export type NormalizedEvent = EventEnvelope & NormalizedEventBody;

// semantic 境界（segment / phase / agent の開始・終了）を決めるイベント種別。
// これらに timestamp が無い状態で semantic derivation へ入れてはならない。
// 実時計（Date.now()）で補完すると replay 決定性が壊れ、live と history で
// segment の endedAt が食い違う。
// 供給の正規経路は ClaudeLiveNormalizer の「直近観測時刻の継承」で、
// それでも欠けている場合は契約違反として落とす。実時計では救済しない。
//
// 必須になるのは「一度でも時刻を観測した後」。ストリーム先頭の turn_started は
// 継承元が無く、かつ閉じるべき segment も running work もまだ存在しないため
// （work-model.ts:1606 の closeSegment / markRunningWorkStale は空に対する no-op）、
// 時刻を持たないことが正当。観測開始後に欠けたら境界が壊れるので落とす
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
    // cliInserted: このターンを開いたのは CLI が書いた user レコード（`isMeta`）で、利用者は何も打っていない。
    // 本文は user_message にしない（発言として集計・タイトル・逐語へ入る）ので、表示はこの印だけを見る
    | { kind: "turn_started"; turnId: string; cliInserted?: true }
    | { kind: "turn_completed"; turnId: string; usage?: UsageSnapshot }
    | { kind: "turn_interrupted"; turnId: string }
    | {
        kind: "turn_failed";
        turnId: string;
        reason: string;
        // limit到達等の分類。SDKのresult文字列から判別
        errorKind?: "usage_limit";
        // usage_limit時のリセット時刻（epoch ms）。取れなければnull
        resetsAt?: number | null;
        // どのlimitか（モデル別/週間枠/credits）を含むSDK原文（表示用）
        detail?: string;
      }
    // SDK内部リトライの可視化（無処理だとUIがフリーズしたように見える）
    | {
        kind: "api_retry";
        turnId: string | null;
        attempt: number;
        maxRetries: number;
        retryDelayMs: number;
        errorStatus?: number;
        // SDKAssistantMessageError（HTTP応答なしのリトライでも原因種別を出す）
        errorType?: string;
      }
    | { kind: "assistant_text_delta"; turnId: string; text: string }
    // 直前に流した未ラベルの assistant 本文が、この wire uuid のフレームのものであるという印。
    // SDK の assistant フレームは本文が完結した後に届くので、ストリーム中の assistant_text_delta
    // へ uuid を載せることはできない（uuid を知る前に本文を出している）。
    // live 専用: 撤回対象は CLI が自分の転記録から削除するので history からは復元されない
    | { kind: "assistant_message_uuid"; turnId: string; uuid: string }
    // プロバイダからの撤回指示（R-DSP-26）。到着した uuid のメッセージを画面から退去させる。
    // 撤回は冪等で、未知・撤回済みの uuid は no-op（sdk.d.ts）。2 経路（置き換える側のフレームの
    // supersedes / ターン末 model_refusal_fallback の retracted_message_uuids）が同じ uuid を
    // 名乗りうるため、消費側は 2 回来ても壊れてはならない
    | { kind: "assistant_retracted"; turnId: string | null; uuids: string[] }
    | {
        kind: "user_message";
        turnId: string | null;
        text: string;
        images?: ImageAttachment[];
        imageRefs?: ImageRefInfo[];
        // sentAt は Host が送信を観測した実時刻（R-CNV-16 のフッター表示専用）。
        // envelope の timestamp は順序用の観測時刻の継承で、復元タブの初回送信では
        // 記録末尾の時刻になる。名前を `timestamp` にすると envelope の spread に潰される
        sentAt?: number;
      }
    // resume 時の過去ログ再生（表示専用。復元境界は会話へ挿入する区切り行で示す）
    // uuid は会話の過去 chunk との重複判定にだけ使う表示専用の項目。
    // replayed_message は work-model / evidence-index / semantic-model / l3-analysis の
    // どこにも現れない（grep 0 件）ので、足しても導出には入り得ない
    // recordedAt はそのレコード自身の時刻（R-CNV-15 / R-CNV-16 のフッター表示専用）。
    // 名前を `timestamp` にすると envelope の spread に潰される。meta.timestamp で運ぶと
    // timestamp gate の判定基準（lastEventTimestamp）が過去へ巻き戻る
    | {
        kind: "replayed_message";
        role: "user" | "assistant";
        text: string;
        uuid?: string;
        imageRefs?: ImageRefInfo[];
        model?: string;
        recordedAt?: number;
        // Original send time, used for display when recordedAt is absent.
        sentAt?: number;
      }
    | {
        kind: "tool_call_started";
        turnId: string;
        toolUseId: string;
        parentToolUseId: string | null;
        toolName: string;
        inputPreview: string;
        // 切り詰め前の完全な入力から算出した人間可読の1行（summarizeToolInput）。
        // inputPreview は500字切り詰めでJSONとして壊れるため、要約はホスト側で作る
        inputSummary?: string;
        // Task/Agent の run_in_background:true（H-1: inputPreviewは500字切り詰めのため
        // 欠落しうる。切り詰め前の生inputを見られるホスト側で判定して構造化フィールドにする）
        isBackground?: boolean;
        // Task/Agent 起動時のサブエージェント情報（inputPreview切り詰めと同じ理由でホスト側で構造化）。
        // subagentModel/subagentEffort は起動時点の宣言値: input.model（明示指定）＞ agent定義
        // frontmatter（model は "inherit" を除く）。実際に使われたモデルは後続の subagent_info が正
        subagentType?: string;
        subagentModel?: string;
        subagentEffort?: string;
        delegation?: DelegationInfo;
        taskIntentStructured?: TaskIntent;
        artifacts?: ProjectedArtifactAccess[];
        // 省略時は complete と解釈しない（unknown 扱い）
        effectCoverage?: EffectCoverage;
        // pp1 progress emission（既存 kind への optional フィールド）。
        // 抽出は Step 2 の共有ヘルパのみが書く（preview からは絶対に作らない）
        progressEmission?: ProgressEmission;
      }
    // サブエージェントの実測情報。最初の sidechain assistant メッセージ（parent_tool_use_id あり）の
    // message.model を1回だけ流す。起動時の宣言値は inherit 等で実モデルが分からないため、
    // 実測値でカード表示を上書きする。effort フィールドを持たない理由: SDKAssistantMessage 型に
    // effort は無く、セッションJSONLでは永続化エンベロープにのみ現れる。SDK hooks 入力には
    // 載るが表示のためだけの hooks 配線は不採用（claudeHost.ts 参照）。宣言値は tool_call_started 側で運ぶ
    | { kind: "subagent_info"; turnId: string | null; toolUseId: string; model?: string; agentId?: string }
    // root message.model の変化ごとに1回 emit（表示専用。work-model / evidence-index / semantic-model / l3-analysis は読まない）
    | { kind: "model_observed"; turnId: string | null; model: string }
    // CLI のコンテキスト圧縮地点（表示専用。model_observed と同じ扱い。turn 境界ではない）
    // priorGeneration: 世代境界より前の圧縮（`src/session-transcript.ts#readSessionHistory` だけが立てる）。
    // 作業ログ・集計は全世代を保つので、落とすのは会話面（conv-renderable.ts）だけ
    | { kind: "compact_boundary"; trigger: "auto" | "manual"; preTokens?: number; priorGeneration?: true }
    | {
        kind: "tool_call_finished";
        turnId: string;
        toolUseId: string;
        isError: boolean;
        // is_error tool_result の本文。canUseTool 非発火環境での拒否理由可視化に使う
        // （暫定の拒否理由表示）
        resultPreview: string;
        // resume 観測（裁定A1: 新 kind でなく既存 kind への optional フィールド）。
        // 3値とも切り詰め前の生 tool_result / 生 user record から共有ヘルパで抽出する
        // （resultPreview は 2000 字切り詰め済みで抽出元にできない）
        // async 起動ACKの実 agentId（transcript 名）。dispatch toolUseId との対応表の素材
        asyncLaunchedAgentId?: string;
        // SendMessage 成功結果の resumedAgentId。resume 確定はここでのみ観測する
        // （tool_use 開始時に観測すると失敗した SendMessage でも reopen してしまう）
        resumedAgentId?: string;
        // 背景 Bash の起動 ACK が運ぶ task id（run_in_background）。asyncLaunchedAgentId と同じく
        // task-notification の agentId と結合する素材。ACK は完了ではない（裁定A2 を Bash にも適用）
        backgroundTaskId?: string;
        // task-notification（background 委任の真の完了信号。裁定A2: 起動ACKでは完了にしない）。
        // 対応する tool_result block が無いため toolUseId は合成 ID になる
        taskNotification?: TaskNotificationInfo;
      }
    | {
        kind: "approval_request";
        turnId: string | null;
        requestId: string;
        toolName: string;
        // 原データ全文（要約だけで許可させない）。承認カードの「詳細を表示」で出す
        rawInputJson: string;
        // 承認カードの可読表示用。inputJson は context を含まない純粋な入力JSON
        // （rawInputJson は末尾に "--- context ---" が連結されるためパースできない）
        inputJson?: string;
        inputSummary?: string;
        expiresAt: number | null;
        // AskUserQuestion の質問構造（機能B）。パース失敗時は undefined のまま rawInputJson へフォールバック
        questions?: AskUserQuestionSpec;
      }
    | {
        kind: "approval_resolved";
        requestId: string;
        behavior: "allow" | "deny";
        resolvedBy: string;
        // AskUserQuestion の回答（機能B/M-7）。監査性のため replay でも再現できるよう保持する
        answers?: Record<string, string>;
      }
    | { kind: "permission_denied"; turnId: string | null; toolName: string; reason: string }
    | { kind: "usage_update"; scope: "turn" | "conversation"; turnId: string | null; usage: UsageSnapshot }
    // root message（message.id）につき 1 回。live は stream_event:message_delta の usage
    // （assistant record の usage.output_tokens は message_start の placeholder）、history は JSONL の
    // 同 messageId の最終 record の後。subagent は live に stream_event が無く history にしか無い
    // 最終 message もあるため両経路とも発行しない（parentToolUseId は null 固定）。
    // この kind はどの consumer でも seq / WorkModel / Evidence / EventLog / webview / semanticHash に混入せず、
    // 全 consumer が isGuardrailOnlyEventKind で gate する（GUARDRAIL_ONLY_EVENT_KINDS）。
    | {
        kind: "assistant_usage";
        turnId: string;
        messageId: string;
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
    // SDK の background_tasks_changed（レベル信号）。生きているバックグラウンドタスクの
    // 全量が毎回届くので、受信側は集合ごと置き換える。開始/終了のエッジを対にして数えると
    // 取りこぼしで実行中表示が固着する（sdk.d.ts の SDKBackgroundTasksChangedMessage 参照）
    | {
        kind: "background_tasks";
        // ambient は CLI が利用者作業として出さない housekeeping（sdk.d.ts）。activity indicator から除外する
        tasks: Array<{ id: string; type: string; description: string; ambient?: true }>;
      }
    | {
        kind: "error";
        message: string;
        fatal: boolean;
      }
    // CLIが随時送ってくるレート制限状況（Account & Usage 相当の元データ）
    | {
        kind: "rate_limit";
        status: string;
        rateLimitType: string;
        utilization: number;
        resetsAt: number | null;
        isUsingOverage: boolean;
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

// live / history の両経路が必ずこれを通す（同値は構成で保証する）。無い値は省略（0 埋めしない）
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

// provider 生値をそのまま保持。取れない値は undefined = unknown（0にしない）
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

// 画像添付（クリップボード貼り付け）。data は base64（dataURLプレフィックスなし）
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

// 未送信の添付。実体は Host が tabId ごとに持ち、webview はこの形で受け取って描くだけ（R-CNV-11）
export interface PendingAttachmentInfo {
  id: string;
  mediaType: ImageAttachment["mediaType"];
  data: string;
}
// Host が採番する添付 ID の字面。webview から戻る attachmentId をこれで絞る
export const ATTACHMENT_ID_RE = /^att-[0-9]+$/;
export const IMAGE_MAX_COUNT = 4;
// /rename の名前の上限。SDK の解決器は JSONL の末尾 64KB しか読まないので、それに収まらない名前は
// 履歴一覧で解決されずタブ名と食い違う（R-SES-05）
export const RENAME_TITLE_MAX = 2000;
export const IMAGE_MAX_BASE64_LEN = 8_000_000; // ≒6MB実体/枚
export const SEND_TEXT_MAX_LEN = 1_000_000;
// JSONL のファイル名に載る文字だけ。保存先の走査（extension.ts#lookupSessionFile）が
// この id をファイル名へ連結するので、正本はここ 1 本にする（複製すると片方だけ緩む）
export const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
// ファイル選択ダイアログから 1 回で入力欄へ入れるパスの上限。
// 多重選択で入力欄が読めなくなる量を差し込ませない
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

// ツール入力から人が読める1行を作る（拡張・Webview共有）。
// ホスト側で「切り詰め前の完全な入力オブジェクト」に対して呼ぶのが正。Webview に届く
// inputPreview は500字で切り詰められており JSON として壊れているため、そちらでパースすると
// 必ず失敗して生JSONの断片が表示される（Agent や長文プロンプトのツールで顕著）。
// 要約に足る情報が無ければ null を返し、呼び出し側でフォールバックさせる。
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

// Webview から VS Code コマンドを直接指名させない。command ID と引数は Host 側の対応表が持つ
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

// 設定エディタ（src/settings-panel.ts が開く WebviewPanel）との境界。会話面の WebviewToHost / HostToWebview とは受信口が別
// requestId は画面が書込み要求ごとに採番し、Host は書込み後の返送に replyTo として写す
export type SettingsPageToHost =
  | { type: "settingsPageReady" }
  | { type: "recheckExternalExecutors" }
  | { type: "setComposerSendKey"; requestId: number; sendKey: ComposerSendKey }
  | { type: "setApiKeyPolicy"; requestId: number; policy: ApiKeyPolicy }
  | { type: "setRestoreTabsOnStartup"; requestId: number; enabled: boolean }
  | { type: "setLearningEnabled"; requestId: number; enabled: boolean }
  | { type: "setOrchestrationSetting"; requestId: number; setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes"; value: unknown }
  | { type: "setFileLinkSetting"; requestId: number; setting: FileLinkBooleanSetting; enabled: boolean }
  | { type: "setFileLinkSetting"; requestId: number; setting: "openWithSystemApp"; value: string[] }
  | { type: "openVsCodeSettings" };

export type HostToSettingsPage =
  // 構成から読み直した実効値。書込みの後も要求値ではなくこれを返す（R-DSP-01）。
  // replyTo は書込み要求への返送だけが持つ。構成変更・ready への送信は持たない
  | ({ type: "settingsState"; composerSendKey: ComposerSendKey; apiKeyPolicy: ApiKeyPolicy; restoreTabsOnStartup: boolean; learningEnabled: boolean; replyTo?: number }
    & Record<FileLinkBooleanSetting, boolean> & { openWithSystemApp: string[] } & { orchestrationEnabled: boolean; orchestrationAgents: OrchestrationSettingRow[]; orchestrationDefaults: OrchestrationSettingRow[]; conductorPolicy: string; conductorPolicyDefault: string; externalTimeoutMinutes: number; externalDetection: Record<ExecutorId, ExternalDetection>; externalModels: ExternalModels });

function isSettingsRequestId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export function isSettingsPageToHost(v: unknown): v is SettingsPageToHost {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  const t = m.type as SettingsPageToHost["type"];
  if (t === "settingsPageReady" || t === "recheckExternalExecutors" || t === "openVsCodeSettings") return hasOnlyKeys(m, ["type"]);
  if (t === "setComposerSendKey") {
    return isSettingsRequestId(m.requestId)
      && (COMPOSER_SEND_KEYS as readonly string[]).includes(m.sendKey as string) && hasOnlyKeys(m, ["type", "requestId", "sendKey"]);
  }
  if (t === "setApiKeyPolicy") {
    return isSettingsRequestId(m.requestId)
      && (API_KEY_POLICIES as readonly string[]).includes(m.policy as string) && hasOnlyKeys(m, ["type", "requestId", "policy"]);
  }
  if (t === "setRestoreTabsOnStartup" || t === "setLearningEnabled") {
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

export function isHostToSettingsPage(v: unknown): v is HostToSettingsPage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  const t = m.type as HostToSettingsPage["type"];
  if (t === "settingsState") {
    return (COMPOSER_SEND_KEYS as readonly string[]).includes(m.composerSendKey as string)
      && (API_KEY_POLICIES as readonly string[]).includes(m.apiKeyPolicy as string)
      && typeof m.restoreTabsOnStartup === "boolean"
      && typeof m.learningEnabled === "boolean"
      && typeof m.orchestrationEnabled === "boolean" && typeof m.conductorPolicy === "string"
      && typeof m.conductorPolicyDefault === "string"
      && isOrchestrationSettingRoster(m.orchestrationAgents) && isOrchestrationSettingRoster(m.orchestrationDefaults)
      && isExternalTimeout(m.externalTimeoutMinutes) && isExternalDetection(m.externalDetection) && isExternalModels(m.externalModels)
      && FILE_LINK_BOOLEAN_SETTINGS.every((key) => typeof m[key] === "boolean")
      && Array.isArray(m.openWithSystemApp) && m.openWithSystemApp.every((item) => typeof item === "string")
      && (m.replyTo === undefined || isSettingsRequestId(m.replyTo))
      && hasOnlyKeys(m, ["type", "composerSendKey", "apiKeyPolicy", "restoreTabsOnStartup", "learningEnabled", ...FILE_LINK_SETTINGS, "orchestrationEnabled", "orchestrationAgents", "orchestrationDefaults", "conductorPolicy", "conductorPolicyDefault", "externalTimeoutMinutes", "externalDetection", "externalModels", "replyTo"]);
  }
  t satisfies never;
  return false;
}

// Webview → 拡張（フェーズ2: マルチタブ。tabId は host が採番し init/tabCreated で通知する）
export type WebviewToHost =
  | { type: "ready"; cursor: { generation: number; seq: number } | null }
  // images は Host が自分の添付スロットから詰める欄で、wire では受けない
  // （isWebviewToHost の send は images キーを持つメッセージを丸ごと捨てる。R-CNV-11）
  | { type: "send"; tabId: string; text: string; clientToken?: string; images?: ImageAttachment[] }
  // 添付の預け入れ・取り消し。実体は Host が tabId ごとに保持し、応答は必ず attachments で返す
  | { type: "attachImage"; tabId: string; mediaType: ImageAttachment["mediaType"]; data: string }
  | { type: "removeAttachment"; tabId: string; attachmentId: string }
  | { type: "startHandoff"; tabId: string }
  | { type: "cancelHandoff"; tabId: string; runId: string }
  // 状態カードを展開したときだけ本文を取りに行く。part は 0 起算で順に要求する
  | { type: "getHandoffDetail"; tabId: string; runId: string; part: number }
  | { type: "openHandoffSource"; tabId: string; sourceSessionId: string }
  | { type: "interrupt"; tabId: string }
  | {
      type: "approvalDecision";
      tabId: string;
      requestId: string;
      behavior: "allow" | "deny";
      // AskUserQuestion の回答（機能B）。question文字列→選択labelまたは自由入力。
      // multiSelect はカンマ区切り。allow 以外では無視する
      answers?: Record<string, string>;
    }
  | { type: "newTab" }
  | { type: "closeTab"; tabId: string }
  // /clear: 会話履歴とCLIセッションを破棄して同タブで新規セッションを開始する
  | { type: "clearTab"; tabId: string }
  | { type: "setMode"; tabId: string; mode: PermissionModeId }
  | { type: "setModel"; tabId: string; model: string | null }
  | { type: "setEffort"; tabId: string; effort: string | null }
  | { type: "queryFiles"; reqId: number; query: string }
  // ファイル選択ダイアログを開く。imageSlots は「あと何枚を画像として添付できるか」で、
  // 超えた分と画像でないものは Host がパスとして返す
  | { type: "pickFiles"; reqId: number; imageSlots: number }
  | { type: "openFile"; tabId: string; target: string }
  | { type: "exportTab"; tabId: string }
  // /rename: Host がセッション JSONL へ custom-title を書き、タブ名と履歴一覧を同じ解決器で揃える（R-SES-05）
  | { type: "renameTab"; tabId: string; title: string }
  | { type: "listSessions"; source?: "laisora" | "claude"; cursor?: string }
  | { type: "analyzeSession"; sessionId: string; filePath: string }
  // 現在のタブのセッションを分析する（ファイルパスはホストが sessionId から解決する）
  | { type: "analyzeCurrent"; tabId: string }
  // セッション概要の要約（R-DSP-25）。そのタブの model・effort で生成し、Host が保存する
  | { type: "summarizeSession"; tabId: string }
  // VS Code 標準の配色テーマ選択を開く（/color の受け皿）
  | { type: "openThemePicker" }
  | { type: "runHostAction"; action: "openSettings" }
  | { type: "runHostAction"; action: "addClaudeModel"; tabId: string }
  // 起動直後でも利用率を出すため、CLIがローカルへ残したキャッシュを要求する
  | { type: "requestCachedUsage" }
  | {
      type: "agentInspectorRequest";
      tabId: string;
      agentId: string;
      section: AgentInspectorSection;
      requestId: string;
      // Host が発行した不透明tokenだけを往復する。file path/byte offset/limitは受け取らない。
      cursor?: string;
    }
  // 作業ログの過去イベントを1 chunk ぶん古い側へ取り寄せる（会話履歴 Lazy Loading フェーズ1）。
  // cursor は Host が発行した不透明token。anchor は Host が pushEvent で採番して同じ webview へ
  // 既に渡した識別子で、初回要求のときだけ使う（ready の cursor と同じ語彙）。
  // どちらか一方だけを載せる。file path/byte offset/chunk件数は受け取らない（上の :445 と同じ規則）
  | {
      type: "historyChunkRequest";
      tabId: string;
      requestId: string;
      cursor?: string;
      anchor?: { generation: number; seq: number };
    }
  // 作業ログの過去イベントを transcript から読み直して取り寄せる（R-TAB-07）。
  // cursor は Host 発行 token、初回は anchor。file path / offset は受け取らない
  | {
      type: "worklogTranscriptRequest";
      tabId: string;
      requestId: string;
      cursor?: string;
      anchor?: { generation: number; seq: number };
    }
  // 会話ログの過去メッセージを1 chunk ぶん古い側へ取り寄せる（Lazy Loading フェーズ2）。
  // 表示専用の経路で、Host 側は transcript を読むだけ。pushEvent / EventLog / semantic
  // ingestion のどれにも入れない（ユーザー裁定）。
  // cursor は Host が発行した不透明token。初回は cursor 無しで「画面に出ている最古より前」を
  // 要求する。file path / byte offset / 件数は受け取らない（historyChunkRequest と同じ規則）
  // anchorUuid は Host が搬送した識別子の往復で、cursor と同じ扱い（webview が任意の
  // 位置を作れるわけではない）。cursor が Host 側の LRU 退避や世代更新で無効になったとき、
  // これが無いと Host は最初の起点から返し直すしかなく、遡りの位置が黙って巻き戻る
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
  // 作業ログの LLM 意味分析をユーザーの明示操作で1回だけ起動する。
  // tabId 以外を受け取らない: modelId / prompt / timeout を webview から渡せる形にすると、
  // 課金される呼び出しのパラメータが UI 側の真実源になる（起動可否も含め Host が決める）
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
  // first-paint: init を受け取ってから活性タブが画面に載るまでの実測。時刻は document age
  // （performance.now）で、現在時刻は載せない（TB-7）
  // orphan-turn-adopted: turn_started 不着のまま本文デルタで開いたターン（OA-1〜OA-7）。
  // message は tabId と turnId だけで、本文を載せない
  | {
      type: "webviewDiagnostic";
      kind: "error" | "ready-retry" | "first-paint" | "orphan-turn-adopted";
      message: string;
    }
  // intoTabId: 未使用の会話タブがあればそこへ開く（新タブを増やさない）。ホスト側で
  // 「本当に未使用か」を判定し、使用中なら従来どおり新タブを作る
  | { type: "resumeSession"; sessionId: string; filePath: string; intoTabId?: string }
  // Resume fast path v4 F-4: live Session をresetせず表示 hydration だけを再試行する。
  | { type: "resumeHydrationRetry"; tabId: string }
  // 復帰の init は可視化の時点で飛ぶ（ready を待たない）ので、見ているタブを先に
  // 積むには Host が面ごとの最後の選択を覚えている必要がある
  | { type: "activeTab"; tabId: string };

export interface SessionListItem {
  originUnverified?: boolean;
  sessionId: string;
  filePath: string;
  title: string;
  cwd: string;
  mtime: number;
}

// 履歴一覧の走査で落ちたものを種類別に数える。1 個の真偽値へ畳まないこと。畳むと
// 利用者も次に触る者も「どの扉から欠けたか」を画面から判別できず、再発時に特定できない。
// resolveFailed は getSessionInfo が例外で落ちた件数だけを数える。要約を持たない候補は
// 欠落ではなく正常な読み飛ばしなので含めない
export interface SessionScanDegradation {
  rootFailed: boolean;
  unreadableProjects: number;
  statFailed: number;
  resolveFailed: number;
  // 候補は見つかったのに 1 行も出せなかったときの候補数。SDK の getSessionInfo は
  // 壊れた記録に対して例外を投げず undefined を返すことがあり、そのとき resolveFailed は
  // 0 のままになる。これを数えないと「候補 40 件・表示 0 件」が「セッションが見つかりません」
  // として断言される（走査は成功しているので rootFailed も立たない）
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

// ---------- WorkModel の公開面 ----------

// WorkModelState をそのまま流さない理由: toolPlacements は 8192 件規模の内部索引、
// segments は詳細カードが自分で持つ。version は WorkModelPayload の形の版であり
// PROTOCOL_VERSION とは別に動く（概要の項目追加でプロトコル全体を上げたくない）
// tasks / taskTotals を運ぶ。詳細ログのTODO行は、snapshot 再生の窓（1500件）から Task 更新イベントが
// 落ちても復元できる必要があり、イベント側の情報だけでは足りない
export const WORK_MODEL_VERSION = 3;

// 木の深さの上限。projection も同じ上限で辺を落とすので、自分で作った payload は必ず
// ガードを通る。ガード側だけに置くと、深い階層を復元した payload が丸ごと捨てられる
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
  agentId: string;
  // resume 時に transcript の実 agentId（meta.json 由来）が判明した場合の別名。
  // agentId 自体は経路不変の合成 ID を保つ（凍結期待値: 同値射影の除外は
  // 固定 allowlist のみ。値の置換は availability 欠落ではないため許されない）
  transcriptAgentId?: string;
  parentAgentId: string | null;
  toolUseId: string;
  // agent から親の tool-row を選ぶための識別子。
  // 落とすと後段が EventLog か DOM から推定し直すことになる
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

// ---------- Agent Inspector ----------

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
  // 「記録が無い（まだ書き出されていない）」。待てば出る
  | "session-unavailable"
  // 「記録があるかどうかを確かめられなかった」（保存先の走査が失敗）。待っても直らない。
  // session-unavailable や read-failed へ畳むと、待つ／読み直すという別の対処へ誘導する（R-37）
  | "session-scan-failed"
  | "agent-unavailable"
  | "transcript-unavailable"
  | "invalid-cursor"
  | "stale-request"
  | "read-failed"
  | "response-too-large"
  | "meta-limit";

// history-window.ts の同名型と構造だけを合わせる（import しない）。history-window.ts は
// node:crypto を実行時 import するので、値・型のどちらでもここから参照すると webview バンドルが
// 壊れる経路を作る。両者の一致は extension.ts の代入1箇所で tsc が検査するが、検出できるのは
// history-window.ts 側の削除・型変更だけ。非リテラル代入には余剰プロパティ検査が掛からないので、
// 向こうにフィールドを足しても tsc は落ちず、ここへ来ないまま webview へ届かない
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

// 前半5つは HistoryWindowErrorReason と同じ綴り。向こうへ足すと extension.ts の代入が落ちるが、
// 向こうから減らしても部分集合なので落ちない（ここと isHostToWebview の whitelist に死んだ
// reason が残る）。減らすときは両方を手で消すこと
// response-too-large は持たない。単一イベントが搬送予算を超えても本文を切って必ず送るので、
// この面はサイズを理由に失敗しない（R-CNV-01。extension.ts の fitEventForTransport 経路）。
// 復活させると「過去の読み込みが止まりました」の再開不能な行き止まりが戻る
export type HistoryChunkErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "ambiguous-identity"
  | "invalid-request"
  | "stale-request"
  | "host-error";

// 会話の過去 chunk。conversation-history.ts の同名型と構造だけを合わせる（import しない。
// 向こうは node:crypto を使うので webview バンドルが壊れる経路を作る）。
// uuid はレコード固有の識別子で、重複挿入の判定に使う。持たないレコードは運ばない
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
    // 登録した transcript 全体の値（page ごとではない）。読めなかった行と、uuid が無く
    // 運べなかった発言。数えるだけで運ばないと、会話が欠けたまま「読み終わった」になる（R-32）
    malformedLineCount?: number;
    droppedWithoutUuidCount?: number;
  };
}

export type ConversationHistoryErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "invalid-request"
  // 「そのセッションの記録が無い」。遡る対象が無いので終端でよい
  | "session-unavailable"
  // 「記録があるかどうかを確かめられなかった」。同期ロック・権限・競合で走査自体が失敗した。
  // session-unavailable と同じ扱いにすると、読めなかっただけの状態が「読み終わった」として
  // 進行表示から消える（R-17）。これは終端ではなく一過性の失敗として扱う
  | "session-scan-failed"
  | "read-failed"
  | "stale-request"
  | "response-too-large"
  | "host-error";

// resume で <sessionId>/subagents/agent-*.meta.json から復元したサブエージェント。
// meta には effort と時刻が無いため、それらは同名 transcript の先頭/末尾から採る
// （meta だけで確定するのは階層）
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
  // phase から詳細カード（segment）とターンへ辿るための識別子。
  // reducer 側で各64件に制限済みなので、そのまま運んでも上限は保たれる
  segmentIds: string[];
  segmentCount: number;
  turnIds: string[];
  turnCount: number;
  lastTurnId?: string;
  startedAt: number;
  endedAt?: number;
  isCurrent: boolean;
  // 実行状態の判定は work-model.ts の phaseStateOf だけが行う。renderer はこの値を描く
  state: WorkPhaseState;
  compactedPhaseCount?: number;
  agents: WorkAgentNode[];
}

// ---------- イベントに載せる配置と集計 ----------

// 概要（WorkModelPayload）と違い、こちらは1イベントごとに同期で届く。詳細カードは
// イベント処理のその場で置き先を決める必要があり、間引いた payload では間に合わない。
// また EventLog の保持範囲を超えて古い segment は payload から落ちるため、
// 再生されたイベントが作るカードの数値は payload からは復元できない。
// 値はすべて reducer 状態の写しで、ここで計算し直さない

export interface WorkPlacementView {
  // rollup へ併合済みの配置は "rollup"
  phaseId: string;
  segmentId?: string;
  // 明示タスク配下ならそのキー。詳細ログはこれでTODO行の中へ入れる
  taskKey?: string;
  // agent の子ツールは false（agent 1件として数え、二重計上しない）
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
  // 現在の segment（閉じたときは null）。変わったときだけ載る。これが無いと、ツールを
  // 使わないターンで webview 側が前ターンのカードを「現在の作業」として出し続ける
  currentSegmentId?: string | null;
  // tool_call_started のみ。記帳系（TodoWrite/TaskCreate/TaskUpdate）として解釈できたものには付かない
  placement?: WorkPlacementView;
  // このイベントで値が変わった分だけ。届いた分を上書きする（差分計算を webview へ持たせない）
  segments?: WorkSegmentView[];
  agents?: WorkAgentStateView[];
  taskTotals?: WorkTaskTotalsView[];
  // task の集合・状態が変わったときの全量（レベル信号）。TODOカードの正本
  tasks?: WorkTaskItemView[];
  // ターン境界で running から stale へ移った toolUseId
  staled?: string[];
  pendingApprovalCount?: number;
  // turn_completed のみ。そのターンの counted ツール件数。今は webview に消費点が無い（返信フッターは件数を出さない）
  turnToolCount?: number;
}

export interface PlanContext {
  blockId: string; start: number; end: number; text: string; running: boolean;
}

export interface WorkModelPayload {
  planDeclaration?: { goal: string; at: number };
  planHistory?: import("./work-model").PlanHistoryEntry[];
  planHistoryTruncated?: boolean;
  planContext?: PlanContext;
  planTools?: Array<{ id: string; name: string; description: string; startedAt: number }>;
  version: number;
  revision: number;
  coverage: WorkCoverage;
  currentPhaseId?: string;
  ambiguity?: "multiple-active-tasks";
  phases: WorkPhaseView[];
  // 親を特定できなかったサブエージェント。任意の親へ付けずここへ分離する
  unlinkedAgents: WorkAgentNode[];
  // Task の現在状態と集計。イベント側の tasks は「変わったとき」にしか載らないので、
  // 再生窓から Task更新イベントが落ちた snapshot では、これが唯一の復元元になる。
  // 無いと窓内にあるTask配下のツール行まで未接続DOMへ入って画面から消える
  tasks: WorkTaskItemView[];
  taskTotals: WorkTaskTotalsView[];
}

// ---------- SemanticModel の公開面 ----------

// deriveSemanticModel の出力を運ぶが、attempt の artifacts は ProjectedArtifactAccess へ
// 射影済みでなければならない。canonicalPath は Host-only で、どのフィールドからも
// Webview へ流さない。
// canonicalPath?: never は、未射影の HostArtifactAccess[] が構造的部分型として
// 素通りするのを型検査で塞ぐためのもの
export type SemanticArtifactView = ProjectedArtifactAccess & { canonicalPath?: never };

export type SemanticAttemptNodeView = Omit<ExecutionAttemptNode, "artifacts"> & {
  artifacts: SemanticArtifactView[];
};

export type SemanticNodeView = Exclude<SemanticNode, ExecutionAttemptNode> | SemanticAttemptNodeView;

// ---------- L3 の公開面（裁定A1） ----------

// `DivergenceRecord.coverage` は「その乖離を検出するための入力がどれだけ観測できたか」
// であって、record の存在の確からしさではない（裁定Q8）。record が在ること自体が観測事実なので
// **これを理由に record を隠してはならない**。表示側が Coverage を見て畳む実装を書けないよう、
// 公開面では名前を変えて運ぶ（record を出すか否かの判断は kind 側の state が持つ）
export type DivergenceRecordView = Omit<DivergenceRecord, "coverage"> & {
  detectionInputCoverage: Coverage;
};

export type DivergenceKindReportView = Omit<DivergenceKindReport, "records"> & {
  records: DivergenceRecordView[];
};

export type DivergenceReportView = Omit<DivergenceReport, "kinds"> & {
  kinds: Record<DivergenceKind, DivergenceKindReportView>;
};

// 裁定A1: L3 は SemanticModelPayload に内包して1経路で運ぶ（webview 側で再集計しない）。
// L3Report は canonicalPath 基底の値を持たない（basis は nodeId/edgeId/EvidenceRef、
// footprint 由来の値は件数のみ）ため、nodes と違い射影を要しない
export interface L3ReportPayload {
  facts?: AnalysisFactsView;
  analysis: L3Report;
  divergences: DivergenceReportView;
  // 省略可能（LLM は既定オフ）。undefined = 未着 / disabled = 既定オフ /
  // unavailable = 実行できなかった / completed かつ accepted 0 件 = 実行したが検証を
  // 通ったものが無い。4つは別物として描く（D-9/D-11: 棄却件数は要約行 rejectedCount に表示、棄却所見詳細は診断面に閉じる）
  llm?: LlmFindingReportView;
}

// 通常 UI 面の unavailable 理由。client 側の LlmAnalysisUnavailableReason は粒度が細かく、
// どれを本語彙のどれへ写すかは llm-report.ts が網羅的に決める（string を受けると
// tsc が写像漏れを検出できず、表示文言の無い理由コードがそのまま画面に出る）
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
  emptyStateLabel?: string;
  // 分析入力の被覆行（Host が組む）。再起動前の artifact には無い
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


// オプトイン時のみ Host が送る診断面。SemanticModelPayload からは辿れない。
// 検証器の観測可能性（候補数・棄却理由内訳・キャッシュ）はここに閉じる
export type LlmFindingDiagnosticsPayload =
  | { state: "unavailable"; reason: string }
  | {
      state: "completed";
      specVersion: number;
      provenance: LlmAnalysisProvenance;
      cacheState: "hit" | "miss";
      rejected: RejectedFinding[];
      // 件数は2段の漏斗。candidate は LLM が出した数であって検証器へ渡った数ではない
      // （candidate = schemaRejected + verified / verified = accepted + rejected）。
      // candidate に verified を当てるとスキーマ段の棄却が観測できなくなる
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

// version は SemanticModel 自身の SEMANTIC_MODEL_SPEC_VERSION が載る
// （WORK_MODEL_VERSION と同様、PROTOCOL_VERSION とは独立に動く）
// progress は Host-only（baseDir / canonicalPath を含む）。
// projection が runtime で落とすのに加え、型でも公開面から外す
export interface SemanticModelPayload extends Omit<SemanticModel, "nodes" | "progress"> {
  nodes: SemanticNodeView[];
  // 省略可能。undefined は「L3 未着」（導出前 / 導出失敗）。
  // **「L3 未着」と「指標が unavailable」と「observed 0」は別物**
  l3?: L3ReportPayload;
  // timeBuckets の読み直し（src/transcript-time-buckets.ts）で読めなかったもの。省略 = 欠落なし。
  // 読めなかった subagents/ を 0 本として timeBuckets に畳むと、並列していたセッションが
  // 「直列 100%」で描かれる（R-23）。任意フィールドは全て webview に描き手を持つ（G-COV-4）
  timeBucketsCoverage?: TimeBucketsCoverage;
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

// Task 表示に要る値の写し。reducer の値をそのまま並べるだけで、ここで数え直さない
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
    // meta.json は親の tool_use を持たない。推定で埋めると相関先を捏造することになる
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

// meta の parentAgentId は親を高々1つしか持たない。辿って再訪したら循環で、
// どちらの辺も採れない（ファイル名順で片側だけ採ると宣言順で階層が変わる）
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

// Host の materialized WorkModel を webview へ出す形へ落とす。分類も帰属もここでは行わない
// （reducer が決めた値と、meta 由来の識別情報の突き合わせだけ）。
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
  // live 側の agentId（reducer の合成ID）と meta 側の実 agentId の両方で引けるようにする。
  // 深い階層の meta が指す parentAgentId は実IDなので、合成IDだけでは親に到達できない
  const nodeByKey = new Map<string, WorkAgentNode>();
  const levelByNode = new Map<WorkAgentNode, number>();
  const matchedRestoredIds = new Set<string>();
  const phases: WorkPhaseView[] = [];
  const unlinkedAgents: WorkAgentNode[] = [];
  let depthLimitedCount = 0;

  // 親が見つかっても深さ上限を超えるなら、その辺だけを捨てて根へ回す。
  // 木ごと拒否すると壊れた一部のために payload 全体を失う
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
  // 浅い順に並べてから解決する。深い側を先に処理すると親がまだ登録されておらず
  // 「階層未確認」へ落ちる（実データは depth 3 まで）
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
    planDeclaration: state.planDeclaration,
    planHistory: state.planHistory,
    planHistoryTruncated: state.planHistoryTruncated,
    planTools: state.runningToolUseIds.flatMap(id => {
      const tool = findToolPlacement(state, id);
      return tool && !tool.stale && tool.parentToolUseId === null
        ? [{ id, name: tool.toolName, description: tool.description, startedAt: tool.startedAt }] : [];
    }),
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

// 1イベント分の配置と、そのイベントで変わった集計を取り出す。「何が変わったか」は
// revision の一致で決める（reducer が書き換えた枝にだけ現在の revision が入る）。
// 規則を再実装しないため、ここでは加減算も分類もしない。
// previousState は staled の判定にだけ使う（このイベントで初めて stale になったものだけを出す）
export function projectWorkEvent(
  previousState: WorkModelState,
  nextState: WorkModelState,
  event: NormalizedEvent
): WorkEventInfo | undefined {
  // 本文デルタはストリーミング中の最頻イベント。毎回集計を載せると EventLog と postMessage の
  // 量がデルタ数に比例して増えるので、配置先が変わった最初の1件だけ載せる。
  // 丸ごと除外すると、ツールを使わないターンで webview の「現在の作業カード」が
  // 前ターンのまま残る（reducer はデルタで新しい segment を開いている）
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
    // placement が付かない tool_call_started は「reducer が記帳系として扱った」ことを意味する。
    // その区別を webview へ渡すため、配置が無くても情報自体は必ず付ける
    // （付けないと webview 側で配置情報の欠落と区別できず、ツール名の表を持つことになる）
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

  // 走査するのは直前まで実行中だったものだけ。全 placement を見ると完了済みまで触る
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

// webview 側の同期再生上限で落とした詳細イベントを Host 由来の coverage へ合流させる。
// renderer 側で「Host は complete だがこの画面では欠けている」を分岐すると、
// 概要と詳細で別々の欠落判定を持つ状態へ戻る
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
    (m.planHistory === undefined || isArrayOf(m.planHistory, entry => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      return isNumber(row.at) && (row.kind === "user" || row.kind === "todos" &&
        (row.source === undefined || row.source === "tasks") && (row.created === undefined || typeof row.created === "boolean") && (row.removed === undefined || typeof row.removed === "boolean") && isArrayOf(row.items, isWorkTaskItemView));
    })) &&
    (m.planDeclaration === undefined || isPlanDeclaration(m.planDeclaration)) &&
    (m.planHistoryTruncated === undefined || typeof m.planHistoryTruncated === "boolean") &&
    (m.planContext === undefined || isPlanContext(m.planContext)) &&
    (m.planTools === undefined || isArrayOf(m.planTools, tool => {
      if (!tool || typeof tool !== "object") return false;
      const row = tool as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.name === "string" && typeof row.description === "string" && isNumber(row.startedAt);
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
    // 型と対の実行時検査。射影漏れの canonicalPath をここで止める
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

// ---- L3 payload のガード（裁定A1） ----

// counts / excludedPairCounts の共通形
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

// reason 文字列は enum をここへ複製せず string 検査に留める（語彙を2箇所に置くと
// 追加時に静かに食い違う）。表示側は未知の reason を落とさず「未観測」として描くこと
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

// L3Report.metrics のキー集合を型で固定する（指標追加時にここがコンパイルエラーになる）
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

// kind の集合を型で固定する（kind 追加時にここがコンパイルエラーになる）
const DIVERGENCE_KIND_KEYS: Record<DivergenceKind, true> = {
  serialization: true,
  unsupported_completion: true,
  progress_stagnation: true,
  declared_state_conflict: true,
};

// declared / observed は拡張点（unknown 型）なので値の形を検査しない。
// `divergenceId` は必須で緩めない: ID 無しの record を通すと「LLM finding は
// DivergenceRecord の ID の引用でしか乖離へ言及できない」が成立しない payload が
// LLM 分析へ届く（llm-finding-verify.ts はそれを unidentified として全件棄却する）。
// ID を持たない l3 は payload ごと落ち、l3 未着の表示へ縮退する
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
    // 診断値の欠落で l3 全体を落とさない（欠けると観測された乖離が UI から消える）。
    // 検出結果の正しさに関与しないので、必須にする側の利得が無い（裁定 P-2）
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
    h.label.length > 0
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

// 棄却側を運ぶ名前は通常 UI 面から落とす（本文も内訳も出さない）。
// rejectedCount は要約行に出すため許可する（D-9/D-11）
const LLM_REPORT_BANNED_KEYS = [
  "rejected",
  "byReason",
  "diagnostics",
  "candidateCount",
];

// 自由文（例外メッセージ）には LLM 本文が混ざりうる。コード語彙そのものを複製せず
// 「コード化されている」ことだけを検査する（新しいコードの追加で payload を落とさない）
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

// check / reason は llm-finding-verify.ts の enum を複製せず string 検査に留める
// （l3 の reason と同じ方針。語彙が増えるたびに二重管理へ戻さない）
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
  return hasOnlyKeys(learning, ["state", "note", "lines"])
    && (learning.state === "unobserved" || learning.state === "observed")
    && typeof learning.note === "string" && Array.isArray(learning.lines)
    && learning.lines.every(line => typeof line === "string")
    && (learning.state === "unobserved" ? learning.note.length > 0 && learning.lines.length === 0 : learning.lines.length > 0);
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
    (m.timeBucketsCoverage === undefined || isTimeBucketsCoverage(m.timeBucketsCoverage))
  );
}

export type ResumeHydrationPhase = "loading" | "complete" | "failed";

export const RESUME_PREVIEW_MESSAGE_MAX = 80;

// 「転記済みと同じ内容が書き直されている可能性」を出す比（R-HND-11）。機械側は重複を消さない
// （近似一致は決定の取り違えになる）ので、防御は指示文側に置き、ここは観測だけを持つ
export const DECISIONS_REWRITE_RATIO = 0.8;

// 記録から復元した引き継ぎカードの展開部を指す実行 ID（R-HND-10）。Host と webview が
// 同じ関数で作る。**固定値にしないこと**: intoTabId によるタブ再利用で同じ tabId に別セッションが
// 載ったとき、古い展開部の cache が一致して別会話の本文を返す
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
  // Resume fast path v4 F-2/F-5/F-8: hydration 中の表示差分だけを in-place で運ぶ。
  // 判別ユニオンは runtime guard（isResumeHydrationStateShape）と同じ制約を型に持たせるため:
  // phase 遷移か carrier のどちらか一方を必ず運び、reason は failed のときだけ許す。
  | {
      type: "resumeHydrationState";
      tabId: string;
      phase: Exclude<ResumeHydrationPhase, "failed">;
      // FP-1: 最初の描画は read-set 捕捉だけを待つ。tail の読取が終わったあと
      // 表示専用 preview をこれで追送する（tabCreated/tabCleared を二度撃たない）
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
  // activate=false は引き継ぎ先タブを裏で開く経路（R-HND-08: 完了時にフォーカスを奪わない）。
  // 他の経路は利用者の操作に対する応答なので true を送る
  | { type: "tabCreated"; tab: TabSnapshot; activate: boolean }
  | { type: "tabClosed"; tabId: string }
  | { type: "activateTab"; tabId: string }
  // /clear 完了通知。tab はクリア後の新スナップショット（webview側はタブを同位置で置換する）
  | { type: "tabCleared"; tab: TabSnapshot }
  // 復帰の init で deferred として積んだタブの中身。受け側は tabCleared と同じ手順で
  // その場に作り直す（並びとアクティブ選択を保つ）
  | { type: "tabRestored"; tab: TabSnapshot }
  | { type: "tabRenamed"; tabId: string; title: string }
  // 引き継ぎの状態通知。要約・逐語の本文はここへ載せない
  // （webview が展開したときだけ getHandoffDetail で取りに行く）
  | {
      type: "handoffStatus";
      tabId: string;
      runId: string;
      state: "running" | "failed" | "done";
      phase?: string;
      // compact 進行中の心拍ごとに載る（running・phase "compacting" のときだけ）。
      // since は elapsedMs の起点で、result 未着なら "compact_start"
      progress?: { heartbeats: number; elapsedMs: number; since: "compact_start" | "result" };
      reason?: string;
      detail?: string;
      message: string;
      source: { sessionId: string; title: string };
      fork?: { sessionId: string; tabId: string; title: string };
      compact?: { preTokens: number; postTokens: number };
      utteranceCount?: number;
      // F のうち JSON として読めず捨てた行数（done のときだけ。0 は載せない）
      unreadableLineCount?: number;
      // 決定行の転記の件数だけ（R-HND-11 / R-HND-12）。本文は handoffDetail の part 0 が運ぶ
      decisions?: {
        total: number;
        carried: number;
        extracted: number;
        removed: number;
        unknownIdRefs: number;
        warn?: { entries: number; bytes: number };
      };
    }
  // 状態カードの展開部。getHandoffDetail への応答で、1 通あたり
  // HANDOFF_DETAIL_MAX_BYTES 以下に分割する。summary は part 0 だけが運ぶ。
  // total===0 は「F を読めなかった」で、webview はその旨を出す
  | {
      type: "handoffDetail";
      tabId: string;
      runId: string;
      part: number;
      total: number;
      summary?: string;
      utterances: { n: number; at: string; kind: "typed" | "answer"; text: string; questions?: string[] }[];
      // 転記した決定行。summary と同じく part 0 だけが運ぶ
      decisions?: HandoffDecisions;
    }
  | { type: "modeChanged"; tabId: string; mode: PermissionModeId }
  | { type: "commands"; tabId: string; commands: SlashCommandInfo[] }
  | {
      type: "models";
      tabId: string;
      models: ModelInfo[];
    }
  // notice は Host が適用・保存を終えた後の結果文（適用済み / 保存失敗）。webview は選択直後に
  // 自前で「保存しました」を出さない（R-DSP-01: 保存前に保存済みを名乗らない）
  | { type: "modelChanged"; tabId: string; model: string | null; notice?: string }
  | { type: "effortChanged"; tabId: string; effort: string | null; notice?: string }
  | { type: "configuredEffortChanged"; tabId: string; effort: string | null; model?: string | null; defaultEffort?: string | null; appliedModel?: string | null; appliedEffort?: string | null }
  | { type: "files"; reqId: number; paths: string[] }
  // pickFiles の応答。キャンセルは paths / images とも空で返す（無応答にしない）
  | { type: "pickedFiles"; reqId: number; paths: string[]; images: ImageAttachment[] }
  // そのタブの未送信添付の全量。差分ではなく毎回全量を送り、webview は置き換えるだけにする
  | { type: "attachments"; tabId: string; items: PendingAttachmentInfo[] }
  // 履歴一覧は確定した行から逐次届く。requestId は listSessions 要求ごとに単調増加し、
  // パネル再オープンで走り出した新しい実行より小さい requestId の行は捨てる。
  // complete=false の到着は「まだ確認中」であって「これで全部」ではない（部分応答を
  // 0 件の根拠にしない）。complete=true が来て初めて件数が確定する
  // degraded は「走査中に読めなかったものがある」ことだけを運ぶ。complete=false へ逃がさない
  // こと（受信側は complete でないと「読み込んでいます…」を出し続け、断言が永久スピナーへ
  // 変わるだけになる）。complete は「走査が終わった」、degraded は「件数が本物ではない」
  | { type: "sessions"; source?: "laisora" | "claude"; nextCursor?: string; append?: boolean; requestId: number; sessions: SessionListItem[]; complete: boolean; degraded?: SessionScanDegradation }
  | { type: "analysis"; sessionId: string; filePath: string; report: unknown }
  // 成功時の analysis と対。これが無いと webview はペンディング表示をタイムアウトまで解除できない。
  // 要求元の面だけへ postTo で返す（全面へ配ると別タブの分析画面に理由が出る）。
  // kind "script" は analyzeCurrent / analyzeSession の失敗（ペンディング解除 + 理由）、
  // kind "action" は所見からの操作（startFindingSession / prepareHistoricalDraft）の拒否。
  // reason は Host が組んだ表示文。tabId が無い script 失敗は sessionId から表示先タブを引く（R-ANL-11）
  | { type: "analysisFailed"; kind: "script" | "action"; tabId?: string; sessionId?: string; reason?: string }
  | { type: "composerPrefill"; tabId: string; text: string }
  | { type: "editorContext"; path: string; startLine: number; endLine: number }
  // 概要表示用の materialized WorkModel。snapshot（init/tabCreated/tabCleared/tabRestored）が運ぶものと
  // 同じ projectWorkModel の出力で、live 更新のときだけこの経路で送る
  | { type: "workModel"; tabId: string; model: WorkModelPayload }
  // L2b semantic model の live 更新。snapshot が運ぶ semanticModel と同じ導出結果。
  | { type: "semanticModel"; tabId: string; model: SemanticModelPayload }
  | { type: "llmAnalysisSetting"; enabled: boolean }
  // 利用者設定の現在値。ready 応答と設定変更後に送る（snapshot には載せない）
  | { type: "userSettings"; composerSendKey: ComposerSendKey }
  // 会話面へ出す 1 行の system 表示。イベントログには残らない（modelChanged.notice と同じ性質）
  | { type: "tabNotice"; tabId: string; text: string }
  // LLM 分析の飛行中フラグ。開始/終了で post。snapshot の llmAnalysisRunning と同じ真偽値
  // running 中の進行は LLM 呼び出しの開始・完了ごとに載る（running:true のときだけ）。
  // failure は不可用で終えたときだけ載る。limit はどちらの上限で落ちたか（タイムアウト以外では欠ける）
  // refusal は実行を開始しなかった理由（Host 拒否・入力不足）。running:false にだけ載り、failure とは
  // 同居しない。未実行を分析結果（attemptFailed / unavailable）として描かせないための別スロット（R-ANL-11）
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
  // セッション概要の要約の状態（R-DSP-25）。summary は生成完了時に載る。saveFailed=true は
  // 生成できたが永続化に失敗した（表示はできるが再起動で消える。Webview は「保存済み」と
  // 表示してはならない — R-DSP-01）。
  // failure は実行しなかった / 生成できなかった理由（running:false にだけ載る）。summary は既存の要約を
  // そのまま運ぶので、失敗の通知が保存済みの要約を消さない（R-DSP-25）
  | { type: "sessionSummary"; tabId: string; running: boolean; summary?: { text: string; model: string }; saveFailed?: boolean; failure?: string }
  // 棄却された LLM finding の診断面。Host はオプトイン時のみ送る。
  // 通常 UI が読む SemanticModelPayload / L3ReportPayload からは到達できない別経路にする。
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
  // 作業ログの過去 chunk。EventLog へは入れず（入れると EVENT_LOG_MAX を跨いで coverage が
  // 反転する）、この経路だけで webview の窓へ prepend する。
  // generation は応答時点の世代であって照合用ではない。CLI 再起動で世代だけが進んでも登録は
  // 生きているので、webview がこれを破棄条件に使うと正当な応答を捨てる。破棄は requestId で行う
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
  // 作業ログの過去 chunk（transcript 読み直し由来。R-TAB-07）。破棄は requestId で行う
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
  // 会話の過去 chunk。historyChunkResult と同じ扱い: EventLog へは入れず、この経路だけで
  // webview の会話面へ prepend する。
  // generation は応答時点の世代であって照合用ではない。破棄は requestId で行う
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
  // ~/.claude.json の cachedUsageUtilization 由来。ターン未実行でも利用率を出すために使う
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
  // 復帰の init が運ぶ「まだ中身を積んでいないタブ」。events は空・workModel は無い。
  // 空の events は「0 件」の主張ではなく、受け側は読み込み中の表示を出す
  // （R-TAB-08 / R-CNV-02）。中身は tabRestored で後から届く
  deferred?: true;
  state: ConversationSnapshot;
}

export interface ConversationSnapshot {
  conversationId: string | null;
  cwd: string;
  turnState: "idle" | "running" | "interrupting";
  auth: AuthStatus | null;
  // 接続前表示用の設定値（実測の auth が来たらそちらを優先表示）
  configModel?: string;
  configEffort?: string;
  // 設定に effort が無いとき、実行中 CLI が既定として使う effort（get_settings の applied.effort）
  defaultEffort?: string;
  // 実行中 CLI が次のリクエストで使う model（get_settings の applied.model）。resume では記録の model で、configModel より優先する
  appliedModel?: string;
  // get_settings の applied.effort。null = CLI が effort を送らない。configEffort / defaultEffort はこれと一致するときだけ立つ
  appliedEffort?: string | null;
  recordedModel?: string;
  permissionMode: PermissionModeId;
  commands?: SlashCommandInfo[];
  models?: ModelInfo[];
  // setModel による実行中上書き（null = 既定モデル）
  modelOverride?: string | null;
  effortOverride?: string | null;
  // resume で開いたタブのとき、元セッションの識別子。作業ログから分析タブを開く導線に使う
  resumeSessionId?: string;
  resumeFilePath?: string;
  handoffSource?: {
    sessionId: string;
    title?: string;
    compact?: { preTokens: number; postTokens: number };
    utteranceCount?: number;
    detailRunId?: string;
    // 封筒が運ぶ決定行の本数（消した行を含む）。これが無いと復元したカードは決定行の展開部を
    // 作れず、他の展開を開いて part 0 が届くまで決定行へ到達する導線が無い（R-HND-11）
    decisionCount?: number;
  };
  resumeHydration?: ResumeHydrationSnapshotState;
  // Host が保持する materialized WorkModel。イベント再 fold で作らせない
  workModel?: WorkModelPayload;
  planUsage?: import("./plan-usage").PlanUsage;
  // semanticView の明示状態。「未着」と「明示off」を同一視しない。
  // true = on（semanticModel が無ければ未着/導出失敗）、false = 設定で明示off
  semanticView?: boolean;
  semanticModel?: SemanticModelPayload;
  llmAnalysisEnabled?: boolean;
  llmAnalysisRunning?: boolean;
  // Webview を作り直した時点の最後の観測。飛行中でも最初の call 通知前は存在しない。
  // elapsedMs は snapshot 時点まで Host の壁時計で進めてから渡す。
  llmAnalysisProgress?: LlmAnalysisRunProgress;
  // 保存済みのセッション概要の要約（R-DSP-25）。無ければ 1 つ目のプロンプトを表示する
  sessionSummary?: { text: string; model: string };
  sessionSummaryRunning?: boolean;
  // 診断表示の**実効**状態（semanticView と同じ3値）。診断設定単体ではなく分析設定との積であることに
  // 注意。true = 両方 on、false = どちらかが off（Webview は診断パネルを DOM ごと撤去する）
  llmDiagnostics?: boolean;
  // 復帰の init は見ているタブの events を末尾側だけ運ぶ。落とした先頭側は Host の履歴窓に
  // 残っており、受け側は窓落ちとして数えて遡り（historyChunkRequest）で埋める。
  // 省略していない snapshot には載せない（0 件を運ぶと「省略なし」の表現が 2 通りになる）。
  // count は windowEvents の droppedCount と同じ正味の件数。backfilledHead=true のときは
  // events[0] が先頭へ戻した turn_started で、events[0] と events[1] は連続していない
  headOmitted?: { count: number; hasConvEvent: boolean; backfilledHead: boolean };
  // Host が全イベントを畳んだ点灯・帯の背景側の現在値。webview は再生の後にこれで置き換える（R-SES-02）。
  // 空 = 活動なしの確定値（ストリームが閉じた Host も空を運ぶ）
  backgroundActivity?: BackgroundActivitySnapshot;
  events: NormalizedEvent[];
}

export function isWebviewToHost(v: unknown): v is WebviewToHost {
  if (typeof v !== "object" || v === null) return false;
  // 網羅性ガードのため既知のリテラル和集合として扱う（実値の検証は各 if 内で行う。
  // ここでの as は「t の静的型を絞る」ためだけで、実行時の妥当性は保証しない）
  const t = (v as { type?: unknown }).type as WebviewToHost["type"];
  const tabId = (v as { tabId?: unknown }).tabId;

  if (t === "ready") {
    // cursor は null または {generation, seq}（レビューP2-2: 型検証の抜けを塞ぐ）
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
    return (
      typeof tabId === "string" &&
      (model === null || (typeof model === "string" && model.length <= 100))
    );
  }
  if (t === "listSessions") {
    const q = v as { source?: unknown; cursor?: unknown };
    return (q.source === undefined || q.source === "laisora" || q.source === "claude") &&
      (q.cursor === undefined || (typeof q.cursor === "string" && /^\d+:\d+$/.test(q.cursor)));
  }
  if (t === "analyzeSession") {
    return (
      typeof (v as { sessionId?: unknown }).sessionId === "string" &&
      typeof (v as { filePath?: unknown }).filePath === "string"
    );
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
    // 上限（slots <= IMAGE_MAX_COUNT）は R-CNV-05 を守る: 超過を通すと Host が
    // IMAGE_MAX_COUNT を超える images を返しうる。その応答は isHostToWebview の
    // pickedFiles ガードで落ち、main.ts が丸ごと捨てるので、選んだパスが 1 件も
    // 入力欄へ入らない（R-CNV-05）。
    // 型・非負の検査はこの経路とは無関係で（負の slots は全件がパスへ回るだけ）、
    // 守る要件は特定できていない
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
    // images を許可キーに戻さないこと。戻すと「押した瞬間の activeTabId」宛てに webview の
    // 手持ちが載る経路が復活し、添付が別の会話へ入る（R-CNV-11）。添付は Host が tabId の
    // スロットから取り出す
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
    // L-3: 質問数上限(4)を大きく超える混入やDoS的なキー水増しを防ぐ（キー数≤8）。
    // キー長は質問文の妥当な範囲（≤2000）、空文字キーは拒否
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
  // 網羅性ガード: WebviewToHost に新バリアントを追加してここに分岐を足し忘れると、
  // t がここで never に絞り込まれず tsc が落ちる（実行時の分岐漏れではなく型検査で捕まえる。
  // isHostToWebview と対称にする＝B4-4）
  t satisfies never;
  return false;
}

// 拡張(host) → Webview のランタイム型ガード（R2-4 B-4a）。
// isWebviewToHost（webview→拡張）とは非対称に検証範囲を絞る:
// - トップレベルの type 判別と必須フィールドの型は isWebviewToHost と同じ厳密さで検証する
//   （壊れたメッセージを受信側の as キャストへ素通りさせないため。isWebviewToHost はここが本体）。
//   ただし値域・長さ制限（length 上限や effort の集合メンバシップ）は host 方向では課さない。
// - NormalizedEvent の kind ごとの追加必須フィールド（turnId 等）・AuthStatus の内部・
//   AnalysisReport（report は protocol.ts 上も unknown 型）は検証しない。ここまで踏み込むと
//   型定義の二重管理になり、protocol.ts を変更するたびにバリデータ側も直す羽目になる
//   （isWebviewToHost が images/answers を検証する深さ＝配列要素の必須フィールドの型止まり、に揃えた）。
// - host は同一拡張内の信頼できる送信元なので、ここでの目的は悪意ある入力の遮断ではなく
//   protocol変更時の型崩れを早期に検出すること。検出できる時点は変更の種類で異なる:
//   バリアント追加漏れはコンパイル時（末尾の never チェック）、フィールド名変更は
//   ランタイム受信時のみ（インラインの typeof 検査は改名に静的追従しない）。
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

// 上限は搬送量の歯止め。text は表示本文なので長くなりうるが、無制限だと1 chunk で
// postMessage を詰まらせる。Host 側も同じ上限で切ってから送る
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

// 詳細ログはこの値だけを見て描くので、形が違うイベントは events ごと落とす。
// 緩めると「配置不明のまま描画へ進む」経路ができ、DOM 側の推測が復活する
export function isWorkEventInfo(v: unknown): v is WorkEventInfo {
  if (typeof v !== "object" || v === null) return false;
  const info = v as Record<string, unknown>;
  if (!isNumber(info.revision)) return false;
  // segment が閉じたことは null で伝える。isOptionalString は null を弾くので個別に見る
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

// TabSnapshot は init.tabs / tabCreated.tab / tabCleared.tab / tabRestored.tab の4箇所で使うため共有する
// count は 1 以上の整数だけを受理する。0 や負値を通すと「省略していない」が
// undefined と count:0 の 2 通りで表現され、受け側の分岐が二重になる
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

// R-SES-02。id の空文字は拒まない: claude-normalizer は task_id の無い集合要素を id "" で出し、
// 拒むと init ごと捨てられて全タブが空になる
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
  // 省略可能だが値は true 以外を認めない。false を運べると「deferred でない」の
  // 表現が 2 通りになり、受け側の分岐が二重になる
  if (t.deferred !== undefined && t.deferred !== true) return false;
  if (typeof t.state !== "object" || t.state === null) return false;
  const s = t.state as Record<string, unknown>;
  return (
    (s.conversationId === null || typeof s.conversationId === "string") &&
    typeof s.cwd === "string" &&
    (s.turnState === "idle" || s.turnState === "running" || s.turnState === "interrupting") &&
    (s.auth === null || typeof s.auth === "object") &&
    (PERMISSION_MODES as string[]).includes(s.permissionMode as string) &&
    // 省略可能にするのは commands?/models? と同じ扱い。存在するなら中身は緩めない
    (s.workModel === undefined || isWorkModelPayload(s.workModel)) &&
    (s.planUsage === undefined || isPlanUsage(s.planUsage)) &&
    (s.semanticView === undefined || typeof s.semanticView === "boolean") &&
    (s.semanticModel === undefined || isSemanticModelPayload(s.semanticModel)) &&
    (s.effortOverride === undefined || s.effortOverride === null || typeof s.effortOverride === "string") &&
    (s.defaultEffort === undefined || typeof s.defaultEffort === "string") &&
    (s.appliedModel === undefined || typeof s.appliedModel === "string") &&
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

export function isHostToWebview(v: unknown): v is HostToWebview {
  if (typeof v !== "object" || v === null) return false;
  // 網羅性ガードのため既知のリテラル和集合として扱う（実値の検証は各 if 内で行う。
  // ここでの as は「t の静的型を絞る」ためだけで、実行時の妥当性は保証しない）
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
    // R-HND-08: activate の欠落・非 boolean を通すと、引き継ぎ先タブが裏で開く経路が
    // 「常に前面へ出す」へ退化して完了時にフォーカスを奪う
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
    // 入力欄と添付欄へ差し込む前に形を確かめる（R-CNV-05）。
    // ただし paths.length の上限は Host 側の切り捨て（PICKED_FILE_MAX_COUNT）との整合検査で、
    // R-CNV-05 を守るものではない（むしろ制限する側。守る要件は未確定）
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
    // report: unknown は中身を見ない契約（analysis.ts の AnalysisReport 変更のたびに
    // ここを直す二重管理を避けるため）。存在有無すら問わない — unknown は undefined も含む
    return (
      typeof (v as { sessionId?: unknown }).sessionId === "string" &&
      typeof (v as { filePath?: unknown }).filePath === "string"
    );
  }
  if (t === "analysisFailed") {
    const m = v as Record<string, unknown>;
    const allowed = new Set(["type", "kind", "tabId", "sessionId", "reason"]);
    if (!Object.keys(m).every((key) => allowed.has(key))) return false;
    if (m.kind !== "script" && m.kind !== "action") return false;
    if (tabId !== undefined && (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 200)) return false;
    if (m.sessionId !== undefined && typeof m.sessionId !== "string") return false;
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
    return (COMPOSER_SEND_KEYS as readonly string[]).includes((v as { composerSendKey?: unknown }).composerSendKey as string);
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
      // 未実行の理由は実行中・失敗と同居しない（3 状態の区別を wire で崩さない。R-ANL-11）
      (refusal === undefined ||
        (typeof refusal === "string" && refusal.length > 0 && m.running === false && failure === undefined))
    );
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

  // 網羅性ガード: HostToWebview に新バリアントを追加してここに分岐を足し忘れると、
  // t がここで never に絞り込まれず tsc が落ちる（実行時の分岐漏れではなく型検査で捕まえる）
  t satisfies never;
  return false;
}
