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

const EVENT_LOG_MAX = 5000;

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
  arrivalJudged?: boolean;
};

export function foldEventState(
  draft: EventFoldDraft,
  partial: NormalizedEventBody & { provenance?: EventProvenance },
  conversationId?: string,
  meta?: EventMeta
): FoldEventResult {
  const effects: FoldEffect[] = [];

  if (conversationId !== undefined && draft.detachedConversationIds.has(conversationId)) {
    effects.push({
      type: "log",
      message: `[${draft.title}] [drop] detached conversation event: ${partial.kind}`,
    });
    return { draft, normalizedEvent: null, effects };
  }
  if (meta?.gapBoundaries !== undefined && meta.gapBoundaries.length > 0) {
    draft.carriedGapBoundaries.push(...meta.gapBoundaries);
  }
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
  const work = projectWorkEvent(previousWorkModel, draft.workModel, ev);
  if (work !== undefined) ev.work = work;
  applyActivityEvent(draft.backgroundActivity, ev);
  const trimmed = trimEventLog([...draft.events, ev]);
  draft.workModel = markEventLogTrimmed(draft.workModel, draft.events.length + 1 - trimmed.length);
  draft.events = trimmed;
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
