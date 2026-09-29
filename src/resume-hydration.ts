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
import { handoffDecisionLineCount } from "./handoff-envelope";
import { output } from "./host-context";
import {
  EventProvenance,
  HostToWebview,
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

// RESUME_CWD_SCAN_BYTES は SDK の getSessionInfo が読む先頭・末尾の窓に合わせる。
// 全文読みへ広げない: readRecordedSessionCwd は最初の描画より前に await される。
// 採る値は所在ディレクトリとの突合で決まり、履歴一覧の行の cwd と一致するとは限らない。
const RESUME_CWD_SCAN_BYTES = 64 * 1024;

// lastRelocatedCwd で移動先の記録を候補に含める。
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

// encodedProjectDirName は SDK の projects ディレクトリ名の符号化を写す。PROJECT_DIR_ENCODE_MAX を超える名前は
// SDK が別規則で符号化するので、一致と判定しない。
// 所在ディレクトリと食い違う cwd でも resume は記録を見つける。
// 食い違いは resume の成否ではなく、CLI が読む設定とツールの作業ディレクトリを変える。
const PROJECT_DIR_ENCODE_MAX = 200;
function encodedProjectDirName(cwd: string): string | undefined {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return encoded.length > PROJECT_DIR_ENCODE_MAX ? undefined : encoded;
}

// knownCwdMatchingStore で保存済みの推定を突合し、過去の誤推定を固定しない。
function knownCwdMatchingStore(knownCwd: string | undefined, filePath: string): string | undefined {
  if (knownCwd === undefined || knownCwd.length === 0) return undefined;
  return encodedProjectDirName(knownCwd) === basename(dirname(filePath)) ? knownCwd : undefined;
}

// ancestorMatchingStore は、記録の候補が起動後の移動先でも起動フォルダを探すために使う。
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

// encodedProjectDirName は非可逆なので、保存先の名前から起動フォルダを逆算しない。
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
    // 移動先を祖先で上書きしないよう、ancestorMatchingStore の適用を絞る。
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
  // replayJournalInto は到着時の verdict を使う。破棄した記録も境界の引き継ぎに必要。
  verdict: HydrationVerdict;
  displayed: boolean;
  clientToken?: string;
}

// hydrationCommitted を関数に分け、呼び出し側の代入による型の絞り込みが副作用後にも残るのを避ける。
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
  // liveSeqBase は失敗時の再配送と表示の仮採番を揃えるために保持する（src/session.ts#finalizeHydrationFailure）。
  liveSeqBase: number;
  acceptedSinceBuffering: number;
  // liveCommitCursor は src/session.ts#finalizeHydrationFailure の再実行でも未反映分だけを反映するために保持する。
  liveCommitCursor: number;
  liveTitleCandidate?: string;
  workPostDirty: boolean;
  semanticPostDirty: boolean;
  persistencePosts: Map<string, Extract<HostToWebview, { type: "analysisPersistenceState" }>>;
}

// ResumeOpenOutcome.tabPosted は新規タブ通知の有無。再利用では立たないので、成功判定に単独で使わない。
interface ResumeOpenOutcome {
  tabPosted: boolean;
  session: Session | undefined;
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
  // 同じ記録の連打でタブ枠を消費しないための inFlight 判定（verify-resume-hydration#Wmut-40、R-SES-03 / R-TAB-08）。
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
    // 旧 CLI の破棄を await すると最初の描画が破棄の完了を待つ（verify-resume-hydration#Wmut-39）。
    if (canReuse) {
      void s
        .disposeDetachedConversation(detached)
        .catch((e) => output.appendLine(`[${s.title}] 旧 CLI の破棄に失敗: ${String(e)}`));
    }
    let readSet: ResumeReadSet | undefined;
    // 起動フォルダの固定は src/conversation-lifecycle.ts#warmup より前に済ませる。
    let recordedCwd = knownCwdMatchingStore(req.knownCwd, req.filePath);
    if (recordedCwd !== undefined) {
      output.appendLine(`[${s.title}] resume cwd=${recordedCwd} source=known`);
    }
    try {
      readSetT0 = Date.now();
      readSet = await captureResumeReadSet(req.filePath);
      s.recordedModel = readSet.recordedModel;
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
    if (recordedCwd !== undefined && recordedCwd.length > 0) s.cwd = recordedCwd;
    captureDoneT = Date.now();
    if (s.closed || st.sessions.get(s.tabId) !== s) {
      s.resuming = false;
      return { tabPosted, session: undefined };
    }
    // preview の読み取りは初期表示を待たせない位置に保つ（verify-resume-hydration#FP-C10、R-TAB-08）。
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
    // src/session.ts#resumePreviewSnapshot を使い、表示専用の仮状態を履歴窓へ登録しない。
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
    if (s.closed || st.sessions.get(s.tabId) !== s) {
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
        // src/session.ts#resetLogicalSession で所有ごと消えた場合も、復元中の印を残さない。
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
    warmup(s);
    await runResumeHydration(st, s, hydration, transcript);
  } catch (e) {
    output.appendLine(`[${s.title}] resume 失敗: ${String(e)}`);
    // hydrationCommitted の成立後は失敗扱いへ戻さず、確定済みの表示を未確定にしない。
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
      // openResumedSession の inherit はホスト内部専用。受信したオブジェクトを展開して引き継がない。
      await openResumedSession(st, {
        sessionId: msg.sessionId,
        filePath: msg.filePath,
        ...(msg.intoTabId !== undefined ? { intoTabId: msg.intoTabId } : {}),
        activate: true,
      });
      break;
    }
    // runResumeHydration の再試行では、捕捉済みの読取境界を保つ（verify-resume-hydration#FP-C6）。
    case "resumeHydrationRetry": {
      const s = target!;
      const h = s.hydration;
      if (h === null || h.phase !== "failed" || s.resuming || s.closed) break;
      h.attemptId = randomUUID();
      h.phase = "loading";
      h.failureReason = undefined;
      h.buffering = true;
      h.logicalGeneration = s.logicalGeneration;
      // liveSeqBase を再試行時の採番へ合わせる。既に反映した範囲は liveCommitCursor で保持する。
      h.liveSeqBase = s.seq;
      h.acceptedSinceBuffering = 0;
      s.resuming = true;
      st.post({ type: "resumeHydrationState", tabId: s.tabId, phase: "loading" });
      try {
        await runResumeHydration(st, s, h);
      } catch (e) {
        output.appendLine(`[${s.title}] resume retry 失敗: ${String(e)}`);
        // hydrationCommitted の成立後は再試行でも失敗扱いへ戻さない。
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

// applyDraftEffects から集計結果を画面へ送らず、未確定の値を確定値として見せない。
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
        // unhandled の網羅性検査を残し、src/event-fold.ts#FoldEffect の追加を黙って捨てない。
        const unhandled: never = effect;
        output.appendLine(`[hydration] 未知の FoldEffect を破棄: ${JSON.stringify(unhandled)}`);
        break;
      }
    }
  }
}

// createHydrationDraft では src/event-fold.ts#foldEventState が破壊的に更新する容器を共有せず、中止時の変更を隔離する。
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
    // resuming による予約抑止を仮集計にも適用し、確定前の読み直しを避ける（src/event-fold.ts#foldEventState）。
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
  // src/session.ts#applyCommandList も候補を書き込むため、commandsTouched で記録の再生による更新と区別する。
  if (commandsTouched) s.commands = draft.commands;
  s.liveDelegationAgentIds = draft.liveDelegationAgentIds;
  s.liveDelegationRev = draft.liveDelegationRev;
  s.backgroundActivity = draft.backgroundActivity;
  s.workModel = draft.workModel;
  s.evidenceIndex = draft.evidenceIndex;
  s.events = draft.events;
}

// createHydrationYielder は重い記録と時計の分解能の両方に備えて中断機会を設ける。
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

// foldHistoryEvents に履歴の集約を集め、消費者の追加は visit で分岐する（verify-guardrail#GR-37、verify-guardrail#GR-37a）。
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

// replayJournalInto の到着順を時刻順へ並べ替えず、発言とターン境界の順序を保つ（R-TAB-09）。
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
      // replayJournalInto では、記録の採否と境界の引き継ぎを混同しない。
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
      // src/session.ts#resetLogicalSession で所有が消えた場合に限り、後続の復元が持つ実行中の印に触れず片付ける。
      if (s.hydration === null) s.resuming = false;
      return;
    }
    s.finalizeHydrationFailure(h, "cancelled", !s.closed && st.sessions.get(s.tabId) === s);
  };
  // src/session-transcript.ts#readSessionHistory の世代指定を、集計する履歴の切り捨てに使わない（R-HND-13）。
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
  // src/session-list-wiring.ts#sessionSummaryOf を通し、保存された改名を発言由来の名前で置き換えない。
  const resolvedTitle = (await sessionSummaryOf(h.sessionId)) ?? title;
  if (invalidated()) return abort("タイトル解決中にセッションが変化しました");
  // invalidated では利用者の改名を検出できないため、titleAtResolve と autoTitledAtResolve を別に控える（R-SES-05）。
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
  // src/work-model.ts#WorkCoverage の圧縮履歴は集約済みの値を保ち、読取器の初期値で上書きしない。
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
      // 原因を src/work-model.ts#WorkCoverage に残し、読み取り失敗を先頭の集計省略と混同させない（R-DSP-01）。
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
  // src/work-model.ts#markBackgroundUnconfirmed で、記録だけでは証明できない実行継続を未確認にする。
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

  // src/session-transcript.ts#isHandoffGenerationBoundary との条件の一致を保ち、前世代への導線を残す（R-HND-09）。
  if (conversation.handoffEnvelope?.snapshot.forkSessionId === h.sessionId) {
    const sourceId = conversation.handoffEnvelope.snapshot.sourceSessionId;
    const existingSource = [...st.sessions.values()].find(
      (other) => !other.closed && (other.resumeSessionId === sourceId || other.auth?.sessionId === sourceId)
    );
    s.handoffSource = {
      sessionId: sourceId,
      ...(existingSource?.title ? { title: existingSource.title } : {}),
      ...(conversation.handoffEnvelope.snapshot.compact !== undefined
        ? { compact: conversation.handoffEnvelope.snapshot.compact }
        : {}),
      utteranceCount: conversation.handoffEnvelope.userUtterances.length,
      ...(conversation.handoffEnvelope.decisions !== undefined
        ? { decisionCount: handoffDecisionLineCount(conversation.handoffEnvelope.decisions) }
        : {}),
      detailRunId: restoredHandoffRunId(h.sessionId),
    };
  }

  // createHydrationDraft の作成後に再起動していても、再生する記録の採番には現在の世代を使う。
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

  // commitHydrationDraft まで待機を挟まず、到着する境界イベントとの順序を保つ（R-TAB-09）。
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
  // ResumeHydration は再試行判定のために残すが、成功後の記録本文をタブの寿命まで保持しない。
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
  // titleAtResolve と autoTitledAtResolve の比較で、解決後の改名を上書きしない（R-SES-05）。
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
  // 読み直しを live 境界の有無で制限すると復元後のモデル別内訳が欠ける（verify-resume-hydration#Wmut-42、R-DSP-39 / R-TAB-07）。
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
