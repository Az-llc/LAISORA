// 状況パネル（概要 / グラフ / 分析 / 実行ログ の 4 タブ）と概要タブ・分析タブの描画。
// 値は Host の payload（WorkModelPayload / SemanticModelPayload.timeBuckets / execLogMarks）の写しだけを描き、
// ツール名から操作分類を起こしたり、作業を帰属させたり、時間を再計算したりはしない。
import type {
  HostToWebview,
  SemanticModelPayload,
  TimeBucketsCoverage,
  WorkModelPayload,
  WorkTaskItemView,
} from "../protocol";
import type { AnalysisReport } from "../analysis";
import type { AgentSpanView, BackgroundTaskSpanView, RequestBlockView, TimeBucketView } from "../time-buckets";
import type { ExecLogFindingView, ExecLogMark } from "../exec-log-marks";
import { renderAnalysisView } from "./analysis-view";
import { renderAnalysisFactsView } from "./analysis-facts-view";
import { vscode } from "./dom";
import { formatDateTime, formatDuration, clock, dayClock } from "./format";
import { termSpan, type TermKey } from "./term";
import { WorkGraph, coverageRows, NO_WORK_SUMMARY_TEXT, agentLabel, type GraphScrollPort } from "./work-graph";
import { AgentInspector } from "./agent-inspector";
import * as l10n from "@vscode/l10n";

type LlmRunStateMessage = Extract<HostToWebview, { type: "llmAnalysisRunState" }>;
type LlmRunProgress = NonNullable<LlmRunStateMessage["progress"]>;
type LlmRunFailure = NonNullable<LlmRunStateMessage["failure"]>;

// tab.ts#handoffElapsedText と同じ表記規則。あちらは module-private で共有できない
function llmElapsedText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? l10n.t("{0}s", total) : l10n.t("{0}m {1}s", Math.floor(total / 60), total % 60);
}


export type WorkViewMode = "summary" | "graph" | "analysis" | "log";

const WORK_VIEW_MODES: WorkViewMode[] = ["summary", "graph", "analysis", "log"];

// 終了セッションの流れは直近だけを見せ、残りは「前の N 往復を表示」で開く
const FLOW_LIMIT = 14;
// 30 文字以下の発言には開く印を出さない。開いても何も増えない（R-DSP-05）
const SHORT_TEXT_MAX = 30;
// 状態 C（スクリプトで何も拾えなかったとき）の文言。所有者が決めた文言なので言い換えない
const NO_FINDINGS_TEXT = l10n.t(
  "Script analysis found no classifiable failures and no operations matching the rule table. This does not mean LLM analysis would find no candidates either; a script can only count events that fit predefined patterns."
);

// 見出しと注記は exec-log-marks.ts の実装（FAILURE_RULES / CONVENTION_RULES）が支えられる範囲だけを言う。
// 規則表は手選び 3 件の固定配列で、利用者の CLAUDE.md を読まない。
// 検出の仕組みを変えたら文も直す（R-DSP-01: 実体より強い主張をしない）
const FINDING_SECTIONS: readonly { family: "failure" | "convention"; title: string; note: string }[] = [
  {
    family: "failure",
    title: l10n.t("Failure classification"),
    note: l10n.t("Observations of lines where a tool execution returned an error, classified by rules over fixed patterns in the result body. Failures that match no rule are not counted. This is not a determination of cause, so the fix target is attached as a candidate"),
  },
  {
    family: "convention",
    title: l10n.t("Observed convention violations"),
    note: l10n.t("Observations of whether tool inputs matched the three conventions written in the rule table. CLAUDE.md and rule bodies are not read, so other decisions written there are not judged"),
  },
];

function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function div(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

// 「作業の流れ」の行の日付（月日のみ）。年は行の title（フルの日時）に持たせる
function monthDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}


function sameMarks(a: readonly ExecLogMark[] | undefined, b: readonly ExecLogMark[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((m, i) => m.toolUseId === b[i].toolUseId && m.findingAnchor === b[i].findingAnchor && m.label === b[i].label);
}

// 分析タブのサブタブ。既定はスクリプト分析
type AnalysisSubtab = "script" | "ai";
const ANALYSIS_SUBTABS: readonly AnalysisSubtab[] = ["script", "ai"];

export class WorkOverview {
  private readonly switchEl: HTMLElement;
  private readonly rootEl: HTMLElement;
  private readonly coverageEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly analysisEl: HTMLElement;
  // セッションの実測（R-DSP-15 / R-DSP-16 / R-DSP-17）
  private readonly measuredEl: HTMLElement;
  // スクリプト分析の所見（実行ログの印の飛び先。R-TAB-06）
  private readonly findingsEl: HTMLElement;
  private readonly logHeadEl: HTMLElement;
  private readonly logSumEl: HTMLElement;
  // 第3タブの主区画（L3）と参考区画（統計分析レポート。裁定A4）を別の入れ物にする。
  // renderAnalysisView は渡した要素を空にするので、同じ要素へ両方を描くと片方が消える
  private readonly l3El: HTMLElement;
  private readonly referenceHeadEl: HTMLElement;
  private readonly referenceEl: HTMLElement;
  private readonly tabs: Record<WorkViewMode, HTMLButtonElement>;
  private readonly graph: WorkGraph;
  private readonly inspector: AgentInspector;
  private mode: WorkViewMode = "summary";
  private payload: WorkModelPayload | undefined;
  private semanticPayload: SemanticModelPayload | undefined;
  // true=on / false=明示off / undefined=未着（protocol.ts ConversationSnapshot.semanticView と同じ3値）
  private semanticView: boolean | undefined;
  private hasReferenceReport = false;
  private llmAnalysisEnabled: boolean | undefined;
  private turnRunning = false;
  private analysisSub: AnalysisSubtab = "script";
  get analysisSubtab(): AnalysisSubtab { return this.analysisSub; }
  private readonly subTabs: Record<AnalysisSubtab, HTMLButtonElement>;
  private readonly subSwitchEl: HTMLElement;
  private readonly scriptEl: HTMLElement;
  private readonly llmEl: HTMLElement;
  private readonly l3LlmEl: HTMLElement;
  private llmRunning = false;
  // Host が観測した経過と、それを受け取った時点の tick 時刻。表示は前者に tick の進みを足す。
  // 自前の時計を読まない（G-54）。受け取った時点で tick を 1 度も見ていなければ起点が無いので、
  // 外挿せず Host の値をそのまま出す
  private llmProgress: (LlmRunProgress & { receivedAt: number | undefined }) | undefined;
  private llmFailure: LlmRunFailure | undefined;
  private llmRunLineEl: HTMLElement | undefined;
  // Host が実行を開始しなかった理由（llmAnalysisRunState.refusal）。未実行であって失敗ではないので
  // llmFailure とも LLM 面の attemptFailed とも別に持つ（R-ANL-11）
  private llmRefusal: string | undefined;
  // 要求した分析（スクリプト分析・所見からの操作）を Host が返せなかった理由（analysisFailed.reason）
  private analysisFailure: string | undefined;
  private analysisFailureEl: HTMLElement | undefined;
  private summaryDirty = false;
  private summaryRenderCount = 0;
  private l3Dirty = false;
  private renderedAnalysisValueKey: string | undefined;
  private renderedAnalysisEvidenceKey: string | undefined;
  private lastTickMs: number | undefined;
  private flowExpanded = false;
  private readonly openBlocks = new Set<string>();
  private execLogMarks: ExecLogMark[] | undefined;
  private execLogFindings: ExecLogFindingView[] | undefined;
  // 印を貼り終えた行。全行を毎イベント貼り直さない
  private readonly decoratedToolUseIds = new Set<string>();
  // 要約（R-DSP-25）。undefined = 未生成（1 つ目のプロンプトを出す）。
  // saveFailed=true = 生成できたが永続化に失敗（「保存済み」と表示してはならない — R-DSP-01）
  private sessionSummary: { text: string; model: string; saveFailed?: boolean } | undefined;
  private summaryRunning = false;
  // 直近の要約実行が終えられなかった理由（sessionSummary.failure）。既存の要約は消さない（R-DSP-25）
  private summaryFailure: string | undefined;
  // 前回 onAnalysisModeChange へ通知した値。applyMode は syncVisibility 経由で毎イベント
  // バッチ呼ばれるため、無条件発火だと非アクティブタブのイベントでも共有 chrome の
  // 再描画（updateComposerLock→refreshChrome）が走る（レビューT4-r1 M1）
  private notifiedAnalysisActive: boolean | undefined;

  constructor(
    private readonly workEl: HTMLElement,
    // .log-head 内のタブバー置き場（tab.ts が用意する）。ここへ入れることで、作業ログを
    // どこまでスクロールしてもタブバーが見える。workEl の中へ戻すと包含ブロックの下端に
    // 縛られ、最下部でヘッダの裏へ押し上げられる
    private readonly switchHost: HTMLElement,
    private readonly tabId: string,
    // コンポーザ無効化は main.ts の責務のまま、可視状態の通知だけをここが担う（裁定A1:
    // コールバック注入。work-overview → main の import 辺を作らない）
    private readonly onAnalysisModeChange?: (analysisActive: boolean) => void,
    private readonly toolEvidence?: {
      has(toolUseId: string): boolean;
      navigate(toolUseId: string): void;
    },
    // サブタブ切替の通知。setMode の先頭（隠す前）で呼び、返った関数を applyMode の後（当て直し）に呼ぶ。
    // スクロール位置の退避・復元は tab.ts の責務（R-TAB-06）
    private readonly onWorkViewChange?: (prev: WorkViewMode, next: WorkViewMode) => (() => void) | void,
    // 往復の行から会話面の該当ターンへ飛ぶ導線。飛び先が無い行にはボタンを出さない
    private readonly conversation?: {
      has(turnId: string): boolean;
      navigate(turnId: string): void;
    },
    // グラフの窓が #logs の可視帯を測り、行の増減で scrollTop を補正する口（tab.ts が用意する）
    private readonly graphScrollPort?: GraphScrollPort,
    private readonly onAnalysisSubChange?: () => void
  ) {
    this.switchEl = document.createElement("div");
    this.switchEl.className = "work-view-switch";
    this.switchEl.setAttribute("role", "tablist");
    this.switchEl.setAttribute("aria-label", l10n.t("Status views"));

    this.rootEl = document.createElement("div");
    this.rootEl.className = "work-overview";
    this.rootEl.id = `wo-panel-${this.tabId}`;
    this.rootEl.setAttribute("role", "tabpanel");
    this.rootEl.setAttribute("aria-labelledby", `wotab-summary-${this.tabId}`);
    this.rootEl.tabIndex = 0;

    this.coverageEl = div("wo-coverage");
    this.bodyEl = div("wo-body");
    this.rootEl.append(this.coverageEl, this.bodyEl);

    this.analysisEl = document.createElement("div");
    // analysis-view は分析レポート内部（表・findings等）の既存スタイルを効かせるため
    this.analysisEl.className = "work-analysis analysis-view";
    this.analysisEl.id = `wa-panel-${this.tabId}`;
    this.analysisEl.setAttribute("role", "tabpanel");
    this.analysisEl.setAttribute("aria-labelledby", `wotab-analysis-${this.tabId}`);
    this.analysisEl.tabIndex = 0;
    this.measuredEl = div("wa-head");
    this.findingsEl = div("wa-findings");
    this.l3El = div("l3-view");
    this.l3LlmEl = div("l3-view l3-view-llm");
    this.referenceHeadEl = span("l3-reference-head", l10n.t("Reference: statistical analysis ("));
    this.referenceHeadEl.append(termSpan("Baseline"), document.createTextNode(l10n.t(" comparison)")));
    this.referenceEl = div("l3-reference");
    this.referenceEl.appendChild(span("wo-empty", l10n.t("Statistical analysis has not been run yet (use the Analyze button in the history panel 🕘).")));
    this.syncReferenceVisibility();
    // 実測ヘッダの下にサブタブ 2 枚。同時に見えるのは片方だけ
    this.subSwitchEl = document.createElement("div");
    this.subSwitchEl.className = "wa-tabs";
    this.subSwitchEl.setAttribute("role", "tablist");
    this.subSwitchEl.setAttribute("aria-label", l10n.t("Analysis type"));
    this.scriptEl = div("wa-sub");
    this.scriptEl.id = `wa-sub-script-${this.tabId}`;
    this.scriptEl.setAttribute("role", "tabpanel");
    this.llmEl = div("wa-sub");
    this.llmEl.id = `wa-sub-ai-${this.tabId}`;
    this.llmEl.setAttribute("role", "tabpanel");
    this.subTabs = {
      script: this.buildSubTab("script", l10n.t("Script analysis"), this.scriptEl.id),
      ai: this.buildSubTab("ai", l10n.t("LLM Analysis"), this.llmEl.id),
    };
    this.scriptEl.setAttribute("aria-labelledby", this.subTabs.script.id);
    this.llmEl.setAttribute("aria-labelledby", this.subTabs.ai.id);
    this.subSwitchEl.append(this.subTabs.script, this.subTabs.ai);
    this.scriptEl.append(this.findingsEl, this.l3El);
    // 分析の入口は「LLM 分析を実行」1 個だけで、LLM 分析側の先頭（af-llm-section の先頭・R-ANL-11）。
    // 結果は必ずその下に生えるので、押した位置から読み始められる（R-ANL-12）
    this.llmEl.append(this.l3LlmEl, this.referenceHeadEl, this.referenceEl);
    this.analysisEl.append(this.measuredEl, this.subSwitchEl, this.scriptEl, this.llmEl);
    this.applyAnalysisSub();

    // 実行ログの上部にまとめ（指摘 N 件）を置く容器。行は tab.ts が組むので、ここは印の集計だけ
    this.logHeadEl = div("wl-head");
    this.logSumEl = div("wl-sum");
    this.logHeadEl.appendChild(this.logSumEl);
    this.logHeadEl.hidden = true;

    this.inspector = new AgentInspector(this.tabId, () => this.graph.onInspectorClosed());
    this.graph = new WorkGraph(this.tabId, this.inspector, this.graphScrollPort);

    this.tabs = {
      summary: this.buildTab("summary", l10n.t("Summary"), this.rootEl.id),
      graph: this.buildTab("graph", l10n.t("Graph"), this.graph.rootEl.id),
      analysis: this.buildTab("analysis", l10n.t("Analysis"), this.analysisEl.id),
      log: this.buildTab("log", l10n.t("Execution log"), this.workEl.id),
    };
    this.switchEl.append(this.tabs.summary, this.tabs.graph, this.tabs.analysis, this.tabs.log);

    // 検査が DOM 経由で直接呼ぶ外部駆動点。本番の印は updateSemantic が渡す
    (this.rootEl as HTMLElement & { laisoraSetExecLogMarks?: (marks: ExecLogMark[] | undefined) => void })
      .laisoraSetExecLogMarks = (marks) => this.setExecLogMarks(marks);
  }

  private buildTab(mode: WorkViewMode, label: string, controls: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "work-view-tab";
    btn.id = `wotab-${mode}-${this.tabId}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", controls);
    btn.textContent = label;
    btn.onclick = () => this.setMode(mode);
    btn.addEventListener("keydown", (e) => {
      const at = WORK_VIEW_MODES.indexOf(this.mode);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 1 : WORK_VIEW_MODES.length - 1;
        this.setMode(WORK_VIEW_MODES[(at + step) % WORK_VIEW_MODES.length], true);
      } else if (e.key === "Home") {
        e.preventDefault();
        this.setMode(WORK_VIEW_MODES[0], true);
      } else if (e.key === "End") {
        e.preventDefault();
        this.setMode(WORK_VIEW_MODES[WORK_VIEW_MODES.length - 1], true);
      }
    });
    return btn;
  }

  private buildSubTab(sub: AnalysisSubtab, label: string, controls: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wa-tab";
    btn.id = `watab-${sub}-${this.tabId}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", controls);
    btn.textContent = label;
    btn.onclick = () => this.setAnalysisSub(sub);
    btn.addEventListener("keydown", (e) => {
      const at = ANALYSIS_SUBTABS.indexOf(this.analysisSub);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 1 : ANALYSIS_SUBTABS.length - 1;
        this.setAnalysisSub(ANALYSIS_SUBTABS[(at + step) % ANALYSIS_SUBTABS.length], true);
      } else if (e.key === "Home") {
        e.preventDefault();
        this.setAnalysisSub(ANALYSIS_SUBTABS[0], true);
      } else if (e.key === "End") {
        e.preventDefault();
        this.setAnalysisSub(ANALYSIS_SUBTABS[ANALYSIS_SUBTABS.length - 1], true);
      }
    });
    return btn;
  }

  setAnalysisSub(sub: AnalysisSubtab, moveFocus = false): void {
    const changed = this.analysisSub !== sub;
    this.analysisSub = sub;
    this.applyAnalysisSub();
    if (moveFocus) this.subTabs[sub].focus();
    if (changed) this.onAnalysisSubChange?.();
  }

  private applyAnalysisSub(): void {
    for (const sub of ANALYSIS_SUBTABS) {
      const btn = this.subTabs[sub];
      btn.classList.toggle("active", sub === this.analysisSub);
      btn.setAttribute("aria-selected", String(sub === this.analysisSub));
      btn.tabIndex = sub === this.analysisSub ? 0 : -1;
    }
    this.scriptEl.hidden = this.analysisSub !== "script";
    this.llmEl.hidden = this.analysisSub !== "ai";
  }


  // 作業ログの先頭へ差し込む。tab.ts は workEl へ append し続けるので、切替は
  // 「自分の要素以外を hidden にする」形にする
  mount(): void {
    this.workEl.insertBefore(this.logHeadEl, this.workEl.firstChild);
    this.workEl.insertBefore(this.rootEl, this.logHeadEl.nextSibling);
    this.workEl.insertBefore(this.graph.rootEl, this.rootEl.nextSibling);
    this.workEl.insertBefore(this.analysisEl, this.graph.rootEl.nextSibling);
    this.switchHost.appendChild(this.switchEl);
    this.applyMode();
  }

  // 値が同じでも描き直す。webview はボタン押下時に局所的に「分析中…」へ切り替えるため、
  // Host の running:false（拒否時を含む）を捨てるとボタンが張り付いたままになる
  setLlmRunning(running: boolean, progress?: LlmRunProgress, failure?: LlmRunFailure, refusal?: string): void {
    this.llmRunning = running;
    if (running) {
      this.llmFailure = undefined;
      this.llmRefusal = undefined;
      this.analysisFailure = undefined;
      // receivedAt は進捗行の経過表示専用。TimeBucketView / nowMs() へ渡さない（TB-7 がこの行と読み手の集合を固定）
      if (progress !== undefined) this.llmProgress = { ...progress, receivedAt: Date.now() };
    } else {
      this.llmProgress = undefined;
      this.llmFailure = failure;
      this.llmRefusal = refusal;
    }
    this.l3Dirty = true;
    if (this.mode === "analysis") this.renderAnalysisPanel();
  }

  // 要求した分析を Host が返せなかった理由を、結果が出るはずだった LLM 分析側の区画に出す。
  // 既存の結果は消さない。次の実行開始（setLlmRunning(true)）か次の結果（setAnalysis）で消える
  showAnalysisFailure(reason: string): void {
    this.analysisFailure = reason;
    this.setAnalysisSub("ai");
    this.setMode("analysis");
    this.l3Dirty = true;
    this.renderAnalysisPanel();
  }

  // live=true の行だけを読み上げ対象にする。進行の行は 1 秒ごとに書き替わるので、
  // 読み上げ対象にすると秒が変わるたびに読み上げが走る。
  // place="tail" は不可用の一般文言（llm-report.ts が組み立て llm-action-view.ts が描く）の
  // 後ろへ回すため。実行ボタンの隣に置くと、見出しより先に詳細が出る
  private llmRunLineText(): { text: string; live: boolean; place: "run" | "tail" } | null {
    // 未実行は実行ボタンの隣に理由だけを出す。結果面（attemptFailed / unavailable）は触らない
    if (this.llmRefusal !== undefined) {
      return { live: true, place: "run", text: l10n.t("Not run: {0}", this.llmRefusal) };
    }
    const failure = this.llmFailure;
    if (failure !== undefined) {
      const elapsed = llmElapsedText(failure.elapsedMs);
      if (failure.limit === undefined) {
        return {
          live: true,
          place: "tail",
          text: l10n.t(
            "Stopped at call {0}/{1} — elapsed {2} · {3} completed",
            failure.attemptedCalls,
            failure.plannedCalls,
            elapsed,
            failure.completedCalls
          ),
        };
      }
      const limit =
        failure.limit === "per_call" ? l10n.t("LLM response inactivity timeout") : l10n.t("total timeout");
      return {
        live: true,
        place: "tail",
        text: l10n.t(
          "Stopped at call {0}/{1} — {2} · elapsed {3} · {4} completed",
          failure.attemptedCalls,
          failure.plannedCalls,
          limit,
          elapsed,
          failure.completedCalls
        ),
      };
    }
    const progress = this.llmProgress;
    if (progress === undefined) return null;
    const since =
      progress.receivedAt === undefined || this.lastTickMs === undefined
        ? 0
        : Math.max(0, this.lastTickMs - progress.receivedAt);
    const elapsed = llmElapsedText(progress.elapsedMs + since);
    const text = progress.stage === "merge"
      ? l10n.t("Combining analysis results · Elapsed {0}", elapsed)
      : progress.stage === "slice" && progress.sliceCount !== undefined && progress.sliceCount > 1 && progress.sliceIndex !== undefined
        ? l10n.t("Analyzing log sections · {0}/{1} · Elapsed {2}", progress.sliceIndex, progress.sliceCount, elapsed)
        : l10n.t("Analyzing log · Elapsed {0}", elapsed);
    return { live: false, place: "run", text };
  }

  // renderAnalysisFactsView が l3LlmEl を空にするので、受信時に足さず描き直しのたびに足す。
  // 置き場の探索に querySelector を使わないのは、クラス選択子の字面が
  // check-protocol-guards S5-T2-D4（概要が LLM 面を名指ししない）の的に誤って当たるため。
  // D4 はコメントも数えるので、この注記自体もその字面を書けない
  private renderLlmRunLine(): void {
    this.llmRunLineEl?.remove();
    this.llmRunLineEl = undefined;
    const line = this.llmRunLineText();
    if (line === null) return;
    const el = document.createElement("span");
    el.className = this.llmRefusal !== undefined ? "llm-run-note llm-run-progress llm-run-refusal" : "llm-run-note llm-run-progress";
    if (line.live) el.setAttribute("role", "status");
    el.textContent = line.text;
    const box = line.place === "run" ? this.l3LlmEl.getElementsByClassName("llm-run")[0] : undefined;
    (box ?? this.l3LlmEl).appendChild(el);
    this.llmRunLineEl = el;
  }

  // renderAnalysisFactsView が l3LlmEl を空にするので、描き直しのたびに足す（renderLlmRunLine と同じ理由）
  private renderAnalysisFailureLine(): void {
    this.analysisFailureEl?.remove();
    this.analysisFailureEl = undefined;
    if (this.analysisFailure === undefined) return;
    const el = document.createElement("div");
    el.className = "llm-run-note analysis-failure";
    el.setAttribute("role", "alert");
    el.textContent = this.analysisFailure;
    this.l3LlmEl.appendChild(el);
    this.analysisFailureEl = el;
  }

  setTurnState(state: "idle" | "running" | "interrupting"): void {
    this.setActive(state !== "idle");
  }

  // 「動いている」はタブのドットと同じ述語（ターン中・バックグラウンド・サブエージェントのみ、を含む）。
  // turnState だけで決めると、サブエージェントだけが動いている間に「終了」と出る（R-SES-02 / R-DSP-20）
  setActive(running: boolean): void {
    if (this.turnRunning === running) return;
    this.turnRunning = running;
    this.l3Dirty = true;
    this.summaryDirty = true;
    this.graph.setRunning(running);
    if (this.mode === "analysis") this.renderAnalysisPanel();
    if (this.mode === "summary") this.render();
  }

  setLlmAnalysisEnabled(enabled: boolean | undefined): void {
    if (this.llmAnalysisEnabled === enabled) {
      this.l3El.querySelector('button[role="switch"]')?.removeAttribute("aria-busy");
      return;
    }
    this.llmAnalysisEnabled = enabled;
    this.l3Dirty = true;
    if (this.mode === "analysis") {
      const activeEl = document.activeElement;
      const hadFocus =
        activeEl !== null &&
        this.l3El.contains(activeEl) &&
        activeEl.getAttribute("role") === "switch";
      this.renderAnalysisPanel();
      if (hadFocus) {
        this.l3El.querySelector<HTMLButtonElement>('button[role="switch"]')?.focus();
      }
    }
  }

  // 分析レポートの保持キーは sessionId（裁定A2: resume 後も引き継ぐ）。report の貯蔵は
  // main.ts の sessionId キー Map が持ち、ここは「いま表示している1件」だけを描く
  setAnalysis(sessionId: string, filePath: string, report: AnalysisReport): void {
    this.hasReferenceReport = true;
    this.analysisEl.dataset.sessionId = sessionId;
    // 新しい結果が届いたので、前回の要求の失敗理由は消す
    this.analysisFailure = undefined;
    this.renderAnalysisFailureLine();
    renderAnalysisView(this.referenceEl, sessionId, filePath, report);
    this.syncReferenceVisibility();
  }

  showAnalysis(sessionId: string, filePath: string, report: AnalysisReport): void {
    this.setAnalysis(sessionId, filePath, report);
    // 結果はボタンの下（LLM 分析側）に生える。押した先が見える側へ切り替える（R-ANL-12）
    this.setAnalysisSub("ai");
    this.setMode("analysis");
  }

  update(payload: WorkModelPayload | undefined): void {
    const previousToolCount = this.payload === undefined ? undefined : this.totalToolCount(this.payload);
    const previousFailCount = this.payload === undefined ? undefined : this.totalFailCount(this.payload);
    this.payload = payload;
    this.summaryDirty = true;
    if (this.mode === "summary") this.render();
    // 実測ヘッダのツール操作数だけが payload 由来。所見・L3 まで描き直すと 120ms ごとに details の開閉が戻る
    const measuredChanged =
      previousToolCount !== (payload === undefined ? undefined : this.totalToolCount(payload)) ||
      previousFailCount !== (payload === undefined ? undefined : this.totalFailCount(payload));
    if (this.mode === "analysis" && measuredChanged) {
      this.renderMeasured();
    }
    else if (this.mode !== "analysis" && measuredChanged) this.l3Dirty = true;
    this.graph.update(payload);
  }

  updateSemantic(model: SemanticModelPayload | undefined, semanticView?: boolean): void {
    const previous = this.activeSemantic();
    const active = semanticView === false ? undefined : model;
    // 履歴 backfill 中は coverage だけを差し替えた shallow copy が何度も届く。
    // 分析面が読む入力の参照がすべて同じなら、結果 DOM を捨てて描き直さない。
    // Host から新しい semanticModel が届く場合は structured clone により各参照が変わるため、
    // 同じ revision でも新しい分析入力を取りこぼさない。
    const shallowAnalysisChanged =
      previous?.timeBuckets !== active?.timeBuckets ||
      previous?.l3 !== active?.l3 ||
      previous?.execLogFindings !== active?.execLogFindings ||
      !sameMarks(this.execLogMarks, active?.execLogMarks);
    this.semanticPayload = model;
    this.semanticView = semanticView;
    this.summaryDirty = true;
    this.syncReferenceVisibility();
    this.execLogFindings = active?.execLogFindings;
    this.setExecLogMarks(active?.execLogMarks);
    const evidenceChanged = this.analysisEvidenceKey() !== this.renderedAnalysisEvidenceKey;
    if (this.renderedAnalysisValueKey === undefined) {
      this.l3Dirty = true;
    } else if (this.l3Dirty || shallowAnalysisChanged || evidenceChanged) {
      // 同値の semanticModel 再送もあるため、参照差だけで再描画を決めない。
      this.l3Dirty =
        evidenceChanged || this.analysisValueKey() !== this.renderedAnalysisValueKey;
    }
    if (this.mode === "analysis" && this.l3Dirty) this.renderAnalysisPanel();
    if (this.mode === "summary") this.render();
    this.graph.updateSemantic(model, semanticView);
  }

  // 実行ログの印（R-TAB-06）。印は Host の producer（exec-log-marks.ts）が作る。ここでは行へ貼り、まとめを出すだけ
  setExecLogMarks(marks: ExecLogMark[] | undefined): void {
    if (sameMarks(this.execLogMarks, marks)) return;
    this.execLogMarks = marks;
    this.summaryDirty = true;
    this.decorateExecLog(true);
    if (!this.analysisMatchesRendered()) {
      this.l3Dirty = true;
      if (this.mode === "analysis") this.renderAnalysisPanel();
    }
    if (this.mode === "summary") this.render();
  }

  setMode(mode: WorkViewMode, moveFocus = false): void {
    const prev = this.mode;
    const after = prev !== mode ? this.onWorkViewChange?.(prev, mode) : undefined;
    this.mode = mode;
    this.applyMode();
    if (mode === "summary" && this.summaryDirty) this.render();
    if (mode === "analysis" && !this.l3Dirty && !this.analysisMatchesRendered()) this.l3Dirty = true;
    if (mode === "analysis" && this.l3Dirty) this.renderAnalysisPanel();
    if (typeof after === "function") after();
    if (moveFocus) this.tabs[mode].focus();
  }

  // tab.ts が新しい詳細行を append したあとに呼ぶ。呼ばないと概要表示のまま新着だけが見える
  syncVisibility(): void {
    this.applyMode();
    if (this.execLogMarks !== undefined) this.decorateExecLog(false);
    if (this.analysisEvidenceKey() !== this.renderedAnalysisEvidenceKey) {
      this.l3Dirty = true;
      if (this.mode === "analysis") this.renderAnalysisPanel();
    }
  }

  // #logs の scroll（main.ts）から。グラフ以外を見ている間は渡さない
  onPortScroll(): void {
    if (this.mode !== "graph") return;
    this.graph.onPortScroll();
  }

  tick(nowMs: number): void {
    this.lastTickMs = nowMs;
    this.graph.tick(nowMs);
    if (this.mode === "summary" && this.turnRunning) this.refreshLive(nowMs);
    // 進行中だけ描き直す。終端の便で llmProgress を落としているので、終端の後は
    // 何度 tick が来ても「分析中…」は復活しない
    if (this.mode === "analysis" && this.llmProgress !== undefined) this.renderLlmRunLine();
  }

  handleInspectorResult(message: Extract<HostToWebview, { type: "agentInspectorResult" }>): void {
    this.inspector.handleResult(message);
  }

  handleInspectorError(message: Extract<HostToWebview, { type: "agentInspectorError" }>): void {
    this.inspector.handleError(message);
  }

  private applyMode(): void {
    for (const mode of WORK_VIEW_MODES) {
      const btn = this.tabs[mode];
      btn.classList.toggle("active", mode === this.mode);
      btn.setAttribute("aria-selected", String(mode === this.mode));
      btn.tabIndex = mode === this.mode ? 0 : -1;
    }
    this.rootEl.hidden = this.mode !== "summary";
    this.graph.rootEl.hidden = this.mode !== "graph";
    this.graph.setVisible(this.mode === "graph");
    if (this.mode !== "graph" && this.inspector.isOpen()) this.inspector.close();
    this.analysisEl.hidden = this.mode !== "analysis";
    this.logHeadEl.hidden = this.mode !== "log" || this.logSumEl.childElementCount === 0;
    const analysisActive = this.mode === "analysis";
    if (analysisActive !== this.notifiedAnalysisActive) {
      this.notifiedAnalysisActive = analysisActive;
      this.onAnalysisModeChange?.(analysisActive);
    }
    for (const child of Array.from(this.workEl.children)) {
      if (child === this.rootEl || child === this.graph.rootEl ||
          child === this.analysisEl || child === this.logHeadEl) continue;
      (child as HTMLElement).hidden = this.mode !== "log";
    }
  }

  // semanticView=false（明示off）は render() と同じ扱いで L3 を出さない
  private activeL3(): SemanticModelPayload["l3"] {
    return (this.semanticView === false ? undefined : this.semanticPayload)?.l3;
  }

  private syncReferenceVisibility(): void {
    const hasL3 = this.activeL3() !== undefined;
    this.referenceHeadEl.hidden = !hasL3 || !this.hasReferenceReport;
    this.referenceEl.hidden = hasL3 && !this.hasReferenceReport;
  }

  private renderAnalysisPanel(): void {
    this.renderMeasured();
    this.renderFindings();
    this.renderL3();
    this.captureAnalysisKeys();
  }

  // 分析面の描画入力だけを比較する。coverage は概要・グラフの表示入力であり、分析入力ではない。
  // toolEvidence は同じ payload のまま履歴 backfill で利用可能性が変わるので、参照とは別に含める。
  private analysisValueKey(): string {
    const semantic = this.activeSemantic();
    return JSON.stringify([
      semantic?.timeBuckets,
      this.execLogFindings,
      this.execLogMarks,
      semantic?.l3,
      this.payload === undefined ? undefined : this.totalToolCount(this.payload),
      this.payload === undefined ? undefined : this.totalFailCount(this.payload),
      this.llmAnalysisEnabled,
      this.turnRunning,
      this.llmRunning,
      this.llmProgress,
      this.llmFailure,
      this.llmRefusal,
      this.analysisFailure,
    ]);
  }

  private analysisEvidenceKey(): string {
    const ids = new Set<string>();
    for (const mark of this.execLogMarks ?? []) ids.add(mark.toolUseId);
    const llm = this.activeL3()?.llm;
    const attached = llm !== undefined && "attached" in llm ? llm.attached : undefined;
    for (const finding of attached?.findings ?? []) {
      for (const evidence of finding.evidence) {
        if (evidence.navigateToolUseId !== undefined) ids.add(evidence.navigateToolUseId);
      }
    }
    return JSON.stringify(
      Array.from(ids).sort().map((id) => [id, this.toolEvidence?.has(id) === true])
    );
  }

  private analysisMatchesRendered(): boolean {
    return this.renderedAnalysisValueKey !== undefined &&
      this.analysisValueKey() === this.renderedAnalysisValueKey &&
      this.analysisEvidenceKey() === this.renderedAnalysisEvidenceKey;
  }

  private captureAnalysisKeys(): void {
    this.renderedAnalysisValueKey = this.analysisValueKey();
    this.renderedAnalysisEvidenceKey = this.analysisEvidenceKey();
  }

  // 3値: l3 未着（導出前 / 導出失敗 / semantic 明示off）と、値が unavailable と、
  // 値が observed を区別する。未着では区画を出さず参考区画（統計分析）の表示のままにする（裁定A4）
  private renderL3(): void {
    this.l3Dirty = false;
    const l3 = this.activeL3();
    const evidenceNavigation = this.toolEvidence
      ? {
          has: (toolUseId: string) => this.toolEvidence?.has(toolUseId) === true,
          navigate: (toolUseId: string) => {
            if (this.toolEvidence?.has(toolUseId) === true) {
              this.setMode("log");
              this.toolEvidence.navigate(toolUseId);
            }
          },
        }
      : undefined;
    renderAnalysisFactsView(
      this.l3El,
      l3,
      this.tabId,
      this.llmAnalysisEnabled,
      this.turnRunning,
      this.llmRunning,
      evidenceNavigation,
      this.l3LlmEl
    );
    this.renderLlmRunLine();
    this.renderAnalysisFailureLine();
    this.syncReferenceVisibility();
  }

  private activeSemantic(): SemanticModelPayload | undefined {
    return this.semanticView === false ? undefined : this.semanticPayload;
  }

  // セッションの実測。棒 3 本は同一目盛りで、返信待ちは棒に入れない（R-DSP-17）。
  // 継承時刻の値（null）は棒にも数字にもしない（R-DSP-11）
  private renderMeasured(): void {
    const head = this.measuredEl;
    // 描き直しの前に、利用者が開いた details の開閉をツリー順で退避する
    const prevOpen = Array.from(head.querySelectorAll("details")).map((d) => d.open);
    head.textContent = "";
    try {
      this.renderMeasuredBody(head);
    } finally {
      const details = Array.from(head.querySelectorAll("details"));
      if (details.length === prevOpen.length) details.forEach((d, i) => (d.open = prevOpen[i]));
    }
  }

  private renderMeasuredBody(head: HTMLElement): void {
    const view = this.activeSemantic()?.timeBuckets;
    if (view === undefined || view.firstAt === null || view.lastAt === null) {
      head.hidden = true;
      return;
    }
    head.hidden = false;
    head.appendChild(span("wa-head-t", l10n.t("Session measurements")));
    const when = div("wa-when");
    const start = document.createElement("b");
    start.textContent = dayClock(view.firstAt);
    const end = document.createElement("b");
    end.textContent = dayClock(view.lastAt);
    when.append(document.createTextNode(`${l10n.t("Start")} `), start, span("wa-arrow", "→"), document.createTextNode(`${l10n.t("Last")} `), end);
    const elapsed = span("wa-elapsed", "");
    elapsed.append(document.createTextNode(`${l10n.t("Elapsed")} `), span("wa-strong", view.spanMs === null ? l10n.t("Not measured") : formatDuration(view.spanMs)));
    when.appendChild(elapsed);
    head.appendChild(when);
    if (view.main.replyMs !== null || view.main.confirmMs !== null) {
      const idle = div("wa-idle");
      if (view.main.replyMs !== null) {
        idle.append(termSpan("Waiting for reply"), document.createTextNode(" "), span("wa-strong", formatDuration(view.main.replyMs)));
      }
      if (view.main.confirmMs !== null) {
        if (view.main.replyMs !== null) idle.appendChild(document.createTextNode(l10n.t(" · ")));
        idle.append(termSpan("Waiting for your answer"), document.createTextNode(" "), span("wa-strong", formatDuration(view.main.confirmMs)));
      }
      head.appendChild(idle);
    }
    head.appendChild(this.renderMeasuredFacts(view));
    const cap = div("wa-cap");
    cap.append(span("wa-cap-n", l10n.t("Processing time")), span("wa-cap-v", view.bars.totalMs === null ? l10n.t("Not measured") : formatDuration(view.bars.totalMs)));
    head.appendChild(cap);

    const mainGen = view.main.generateMs;
    const mainTool = view.bars.mainMs === null || mainGen === null ? null : Math.max(0, view.bars.mainMs - mainGen);
    const total = view.bars.totalMs;
    const rows = div("wa-rows");
    const bar = (
      label: Node[],
      gen: number | null,
      tool: number | null,
      sum: number | null,
      cls: string
    ) => {
      const name = div(`wa-rn${cls}`);
      name.append(...label);
      const track = div(`wa-bar${cls}`);
      track.setAttribute("role", "img");
      if (gen === null || tool === null || sum === null || total === null) {
        track.classList.add("unmeasured");
        track.setAttribute("aria-label", l10n.t("Not measured"));
      } else {
        const scale = Math.max(1, total);
        const g = span("wa-seg wa-gen", "");
        g.style.width = `${Math.round((gen / scale) * 1000) / 10}%`;
        g.dataset.ms = String(gen);
        if (gen > 0) g.appendChild(span("wa-seg-v", formatDuration(gen)));
        const t = span("wa-seg wa-tool", "");
        t.style.width = `${Math.round((tool / scale) * 1000) / 10}%`;
        t.dataset.ms = String(tool);
        if (tool > 0) t.appendChild(span("wa-seg-v", formatDuration(tool)));
        track.append(g, t);
        track.setAttribute("aria-label", l10n.t("LLM generation {0}, tool execution {1}", formatDuration(gen), formatDuration(tool)));
      }
      const value = div("wa-rt");
      value.appendChild(span("wa-strong", sum === null ? l10n.t("Not measured") : formatDuration(sum)));
      if (sum !== null && total !== null && total > 0 && cls !== " wa-total") {
        value.appendChild(span("wa-sm", `${Math.round((sum / total) * 100)}%`));
      }
      rows.append(name, track, value);
    };
    const subGen = view.sub.generateMs;
    const subTool = view.sub.toolMs;
    bar([document.createTextNode(l10n.t("Total"))], mainGen === null ? null : mainGen + subGen, mainTool === null ? null : mainTool + subTool, total, " wa-total");
    bar([document.createTextNode(l10n.t("Main"))], mainGen, mainTool, view.bars.mainMs, "");
    bar([termSpan("Subagent"), span("wa-c", l10n.t("{0} runs", view.agentCount))], subGen, subTool, view.bars.subMs, "");
    head.appendChild(rows);
    const key = document.createElement("ul");
    key.className = "wa-key";
    for (const [cls, label] of [["wa-gen", "LLM generation"], ["wa-tool", "Tool execution"]] as const) {
      const li = document.createElement("li");
      const sw = span(`wa-sw ${cls}`, "");
      sw.setAttribute("aria-hidden", "true");
      li.append(sw, termSpan(label));
      key.appendChild(li);
    }
    head.appendChild(key);
    if (view.agents.length > 0) head.appendChild(this.renderAgentBreakdown(view));
  }

  private renderMeasuredFacts(view: TimeBucketView): HTMLElement {
    const facts = div("wa-facts");
    const concurrency = div("");
    concurrency.append(
      span("wa-lbl", l10n.t("Max concurrency")),
      document.createTextNode(" "),
      span("wa-strong", String(view.maxConcurrency)),
      document.createTextNode(l10n.t(" (subagents ")),
      span("wa-strong", String(view.maxParallelAgents)),
      document.createTextNode(l10n.t(")"))
    );
    facts.appendChild(concurrency);
    const payload = this.payload;
    if (payload !== undefined) {
      const ops = div("");
      ops.append(
        span("wa-lbl", l10n.t("Tool operations (errors/total)")),
        document.createTextNode(" "),
        span("wa-strong", String(this.totalFailCount(payload))),
        span("wa-lbl", ` / ${this.totalToolCount(payload)}`)
      );
      facts.appendChild(ops);
    }
    return facts;
  }

  // サブエージェントを種別ごと → 体ごとの 2 段で開く（体ごとの開始時刻は出さない — S-4）
  private renderAgentBreakdown(view: TimeBucketView): HTMLElement {
    const more = document.createElement("details");
    more.className = "wa-more";
    const summary = document.createElement("summary");
    summary.textContent = l10n.t("View {0} subagent runs by type", view.agents.length);
    more.appendChild(summary);
    const byType = new Map<string, AgentSpanView[]>();
    for (const a of view.agents) {
      const key = a.subagentType ?? l10n.t("(no type)");
      const list = byType.get(key) ?? [];
      list.push(a);
      byType.set(key, list);
    }
    const table = div("wa-types");
    const head = div("wa-thead");
    const columns: readonly [string, string][] = [
      ["", l10n.t("Type")],
      [" wa-num", l10n.t("Runs")],
      [" wa-num", l10n.t("LLM generation")],
      [" wa-num", l10n.t("Tool execution")],
      [" wa-num", l10n.t("Operations")],
      [" wa-num", l10n.t("Failures")],
    ];
    for (const [cls, text] of columns) {
      head.appendChild(div(`wa-th${cls}`)).textContent = text;
    }
    table.appendChild(head);
    const num = (n: number) => span(`wa-num${n === 0 ? " wa-zero" : ""}`, String(n));
    const dur = (ms: number) => span(`wa-num${ms === 0 ? " wa-zero" : ""}`, formatDuration(ms));
    for (const [type, agents] of byType) {
      const row = document.createElement("details");
      row.className = "wa-trow";
      const rs = document.createElement("summary");
      const sum = (f: (a: AgentSpanView) => number) => agents.reduce((acc, a) => acc + f(a), 0);
      rs.append(span("wa-ty", type), num(agents.length), dur(sum((a) => a.generateMs)), dur(sum((a) => a.toolMs)), num(sum((a) => a.toolCount)), (() => {
        const f = sum((a) => a.failCount);
        return span(`wa-num${f === 0 ? " wa-zero" : " wa-fail"}`, String(f));
      })());
      row.appendChild(rs);
      const runs = document.createElement("ul");
      runs.className = "wa-runs";
      for (const a of agents) {
        const li = document.createElement("li");
        li.dataset.toolUseId = a.toolUseId;
        li.append(span("", agentLabel(a)), dur(a.generateMs), dur(a.toolMs), num(a.toolCount), span(`wa-num${a.failCount === 0 ? " wa-zero" : " wa-fail"}`, String(a.failCount)));
        runs.appendChild(li);
      }
      row.appendChild(runs);
      table.appendChild(row);
    }
    more.appendChild(table);
    return more;
  }

  // スクリプト分析の所見（実行ログの印の飛び先。R-TAB-06）。今回の件数だけを出す。累計は数えていないので出さない（R-DSP-11）
  private renderFindings(): void {
    const box = this.findingsEl;
    box.textContent = "";
    const findings = this.execLogFindings;
    if (findings === undefined) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (findings.length === 0) {
      box.appendChild(span("wa-quiet", NO_FINDINGS_TEXT));
      return;
    }
    for (const { family, title, note } of FINDING_SECTIONS) {
      const rows = findings.filter((f) => f.family === family);
      if (rows.length === 0) continue;
      const headEl = span("wa-sec-h", title);
      headEl.title = note;
      headEl.setAttribute("aria-description", note);
      headEl.tabIndex = 0;
      box.appendChild(headEl);
      this.renderFindingRows(box, rows);
    }
  }

  private renderFindingRows(box: HTMLElement, findings: readonly ExecLogFindingView[]): void {
    for (const f of findings) {
      const row = div("wa-find");
      row.dataset.findingAnchor = f.anchor;
      row.dataset.family = f.family;
      row.tabIndex = -1;
      // 行の主語は観測した事象。直す先はタグ（プロジェクト / ルール / 設定 / skill）付きの候補として
      // 後ろに添える（R-DSP-01）。累計は数えていないので出さない（R-DSP-11）
      const nameEl = span("wa-find-n", f.label);
      row.append(nameEl, span("wa-find-c", l10n.t("This time {0}", f.count)));
      if (f.fixCandidate !== undefined) {
        // .wa-sm はチップ側の「ほか N 件」と共用。候補だけを引ける class を必ず持たせる
        const fix = span("wa-sm wa-find-fix", "");
        if (f.category !== undefined) fix.appendChild(span("wa-badge", f.category));
        fix.appendChild(document.createTextNode(l10n.t("Candidate: {0}", f.fixCandidate)));
        fix.title = l10n.t("A common fix target for this classification. It has not been confirmed that this line was caused by it");
        row.appendChild(fix);
      }
      const nav = this.toolEvidence;
      const marks = (this.execLogMarks ?? []).filter((m) => m.findingAnchor === f.anchor && nav?.has(m.toolUseId) === true);
      if (marks.length > 0 && nav !== undefined) {
        const chips = div("wa-chips");
        for (const m of marks.slice(0, 12)) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "wa-chip";
          chip.textContent = l10n.t("Execution log line ›");
          chip.title = m.toolUseId;
          chip.onclick = () => {
            this.setMode("log");
            nav.navigate(m.toolUseId);
          };
          chips.appendChild(chip);
        }
        if (marks.length > 12) chips.appendChild(span("wa-sm", l10n.t("{0} more", marks.length - 12)));
        row.appendChild(chips);
      }
      box.appendChild(row);
    }
  }

  // 実行ログの印から分析タブの所見へ。確認は出さない
  private revealFinding(anchor: string): void {
    this.setMode("analysis", true);
    this.setAnalysisSub("script");
    for (const old of Array.from(this.findingsEl.querySelectorAll<HTMLElement>(".wa-find.wa-hit"))) old.classList.remove("wa-hit");
    const target = this.findingsEl.querySelector<HTMLElement>(`.wa-find[data-finding-anchor="${CSS.escape(anchor)}"]`);
    if (target === null) return;
    target.classList.add("wa-hit");
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }

  private render(): void {
    this.summaryDirty = false;
    this.rootEl.dataset.renderCount = String(++this.summaryRenderCount);
    this.coverageEl.textContent = "";
    this.bodyEl.textContent = "";
    const semantic = this.activeSemantic();
    const payload = this.payload;
    const coverage = semantic?.coverage.base ?? payload?.coverage;
    if (semantic !== undefined) {
      this.rootEl.dataset.semanticMode = semantic.mode;
      this.rootEl.dataset.semanticRevision = String(semantic.revision);
      this.rootEl.removeAttribute("data-work-revision");
    } else {
      delete this.rootEl.dataset.semanticMode;
      delete this.rootEl.dataset.semanticRevision;
      if (payload !== undefined) this.rootEl.dataset.workRevision = String(payload.revision);
      else this.rootEl.removeAttribute("data-work-revision");
    }
    if (coverage !== undefined) this.renderCoverageRows(coverage, semantic?.timeBucketsCoverage);
    const view = semantic?.timeBuckets;
    const tasks = payload?.tasks ?? [];
    const hasFlow = view !== undefined && view.blocks.length > 0;
    if (!hasFlow && tasks.length === 0 && (payload === undefined || this.totalToolCount(payload) === 0)) {
      // 中身が無い区画は骨組みごと出さない。無いときは 1 行で済ませる（R-DSP-05）
      this.bodyEl.appendChild(span("wo-empty", NO_WORK_SUMMARY_TEXT));
      return;
    }
    this.bodyEl.appendChild(this.renderHead(semantic, view));
    this.bodyEl.appendChild(this.renderCards(view, payload));
    this.bodyEl.appendChild(this.renderFlow(view, tasks));
  }

  private renderCoverageRows(coverage: WorkModelPayload["coverage"], timeBuckets?: TimeBucketsCoverage): void {
    this.coverageEl.dataset.coverageSummary = coverage.summary;
    this.coverageEl.dataset.coverageDetails = coverage.details;
    this.coverageEl.dataset.phaseHistory = coverage.phaseHistory;
    for (const row of coverageRows(coverage, timeBuckets)) {
      const el = span("wo-coverage-row", row.text);
      el.dataset.coverageScope = row.scope;
      if (row.state !== undefined) el.dataset.state = row.state;
      if (row.detail !== undefined) el.title = row.detail;
      this.coverageEl.appendChild(el);
    }
  }

  private totalToolCount(payload: WorkModelPayload): number {
    let n = 0;
    for (const p of payload.phases) n += p.toolCount + p.childToolCount;
    return n;
  }

  private totalFailCount(payload: WorkModelPayload): number {
    let n = 0;
    for (const p of payload.phases) n += p.failCount + p.childFailCount;
    return n;
  }

  private nowMs(view: TimeBucketView | undefined): number | undefined {
    if (!this.turnRunning) return undefined;
    if (this.lastTickMs !== undefined && view?.lastAt !== null && view !== undefined && this.lastTickMs > view.lastAt) return this.lastTickMs;
    return undefined;
  }

  // ヘッダ: 開始日時 / 経過 / 1 つ目のプロンプト（R-DSP-19 / R-DSP-02）
  private renderHead(semantic: SemanticModelPayload | undefined, view: TimeBucketView | undefined): HTMLElement {
    const head = div("wo-head");
    const when = div("wo-when");
    if (view !== undefined && view.firstAt !== null && view.lastAt !== null) {
      const start = document.createElement("b");
      start.textContent = formatDateTime(view.firstAt);
      when.append(start, document.createTextNode(l10n.t(" started ")));
      if (this.turnRunning) {
        const elapsed = document.createElement("b");
        elapsed.dataset.liveElapsed = "session";
        elapsed.dataset.start = String(view.firstAt);
        elapsed.textContent = formatDuration((this.nowMs(view) ?? view.lastAt) - view.firstAt);
        when.append(document.createTextNode(`${l10n.t("Elapsed")} `), elapsed, document.createTextNode(l10n.t(" (running)")));
      } else {
        const elapsed = document.createElement("b");
        // 起点が継承時刻なら経過を数字にしない（R-DSP-11）
        elapsed.textContent = view.spanMs === null ? l10n.t("Not measured") : formatDuration(view.spanMs);
        when.append(document.createTextNode(l10n.t("{0} finished, elapsed ", formatDateTime(view.lastAt))), elapsed);
      }
      head.appendChild(when);
      head.appendChild(this.renderSessionBand(view));
    }
    // 値が 1 つ目のプロンプトそのものでないなら「1 つ目のプロンプト」と名乗らせない（R-DSP-02 / R-DSP-01）。
    // Goal title（1 行目 200 字）を代用しない。要約が保存済みならそれで置き換え、出所（要約: モデル名）を添える（R-DSP-25）
    const firstPrompt = semantic?.firstPromptText;
    const summary = this.sessionSummary;
    if ((firstPrompt !== undefined && firstPrompt.length > 0) || summary !== undefined) {
      const gist = div("wo-gist");
      const text = div("wo-gist-t wo-raw");
      text.textContent = summary?.text ?? firstPrompt ?? "";
      if (summary !== undefined && firstPrompt !== undefined && firstPrompt.length > 0) {
        text.title = l10n.t("First prompt: {0}", firstPrompt.length > 300 ? `${firstPrompt.slice(0, 299)}…` : firstPrompt);
      }
      gist.appendChild(text);
      gist.appendChild(this.buildSummaryButton(summary !== undefined));
      head.appendChild(gist);
      // 保存に失敗した要約を「保存済み」と表示しない（R-DSP-01）。再試行は「作り直す」ボタン
      head.appendChild(div("wo-gist-n")).textContent =
        summary !== undefined
          ? summary.saveFailed === true
            ? l10n.t("Summary: {0} — could not be saved (retry)", summary.model)
            : l10n.t("Summary: {0} (saved)", summary.model)
          : l10n.t("First prompt");
    }
    if (this.summaryFailure !== undefined) {
      const failed = div("wo-gist-err");
      failed.setAttribute("role", "alert");
      failed.textContent = this.summaryFailure;
      head.appendChild(failed);
    }
    return head;
  }

  // 要約ボタン（R-DSP-25）。tooltip でトークン消費を明示する（R-ANL-07）。
  // 押した瞬間に実行中表現へ切り替え、復帰は Host の sessionSummary（running:false）による再描画
  private buildSummaryButton(hasSummary: boolean): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wo-gist-b";
    if (this.summaryRunning) {
      btn.textContent = l10n.t("Summarizing…");
      btn.disabled = true;
      btn.title = l10n.t("Generating the summary");
      return btn;
    }
    btn.textContent = hasSummary ? l10n.t("Regenerate") : l10n.t("Summarize");
    // R-DSP-25
    const rule = l10n.t("The summary runs with the same model and effort as this tab");
    btn.title = hasSummary
      ? l10n.t("Regenerates the summary and saves it. Consumes tokens. {0}", rule)
      : l10n.t("Creates a summary and saves it. Consumes tokens. {0}", rule);
    btn.onclick = () => {
      vscode.postMessage({ type: "summarizeSession", tabId: this.tabId });
      btn.disabled = true;
      btn.textContent = l10n.t("Summarizing…");
      btn.title = l10n.t("Generating the summary");
    };
    return btn;
  }

  setSessionSummary(
    running: boolean,
    summary: { text: string; model: string } | undefined,
    saveFailed = false,
    failure?: string
  ): void {
    this.summaryRunning = running;
    if (summary !== undefined) {
      this.sessionSummary = saveFailed ? { ...summary, saveFailed: true } : summary;
    }
    // 失敗理由は終了の便にだけ載る。開始（running）で消し、summary は上のとおり触らない（R-DSP-25）
    this.summaryFailure = running ? undefined : failure;
    this.summaryDirty = true;
    if (this.mode === "summary") this.render();
  }

  // 4 区分と棒 3 本の帯（R-DSP-19。グラフの右パネルから移設）。値は Host の TimeBucketView を
  // そのまま描き、継承時刻の値（null）は「未測定」（R-DSP-11）
  private renderSessionBand(view: TimeBucketView): HTMLElement {
    const band = div("wo-band");
    const buckets = div("wo-buckets");
    const item = (term: TermKey | Node, value: number | null, bucket: string) => {
      const el = span("wo-bk", "");
      el.dataset.bucket = bucket;
      el.append(typeof term === "string" ? termSpan(term) : term, document.createTextNode(" "), span("wo-bk-v", value === null ? l10n.t("Not measured") : formatDuration(value)));
      buckets.appendChild(el);
    };
    item("LLM generation", view.main.generateMs, "generate");
    item("Tool execution", view.main.toolMs, "tool");
    item("Waiting for your answer", view.main.confirmMs, "confirm");
    item("Waiting for reply", view.main.replyMs, "reply");
    if (view.main.subOnlyMs !== null && view.main.subOnlyMs > 0) item(document.createTextNode(l10n.t("Subagent only")), view.main.subOnlyMs, "sub-only");
    band.append(buckets, this.renderBars(view));
    return band;
  }

  // R-DSP-17: 合計 / メイン / サブエージェント の 3 本を同一目盛りに並べる。返信待ちは棒に入れない
  private renderBars(view: TimeBucketView): HTMLElement {
    const box = div("wo-bars");
    // data-bar は言語に依らない識別子（main.css の色分けが引く）。表示名は用語表のキーか翻訳済み文字列
    const bars: [string, Node, number | null][] = [
      ["total", document.createTextNode(l10n.t("Total")), view.bars.totalMs],
      ["main", document.createTextNode(l10n.t("Main")), view.bars.mainMs],
      ["subagent", termSpan("Subagent"), view.bars.subMs],
    ];
    const max = Math.max(1, ...bars.map(([, , v]) => v ?? 0));
    for (const [id, label, value] of bars) {
      const rowEl = div("wo-bar-row");
      rowEl.dataset.bar = id;
      const name = span("wo-bar-l", "");
      name.appendChild(label);
      const track = span("wo-bar-t", "");
      const fill = span("wo-bar-f", "");
      // 実測できていない棒を 0 幅で描かない。0 は「無かった」を主張する（R-DSP-01）
      if (value === null) {
        fill.classList.add("unmeasured");
      } else {
        fill.style.width = `${Math.round(value / max * 1000) / 10}%`;
        fill.dataset.ms = String(value);
      }
      track.appendChild(fill);
      rowEl.append(name, track, span("wo-bar-v", value === null ? l10n.t("Not measured") : formatDuration(value)));
      box.appendChild(rowEl);
    }
    return box;
  }

  // 数値タイル。ラベル左・値中央・区切り線。副題は置かない。
  // 現在値は並列数の 1 枚だけ。他の 4 枚はセッション累計なので、行の見出しで「現在」を名乗らない
  private renderCards(view: TimeBucketView | undefined, payload: WorkModelPayload | undefined): HTMLElement {
    const cards = div("wo-cards");
    // ラベルと値は別の行（div 2 段）。span にすると
    // 「並列数2」のように 1 行へ潰れる（O-64 が y 座標で固定）
    const card = (id: string, label: string, value: number, tone?: "hot" | "quiet") => {
      const c = div(`wo-card${tone !== undefined ? ` wo-${tone}` : ""}`);
      c.dataset.card = id;
      const t = div("wo-card-t");
      t.textContent = label;
      const v = div("wo-card-v");
      v.textContent = String(value);
      c.append(t, v);
      cards.appendChild(c);
      return c;
    };
    if (view !== undefined) {
      // 並列数は常に現在値（終了セッションは 0）。実行状態で最大値へ切り替えない
      const parallel = view.currentParallel;
      const parallelCard = card("parallel", l10n.t("Current parallelism"), parallel, parallel === 0 ? "quiet" : undefined);
      // ● が点くのは現在値のタイルだけ。実行中でなければ点けない（R-DSP-06）
      if (this.turnRunning) parallelCard.querySelector(".wo-card-t")?.prepend(span("wo-live-dot", ""));
      card("agents", l10n.t("Agents"), view.agentCount, view.agentCount === 0 ? "quiet" : undefined);
    }
    // 検出器が無い間は「スクリプト分析」タイルを出さない。常に 0 のタイルは
    // 「分からないもの」を並べ立てることになる（R-DSP-10）
    if (this.execLogMarks !== undefined) {
      const anchored = this.execLogMarks.filter((m) => m.findingAnchor !== undefined).length;
      card("marks", l10n.t("Script analysis"), anchored, anchored > 0 ? "hot" : "quiet");
    }
    if (payload !== undefined) {
      const fails = this.totalFailCount(payload);
      card("fails", l10n.t("Failed executions"), fails, fails > 0 ? "hot" : "quiet");
      card("tools", l10n.t("Tool Executions"), this.totalToolCount(payload));
    }
    const box = div("wo-kpi");
    box.appendChild(cards);
    return box;
  }

  // 作業の流れ。1 行 = 1 往復（依頼ブロック）、新しいものが上。
  // Todo があれば入れ子、無ければ 1 行だけ（R-DSP-20 / R-DSP-04 / R-DSP-05）
  private renderFlow(view: TimeBucketView | undefined, tasks: readonly WorkTaskItemView[]): HTMLElement {
    const flow = div("wo-flow");
    const blocks = view?.blocks ?? [];
    const h = div("wo-flow-h");
    h.appendChild(document.createTextNode(l10n.t("Flow of work")));
    if (blocks.length > 0) {
      h.appendChild(span("wo-c", this.turnRunning ? l10n.t("Round trip {0}", blocks.length) : l10n.t("{0} round trips", blocks.length)));
    }
    flow.appendChild(h);
    if (blocks.length === 0) {
      // 意味モデル未着・明示 off では流れの材料が無い。測っていない値を置かない（R-DSP-11）
      flow.appendChild(span("wo-note", view === undefined ? l10n.t("The flow of work cannot be shown because the semantic model is disabled.") : l10n.t("No user messages yet.")));
      if (tasks.length > 0) flow.appendChild(this.renderTodo(tasks));
    } else {
      const newestFirst = [...blocks].reverse();
      const hidden = !this.flowExpanded && !this.turnRunning && newestFirst.length > FLOW_LIMIT ? newestFirst.length - FLOW_LIMIT : 0;
      if (hidden > 0) {
        const fold = document.createElement("button");
        fold.type = "button";
        fold.className = "wo-fold";
        fold.textContent = l10n.t("↑ Show the previous {0} round trips", hidden);
        fold.onclick = () => {
          this.flowExpanded = true;
          this.render();
        };
        flow.appendChild(fold);
      }
      const list = document.createElement("ul");
      list.className = "wo-list";
      const shown = hidden > 0 ? newestFirst.slice(0, FLOW_LIMIT) : newestFirst;
      const runningAgents = (view?.agents ?? []).filter((a) => a.open && this.turnRunning);
      const runningBgTasks = (view?.backgroundTasks ?? []).filter((b) => b.open && this.turnRunning);
      let prevDay: string | undefined;
      for (let i = 0; i < shown.length; i++) {
        const block = shown[i];
        const day = dayKey(block.anchorAt);
        const li = this.renderBlockRow(block, view, day !== prevDay);
        prevDay = day;
        list.appendChild(li);
        if (i === 0 && this.turnRunning) {
          for (const agent of runningAgents) list.appendChild(this.renderRunningAgent(agent, view));
          for (const bg of runningBgTasks) list.appendChild(this.renderRunningBackgroundTask(bg, view));
          if (tasks.length > 0) list.appendChild(this.renderTodo(tasks));
        }
      }
      flow.appendChild(list);
      if (!list.querySelector(".wo-todo") && tasks.length > 0) flow.appendChild(this.renderTodo(tasks));
    }
    if (tasks.length === 0) {
      // Todo が無いときは入れ子の骨組みを出さず 1 行だけ（R-DSP-04）
      flow.appendChild(span("wo-todo-n", l10n.t("Todo is not used")));
    }
    return flow;
  }

  // showDate: 日をまたぐセッションで行の時刻が曖昧にならないよう、日付（月日）を先頭行と日付が変わる行に出す。
  // フルの日時は毎行 title に持つ
  private renderBlockRow(block: RequestBlockView, view: TimeBucketView | undefined, showDate = true): HTMLElement {
    const li = document.createElement("li");
    li.className = "wo-it";
    li.dataset.blockId = block.blockId;
    const marks = this.marksInBlock(block);
    const isNow = this.turnRunning && block.running;
    if (isNow) li.classList.add("now");
    if (block.failCount > 0 || marks > 0) li.classList.add("m");
    else if (block.toolCount > 0) li.classList.add("w");
    if (block.text.length <= SHORT_TEXT_MAX) li.classList.add("wo-short");
    if (this.openBlocks.has(block.blockId)) li.classList.add("open");
    const at = span("wo-it-at", showDate ? `${monthDay(block.anchorAt)} ${clock(block.anchorAt)}` : clock(block.anchorAt));
    at.title = formatDateTime(block.anchorAt);
    if (showDate) at.dataset.date = monthDay(block.anchorAt);
    li.append(
      at,
      span("wo-it-bar", ""),
      span("wo-it-t", block.text)
    );
    const stats = span("wo-it-s", "");
    const parts: (string | HTMLElement)[] = [];
    if (block.toolCount > 0) parts.push(l10n.t("Tools {0}", block.toolCount));
    if (block.agentCount > 0) parts.push(l10n.t("Agents {0}", block.agentCount));
    if (marks > 0) parts.push(span("wo-mk", l10n.t("Flagged {0}", marks)));
    if (parts.length === 0) {
      // 起点が継承値（durationMs=null）なら数字を出さず、実行中の刻みも付けない（R-DSP-11。グラフの blockDuration と同じ規則）
      if (block.durationMs === null) {
        parts.push(span("wo-it-e", l10n.t("Not measured")));
      } else {
        const end = isNow ? (this.nowMs(view) ?? block.end) : block.end;
        const elapsed = span("wo-it-e", formatDuration(Math.max(block.durationMs, end - block.start)));
        if (isNow) {
          elapsed.dataset.liveElapsed = "block";
          elapsed.dataset.start = String(block.start);
        }
        parts.push(elapsed);
      }
    }
    parts.forEach((p, i) => {
      if (i > 0) stats.appendChild(document.createTextNode(l10n.t(" · ")));
      stats.appendChild(typeof p === "string" ? document.createTextNode(p) : p);
    });
    const convTurn = this.conversation !== undefined ? block.turnIds.find((id) => this.conversation!.has(id)) : undefined;
    if (convTurn !== undefined) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wo-conv";
      btn.textContent = l10n.t("Conversation");
      btn.title = l10n.t("Go to this exchange in the Conversation tab");
      btn.onclick = (e) => {
        e.stopPropagation();
        this.conversation!.navigate(convTurn);
      };
      stats.appendChild(btn);
    }
    li.appendChild(stats);
    li.addEventListener("click", () => {
      if (block.text.length <= SHORT_TEXT_MAX) return;
      const open = li.classList.toggle("open");
      if (open) this.openBlocks.add(block.blockId);
      else this.openBlocks.delete(block.blockId);
    });
    return li;
  }

  // 往復に属する印の数。印は turnId を持ち、往復は turnIds を持つ
  private marksInBlock(block: RequestBlockView): number {
    const marks = this.execLogMarks;
    if (marks === undefined || block.turnIds.length === 0) return 0;
    const turns = new Set(block.turnIds);
    let n = 0;
    for (const m of marks) if (turns.has(m.turnId)) n++;
    return n;
  }

  private renderRunningAgent(agent: AgentSpanView, view: TimeBucketView | undefined): HTMLElement {
    const li = document.createElement("li");
    li.className = "wo-run";
    li.dataset.toolUseId = agent.toolUseId;
    const elapsed = span("wo-run-e", formatDuration((this.nowMs(view) ?? agent.end) - agent.start));
    elapsed.dataset.liveElapsed = "agent";
    elapsed.dataset.start = String(agent.start);
    li.append(
      span("wo-dot", ""),
      span("wo-run-n", agentLabel(agent)),
      span("wo-run-m", agent.subagentType ?? ""),
      elapsed
    );
    return li;
  }

  private renderRunningBackgroundTask(task: BackgroundTaskSpanView, view: TimeBucketView | undefined): HTMLElement {
    const li = document.createElement("li");
    li.className = "wo-run";
    li.dataset.toolUseId = task.toolUseId;
    li.dataset.taskId = task.taskId;
    const desc = task.description || task.taskId;
    const elapsed = span("wo-run-e", l10n.t("· Elapsed {0}", formatDuration((this.nowMs(view) ?? task.end) - task.start)));
    elapsed.dataset.liveElapsed = "bg";
    elapsed.dataset.start = String(task.start);
    li.append(
      span("wo-run-n", `🔄 ${desc}`),
      elapsed
    );
    return li;
  }

  private renderTodo(tasks: readonly WorkTaskItemView[]): HTMLElement {
    const li = document.createElement("li");
    li.className = "wo-todo-wrap";
    const ul = document.createElement("ul");
    ul.className = "wo-todo";
    for (const task of tasks) {
      const item = document.createElement("li");
      item.dataset.taskKey = task.taskKey;
      item.dataset.status = task.status;
      const mark = span("wo-s", task.status === "completed" ? "✓" : task.status === "in_progress" ? "▸" : "·");
      if (task.status === "completed") {
        mark.classList.add("done");
        item.classList.add("wo-doneli");
      } else if (task.status === "in_progress") {
        mark.classList.add("now");
        item.classList.add("wo-onnow");
      }
      item.append(mark, span("wo-todo-t", task.status === "in_progress" && task.activeForm ? task.activeForm : task.description));
      ul.appendChild(item);
    }
    li.append(ul, span("wo-todo-n", l10n.t("Todo {0} items", tasks.length)));
    return li;
  }

  private refreshLive(nowMs: number): void {
    for (const el of Array.from(this.rootEl.querySelectorAll<HTMLElement>("[data-live-elapsed]"))) {
      const start = Number(el.dataset.start);
      if (Number.isFinite(start) && nowMs > start) {
        if (el.dataset.liveElapsed === "bg") {
          el.textContent = l10n.t("· Elapsed {0}", formatDuration(nowMs - start));
        } else {
          el.textContent = formatDuration(nowMs - start);
        }
      }
    }
  }

  // 実行ログの行に印を貼る（R-TAB-06）。行は tab.ts が data-tool-use-id を付けて組む。
  // full=true は印の集合が変わったとき（貼り直し）、false は行が増えたとき（未処理の行にだけ貼る）
  private decorateExecLog(full: boolean): void {
    if (full) {
      for (const old of Array.from(this.workEl.querySelectorAll<HTMLElement>(".wl-tag"))) old.remove();
      for (const row of Array.from(this.workEl.querySelectorAll<HTMLElement>(".tool-row.wl-flag, .tool-row.wl-fail"))) {
        row.classList.remove("wl-flag", "wl-fail");
      }
      this.decoratedToolUseIds.clear();
    }
    const marks = this.execLogMarks ?? [];
    for (const mark of marks) {
      // 「失敗（分類なし）」には印を付けない。押しても分析タブに飛び先が無い（R-TAB-06）
      const anchor = mark.findingAnchor;
      if (anchor === undefined) continue;
      if (this.decoratedToolUseIds.has(`${mark.toolUseId}|${anchor}`)) continue;
      const row = this.workEl.querySelector<HTMLElement>(`.tool-row[data-tool-use-id="${CSS.escape(mark.toolUseId)}"]`);
      if (row === null) continue;
      this.decoratedToolUseIds.add(`${mark.toolUseId}|${anchor}`);
      row.classList.add(mark.family === "failure" ? "wl-fail" : "wl-flag");
      const tag = div("wl-tag");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = mark.label;
      button.dataset.findingAnchor = anchor;
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.revealFinding(anchor);
      };
      tag.appendChild(button);
      // 印は summary の中。行の本文へ置くと、行を閉じたままでは見えない（R-TAB-06）
      const summary = row.querySelector<HTMLElement>(":scope > summary");
      (summary !== null ? summary : row).appendChild(tag);
    }
    this.renderExecLogSummary();
  }

  // 上部のまとめ（指摘 N 件 ＋ 種類別）。数えるのは Host が載せた印の全件で、
  // 画面に貼れた行の数ではない。裏読みの途中は行が揃っていないので、行から数えると部分集合になる（R-TAB-07）
  private renderExecLogSummary(): void {
    this.logSumEl.textContent = "";
    const anchored = (this.execLogMarks ?? []).filter((m) => m.findingAnchor !== undefined);
    const total = anchored.length;
    if (total > 0) {
      this.logSumEl.appendChild(span("wl-sum-n", l10n.t("{0} flagged", total)));
      const byAnchor = new Map<string, { label: string; count: number }>();
      for (const mark of anchored) {
        const anchor = mark.findingAnchor!;
        const cur = byAnchor.get(anchor) ?? { label: mark.label, count: 0 };
        cur.count++;
        byAnchor.set(anchor, cur);
      }
      for (const [anchor, { label, count }] of byAnchor) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "wl-chip";
        chip.textContent = `${label} ${count}`;
        chip.dataset.findingAnchor = anchor;
        chip.onclick = () => this.revealFinding(anchor);
        this.logSumEl.appendChild(chip);
      }
    }
    this.logHeadEl.hidden = this.mode !== "log" || total === 0;
  }
}
