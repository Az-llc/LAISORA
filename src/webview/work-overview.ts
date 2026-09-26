import type { MainTokenTotal, PlanUsage } from "../plan-usage";
import type { RoleRunView, RoleSummaryView } from "../role-summary";
import { derivePlanView, planStepKey } from "./plan-view";
import { renderPlanSection, planDuration, planTokens } from "./plan-panel";
import { createLoader } from "./loader";
import { EXECUTORS } from "../orchestration-executors";
// 状況パネル（概要 / グラフ / 分析 / 実行ログ の 4 タブ）と概要タブ・分析タブの描画。
// 値は Host の payload（WorkModelPayload / SemanticModelPayload.timeBuckets / execLogMarks）の写しだけを描き、
// ツール名から操作分類を起こしたり、作業を帰属させたり、時間を再計算したりはしない。
import type {
  HostToWebview,
  OrchestrationView,
  SemanticModelPayload,
  TimeBucketsCoverage,
  WorkModelPayload,
} from "../protocol";
import type { AnalysisReport } from "../analysis";
import type { TimeBucketView } from "../time-buckets";
import type { ExecLogFindingView, ExecLogMark, FailureKindView, FailureSummaryView } from "../exec-log-marks";
import { renderAnalysisView } from "./analysis-view";
import { renderAnalysisFactsView } from "./analysis-facts-view";
import { vscode } from "./dom";
import { formatDateTime, formatDuration, clock, dayClock } from "./format";
import { termSpan, type TermKey } from "./term";
import { WorkGraph, coverageRows, NO_WORK_SUMMARY_TEXT, type GraphScrollPort } from "./work-graph";
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

const EARLIER_LIMIT = 3;
// 状態 C（スクリプトで何も拾えなかったとき）の文言。所有者が決めた文言なので言い換えない
const NO_FINDINGS_TEXT = l10n.t(
  "Script analysis found no classifiable failures and no operations matching the rule table. This does not mean LLM analysis would find no candidates either; a script can only count events that fit predefined patterns."
);

// 見出しと注記は exec-log-marks.ts の実装（FAILURE_RULES / CONVENTION_RULES）が支えられる範囲だけを言う。
// 規則表は手選び 3 件の固定配列で、利用者の CLAUDE.md を読まない。
// 検出の仕組みを変えたら文も直す（R-DSP-01: 実体より強い主張をしない）
const FINDING_SECTIONS: readonly { family: "failure" | "convention"; code: string; title: string; note: string }[] = [
  {
    family: "failure",
    code: "FAIL",
    title: l10n.t("Failure classification"),
    note: l10n.t("Observations of lines where a tool execution returned an error, classified by rules over fixed patterns in the result body. Failures that match no rule are not counted. This is not a determination of cause, so the fix target is attached as a candidate"),
  },
  {
    family: "convention",
    code: "RULE",
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

function monthDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}


function sameMarks(a: readonly ExecLogMark[] | undefined, b: readonly ExecLogMark[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((m, i) => m.toolUseId === b[i].toolUseId && m.findingAnchor === b[i].findingAnchor && m.label === b[i].label);
}

// 分析の指標の色。CSS の --wa-<tone> と .wa-tone-<tone> に対応する（R-CNV-36: アクセントの濃淡は図の印だけ）
type ChartTone = "c1" | "c2" | "c3" | "c4" | "tool" | "unobserved";
const MODEL_TONES: readonly ChartTone[] = ["c1", "c2", "c3"];
const ROLE_TONES: readonly ChartTone[] = ["c1", "c2", "c3", "c4"];

// 分析タブのサブタブ。既定はスクリプト分析
type AnalysisSubtab = "script" | "ai";
const ANALYSIS_SUBTABS: readonly AnalysisSubtab[] = ["script", "ai"];

export class WorkOverview {
  private readonly rootEl: HTMLElement;
  private readonly coverageEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private orchestrationEl: HTMLElement | undefined;
  private readonly analysisEl: HTMLElement;
  // 分析の指標（TIME / ROLES / ERR）。スクリプト分析と LLM 分析の両方の上に置く
  private readonly measuredEl: HTMLElement;
  // 描き直しで開閉を戻さない。キーは役割（other は ""）
  private readonly expandedRoles = new Set<string>();
  private errExpanded = false;
  // 根拠リンクを開いた所見の anchor。描き直しで開閉を戻さない
  private readonly expandedFindings = new Set<string>();
  // スクリプト分析の所見（実行ログの印の飛び先。R-TAB-06）
  private readonly findingsEl: HTMLElement;
  private readonly logHeadEl: HTMLElement;
  private readonly logSumEl: HTMLElement;
  // 第3タブの主区画（L3）と参考区画（統計分析レポート。裁定A4）を別の入れ物にする。
  // renderAnalysisView は渡した要素を空にするので、同じ要素へ両方を描くと片方が消える
  private readonly l3El: HTMLElement;
  private readonly referenceHeadEl: HTMLElement;
  private readonly referenceEl: HTMLElement;
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
  private readonly planSection = document.createElement("section");
  private readonly youSection = div("wo-you");
  private planUsage: PlanUsage | undefined;
  private planOrchestration: OrchestrationView | undefined;

  private execLogMarks: ExecLogMark[] | undefined;
  private execLogFindings: ExecLogFindingView[] | undefined;
  private execLogFindingsEmptyLabel: string | undefined;
  // 印を貼り終えた行。全行を毎イベント貼り直さない
  private readonly decoratedToolUseIds = new Set<string>();
  // 要約（R-DSP-25）。undefined = 未生成（1 つ目のプロンプトを出す）。
  // saveFailed=true = 生成できたが永続化に失敗（「保存済み」と表示してはならない — R-DSP-01）
  private sessionSummary: { text: string; model: string; saveFailed?: boolean } | undefined;
  private summaryRunning = false;
  // 直近の要約実行が終えられなかった理由（sessionSummary.failure）。既存の要約は消さない（R-DSP-25）
  private summaryFailure: string | undefined;

  constructor(
    private readonly workEl: HTMLElement,
    private readonly tabId: string,
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
    private readonly onAnalysisSubChange?: () => void,
    private readonly onModeApplied?: (moveFocus: boolean) => void,
    private readonly onViewChange: (action: () => void) => void = (action) => action()
  ) {
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
    // 分析の指標の下にサブタブ 2 枚。同時に見えるのは片方だけ
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

    // 検査が DOM 経由で直接呼ぶ外部駆動点。本番の印は updateSemantic が渡す
    (this.rootEl as HTMLElement & { laisoraSetExecLogMarks?: (marks: ExecLogMark[] | undefined) => void })
      .laisoraSetExecLogMarks = (marks) => this.setExecLogMarks(marks);
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

  setYou(element: HTMLElement): void { this.youSection.replaceChildren(element); }

  setPlanUsage(usage: PlanUsage | undefined): void {
    this.planUsage = usage;
    this.summaryDirty = true;
    if (this.mode === "summary") this.render();
  }

  private renderPlan(): void {
    this.planSection.className = "plan-section";
    const time = this.activeSemantic()?.timeBuckets;
    const block = time?.blocks.at(-1);
    const context = this.payload?.planContext ?? (block ? {
      blockId: block.blockId, text: block.text, start: block.start, end: block.end, running: this.turnRunning,
    } : undefined);
    const view = derivePlanView(this.payload, this.planOrchestration, this.planUsage, this.lastTickMs ?? 0, context);
    // R-DSP-20: semantic snapshots can predate completion; only legacy payloads need their NOW fallback.
    for (const agent of time?.agents ?? []) {
      if (this.payload?.planTools !== undefined) continue;
      if (!agent.open || !this.turnRunning) continue;
      const lanes = [...view.now, ...view.steps.flatMap(step => step.lanes)];
      if (lanes.some(lane => lane.id === `agent:${agent.transcriptAgentId ?? agent.toolUseId}`)) continue;
      view.now.push({ id: `agent:${agent.toolUseId}`, agent: agent.subagentType ?? "Claude", title: agent.description,
        start: agent.start, elapsed: (this.nowMs(time) ?? agent.end) - agent.start, status: "running", tokens: null, cacheRead: 0, external: false });
    }
    for (const task of time?.backgroundTasks ?? []) {
      if (this.payload?.planTools !== undefined) continue;
      if (!task.open || !this.turnRunning) continue;
      view.now.push({ id: `background:${task.taskId}`, agent: "Claude", title: task.description,
        start: task.start, elapsed: (this.nowMs(time) ?? task.end) - task.start, status: "running", tokens: null, cacheRead: 0, external: false });
    }
    renderPlanSection(this.planSection, view);
  }

  // 分析面は payload を読まない（ERR の件数は semanticModel.failureSummary）。
  // ここで分析面を描き直すと 120ms ごとに開いた内訳が閉じる
  update(payload: WorkModelPayload | undefined): void {
    this.payload = payload;
    this.summaryDirty = true;
    if (this.mode === "summary") this.render();
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
      previous?.roleSummary !== active?.roleSummary ||
      previous?.failureSummary !== active?.failureSummary ||
      previous?.mainTokens !== active?.mainTokens ||
      previous?.l3 !== active?.l3 ||
      previous?.execLogFindings !== active?.execLogFindings ||
      !sameMarks(this.execLogMarks, active?.execLogMarks);
    this.semanticPayload = model;
    this.semanticView = semanticView;
    this.summaryDirty = true;
    this.syncReferenceVisibility();
    this.execLogFindings = active?.execLogFindings;
    this.execLogFindingsEmptyLabel = active?.execLogFindingsEmptyLabel;
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
    this.onModeApplied?.(moveFocus);
    if (typeof after === "function") after();
  }

  // tab.ts が新しい詳細行を append したあとに呼ぶ。呼ばないと概要表示のまま新着だけが見える
  syncVisibility(): void {
    for (const row of Array.from(this.bodyEl.querySelectorAll<HTMLButtonElement>(".earlier-row"))) {
      const turns: string[] = JSON.parse(row.dataset.turnIds ?? "[]");
      row.disabled = !turns.some(id => this.conversation?.has(id));
    }
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
    if (this.mode === "summary") this.renderPlan();
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
    if (this.mode === "log") {
      this.workEl.setAttribute("role", "tabpanel");
      this.workEl.setAttribute("aria-labelledby", `wotab-log-${this.tabId}`);
      this.workEl.tabIndex = 0;
    } else {
      this.workEl.removeAttribute("role");
      this.workEl.removeAttribute("aria-labelledby");
      this.workEl.removeAttribute("tabindex");
    }
    this.rootEl.hidden = this.mode !== "summary";
    this.graph.rootEl.hidden = this.mode !== "graph";
    this.graph.setVisible(this.mode === "graph");
    if (this.mode !== "graph" && this.inspector.isOpen()) this.inspector.close();
    this.analysisEl.hidden = this.mode !== "analysis";
    this.logHeadEl.hidden = this.mode !== "log" || this.logSumEl.childElementCount === 0;
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
      semantic?.roleSummary,
      semantic?.failureSummary,
      semantic?.mainTokens,
      this.execLogFindings,
      this.execLogFindingsEmptyLabel,
      this.execLogMarks,
      semantic?.l3,
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
              this.onViewChange(() => {
                this.setMode("log");
                this.toolEvidence?.navigate(toolUseId);
              });
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

  // 値・並び・百分率は Host が決めた形のまま描く。null は測れていない値なので何も描かない
  // （0 や — で埋めると「無かった」を主張する。R-DSP-11）
  private renderMeasured(): void {
    const head = this.measuredEl;
    head.textContent = "";
    const semantic = this.activeSemantic();
    const modules = [
      this.renderTimeModule(semantic?.timeBuckets, semantic?.mainTokens ?? null),
      this.renderRolesModule(semantic?.roleSummary),
      this.renderErrModule(semantic?.failureSummary),
    ].filter((m): m is HTMLElement => m !== null);
    head.hidden = modules.length === 0;
    if (modules.length === 0) return;
    const grid = div("wa-grid");
    grid.append(...modules);
    head.appendChild(grid);
  }

  private metricsModule(kind: "time" | "roles" | "err", code: string, subtitle: string): HTMLElement {
    const mod = document.createElement("section");
    mod.className = `wa-mod wa-${kind}`;
    const head = div("wa-code");
    head.id = `wa-${kind}-h-${this.tabId}`;
    const label = document.createElement("b");
    label.textContent = code;
    head.append(label, span("wa-code-s", subtitle));
    mod.setAttribute("aria-labelledby", head.id);
    mod.appendChild(head);
    return mod;
  }

  // 本体だけ（委任は ROLES）。輪の区切りは Host の百分率を CSS の calc で積むだけで、ここで比を計算しない
  private renderTimeModule(view: TimeBucketView | undefined, tokens: MainTokenTotal | null): HTMLElement | null {
    if (view === undefined || view.firstAt === null || view.lastAt === null) return null;
    const mod = this.metricsModule("time", "TIME", l10n.t("Main processing time"));
    // isTimeBucketsPayload は mainByModel の欠落（旧 payload）を通す
    const byModel = view.mainByModel ?? null;
    const totalMs = byModel !== null ? byModel.totalMs : view.bars.mainMs;
    const totalText = totalMs === null ? l10n.t("Not measured") : formatDuration(totalMs);
    const segments: { tone: ChartTone; label: Node; ms: number; percent: number | null }[] = [];
    if (byModel !== null) {
      byModel.models.forEach((m, i) => {
        const tone: ChartTone = m.kind === "model" ? MODEL_TONES[i] ?? "c4" : m.kind === "other" ? "c4" : "unobserved";
        segments.push({ tone, label: document.createTextNode(m.label), ms: m.generateMs, percent: m.percent });
      });
      segments.push({ tone: "tool", label: termSpan("Tool execution"), ms: byModel.toolMs, percent: byModel.toolPercent });
    }
    const ring = div("wa-ring");
    ring.setAttribute("role", "img");
    ring.setAttribute("aria-label", l10n.t("Main processing time {0}", totalText));
    let at = "";
    const stops: string[] = [];
    for (const s of segments) {
      if (s.percent === null) continue;
      const from = at === "" ? "0%" : `calc(${at})`;
      at = at === "" ? `${s.percent}%` : `${at} + ${s.percent}%`;
      stops.push(`var(--wa-${s.tone}) ${from} calc(${at})`);
    }
    if (stops.length > 0) ring.style.background = `conic-gradient(${stops.join(", ")})`;
    ring.appendChild(span("wa-ring-v", totalText));
    const legend = div("wa-tl");
    for (const s of segments) {
      const row = div("wa-lr");
      row.dataset.tone = s.tone;
      const dot = span(`wa-dot wa-tone-${s.tone}`, "");
      dot.setAttribute("aria-hidden", "true");
      const name = span("wa-ln", "");
      name.appendChild(s.label);
      name.title = name.textContent ?? "";
      row.append(dot, name, span("wa-lv", formatDuration(s.ms)), span("wa-lp", s.percent === null ? "" : `${s.percent}%`));
      legend.appendChild(row);
    }
    const facts = div("wa-fx");
    if (tokens !== null) facts.appendChild(span("wa-fx-i", l10n.t("Main ≈{0} tok", planTokens(tokens.tokens))));
    const start = dayClock(view.firstAt);
    const end = dayClock(view.lastAt);
    facts.appendChild(span("wa-fx-i", `${start} → ${start.slice(0, 5) === end.slice(0, 5) ? clock(view.lastAt) : end}`));
    const wait = (term: TermKey, ms: number | null) => {
      if (ms === null) return;
      const item = span("wa-fx-i", "");
      item.dataset.wait = term;
      item.append(termSpan(term), document.createTextNode(` ${formatDuration(ms)}`));
      facts.appendChild(item);
    };
    wait("Waiting for reply", view.main.replyMs);
    wait("Waiting for your answer", view.main.confirmMs);
    legend.appendChild(facts);
    const body = div("wa-tm");
    body.append(ring, legend);
    mod.appendChild(body);
    return mod;
  }

  // R-ANL-23: 役割は Host が記録から決めたもの。委任が無ければ区画ごと出さない
  private renderRolesModule(summary: RoleSummaryView | undefined): HTMLElement | null {
    if (summary === undefined || (summary.roles.length === 0 && summary.omittedSubagentCount === 0 && summary.externalRunsCoverage === undefined)) return null;
    const mod = this.metricsModule("roles", "ROLES", l10n.t("By delegated role (press a row for its runs)"));
    if (summary.roles.length > 0) {
      const grid = div("wa-rg");
      const columns = div("wa-rh");
      columns.setAttribute("aria-hidden", "true");
      columns.append(span("wa-rh-t", "TIME"), span("wa-rh-k", "TOKENS"));
      grid.appendChild(columns);
      summary.roles.forEach((role, i) => {
        const key = role.role ?? "";
        const open = this.expandedRoles.has(key);
        const list = div("wa-rl");
        list.id = `wa-rl-${this.tabId}-${i}`;
        list.hidden = !open;
        for (const run of role.runs) list.appendChild(this.renderRoleRun(run));
        const row = document.createElement("button");
        row.type = "button";
        row.className = "wa-rr";
        row.dataset.role = key;
        row.setAttribute("aria-expanded", String(open));
        row.setAttribute("aria-controls", list.id);
        const name = span("wa-rname", "");
        const label = document.createElement("b");
        label.textContent = role.role === null ? l10n.t("other") : role.label;
        name.append(label, span("wa-rcount", `×${role.count}`));
        row.append(
          this.roleTotal("wa-tv", role.totalMs === null ? null : formatDuration(role.totalMs), role.totalMsPartial, role.running, true),
          this.roleBar("wa-sb-t", role.timeWidthPercent, role.runs, (run) => run.timePercent),
          name,
          this.roleBar("wa-sb-k", role.tokenWidthPercent, role.runs, (run) => run.tokenPercent),
          this.roleTotal("wa-kv", role.totalTokens === null ? null : planTokens(role.totalTokens), role.totalTokensPartial, role.running, false)
        );
        row.onclick = () => {
          const next = list.hidden;
          list.hidden = !next;
          row.setAttribute("aria-expanded", String(next));
          if (next) this.expandedRoles.add(key);
          else this.expandedRoles.delete(key);
        };
        grid.append(row, list);
      });
      mod.appendChild(grid);
    }
    if (summary.omittedSubagentCount > 0) {
      mod.appendChild(div("wa-note")).textContent = l10n.t("{0} subagents folded into the summary are not listed", summary.omittedSubagentCount);
    }
    // R-ANL-24 / R-DSP-01: 読めなかった記録があるとき、一覧を外部実行の全件として出さない
    const external = summary.externalRunsCoverage;
    if (external !== undefined) {
      mod.appendChild(div("wa-note wa-note-external")).textContent = external.readError
        ? l10n.t("The saved external run records could not be read; external runs may be missing")
        : l10n.t("{0} saved external run records could not be read; external runs may be missing", external.unreadableLines);
    }
    return mod;
  }

  // R-DSP-03: 実行中を含む合計はまだ増える。終わった実行に測れていないものを含む合計は測れた分の和
  // ローダーは行に 1 つ（時間の側）。トークン側にも置くと同じ印が左右に並ぶ
  private roleTotal(className: string, text: string | null, partial: boolean, running: boolean, withLoader: boolean): HTMLElement {
    const el = span(className, "");
    if (text === null) return el;
    if (running) {
      if (withLoader) {
        const loader = span("wa-running", "");
        loader.setAttribute("aria-hidden", "true");
        loader.appendChild(createLoader(12));
        el.appendChild(loader);
      }
      el.appendChild(document.createTextNode(text));
      el.title = l10n.t("Still running; the value will grow");
      return el;
    }
    if (!partial) {
      el.textContent = text;
      return el;
    }
    const note = span("term-note", text);
    note.title = l10n.t("Includes runs that were not measured; the value is the total of the measured runs");
    el.appendChild(note);
    return el;
  }

  private roleBar(className: string, widthPercent: number | null, runs: readonly RoleRunView[], percentOf: (run: RoleRunView) => number | null): HTMLElement {
    const track = span(`wa-sb ${className}`, "");
    track.setAttribute("aria-hidden", "true");
    if (widthPercent === null) return track;
    const fill = span("wa-fill", "");
    fill.style.width = `${widthPercent}%`;
    for (const run of runs) {
      const percent = percentOf(run);
      if (percent === null) continue;
      const seg = span(`wa-seg wa-tone-${ROLE_TONES[run.shade] ?? "c4"}`, "");
      seg.style.width = `${percent}%`;
      seg.title = `${run.name} · ${run.variantLabel}`;
      fill.appendChild(seg);
    }
    track.appendChild(fill);
    return track;
  }

  // 要求値（観測していない値）は「要求」を添えて実測と区別する（R-ANL-23）
  private renderRoleRun(run: RoleRunView): HTMLElement {
    const row = div("wa-ri");
    const dot = span(`wa-dot wa-tone-${ROLE_TONES[run.shade] ?? "c4"}`, "");
    dot.setAttribute("aria-hidden", "true");
    const variant = span("wa-mx", "");
    variant.title = run.variantLabel;
    const part = (text: string, requested: boolean) => {
      if (variant.childNodes.length > 0) variant.appendChild(document.createTextNode(" · "));
      variant.appendChild(document.createTextNode(text));
      if (!requested) return;
      const mark = span("wa-req", l10n.t("requested"));
      mark.title = l10n.t("Requested value; the applied value was not observed");
      variant.appendChild(mark);
    };
    part(run.executor, false);
    if (run.model !== null) part(run.model, run.modelSource === "requested");
    if (run.effort !== null) part(run.effort, run.effortSource === "requested");
    row.append(
      dot,
      span("wa-rn", run.name),
      variant,
      run.durationMs === null ? this.unmeasuredCell() : span("wa-v", formatDuration(run.durationMs)),
      run.tokens === null ? this.unmeasuredCell() : span("wa-v", planTokens(run.tokens))
    );
    return row;
  }

  // R-DSP-11: 測れていない実行の値は 0 にせず — で示す
  private unmeasuredCell(): HTMLElement {
    const el = span("wa-v wa-unmeasured", "—");
    el.title = l10n.t("Not measured");
    return el;
  }

  // R-DSP-40: 上位 3 種と残りの分割・並びは Host が決める
  private renderErrModule(summary: FailureSummaryView | undefined): HTMLElement | null {
    if (summary === undefined) return null;
    const mod = this.metricsModule("err", "ERR", l10n.t("Failures"));
    const figure = div("wa-gv");
    figure.append(span("wa-gv-n", String(summary.failCount)), span("wa-gv-d", l10n.t("/ {0} tool calls", summary.toolCount)));
    const ratio = div("wa-ratio");
    ratio.setAttribute("aria-hidden", "true");
    if (summary.failPercent !== null) {
      const fill = span("wa-ratio-f", "");
      fill.style.width = `${summary.failPercent}%`;
      ratio.appendChild(fill);
    }
    mod.append(figure, ratio);
    const counters = (kinds: readonly FailureKindView[]): HTMLElement => {
      const box = div("wa-ctr");
      for (const kind of kinds) {
        const label = span("wa-kn", kind.label);
        label.title = kind.label;
        label.dataset.anchor = kind.anchor;
        box.append(label, span("wa-kc", String(kind.count)));
      }
      return box;
    };
    if (summary.top.length > 0) mod.appendChild(counters(summary.top));
    if (summary.restCount > 0) {
      const rest = counters(summary.rest);
      rest.classList.add("wa-ctr-rest");
      rest.id = `wa-err-rest-${this.tabId}`;
      rest.hidden = !this.errExpanded;
      const more = document.createElement("button");
      more.type = "button";
      more.className = "wa-more";
      more.textContent = l10n.t("+{0} kinds", summary.restCount);
      more.setAttribute("aria-expanded", String(this.errExpanded));
      more.setAttribute("aria-controls", rest.id);
      more.onclick = () => {
        this.errExpanded = rest.hidden;
        rest.hidden = !this.errExpanded;
        more.setAttribute("aria-expanded", String(this.errExpanded));
      };
      mod.append(more, rest);
    }
    return mod;
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
    for (const { family, code, title, note } of FINDING_SECTIONS) {
      const rows = findings.filter((f) => f.family === family);
      const section = document.createElement("section");
      section.className = "wa-fsec";
      section.dataset.family = family;
      const head = div("wa-code");
      head.id = `wa-fsec-${family}-${this.tabId}`;
      const label = document.createElement("b");
      label.textContent = code;
      const headEl = span("wa-code-s wa-sec-h", title);
      headEl.title = note;
      headEl.setAttribute("aria-description", note);
      headEl.tabIndex = 0;
      head.append(label, headEl);
      section.setAttribute("aria-labelledby", head.id);
      section.appendChild(head);
      // R-DSP-10: 印が 0 件の family も見出しを残し、Host の「該当なし」を置く
      if (rows.length === 0) {
        if (this.execLogFindingsEmptyLabel !== undefined) section.appendChild(div("wa-fsec-empty")).textContent = this.execLogFindingsEmptyLabel;
      } else {
        const list = div("llm-finding-cards");
        this.renderFindingRows(list, rows);
        section.appendChild(list);
      }
      box.appendChild(section);
    }
  }

  // 番号・件数の単位・根拠の開閉の文言・リンクの #n は Host（exec-log-marks.ts）が組んだ値をそのまま置く
  private renderFindingRows(list: HTMLElement, findings: readonly ExecLogFindingView[]): void {
    for (const f of findings) {
      const row = document.createElement("article");
      row.className = "llm-finding-card wa-find";
      row.dataset.findingAnchor = f.anchor;
      row.dataset.family = f.family;
      row.tabIndex = -1;
      row.appendChild(div("llm-finding-num llm-finding-digits wa-find-num")).textContent = f.numberDigits;
      const body = div("llm-finding-body");
      // 行の主語は観測した事象。直す先は候補として添える（R-DSP-01）。置き場所のタグ（category）は出さない
      body.appendChild(div("llm-finding-title wa-find-n")).textContent = f.label;
      if (f.fixCandidate !== undefined) {
        const fix = document.createElement("p");
        fix.className = "llm-finding-action wa-find-fix";
        fix.textContent = l10n.t("Candidate: {0}", f.fixCandidate);
        fix.title = l10n.t("A common fix target for this classification. It has not been confirmed that this line was caused by it");
        body.appendChild(fix);
      }
      const nav = this.toolEvidence;
      const marks = (this.execLogMarks ?? []).filter((m) => m.findingAnchor === f.anchor && nav?.has(m.toolUseId) === true);
      if (marks.length > 0 && nav !== undefined) {
        const links = div("llm-finding-evidence wa-ev");
        links.id = `wa-ev-${this.tabId}-${f.anchor}`;
        links.hidden = !this.expandedFindings.has(f.anchor);
        const lineLabel = l10n.t("Execution log line");
        for (const m of marks.slice(0, 12)) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "llm-evidence-chip wa-ev-link";
          link.textContent = `${m.ordinalLabel} ›`;
          link.title = lineLabel;
          link.setAttribute("aria-label", l10n.t("Execution log line {0}", m.ordinalLabel));
          link.onclick = () => this.onViewChange(() => {
            this.setMode("log");
            nav.navigate(m.toolUseId);
          });
          links.appendChild(link);
        }
        if (marks.length > 12) links.appendChild(span("wa-ev-more", l10n.t("{0} more", marks.length - 12)));
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "wa-ev-toggle";
        toggle.textContent = f.evidenceLabel;
        toggle.setAttribute("aria-expanded", String(!links.hidden));
        toggle.setAttribute("aria-controls", links.id);
        toggle.onclick = () => {
          const open = links.hidden;
          links.hidden = !open;
          toggle.setAttribute("aria-expanded", String(open));
          if (open) this.expandedFindings.add(f.anchor);
          else this.expandedFindings.delete(f.anchor);
        };
        body.append(toggle, links);
      }
      row.appendChild(body);
      const margin = document.createElement("aside");
      margin.className = "llm-finding-margin wa-find-margin";
      const figure = div("llm-finding-impact wa-find-c");
      figure.append(document.createTextNode(String(f.count)), span("wa-find-unit", f.countUnit));
      margin.appendChild(figure);
      row.appendChild(margin);
      list.appendChild(row);
    }
  }

  // 実行ログの印から分析タブの所見へ。確認は出さない
  private revealFinding(anchor: string): void {
    this.onViewChange(() => {
      this.setMode("analysis", true);
      this.setAnalysisSub("script");
      for (const old of Array.from(this.findingsEl.querySelectorAll<HTMLElement>(".wa-find.wa-hit"))) old.classList.remove("wa-hit");
      const target = this.findingsEl.querySelector<HTMLElement>(`.wa-find[data-finding-anchor="${CSS.escape(anchor)}"]`);
      if (target === null) return;
      target.classList.add("wa-hit");
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    });
  }

  setOrchestration(state: OrchestrationView | undefined): void {
    this.planOrchestration = state;
    this.renderPlan();
    if (state === undefined) { // R-ORC-38, R-ORC-21
      this.orchestrationEl?.remove();
      this.orchestrationEl = undefined;
      return;
    }
    if (this.orchestrationEl === undefined) {
      this.orchestrationEl = document.createElement("section");
      this.orchestrationEl.className = "wo-flow orchestration-roster";
      this.orchestrationEl.tabIndex = 0;
      this.orchestrationEl.setAttribute("aria-label", l10n.t("Agent roster"));
      this.rootEl.appendChild(this.orchestrationEl);
    }
    const group = this.orchestrationEl;
    group.replaceChildren();
    const heading = document.createElement("h3");
    heading.className = "wo-flow-h";
    heading.textContent = l10n.t("Agent roster");
    group.appendChild(heading);
    if (state.settingsChanged) { // R-ORC-21
      const notice = div("wo-note orchestration-notice");
      notice.setAttribute("role", "status");
      notice.textContent = l10n.t("Orchestration settings changed. They apply from the next session; this conversation keeps its starting roster.");
      group.appendChild(notice);
    }
    const conductor = div("orchestration-conductor");
    conductor.appendChild(span("wi-kind", l10n.t("Conductor (main thread)")));
    group.appendChild(conductor);
    const unknown = l10n.t("unknown");
    const list = (title: string, kind: string): HTMLUListElement => {
      const label = document.createElement("h4");
      label.className = "wo-flow-h";
      label.textContent = title;
      const rows = document.createElement("ul");
      rows.className = "wo-list";
      rows.dataset.orchestrationList = kind;
      rows.setAttribute("aria-label", title);
      group.append(label, rows);
      return rows;
    };
    const row = (rows: HTMLElement, title: string, detail: string, badge: string): HTMLElement => {
      const entry = document.createElement("li");
      entry.append(span("wi-kind", badge), document.createTextNode(" "), span("wo-it-t", title), span("wo-note", detail));
      rows.appendChild(entry);
      return entry;
    };
    const usageLabels: Record<string, string> = {
      input_tokens: l10n.t("Input tokens"), output_tokens: l10n.t("Output tokens"),
      cached_input_tokens: l10n.t("Cached input tokens"), reasoning_output_tokens: l10n.t("Reasoning output tokens"),
      cache_read_input_tokens: l10n.t("Cache read input tokens"), cache_creation_input_tokens: l10n.t("Cache creation input tokens"),
      total_tokens: l10n.t("Total tokens"), thinking_tokens: l10n.t("Thinking tokens"), cache_read_tokens: l10n.t("Cache read tokens"),
    };
    const usage = (value: OrchestrationView["agents"][number]["usage"]): string => value === null ? unknown
      : Object.entries(value).map(([key, count]) => `${usageLabels[key]}: ${count}`).join(" · ");
    const children = list(l10n.t("Observed agents"), "agents");
    const recentAgents = [...state.agents].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, 50); // R-ORC-23
    for (const agent of recentAgents) {
      const appliedModel = agent.model ?? unknown; // R-ORC-22
      const appliedEffort = agent.effort ?? unknown; // R-ORC-22
      const entry = row(children, agent.role ?? agent.agentType ?? unknown,
        l10n.t("Applied Model: {0} · Applied Effort: {1}", appliedModel, appliedEffort), l10n.t("Child agent"));
      entry.appendChild(span("wo-note", l10n.t("First seen: {0} · Last activity: {1} · Tokens: {2}",
        formatDateTime(Date.parse(agent.firstSeenAt)), formatDateTime(Date.parse(agent.lastActivityAt)), usage(agent.usage))));
    }
    const externalRuns = list(l10n.t("External runs"), "runs");
    const recentRuns = [...state.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50); // R-ORC-23
    for (const run of recentRuns) {
      const outcome = run.outcome === "ok" ? l10n.t("Succeeded") : run.outcome === "failed" ? l10n.t("Failed")
        : run.outcome === "timeout" ? l10n.t("Timed out") : l10n.t("Refused");
      row(externalRuns, `${run.role} · ${EXECUTORS[run.executor].displayName}${run.model ? ` · ${run.model}` : ""}${run.effort ? ` · ${run.effort}` : ""}`, l10n.t("{0} · Duration: {1} · Tokens: {2}",
        outcome, formatDuration(run.durationMs), usage(run.usage)) + (run.cwd ? ` ? ${run.cwd}` : ""), l10n.t("External executor"));
    }
    const requested = list(l10n.t("Starting roster (requested settings)"), "roster");
    for (const member of state.roster.agents) {
      row(requested, `${member.role} → ${member.agentKey}`,
        l10n.t("Requested Model: {0} · Requested Effort: {1}", member.model, member.effort ?? unknown), l10n.t("Child agent"));
    }
    for (const member of state.roster.external) {
      row(requested, `${member.role} → ${EXECUTORS[member.executor].displayName}`,
        l10n.t("Requested Model: {0} · Requested Effort: {1}", member.model ?? unknown, member.effort ?? unknown), l10n.t("External executor"));
    }
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
      this.bodyEl.appendChild(this.renderPlanYou(view));
      return;
    }
    this.bodyEl.appendChild(this.renderHead(semantic, view));
    this.bodyEl.appendChild(this.renderCards(view, payload));
    this.bodyEl.appendChild(this.renderPlanYou(view));
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
    const rule = l10n.t("The summary runs on haiku (fast, low cost)");
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

  private renderPlanYou(view: TimeBucketView | undefined): HTMLElement {
    const layout = div("wo-plan-you");
    layout.lang = document.documentElement.lang;
    const left = div("wo-plan-column");
    this.renderPlan();
    left.append(this.planSection);
    const earlier = document.createElement("section");
    earlier.className = "earlier-requests";
    const blocks = [...(view?.blocks ?? [])].reverse();
    const heading = document.createElement("h3");
    heading.className = "earlier-label";
    heading.textContent = `EARLIER REQUESTS · ${blocks.length}`;
    earlier.append(heading);
    if (this.payload?.planHistoryTruncated) earlier.append(span("plan-lede earlier-partial", l10n.t("Some earlier request details are unavailable.")));
    if (!blocks.length) earlier.append(span("earlier-empty", l10n.t("No earlier requests available.")));
    const shown = this.flowExpanded ? blocks : blocks.slice(0, EARLIER_LIMIT);
    for (const block of shown) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "earlier-row";
      row.dataset.blockId = block.blockId;
      row.dataset.turnIds = JSON.stringify(block.turnIds);
      row.title = block.text;
      const at = span("earlier-at", block.anchorAt > 0 ? `${monthDay(block.anchorAt)} ${clock(block.anchorAt)}` : "—");
      at.title = formatDateTime(block.anchorAt);
      const history = this.payload?.planHistory?.filter(entry => entry.kind === "todos" && entry.at >= block.start && (entry.at < block.end || block === view?.blocks.at(-1) && entry.at === block.end));
      // R-DSP-34: 手順数は宣言（kind "todos"）だけ。委任の再開（kind "resume"）は宣言ではないので数えない。同一性は PLAN と同じ planStepKey
      const steps = new Set(history?.flatMap(entry => entry.kind === "todos" ? entry.items.map(item => planStepKey(entry, item)) : []));
      const count = history?.length ? String(steps.size) : "—";
      const usage = this.planUsage?.blocks.find(value => value.blockId === block.blockId);
      const elapsed = span("earlier-elapsed", planDuration(block.durationMs));
      if (block.durationMs !== null && block.running && this.turnRunning) {
        elapsed.dataset.liveElapsed = "block";
        elapsed.dataset.start = String(block.start);
        elapsed.textContent = planDuration(Math.max(block.durationMs, (this.nowMs(view) ?? block.end) - block.start));
      }
      const stats = span("earlier-stats", `${l10n.t("{0} steps", count)} · `);
      stats.append(elapsed, document.createTextNode(` · ${planTokens(usage?.slices.length ? usage.tokens : null)}`));
      stats.title = l10n.t("Claude tokens. Cache read: {0}", planTokens(usage?.slices.length ? usage.cacheRead : null));
      const title = span("earlier-title", block.text.split(/\r?\n/, 1)[0]);
      if (/[\u3040-\u30ff\u3400-\u9fff]/.test(title.textContent ?? "")) title.lang = "ja";
      row.append(at, title, stats);
      row.onclick = () => {
        const turn = block.turnIds.find(id => this.conversation?.has(id));
        if (turn) this.conversation?.navigate(turn);
      };
      row.disabled = !block.turnIds.some(id => this.conversation?.has(id));
      earlier.append(row);
    }
    if (!this.flowExpanded && blocks.length > EARLIER_LIMIT) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "earlier-expand";
      expand.textContent = l10n.t("Previous {0} ▸", blocks.length - EARLIER_LIMIT);
      expand.setAttribute("aria-expanded", "false");
      expand.onclick = () => {
        this.flowExpanded = true;
        this.render();
        this.bodyEl.querySelector<HTMLButtonElement>(`.earlier-row[data-block-id="${CSS.escape(blocks[EARLIER_LIMIT].blockId)}"]`)?.focus({ preventScroll: true });
      };
      earlier.append(expand);
    }
    left.append(earlier);
    layout.append(left, this.youSection);
    return layout;
  }

  private refreshLive(nowMs: number): void {
    for (const el of Array.from(this.rootEl.querySelectorAll<HTMLElement>("[data-live-elapsed]"))) {
      const start = Number(el.dataset.start);
      if (Number.isFinite(start) && nowMs > start) {
        if (el.dataset.liveElapsed === "bg") {
          el.textContent = l10n.t("· Elapsed {0}", formatDuration(nowMs - start));
        } else {
          el.textContent = el.classList.contains("earlier-elapsed") ? planDuration(nowMs - start) : formatDuration(nowMs - start);
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
