import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

import { randomUUID } from "node:crypto";
import { basename, dirname, win32 } from "node:path";

import { createBackgroundActivityState } from "./background-activity";
import { ClaudeConversation } from "./claudeHost";
import { registerConversationHistory, releaseConversationHistory } from "./conversation-history";
import { refreshFallbackAppliedModel, warmup } from "./conversation-lifecycle";
import { createEvidenceIndex, evidenceIndexHash } from "./evidence-index";
import {
  foldEventState,
  type EventFoldDraft,
  type EventMeta,
  type FoldEffect,
  type FoldEventResult,
} from "./event-fold";
import {
  handoffDecisionCounts,
  handoffDecisionLineCount,
  handoffContextUsageKey,
  handoffUnreadableLinesKey,
  restoredHandoffUnreadableLineCount,
} from "./handoff-envelope";
import { extensionContext, output } from "./host-context";
import {
  EventProvenance,
  HandoffContextUsage,
  HostToWebview,
  isHandoffContextMeasurement,
  NormalizedEventBody,
  ResumeHydrationPhase,
  ResumePreviewMessage,
  restoredHandoffRunId,
  WebviewToHost,
} from "./protocol";
import { createGuardrailState } from "./guardrail";
import { initialSessionFacts } from "./session-facts";
import { isInSessionStore } from "./session-files";
import { foldTitleRecords, splitCompleteLines } from "./session-display-title";
import { displayTitleFromSummary } from "./session-list";
import { rememberSession, refreshTabTitle, sessionSummaryOf } from "./session-list-wiring";
import {
  captureResumeReadSet,
  readConversationMessages,
  readResumePreviewTail,
  readSessionHistory,
  readSessionTranscript,
  readSubagentAgents,
  type HistoryEvent,
  type ResumeReadSet,
  type SessionTranscript,
} from "./session-transcript";
import {
  Session,
  historyScopeKey,
  isUnusedSession,
} from "./session";
import {
  SessionStore,
  currentScopeMax,
  tabLimit,
  warnTabLimit,
} from "./store-surfaces";
import {
  createWorkModelState,
  markBackgroundUnconfirmed,
  markSubagentGaps,
} from "./work-model";

const HYDRATION_SWITCHOVER_MAX = 64;
const HYDRATION_DRAIN_BATCH = 512;

const RESUME_CWD_SCAN_BYTES = 64 * 1024;

function lastRelocatedCwd(
  lines: readonly { text: string }[]
): { cwd: string | undefined; malformedLines: number } {
  let cwd: string | undefined;
  let malformedLines = 0;
  for (const line of lines) {
    if (!line.text.includes('"relocated"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line.text);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const fields = record as { type?: unknown; relocatedCwd?: unknown };
    if (fields.type !== "relocated") continue;
    if (typeof fields.relocatedCwd === "string" && fields.relocatedCwd.length > 0) {
      cwd = fields.relocatedCwd;
    }
  }
  return { cwd, malformedLines };
}

const PROJECT_DIR_ENCODE_MAX = 200;
function encodedProjectDirName(cwd: string): string | undefined {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return encoded.length > PROJECT_DIR_ENCODE_MAX ? undefined : encoded;
}

function knownCwdMatchingStore(knownCwd: string | undefined, filePath: string): string | undefined {
  if (knownCwd === undefined || knownCwd.length === 0) return undefined;
  return encodedProjectDirName(knownCwd) === basename(dirname(filePath)) ? knownCwd : undefined;
}

function ancestorMatchingStore(dirName: string, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  let current = candidate;
  for (let parent = win32.dirname(current); parent !== current; parent = win32.dirname(current)) {
    if (encodedProjectDirName(parent) === dirName) return parent;
    current = parent;
  }
  return undefined;
}

type RecordedCwdSource = "record-matched" | "ancestor-matched" | "unconfirmed";

async function readRecordedSessionCwd(
  filePath: string
): Promise<{ cwd: string | undefined; source: RecordedCwdSource; malformedRelocationLines: number }> {
  const { open } = await import("node:fs/promises");
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const headLength = Math.min(size, RESUME_CWD_SCAN_BYTES);
    const head = new Uint8Array(headLength);
    if (headLength > 0) await handle.read(head, 0, headLength, 0);
    const tailStart = Math.max(headLength, size - RESUME_CWD_SCAN_BYTES);
    const tailLength = size - tailStart;
    const tail = new Uint8Array(tailLength);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, tailStart);
    const lines = [
      ...splitCompleteLines(head, 0).lines,
      ...splitCompleteLines(tail, tailStart).lines,
    ];
    const relocation = lastRelocatedCwd(lines);
    const firstCwd = foldTitleRecords({ candidates: {} }, lines).cwd;
    const dirName = basename(dirname(filePath));
    const matching = [relocation.cwd, firstCwd].filter(
      (candidate): candidate is string =>
        candidate !== undefined && encodedProjectDirName(candidate) === dirName
    );
    const ancestor =
      matching.length === 0 && relocation.cwd === undefined ? ancestorMatchingStore(dirName, firstCwd) : undefined;
    return {
      cwd: ancestor ?? (matching.length === 1 ? matching[0] : relocation.cwd ?? firstCwd),
      source: ancestor !== undefined ? "ancestor-matched" : matching.length === 1 ? "record-matched" : "unconfirmed",
      malformedRelocationLines: relocation.malformedLines,
    };
  } finally {
    await handle.close();
  }
}

export type HydrationVerdict = "accepted" | "dropped-timestamp" | "dropped-stale";

export interface HydrationJournalEntry {
  journalEventId: string;
  partial: NormalizedEventBody & { provenance?: EventProvenance };
  conversationId?: string;
  meta?: EventMeta;
  verdict: HydrationVerdict;
  displayed: boolean;
  clientToken?: string;
}

function hydrationCommitted(h: ResumeHydration): boolean {
  return h.phase === "complete";
}

export interface ResumeHydration {
  attemptId: string;
  logicalGeneration: number;
  sessionId: string;
  filePath: string;
  readSet: ResumeReadSet | undefined;
  previewMessages: ResumePreviewMessage[];
  phase: ResumeHydrationPhase;
  failureReason?: string;
  buffering: boolean;
  journal: HydrationJournalEntry[];
  journalSeq: number;
  arrivalTimestamp: number | undefined;
  liveSeqBase: number;
  acceptedSinceBuffering: number;
  liveCommitCursor: number;
  liveTitleCandidate?: string;
  workPostDirty: boolean;
  semanticPostDirty: boolean;
  persistencePosts: Map<string, Extract<HostToWebview, { type: "analysisPersistenceState" }>>;
}

interface ResumeOpenOutcome {
  tabPosted: boolean;
  session: Session | undefined;
}

function restoredHandoffContextUsage(value: unknown): HandoffContextUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { before, after } = value as Record<string, unknown>;
  if (before !== null && !isHandoffContextMeasurement(before)) return undefined;
  return after === null || isHandoffContextMeasurement(after) ? { before, after } : { before };
}

export async function openResumedSession(
  st: SessionStore,
  req: {
    sessionId: string;
    filePath: string;
    intoTabId?: string;
    activate: boolean;
    inherit?: { model: string | null | undefined; effort: Session["effortOverride"] };
    knownCwd?: string;
  }
): Promise<ResumeOpenOutcome> {
  let tabPosted = false;
  if (!isInSessionStore(req.filePath)) {
    output.appendLine(`[drop] resume outside session store: ${req.filePath}`);
    void vscode.window.showWarningMessage(l10n.t("LAISORA: Logs outside the session store cannot be restored."));
    return { tabPosted, session: undefined };
  }
  const inFlight = [...st.sessions.values()].find(
    (t) => t.resuming && t.resumeSessionId === req.sessionId
  );
  if (inFlight) {
    output.appendLine(`[${inFlight.title}] resume 重複要求を無視: ${req.sessionId}`);
    return { tabPosted, session: undefined };
  }
  const reuse = req.intoTabId ? st.sessions.get(req.intoTabId) : undefined;
  const canReuse = !!reuse && isUnusedSession(reuse);
  if (!canReuse && st.sessions.size >= tabLimit()) {
    warnTabLimit();
    return { tabPosted, session: undefined };
  }
  const s = canReuse ? reuse! : st.createSession();
  const resumeT0 = Date.now();
  s.resuming = true;
  let hydration: ResumeHydration | null = null;
  let preparation: ReturnType<Session["beginResumePreparation"]> | undefined;
  let resumeGeneration = s.logicalGeneration;
  let readSetT0 = resumeT0;
  let captureDoneT = resumeT0;
  let detached: ClaudeConversation | null = null;
  const lagProbe = startLoopLagProbe();
  try {
    if (canReuse) {
      s.clearing = true;
      try {
        detached = s.detachConversation();
        s.resetLogicalSession();
        s.resetDiscardedProfileForResume();
      } finally {
        s.clearing = false;
      }
    }
    preparation = s.beginResumePreparation();
    resumeGeneration = s.logicalGeneration;
    s.resumeSessionId = req.sessionId;
    if (req.inherit !== undefined) {
      s.modelOverride = req.inherit.model;
      s.effortOverride = req.inherit.effort;
    }
    s.resumeFilePath = req.filePath;
    s.ownerState = {
      kind: "pinned",
      ownerId: req.sessionId,
      logicalGeneration: s.logicalGeneration,
      source: "resume",
    };
    s.analysisStore.loadPersistedArtifactsFromStore();
    s.analysisStore.flushPendingPersistence();
    if (canReuse) {
      void s
        .disposeDetachedConversation(detached)
        .catch((e) => output.appendLine(`[${s.title}] 旧 CLI の破棄に失敗: ${String(e)}`));
    }
    let readSet: ResumeReadSet | undefined;
    let recordedModel: string | undefined;
    let recordedCwd = knownCwdMatchingStore(req.knownCwd, req.filePath);
    if (recordedCwd !== undefined) {
      output.appendLine(`[${s.title}] resume cwd=${recordedCwd} source=known`);
    }
    try {
      readSetT0 = Date.now();
      readSet = await captureResumeReadSet(req.filePath);
      recordedModel = readSet.recordedModel;
      if (recordedCwd === undefined) {
        const recorded = await readRecordedSessionCwd(req.filePath);
        recordedCwd = recorded.cwd;
        output.appendLine(
          `[${s.title}] resume cwd=${recordedCwd ?? "(none)"} source=${recorded.source}` +
            ` malformedRelocation=${recorded.malformedRelocationLines}`
        );
      }
    } catch (error) {
      output.appendLine(`[${s.title}] resume read-set / cwd 捕捉に失敗: ${String(error)}`);
    }
    captureDoneT = Date.now();
    if (s.closed || st.sessions.get(s.tabId) !== s || s.logicalGeneration !== resumeGeneration || s.resumePreparation !== preparation) {
      s.resuming = false;
      return { tabPosted, session: undefined };
    }
    s.recordedModel = recordedModel;
    if (recordedCwd !== undefined && recordedCwd.length > 0) s.cwd = recordedCwd;
    hydration = {
      attemptId: randomUUID(),
      logicalGeneration: s.logicalGeneration,
      sessionId: req.sessionId,
      filePath: req.filePath,
      readSet,
      previewMessages: [],
      phase: "loading",
      buffering: true,
      journal: [],
      journalSeq: 0,
      arrivalTimestamp: readSet?.lastCompleteParentTimestamp,
      liveSeqBase: s.seq,
      acceptedSinceBuffering: 0,
      liveCommitCursor: 0,
      workPostDirty: false,
      semanticPostDirty: false,
      persistencePosts: new Map(),
    };
    s.hydration = hydration;
    s.hydrationCoverageUnconfirmed = false;
    st.post(
      canReuse
        ? { type: "tabCleared", tab: s.resumePreviewSnapshot(hydration) }
        : { type: "tabCreated", tab: s.resumePreviewSnapshot(hydration), activate: req.activate }
    );
    tabPosted = !canReuse;
    output.appendLine(
      `[${s.title}] resume phase1 描画: ${Date.now() - resumeT0}ms` +
        `（準備 ${readSetT0 - resumeT0}ms / read-set ${captureDoneT - readSetT0}ms）`
    );
    let previewMessages: ResumePreviewMessage[] = [];
    const previewT0 = Date.now();
    try {
      previewMessages = await readResumePreviewTail(req.filePath, req.sessionId);
    } catch (error) {
      output.appendLine(`[${s.title}] resume preview 取得に失敗: ${String(error)}`);
    }
    const previewDoneT = Date.now();
    if (s.closed || st.sessions.get(s.tabId) !== s || s.logicalGeneration !== resumeGeneration || s.resumePreparation !== preparation) {
      if (s.hydration === hydration) s.hydration = null;
      s.resuming = false;
      return { tabPosted, session: undefined };
    }
    hydration.previewMessages = previewMessages;
    let transcript: SessionTranscript | undefined;
    if (s.recordedModel === undefined) {
      transcript = await readSessionTranscript(req.filePath, isInSessionStore, readSet, req.sessionId);
      if (s.closed || st.sessions.get(s.tabId) !== s || s.hydration !== hydration || s.logicalGeneration !== hydration.logicalGeneration) {
        output.appendLine(`[${s.title}] resume aborted: the session changed while reading the recorded model`);
        if (s.hydration === hydration) s.finalizeHydrationFailure(hydration, "cancelled", false);
        else if (s.hydration === null) s.resuming = false;
        return { tabPosted, session: undefined };
      }
      s.recordedModel = transcript.recordedModel;
      if (s.recordedModel !== undefined) st.post({ type: "tabCleared", tab: s.resumePreviewSnapshot(hydration) });
    }
    if (previewMessages.length > 0) {
      st.post({
        type: "resumeHydrationState",
        tabId: s.tabId,
        phase: "loading",
        previewMessages: s.hydrationPreviewMessages(hydration),
      });
    }
    output.appendLine(
      `[${s.title}] resume phase1: ${previewDoneT - resumeT0}ms` +
        `（準備 ${readSetT0 - resumeT0}ms / read-set ${captureDoneT - readSetT0}ms` +
        ` / preview ${previewDoneT - previewT0}ms / loop lag 最大 ${lagProbe.maxLagMs()}ms）`
    );
    lagProbe.stop();
    if (hydration.arrivalTimestamp !== undefined) s.finishResumePreparation(preparation);
    warmup(s);
    await runResumeHydration(st, s, hydration, transcript);
  } catch (e) {
    output.appendLine(`[${s.title}] resume 失敗: ${String(e)}`);
    if (hydration === null || s.hydration === null) {
      s.resuming = false;
    } else if (s.hydration === hydration && !hydrationCommitted(hydration)) {
      s.finalizeHydrationFailure(
        hydration,
        String(e),
        !s.closed && st.sessions.get(s.tabId) === s
      );
    }
  } finally {
    if (preparation !== undefined) s.finishResumePreparation(preparation);
    lagProbe.stop();
  }
  rememberSession(s);
  return { tabPosted, session: s };
}

export async function handleResumeMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "resumeSession" | "resumeHydrationRetry" }>,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "resumeSession": {
      await openResumedSession(st, {
        sessionId: msg.sessionId,
        filePath: msg.filePath,
        ...(msg.intoTabId !== undefined ? { intoTabId: msg.intoTabId } : {}),
        activate: true,
      });
      break;
    }
    case "resumeHydrationRetry": {
      const s = target!;
      const h = s.hydration;
      if (h === null || h.phase !== "failed" || s.resuming || s.closed) break;
      h.attemptId = randomUUID();
      h.phase = "loading";
      h.failureReason = undefined;
      h.buffering = true;
      h.logicalGeneration = s.logicalGeneration;
      h.liveSeqBase = s.seq;
      h.acceptedSinceBuffering = 0;
      s.resuming = true;
      st.post({ type: "resumeHydrationState", tabId: s.tabId, phase: "loading" });
      try {
        await runResumeHydration(st, s, h);
      } catch (e) {
        output.appendLine(`[${s.title}] resume retry 失敗: ${String(e)}`);
        if (s.hydration === h && !hydrationCommitted(h)) {
          s.finalizeHydrationFailure(h, String(e), !s.closed && st.sessions.get(s.tabId) === s);
        }
      }
      break;
    }
  }
}

interface DraftEffectSink {
  guardrailRefresh: boolean;
  guardrailTick: boolean;
  resolveOwner: { sessionId: string; logicalGeneration: number } | null;
  commandsTouched: boolean;
  liveTurnCompleted: boolean;
}

function applyDraftEffects(effects: readonly FoldEffect[], sink: DraftEffectSink): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "log":
        output.appendLine(effect.message);
        break;
      case "schedule_guardrail_refresh":
        sink.guardrailRefresh = true;
        break;
      case "schedule_guardrail_tick":
        sink.guardrailTick = true;
        break;
      case "post_commands":
        sink.commandsTouched = true;
        break;
      case "resolve_owner":
        sink.resolveOwner = {
          sessionId: effect.sessionId,
          logicalGeneration: effect.logicalGeneration,
        };
        break;
      case "refresh_tab_title":
      case "schedule_transcript_time_buckets":
        break;
      case "post_events":
      case "schedule_work_model_post":
      case "schedule_semantic_model_post":
        output.appendLine(`[hydration] draft fold が抑止対象の effect を出した: ${effect.type}`);
        break;
      default: {
        const unhandled: never = effect;
        output.appendLine(`[hydration] 未知の FoldEffect を破棄: ${JSON.stringify(unhandled)}`);
        break;
      }
    }
  }
}

export function createHydrationDraft(s: Session): EventFoldDraft {
  return {
    tabId: s.tabId,
    title: s.title,
    generation: s.generation,
    logicalGeneration: s.logicalGeneration,
    expectedConversationId: s.expectedConversationId,
    detachedConversationIds: s.detachedConversationIds,
    conversation: s.conversation,
    seq: 0,
    lastEventTimestamp: undefined,
    timestampContractViolations: 0,
    carriedGapBoundaries: [],
    sessionFacts: initialSessionFacts(),
    guardrail: createGuardrailState(),
    liveGuardrailSignalIds: new Set<string>(),
    guardrailLiveSince: undefined,
    commands: [...s.commands],
    auth: s.auth,
    models: s.models,
    lastContextTotalTokens: s.lastContextTotalTokens,
    liveDelegationAgentIds: new Set<string>(),
    liveDelegationRev: s.liveDelegationRev,
    backgroundActivity: createBackgroundActivityState(),
    workModel: createWorkModelState(),
    evidenceIndex: createEvidenceIndex(),
    events: [],
    titleRefreshed: s.titleRefreshed,
    titleRefreshing: s.titleRefreshing,
    resuming: true,
    closed: false,
  };
}

function commitHydrationDraft(s: Session, draft: EventFoldDraft, commandsTouched: boolean): void {
  s.seq = draft.seq;
  s.lastEventTimestamp = draft.lastEventTimestamp;
  s.timestampContractViolations = draft.timestampContractViolations;
  s.carriedGapBoundaries = draft.carriedGapBoundaries;
  s.sessionFacts = draft.sessionFacts;
  s.guardrail = draft.guardrail;
  s.liveGuardrailSignalIds = draft.liveGuardrailSignalIds;
  s.guardrailLiveSince = draft.guardrailLiveSince;
  s.auth = draft.auth;
  s.modelFallback = draft.modelFallback;
  if (draft.modelFallback) {
    s.appliedModel = draft.modelFallback.appliedModel;
    s.effectiveModel = draft.modelFallback.appliedModel;
  }
  s.lastContextTotalTokens = draft.lastContextTotalTokens;
  if (commandsTouched) s.commands = draft.commands;
  s.liveDelegationAgentIds = draft.liveDelegationAgentIds;
  s.liveDelegationRev = draft.liveDelegationRev;
  s.backgroundActivity = draft.backgroundActivity;
  s.workModel = draft.workModel;
  s.evidenceIndex = draft.evidenceIndex;
  s.events = draft.events;
}

const HYDRATION_YIELD_RECORDS = 500;
const HYDRATION_YIELD_MS = 8;

function createHydrationYielder(): () => Promise<void> | undefined {
  let count = 0;
  let startedAt = Date.now();
  return () => {
    count++;
    if (count < HYDRATION_YIELD_RECORDS && Date.now() - startedAt < HYDRATION_YIELD_MS) {
      return undefined;
    }
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        count = 0;
        startedAt = Date.now();
        resolve();
      })
    );
  };
}

export async function foldHistoryEvents(
  draft: EventFoldDraft,
  history: { events: readonly HistoryEvent[] },
  visit: (step: FoldEventResult) => "continue" | "stop",
  invalidated: () => boolean
): Promise<"complete" | "stopped" | "invalidated"> {
  const maybeYield = createHydrationYielder();
  for (const ev of history.events) {
    const step = foldEventState(draft, ev.body, undefined, {
      timestamp: ev.timestamp,
      hostArtifacts: ev.hostArtifacts,
      gapBoundaries: ev.gapBoundaries,
      suppressPost: true,
    });
    if (visit(step) === "stop") return "stopped";
    const pending = maybeYield();
    if (pending) {
      await pending;
      if (invalidated()) return "invalidated";
    }
  }
  return "complete";
}

function replayJournalInto(
  draft: EventFoldDraft,
  journal: readonly HydrationJournalEntry[],
  from: number,
  to: number,
  sink: DraftEffectSink
): number {
  let dropped = 0;
  for (let i = from; i < to; i++) {
    const entry = journal[i];
    if (entry.partial.provenance?.path === "live" && entry.partial.kind === "turn_completed") {
      sink.liveTurnCompleted = true;
    }
    if (entry.verdict !== "accepted") {
      if (entry.meta?.gapBoundaries !== undefined && entry.meta.gapBoundaries.length > 0) {
        draft.carriedGapBoundaries.push(...entry.meta.gapBoundaries);
      }
      if (entry.verdict === "dropped-timestamp") dropped += 1;
      continue;
    }
    const { effects } = foldEventState(draft, entry.partial, entry.conversationId, {
      ...(entry.meta ?? {}),
      suppressPost: true,
      arrivalJudged: true,
    });
    applyDraftEffects(effects, sink);
  }
  return dropped;
}

async function runResumeHydration(st: SessionStore, s: Session, h: ResumeHydration, capturedTranscript?: SessionTranscript): Promise<void> {
  const invalidated = (): boolean =>
    s.closed ||
    st.sessions.get(s.tabId) !== s ||
    s.hydration !== h ||
    s.logicalGeneration !== h.logicalGeneration;
  const abort = (why: string): void => {
    output.appendLine(`[${s.title}] resume 中止: ${why}`);
    if (s.hydration !== h) {
      if (s.hydration === null) s.resuming = false;
      return;
    }
    s.finalizeHydrationFailure(h, "cancelled", !s.closed && st.sessions.get(s.tabId) === s);
  };
  const historyOpts = {
    ...(h.readSet === undefined ? {} : { resumeReadSet: h.readSet }),
    generationSessionId: h.sessionId,
  };

  const transcript = capturedTranscript ?? await readSessionTranscript(h.filePath, isInSessionStore, h.readSet, h.sessionId);
  if (invalidated()) return abort("読み取り中にセッションが変化しました");
  const { title, messages } = transcript;
  s.recordedModel = transcript.recordedModel ?? s.recordedModel;
  if (transcript.readError) {
    output.appendLine(`[${s.title}] resume transcript read failed: ${transcript.readError}`);
  } else if (
    transcript.coverage.summary !== "complete" ||
    transcript.coverage.details !== "complete"
  ) {
    output.appendLine(
      `[${s.title}] resume transcript incomplete: malformed=${transcript.malformedLineCount} ` +
        `omittedMessages=${transcript.coverage.omittedMessageCount ?? 0} ` +
        `omittedTools=${transcript.coverage.omittedToolCount ?? 0}`
    );
  }
  const resolvedTitle = (await sessionSummaryOf(h.sessionId)) ?? title;
  if (invalidated()) return abort("タイトル解決中にセッションが変化しました");
  const titleAtResolve = s.title;
  const autoTitledAtResolve = s.autoTitled;

  const history = await readSessionHistory(h.filePath, isInSessionStore, historyOpts);
  if (invalidated()) return abort("履歴読み取り中にセッションが変化しました");
  if (history.readError) {
    output.appendLine(`[${s.title}] resume history read failed: ${history.readError}`);
  } else if (history.subagentsReadError) {
    output.appendLine(`[${s.title}] resume history subagents/ read failed: ${history.subagentsReadError}`);
  } else if (history.coverage.summary !== "complete" || history.coverage.details !== "complete") {
    output.appendLine(`[${s.title}] resume history incomplete: malformed=${history.malformedLineCount}`);
  }

  const draft = createHydrationDraft(s);
  const sink: DraftEffectSink = {
    guardrailRefresh: false,
    guardrailTick: false,
    resolveOwner: null,
    commandsTouched: false,
    liveTurnCompleted: false,
  };
  const folded = await foldHistoryEvents(
    draft,
    history,
    (step) => {
      applyDraftEffects(step.effects, sink);
      return "continue";
    },
    invalidated
  );
  if (folded === "invalidated") return abort("履歴集計中にセッションが変化しました");
  draft.workModel = {
    ...draft.workModel,
    coverage: {
      ...draft.workModel.coverage,
      ...(history.coverage.summary !== "complete" ? { summary: history.coverage.summary } : {}),
      ...(history.coverage.details !== "complete" ? { details: history.coverage.details } : {}),
      ...(history.coverage.omittedTranscriptCount
        ? { omittedTranscriptCount: history.coverage.omittedTranscriptCount }
        : {}),
      ...(history.coverage.omittedMessageCount
        ? { omittedMessageCount: history.coverage.omittedMessageCount }
        : {}),
      ...(history.coverage.omittedToolCount
        ? { omittedToolCount: history.coverage.omittedToolCount }
        : {}),
      ...(history.coverage.hierarchyIncomplete ? { hierarchyIncomplete: true as const } : {}),
      ...(history.coverage.historyReadError !== undefined
        ? { historyReadError: history.coverage.historyReadError }
        : {}),
      ...(history.coverage.historyMalformedLineCount
        ? { historyMalformedLineCount: history.coverage.historyMalformedLineCount }
        : {}),
      source: "provider-transcript",
    },
  };
  draft.evidenceIndex = { ...draft.evidenceIndex, hash: evidenceIndexHash(draft.evidenceIndex) };

  const restored = await readSubagentAgents(h.filePath, isInSessionStore);
  if (invalidated()) return abort("階層読み取り中にセッションが変化しました");
  draft.workModel = markSubagentGaps(draft.workModel, {
    unreadableAgentCount:
      restored.malformedMetaCount + restored.transcriptReadFailureCount + restored.omittedTranscriptCount,
    hierarchyIncomplete: restored.readError !== undefined || restored.malformedMetaCount > 0,
  });
  draft.workModel = markBackgroundUnconfirmed(draft.workModel, draft.lastEventTimestamp ?? Date.now());
  output.appendLine(
    `[${s.title}] resume subagents: meta=${restored.metaCount} malformed=${restored.malformedMetaCount} ` +
      `transcripts=${restored.transcriptsRead} readFailed=${restored.transcriptReadFailureCount} ` +
      `omitted=${restored.omittedTranscriptCount} bytes=${restored.bytesRead} ` +
      `${restored.elapsedMs}ms${restored.readError ? ` error=${restored.readError}` : ""}`
  );

  const foldIntoDraft = (
    partial: NormalizedEventBody & { provenance?: EventProvenance }
  ): void => {
    applyDraftEffects(
      foldEventState(draft, partial, undefined, { suppressPost: true }).effects,
      sink
    );
  };
  if (transcript.readError || history.readError) {
    const err = transcript.readError ?? history.readError;
    const nothingRead = history.events.length === 0 && messages.length === 0;
    foldIntoDraft({
      kind: "error",
      message: nothingRead
        ? l10n.t("Could not read the past log ({0}). Resuming without history (the CLI-side resume continues).", String(err))
        : l10n.t(
            "Could not read the past log ({0}). Resuming with only the part that could be read (the CLI-side resume continues).",
            String(err)
          ),
      fatal: false,
    });
  } else if (history.subagentsReadError) {
    foldIntoDraft({
      kind: "error",
      message: l10n.t(
        "Could not read the subagent record list ({0}). Subagent work is not included in the history (the CLI-side resume continues).",
        history.subagentsReadError
      ),
      fatal: false,
    });
  } else if (transcript.malformedLineCount > 0 || history.malformedLineCount > 0) {
    const count = Math.max(transcript.malformedLineCount, history.malformedLineCount);
    foldIntoDraft({
      kind: "error",
      message: l10n.t("{0} lines of the past log could not be read. Part of the history is missing.", count),
      fatal: false,
    });
  }
  const anchors = messages
    .map((m) => m.uuid)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  const maybeYield = createHydrationYielder();
  for (const m of messages) {
    foldIntoDraft({
      kind: "replayed_message",
      role: m.role,
      text: m.text,
      uuid: m.uuid,
      ...(m.restoredApproval ? { restoredApproval: m.restoredApproval } : {}),
      ...(m.imageRefs && m.imageRefs.length > 0 ? { imageRefs: m.imageRefs } : {}),
      ...(m.model ? { model: m.model } : {}),
      ...(m.timestamp > 0 ? { recordedAt: m.timestamp } : {}),
    });
    const pending = maybeYield();
    if (pending) {
      await pending;
      if (invalidated()) return abort("表示メッセージ整形中にセッションが変化しました");
    }
  }

  const conversation = await readConversationMessages(h.filePath, isInSessionStore, h.readSet, h.sessionId);
  if (invalidated()) return abort("会話履歴読み取り中にセッションが変化しました");

  if (conversation.handoffEnvelope?.snapshot.forkSessionId === h.sessionId) {
    const sourceId = conversation.handoffEnvelope.snapshot.sourceSessionId;
    const existingSource = [...st.sessions.values()].find(
      (other) => !other.closed && (other.resumeSessionId === sourceId || other.auth?.sessionId === sourceId)
    );
    const restoredContextUsage = restoredHandoffContextUsage(extensionContext?.globalState.get(handoffContextUsageKey(h.sessionId)));
    const unreadableLineCount = restoredHandoffUnreadableLineCount(extensionContext?.globalState.get(handoffUnreadableLinesKey(h.sessionId)));
    const decisions = conversation.handoffEnvelope.decisions;
    s.handoffSource = {
      sessionId: sourceId,
      ...(existingSource?.title ? { title: existingSource.title } : {}),
      ...(conversation.handoffEnvelope.snapshot.compact !== undefined
        ? { compact: conversation.handoffEnvelope.snapshot.compact }
        : {}),
      ...(restoredContextUsage !== undefined ? { contextUsage: restoredContextUsage } : {}),
      utteranceCount: conversation.handoffEnvelope.userUtterances.length,
      ...(unreadableLineCount !== undefined ? { unreadableLineCount } : {}),
      ...(decisions !== undefined
        ? { decisionCount: handoffDecisionLineCount(decisions), decisions: handoffDecisionCounts(decisions) }
        : {}),
      detailRunId: restoredHandoffRunId(h.sessionId),
    };
  }

  draft.generation = s.generation;

  let cursor = 0;
  let dropped = 0;
  while (h.journal.length - cursor > HYDRATION_SWITCHOVER_MAX) {
    const end = Math.min(h.journal.length - HYDRATION_SWITCHOVER_MAX, cursor + HYDRATION_DRAIN_BATCH);
    dropped += replayJournalInto(draft, h.journal, cursor, end, sink);
    cursor = end;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (invalidated()) return abort("journal 整理中にセッションが変化しました");
  }

  dropped += replayJournalInto(draft, h.journal, cursor, h.journal.length, sink);
  draft.timestampContractViolations += dropped;
  h.buffering = false;
  h.phase = "complete";
  h.liveCommitCursor = h.journal.length;
  commitHydrationDraft(s, draft, sink.commandsTouched);
  refreshFallbackAppliedModel(st, s);
  s.restoredAgents = restored.agents;
  s.hydrationCoverageUnconfirmed = false;
  s.conversationAnchorUuids = anchors;
  h.journal.length = 0;
  h.liveCommitCursor = 0;
  try {
    registerConversationHistory(historyScopeKey(s), conversation.messages, currentScopeMax());
    output.appendLine(
      `[${s.title}] 会話履歴を登録: ${conversation.messages.length}件 ` +
        `malformed=${conversation.malformedLineCount} uuid欠落=${conversation.droppedWithoutUuidCount}`
    );
  } catch (error) {
    releaseConversationHistory(historyScopeKey(s));
    output.appendLine(`[${s.title}] 会話履歴の登録に失敗: ${String(error)}`);
  }
  if (s.title === titleAtResolve && s.autoTitled === autoTitledAtResolve) {
    if (resolvedTitle) {
      s.title = displayTitleFromSummary(resolvedTitle, h.sessionId);
      s.autoTitled = true;
    } else if (h.liveTitleCandidate) {
      s.title = displayTitleFromSummary(h.liveTitleCandidate, s.tabId);
      s.autoTitled = true;
    }
  }
  st.post({ type: "tabCleared", tab: s.snapshot() });
  s.resuming = false;

  s.flushHydrationPosts(h);
  if (sink.guardrailRefresh) s.guardrailRunner.scheduleGuardrailRefresh();
  if (sink.guardrailTick) s.guardrailRunner.scheduleGuardrailTick();
  if (sink.resolveOwner !== null) {
    s.analysisStore.resolveOwnerFromAuthStatus(sink.resolveOwner.sessionId, sink.resolveOwner.logicalGeneration);
  }
  s.semantic.scheduleTranscriptTimeBuckets();
  if (sink.liveTurnCompleted && !s.titleRefreshed && !s.titleRefreshing && !s.closed) {
    s.titleRefreshing = true;
    void refreshTabTitle(s);
  }
}

const RESUME_LOOP_LAG_TICK_MS = 20;
function startLoopLagProbe(): { maxLagMs: () => number; stop: () => void } {
  let maxLag = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - RESUME_LOOP_LAG_TICK_MS;
    if (lag > maxLag) maxLag = lag;
    last = now;
  }, RESUME_LOOP_LAG_TICK_MS);
  timer.unref?.();
  return { maxLagMs: () => maxLag, stop: () => clearInterval(timer) };
}
