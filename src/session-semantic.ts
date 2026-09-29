import { getLaisoraConfiguration } from "./claude-settings";
import { projectPlanUsage, summarizeMainTokens } from "./plan-usage";
import * as l10n from "@vscode/l10n";
import { deriveFailureSummary } from "./exec-log-marks";
import { readSessionExternalRuns, type ExternalRunRecord, type SessionExternalRuns } from "./orchestration-external";
import { deriveRoleSummary, type ExternalRunsCoverage } from "./role-summary";
import {
  emptyRosterEvidence,
  hasInjectedRoster,
  mergeRosterEvidence,
  readRosterEvidence,
  writeRosterEvidence,
  type RosterEvidence,
} from "./roster-evidence";

import { projectAnalysisFactsView, projectSummaryAnalysis } from "./analysis-facts-view";
import type { SemanticEvidenceIndex } from "./evidence-index";
import { output } from "./host-context";
import { deriveL3 } from "./l3-analysis";
import { deriveDivergences, type DivergenceReport } from "./l3-divergence";
import type { LlmDiagnosticsAudience } from "./llm-report";
import type { PersonalBaseline } from "./analysis";
import { cachedPersonalBaseline } from "./personal-baseline";
import { projectDivergences, projectSemanticModel } from "./projection";
import {
  type AnalysisPanelView,
  type L3ReportPayload,
  type RestoredAgent,
  type SemanticModelPayload,
  type TimeBucketsCoverage,
  type WorkModelPayload,
  projectWorkModel,
} from "./protocol";
import { deriveSemanticModel, type SemanticModel } from "./semantic-model";
import { deriveSessionFacts, type SessionFacts, type SessionFactsAccumulator } from "./session-facts";
import { inspectorSessionFile, isInSessionStore } from "./session-files";
import type { Session } from "./extension";
import type { LearningFacts } from "./learning";
import type { SessionStore } from "./store-surfaces";
import { overlayLiveTimeBucketState, type TimeBucketView } from "./time-buckets";
import { childSpansOf, readTranscriptTimeBucketsWithCoverage } from "./transcript-time-buckets";
import type { WorkCoverage, WorkModelState } from "./work-model";

// semantic model は毎回の導出が全ノード再計算＋hash（再計算コスト未実測）
// のため workModel と同じ 120ms では回さない。送信時点の最新を導出するので取りこぼしはない
export const SEMANTIC_MODEL_POST_INTERVAL_MS = 1000;
// 概要の再送間隔。イベント1件ごとに payload を作り直すと、reducer の構造共有で稼いだ分を
// シリアライズで使い切る。常に送信時点の最新を送るので取りこぼしにはならない
const WORK_MODEL_POST_INTERVAL_MS = 120;
// ターン境界の直後は JSONL の末尾レコードがまだ書かれていないことがある。境界イベントから少し置いて読む
const TRANSCRIPT_TIME_BUCKETS_DELAY_MS = 1500;

// 設定の生死は send 時に毎回読む（ConversationSnapshot.semanticView の明示と、off 時に payload を
// 送らない裁定の両方をここで満たす）。try は検証ハーネスの偽 vscode が
// getConfiguration を持たないため（欠けていたら既定 on）
export function semanticViewEnabled(): boolean {
  try {
    return (
      getLaisoraConfiguration().get<boolean>("workLog.semanticView", true) !==
      false
    );
  } catch {
    return true;
  }
}

// 既定オン（package.json と一致）。catch 分岐（getConfiguration 不在＝偽 vscode）は
// 検証ハーネスが実クライアントを構築して課金するのを防ぐため false のまま
export function llmAnalysisEnabled(): boolean {
  try {
    return (
      getLaisoraConfiguration().get<boolean>("workLog.llmAnalysis", true) ===
      true
    );
  } catch {
    return false;
  }
}

export function llmDiagnosticsAudience(): LlmDiagnosticsAudience {
  try {
    return getLaisoraConfiguration()
      .get<boolean>("workLog.llmAnalysisDiagnostics", false) === true
      ? "opt-in-diagnostics"
      : "off";
  } catch {
    return "off";
  }
}


function externalOf(conv: Session["conversation"]): ExternalRunRecord[] {
  return (conv?.orchestrationRuns ?? []).filter((run): run is ExternalRunRecord => run.kind === "external");
}

// runId が同じ記録は 1 件に数える（前側を残す）。runId の無い記録は突き合わせられないので全て残す
function mergeExternalRuns(first: readonly ExternalRunRecord[], second: readonly ExternalRunRecord[]): ExternalRunRecord[] {
  const seen = new Set<string>();
  const out: ExternalRunRecord[] = [];
  for (const run of [...first, ...second]) {
    if (run.runId !== undefined) {
      if (seen.has(run.runId)) continue;
      seen.add(run.runId);
    }
    out.push(run);
  }
  return out;
}

// 裁定A1/M4: L3 の導出はこの1点だけ（webview 側で数え直さない）。
// evidence は model と同じ fold のものを渡す（longGap 入力は evidence 側にしかない）
function deriveL3Payload(
  model: SemanticModel,
  evidence: SemanticEvidenceIndex,
  divergenceReport: DivergenceReport,
  facts?: SessionFacts,
  learning?: LearningFacts
): L3ReportPayload {
  const analysis = deriveL3(model, evidence);
  const divergences = projectDivergences(divergenceReport);
  return {
    analysis,
    divergences,
    ...(facts !== undefined ? { facts: projectAnalysisFactsView(facts, divergenceReport, learning) } : {}),
  };
}

// 失敗の分類は「どの段で落ちたか」で決める。detail（例外文・絶対パスを含みうる）は
// Output だけに出し、画面へは label だけを出す
interface DerivationFailure {
  stage: "model" | "metrics";
  detail: string;
}

export function derivationFailureLabel(stage: DerivationFailure["stage"]): string {
  switch (stage) {
    case "model":
      return l10n.t("Could not build the work state from the record");
    case "metrics":
      return l10n.t("Could not build the analysis metrics from the record");
  }
}

// workModel / evidenceIndex / sessionFacts は EventFoldDraft（event-fold.ts）の必須メンバーなので
// Session 側に残る。semanticMemo はそれらを参照同一性で比較する（値比較へ変えると memo が
// 毎回 hit して古い L3 を返し続ける）
export class SessionSemantic {
  private workModelPostTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticModelPostTimer: ReturnType<typeof setTimeout> | null = null;
  // 自セッションの JSONL から導出した時間 4 区分（U-1 案 b）。live のターン境界は継承時刻なので fold 由来の
  // 値は inherited になる。ターン境界のたびと resume の hydration 完了時に JSONL を読み直して差し替える（R-DSP-15 / R-TAB-07）
  transcriptTimeBuckets: TimeBucketView | undefined = undefined;
  transcriptTimeBucketsCoverage: TimeBucketsCoverage | undefined = undefined;
  private transcriptTimeBucketsTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptTimeBucketsReading = false;
  transcriptTimeBucketsDirty = false;
  // memo 化するのは LLM を載せる前の base payload だけ。attach 済みを memo すると
  // 設定 on/off を鍵に含める必要が生じ、設定を変えた後に古い payload を返しうる
  semanticMemo: {
    workModel: WorkModelState;
    evidenceIndex: SemanticEvidenceIndex;
    streamOpen: boolean;
    liveDelegationRev: number;
    // 導出は sessionFacts と baseline も読む（deriveSessionFacts）。鍵に入れないと
    // GUARDRAIL_ONLY_EVENT_KINDS のイベントで sessionFacts だけが進んだとき
    // memo が hit し続け、古い L3 を返す。foldSessionFacts は毎回新しいオブジェクトを
    // 返すので参照比較で足りる
    sessionFacts: SessionFactsAccumulator;
    learningKey: string | undefined;
    baseline: PersonalBaseline | null;
    restoredAgents: RestoredAgent[];
    derivation: {
      model: SemanticModel;
      payload: SemanticModelPayload;
      divergenceReport?: DivergenceReport;
    } | undefined;
    // derivation が欠けた理由。memo に同居させないと、再導出しない 2 回目以降で理由が消え、
    // 例外由来の欠落が「記録がまだありません」へ倒れる（R-DSP-01）
    derivationError: DerivationFailure | null;
  } | null = null;
  // 直近の導出が model 段で例外だったか。真の間、workModel の射影と semantic の再送に
  // semanticDerivationFailed を立てる。成功した payload には Host がフィールドを付けず、
  // webview は届いた coverage で置換するので、成功の送信で申告は消える（R-DSP-01）
  semanticDerivationFailedLast = false;
  // 最後に webview へ送れた semantic。導出が失敗している間はこれに stale を付けて送り直す。
  // logicalGeneration が違えば（/clear・resume 後）旧セッションの表示なので送らない（W-SD-3）
  lastGoodSemanticPayload: { payload: SemanticModelPayload; logicalGeneration: number } | undefined;

  constructor(
    private readonly host: Session,
    private readonly store: SessionStore
  ) {}

  clearSemanticModelPostTimer(): void {
    if (this.semanticModelPostTimer !== null) {
      clearTimeout(this.semanticModelPostTimer);
      this.semanticModelPostTimer = null;
    }
    this.clearTranscriptTimeBucketsTimer();
  }

  clearTranscriptTimeBucketsTimer(): void {
    if (this.transcriptTimeBucketsTimer !== null) {
      clearTimeout(this.transcriptTimeBucketsTimer);
      this.transcriptTimeBucketsTimer = null;
    }
  }

  // 毎イベントで読まない（14MB の transcript を秒単位で舐める）。ターン境界と hydration 完了に限り、連続する予約は 1 回にまとめる
  scheduleTranscriptTimeBuckets(): void {
    if (this.host.closed) return;
    if (this.transcriptTimeBucketsReading) {
      this.transcriptTimeBucketsDirty = true;
      return;
    }
    if (this.transcriptTimeBucketsTimer !== null) return;
    this.transcriptTimeBucketsTimer = setTimeout(() => {
      this.transcriptTimeBucketsTimer = null;
      void this.refreshTranscriptTimeBuckets();
    }, TRANSCRIPT_TIME_BUCKETS_DELAY_MS);
  }

  private async refreshTranscriptTimeBuckets(): Promise<void> {
    const file = inspectorSessionFile(this.host);
    if (file === null) return;
    const logicalGeneration = this.host.logicalGeneration;
    this.transcriptTimeBucketsReading = true;
    let view: TimeBucketView | undefined;
    let coverage: TimeBucketsCoverage | undefined;
    try {
      const read = await readTranscriptTimeBucketsWithCoverage(file, isInSessionStore, {
        conversationId: this.host.tabId,
        generation: this.host.generation,
      });
      view = read.view;
      coverage = read.coverage;
    } catch (error) {
      output.appendLine(`[${this.host.title}] transcript time buckets failed: ${String(error)}`);
      coverage = { sessionReadError: String(error) };
    } finally {
      this.transcriptTimeBucketsReading = false;
    }
    // /clear・resume で論理セッションが変わっていたら旧セッションの値を載せない
    if (!this.host.closed && logicalGeneration === this.host.logicalGeneration) {
      if (coverage !== undefined) {
        output.appendLine(`[${this.host.title}] transcript time buckets degraded: ${JSON.stringify(coverage)}`);
      }
      // 読めなかった事実は view の有無に依らず webview へ運ぶ（欠落が消えたときも載せ直す）
      const coverageChanged = JSON.stringify(coverage) !== JSON.stringify(this.transcriptTimeBucketsCoverage);
      this.transcriptTimeBucketsCoverage = coverage;
      if (view !== undefined) this.transcriptTimeBuckets = view;
      if (view !== undefined || coverageChanged) this.scheduleSemanticModelPost();
    }
    // 旧世代の読みを捨てるときも回収する。読みの最中に新しい世代が予約した分は dirty にしか残らない
    if (this.transcriptTimeBucketsDirty) {
      this.transcriptTimeBucketsDirty = false;
      this.scheduleTranscriptTimeBuckets();
    }
  }

  // 失敗した hydration の後は live だけの集計しか無い。retry 成功まで
  // 「セッション全体の確定値」として出さない（R-TAB-07）
  projectedWorkModel(): WorkModelPayload {
    const model = projectWorkModel(this.host.workModel, this.host.restoredAgents);
    const time = this.host.evidenceIndex.timeBuckets;
    const block = time.blocks[time.blocks.length - 1];
    if (block) {
      model.planContext = { blockId: block.blockId, text: block.text, start: block.start,
        end: Math.max(block.start, time.lastAt ?? block.start), running: this.host.workModel.turnActive ||
          this.host.streamOpen() && model.phases.some(phase => phase.runningCount > 0 || (phase.backgroundRunningCount ?? 0) > 0) };
    }
    // 状況の導出が例外で欠けたら、semantic を送れない間も workModel 側で申告する。
    // 申告しないと状況タブは古い表示のまま「現在」として残る（R-DSP-01。G-COV-8 / W-SD-1 / W-SD-2）
    const semanticDerivationFailed: WorkCoverage["semanticDerivationFailed"] | undefined =
      this.semanticDerivationFailedLast && semanticViewEnabled()
        ? this.hasLastGoodSemanticForThisGeneration()
          ? "stale"
          : "unavailable"
        : undefined;
    if (!this.host.hydrationCoverageUnconfirmed && semanticDerivationFailed === undefined) return model;
    return {
      ...model,
      coverage: {
        ...model.coverage,
        ...(this.host.hydrationCoverageUnconfirmed
          ? {
              summary: "prefix-truncated" as const,
              details: "prefix-truncated" as const,
              hydrationUnconfirmed: "failed" as const,
            }
          : {}),
        ...(semanticDerivationFailed !== undefined ? { semanticDerivationFailed } : {}),
      },
    };
  }

  scheduleWorkModelPost(): void {
    // hydration 中は dirty 化だけ。部分 draft を確定値として露出させない（FP-2）
    if (this.host.resuming && this.host.hydration !== null) {
      this.host.hydration.workPostDirty = true;
      return;
    }
    if (this.workModelPostTimer !== null) return;
    this.workModelPostTimer = setTimeout(() => {
      this.workModelPostTimer = null;
      this.store.post({ type: "planUsage", tabId: this.host.tabId,
        state: projectPlanUsage(this.host.sessionFacts.planUsage, this.host.evidenceIndex.timeBuckets.blocks) });
      this.store.post({
        type: "workModel",
        tabId: this.host.tabId,
        model: this.projectedWorkModel(),
      });
    }, WORK_MODEL_POST_INTERVAL_MS);
  }

  // MED-4: init/restoreVisible/tabCreated/tabCleared/tabRestored/設定変更が snapshot 経由で全タブ分を
  // 同期導出するため memoize する。鍵は導出の全入力（workModel/evidenceIndex は参照同一性 —
  // fold/reducer は無変更時に同一オブジェクトを返す。streamOpen と live 集合版数は
  // イベント無しでも変わる入力なので別途持つ）。revision 基準にしないのは、evidence だけが
  // 変わるイベントで revision が進む保証を確認できていないため
  semanticDerivation(): {
    model: SemanticModel;
    payload: SemanticModelPayload;
    divergenceReport?: DivergenceReport;
  } | undefined {
    const streamOpen = this.host.streamOpen();
    const learning = this.host.learningFacts?.();
    const learningKey = JSON.stringify(learning);
    const memo = this.semanticMemo;
    if (
      memo !== null &&
      memo.workModel === this.host.workModel &&
      memo.evidenceIndex === this.host.evidenceIndex &&
      memo.streamOpen === streamOpen &&
      memo.liveDelegationRev === this.host.liveDelegationRev &&
      memo.sessionFacts === this.host.sessionFacts &&
      memo.learningKey === learningKey &&
      memo.baseline === cachedPersonalBaseline &&
      memo.restoredAgents === this.host.restoredAgents
    ) {
      return memo.derivation;
    }
    let derivation: {
      model: SemanticModel;
      payload: SemanticModelPayload;
      divergenceReport?: DivergenceReport;
    } | undefined;
    let derivationError: DerivationFailure | null = null;
    try {
      const model = deriveSemanticModel(this.host.workModel, this.host.evidenceIndex, {
        // CLI 再起動（世代交代）で変わる conversationId ではなく tabId を渡す。
        // 安定範囲は同一 extension host プロセス内（= 同一 webview セッションの revision 間）
        // まで。Goal nodeId（goal:<id>）の同一性追跡に必要なのはこの範囲で足りる
        conversationId: this.host.tabId,
        streamOpen,
        liveDelegationAgentIds: this.host.liveDelegationAgentIds,
        childSpans: childSpansOf(this.host.restoredAgents),
      });
      let payload = projectSemanticModel(model);
      let divergenceReport: DivergenceReport | undefined;
      // L3 の失敗で L2b 表示ごと落とさない（l3 未着 = 縮退表示）
      try {
        divergenceReport = deriveDivergences(model);
        const facts = deriveSessionFacts(this.host.sessionFacts, this.host.evidenceIndex, cachedPersonalBaseline, {
          eventLogTrimmed: (this.host.workModel.coverage.droppedEventCount ?? 0) > 0,
        });
        payload = { ...payload, l3: deriveL3Payload(model, this.host.evidenceIndex, divergenceReport, facts, learning) };
      } catch (error) {
        derivationError = { stage: "metrics", detail: String(error) };
        output.appendLine(`[${this.host.title}] L3 derivation failed: ${derivationError.detail}`);
      }
      derivation = { model, payload, divergenceReport };
    } catch (error) {
      derivationError = { stage: "model", detail: String(error) };
      output.appendLine(`[${this.host.title}] SemanticModel derivation failed: ${derivationError.detail}`);
      derivation = undefined;
    }
    this.semanticMemo = {
      workModel: this.host.workModel,
      evidenceIndex: this.host.evidenceIndex,
      streamOpen,
      liveDelegationRev: this.host.liveDelegationRev,
      sessionFacts: this.host.sessionFacts,
      learningKey,
      baseline: cachedPersonalBaseline,
      restoredAgents: this.host.restoredAgents,
      derivation,
      derivationError,
    };
    this.semanticDerivationFailedLast = derivationError?.stage === "model";
    return derivation;
  }

  semanticBasePayload(): SemanticModelPayload | undefined {
    return this.semanticDerivation()?.payload;
  }

  // 導出が例外で欠けたのか、まだ何も無いのかを分けるための理由（R-DSP-01）。
  // semanticDerivation() が memo を埋めるので、必ず先に通してから読む
  semanticDerivationFailure(): DerivationFailure | null {
    this.semanticDerivation();
    return this.semanticMemo?.derivationError ?? null;
  }

  semanticModelPayload(): SemanticModelPayload | undefined {
    const base = this.semanticBasePayload();
    // JSONL 由来の 4 区分があれば数値をそれで差し替える。fold 由来の数値（live は inherited）と混ぜない（R-TAB-07）。
    // 開いているターン・動作中のサブエージェントの状態だけは fold（live）のものを残す（R-DSP-20 / R-DSP-06）
    const overlaid =
      base !== undefined && this.transcriptTimeBuckets !== undefined
        ? {
            ...base,
            timeBuckets:
              base.timeBuckets !== undefined
                ? overlayLiveTimeBucketState(this.transcriptTimeBuckets, base.timeBuckets)
                : this.transcriptTimeBuckets,
          }
        : base;
    const withCoverage =
      overlaid !== undefined && this.transcriptTimeBucketsCoverage !== undefined
        ? { ...overlaid, timeBucketsCoverage: this.transcriptTimeBucketsCoverage }
        : overlaid;
    const payload = this.attachLlm(withCoverage, base);
    if (payload === undefined) return undefined;
    const work = projectWorkModel(this.host.workModel, this.host.restoredAgents);
    const conv = this.host.conversation;
    return {
      ...payload,
      roleSummary: deriveRoleSummary({
        phases: work.phases,
        unlinkedAgents: work.unlinkedAgents,
        ...this.externalRuns(conv),
        rosterEvidence: this.rosterEvidence(),
      }),
      failureSummary: deriveFailureSummary(payload.execLogFindings ?? [], work.phases),
      summaryAnalysis: projectSummaryAnalysis(payload.execLogFindings, payload.l3?.llm),
      mainTokens: summarizeMainTokens(this.host.sessionFacts.planUsage),
    };
  }

  private externalRunsCache: {
    ownerId: string;
    conversation: Session["conversation"];
    persisted: readonly ExternalRunRecord[];
    coverage: ExternalRunsCoverage | undefined;
  } | undefined;

  // 会話の記録はその CLI プロセスの分だけ。再開・CLI の作り直しの後は、保存域の runs.jsonl から同じセッションの記録を
  // 読み戻して足す（R-ANL-24）。読むのは owner か会話が変わったときに一度だけ、非同期で。読み終えたら送り直す。
  // 読み終えるまでは前の会話が持っていた分で埋める（CLI を作り直した直後に一覧から消えないように）
  externalRuns(conv: Session["conversation"]): { externalRuns: ExternalRunRecord[]; externalRunsCoverage?: ExternalRunsCoverage } {
    const live = externalOf(conv);
    const owner = this.host.ownerState?.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
    const directory = this.store.orchestrationRunsDirectory;
    if (owner === undefined || directory === undefined) return { externalRuns: live };
    let cache = this.externalRunsCache;
    if (cache?.ownerId !== owner || cache.conversation !== conv) {
      const carried = cache?.ownerId === owner ? mergeExternalRuns(externalOf(cache.conversation), cache.persisted) : [];
      const next = { ownerId: owner, conversation: conv, persisted: carried, coverage: cache?.ownerId === owner ? cache.coverage : undefined };
      this.externalRunsCache = cache = next;
      this.externalRunsRead = readSessionExternalRuns(directory, owner)
        .catch((error: unknown): SessionExternalRuns => {
          output.appendLine(`[${this.host.title}] [orchestration-runs] read failed: ${String(error)}`);
          return { runs: [], unreadableLines: 0, readError: true };
        })
        .then((read) => {
          if (this.externalRunsCache !== next || this.host.closed) return;
          next.persisted = mergeExternalRuns(read.runs, next.persisted);
          next.coverage = read.unreadableLines > 0 || read.readError ? { unreadableLines: read.unreadableLines, readError: read.readError } : undefined;
          this.scheduleSemanticModelPost();
        });
    }
    const externalRuns = mergeExternalRuns(live, cache.persisted);
    return cache.coverage !== undefined ? { externalRuns, externalRunsCoverage: cache.coverage } : { externalRuns };
  }

  private externalRunsRead: Promise<void> = Promise.resolve();

  flushExternalRuns(): Promise<void> {
    return this.externalRunsRead;
  }

  private rosterEvidenceCache: { ownerId: string; persisted: RosterEvidence; serialized: string } | undefined;
  private rosterEvidenceWrite: Promise<void> = Promise.resolve();

  // 保存済みの記録（セッション ID ごと）と、この会話が起動時・起動フックで記録したものの和。
  // 注入の記録が一度も無いセッションには書かない（注入していない起動の空記録だけでファイルを作らない）
  rosterEvidence(): RosterEvidence {
    const live = this.host.conversation?.rosterEvidence ?? emptyRosterEvidence();
    const owner = this.host.ownerState?.kind === "pinned" ? this.host.ownerState.ownerId : undefined;
    const directory = this.store.rosterEvidenceDirectory;
    if (owner === undefined || directory === undefined) return live;
    if (this.rosterEvidenceCache?.ownerId !== owner) {
      const persisted = readRosterEvidence(directory, owner, (line) => output.appendLine(`[${this.host.title}] ${line}`));
      this.rosterEvidenceCache = { ownerId: owner, persisted, serialized: JSON.stringify(persisted) };
    }
    const cache = this.rosterEvidenceCache;
    const merged = mergeRosterEvidence(cache.persisted, live);
    const serialized = JSON.stringify(merged);
    if (serialized !== cache.serialized && hasInjectedRoster(merged)) {
      cache.persisted = merged;
      cache.serialized = serialized;
      this.rosterEvidenceWrite = this.rosterEvidenceWrite
        .then(() => writeRosterEvidence(directory, owner, merged))
        .catch((error: unknown) => {
          // 次の導出で書き直す。記録はメモリに残るので、この起動中の役割付けは変わらない
          cache.serialized = "";
          output.appendLine(`[${this.host.title}] [roster-evidence] write failed: ${String(error)}`);
        });
    }
    return merged;
  }

  flushRosterEvidence(): Promise<void> {
    return this.rosterEvidenceWrite;
  }

  // webview へ送る semantic。導出が失敗している間は最後に送れたものに stale を付けて送り直す。
  // 送らないと状況タブは古い表示のまま「現在」として残る（R-DSP-01。W-SD-1）。
  // 一度も成功していないなら undefined（呼び出し側は workModel の unavailable で申告する）
  semanticModelPostPayload(): SemanticModelPayload | undefined {
    const payload = this.semanticModelPayload();
    if (payload !== undefined) {
      this.lastGoodSemanticPayload = { payload, logicalGeneration: this.host.logicalGeneration };
      return payload;
    }
    const last = this.lastGoodSemanticPayload;
    if (!this.semanticDerivationFailedLast || last === undefined || last.logicalGeneration !== this.host.logicalGeneration) {
      return undefined;
    }
    const llm = this.attachLlm(last.payload, last.payload)?.l3?.llm;
    const attached = llm && "attached" in llm ? llm.attached : undefined;
    const staleLlm = attached && llm ? { ...llm, attached: { ...attached, freshness: "stale" as const } } : llm;
    return {
      ...last.payload,
      summaryAnalysis: projectSummaryAnalysis(undefined, staleLlm),
      coverage: { ...last.payload.coverage, base: { ...last.payload.coverage.base, semanticDerivationFailed: "stale" } },
    };
  }

  private hasLastGoodSemanticForThisGeneration(): boolean {
    return this.lastGoodSemanticPayload?.logicalGeneration === this.host.logicalGeneration;
  }

  // l3.llm を書く唯一の場所。base と base.l3 へ代入しないこと: memo が返すのは
  // 分析を検証したその同一オブジェクトなので、代入すると過去に配った payload まで
  // 遡って書き換わり、同一性で守っている「検証済みの組」が壊れる
  // 鮮度判定は freshnessBase（semanticBasePayload の memo）との同一性で行う。表示用の base は読み直しの重ね・
  // 被覆の付記で複製になりうるので、それで比べると分析後に何も変わっていなくても「更新あり」になる
  private attachLlm(
    base: SemanticModelPayload | undefined,
    freshnessBase: SemanticModelPayload | undefined
  ): SemanticModelPayload | undefined {
    if (base?.l3 === undefined || freshnessBase === undefined) return base;
    if (!llmAnalysisEnabled()) {
      return { ...base, l3: { ...base.l3, llm: { state: "disabled" } } };
    }
    let panelView: AnalysisPanelView;
    if (this.host.llmRun !== null) {
      const attached = this.host.analysisStore.buildAttachedAnalysisView(freshnessBase);
      panelView = attached ? { state: "running", attached } : { state: "running" };
    } else if (this.host.lastAttemptFailedReason !== null) {
      const attached = this.host.analysisStore.buildAttachedAnalysisView(freshnessBase);
      panelView = attached
        ? { state: "attemptFailed", reason: this.host.lastAttemptFailedReason, attached }
        : { state: "attemptFailed", reason: this.host.lastAttemptFailedReason };
    } else if (this.host.persistedArtifacts.length > 0) {
      const attached = this.host.analysisStore.buildAttachedAnalysisView(freshnessBase);
      panelView = attached ? { state: "attached", attached } : { state: "idle" };
    } else {
      panelView = { state: "idle" };
    }
    return { ...base, l3: { ...base.l3, llm: panelView } };
  }

  scheduleSemanticModelPost(): void {
    if (this.host.resuming && this.host.hydration !== null) {
      this.host.hydration.semanticPostDirty = true;
      return;
    }
    if (this.semanticModelPostTimer !== null) return;
    this.semanticModelPostTimer = setTimeout(() => {
      this.semanticModelPostTimer = null;
      if (!semanticViewEnabled()) return;
      const model = this.semanticModelPostPayload();
      if (model !== undefined) {
        this.store.post({ type: "semanticModel", tabId: this.host.tabId, model });
      } else if (this.semanticDerivationFailedLast) {
        // 一度も semantic を送れていない失敗は workModel の coverage（unavailable）で申告する
        this.store.post({ type: "workModel", tabId: this.host.tabId, model: this.projectedWorkModel() });
      }
    }, SEMANTIC_MODEL_POST_INTERVAL_MS);
  }
}
