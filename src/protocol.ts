import { isToolIntentInput, type ToolIntentInput } from "./webview/status-line";
import { isAccentSettings, isAccentSettingValue, type AccentSettings, type AccentSetting } from "./accent";
import { isDisplayName } from "./display-name";
import { normalizeSystemAppExtension } from "./file-link-open-mode";
import { isPlanUsage, type MainTokenTotal } from "./plan-usage";
import type { FailureSummaryView } from "./exec-log-marks";
import type { HandoffCompactStats } from "./handoff-envelope";
import type { RoleSummaryView } from "./role-summary";
import type { ExecutorId } from "./orchestration-executors";
import { isExternalTimeout, isExternalDetection, isExternalModels, type ExternalModels, type ExternalDetection } from "./orchestration-roster";
import { isOrchestrationSettingRoster, type OrchestrationSettingRow } from "./orchestration-roster";
import { isOrchestrationView, type OrchestrationView } from "./orchestration-view";
export type { OrchestrationView } from "./orchestration-view";
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
import type { TimeBucket, TimeBucketView } from "./time-buckets";
import type { AnalysisFactsView, SummaryAnalysisView } from "./analysis-facts-view";
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

export interface TaskNotificationInfo {
  agentId: string;
  toolUseId?: string;
  status?: string;
  tokens?: number;
  summary?: string;
  result?: string;
}

export type ProgressState = "active" | "blocked" | "review" | "done";

export interface ProgressEmission {
  pp: "pp1";
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

export function applyFallbackModel(state: ModelFallbackState | undefined, model: string | null | undefined,
  at: number, models: readonly ModelInfo[] = []): ModelFallbackState | undefined {
  if (!state || !model) return state;
  if (state.resolvedAt === undefined && sameModel(model, fallbackOriginalModel(state), models)) {
    return { ...state, appliedModel: model, resolvedAt: at };
  }
  if (state.resolvedAt !== undefined && sameModel(model, state.notice.fallbackModel, models) &&
    !sameModel(model, state.appliedModel, models)) {
    const { resolvedAt: _resolvedAt, autoRevert: _autoRevert, ...open } = state;
    return { ...open, appliedModel: model, reopenedAt: at };
  }
  return model === state.appliedModel ? state : { ...state, appliedModel: model };
}

export function resolveFallbackByChoice(state: ModelFallbackState | undefined, model: string | null | undefined,
  at: number, models: readonly ModelInfo[] = []): ModelFallbackState | undefined {
  if (!state) return state;
  const appliedModel = model === null ? models.find(row => row.id === "default")?.resolvedModel || state.appliedModel
    : model || state.appliedModel;
  return { ...state, appliedModel, resolvedAt: state.resolvedAt ?? at };
}

export function fallbackOriginalModel(state: ModelFallbackState): string {
  return state.turnOriginalModel ?? state.notice.originalModel;
}

export function fallbackNoticeOriginal(state: ModelFallbackState | undefined,
  notice: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): string {
  return state !== undefined && state.notice === notice ? fallbackOriginalModel(state) : notice.originalModel;
}

export function foldModelFallback(state: ModelFallbackState | undefined, event: NormalizedEvent,
  models: readonly ModelInfo[] = []): ModelFallbackState | undefined {
  if (event.kind === "model_refusal_fallback" && event.scope === "session") {
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

export function fallbackNeedsConfirmation(state: ModelFallbackState): boolean {
  return state.autoRevert !== "pending" && state.autoRevert !== "applied" && state.autoRevert !== "deferred";
}

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
        errorType?: string;
      }
    | { kind: "assistant_text_delta"; turnId: string; text: string; recordUuid?: string | null }
    | { kind: "assistant_message_uuid"; turnId: string; uuid: string }
    | { kind: "assistant_retracted"; turnId: string | null; uuids: string[] }
    | { kind: "local_command_output"; text: string; uuid?: string; priorGeneration?: true }
    | ({ kind: "model_refusal_fallback" } & ModelRefusalFallback)
    | { kind: "model_fallback_revert"; turnId: string | null; originalModel: string; outcome: FallbackRevertOutcome }
    | {
        kind: "user_message";
        turnId: string | null;
        text: string;
        images?: ImageAttachment[];
        imageRefs?: ImageRefInfo[];
        sentAt?: number;
      }
    | {
        kind: "replayed_message";
        role: "user" | "assistant" | "system";
        text: string;
        uuid?: string;
        imageRefs?: ImageRefInfo[];
        model?: string;
        recordedAt?: number;
        sentAt?: number;
        restoredApproval?: RestoredApprovalCard;
      }
    | {
        kind: "tool_call_started";
        turnId: string;
        toolUseId: string;
        parentToolUseId: string | null;
        toolName: string;
        inputPreview: string;
        inputSummary?: string;
        intentInput?: ToolIntentInput;
        isBackground?: boolean;
        subagentType?: string;
        subagentModel?: string;
        subagentEffort?: string;
        delegation?: DelegationInfo;
        taskIntentStructured?: TaskIntent;
        artifacts?: ProjectedArtifactAccess[];
        effectCoverage?: EffectCoverage;
        progressEmission?: ProgressEmission;
      }
    | { kind: "subagent_info"; turnId: string | null; toolUseId: string; model?: string; agentId?: string }
    | { kind: "model_observed"; turnId: string | null; model: string }
    | { kind: "compact_boundary"; trigger: "auto" | "manual"; preTokens?: number; priorGeneration?: true }
    | {
        kind: "tool_call_finished";
        turnId: string;
        toolUseId: string;
        isError: boolean;
        resultPreview: string;
        asyncLaunchedAgentId?: string;
        resumedAgentId?: string;
        backgroundTaskId?: string;
        taskNotification?: TaskNotificationInfo;
      }
    | {
        kind: "approval_request";
        turnId: string | null;
        requestId: string;
        toolName: string;
        rawInputJson: string;
        inputJson?: string;
        inputSummary?: string;
        expiresAt: number | null;
        questions?: AskUserQuestionSpec;
      }
    | {
        kind: "approval_resolved";
        requestId: string;
        behavior: "allow" | "deny" | "withdrawn";
        resolvedBy: string;
        answers?: Record<string, string>;
      }
    | { kind: "permission_denied"; turnId: string | null; toolName: string; reason: string; classifierUnavailable?: boolean }
    | { kind: "usage_update"; scope: "turn" | "conversation"; turnId: string | null; usage: UsageSnapshot }
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
    | {
        kind: "background_tasks";
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

export interface RestoredApprovalCard {
  requestId: string;
  toolName: string;
  inputJson: string;
  questions?: AskUserQuestionSpec;
  answers?: Record<string, string>;
  resolution: "answered" | "allowed" | "denied" | "withdrawn" | "failed" | "unknown";
}

export interface AssistantUsage {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

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
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  sessionId?: string;
  verifiedAt: number;
  status: "verified" | "pending" | "error";
  detail?: string;
  runtime?: RuntimeCapability;
}

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

export interface PendingAttachmentInfo {
  id: string;
  mediaType: ImageAttachment["mediaType"];
  data: string;
}
export const ATTACHMENT_ID_RE = /^att-[0-9]+$/;
export const IMAGE_MAX_COUNT = 4;
export const RENAME_TITLE_MAX = 2000;
export const IMAGE_MAX_BASE64_LEN = 8_000_000;
export const SEND_TEXT_MAX_LEN = 1_000_000;
export const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
export const PICKED_FILE_MAX_COUNT = 20;

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

const KNOWN_HIDDEN_COMMANDS = new Set([
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

export const HOST_ACTIONS = ["openSettings", "addClaudeModel"] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

export const API_KEY_POLICIES = ["inherit", "subscriptionOnly"] as const;
export type ApiKeyPolicy = (typeof API_KEY_POLICIES)[number];
export function normalizeApiKeyPolicy(v: unknown): ApiKeyPolicy {
  return v === "subscriptionOnly" ? "subscriptionOnly" : "inherit";
}

export const ACCOUNT_USAGE_REUSE_MS = 60_000;
export const ACCOUNT_USAGE_TIMEOUT_MS = 15_000;
export const ACCOUNT_USAGE_REPLY_WAIT_MS = 2 * ACCOUNT_USAGE_TIMEOUT_MS + 5_000;
export const ACCOUNT_USAGE_ROWS_MAX = 32;
export const ACCOUNT_USAGE_STATES = ["ok", "unavailable", "failed"] as const;
export type AccountUsageState = (typeof ACCOUNT_USAGE_STATES)[number];
export interface AccountUsageRow {
  kind: string;
  percent: number;
  resetsAt: number | null;
  scope?: string;
  severity?: string;
}
export interface AccountUsageSnapshot {
  seq: number;
  fetchedAtMs: number;
  state: AccountUsageState;
  rows: AccountUsageRow[];
}

export function isCurrentAccountUsageRow(row: AccountUsageRow, nowMs: number): boolean {
  return row.resetsAt === null || row.resetsAt > nowMs;
}

function isRenameRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function isAccountUsageRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function isAccountUsageRow(value: unknown): value is AccountUsageRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).every((key) => key === "kind" || key === "percent" || key === "resetsAt" || key === "scope" || key === "severity") &&
    typeof row.kind === "string" && row.kind.length > 0 && row.kind.length <= 100 &&
    typeof row.percent === "number" && Number.isFinite(row.percent) &&
    (row.resetsAt === null || (typeof row.resetsAt === "number" && Number.isFinite(row.resetsAt))) &&
    (row.scope === undefined || (typeof row.scope === "string" && row.scope.length <= 100)) &&
    (row.severity === undefined || (typeof row.severity === "string" && row.severity.length <= 50))
  );
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

export type SettingsPageToHost =
  | { type: "settingsPageReady" }
  | { type: "recheckExternalExecutors" }
  | { type: "researchModelProfiles"; targets: string[]; purpose?: "effort" }
  | { type: "previewConductorInstruction"; requestId: number; policy: string }
  | { type: "setAccentSetting"; requestId: number; setting: AccentSetting; value: string }
  | { type: "setDisplayName"; requestId: number; value: string }
  | { type: "setComposerSendKey"; requestId: number; sendKey: ComposerSendKey }
  | { type: "setApiKeyPolicy"; requestId: number; policy: ApiKeyPolicy }
  | { type: "setAutoContinueAtUsageLimit"; requestId: number; enabled: boolean }
  | { type: "setInitialModel"; requestId: number; model: string }
  | { type: "setRestoreTabsOnStartup"; requestId: number; enabled: boolean }
  | { type: "setLearningEnabled"; requestId: number; enabled: boolean }
  | { type: "setProfileSources"; requestId: number; sources: ProfileSource[] }
  | { type: "setOrchestrationSetting"; requestId: number; setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes"; value: unknown }
  | { type: "setFileLinkSetting"; requestId: number; setting: FileLinkBooleanSetting; enabled: boolean }
  | { type: "setFileLinkSetting"; requestId: number; setting: "openWithSystemApp"; value: string[] }
  | { type: "openVsCodeSettings" }
  | { type: "settingWriteFailureAction"; action: SettingWriteFailureAction };

export const SETTING_WRITE_FAILURE_KINDS = ["unregistered", "other"] as const;
export type SettingWriteFailure = { kind: typeof SETTING_WRITE_FAILURE_KINDS[number]; reason: string };
export const SETTING_WRITE_FAILURE_ACTIONS = ["reloadWindow", "openSettingsJson"] as const;
export type SettingWriteFailureAction = typeof SETTING_WRITE_FAILURE_ACTIONS[number];

function isSettingWriteFailure(v: unknown): v is SettingWriteFailure {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return hasOnlyKeys(m, ["kind", "reason"]) && (SETTING_WRITE_FAILURE_KINDS as readonly string[]).includes(m.kind as string) && typeof m.reason === "string";
}

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
  | ({ type: "settingsState"; appearance?: AccentSettings; displayName?: string; composerSendKey: ComposerSendKey; apiKeyPolicy: ApiKeyPolicy; restoreTabsOnStartup: boolean; initialModel?: string; autoContinueAtUsageLimit: boolean; learningEnabled: boolean; replyTo?: number; writeFailure?: SettingWriteFailure }
    & SettingsProfileProjection & Record<FileLinkBooleanSetting, boolean> & { openWithSystemApp: string[] } & { orchestrationEnabled: boolean; orchestrationAgents: OrchestrationSettingRow[]; orchestrationDefaults: OrchestrationSettingRow[]; conductorPolicy: string; conductorPolicyDefault: string; externalTimeoutMinutes: number; externalDetection: Record<ExecutorId, ExternalDetection>; externalModels: ExternalModels });

function isSettingsRequestId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export function isSettingsPageToHost(v: unknown): v is SettingsPageToHost {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  const t = m.type as SettingsPageToHost["type"];
  if (t === "settingsPageReady" || t === "recheckExternalExecutors" || t === "openVsCodeSettings") return hasOnlyKeys(m, ["type"]);
  if (t === "settingWriteFailureAction") {
    return hasOnlyKeys(m, ["type", "action"]) && (SETTING_WRITE_FAILURE_ACTIONS as readonly string[]).includes(m.action as string);
  }
  if (t === "researchModelProfiles") return hasOnlyKeys(m, ["type", "targets", "purpose"]) && isProfileTargetIds(m.targets) && m.targets.length > 0
    && (m.purpose === undefined || m.purpose === "effort");
  if (t === "setProfileSources") return hasOnlyKeys(m, ["type", "requestId", "sources"]) && isSettingsRequestId(m.requestId) && isProfileSources(m.sources);
  if (t === "previewConductorInstruction") return hasOnlyKeys(m, ["type", "requestId", "policy"]) && isSettingsRequestId(m.requestId) && typeof m.policy === "string";
  if (t === "setAccentSetting") {
    return isSettingsRequestId(m.requestId) && isAccentSettingValue(m.setting, m.value) && hasOnlyKeys(m, ["type", "requestId", "setting", "value"]);
  }
  if (t === "setDisplayName") {
    return isSettingsRequestId(m.requestId) && isDisplayName(m.value) && hasOnlyKeys(m, ["type", "requestId", "value"]);
  }
  if (t === "setComposerSendKey") {
    return isSettingsRequestId(m.requestId)
      && (COMPOSER_SEND_KEYS as readonly string[]).includes(m.sendKey as string) && hasOnlyKeys(m, ["type", "requestId", "sendKey"]);
  }
  if (t === "setInitialModel") {
    return isSettingsRequestId(m.requestId) && typeof m.model === "string" && m.model.length <= 200
      && (m.model === "" || /^[A-Za-z0-9][A-Za-z0-9_.:[\]-]*$/.test(m.model))
      && hasOnlyKeys(m, ["type", "requestId", "model"]);
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
      && (m.displayName === undefined || isDisplayName(m.displayName))
      && (COMPOSER_SEND_KEYS as readonly string[]).includes(m.composerSendKey as string)
      && (API_KEY_POLICIES as readonly string[]).includes(m.apiKeyPolicy as string)
      && typeof m.restoreTabsOnStartup === "boolean"
      && (m.initialModel === undefined || typeof m.initialModel === "string")
      && typeof m.autoContinueAtUsageLimit === "boolean" && typeof m.learningEnabled === "boolean"
      && typeof m.orchestrationEnabled === "boolean" && typeof m.conductorPolicy === "string"
      && typeof m.conductorPolicyDefault === "string"
      && isOrchestrationSettingRoster(m.orchestrationAgents) && isOrchestrationSettingRoster(m.orchestrationDefaults)
      && isExternalTimeout(m.externalTimeoutMinutes) && isExternalDetection(m.externalDetection) && isExternalModels(m.externalModels)
      && FILE_LINK_BOOLEAN_SETTINGS.every((key) => typeof m[key] === "boolean")
      && Array.isArray(m.openWithSystemApp) && m.openWithSystemApp.every((item) => typeof item === "string")
      && (m.replyTo === undefined || isSettingsRequestId(m.replyTo))
      && (m.writeFailure === undefined || m.replyTo !== undefined && isSettingWriteFailure(m.writeFailure))
      && hasOnlyKeys(m, ["type", "initialModel", "appearance", "displayName", "composerSendKey", "apiKeyPolicy", "restoreTabsOnStartup", "autoContinueAtUsageLimit", "learningEnabled", ...FILE_LINK_SETTINGS, "orchestrationEnabled", "orchestrationAgents", "orchestrationDefaults", "conductorPolicy", "conductorPolicyDefault", "externalTimeoutMinutes", "externalDetection", "externalModels", "replyTo", "writeFailure", "profileSources", "researchTargets", "researchUnavailable", "effortUnavailable", "researchText", "conductorPreview"]);
  }
  t satisfies never;
  return false;
}

export type WebviewToHost =
  | { type: "ready"; cursor: { generation: number; seq: number } | null }
  | { type: "send"; tabId: string; text: string; clientToken?: string; images?: ImageAttachment[] }
  | { type: "attachImage"; tabId: string; mediaType: ImageAttachment["mediaType"]; data: string }
  | { type: "removeAttachment"; tabId: string; attachmentId: string }
  | { type: "startHandoff"; tabId: string }
  | { type: "cancelHandoff"; tabId: string; runId: string }
  | { type: "getHandoffDetail"; tabId: string; runId: string; part: number; refresh?: true }
  | { type: "openHandoffSource"; tabId: string; sourceSessionId: string }
  | { type: "interrupt"; tabId: string }
  | { type: "cancelAutoResume"; tabId: string }
  | {
      type: "approvalDecision";
      tabId: string;
      requestId: string;
      behavior: "allow" | "deny";
      answers?: Record<string, string>;
    }
  | { type: "newTab" }
  | { type: "closeTab"; tabId: string }
  | { type: "clearTab"; tabId: string }
  | { type: "setMode"; tabId: string; mode: PermissionModeId }
  | { type: "setModel"; tabId: string; model: string | null; sessionOnly?: boolean }
  | { type: "setEffort"; tabId: string; effort: string | null }
  | { type: "queryFiles"; reqId: number; query: string }
  | { type: "pickFiles"; reqId: number; imageSlots: number }
  | { type: "openFile"; tabId: string; target: string }
  | { type: "exportTab"; tabId: string }
  | { type: "renameTab"; tabId: string; title: string }
  | { type: "listSessions"; source?: "laisora" | "claude"; cursor?: string; showHidden?: boolean }
  | { type: "renameSession"; sessionId: string; filePath: string; title: string; requestId?: string }
  | { type: "setSessionHidden"; sessionId: string; hidden: boolean }
  | { type: "analyzeCurrent"; tabId: string }
  | { type: "summarizeSession"; tabId: string }
  | { type: "suggestSessionName"; tabId: string }
  | { type: "openThemePicker" }
  | { type: "runHostAction"; action: "openSettings" }
  | { type: "runHostAction"; action: "addClaudeModel"; tabId: string }
  | { type: "requestAccountUsage"; tabId: string; requestId: string }
  | { type: "requestAccountUsage"; requestId: string }
  | { type: "accountUsagePanelClosed" }
  | {
      type: "agentInspectorRequest";
      tabId: string;
      agentId: string;
      section: AgentInspectorSection;
      requestId: string;
      cursor?: string;
    }
  | {
      type: "historyChunkRequest";
      tabId: string;
      requestId: string;
      cursor?: string;
      anchor?: { generation: number; seq: number };
    }
  | {
      type: "worklogTranscriptRequest";
      tabId: string;
      requestId: string;
      cursor?: string;
      anchor?: { generation: number; seq: number };
    }
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
  | {
      type: "webviewDiagnostic";
      kind: "error" | "ready-retry" | "first-paint" | "orphan-turn-adopted";
      message: string;
    }
  | { type: "resumeSession"; sessionId: string; filePath: string; intoTabId?: string }
  | { type: "resumeHydrationRetry"; tabId: string }
  | { type: "activeTab"; tabId: string };

export interface SessionListItem {
  originUnverified?: boolean;
  hidden?: boolean;
  sessionId: string;
  filePath: string;
  title: string;
  cwd: string;
  mtime: number;
}

export const SESSION_LIST_ACTIONS = ["rename", "hide", "unhide"] as const;
export type SessionListAction = (typeof SESSION_LIST_ACTIONS)[number];

export interface SessionScanDegradation {
  rootFailed: boolean;
  unreadableProjects: number;
  statFailed: number;
  resolveFailed: number;
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

export const WORK_MODEL_VERSION = 3;

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
  transcriptAgentId?: string;
  parentAgentId: string | null;
  toolUseId: string;
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
  backgroundLaunch?: true;
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
  | "session-unavailable"
  | "session-scan-failed"
  | "agent-unavailable"
  | "transcript-unavailable"
  | "invalid-cursor"
  | "stale-request"
  | "read-failed"
  | "response-too-large"
  | "meta-limit";

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

export type HistoryChunkErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "ambiguous-identity"
  | "invalid-request"
  | "stale-request"
  | "host-error";

export interface ConversationHistoryMessagePayload {
  uuid: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  imageRefs?: ImageRefInfo[];
  model?: string;
  restoredApproval?: RestoredApprovalCard;
}

export interface ConversationHistoryPagePayload {
  items: ConversationHistoryMessagePayload[];
  nextCursor?: string;
  hasMore: boolean;
  coverage: {
    returnedCount: number;
    remainingOlderCount: number;
    oldestReached: boolean;
    malformedLineCount?: number;
    droppedWithoutUuidCount?: number;
  };
}

export type ConversationHistoryErrorReason =
  | "invalid-cursor"
  | "unknown-anchor"
  | "history-unavailable"
  | "invalid-request"
  | "session-unavailable"
  | "session-scan-failed"
  | "read-failed"
  | "stale-request"
  | "response-too-large"
  | "host-error";

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
  segmentIds: string[];
  segmentCount: number;
  turnIds: string[];
  turnCount: number;
  lastTurnId?: string;
  startedAt: number;
  endedAt?: number;
  isCurrent: boolean;
  state: WorkPhaseState;
  compactedPhaseCount?: number;
  agents: WorkAgentNode[];
}

export interface WorkPlacementView {
  phaseId: string;
  segmentId?: string;
  taskKey?: string;
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
  currentSegmentId?: string | null;
  placement?: WorkPlacementView;
  segments?: WorkSegmentView[];
  agents?: WorkAgentStateView[];
  taskTotals?: WorkTaskTotalsView[];
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
  runningMainTools?: Array<{ id: string; name: string; startedAt: number; intentInput?: ToolIntentInput }>;
  version: number;
  revision: number;
  coverage: WorkCoverage;
  currentPhaseId?: string;
  ambiguity?: "multiple-active-tasks";
  phases: WorkPhaseView[];
  unlinkedAgents: WorkAgentNode[];
  tasks: WorkTaskItemView[];
  taskTotals: WorkTaskTotalsView[];
}

export type SemanticArtifactView = ProjectedArtifactAccess & { canonicalPath?: never };

export type SemanticAttemptNodeView = Omit<ExecutionAttemptNode, "artifacts"> & {
  artifacts: SemanticArtifactView[];
};

export type SemanticNodeView = Exclude<SemanticNode, ExecutionAttemptNode> | SemanticAttemptNodeView;

export type DivergenceRecordView = Omit<DivergenceRecord, "coverage"> & {
  detectionInputCoverage: Coverage;
};

export type DivergenceKindReportView = Omit<DivergenceKindReport, "records"> & {
  records: DivergenceRecordView[];
};

export type DivergenceReportView = Omit<DivergenceReport, "kinds"> & {
  kinds: Record<DivergenceKind, DivergenceKindReportView>;
};

export interface L3ReportPayload {
  facts?: AnalysisFactsView;
  analysis: L3Report;
  divergences: DivergenceReportView;
  llm?: LlmFindingReportView;
}

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
  tokensLabel?: string | null;
  slicesCount?: number;
  emptyStateLabel?: string;
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

export type LlmFindingDiagnosticsPayload =
  | { state: "unavailable"; reason: string }
  | {
      state: "completed";
      specVersion: number;
      provenance: LlmAnalysisProvenance;
      cacheState: "hit" | "miss";
      rejected: RejectedFinding[];
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

export interface SemanticModelPayload extends Omit<SemanticModel, "nodes" | "progress"> {
  nodes: SemanticNodeView[];
  l3?: L3ReportPayload;
  timeBucketsCoverage?: TimeBucketsCoverage;
  roleSummary?: RoleSummaryView;
  failureSummary?: FailureSummaryView;
  summaryAnalysis?: SummaryAnalysisView;
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
  const nodeByKey = new Map<string, WorkAgentNode>();
  const levelByNode = new Map<WorkAgentNode, number>();
  const matchedRestoredIds = new Set<string>();
  const phases: WorkPhaseView[] = [];
  const unlinkedAgents: WorkAgentNode[] = [];
  let depthLimitedCount = 0;

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

export function projectWorkEvent(
  previousState: WorkModelState,
  nextState: WorkModelState,
  event: NormalizedEvent
): WorkEventInfo | undefined {
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

const DIVERGENCE_KIND_KEYS: Record<DivergenceKind, true> = {
  serialization: true,
  unsupported_completion: true,
  progress_stagnation: true,
  declared_state_conflict: true,
};

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

const LLM_REPORT_BANNED_KEYS = [
  "rejected",
  "byReason",
  "diagnostics",
  "candidateCount",
];

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

const TIME_BUCKET_NAMES: Record<TimeBucket, true> = { generate: true, tool: true, delegation: true, confirm: true, reply: true };
const TAIL_MAIN_NAMES: Record<NonNullable<TimeBucketView["tail"]["main"]>, true> = { generate: true, tool: true, delegation: true, confirm: true };

function isTimeBucketsPayload(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const { mainByModel: byModel, blocks, agents, backgroundTasks, bars, main, intervals, tail } = v as Record<string, unknown>;
  const percent = (value: unknown) => isNumber(value) && (value as number) >= 0 && (value as number) <= 100;
  const duration = (value: unknown) => isNumber(value) && (value as number) >= 0;
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  return isTimeBarsView(bars) &&
    (main === undefined || record(main) && (main.subagentWaitMs === undefined || duration(main.subagentWaitMs))) &&
    (intervals === undefined || isArrayOf(intervals, item => record(item) && typeof item.bucket === "string" && Object.hasOwn(TIME_BUCKET_NAMES, item.bucket))) &&
    (tail === undefined || record(tail) && (tail.main === undefined || tail.main === null || typeof tail.main === "string" && Object.hasOwn(TAIL_MAIN_NAMES, tail.main))) &&
    (byModel === undefined || byModel === null || isMainTimeByModelView(byModel)) &&
    [agents, backgroundTasks].every(items => items === undefined || isArrayOf(items, item => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const lane = item as Record<string, unknown>;
      return (lane.stepKey === undefined || typeof lane.stepKey === "string") &&
        (items !== backgroundTasks || lane.subagent === undefined || typeof lane.subagent === "boolean");
    })) &&
    (blocks === undefined || isArrayOf(blocks, value => {
      if (typeof value !== "object" || value === null) return false;
      const block = value as Record<string, unknown>;
      if (block.kind !== undefined && !["say", "command", "interrupt", "plan"].includes(block.kind as string)) return false;
      if (block.kind === "plan" && (!isArrayOf(block.steps, isPlanBlockStep) || !isArrayOf(block.userMessages, isPlanBlockMarker) || !isPlanBlockMetrics(block.metrics))) return false;
      if (block.goal !== undefined && typeof block.goal !== "string") return false;
      if (block.closedAt !== undefined && !isNumber(block.closedAt)) return false;
      if (block.steps !== undefined && !isArrayOf(block.steps, isPlanBlockStep)) return false;
      if (block.userMessages !== undefined && !isArrayOf(block.userMessages, isPlanBlockMarker)) return false;
      if (block.metrics !== undefined && !isPlanBlockMetrics(block.metrics)) return false;
      if (block.requestNumber !== undefined && block.requestNumber !== null &&
        !(typeof block.requestNumber === "string" && /^\d+$/.test(block.requestNumber))) return false;
      if (block.processingMs !== undefined && block.processingMs !== null &&
        !(isNumber(block.processingMs) && (block.processingMs as number) >= 0)) return false;
      if (block.subagentWaitMs !== undefined && !duration(block.subagentWaitMs)) return false;
      if (block.strip === undefined || block.strip === null) return true;
      if (typeof block.strip !== "object" || Array.isArray(block.strip)) return false;
      const strip = block.strip as Record<string, unknown>;
      return [strip.generatePercent, strip.toolPercent, strip.subagentWaitPercent, strip.confirmPercent, strip.replyPercent, strip.remainderPercent].every(percent);
    }));
}

function isTimeBarsView(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  const duration = (x: unknown) => isNumber(x) && (x as number) >= 0;
  return [b.totalMs, b.mainMs, b.toolMs].every(x => x === null || duration(x)) && duration(b.subMs);
}

function isPlanBlockMarker(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const marker = v as Record<string, unknown>;
  return isNumber(marker.at) && (marker.at as number) >= 0 && typeof marker.text === "string";
}

function isPlanBlockMetrics(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  const duration = (x: unknown) => x === null || isNumber(x) && (x as number) >= 0;
  const tokens = m.tokens as Record<string, unknown> | null;
  return (m.provisional === undefined || typeof m.provisional === "boolean") &&
    [m.generateMs, m.toolMs, m.subagentWaitMs, m.subagentOnlyMs, m.decisionWaitMs, m.replyWaitMs].every(duration) &&
    (tokens === null || typeof tokens === "object" && !Array.isArray(tokens) && tokens !== null &&
      isNumber(tokens.tokens) && (tokens.tokens as number) >= 0 && isNumber(tokens.cacheRead) && (tokens.cacheRead as number) >= 0);
}

function isPlanBlockStep(v: unknown): boolean {
  if (!isPlanBlockMetrics(v)) return false;
  const step = v as Record<string, unknown>;
  const at = (x: unknown) => x === null || isNumber(x) && (x as number) >= 0;
  return typeof step.key === "string" && typeof step.title === "string" &&
    ["unknown", "pending", "in_progress", "completed"].includes(step.status as string) &&
    typeof step.removed === "boolean" && typeof step.longest === "boolean" &&
    (step.parallel === undefined || typeof step.parallel === "boolean") &&
    [step.startedAt, step.endedAt, step.end, step.durationMs].every(at) &&
    (step.startedAt === null || step.end === null || (step.end as number) >= (step.startedAt as number));
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
    (r.outcome === null || ["ok", "failed", "timeout", "refused", "stopped"].includes(r.outcome as string)) &&
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

export const DECISIONS_REWRITE_RATIO = 0.8;

export interface HandoffDecisionCounts {
  total: number;
  carried: number;
  extracted: number;
  removed: number;
  unknownIdRefs: number;
  warn?: { entries: number; bytes: number };
}

export interface HandoffSourceSnapshot {
  sessionId: string;
  title?: string;
  compact?: HandoffCompactStats;
  contextUsage?: HandoffContextUsage;
  utteranceCount?: number;
  unreadableLineCount?: number;
  detailRunId?: string;
  decisionCount?: number;
  decisions?: HandoffDecisionCounts;
}

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
  | { type: "init"; protocolVersion: number; tabs: TabSnapshot[]; hostWindows?: boolean; systemAppExtensions?: string[] }
  | { type: "events"; tabId: string; events: NormalizedEvent[] }
  | {
      type: "resumeHydrationState";
      tabId: string;
      phase: Exclude<ResumeHydrationPhase, "failed">;
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
  | { type: "tabCreated"; tab: TabSnapshot; activate: boolean }
  | { type: "tabClosed"; tabId: string }
  | { type: "activateTab"; tabId: string }
  | { type: "tabCleared"; tab: TabSnapshot }
  | { type: "tabRestored"; tab: TabSnapshot }
  | { type: "tabRenamed"; tabId: string; title: string }
  | {
      type: "handoffStatus";
      tabId: string;
      runId: string;
      state: "running" | "failed" | "done";
      phase?: string;
      progress?: { heartbeats: number; elapsedMs: number; since: "compact_start" | "result" };
      reason?: string;
      detail?: string;
      message: string;
      source: { sessionId: string; title: string };
      fork?: { sessionId: string; tabId: string; title: string };
      compact?: HandoffCompactStats;
      contextUsage?: HandoffContextUsage;
      utteranceCount?: number;
      unreadableLineCount?: number;
      decisions?: HandoffDecisionCounts;
    }
  | {
      type: "handoffDetail";
      tabId: string;
      runId: string;
      part: number;
      total: number;
      summary?: string;
      utterances: { n: number; at: string; kind: "typed" | "answer"; text: string; questions?: string[]; imageRefs?: ImageRefInfo[] }[];
      decisions?: HandoffDecisions;
    }
  | { type: "modeChanged"; tabId: string; mode: PermissionModeId }
  | { type: "commands"; tabId: string; commands: SlashCommandInfo[] }
  | {
      type: "models";
      tabId: string;
      models: ModelInfo[];
    }
  | { type: "modelChanged"; tabId: string; model: string | null; notice?: string; applied?: boolean }
  | { type: "effortChanged"; tabId: string; effort: string | null; notice?: string }
  | { type: "configuredEffortChanged"; tabId: string; effort: string | null; model?: string | null; defaultEffort?: string | null; appliedModel?: string | null; appliedEffort?: string | null }
  | { type: "files"; reqId: number; paths: string[] }
  | { type: "pickedFiles"; reqId: number; paths: string[]; images: ImageAttachment[] }
  | { type: "attachments"; tabId: string; items: PendingAttachmentInfo[] }
  | { type: "sessions"; source?: "laisora" | "claude"; showHidden?: boolean; nextCursor?: string; append?: boolean; requestId: number; sessions: SessionListItem[]; complete: boolean; degraded?: SessionScanDegradation }
  | { type: "sessionRenamed"; sessionId: string; title: string; requestId?: string }
  | { type: "sessionHiddenChanged"; sessionId: string; hidden: boolean }
  | { type: "sessionListActionFailed"; sessionId: string; action: SessionListAction; reason: string; requestId?: string }
  | { type: "analysis"; sessionId: string; filePath: string; report: unknown }
  | { type: "analysisFailed"; kind: "script" | "action"; tabId?: string; reason?: string }
  | { type: "composerPrefill"; tabId: string; text: string }
  | { type: "editorContext"; path: string; startLine: number; endLine: number }
  | { type: "workModel"; tabId: string; model: WorkModelPayload }
  | { type: "semanticModel"; tabId: string; model: SemanticModelPayload }
  | { type: "llmAnalysisSetting"; enabled: boolean }
  | { type: "userSettings"; appearance?: AccentSettings; displayName?: string; composerSendKey: ComposerSendKey }
  | { type: "tabNotice"; tabId: string; text: string }
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
  | ({ type: "accountUsage"; replyTo: string } & AccountUsageSnapshot)
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
  deferred?: true;
  state: ConversationSnapshot;
}

export interface ConversationSnapshot {
  conversationId: string | null;
  cwd: string;
  turnState: "idle" | "running" | "interrupting";
  auth: AuthStatus | null;
  configModel?: string;
  configEffort?: string;
  defaultEffort?: string;
  appliedModel?: string;
  modelFallback?: ModelFallbackState;
  appliedEffort?: string | null;
  recordedModel?: string;
  permissionMode: PermissionModeId;
  commands?: SlashCommandInfo[];
  models?: ModelInfo[];
  modelOverride?: string | null;
  effortOverride?: string | null;
  resumeSessionId?: string;
  resumeFilePath?: string;
  handoffSource?: HandoffSourceSnapshot;
  resumeHydration?: ResumeHydrationSnapshotState;
  workModel?: WorkModelPayload;
  planUsage?: import("./plan-usage").PlanUsage;
  semanticView?: boolean;
  semanticModel?: SemanticModelPayload;
  llmAnalysisEnabled?: boolean;
  llmAnalysisRunning?: boolean;
  llmAnalysisProgress?: LlmAnalysisRunProgress;
  sessionSummary?: { text: string; model: string };
  sessionSummaryRunning?: boolean;
  llmDiagnostics?: boolean;
  headOmitted?: { count: number; hasConvEvent: boolean; backfilledHead: boolean };
  backgroundActivity?: BackgroundActivitySnapshot;
  autoResumeAt?: number | null;
  events: NormalizedEvent[];
}

export function isWebviewToHost(v: unknown): v is WebviewToHost {
  if (typeof v !== "object" || v === null) return false;
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
      (model === null || (typeof model === "string" && model.trim() !== "" && model.length <= 100))
    );
  }
  if (t === "listSessions") {
    const q = v as { source?: unknown; cursor?: unknown; showHidden?: unknown };
    return (q.source === undefined || q.source === "laisora" || q.source === "claude") &&
      (q.cursor === undefined || (typeof q.cursor === "string" && /^\d+:\d+$/.test(q.cursor))) &&
      (q.showHidden === undefined || typeof q.showHidden === "boolean");
  }
  if (t === "renameSession") {
    const message = v as Record<string, unknown>;
    return hasOnlyKeys(message, ["type", "sessionId", "filePath", "title", "requestId"]) &&
      (message.requestId === undefined || isRenameRequestId(message.requestId)) &&
      typeof message.sessionId === "string" && SESSION_ID_RE.test(message.sessionId) &&
      typeof message.filePath === "string" && message.filePath.length > 0 && !message.filePath.includes("\0") &&
      typeof message.title === "string" && message.title.trim().length > 0 && message.title.length <= RENAME_TITLE_MAX;
  }
  if (t === "setSessionHidden") {
    const message = v as Record<string, unknown>;
    return hasOnlyKeys(message, ["type", "sessionId", "hidden"]) &&
      typeof message.sessionId === "string" && SESSION_ID_RE.test(message.sessionId) &&
      typeof message.hidden === "boolean";
  }
  if (t === "openFile") {
    const message = v as Record<string, unknown>;
    const allowed = new Set(["type", "tabId", "target"]);
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
  if (t === "accountUsagePanelClosed") return Object.keys(v).every((key) => key === "type");
  if (t === "requestAccountUsage") {
    return (
      Object.keys(v).every((key) => key === "type" || key === "tabId" || key === "requestId") &&
      isAccountUsageRequestId((v as { requestId?: unknown }).requestId) &&
      (tabId === undefined || (typeof tabId === "string" && tabId.length > 0 && tabId.length <= 200))
    );
  }
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
    const refresh = (v as { refresh?: unknown }).refresh;
    return (
      typeof tabId === "string" &&
      typeof (v as { runId?: unknown }).runId === "string" &&
      typeof part === "number" &&
      Number.isInteger(part) &&
      part >= 0 &&
      (refresh === undefined || (refresh === true && part === 0))
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
        typeof tool.inputPreview === "string" && isOptionalString(tool.resultPreview) &&
        (tool.backgroundLaunch === undefined || tool.backgroundLaunch === true);
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

const CONVERSATION_TEXT_MAX = 20000;
const CONVERSATION_ITEMS_MAX = 500;

function isRestoredApprovalCard(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  if (typeof card.requestId !== "string" || !card.requestId || typeof card.toolName !== "string" ||
    typeof card.inputJson !== "string" || !["answered", "allowed", "denied", "withdrawn", "failed", "unknown"].includes(String(card.resolution))) return false;
  if (card.answers !== undefined && (typeof card.answers !== "object" || card.answers === null || Array.isArray(card.answers) ||
    !Object.values(card.answers).every((answer) => typeof answer === "string"))) return false;
  if (card.questions !== undefined) {
    const spec = card.questions as AskUserQuestionSpec;
    if (typeof spec !== "object" || spec === null || !Array.isArray(spec.questions) || !spec.questions.every((q) =>
      typeof q === "object" && q !== null && typeof q.question === "string" && typeof q.multiSelect === "boolean" &&
      (q.header === undefined || typeof q.header === "string") && Array.isArray(q.options) && q.options.every((option) =>
        typeof option === "object" && option !== null && typeof option.label === "string" &&
        (option.description === undefined || typeof option.description === "string")))) return false;
  }
  return true;
}

function isConversationHistoryMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.uuid === "string" && m.uuid.length > 0 && m.uuid.length <= 100 &&
    (m.role === "user" || m.role === "assistant" || m.role === "system") &&
    typeof m.text === "string" && m.text.length <= CONVERSATION_TEXT_MAX &&
    typeof m.timestamp === "number" &&
    (m.imageRefs === undefined || isImageRefInfoArray(m.imageRefs)) &&
    (m.model === undefined || (typeof m.model === "string" && m.model.length > 0)) &&
    (m.restoredApproval === undefined || isRestoredApprovalCard(m.restoredApproval))
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

export function isWorkEventInfo(v: unknown): v is WorkEventInfo {
  if (typeof v !== "object" || v === null) return false;
  const info = v as Record<string, unknown>;
  if (!isNumber(info.revision)) return false;
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
    if (e.restoredApproval !== undefined && !isRestoredApprovalCard(e.restoredApproval)) return false;
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
    (s.autoResumeAt === undefined || s.autoResumeAt === null || isNumber(s.autoResumeAt)) &&
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

export interface HandoffContextMeasurement {
  totalTokens: number;
  measuredAt: string;
}

export interface HandoffContextUsage {
  before: HandoffContextMeasurement | null;
  after?: HandoffContextMeasurement | null | "pending";
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_8601_RE.test(value) && Number.isFinite(Date.parse(value));
}

export function isHandoffContextMeasurement(value: unknown): value is HandoffContextMeasurement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.totalTokens === "number" && Number.isFinite(item.totalTokens) && item.totalTokens >= 0 &&
    isIsoTimestamp(item.measuredAt);
}

export function isHandoffContextUsage(value: unknown): value is HandoffContextUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(context, "before") &&
    (context.before === null || isHandoffContextMeasurement(context.before)) &&
    (context.after === undefined || context.after === null || context.after === "pending" ||
      isHandoffContextMeasurement(context.after));
}

function isHandoffCompactStats(value: unknown): value is HandoffCompactStats | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const compact = value as Record<string, unknown>;
  const tokens = (n: unknown): boolean => n === undefined || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  return tokens(compact.preTokens) && tokens(compact.postTokens) &&
    (compact.retainedResponseCount === undefined ||
      (typeof compact.retainedResponseCount === "number" && Number.isSafeInteger(compact.retainedResponseCount) &&
        compact.retainedResponseCount >= 2));
}

function isUnreadableLineCount(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v > 0);
}

function isHandoffSource(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const h = v as Record<string, unknown>;
  return typeof h.sessionId === "string" && SESSION_ID_RE.test(h.sessionId) &&
    (h.title === undefined || typeof h.title === "string") &&
    (h.detailRunId === undefined || typeof h.detailRunId === "string") &&
    (h.utteranceCount === undefined ||
      (typeof h.utteranceCount === "number" && Number.isSafeInteger(h.utteranceCount) && h.utteranceCount >= 0)) &&
    (h.decisionCount === undefined ||
      (typeof h.decisionCount === "number" && Number.isSafeInteger(h.decisionCount) && h.decisionCount >= 0)) &&
    isUnreadableLineCount(h.unreadableLineCount) &&
    isHandoffDecisionCounts(h.decisions) &&
    (h.contextUsage === undefined || isHandoffContextUsage(h.contextUsage)) &&
    isHandoffCompactStats(h.compact);
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
  const t = (v as { type?: unknown }).type as HostToWebview["type"];
  const tabId = (v as { tabId?: unknown }).tabId;

  if (t === "planUsage") {
    return typeof tabId === "string" && Object.keys(v).length === 3
      && hasOnlyKeys(v as Record<string, unknown>, ["type", "tabId", "state"])
      && isPlanUsage((v as { state?: unknown }).state);
  }

  if (t === "orchestrationView") {
    return typeof tabId === "string" && hasOnlyKeys(v as Record<string, unknown>, ["type", "tabId", "state"])
      && isOrchestrationView((v as { state?: unknown }).state);
  }

  if (t === "init") {
    const tabs = (v as { tabs?: unknown }).tabs;
    const extensions = (v as { systemAppExtensions?: unknown }).systemAppExtensions;
    return (
      typeof (v as { protocolVersion?: unknown }).protocolVersion === "number" &&
      ((v as { hostWindows?: unknown }).hostWindows === undefined ||
        typeof (v as { hostWindows?: unknown }).hostWindows === "boolean") &&
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
      isHandoffCompactStats(m.compact) &&
      (m.contextUsage === undefined || isHandoffContextUsage(m.contextUsage)) &&
      (m.utteranceCount === undefined || typeof m.utteranceCount === "number") &&
      isUnreadableLineCount(m.unreadableLineCount) &&
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
            (Array.isArray(item.questions) && item.questions.every((q) => typeof q === "string"))) &&
          (item.imageRefs === undefined || isImageRefInfoArray(item.imageRefs))
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
  if (t === "sessionRenamed") {
    const m = v as Record<string, unknown>;
    return hasOnlyKeys(m, ["type", "sessionId", "title", "requestId"]) && typeof m.sessionId === "string" && typeof m.title === "string" &&
      (m.requestId === undefined || isRenameRequestId(m.requestId));
  }
  if (t === "sessionHiddenChanged") {
    const m = v as Record<string, unknown>;
    return hasOnlyKeys(m, ["type", "sessionId", "hidden"]) && typeof m.sessionId === "string" && typeof m.hidden === "boolean";
  }
  if (t === "sessionListActionFailed") {
    const m = v as Record<string, unknown>;
    return hasOnlyKeys(m, ["type", "sessionId", "action", "reason", "requestId"]) && typeof m.sessionId === "string" &&
      (SESSION_LIST_ACTIONS as readonly unknown[]).includes(m.action) && typeof m.reason === "string" &&
      (m.requestId === undefined || isRenameRequestId(m.requestId));
  }
  if (t === "sessions") {
    const page = v as { source?: unknown; showHidden?: unknown; nextCursor?: unknown; append?: unknown };
    if (page.source !== undefined && page.source !== "laisora" && page.source !== "claude") return false;
    if (page.showHidden !== undefined && typeof page.showHidden !== "boolean") return false;
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
          ((s as { originUnverified?: unknown }).originUnverified === undefined || typeof (s as { originUnverified?: unknown }).originUnverified === "boolean") &&
          ((s as { hidden?: unknown }).hidden === undefined || typeof (s as { hidden?: unknown }).hidden === "boolean")
      )
    );
  }
  if (t === "composerPrefill") {
    return typeof tabId === "string" && typeof (v as { text?: unknown }).text === "string" && (v as { text: string }).text.length <= 20_000;
  }
  if (t === "analysis") {
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
    const displayName = (v as { displayName?: unknown }).displayName;
    return (appearance === undefined || isAccentSettings(appearance))
      && (displayName === undefined || isDisplayName(displayName))
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
  if (t === "accountUsage") {
    const m = v as Record<string, unknown>;
    return (
      Object.keys(m).every((key) => key === "type" || key === "replyTo" || key === "seq" || key === "fetchedAtMs" || key === "state" || key === "rows") &&
      isAccountUsageRequestId(m.replyTo) &&
      typeof m.seq === "number" && Number.isSafeInteger(m.seq) && m.seq > 0 &&
      typeof m.fetchedAtMs === "number" && Number.isFinite(m.fetchedAtMs) &&
      (ACCOUNT_USAGE_STATES as readonly unknown[]).includes(m.state) &&
      Array.isArray(m.rows) && m.rows.length <= ACCOUNT_USAGE_ROWS_MAX &&
      m.rows.every(isAccountUsageRow) &&
      (m.state === "ok" || m.rows.length === 0)
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

  t satisfies never;
  return false;
}
