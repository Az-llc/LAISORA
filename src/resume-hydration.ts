import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

import { randomUUID } from "node:crypto";
import { basename, dirname, win32 } from "node:path";

import { createBackgroundActivityState } from "./background-activity";
import { ClaudeConversation } from "./claudeHost";
import { registerConversationHistory, releaseConversationHistory } from "./conversation-history";
import { cliStartOf, refreshFallbackAppliedModel, warmup } from "./conversation-lifecycle";
import { createEvidenceIndex, evidenceIndexHash } from "./evidence-index";
import {
  adoptFallbackModel,
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
  isObservedTime,
  NormalizedEventBody,
  ResumeHydrationPhase,
  ResumePreviewMessage,
  restoredHandoffRunId,
  WebviewToHost,
} from "./protocol";
import { createGuardrailState } from "./guardrail";
import { initialSessionFacts } from "./session-facts";
import { isInSessionStore, lookupSessionFile } from "./session-files";
import { foldTitleRecords, splitCompleteLines } from "./session-display-title";
import { displayTitleFromSummary } from "./session-list";
import { handoffForkInFlight, holdsChosenTitle, rememberSession, refreshTabTitle, sessionDisplayTitleOf, sessionSummaryOf } from "./session-list-wiring";
import { currentGenerationRecords } from "./time-buckets";
import {
  captureResumeReadSet,
  claimParentParseTurn,
  parentRecordSource,
  readConversationMessages,
  readResumePreviewTail,
  readSessionHistory,
  readSessionTranscript,
  readSubagentAgents,
  type HistoryEvent,
  type ParentParseClaim,
  type ParentRecordSource,
  type ResumeReadSet,
  type SessionHistoryRead,
  type SessionTranscript,
  type TranscriptMessage,
} from "./session-transcript";
import {
  Session,
  historyScopeKey,
  isUnusedSession,
  type StartMeasurement,
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
  summary: Promise<string | undefined>;
  titleAtResolve?: ResumeTitleState;
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

export async function openSessionById(
  st: SessionStore,
  sender: vscode.Webview,
  sessionId: string
): Promise<"activated" | "opened" | "not_opened" | "not_found" | "scan_failed"> {
  const existing = [...st.sessions.values()].find(
    (s) => !s.closed && (s.resumeSessionId === sessionId || s.auth?.sessionId === sessionId)
  );
  if (existing) {
    await st.postTo(sender, { type: "activateTab", tabId: existing.tabId });
    return "activated";
  }
  const lookup = lookupSessionFile(sessionId);
  if (lookup.reason === "not_found") return "not_found";
  if (lookup.reason === "scan_failed") {
    output.appendLine(`[resume] session lookup failed: ${sessionId}: ${lookup.detail}`);
    return "scan_failed";
  }
  if (!lookup.path) return "not_opened";
  const opened = await openResumedSession(st, { sessionId, filePath: lookup.path, activate: true });
  return opened.tabPosted ? "opened" : "not_opened";
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
    startMeasurement?: StartMeasurement;
  }
): Promise<ResumeOpenOutcome> {
  let tabPosted = false;
  if (!isInSessionStore(req.filePath)) {
    output.appendLine(`[drop] resume outside session store: ${req.filePath}`);
    void vscode.window.showWarningMessage(l10n.t("LAISORA: Logs outside the session store cannot be restored."));
    return { tabPosted, session: undefined };
  }
  if (handoffForkInFlight(req.sessionId, Date.now())) {
    output.appendLine(`[drop] resume of a fork whose handoff is still running: ${req.sessionId}`);
    void vscode.window.showWarningMessage(l10n.t("LAISORA: This conversation is still being handed off. Open it after the handoff finishes."));
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
  const parseClaim = claimParentParseTurn(req.activate ? RESUME_FOREGROUND_PARSE_RESERVE_MS : 0);
  let hydration: ResumeHydration | null = null;
  let preparation: ReturnType<Session["beginResumePreparation"]> | undefined;
  let resumeGeneration = s.logicalGeneration;
  let readSetT0 = resumeT0;
  let captureDoneT = resumeT0;
  let readSetCpu0 = 0;
  let captureDoneCpu = 0;
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
    if (req.startMeasurement !== undefined) s.startMeasurement = req.startMeasurement;
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
    const titleRequest = requestResumeTitle(s, req.sessionId);
    let readSet: ResumeReadSet | undefined;
    let recordedModel: string | undefined;
    let recordedCwd = knownCwdMatchingStore(req.knownCwd, req.filePath);
    if (recordedCwd !== undefined) {
      output.appendLine(`[${s.title}] resume cwd=${recordedCwd} source=known`);
    }
    try {
      readSetT0 = Date.now();
      readSetCpu0 = hostCpuMs();
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
    captureDoneCpu = hostCpuMs();
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
      summary: titleRequest.pending,
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
    trackResumeTitle(st, s, hydration, titleRequest);
    output.appendLine(
      `[${s.title}] resume phase1 描画: ${Date.now() - resumeT0}ms` +
        `（準備 ${readSetT0 - resumeT0}ms / read-set ${captureDoneT - readSetT0}ms）`
    );
    let previewMessages: ResumePreviewMessage[] = [];
    const previewT0 = Date.now();
    const previewCpu0 = hostCpuMs();
    try {
      previewMessages = await readResumePreviewTail(req.filePath, req.sessionId);
    } catch (error) {
      output.appendLine(`[${s.title}] resume preview 取得に失敗: ${String(error)}`);
    }
    const previewDoneT = Date.now();
    const previewCpuMs = hostCpuMs() - previewCpu0;
    if (s.closed || st.sessions.get(s.tabId) !== s || s.logicalGeneration !== resumeGeneration || s.resumePreparation !== preparation) {
      if (s.hydration === hydration) s.hydration = null;
      s.resuming = false;
      return { tabPosted, session: undefined };
    }
    hydration.previewMessages = previewMessages;
    let transcript: SessionTranscript | undefined;
    let transcriptMs: number | undefined;
    let transcriptCpuMs = 0;
    if (s.recordedModel === undefined && readSet?.recordedModelSettled !== true) {
      const transcriptT0 = Date.now();
      const transcriptCpu0 = hostCpuMs();
      transcript = await readSessionTranscript(req.filePath, isInSessionStore, readSet, req.sessionId);
      transcriptMs = Date.now() - transcriptT0;
      transcriptCpuMs = hostCpuMs() - transcriptCpu0;
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
        `（準備 ${readSetT0 - resumeT0}ms / read-set ${captureDoneT - readSetT0}ms (cpu ${captureDoneCpu - readSetCpu0}ms)` +
        ` / preview ${previewDoneT - previewT0}ms (cpu ${previewCpuMs}ms)` +
        (transcriptMs === undefined ? "" : ` / transcript ${transcriptMs}ms (cpu ${transcriptCpuMs}ms)`) +
        ` / loop lag 最大 ${lagProbe.maxLagMs()}ms）`
    );
    lagProbe.stop();
    const timed = hydration.arrivalTimestamp !== undefined;
    if (timed) s.finishResumePreparation(preparation);
    const pendingPreparation = preparation;
    const cliStart = cliStartOf(s);
    const cliFirst: CliFirst = {
      started: Promise.race([cliStart, warmup(s)]),
      ...(timed ? {} : { releaseAfterReads: () => s.finishResumePreparation(pendingPreparation) }),
    };
    await runResumeHydration(st, s, hydration, transcript, resumeT0, cliFirst, parseClaim);
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
    parseClaim.drop();
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
      trackResumeTitle(st, s, h, requestResumeTitle(s, h.sessionId));
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
    get cliStartedAt() { return s.cliStartedAt; },
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
  adoptFallbackModel(s, s.modelFallback, draft.modelFallback);
  s.modelFallback = draft.modelFallback;
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

function restoredRecordUuid(body: NormalizedEventBody): string | undefined {
  if (body.kind === "assistant_message_uuid") return body.uuid;
  if (body.kind === "user_message") return body.uuid;
  return undefined;
}

export function restoredMessagePlan(
  messages: readonly TranscriptMessage[],
  history: { readonly events: readonly HistoryEvent[] }
): { head: TranscriptMessage[]; after: Map<string, TranscriptMessage[]>; tail: TranscriptMessage[] } {
  const drawn = new Set<string>();
  for (const ev of history.events) {
    const uuid = restoredRecordUuid(ev.body);
    if (uuid !== undefined && !("priorGeneration" in ev.body && ev.body.priorGeneration === true)) drawn.add(uuid);
  }
  const head: TranscriptMessage[] = [];
  const after = new Map<string, TranscriptMessage[]>();
  let pending = head;
  for (const m of messages) {
    if (m.role !== "system" && m.restoredApproval === undefined && m.uuid !== undefined && drawn.has(m.uuid)) {
      pending = [];
      after.set(m.uuid, pending);
      continue;
    }
    pending.push(m);
  }
  return { head: drawn.size === 0 ? [] : head, after, tail: drawn.size === 0 ? [...messages] : [] };
}

function replayedMessageEvent(m: TranscriptMessage): NormalizedEventBody {
  return {
    kind: "replayed_message",
    role: m.role,
    text: m.text,
    uuid: m.uuid,
    ...(m.restoredApproval ? { restoredApproval: m.restoredApproval } : {}),
    ...(m.imageRefs && m.imageRefs.length > 0 ? { imageRefs: m.imageRefs } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.timestamp > 0 ? { recordedAt: m.timestamp } : {}),
  };
}

export async function foldHistoryEvents(
  draft: EventFoldDraft,
  history: { events: readonly HistoryEvent[] },
  visit: (step: FoldEventResult, ev: HistoryEvent) => "continue" | "stop",
  invalidated: () => boolean
): Promise<"complete" | "stopped" | "invalidated"> {
  const maybeYield = createHydrationYielder();
  for (const ev of currentGenerationRecords(history.events)) {
    const step = foldEventState(draft, ev.body, undefined, {
      timestamp: ev.timestamp,
      hostArtifacts: ev.hostArtifacts,
      gapBoundaries: ev.gapBoundaries,
      suppressPost: true,
    });
    if (visit(step, ev) === "stop") return "stopped";
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

interface CliFirst {
  started: Promise<void>;
  releaseAfterReads?: () => void;
}

const RESUME_CLI_FIRST_WAIT_MS = 3000;
const RESUME_FOREGROUND_PARSE_RESERVE_MS = RESUME_CLI_FIRST_WAIT_MS + 2000;
const resumeCliStarts = new Map<Promise<void>, number>();

async function afterResumeCliStarts(own: Promise<void>): Promise<"started" | "timeout"> {
  let ownSettled = false;
  const ownUntil = Date.now() + RESUME_CLI_FIRST_WAIT_MS;
  resumeCliStarts.set(own, ownUntil);
  void own.then(() => {
    ownSettled = true;
    resumeCliStarts.delete(own);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      const now = Date.now();
      for (const [start, until] of resumeCliStarts) if (until <= now) resumeCliStarts.delete(start);
      if (resumeCliStarts.size === 0 || now >= ownUntil) break;
      const nearest = Math.min(ownUntil, ...resumeCliStarts.values());
      await Promise.race([
        Promise.allSettled(resumeCliStarts.keys()),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, nearest - now); }),
      ]);
      clearTimeout(timer);
    }
  } finally {
    clearTimeout(timer);
  }
  return ownSettled ? "started" : "timeout";
}

function lastObservedTime(events: readonly HistoryEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isObservedTime(events[i].timestamp)) return events[i].timestamp;
  }
  return undefined;
}

function adoptResumeTitle(s: Session, summary: string, sessionId: string): void {
  s.title = displayTitleFromSummary(summary, sessionId);
  s.autoTitled = true;
}

interface ResumeTitleState {
  title: string;
  autoTitled: boolean;
}

interface ResumeTitleRequest {
  pending: Promise<string | undefined>;
  issued: ResumeTitleState;
  issuedWhileHeld: boolean;
}

function titleStateOf(s: Session): ResumeTitleState {
  return { title: s.title, autoTitled: s.autoTitled };
}

function requestResumeTitle(s: Session, sessionId: string): ResumeTitleRequest {
  return {
    pending: sessionSummaryOf(sessionId).catch((error: unknown) => {
      output.appendLine(`[${s.title}] resume title lookup failed: ${String(error)}`);
      return undefined;
    }),
    issued: titleStateOf(s),
    issuedWhileHeld: holdsChosenTitle(s),
  };
}

function trackResumeTitle(st: SessionStore, s: Session, h: ResumeHydration, request: ResumeTitleRequest): void {
  const { pending, issued, issuedWhileHeld } = request;
  h.summary = pending;
  h.titleAtResolve = undefined;
  void pending.then((summary) => {
    if (h.summary !== pending || issuedWhileHeld || s.title !== issued.title || s.autoTitled !== issued.autoTitled) return;
    h.titleAtResolve = issued;
    try {
      if (summary === undefined || s.closed || st.sessions.get(s.tabId) !== s || s.hydration !== h) return;
      if (s.logicalGeneration !== h.logicalGeneration || holdsChosenTitle(s)) return;
      adoptResumeTitle(s, summary, h.sessionId);
      h.titleAtResolve = titleStateOf(s);
      st.post({ type: "tabRenamed", tabId: s.tabId, title: s.title });
    } catch (error) {
      output.appendLine(`[${s.title}] resume early title failed: ${String(error)}`);
    }
  });
}

async function runResumeHydration(
  st: SessionStore,
  s: Session,
  h: ResumeHydration,
  capturedTranscript?: SessionTranscript,
  startedAt = Date.now(),
  cliFirst?: CliFirst,
  parseClaim?: ParentParseClaim
): Promise<void> {
  const lagProbe = startLoopLagProbe();
  try {
    await runResumeHydrationStages(st, s, h, capturedTranscript, startedAt, lagProbe, cliFirst, parseClaim);
  } finally {
    lagProbe.stop();
  }
}

async function runResumeHydrationStages(
  st: SessionStore,
  s: Session,
  h: ResumeHydration,
  capturedTranscript: SessionTranscript | undefined,
  startedAt: number,
  lagProbe: LoopLagProbe,
  cliFirst: CliFirst | undefined,
  parseClaim: ParentParseClaim | undefined
): Promise<void> {
  const stages: string[] = [];
  let stageT0 = Date.now();
  let stageCpu0 = hostCpuMs();
  const stage = (name: string): void => {
    const now = Date.now();
    const cpu = hostCpuMs();
    stages.push(`${name} ${now - stageT0}ms (cpu ${cpu - stageCpu0}ms)`);
    stageT0 = now;
    stageCpu0 = cpu;
  };
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
  const yieldToCli = async (started: Promise<void>): Promise<boolean> => {
    stage(`cli(${await afterResumeCliStarts(started)})`);
    if (!invalidated()) return true;
    abort("CLI の起動を待つ間にセッションが変化しました");
    return false;
  };

  if (cliFirst !== undefined && cliFirst.releaseAfterReads === undefined && !await yieldToCli(cliFirst.started)) return;
  let parentRecords: ParentRecordSource | undefined;
  let transcript: SessionTranscript;
  let history: SessionHistoryRead;
  let conversation: Awaited<ReturnType<typeof readConversationMessages>>;
  try {
    const turn = await parentRecordSource(h.filePath, h.readSet, parseClaim);
    parentRecords = turn.source;
    if (h.readSet !== undefined) stage("parse-turn");
    if (turn.timedOut) {
      output.appendLine(`[${s.title}] resume shared parse turn not reached after ${turn.waitedMs}ms; reading unshared`);
    }
    if (invalidated()) return abort("読み取りの順番待ちの間にセッションが変化しました");
    transcript = capturedTranscript ?? await readSessionTranscript(h.filePath, isInSessionStore, h.readSet, h.sessionId, parentRecords);
    if (capturedTranscript === undefined) stage("transcript");
    if (invalidated()) return abort("読み取り中にセッションが変化しました");
    history = await readSessionHistory(h.filePath, isInSessionStore, {
      ...(h.readSet === undefined ? {} : { resumeReadSet: h.readSet }),
      generationSessionId: h.sessionId,
      parentRecords,
    });
    stage("history");
    if (invalidated()) return abort("履歴読み取り中にセッションが変化しました");
    conversation = await readConversationMessages(h.filePath, isInSessionStore, h.readSet, h.sessionId, parentRecords);
    stage("conversation");
    if (invalidated()) return abort("会話履歴読み取り中にセッションが変化しました");
  } finally {
    // Ends this tab's turn in parentRecordSource; this async frame stays alive through the fold.
    parentRecords?.release();
  }

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
        `omittedMessages=${transcript.coverage.omittedMessageCount ?? 0}`
    );
  }
  const resolvedTitle = (await h.summary) ?? title;
  stage("title");
  if (invalidated()) return abort("タイトル解決中にセッションが変化しました");

  if (history.readError) {
    output.appendLine(`[${s.title}] resume history read failed: ${history.readError}`);
  } else if (history.subagentsReadError) {
    output.appendLine(`[${s.title}] resume history subagents/ read failed: ${history.subagentsReadError}`);
  } else if (history.coverage.summary !== "complete" || history.coverage.details !== "complete") {
    output.appendLine(`[${s.title}] resume history incomplete: malformed=${history.malformedLineCount}`);
  }
  if (history.coverage.ancestorUsageReadError !== undefined) {
    output.appendLine(
      `[${s.title}] resume history earlier-conversation record read failed (child usage not counted, ` +
        `reachesGeneration=${history.coverage.ancestorUsageReachesGeneration === true}): ${history.coverage.ancestorUsageReadError}`
    );
  }

  const restored = await readSubagentAgents(h.filePath, isInSessionStore);
  stage("subagents");
  if (invalidated()) return abort("階層読み取り中にセッションが変化しました");
  output.appendLine(
    `[${s.title}] resume subagents: meta=${restored.metaCount} malformed=${restored.malformedMetaCount} ` +
      `transcripts=${restored.transcriptsRead} readFailed=${restored.transcriptReadFailureCount} ` +
      `omitted=${restored.omittedTranscriptCount} bytes=${restored.bytesRead} ` +
      `${restored.elapsedMs}ms${restored.readError ? ` error=${restored.readError}` : ""}`
  );

  if (cliFirst?.releaseAfterReads !== undefined) {
    h.arrivalTimestamp ??= lastObservedTime(history.events);
    if (h.arrivalTimestamp !== undefined) {
      cliFirst.releaseAfterReads();
      if (!await yieldToCli(cliFirst.started)) return;
    }
  }

  const draft = createHydrationDraft(s);
  const sink: DraftEffectSink = {
    guardrailRefresh: false,
    guardrailTick: false,
    resolveOwner: null,
    commandsTouched: false,
    liveTurnCompleted: false,
  };
  const foldIntoDraft = (
    partial: NormalizedEventBody & { provenance?: EventProvenance }
  ): void => {
    applyDraftEffects(
      foldEventState(draft, partial, undefined, { suppressPost: true }).effects,
      sink
    );
  };
  const plan = restoredMessagePlan(messages, history);
  for (const m of plan.head) foldIntoDraft(replayedMessageEvent(m));
  const folded = await foldHistoryEvents(
    draft,
    history,
    (step, ev) => {
      applyDraftEffects(step.effects, sink);
      const uuid = restoredRecordUuid(ev.body);
      const following = uuid === undefined ? undefined : plan.after.get(uuid);
      if (uuid !== undefined && following !== undefined) {
        plan.after.delete(uuid);
        for (const m of following) foldIntoDraft(replayedMessageEvent(m));
      }
      return "continue";
    },
    invalidated
  );
  stage("fold");
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
      ...(history.coverage.ancestorUsageReadError !== undefined
        ? { ancestorUsageReadError: history.coverage.ancestorUsageReadError }
        : {}),
      ...(history.coverage.ancestorUsageReachesGeneration ? { ancestorUsageReachesGeneration: true as const } : {}),
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
  stage("evidence");

  draft.workModel = markSubagentGaps(draft.workModel, {
    unreadableAgentCount:
      restored.malformedMetaCount + restored.transcriptReadFailureCount + restored.omittedTranscriptCount,
    hierarchyIncomplete: restored.readError !== undefined || restored.malformedMetaCount > 0,
  });
  draft.workModel = markBackgroundUnconfirmed(draft.workModel, draft.lastEventTimestamp ?? Date.now());

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
  for (const m of [...[...plan.after.values()].flat(), ...plan.tail]) {
    foldIntoDraft(replayedMessageEvent(m));
    const pending = maybeYield();
    if (pending) {
      await pending;
      if (invalidated()) return abort("表示メッセージ整形中にセッションが変化しました");
    }
  }
  stage("replay");

  if (conversation.handoffEnvelope?.snapshot.forkSessionId === h.sessionId) {
    const sourceId = conversation.handoffEnvelope.snapshot.sourceSessionId;
    const sourceTitle = await sessionDisplayTitleOf(sourceId);
    if (invalidated()) return abort("引き継ぎ元の題名の読み取り中にセッションが変化しました");
    const restoredContextUsage = restoredHandoffContextUsage(extensionContext?.globalState.get(handoffContextUsageKey(h.sessionId)));
    const unreadableLineCount = restoredHandoffUnreadableLineCount(extensionContext?.globalState.get(handoffUnreadableLinesKey(h.sessionId)));
    const decisions = conversation.handoffEnvelope.decisions;
    s.handoffSource = {
      sessionId: sourceId,
      ...(sourceTitle !== undefined ? { title: sourceTitle } : {}),
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
  stage(`journal(${h.journal.length})`);
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
  const titleAtResolve = h.titleAtResolve;
  if (
    titleAtResolve !== undefined &&
    s.title === titleAtResolve.title &&
    s.autoTitled === titleAtResolve.autoTitled &&
    !holdsChosenTitle(s)
  ) {
    if (resolvedTitle) {
      adoptResumeTitle(s, resolvedTitle, h.sessionId);
    } else if (h.liveTitleCandidate) {
      s.title = displayTitleFromSummary(h.liveTitleCandidate, s.tabId);
      s.autoTitled = true;
    }
  }
  stage("commit");
  s.semantic.setRosterSources(h.sessionId, history.rosterSources ?? []);
  const snapshot = s.snapshot();
  stage("snapshot");
  st.post({ type: "tabCleared", tab: snapshot });
  stage("post");
  output.appendLine(
    `[${s.title}] resume 全文表示: ${Date.now() - startedAt}ms（${stages.join(" / ")}` +
      ` / loop lag 最大 ${lagProbe.maxLagMs()}ms 計 ${lagProbe.blockedMs()}ms）`
  );
  s.resuming = false;

  s.flushHydrationPosts(h);
  if (sink.guardrailRefresh) s.guardrailRunner.scheduleGuardrailRefresh();
  if (sink.guardrailTick) s.guardrailRunner.scheduleGuardrailTick();
  if (sink.resolveOwner !== null) {
    s.analysisStore.resolveOwnerFromAuthStatus(sink.resolveOwner.sessionId, sink.resolveOwner.logicalGeneration);
  }
  s.semantic.seedTranscriptTimeBuckets(h.filePath, h.sessionId, history, restored);
  s.semantic.scheduleTranscriptTimeBuckets();
  if (sink.liveTurnCompleted && !s.titleRefreshed && !s.titleRefreshing && !s.closed) {
    s.titleRefreshing = true;
    void refreshTabTitle(s);
  }
}

const RESUME_LOOP_LAG_TICK_MS = 20;
export interface LoopLagProbe {
  maxLagMs: () => number;
  blockedMs: () => number;
  stop: () => void;
}
export function startLoopLagProbe(onTick?: (lagMs: number, at: number) => void): LoopLagProbe {
  let maxLag = 0;
  let blocked = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - RESUME_LOOP_LAG_TICK_MS;
    if (lag > maxLag) maxLag = lag;
    if (lag > RESUME_LOOP_LAG_TICK_MS) blocked += lag;
    last = now;
    onTick?.(lag, now);
  }, RESUME_LOOP_LAG_TICK_MS);
  timer.unref?.();
  return { maxLagMs: () => maxLag, blockedMs: () => blocked, stop: () => clearInterval(timer) };
}

export function hostCpuMs(): number {
  const used = process.cpuUsage();
  return Math.round((used.user + used.system) / 1000);
}
