import { subagentResultForDisplay } from "./subagent-result";
import { createHash, randomUUID } from "node:crypto";
import * as l10n from "@vscode/l10n";
import type { Hash } from "node:crypto";
import type {
  AuthStatus,
  EventProvenance,
  NormalizedEventBody,
  RuntimeCapability,
  TaskNotificationInfo,
  UsageSnapshot,
} from "./protocol";
import { assistantUsageFromRaw, summarizeToolInput } from "./protocol";
import type { HostArtifactAccess } from "./artifact-access";
import { extractResumeSignals, extractStage0ToolFields, RESUME_SIGNAL_TOOL_NAMES } from "./tool-observation";
import { redactAbsolutePaths, redactOptional } from "./path-redaction";

// Only CLI-generated local-command replies are UI notices. Ordinary model/user
// text and the original transcript must retain their original language.
export function localizeLocalCommandReply(record: Record<string, unknown>, text: string): string {
  const message = record.message as Record<string, unknown> | undefined;
  if (message?.model !== "<synthetic>" || !record.local_command_source) return text;
  const match = /^Set effort level to (low|medium|high|xhigh|max) \(this session only\): (.+)$/.exec(text);
  if (!match) return text;
  let description = match[2] === "Quick, straightforward implementation with minimal overhead"
    ? l10n.t("Quick, straightforward implementation with minimal overhead")
    : match[2] === "Comprehensive implementation with extensive testing and documentation"
      ? l10n.t("Comprehensive implementation with extensive testing and documentation")
      : match[2] === "Balanced approach with standard implementation and testing"
        ? l10n.t("Balanced approach with standard implementation and testing")
        : match[2].startsWith("Deeper reasoning than high, just below maximum")
          ? l10n.t("Deeper reasoning than high, just below maximum") + match[2].slice("Deeper reasoning than high, just below maximum".length)
          : match[2].startsWith("Maximum capability with deepest reasoning.")
            ? l10n.t("Maximum capability with deepest reasoning.") + match[2].slice("Maximum capability with deepest reasoning.".length)
            : match[2];
  description = description.replace(
    "May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.",
    l10n.t("May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.")
  );
  return l10n.t("Effort set to {0} for this session: {1}", match[1], description);
}

export interface NormalizedOutMeta {
  timestamp?: number;
  hostArtifacts?: HostArtifactAccess[];
  // longGap の境界時刻（このイベントより前に起きたもの）。イベントを生まない
  // 事象（起動未観測で破棄した task-notification）を走査へ渡す側チャネル（裁定C2）。
  // history 側は HistoryEvent.gapBoundaries が同じ役割を持つ
  gapBoundaries?: readonly number[];
}

export interface ClaudeLiveNormalizerOptions {
  cwd: string;
  initialObservedTimestamp?: number;
  log: (msg: string) => void;
  loadAgentDef?: (subagentType: string) => { model?: string; effort?: string } | undefined;
  emit: (body: NormalizedEventBody & { provenance?: EventProvenance }, meta?: NormalizedOutMeta) => void;
  onTurnEnd?: (turnId: string, kind: "turn_completed" | "turn_interrupted" | "turn_failed") => void;
  isClosed?: () => boolean;
  usageLimitPrefixes?: string[];
}

interface AssistantTextEvidenceState {
  streamBytes: number;
  streamHash: Hash;
  reconciledBytes: number;
  reconciledHash: Hash;
  reconciledPrefix: Buffer;
  finalDigests: Set<string>;
}

const ASSISTANT_TEXT_EVIDENCE_MAX_MESSAGES = 128;
const ASSISTANT_TEXT_EVIDENCE_MAX_FINALS = 8;
const ASSISTANT_TEXT_EVIDENCE_PREFIX_BYTES = 64 * 1024;

export function parseAliases(aliases: unknown): string[] | undefined {
  return Array.isArray(aliases) && aliases.length > 0 && aliases.every((alias) => typeof alias === "string")
    ? aliases
    : undefined;
}

export interface RefusalStop {
  category: string | null;
  explanation: string | null;
}

export interface RefusalNotice {
  hasFallback: boolean;
  scopeIsLocal: boolean;
  originalModel: string | null;
  fallbackModel: string | null;
  category: string | null;
  explanation: string | null;
  content: string | null;
  retractedMessageUuids: string[];
}

// CLI は同じ値を 2 通りに直列化する。SDK ストリームは snake_case、transcript は camelCase で、
// claude.exe 内に `is_api_error_message` ⇄ `isApiErrorMessage` の相互変換が実在する。
// 片側だけ読むと経路によって静かに素通りする
function dualString(record: Record<string, unknown>, snake: string, camel: string): string | null {
  const raw = record[snake] ?? record[camel];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// このフレームの本文はモデルの発話ではなく CLI が生成したエラー文である、という印。
// sdk.d.ts には出ない @internal フィールド
export function isApiErrorFrame(record: Record<string, unknown>): boolean {
  return record.isApiErrorMessage === true || record.is_api_error_message === true;
}

// message.stop_reason / stop_details は Messages API の形のまま両経路を素通りする（snake_case）。
// stop_details.category は open string で、新カテゴリはスキーマ更新に先行してワイヤに乗るため
// 既知値の allowlist で分岐しない
export function parseRefusalStop(message: unknown): RefusalStop | null {
  if (typeof message !== "object" || message === null) return null;
  const msg = message as Record<string, unknown>;
  const details =
    typeof msg.stop_details === "object" && msg.stop_details !== null
      ? (msg.stop_details as Record<string, unknown>)
      : undefined;
  if (msg.stop_reason !== "refusal" && details?.type !== "refusal") return null;
  return {
    category: typeof details?.category === "string" ? details.category : null,
    explanation: typeof details?.explanation === "string" ? details.explanation : null,
  };
}

function uuidList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((uuid): uuid is string => typeof uuid === "string" && uuid.length > 0) : [];
}

// SDK の全フレームが必ず持つ wire uuid（sdk.d.ts で必須）。撤回はこの uuid でメッセージを指名する。
// message.id とは別の名前空間で、1 フレーム＝1 uuid（多ブロックはブロックごとの派生 uuid）
export function parseWireUuid(record: Record<string, unknown>): string | null {
  return typeof record.uuid === "string" && record.uuid.length > 0 ? record.uuid : null;
}

// 置き換える側のフレームに載る撤回指示。到着時に指名されたメッセージを退去させ、このフレームを
// その正本の置き換えとして扱う。ターン末 model_refusal_fallback の retracted_message_uuids とは
// 冪等（sdk.d.ts）。単語 1 つのキーなので dualString のような綴りの分岐は生じない
export function parseSupersedes(record: Record<string, unknown>): string[] {
  return uuidList(record.supersedes);
}

export function parseRefusalNotice(record: Record<string, unknown>): RefusalNotice | null {
  if (record.subtype !== "model_refusal_fallback" && record.subtype !== "model_refusal_no_fallback") {
    return null;
  }
  const retracted = record.retracted_message_uuids ?? record.retractedMessageUuids;
  return {
    hasFallback: record.subtype === "model_refusal_fallback",
    // scope を持たない CLI は session（＝本スレッドの切替）として扱う（sdk.d.ts）
    scopeIsLocal: record.scope === "local",
    originalModel: dualString(record, "original_model", "originalModel"),
    fallbackModel: dualString(record, "fallback_model", "fallbackModel"),
    category: dualString(record, "api_refusal_category", "apiRefusalCategory"),
    explanation: dualString(record, "api_refusal_explanation", "apiRefusalExplanation"),
    content: typeof record.content === "string" && record.content.length > 0 ? record.content : null,
    retractedMessageUuids: uuidList(retracted),
  };
}

// 拒否フレームの本文は捨てず、エラー通知の本文として運ぶ。カテゴリは未知の値でも必ず出す
export function formatRefusalMessage(parts: {
  content: string | null;
  explanation: string | null;
  category: string | null;
}): string {
  const head = parts.content ?? parts.explanation ?? "model refusal";
  return parts.category && !head.includes(parts.category) ? `${head} [${parts.category}]` : head;
}

export function formatRefusalReason(category: string | null): string {
  return category ? `model_refusal: ${category}` : "model_refusal";
}

// 拒否フレームのうち、本文が CLI 生成のエラー文であるもの。吹き出しへ出さない対象。
// isApiErrorFrame が偽の拒否フレームは部分応答を運びうるので本文を捨てない
export function isRefusalErrorProse(record: Record<string, unknown>, message: unknown): boolean {
  return parseRefusalStop(message) !== null && isApiErrorFrame(record);
}

function parseTimestamp(msg: unknown): number | undefined {
  if (typeof msg === "object" && msg !== null && "timestamp" in msg) {
    const raw = (msg as { timestamp?: unknown }).timestamp;
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

export class ClaudeLiveNormalizer {
  currentTurnId: string | null = null;
  turnState: "idle" | "running" | "interrupting" = "idle";
  initSlashCommands: string[] | null = null;

  private sawMessageStartForTurn = false;
  private lastCompletedTurnId: string | null = null;
  private lastCompletedAssistantTextEvidence: AssistantTextEvidenceState | null = null;
  private lastAssistantError: string | null = null;
  // 回復していない refusal（フォールバックが走らなかった側）。refusal ターンの result の
  // subtype / is_error は未特定（transcript が result を記録しないため実記録から観測できない）
  // ので、result の形に依らずターンを失敗として閉じる
  private refusalWithoutFallback: RefusalStop | null = null;
  // 同一の refusal で assistant フレームと system 通知の両方から二重に通知しない
  private refusalNoticeEmitted = false;
  // ラベル未付与の assistant 本文を出したか（R-DSP-26）。本文を伴わないフレーム（tool_use だけ）で
  // ラベルを出すと、次に来る本文が前のフレームの uuid で撤回されうる
  private unlabeledAssistantText = false;
  private lastRootModel: string | null = null;
  private subagentModelReported = new Set<string>();
  // 委任 toolUseId → spawn したターン。background 委任の sidechain イベントは root turn 終了後
  // にも届くため、currentTurnId でなく起点ターンへ帰属させる（直前ターンへの帰属は、background
  // 実行中に次の root turn が始まると誤帰属になる）。
  private delegationTurnByToolUseId = new Map<string, string>();
  private usageLimitPrefixes: string[] = [];
  private notificationOrdinals = new Map<string, number>();
  // 起動ACK/resume で実在を観測した agentId だけ通知イベント化する。無条件に emit すると
  // 観測範囲外の通知が reducer の revision を進め、委任ゼロの既存セッションでも
  // semanticHash が変わる（fold 側ではどの委任にも一致せず no-op なのに）
  private observedAsyncAgentIds = new Set<string>();
  // 背景 Bash の task id。observedAsyncAgentIds と分けるのは session-transcript と同じ理由（役割が違う）
  private observedBackgroundTaskIds = new Set<string>();
  // 次の emit に相乗りさせる gap 境界時刻（emit を伴わない事象の搬送先）
  private pendingGapBoundaries: number[] = [];
  private taskEndTimes = new Map<string, number>();
  // SDK の result / system / stream_event は自前の timestamp を持たない（SDK 実測）。
  // 時刻の無い emit を消費側が Date.now() で埋めると導出へ実時刻が混入し、
  // live と history で segment の endedAt が食い違う。
  // 直近に観測した時刻を引き継ぐ。「自前の時計を持たないイベントは、最後に観測した時計より前ではない」
  private lastObservedTimestamp?: number;
  // partial stream と completed assistant snapshot は同じ本文を二重に運ぶ。message id ごとに
  // 観測済み stream 本文と completed snapshot を突合し、欠けた末尾だけを fallback にする。
  // 完了後に遅延 snapshot が来ても偽ターンを作らないよう turn 境界を越えて保持するが、
  // 常駐会話で無制限に増えないよう直近だけに制限する。
  private rootAssistantMessageId: string | null = null;
  private activeRootAssistantTextEvidence: AssistantTextEvidenceState | null = null;
  private assistantTextEvidence = new Map<string, AssistantTextEvidenceState>();
  private resumeSignalToolNames = new Map<string, string>();
  private emittedAssistantUsageMessageIds = new Set<string>();
  private rootAssistantUsage: ReturnType<typeof assistantUsageFromRaw> = {};
  // ゲートで捨てた task_notification の計数。破棄は fold 到達前で
  // EvidenceIndex からは観測できないため、Adapter 側の hash 非入力カウンタとして持つ
  droppedTaskNotificationCount = 0;

  constructor(private readonly opts: ClaudeLiveNormalizerOptions) {
    this.lastObservedTimestamp = opts.initialObservedTimestamp;
    if (opts.usageLimitPrefixes) {
      this.usageLimitPrefixes = [...opts.usageLimitPrefixes];
    }
  }

  seedObservedTimestamp(timestamp: number | undefined): void {
    if (this.lastObservedTimestamp === undefined) this.lastObservedTimestamp = timestamp;
  }

  setUsageLimitPrefixes(prefixes: string[]): void {
    this.usageLimitPrefixes = [...prefixes];
  }

  setTurnState(state: "idle" | "running" | "interrupting"): void {
    this.turnState = state;
  }

  private latestRateLimitReset: number | null = null;

  startTurn(turnId?: string, meta?: NormalizedOutMeta, automatic = false): string {
    const id = turnId ?? randomUUID();
    this.currentTurnId = id;
    this.turnState = "running";
    this.sawMessageStartForTurn = false;
    this.rootAssistantMessageId = null;
    this.activeRootAssistantTextEvidence = null;
    this.lastCompletedTurnId = null;
    this.lastCompletedAssistantTextEvidence = null;
    this.lastAssistantError = null;
    this.refusalWithoutFallback = null;
    this.refusalNoticeEmitted = false;
    this.unlabeledAssistantText = false;
    // send() は SDK record より先に呼ばれるため meta を渡せない。2ターン目以降は直近の
    // provider timestamp を引き継ぎ、Session の timestamp 契約で開始境界が落ちないようにする。
    const startMeta =
      meta?.timestamp === undefined && this.lastObservedTimestamp !== undefined
        ? { ...meta, timestamp: this.lastObservedTimestamp }
        : meta;
    this.emit({ kind: "turn_started", turnId: id, ...(automatic ? { cliInserted: true as const } : {}) }, startMeta);
    return id;
  }

  endTurn(
    kind: "turn_completed" | "turn_interrupted" | "turn_failed",
    extra?: {
      usage?: UsageSnapshot;
      reason?: string;
      errorKind?: "usage_limit";
      resetsAt?: number | null;
      detail?: string;
    },
    meta?: NormalizedOutMeta
  ): string | null {
    const turnId = this.currentTurnId;
    if (!turnId) return null;
    const completedEvidence = this.activeRootAssistantTextEvidence;
    this.currentTurnId = null;
    this.turnState = "idle";
    this.sawMessageStartForTurn = false;
    this.rootAssistantMessageId = null;
    this.activeRootAssistantTextEvidence = null;
    this.lastAssistantError = null;
    this.refusalWithoutFallback = null;
    this.refusalNoticeEmitted = false;
    this.unlabeledAssistantText = false;
    this.lastCompletedTurnId = kind === "turn_completed" ? turnId : null;
    this.lastCompletedAssistantTextEvidence = kind === "turn_completed" ? completedEvidence : null;

    if (kind === "turn_completed") {
      this.emit({ kind, turnId, usage: extra?.usage }, meta);
    } else if (kind === "turn_interrupted") {
      this.emit({ kind, turnId }, meta);
    } else {
      this.emit(
        {
          kind,
          turnId,
          reason: extra?.reason ?? "unknown",
          errorKind: extra?.errorKind,
          resetsAt: extra?.resetsAt,
          detail: extra?.detail,
        },
        meta
      );
    }

    this.opts.onTurnEnd?.(turnId, kind);
    return turnId;
  }

  handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      this.opts.log(`[unknown message type] ${JSON.stringify(msg)?.slice(0, 200) ?? String(msg)}`);
      return;
    }
    const record = msg as Record<string, unknown>;
    const ownTs = parseTimestamp(msg);
    if (ownTs !== undefined) this.lastObservedTimestamp = ownTs;
    // 先頭の時刻無しイベント（rate_limit / init 等）は引き継ぐ元が無いので undefined のまま
    const ts = ownTs ?? this.lastObservedTimestamp;
    const defaultMeta: NormalizedOutMeta | undefined = ts !== undefined ? { timestamp: ts } : undefined;

    switch (record.type) {
      case "system":
        if (record.subtype === "init") {
          if (Array.isArray(record.slash_commands)) {
            this.initSlashCommands = record.slash_commands as string[];
          }
          const isSubscription =
            record.apiKeySource === "oauth" ||
            record.apiKeySource === "none" ||
            record.apiKeySource === undefined;
          const runtime: RuntimeCapability | undefined =
            typeof record.claude_code_version === "string" || Array.isArray(record.tools)
              ? {
                  claudeCodeVersion:
                    typeof record.claude_code_version === "string" ? record.claude_code_version : undefined,
                  tools: Array.isArray(record.tools)
                    ? (record.tools as unknown[]).filter((t: unknown): t is string => typeof t === "string")
                    : undefined,
                }
              : undefined;
          const auth: AuthStatus = {
            provider: "claude",
            credentialSource: isSubscription ? "oauth-subscription" : "api-key",
            billingRealm: isSubscription ? "subscription" : "api",
            apiKeySource: typeof record.apiKeySource === "string" ? record.apiKeySource : undefined,
            model: typeof record.model === "string" ? record.model : undefined,
            effort: record.effort === null ? null
              : typeof record.effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(record.effort)
                ? record.effort as AuthStatus["effort"] : undefined,
            sessionId: typeof record.session_id === "string" ? record.session_id : undefined,
            verifiedAt: Date.now(),
            status: "verified",
            runtime,
          };
          this.emit({ kind: "auth_status", auth }, defaultMeta);
        } else if (record.subtype === "permission_denied") {
          this.emit(
            {
              kind: "permission_denied",
              turnId: this.currentTurnId,
              toolName: typeof record.tool_name === "string" ? record.tool_name : "unknown",
              reason:
                typeof record.decision_reason_type === "string"
                  ? record.decision_reason_type
                  : JSON.stringify(record),
            },
            defaultMeta
          );
        } else if (record.subtype === "api_retry") {
          this.emit(
            {
              kind: "api_retry",
              turnId: this.currentTurnId,
              attempt: typeof record.attempt === "number" ? record.attempt : 0,
              maxRetries: typeof record.max_retries === "number" ? record.max_retries : 0,
              retryDelayMs: typeof record.retry_delay_ms === "number" ? record.retry_delay_ms : 0,
              errorStatus: typeof record.error_status === "number" ? record.error_status : undefined,
              errorType: typeof record.error === "string" ? record.error : undefined,
            },
            defaultMeta
          );
        } else if (record.subtype === "commands_changed") {
          if (!Array.isArray(record.commands)) return;
          const commands: unknown[] = record.commands;
          this.emit(
            {
              kind: "commands_changed",
              commands: commands
                .filter(
                  (command: unknown): command is Record<string, unknown> =>
                    typeof command === "object" &&
                    command !== null &&
                    typeof (command as Record<string, unknown>).name === "string"
                )
                .map((command) => ({
                  name: command.name as string,
                  description: typeof command.description === "string" ? command.description : "",
                  aliases: parseAliases(command.aliases),
                })),
            },
            defaultMeta
          );
        } else if (record.subtype === "task_started") {
          if (record.task_type === "local_agent" && typeof record.task_id === "string" &&
            typeof record.tool_use_id === "string" && record.task_id && record.tool_use_id) {
            this.emit({ kind: "subagent_info", turnId: this.currentTurnId,
              toolUseId: record.tool_use_id, agentId: record.task_id }, defaultMeta);
          }
        } else if (record.subtype === "task_updated") {
          // patch.end_time は task_notification（同一 task_id・直後に届く）の唯一の時刻源。
          // system メッセージ自体は timestamp を持たない（SDK 実測）
          const patch = record.patch as Record<string, unknown> | undefined;
          if (typeof record.task_id === "string" && typeof patch?.end_time === "number") {
            this.taskEndTimes.set(record.task_id, patch.end_time);
          }
        } else if (record.subtype === "task_notification") {
          // live では task-notification は user record として届かず（SDK 実測）、
          // この system メッセージが唯一の搬送形。history 側は注入 user record の XML を
          // parseTaskNotification で読む — 経路ごとに入力の形は違うが出力イベントは同一
          if (typeof record.task_id === "string" && record.task_id.length > 0) {
            const usage = record.usage as { total_tokens?: unknown } | null | undefined;
            const tokens = usage?.total_tokens;
            this.emitTaskNotification(
              {
                agentId: record.task_id,
                ...(typeof record.tool_use_id === "string" && record.tool_use_id
                  ? { toolUseId: record.tool_use_id }
                  : {}),
                ...(typeof record.status === "string" && record.status
                  ? { status: record.status }
                  : {}),
                ...(typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? { tokens } : {}),
              },
              this.taskEndTimes.has(record.task_id)
                ? { timestamp: this.taskEndTimes.get(record.task_id) }
                : defaultMeta
            );
          }
        } else if (record.subtype === "background_tasks_changed") {
          const raw = Array.isArray(record.tasks) ? record.tasks : [];
          this.emit(
            {
              kind: "background_tasks",
              tasks: raw.map((t: Record<string, unknown>) => ({
                id: typeof t.task_id === "string" ? t.task_id : "",
                type: typeof t.task_type === "string" ? t.task_type : "unknown",
                description: typeof t.description === "string" ? t.description : "",
                ...(t.ambient === true ? { ambient: true as const } : {}),
              })),
            },
            defaultMeta
          );
        } else if (record.subtype === "compact_boundary") {
          const compactMeta = record.compact_metadata as Record<string, unknown> | undefined;
          const preTokens = compactMeta?.pre_tokens;
          this.emit(
            {
              kind: "compact_boundary",
              trigger: compactMeta?.trigger === "auto" ? "auto" : "manual",
              ...(typeof preTokens === "number" && Number.isFinite(preTokens) ? { preTokens } : {}),
            },
            defaultMeta
          );
        } else {
          const notice = parseRefusalNotice(record);
          if (notice) this.handleRefusalNotice(notice, record, defaultMeta);
        }
        break;

      case "stream_event": {
        const ev = record.event as Record<string, unknown> | undefined;
        if (
          ev?.type === "message_start" &&
          record.parent_tool_use_id == null &&
          this.turnState === "idle" &&
          !this.isClosed()
        ) {
          this.startTurn(undefined, defaultMeta);
          this.sawMessageStartForTurn = true;
        }
        if (ev?.type === "message_start" && this.currentTurnId && record.parent_tool_use_id == null) {
          this.sawMessageStartForTurn = true;
          const message = ev.message as Record<string, unknown> | undefined;
          this.rootAssistantUsage = assistantUsageFromRaw(message?.usage, false);
          this.rootAssistantMessageId =
            typeof message?.id === "string" && message.id.length > 0 ? message.id : null;
          this.activeRootAssistantTextEvidence = this.rootAssistantMessageId
            ? this.bindAssistantTextEvidence(this.rootAssistantMessageId, null)
            : this.createAssistantTextEvidence();
        }
        if (
          this.sawMessageStartForTurn &&
          ev?.type === "content_block_delta" &&
          (ev.delta as Record<string, unknown> | undefined)?.type === "text_delta" &&
          this.currentTurnId &&
          record.parent_tool_use_id == null
        ) {
          const text = ((ev.delta as Record<string, unknown>).text as string) ?? "";
          const evidence = this.activeRootAssistantTextEvidence ?? undefined;
          if (evidence !== undefined) {
            const bytes = Buffer.from(text);
            evidence.streamHash.update(bytes);
            evidence.streamBytes += bytes.length;
          }
          // 通常とは逆に completed snapshot が先着した場合も、後着deltaで本文を二重化しない。
          if (evidence === undefined || evidence.finalDigests.size === 0) {
            this.emit(
              {
                kind: "assistant_text_delta",
                turnId: this.currentTurnId,
                text,
              },
              defaultMeta
            );
            if (evidence !== undefined) {
              const bytes = Buffer.from(text);
              evidence.reconciledHash.update(bytes);
              evidence.reconciledBytes += bytes.length;
              evidence.reconciledPrefix = this.appendEvidencePrefix(evidence.reconciledPrefix, bytes);
            }
          } else if (!this.reconciledStartsWithStream(evidence)) {
            this.opts.log(
              `[contract] assistant late stream does not reconcile with final ` +
                `(messageId=${this.rootAssistantMessageId}, streamBytes=${evidence.streamBytes}, ` +
                `finalBytes=${evidence.reconciledBytes})`
            );
            this.emit(
              { kind: "assistant_text_delta", turnId: this.currentTurnId, text },
              defaultMeta
            );
            const bytes = Buffer.from(text);
            evidence.reconciledHash.update(bytes);
            evidence.reconciledBytes += bytes.length;
            evidence.reconciledPrefix = this.appendEvidencePrefix(evidence.reconciledPrefix, bytes);
          }
        }
        if (
          ev?.type === "message_delta" &&
          record.parent_tool_use_id == null &&
          this.currentTurnId &&
          this.rootAssistantMessageId &&
          !this.emittedAssistantUsageMessageIds.has(this.rootAssistantMessageId)
        ) {
          this.emittedAssistantUsageMessageIds.add(this.rootAssistantMessageId);
          if (this.emittedAssistantUsageMessageIds.size > 1000) {
            const oldest = this.emittedAssistantUsageMessageIds.keys().next().value;
            if (oldest !== undefined) this.emittedAssistantUsageMessageIds.delete(oldest);
          }
          this.emit(
            {
              kind: "assistant_usage",
              turnId: this.currentTurnId,
              messageId: this.rootAssistantMessageId,
              parentToolUseId: null,
              usage: { ...this.rootAssistantUsage, ...assistantUsageFromRaw(ev.usage, true) },
            },
            defaultMeta
          );
        }
        break;
      }

      case "assistant": {
        if (record.parent_tool_use_id == null && typeof record.error === "string" && record.error) {
          this.lastAssistantError = record.error;
        }
        const parentToolUseId =
          typeof record.parent_tool_use_id === "string" ? record.parent_tool_use_id : null;
        const msgObj = record.message as Record<string, unknown> | undefined;
        if (
          parentToolUseId === null &&
          typeof msgObj?.model === "string" &&
          !msgObj.model.startsWith("<") &&
          msgObj.model !== this.lastRootModel
        ) {
          this.lastRootModel = msgObj.model;
          this.emit(
            {
              kind: "model_observed",
              turnId: this.currentTurnId,
              model: msgObj.model,
            },
            defaultMeta
          );
        }
        if (
          typeof parentToolUseId === "string" &&
          typeof msgObj?.model === "string" &&
          !msgObj.model.startsWith("<") &&
          !this.subagentModelReported.has(parentToolUseId)
        ) {
          this.subagentModelReported.add(parentToolUseId);
          this.emit(
            {
              kind: "subagent_info",
              turnId: this.currentTurnId,
              toolUseId: parentToolUseId,
              model: msgObj.model,
            },
            defaultMeta
          );
        }
        const content = Array.isArray(msgObj?.content) ? (msgObj.content as Record<string, unknown>[]) : [];
        if (parentToolUseId === null) {
          const finalText = content
            .filter((block) => block.type === "text" && typeof block.text === "string" && block.text.length > 0)
            .map((block) => block.text as string)
            .join("");
          const refusalStop = parseRefusalStop(msgObj);
          const refusalIsErrorProse = refusalStop !== null && isApiErrorFrame(record);
          if (refusalStop !== null) {
            // result は currentTurnId が無いと何もしない。本文抑止でこのフレームは暗黙 startTurn の
            // 経路を通らないので、開いていなければここで開く（開かないと分類が消える）。
            // startTurn は下の 2 つの状態を消すので、必ず先に呼ぶ
            if (this.currentTurnId === null) this.startTurn(undefined, defaultMeta);
            this.refusalWithoutFallback = refusalStop;
            if (!this.refusalNoticeEmitted) {
              this.refusalNoticeEmitted = true;
              this.emit(
                {
                  kind: "error",
                  message: formatRefusalMessage({
                    content: refusalIsErrorProse && finalText.length > 0 ? finalText : null,
                    explanation: refusalStop.explanation,
                    category: refusalStop.category,
                  }),
                  fatal: false,
                },
                defaultMeta
              );
            }
          }
          // 別 message の遅延 final が本文を足さずに届いたとき、未ラベルの本文は進行中の message のもの。
          // ここでラベルを出すと進行中の本文が遅延側の uuid を名乗り、webview はその時点で記録が
          // 閉じたとみなす（R-CNV-09: 実行中送信の後ろで進行中の記録が割れる）
          let foreignFinalWithoutText = false;
          if (finalText.length > 0 && !refusalIsErrorProse) {
            const messageId = typeof msgObj?.id === "string" && msgObj.id.length > 0 ? msgObj.id : null;
            // 進行中の message と別の id を名乗る final（＝前ターンの遅延 final が新ターンの
            // ストリーム中に届く並び）は、進行中の evidence を provisional として渡さない。
            // 渡すと bindAssistantTextEvidence が旧 id を進行中 evidence へ張り替え、
            // 旧本文を進行中ストリームと突合し、rootAssistantMessageId まで旧 id へ倒れる。
            // 結果、進行中 message の final が dedupe されず本文が二重に出る。
            const isActiveMessage =
              messageId === null ||
              this.rootAssistantMessageId === null ||
              messageId === this.rootAssistantMessageId;
            const provisional = isActiveMessage
              ? this.activeRootAssistantTextEvidence ??
                (this.turnState === "idle" ? this.lastCompletedAssistantTextEvidence : null)
              : null;
            const evidence = messageId
              ? this.bindAssistantTextEvidence(messageId, provisional)
              : provisional ?? this.createAssistantTextEvidence();
            if (isActiveMessage) {
              if (evidence !== undefined) this.activeRootAssistantTextEvidence = evidence;
              if (messageId !== null) this.rootAssistantMessageId = messageId;
            }
            let fallbackText = finalText;
            if (evidence !== undefined) {
              const finalBytes = Buffer.from(finalText);
              const finalDigest = createHash("sha256").update(finalBytes).digest("hex");
              let replaceReconciled = true;
              if (evidence.finalDigests.has(finalDigest)) {
                fallbackText = "";
                replaceReconciled = false;
              } else if (this.finalStartsWithReconciled(finalBytes, evidence)) {
                fallbackText = finalBytes.subarray(evidence.reconciledBytes).toString("utf8");
              } else if (this.reconciledStartsWithFinal(finalBytes, evidence)) {
                fallbackText = "";
                replaceReconciled = false;
              } else {
                // 非prefixは欠落末尾として安全に合成できない。全文を黙って捨てず、契約違反を
                // 観測可能にした上で completed snapshot 自体を別deltaとして保持する。
                this.opts.log(
                  `[contract] assistant final text does not reconcile with stream ` +
                    `(messageId=${messageId}, streamBytes=${evidence.streamBytes}, ` +
                    `finalBytes=${finalBytes.length})`
                );
              }
              evidence.finalDigests.add(finalDigest);
              if (evidence.finalDigests.size > ASSISTANT_TEXT_EVIDENCE_MAX_FINALS) {
                const oldest = evidence.finalDigests.values().next().value as string | undefined;
                if (oldest !== undefined) evidence.finalDigests.delete(oldest);
              }
              if (replaceReconciled) {
                evidence.reconciledHash = createHash("sha256").update(finalBytes);
                evidence.reconciledBytes = finalBytes.length;
                evidence.reconciledPrefix = Buffer.from(
                  finalBytes.subarray(0, ASSISTANT_TEXT_EVIDENCE_PREFIX_BYTES)
                );
              }
            }
            if (fallbackText.length > 0) {
              // message_start/result との関連付けが欠けても、completed snapshot 自体は本文の
              // observable evidence。捨てずに同じ時刻で暗黙ターンを作り、表示可能にする。
              const turnId =
                this.currentTurnId ?? this.lastCompletedTurnId ?? this.startTurn(undefined, defaultMeta);
              // 暗黙startTurnは新message用stateを初期化するため、final-only経路では直後に
              // completed snapshotのstateを戻してresult/遅延再送まで同じmessageとして扱う。
              // 進行中の別messageがあるときは戻さない（戻すと以後のstream deltaが
              // 旧messageのevidenceへ積まれ、進行中messageのfinalが重複本文として出る）
              if (isActiveMessage) {
                this.activeRootAssistantTextEvidence = evidence;
                this.rootAssistantMessageId = messageId;
              }
              this.emit({ kind: "assistant_text_delta", turnId, text: localizeLocalCommandReply(record, fallbackText) }, defaultMeta);
            }
            foreignFinalWithoutText = !isActiveMessage && fallbackText.length === 0;
          }
          // 撤回は「退去させてから、このフレームを正本の置き換えとして扱う」順（sdk.d.ts）。
          // このフレーム自身のラベルより先に出す
          this.emitRetraction(parseSupersedes(record), defaultMeta);
          const wireUuid = parseWireUuid(record);
          // 拒否フレームは本文を抑止するが、ストリームで出した本文はもう画面にある。
          // ここでラベルを付けないと、その本文を後から名指しで撤回できない
          if (wireUuid !== null && this.unlabeledAssistantText && this.currentTurnId !== null && !foreignFinalWithoutText) {
            this.unlabeledAssistantText = false;
            this.emit(
              { kind: "assistant_message_uuid", turnId: this.currentTurnId, uuid: wireUuid },
              defaultMeta
            );
          }
        }
        for (const block of content) {
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            block.id &&
            typeof block.name === "string" &&
            RESUME_SIGNAL_TOOL_NAMES.has(block.name)
          ) {
            this.resumeSignalToolNames.set(block.id, block.name);
          }
          // sidechain（parentToolUseId あり）は root turn 終了後にも届くため、起点ターンへ帰属
          // させて捨てない。binding が無い sidechain は現行 turn へフォールバックせず破棄する
          // （binding evict・途中復元・未観測 spawn 由来を別 turn へ誤帰属させない）。
          // root の tool_use は従来どおり進行中ターンが必要
          const attributedTurnId =
            parentToolUseId !== null
              ? this.delegationTurnByToolUseId.get(parentToolUseId)
              : this.currentTurnId;
          if (block.type === "tool_use" && attributedTurnId) {
            const blockName = typeof block.name === "string" ? block.name : "";
            const blockId = typeof block.id === "string" ? block.id : "";
            const isAgentTool = blockName === "Task" || blockName === "Agent";
            if (isAgentTool && blockId) {
              this.delegationTurnByToolUseId.set(blockId, attributedTurnId);
              if (this.delegationTurnByToolUseId.size > 1000) {
                const oldest = this.delegationTurnByToolUseId.keys().next().value as string | undefined;
                if (oldest !== undefined) this.delegationTurnByToolUseId.delete(oldest);
              }
            }
            const input =
              typeof block.input === "object" && block.input !== null
                ? (block.input as Record<string, unknown>)
                : undefined;
            const isBackground = isAgentTool && input?.run_in_background === true;
            let subagentType: string | undefined;
            let subagentModel: string | undefined;
            let subagentEffort: string | undefined;
            if (isAgentTool && input) {
              subagentType = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
              const def = subagentType && this.opts.loadAgentDef ? this.opts.loadAgentDef(subagentType) : undefined;
              const inputModel =
                typeof input.model === "string" && input.model && input.model !== "inherit" ? input.model : undefined;
              subagentModel = inputModel ?? (def?.model && def.model !== "inherit" ? def.model : undefined);
              subagentEffort = def?.effort;
            }
            const stage0 = extractStage0ToolFields(blockName, input, blockId, this.opts.cwd);
            const provenance: EventProvenance = isAgentTool
              ? { path: "live", unavailableFields: ["effortMeasured"] }
              : { path: "live" };
            const meta: NormalizedOutMeta = {
              ...(ts !== undefined ? { timestamp: ts } : {}),
              ...(stage0.hostArtifacts ? { hostArtifacts: stage0.hostArtifacts } : {}),
            };
            this.emit(
              {
                kind: "tool_call_started",
                turnId: attributedTurnId,
                toolUseId: blockId,
                parentToolUseId,
                toolName: blockName,
                inputPreview:
                  blockName === "TodoWrite"
                    ? redactAbsolutePaths(JSON.stringify(block.input)).slice(0, 20_000)
                    : redactAbsolutePaths(JSON.stringify(block.input)).slice(0, 500),
                inputSummary: redactOptional(summarizeToolInput(blockName, block.input) ?? undefined),
                isBackground: isBackground || undefined,
                subagentType,
                subagentModel,
                subagentEffort,
                delegation: stage0.delegation,
                taskIntentStructured: stage0.taskIntentStructured,
                artifacts: stage0.artifacts,
                effectCoverage: stage0.effectCoverage,
                progressEmission: stage0.progressEmission,
                provenance,
              },
              meta
            );
          }
        }
        break;
      }

      case "user": {
        const msgObj = record.message as Record<string, unknown> | undefined;
        const content = msgObj?.content;
        // sidechain の tool_result も started と同じ規則で起点ターンへ帰属させる（Step 3.5）
        const resultParentToolUseId =
          typeof record.parent_tool_use_id === "string" ? record.parent_tool_use_id : null;
        const resultTurnId =
          resultParentToolUseId !== null
            ? this.delegationTurnByToolUseId.get(resultParentToolUseId)
            : this.currentTurnId;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              block.type === "tool_result" &&
              resultTurnId
            ) {
              const text = Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c && typeof c === "object" && c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : typeof block.content === "string"
                  ? block.content
                  : "";
              const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
              const resumeSignals = extractResumeSignals(this.resumeSignalToolNames.get(toolUseId), text);
              if (resumeSignals?.asyncLaunchedAgentId) {
                this.observedAsyncAgentIds.add(resumeSignals.asyncLaunchedAgentId);
              }
              if (resumeSignals?.resumedAgentId) {
                this.observedAsyncAgentIds.add(resumeSignals.resumedAgentId);
              }
              // 背景 Bash の通知もここで受理する。登録しないと emitTaskNotification のゲートで捨てられ、
              // 完了が永久に観測されない
              if (resumeSignals?.backgroundTaskId) {
                this.observedBackgroundTaskIds.add(resumeSignals.backgroundTaskId);
              }
              this.emit(
                {
                  kind: "tool_call_finished",
                  turnId: resultTurnId,
                  toolUseId,
                  isError: block.is_error === true,
                  resultPreview: redactAbsolutePaths(subagentResultForDisplay(text)).slice(0, 2000),
                  ...(resumeSignals ?? {}),
                },
                defaultMeta
              );
            }
          }
        }
        break;
      }

      case "rate_limit_event": {
        const info = (record.rate_limit_info as Record<string, unknown> | undefined) ?? {};
        this.latestRateLimitReset = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : null;
        this.emit(
          {
            kind: "rate_limit",
            status: String(info.status ?? "unknown"),
            rateLimitType: String(info.rateLimitType ?? "unknown"),
            utilization: typeof info.utilization === "number" ? info.utilization : 0,
            resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null,
            isUsingOverage: info.isUsingOverage === true,
            overageInUse: info.overageInUse === true,
          },
          defaultMeta
        );
        break;
      }

      case "result": {
        if (!this.currentTurnId) break;
        const usageRaw = record.usage as Record<string, unknown> | undefined;
        const usage: UsageSnapshot = {
          inputTokens: typeof usageRaw?.input_tokens === "number" ? usageRaw.input_tokens : undefined,
          outputTokens: typeof usageRaw?.output_tokens === "number" ? usageRaw.output_tokens : undefined,
          cacheCreationInputTokens:
            typeof usageRaw?.cache_creation_input_tokens === "number"
              ? usageRaw.cache_creation_input_tokens
              : undefined,
          cacheReadInputTokens:
            typeof usageRaw?.cache_read_input_tokens === "number"
              ? usageRaw.cache_read_input_tokens
              : undefined,
          totalCostUsd: typeof record.total_cost_usd === "number" ? record.total_cost_usd : undefined,
          raw: { usage: record.usage, modelUsage: record.modelUsage },
        };
        this.emit(
          {
            kind: "usage_update",
            scope: "turn",
            turnId: this.currentTurnId,
            usage,
          },
          defaultMeta
        );
        const successAborted =
          record.subtype === "success" &&
          typeof record.terminal_reason === "string" &&
          record.terminal_reason.startsWith("aborted");
        const interrupted =
          successAborted ||
          (this.turnState === "interrupting" && record.subtype !== "success") ||
          (record.subtype === "error_during_execution" && record.terminal_reason === "aborted_tools");
        if (interrupted) {
          this.endTurn("turn_interrupted", undefined, defaultMeta);
        } else if (this.refusalWithoutFallback !== null) {
          this.endTurn(
            "turn_failed",
            { reason: formatRefusalReason(this.refusalWithoutFallback.category) },
            defaultMeta
          );
        } else if (record.is_error) {
          const resultText = typeof record.result === "string" ? record.result : "";
          if (this.isUsageLimitText(resultText)) {
            const tailEpoch = Number(resultText.split("|")[1]);
            const resetsAt =
              Number.isFinite(tailEpoch) && tailEpoch > 0
                ? tailEpoch > 1e12
                  ? tailEpoch
                  : tailEpoch * 1000
                : null;
            this.endTurn(
              "turn_failed",
              {
                reason: "usage_limit",
                errorKind: "usage_limit",
                resetsAt: this.latestRateLimitReset ?? resetsAt,
                detail: resultText.split("|")[0].trim().slice(0, 300) || undefined,
              },
              defaultMeta
            );
          } else {
            const subtype =
              typeof record.subtype === "string" && record.subtype && record.subtype !== "success"
                ? record.subtype
                : "result_error";
            const detail =
              this.lastAssistantError ??
              (resultText
                ? resultText.slice(0, 300)
                : Array.isArray(record.errors) && record.errors.length
                  ? record.errors.map(String).join("; ").slice(0, 300)
                  : null);
            this.endTurn(
              "turn_failed",
              {
                reason: detail ? `${subtype}: ${detail}` : subtype,
              },
              defaultMeta
            );
          }
        } else {
          this.endTurn("turn_completed", { usage }, defaultMeta);
        }
        break;
      }

      default:
        this.opts.log(`[unknown message type] ${JSON.stringify(msg).slice(0, 500)}`);
        break;
    }
  }

  private emitRetraction(uuids: string[], meta?: NormalizedOutMeta): void {
    if (uuids.length === 0) return;
    this.emit({ kind: "assistant_retracted", turnId: this.currentTurnId, uuids }, meta);
  }

  private handleRefusalNotice(
    notice: RefusalNotice,
    record: Record<string, unknown>,
    meta?: NormalizedOutMeta
  ): void {
    // 通知は完全な監査記録で、置き換える側のフレームの supersedes と冪等（sdk.d.ts）。
    // 拒否の通知（error）より先に出す＝画面から退去させてから通知ブロックを積む
    this.emitRetraction(notice.retractedMessageUuids, meta);
    const message = formatRefusalMessage(notice);
    if (notice.hasFallback) {
      // scope=local は subagent / 側質問だけの切替でセッションのモデルは変わらない
      if (!notice.scopeIsLocal) this.refusalWithoutFallback = null;
      this.emit({ kind: "error", message, fatal: false }, meta);
      // 切替後のターンで再び拒否されたら、それは別の refusal として通知する
      this.refusalNoticeEmitted = false;
      return;
    }
    if (record.parent_tool_use_id == null) {
      if (this.currentTurnId === null) this.startTurn(undefined, meta);
      this.refusalWithoutFallback = { category: notice.category, explanation: notice.explanation };
    }
    if (this.refusalNoticeEmitted) return;
    this.refusalNoticeEmitted = true;
    this.emit({ kind: "error", message, fatal: false }, meta);
  }

  private createAssistantTextEvidence(): AssistantTextEvidenceState {
    return {
      streamBytes: 0,
      streamHash: createHash("sha256"),
      reconciledBytes: 0,
      reconciledHash: createHash("sha256"),
      reconciledPrefix: Buffer.alloc(0),
      finalDigests: new Set<string>(),
    };
  }

  private bindAssistantTextEvidence(
    messageId: string,
    provisional: AssistantTextEvidenceState | null
  ): AssistantTextEvidenceState {
    const existing = this.assistantTextEvidence.get(messageId);
    if (existing !== undefined) {
      if (provisional === null || provisional === existing) return existing;
      for (const digest of existing.finalDigests) provisional.finalDigests.add(digest);
      while (provisional.finalDigests.size > ASSISTANT_TEXT_EVIDENCE_MAX_FINALS) {
        const oldest = provisional.finalDigests.values().next().value as string | undefined;
        if (oldest === undefined) break;
        provisional.finalDigests.delete(oldest);
      }
      this.assistantTextEvidence.set(messageId, provisional);
      return provisional;
    }
    const evidence = provisional ?? this.createAssistantTextEvidence();
    this.assistantTextEvidence.set(messageId, evidence);
    if (this.assistantTextEvidence.size > ASSISTANT_TEXT_EVIDENCE_MAX_MESSAGES) {
      const oldest = this.assistantTextEvidence.keys().next().value as string | undefined;
      if (oldest !== undefined) this.assistantTextEvidence.delete(oldest);
    }
    return evidence;
  }

  private finalStartsWithReconciled(
    finalBytes: Buffer,
    evidence: AssistantTextEvidenceState
  ): boolean {
    if (finalBytes.length < evidence.reconciledBytes) return false;
    const prefixDigest = createHash("sha256")
      .update(finalBytes.subarray(0, evidence.reconciledBytes))
      .digest("hex");
    return prefixDigest === evidence.reconciledHash.copy().digest("hex");
  }

  private reconciledStartsWithFinal(
    finalBytes: Buffer,
    evidence: AssistantTextEvidenceState
  ): boolean {
    return (
      finalBytes.length <= evidence.reconciledPrefix.length &&
      evidence.reconciledPrefix.subarray(0, finalBytes.length).equals(finalBytes)
    );
  }

  private reconciledStartsWithStream(evidence: AssistantTextEvidenceState): boolean {
    if (evidence.streamBytes === evidence.reconciledBytes) {
      return evidence.streamHash.copy().digest("hex") === evidence.reconciledHash.copy().digest("hex");
    }
    if (evidence.streamBytes > evidence.reconciledPrefix.length) return false;
    const prefixDigest = createHash("sha256")
      .update(evidence.reconciledPrefix.subarray(0, evidence.streamBytes))
      .digest("hex");
    return prefixDigest === evidence.streamHash.copy().digest("hex");
  }

  private appendEvidencePrefix(prefix: Buffer, bytes: Buffer): Buffer {
    const remaining = ASSISTANT_TEXT_EVIDENCE_PREFIX_BYTES - prefix.length;
    if (remaining <= 0) return prefix;
    return Buffer.concat([prefix, bytes.subarray(0, remaining)]);
  }

  // task-notification は tool_result block を持たないため、合成 toolUseId
  // （既存カード・placement に一致しない）で tool_call_finished に載せる。
  // 序数は agentId 単位: 同一 task-id の複数回通知を live/history で同じ ID 列にする
  private emitTaskNotification(notification: TaskNotificationInfo, meta?: NormalizedOutMeta): void {
    if (!this.observedAsyncAgentIds.has(notification.agentId) && !this.observedBackgroundTaskIds.has(notification.agentId)) {
      this.droppedTaskNotificationCount++;
      // 破棄してもイベントの無い「委任完了の到着」という事実は残る。history 側の
      // 注入 user レコードと同じ扱いで gap 境界にする（裁定C1/C2）。
      // system メッセージは自前の timestamp を持たず、時刻源は task_updated の
      // end_time だけなので、それが無い通知は境界を置けない（既知の残余）
      if (meta?.timestamp !== undefined) this.pendingGapBoundaries.push(meta.timestamp);
      return;
    }
    const ordinal = (this.notificationOrdinals.get(notification.agentId) ?? 0) + 1;
    this.notificationOrdinals.set(notification.agentId, ordinal);
    this.emit(
      {
        kind: "tool_call_finished",
        turnId: this.currentTurnId ?? "",
        toolUseId: `task-notification:${notification.agentId}:${ordinal}`,
        isError: false,
        // 本文は載せない（history 側と同じ理由: 自由文がパス漏えい検査対象。構造化値のみ運ぶ）
        resultPreview: "",
        taskNotification: notification,
      },
      meta
    );
  }

  private emit(
    body: NormalizedEventBody & { provenance?: EventProvenance },
    meta?: NormalizedOutMeta
  ): void {
    const provenance: EventProvenance = body.provenance ?? { path: "live" };
    // 本文を出した経路が 3 つある（stream delta / 遅延 stream / completed snapshot の欠落末尾）。
    // どれか 1 つで印を付け忘れると、そのターンの撤回だけが静かに効かなくなる
    if (body.kind === "assistant_text_delta") this.unlabeledAssistantText = true;
    let outMeta = meta;
    if (this.pendingGapBoundaries.length > 0) {
      outMeta = { ...(meta ?? {}), gapBoundaries: this.pendingGapBoundaries };
      this.pendingGapBoundaries = [];
    }
    this.opts.emit({ ...body, provenance }, outMeta);
  }

  private isUsageLimitText(text: string): boolean {
    if (!text) return false;
    if (/usage limit reached/i.test(text)) return true;
    return this.usageLimitPrefixes.some((p) => text.startsWith(p));
  }

  private isClosed(): boolean {
    return this.opts.isClosed ? this.opts.isClosed() : false;
  }
}
