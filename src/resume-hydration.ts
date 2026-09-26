import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

import { randomUUID } from "node:crypto";
import { basename, dirname, win32 } from "node:path";

import { createBackgroundActivityState } from "./background-activity";
import { ClaudeConversation } from "./claudeHost";
import { registerConversationHistory, releaseConversationHistory } from "./conversation-history";
import { warmup } from "./conversation-lifecycle";
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

// 最終の単一 JS turn で fold してよい journal 残数の上限
const HYDRATION_SWITCHOVER_MAX = 64;
// drain の 1 バッチ上限（FP-1）。上限を外すと journal が長いときに
// 最終ターン以外でも event loop を長時間占有する
const HYDRATION_DRAIN_BATCH = 512;

// 記録から起動 cwd を推定する窓。SDK の getSessionInfo と同じ head / tail 64KB だけを見る
// （sdk.mjs の集約は最初に現れた cwd を採り、relocated レコードの relocatedCwd で上書きする）。
// 採る値は所在ディレクトリとの突合で決まるので、履歴一覧の行が見せる cwd と一致するとは限らない。
// 全文読みへ広げてはいけない: この読みは Phase 1 の最初の描画より前にある
const RESUME_CWD_SCAN_BYTES = 64 * 1024;

// SDK は relocated レコードで cwd を上書きする。落とすと、移動したプロジェクトで
// 履歴一覧の表示と起動 cwd が食い違う
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

// SDK は cwd を符号化して ~/.claude/projects/<符号化名> を組み立てる（sdk.mjs xu / nm。
// 200 字超は切り詰め＋ハッシュの別規則）。CLI 2.1.272 の resume は、所在ディレクトリと符号化が食い違う cwd
// （サブディレクトリで実測）でも id で記録を見つけた。食い違いは resume の成否ではなく、メモリ・CLAUDE.md・プロジェクト設定とツールの作業ディレクトリを変える。
// 逆変換（ディレクトリ名 → cwd）は禁止。候補を前向きに符号化して突き合わせるだけにする。
// 200 字超は判定せず undefined を返す（一致扱いにしない）
const PROJECT_DIR_ENCODE_MAX = 200;
function encodedProjectDirName(cwd: string): string | undefined {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return encoded.length > PROJECT_DIR_ENCODE_MAX ? undefined : encoded;
}

// 呼び出し元が知っている起動フォルダは、記録の所在ディレクトリへ符号化されるときだけ採る。
// 保存済みのタブ一覧は過去の誤推定をそのまま持ちうるので、突合せずに採ると誤りが固定される
function knownCwdMatchingStore(knownCwd: string | undefined, filePath: string): string | undefined {
  if (knownCwd === undefined || knownCwd.length === 0) return undefined;
  return encodedProjectDirName(knownCwd) === basename(dirname(filePath)) ? knownCwd : undefined;
}

// レコードの cwd はその時点のシェルの位置で `cd` に追従するが、所在ディレクトリは起動時の cwd のまま。
// 窓の中に起動時の cwd が 1 件も無いと候補がサブディレクトリになりうるので、親を辿って所在ディレクトリへ
// 符号化される祖先を探す。win32.dirname は \ と / の両方を区切りとして扱い、ドライブ根・UNC 共有根・"/" で不動点になる
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

// ファイル名（符号化済みプロジェクト名）は非可逆なので、候補は必ずレコードから読む。
// tail 側の先頭は行の途中から始まるが、壊れた JSON は foldTitleRecords と lastRelocatedCwd が読み飛ばす
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
    // この JSONL を実際に含むディレクトリへ符号化される候補が 1 つだけなら、それを採る（W-CWD-3d）。
    // 祖先の探索は relocated が無いときだけ（移動先を、その祖先で上書きしない）
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
  // v4 F-1: 世代違い・timestamp gate は到着時に一度だけ評価する。Phase 3 の fold は再評価しない。
  // dropped でも entry を積むのは meta.gapBoundaries を replay へ渡すため
  verdict: HydrationVerdict;
  // 表示 bypass 済み。失敗確定時の差分配送で再送しない（v4 F-2/F-10）
  displayed: boolean;
  // v4 F-5: 楽観バブルと確定 user_message を対応づける Webview 生成 token
  clientToken?: string;
}

// commit 済みの attempt を失敗確定させないための判定（v4 F-9）。関数に出しているのは、
// 呼び出し側が直前に phase へ代入しており、インライン比較だと型検査が narrow 後の
// literal と突き合わせて「重なりが無い」と誤検出するため
function hydrationCommitted(h: ResumeHydration): boolean {
  return h.phase === "complete";
}

export interface ResumeHydration {
  attemptId: string;
  logicalGeneration: number;
  sessionId: string;
  filePath: string;
  // 捕捉できなければ undefined。読取器は EOF まで読む契約へ縮退する
  readSet: ResumeReadSet | undefined;
  previewMessages: ResumePreviewMessage[];
  phase: ResumeHydrationPhase;
  failureReason?: string;
  buffering: boolean;
  journal: HydrationJournalEntry[];
  journalSeq: number;
  // 到着時 gate 用の直近観測時刻。foldEventState の draft.lastEventTimestamp と同じ役割
  arrivalTimestamp: number | undefined;
  // buffering 開始時点の Session.seq。失敗確定時の live commit がここから採番するので、
  // 表示 bypass の仮 seq を同じ基準で振ると失敗経路で本番 seq と一致する
  liveSeqBase: number;
  acceptedSinceBuffering: number;
  // live Session へ fold 済みの journal 件数。retry 再失敗時に二重 fold しない（v4 F-4）
  liveCommitCursor: number;
  liveTitleCandidate?: string;
  workPostDirty: boolean;
  semanticPostDirty: boolean;
  persistencePosts: Map<string, Extract<HostToWebview, { type: "analysisPersistenceState" }>>;
}

// tabPosted は「webview がこのタブを知っているか」。resume の例外を握った後でも Session を
// 返すので、呼び出し側はこれを見ないと「タブが無いのに成功」を送ってしまう
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
  // セッションストア外のパスは resume しない（analyzeSession と同じガード）
  if (!isInSessionStore(req.filePath)) {
    output.appendLine(`[drop] resume outside session store: ${req.filePath}`);
    void vscode.window.showWarningMessage(l10n.t("LAISORA: Logs outside the session store cannot be restored."));
    return { tabPosted, session: undefined };
  }
  // R-SES-03 / R-TAB-08: 同じセッションの resume が飛行中なら 2 度目以降の要求を捨てる。
  // 飛行中のタブは Phase 1 の tabCreated で既に前面にある（webview は activate:true の tabCreated を
  // 受けて setActiveTab する）ので、重ねてタブを作る意図は残っていない。放置すると
  // 連打ぶんだけタブ上限を食い、全部が同じセッションへ収束する。
  // 再利用判定（isUnusedSession）とタブ上限はこの後ろで従来どおり効く
  const inFlight = [...st.sessions.values()].find(
    (t) => t.resuming && t.resumeSessionId === req.sessionId
  );
  if (inFlight) {
    output.appendLine(`[${inFlight.title}] resume 重複要求を無視: ${req.sessionId}`);
    return { tabPosted, session: undefined };
  }
  // 何も使っていないタブ（起動直後の「会話 1」など）があれば、そこへ開いて
  // タブを増やさない。使用中なら従来どおり新タブを作る。
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
      // 既存タブを作り直す。/clear と同じ手順（会話の切り離し→履歴初期化→tabClearedで
      // Webview側のTabを同位置で再生成）を通し、そのうえで復元内容を流し込む
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
    // 作業ログから同じセッションの分析タブを開けるようにする
    s.resumeFilePath = req.filePath;
    s.ownerState = {
      kind: "pinned",
      ownerId: req.sessionId,
      logicalGeneration: s.logicalGeneration,
      source: "resume",
    };
    s.analysisStore.loadPersistedArtifactsFromStore();
    s.analysisStore.flushPendingPersistence();
    // FP-1: 旧 CLI の破棄は Phase 1 の描画と並行に走らせる。await すると最初の描画が
    // teardown の後ろへ回る（実測 563ms）。表示専用の preview は旧 CLI の生死に依存しない
    if (canReuse) {
      void s
        .disposeDetachedConversation(detached)
        .catch((e) => output.appendLine(`[${s.title}] 旧 CLI の破棄に失敗: ${String(e)}`));
    }
    // Phase 0（v4 F-1）: 親 JSONL の終端 offset・その時点の subagent 一覧・
    // 境界内の最新 timestamp を捕捉する。以後の hydration はこの read-set だけを読み、
    // 境界より後ろの行は live path だけが所有する（double count と torn line を構造的に除く）
    let readSet: ResumeReadSet | undefined;
    // AUDIT-02: 起動 cwd の決定は warmup より前に置く。後ろへ回すと、現在の workspace で
    // 別プロジェクトのセッションが起動してしまう
    let recordedCwd = knownCwdMatchingStore(req.knownCwd, req.filePath);
    if (recordedCwd !== undefined) {
      output.appendLine(`[${s.title}] resume cwd=${recordedCwd} source=known`);
    }
    try {
      readSetT0 = Date.now();
      readSet = await captureResumeReadSet(req.filePath);
      // Resume keeps the transcript model unless explicitly overridden (CLI resume behaviour).
      s.recordedModel = readSet.recordedModel;
      // 推定を read-set と同じ try に入れるのは、読み取り失敗の扱い（read-set 無しで続行）が同じであるため
      if (recordedCwd === undefined) {
        const recorded = await readRecordedSessionCwd(req.filePath);
        recordedCwd = recorded.cwd;
        output.appendLine(
          `[${s.title}] resume cwd=${recordedCwd ?? "(none)"} source=${recorded.source}` +
            ` malformedRelocation=${recorded.malformedRelocationLines}`
        );
      }
    } catch (error) {
      // 捕捉できない場合は read-set 無しで続行する（読取器は従来どおり EOF まで読む）。
      // 読取自体の失敗は下流の readError として利用者へ出る
      output.appendLine(`[${s.title}] resume read-set / cwd 捕捉に失敗: ${String(error)}`);
    }
    // 決めた起動 cwd をこのタブへ固定する。resolveSessionCwd は resumeFilePath のあるタブで
    // この値を使う（AUDIT-02）。値が無いときは固定せず、defaultCwd → workspace の解決順へ落ちる
    if (recordedCwd !== undefined && recordedCwd.length > 0) s.cwd = recordedCwd;
    captureDoneT = Date.now();
    if (s.closed || st.sessions.get(s.tabId) !== s) {
      s.resuming = false;
      return { tabPosted, session: undefined };
    }
    // FP-1 / R-TAB-08: preview の読取は最初の描画より後ろへ置く。hydration の install は
    // read-set 捕捉より前へ出せない（buffering 開始が parentEndOffset より早いと、
    // 境界内のイベントを history と journal の両方が所有して二重計上になる。v4 F-1）
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
    // Phase 1（FP-1 / FP-3）: 表示専用の早期 snapshot。events は空で
    // 履歴窓を登録しないので snapshot() を通してはならない
    st.post(
      canReuse
        ? { type: "tabCleared", tab: s.resumePreviewSnapshot(hydration) }
        : { type: "tabCreated", tab: s.resumePreviewSnapshot(hydration), activate: req.activate }
    );
    tabPosted = !canReuse;
    // 体感の内訳を出す。最初の描画までの時間は Phase 2 と別物で、遅い場合は
    // 準備区間（既存 CLI の破棄待ち等）が原因になりうる
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
      // hydration は install 済み。buffering のまま残すと isUnusedSession（resuming しか
      // 見ない）が buffering 中のタブを再利用先へ配る
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
        // v4 F-3: /clear（resetLogicalSession）で所有ごと消えた場合は誰も resuming を降ろさない
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
    // 読取が伸びたとき「読取そのものが遅い」のか「event loop が別の同期処理で
    // 塞がっていた」のかを次のログで切り分ける。lag が三桁以上なら後者
    output.appendLine(
      `[${s.title}] resume phase1: ${previewDoneT - resumeT0}ms` +
        `（準備 ${readSetT0 - resumeT0}ms / read-set ${captureDoneT - readSetT0}ms` +
        ` / preview ${previewDoneT - previewT0}ms / loop lag 最大 ${lagProbe.maxLagMs()}ms）`
    );
    lagProbe.stop();
    // post と warmup の間に hydration 処理を挟まない
    warmup(s);
    await runResumeHydration(st, s, hydration, transcript);
  } catch (e) {
    output.appendLine(`[${s.title}] resume 失敗: ${String(e)}`);
    // phase === "complete" は commit 済み。commit 後に走る flushHydrationPosts /
    // guardrail 予約 / owner 解決の例外で失敗確定させると、完全に合成できた session に
    // 再読み込み導線が出て状況の数字が未確定へ落ちる（v4 F-9）。resuming は
    // commit 時に降りているのでログだけ残す
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
    // return / 例外のどの抜け方でも tick を残さない
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
      // inherit は Host 内部（ハンドオフの fork）だけが付ける。msg を展開すると webview 由来の
      // キーがそのまま override へ届く
      await openResumedSession(st, {
        sessionId: msg.sessionId,
        filePath: msg.filePath,
        ...(msg.intoTabId !== undefined ? { intoTabId: msg.intoTabId } : {}),
        activate: true,
      });
      break;
    }
    // v4 F-4: CLI・Session・live journal を reset せず、最初に捕捉した
    // read-set のまま表示 hydration だけをやり直す
    case "resumeHydrationRetry": {
      const s = target!;
      const h = s.hydration;
      // v4 F-4: retry は失敗確定済みの attempt だけを対象にする。loading 中（別の
      // attempt が走っている）や complete（journal を解放済み）で受けると、live journal を
      // 二重 fold するか空の再合成でセッションを消す。v4 F-3 の取消条件と対をなす
      if (h === null || h.phase !== "failed" || s.resuming || s.closed) break;
      h.attemptId = randomUUID();
      h.phase = "loading";
      h.failureReason = undefined;
      h.buffering = true;
      h.logicalGeneration = s.logicalGeneration;
      // retry 開始後の entry だけを再び buffering する。liveCommitCursor 以前は
      // 既に live Session へ fold 済みで、成功時は draft 側で丸ごと採番し直す
      h.liveSeqBase = s.seq;
      h.acceptedSinceBuffering = 0;
      s.resuming = true;
      st.post({ type: "resumeHydrationState", tabId: s.tabId, phase: "loading" });
      try {
        await runResumeHydration(st, s, h);
      } catch (e) {
        output.appendLine(`[${s.title}] resume retry 失敗: ${String(e)}`);
        // commit 後（phase === "complete"）の例外で失敗確定させない。理由は resumeSession 側と同じ
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

// draft の fold から出た intent のうち、Session の状態を触らないもの（log）だけを即実行し、
// 残りは commit 後に一度だけ実行する。post / timer を draft 中に流すと部分集計が
// 確定値として画面へ出る（FP-2）
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
        // draft.resuming=true なので foldEventState はこの 2 つを出さない。Phase 3 の
        // catch-up は sink.liveTurnCompleted（title）と完了時の無条件の読み直し（time buckets）が担う
        break;
      case "post_events":
      case "schedule_work_model_post":
      case "schedule_semantic_model_post":
        // draft への fold は必ず suppressPost:true で呼ぶので到達しない。到達したなら
        // 部分集計が確定値として画面へ出る手前なので、黙って捨てずに記録する（FP-2）
        output.appendLine(`[hydration] draft fold が抑止対象の effect を出した: ${effect.type}`);
        break;
      default: {
        // FoldEffect に variant を足したら compile error になる。default: break へ戻すと
        // 新しい effect が draft 経路だけ黙って消える
        const unhandled: never = effect;
        output.appendLine(`[hydration] 未知の FoldEffect を破棄: ${JSON.stringify(unhandled)}`);
        break;
      }
    }
  }
}

// Phase 2: live Session を一切触らない fold 先。foldEventState が in-place で
// 書く容器（carriedGapBoundaries / liveGuardrailSignalIds / liveDelegationAgentIds / backgroundActivity /
// sessionFacts）は必ず新しい実体にする。参照を共有すると中止した hydration が live を壊す
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
    lastContextTotalTokens: s.lastContextTotalTokens,
    liveDelegationAgentIds: new Set<string>(),
    liveDelegationRev: s.liveDelegationRev,
    backgroundActivity: createBackgroundActivityState(),
    workModel: createWorkModelState(),
    evidenceIndex: createEvidenceIndex(),
    events: [],
    titleRefreshed: s.titleRefreshed,
    titleRefreshing: s.titleRefreshing,
    // title 付け直しと time-bucket 再読込の intent を draft fold から出させない
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
  s.lastContextTotalTokens = draft.lastContextTotalTokens;
  // commands は applyCommandList（supportedCommands）も書く。journal に commands_changed が
  // 無いのに draft 側で上書きすると warmup が取ってきた候補を捨てる
  if (commandsTouched) s.commands = draft.commands;
  s.liveDelegationAgentIds = draft.liveDelegationAgentIds;
  s.liveDelegationRev = draft.liveDelegationRev;
  s.backgroundActivity = draft.backgroundActivity;
  s.workModel = draft.workModel;
  s.evidenceIndex = draft.evidenceIndex;
  s.events = draft.events;
}

// v4 F-16 / FP-1: 履歴 fold の parse loop は無 yield なので、件数と経過時間の両方で
// event loop へ返す。14MB corpus の最大同期停止時間を有界にするのがこの縮退の目的で、
// 件数だけだと 1 件が重いとき、時間だけだと Date.now() の分解能で抜けが出る
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

// readSessionHistory().events を fold へ流す唯一のループ。GR-37 は history.events ループが
// 1 箇所であることを静的に固定し、GR-37a の変異注入もこの本体を的にする。consumer を足すときは
// visit で分岐させ、生ループを増やさない（増やすと gate（foldEventState 本体）を外した経路が
// 検査を素通りする）
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

// journal は arrival order のまま replay する。timestamp で history と再 merge しない
// （発言・ターン境界を取り違えない R-TAB-09 の ordering guard）
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
      // 破棄する entry でも境界は引き取る。捨てると委任待ちが longGap として
      // 過大報告される（foldEventState が早期 return より前に harvest するのと同じ理由）
      if (entry.meta?.gapBoundaries !== undefined && entry.meta.gapBoundaries.length > 0) {
        draft.carriedGapBoundaries.push(...entry.meta.gapBoundaries);
      }
      // timestampContractViolations へ載せるのは gate 由来の破棄だけ。世代違いの破棄を
      // 混ぜると契約違反件数が嘘になる
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

// Phase 2/3。Phase 1（read-set 捕捉・preview post・warmup）は resumeSession 側にある
async function runResumeHydration(st: SessionStore, s: Session, h: ResumeHydration, capturedTranscript?: SessionTranscript): Promise<void> {
  const invalidated = (): boolean =>
    s.closed ||
    st.sessions.get(s.tabId) !== s ||
    s.hydration !== h ||
    s.logicalGeneration !== h.logicalGeneration;
  // v4 F-3: 中止も同じ失敗 finalizer を通す。resuming を立てたまま残さない
  const abort = (why: string): void => {
    output.appendLine(`[${s.title}] resume 中止: ${why}`);
    if (s.hydration !== h) {
      // 新しい attempt が所有しているならその attempt が resuming を降ろす。
      // /clear（resetLogicalSession）で所有ごと消えた場合は誰も降ろさないのでここで降ろす
      if (s.hydration === null) s.resuming = false;
      return;
    }
    s.finalizeHydrationFailure(h, "cancelled", !s.closed && st.sessions.get(s.tabId) === s);
  };
  // generationSessionId は events を切らない。会話面が前世代の圧縮境界を落とすための印だけが付く（R-HND-13）
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
  // タブ名は SDK の解決器（customTitle > aiTitle > 最後の発言 > 最初の発言）へ委ねる。
  // readSessionTranscript.title は最初のユーザー発言なので、/rename した名前が
  // 反映されず、履歴一覧（listSessions 由来）とタブ名が食い違う
  const resolvedTitle = (await sessionSummaryOf(h.sessionId)) ?? title;
  if (invalidated()) return abort("タイトル解決中にセッションが変化しました");
  // R-SES-05: 解決後に /rename されたらそちらが新しい。renameTab は logicalGeneration を
  // 変えないので invalidated() では捕まらず、Phase 3 で無条件に適用すると利用者が付けた名前が
  // 消える。解決時点の値を控えて、変化していたときだけ適用を見送る
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
  // resume の WorkModel は provider transcript 由来であることを coverage に明示する。
  // history.coverage の取り込みは summary/details と件数系のみ:
  // phaseHistory/compactedPhaseCount は reducer が全量 fold 中に算出した値が正で、
  // transcript 側の初期値（complete/0）で上書きすると圧縮の事実が消える
  draft.workModel = {
    ...draft.workModel,
    coverage: {
      ...draft.workModel.coverage,
      ...(history.coverage.summary !== "complete" ? { summary: history.coverage.summary } : {}),
      ...(history.coverage.details !== "complete" ? { details: history.coverage.details } : {}),
      ...(history.coverage.omittedTranscriptCount
        ? { omittedTranscriptCount: history.coverage.omittedTranscriptCount }
        : {}),
      // 件数を落とすと画面には裸の「詳細: 直近のみ」だけが残り、何が何件なのかを
      // 知る手段が Output にしか無くなる
      ...(history.coverage.omittedMessageCount
        ? { omittedMessageCount: history.coverage.omittedMessageCount }
        : {}),
      ...(history.coverage.omittedToolCount
        ? { omittedToolCount: history.coverage.omittedToolCount }
        : {}),
      // summary を倒した原因も運ぶ。summary だけだと画面は「先頭の作業は集計外」と断定する（R-DSP-01）
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
  // 決定性検証の入力。live のホットパスでは計算しない
  draft.evidenceIndex = { ...draft.evidenceIndex, hash: evidenceIndexHash(draft.evidenceIndex) };

  const restored = await readSubagentAgents(h.filePath, isInSessionStore);
  if (invalidated()) return abort("階層読み取り中にセッションが変化しました");
  // 読めなかった meta / transcript を概要へ出す。ログだけに残すと、階層が欠けたまま
  // 「概要: セッション全体」と表示される
  draft.workModel = markSubagentGaps(draft.workModel, {
    unreadableAgentCount:
      restored.malformedMetaCount + restored.transcriptReadFailureCount + restored.omittedTranscriptCount,
    hierarchyIncomplete: restored.readError !== undefined || restored.malformedMetaCount > 0,
  });
  // history はストリームが閉じている。通知未観測の背景は実行継続を証明できないので stale にする
  // （裁定H-1 を L1 にも当てる。放置すると復元したタブの背景が永久に「実行中」で残る）
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
  // 読めなかったことを利用者へ出す。黙って空のタブを出すと完全な resume に見える
  if (transcript.readError || history.readError) {
    const err = transcript.readError ?? history.readError;
    // 途中まで読めた分は fold 済み。「履歴なし」と書けるのは 1 件も読めなかったときだけ
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
  // 画面へ出す会話メッセージの uuid を古い順に控える（件数ではなく識別子で起点を決める）
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

  // 会話ページングの登録を Phase 3 より前に済ませる（Phase 2 / FP-C7）
  const conversation = await readConversationMessages(h.filePath, isInSessionStore, h.readSet, h.sessionId);
  if (invalidated()) return abort("会話履歴読み取り中にセッションが変化しました");

  // カードを出す条件は会話面を切る述語と同じ（R-HND-09）。片方だけが真になると、
  // 前世代が消えたのに到達する導線が無いタブができる
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

  // v4 F-3 は hydration 中の CLI 再起動（s.generation の bump）を継続扱いにする。journal の
  // live event は再起動後のプロセスに属するので、履歴 prefix の世代ではなく現在の世代で採番する。
  // seq は draft が単一カウンタで連番するので `${generation}:${seq}` は配列内で一意のまま
  draft.generation = s.generation;

  // v4 F-16: 残数が 64 以下になるまで yielded drain。最終ターンだけを有界にする
  let cursor = 0;
  let dropped = 0;
  while (h.journal.length - cursor > HYDRATION_SWITCHOVER_MAX) {
    const end = Math.min(h.journal.length - HYDRATION_SWITCHOVER_MAX, cursor + HYDRATION_DRAIN_BATCH);
    dropped += replayJournalInto(draft, h.journal, cursor, end, sink);
    cursor = end;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (invalidated()) return abort("journal 整理中にセッションが変化しました");
  }

  // ここから単一 JS turn。await を置かないこと（JS callback を挟むと境界イベントを
  // 取り違える — R-TAB-09 / v4 F-16）
  dropped += replayJournalInto(draft, h.journal, cursor, h.journal.length, sink);
  draft.timestampContractViolations += dropped;
  h.buffering = false;
  h.phase = "complete";
  h.liveCommitCursor = h.journal.length;
  commitHydrationDraft(s, draft, sink.commandsTouched);
  s.restoredAgents = restored.agents;
  s.hydrationCoverageUnconfirmed = false;
  s.conversationAnchorUuids = anchors;
  // v4 F-4 の retry 契約が要求するのは hydration オブジェクトの存続だけで、成功後の journal を
  // 読む経路は無い（snapshot は phase!=="complete" のときしか journal を見ない）。
  // 保持し続けると全 entry の payload がタブの寿命ぶん残る
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
  // v4 F-15: 履歴側 resolver の結果を先に一度だけ適用し、解決不能なときだけ live 候補を使う。
  // R-SES-05: hydration 中に /rename されていたら利用者が明示した名前のほうが新しいので触らない
  if (s.title === titleAtResolve && s.autoTitled === autoTitledAtResolve) {
    if (resolvedTitle) {
      s.title = displayTitleFromSummary(resolvedTitle, h.sessionId);
      s.autoTitled = true;
    } else if (h.liveTitleCandidate) {
      s.title = displayTitleFromSummary(h.liveTitleCandidate, s.tabId);
      s.autoTitled = true;
    }
  }
  // 完全 snapshot だけが snapshot() を通り、凍結済みの event 配列を一度だけ履歴窓へ登録する
  st.post({ type: "tabCleared", tab: s.snapshot() });
  s.resuming = false;
  // ---- 単一 JS turn ここまで ----

  s.flushHydrationPosts(h);
  if (sink.guardrailRefresh) s.guardrailRunner.scheduleGuardrailRefresh();
  if (sink.guardrailTick) s.guardrailRunner.scheduleGuardrailTick();
  if (sink.resolveOwner !== null) {
    s.analysisStore.resolveOwnerFromAuthStatus(sink.resolveOwner.sessionId, sink.resolveOwner.logicalGeneration);
  }
  // live 境界の有無に依らず一度読み直す。モデル別の内訳（mainByModel）は読み直しだけが作るので、
  // 境界を条件にすると再起動後に新しいターンが来ない復元タブは内訳を持たない（R-DSP-39 / R-TAB-07）。
  // buffer 中に抑止した live 境界もこれで回収される
  s.semantic.scheduleTranscriptTimeBuckets();
  if (sink.liveTurnCompleted && !s.titleRefreshed && !s.titleRefreshing && !s.closed) {
    s.titleRefreshing = true;
    void refreshTabTitle(s);
  }
}

// Phase 1 が伸びたとき、原因が読取そのものか「event loop が別の同期処理に占有されていたか」
// かを次のログで切り分けるための実測。tick の遅れの最大値だけを持つ
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
