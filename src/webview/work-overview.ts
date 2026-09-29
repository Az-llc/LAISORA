import type { MainTokenTotal, PlanUsage } from "../plan-usage";
import type { RoleRunView, RoleSummaryView } from "../role-summary";
import { derivePlanView, planStepKey } from "./plan-view";
import { renderPlanSection, planTokens } from "./plan-panel";
import { createLoader } from "./loader";
import { EXECUTORS } from "../orchestration-executors";
// 分類・帰属・時間区分は Host の payload の値を描くだけで、ここで導出しない（verify-work-overview#O-1, verify-time-buckets#TB-7）。
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

// 表記は src/webview/tab.ts#handoffElapsedText と揃える。あちらは export されていない。
function llmElapsedText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? l10n.t("{0}s", total) : l10n.t("{0}m {1}s", Math.floor(total / 60), total % 60);
}


export type WorkViewMode = "summary" | "graph" | "analysis" | "log";

const EARLIER_LIMIT = 3;
// 所有者が決めた文言。言い換えない（verify-work-overview#O-83f）。
const NO_FINDINGS_TEXT = l10n.t(
  "Script analysis found no classifiable failures and no operations matching the rule table. This does not mean LLM analysis would find no candidates either; a script can only count events that fit predefined patterns."
);

// 見出しと注記は src/exec-log-marks.ts#FAILURE_RULES と src/exec-log-marks.ts#CONVENTION_RULES が検出できる範囲を超えて主張しない。
// 検出側を変えたら文言も直す（R-DSP-01）。
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

// CSS の --wa-<tone> と .wa-tone-<tone> に対応する（R-CNV-36: アクセントの濃淡は図の印だけ）
type ChartTone = "c1" | "c2" | "c3" | "c4" | "tool" | "unobserved";
const MODEL_TONES: readonly ChartTone[] = ["c1", "c2", "c3"];
const ROLE_TONES: readonly ChartTone[] = ["c1", "c2", "c3", "c4"];

type AnalysisSubtab = "script" | "ai";
const ANALYSIS_SUBTABS: readonly AnalysisSubtab[] = ["script", "ai"];

export class WorkOverview {
  private readonly rootEl: HTMLElement;
  private readonly coverageEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private orchestrationEl: HTMLElement | undefined;
  private readonly analysisEl: HTMLElement;
  private readonly measuredEl: HTMLElement;
  // 描き直しで開閉を戻さない（verify-work-overview#O-82dm）。
  private readonly expandedRoles = new Set<string>();
  private errExpanded = false;
  // 描き直しで開閉を戻さない（verify-work-overview#O-83k）。
  private readonly expandedFindings = new Set<string>();
  private readonly findingsEl: HTMLElement;
  private readonly logHeadEl: HTMLElement;
  private readonly logSumEl: HTMLElement;
  // renderAnalysisView は渡した要素を空にするので、l3El と referenceEl を同じ要素にしない。
  private readonly l3El: HTMLElement;
  private readonly referenceHeadEl: HTMLElement;
  private readonly referenceEl: HTMLElement;
  private readonly graph: WorkGraph;
  private readonly inspector: AgentInspector;
  private mode: WorkViewMode = "summary";
  private visible = true;
  private payload: WorkModelPayload | undefined;
  private semanticPayload: SemanticModelPayload | undefined;
  // 値の意味は src/protocol.ts#ConversationSnapshot の semanticView と同じ。
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
  private llmProgress: (LlmRunProgress & { receivedAt: number | undefined }) | undefined;
  private llmFailure: LlmRunFailure | undefined;
  private llmRunLineEl: HTMLElement | undefined;
  // 未実行は失敗ではないので、llmFailure にも LLM 面の attemptFailed にも混ぜない（R-ANL-11）。
  private llmRefusal: string | undefined;
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
  private readonly decoratedToolUseIds = new Set<string>();
  // saveFailed のとき「保存済み」と表示しない（R-DSP-01, verify-work-overview#O-84c）。
  private sessionSummary: { text: string; model: string; saveFailed?: boolean } | undefined;
  private summaryRunning = false;
  private gistExpanded = false;
  private gistResizeObserver: ResizeObserver | undefined;
  private summaryFailure: string | undefined;

  constructor(
    private readonly workEl: HTMLElement,
    private readonly tabId: string,
    private readonly toolEvidence?: {
      has(toolUseId: string): boolean;
      navigate(toolUseId: string): void;
    },
    // prev の面を隠す前に呼び、返した関数は next の面を出した後に呼ぶ。src/webview/tab.ts#Tab の switchWorkViewScroll がこの順序で位置を退避・復元する。
    private readonly onWorkViewChange?: (prev: WorkViewMode, next: WorkViewMode) => (() => void) | void,
    private readonly conversation?: {
      has(turnId: string): boolean;
      navigate(turnId: string): void;
    },
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
    // `analysis-view` は renderAnalysisView が描く中身の CSS を効かせるために要る。
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
    this.referenceEl.appendChild(span("wo-empty", l10n.t("Statistical analysis has not been run yet.")));
    this.syncReferenceVisibility();
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
    // 実行ボタンを描く l3LlmEl を先頭に置き、結果をボタンの下へ伸ばす（R-ANL-11, R-ANL-12, verify-work-overview#O-71b）。
    this.llmEl.append(this.l3LlmEl, this.referenceHeadEl, this.referenceEl);
    this.analysisEl.append(this.measuredEl, this.subSwitchEl, this.scriptEl, this.llmEl);
    this.applyAnalysisSub();

    this.logHeadEl = div("wl-head");
    this.logSumEl = div("wl-sum");
    this.logHeadEl.appendChild(this.logSumEl);
    this.logHeadEl.hidden = true;

    this.inspector = new AgentInspector(this.tabId, () => this.graph.onInspectorClosed());
    this.graph = new WorkGraph(this.tabId, this.inspector, this.graphScrollPort);

    // 本番からは呼ばれない。検査の駆動点で、外すと verify-work-overview#O-63 が落ちる。
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


  // src/webview/tab.ts が workEl へ行を足し続けるので、applyMode は自前の要素以外を隠す形で切り替える。
  mount(): void {
    this.workEl.insertBefore(this.logHeadEl, this.workEl.firstChild);
    this.workEl.insertBefore(this.rootEl, this.logHeadEl.nextSibling);
    this.workEl.insertBefore(this.graph.rootEl, this.rootEl.nextSibling);
    this.workEl.insertBefore(this.analysisEl, this.graph.rootEl.nextSibling);
    this.applyMode();
  }

  // 値が同じでも描き直す。押下時に画面側だけで実行中表示へ切り替えているので、捨てるとボタンが戻らない（verify-webview-wiring#D6-5b）。
  setLlmRunning(running: boolean, progress?: LlmRunProgress, failure?: LlmRunFailure, refusal?: string): void {
    this.llmRunning = running;
    if (running) {
      this.llmFailure = undefined;
      this.llmRefusal = undefined;
      this.analysisFailure = undefined;
      // receivedAt は進捗行の経過表示専用。nowMs と TimeBucketView へ渡さない（verify-time-buckets#TB-7b）。
      if (progress !== undefined) this.llmProgress = { ...progress, receivedAt: Date.now() };
    } else {
      this.llmProgress = undefined;
      this.llmFailure = failure;
      this.llmRefusal = refusal;
    }
    this.l3Dirty = true;
    if (this.mode === "analysis") this.renderAnalysisPanel();
  }

  showAnalysisFailure(reason: string): void {
    this.analysisFailure = reason;
    this.setAnalysisSub("ai");
    this.setMode("analysis");
    this.l3Dirty = true;
    this.renderAnalysisPanel();
  }

  // 進捗の行は tick のたびに書き替わるので live にしない。live にすると書き替えのたびに読み上げが走る。
  // tail は src/webview/llm-action-view.ts#renderLlmActionView が描く不可用の一般文言の後ろへ置くため。実行ボタンの隣だと見出しより先に詳細が出る。
  private llmRunLineText(): { text: string; live: boolean; place: "run" | "tail" } | null {
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
    // lastTickMs が未着なら外挿の起点が無いので、Host の elapsedMs をそのまま出す。自前の時計で補わない（verify-time-buckets#TB-7c）。
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
  // 置き場を querySelector で探さない。クラス選択子の字面が check-protocol-guards の S5-T2-D4 に当たる。
  // S5-T2-D4 はコメントも数えるので、このファイルのコメントにもその字面を書かない。
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

  // renderLlmRunLine と同じ理由で、描き直しのたびに足す。
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

  // running はタブのドットと同じ src/webview/tab.ts#Tab の isActive で決まる。setTurnState のターン状態だけでは決めない（R-SES-02 / R-DSP-20）。
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

  // レポートは src/webview/main.ts#analysisReports が sessionId ごとに保持する。ここへ溜めない。
  setAnalysis(sessionId: string, filePath: string, report: AnalysisReport): void {
    this.hasReferenceReport = true;
    this.analysisEl.dataset.sessionId = sessionId;
    this.analysisFailure = undefined;
    this.renderAnalysisFailureLine();
    renderAnalysisView(this.referenceEl, sessionId, filePath, report);
    this.syncReferenceVisibility();
  }

  showAnalysis(sessionId: string, filePath: string, report: AnalysisReport): void {
    this.setAnalysis(sessionId, filePath, report);
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
    // R-DSP-20: semantic の写しは完了より古いことがあるので、planTools を持たない payload のときだけ NOW を補う（verify-work-overview#O-BG-2）。
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

  // ここから分析面を描き直さない。分析面は payload を読まず、payload は src/session-semantic.ts#WORK_MODEL_POST_INTERVAL_MS ごとに届くので、開いた内訳が閉じる。
  update(payload: WorkModelPayload | undefined): void {
    this.payload = payload;
    this.renderExecLogSummary();
    this.summaryDirty = true;
    if (this.mode === "summary") this.render();
    this.graph.update(payload);
  }

  updateSemantic(model: SemanticModelPayload | undefined, semanticView?: boolean): void {
    const previous = this.activeSemantic();
    const active = semanticView === false ? undefined : model;
    // 履歴 backfill 中は coverage だけを差し替えた shallow copy が何度も届くので、分析入力の参照が同じなら描き直さない。
    // Host からの semanticModel は postMessage の structured clone で参照が変わるので取りこぼさない（verify-work-overview#O-86）。
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
    this.renderExecLogSummary();
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

  // src/webview/tab.ts#Tab の setViewMode は setMode を通らずに作業面を離れるので、ここでも graph の可視を更新する（R-DSP-45, verify-work-graph-scale#GS-8）。
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.graph.setVisible(visible && this.mode === "graph");
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

  // src/webview/tab.ts が workEl へ行を足した後に呼ぶ。呼ばないと足した行が実行ログ以外の面にも見える。
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

  onPortScroll(): void {
    if (this.mode !== "graph") return;
    this.graph.onPortScroll();
  }

  tick(nowMs: number): void {
    this.lastTickMs = nowMs;
    this.graph.tick(nowMs);
    if (this.mode === "summary") this.renderPlan();
    if (this.mode === "summary" && this.turnRunning) this.refreshLive(nowMs);
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
    this.graph.setVisible(this.visible && this.mode === "graph");
    if (this.mode !== "graph" && this.inspector.isOpen()) this.inspector.close();
    this.analysisEl.hidden = this.mode !== "analysis";
    this.logHeadEl.hidden = this.mode !== "log" || this.logSumEl.childElementCount === 0;
    for (const child of Array.from(this.workEl.children)) {
      if (child === this.rootEl || child === this.graph.rootEl ||
          child === this.analysisEl || child === this.logHeadEl) continue;
      (child as HTMLElement).hidden = this.mode !== "log";
    }
  }

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

  // coverage を入れない。履歴 backfill の coverage だけの更新で分析結果を描き直さない（verify-work-overview#O-86）。
  // toolEvidence の可否は payload が同じまま変わるので analysisEvidenceKey が別に持つ。
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

  // 値・並び・百分率は Host の値のまま描き、集計・丸め・並べ替えを足さない（verify-work-overview#O-82s）。
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

  // 輪の区切りは Host の百分率を CSS の calc で積む。ここで比を計算しない（verify-work-overview#O-82s）。
  private renderTimeModule(view: TimeBucketView | undefined, tokens: MainTokenTotal | null): HTMLElement | null {
    if (view === undefined || view.firstAt === null || view.lastAt === null) return null;
    const mod = this.metricsModule("time", "TIME", l10n.t("Main processing time"));
    // src/protocol.ts#isTimeBucketsPayload は mainByModel の欠落を通す。
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
    const subOnly = span("wa-fx-i", l10n.t("Subagent only {0}", view.main.subOnlyMs == null ? l10n.t("Not measured") : formatDuration(view.main.subOnlyMs)));
    subOnly.dataset.fact = "sub-only";
    facts.appendChild(subOnly);
    legend.appendChild(facts);
    const body = div("wa-tm");
    body.append(ring, legend);
    mod.appendChild(body);
    return mod;
  }

  // R-ANL-23: 役割・省略したサブエージェント・外部実行の記録のどれも無いときだけモジュールを出さない。
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
    // R-ANL-24 / R-DSP-01: 読めなかった記録があるとき、一覧を外部実行の全件として見せない（verify-work-overview#O-82um）。
    const external = summary.externalRunsCoverage;
    if (external !== undefined) {
      mod.appendChild(div("wa-note wa-note-external")).textContent = external.readError
        ? l10n.t("The saved external run records could not be read; external runs may be missing")
        : l10n.t("{0} saved external run records could not be read; external runs may be missing", external.unreadableLines);
    }
    return mod;
  }

  // R-DSP-03: ローダーは実行中だけ、withLoader の側だけに出す（verify-work-overview#O-82p, verify-work-overview#O-82pk）。
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

  // R-ANL-23: モデルと effort は modelSource / effortSource が requested のとき要求値の印を付けて出す。
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

  // R-DSP-11: 測れていない値を 0 で描かない（verify-work-overview#O-82c）。
  private unmeasuredCell(): HTMLElement {
    const el = span("wa-v wa-unmeasured", "—");
    el.title = l10n.t("Not measured");
    return el;
  }

  // R-DSP-40: top と rest の分割・並びは src/exec-log-marks.ts#deriveFailureSummary が決める。
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

  // スクリプト分析の所見。この行の書き出しは verify-work-overview#O-82s が指標の区間の終端として探す。
  // 累計は数えていないので出さない（R-DSP-11）。
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
      // R-DSP-10: 印の無い family も見出しを残す（verify-work-overview#O-83Em）。
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

  // 番号・単位・開閉の文言・リンクの序数は Host の値を置き、webview で作らない（verify-work-overview#O-83h, verify-work-overview#O-83i）。
  private renderFindingRows(list: HTMLElement, findings: readonly ExecLogFindingView[]): void {
    for (const f of findings) {
      const row = document.createElement("article");
      row.className = "llm-finding-card wa-find";
      row.dataset.findingAnchor = f.anchor;
      row.dataset.family = f.family;
      row.tabIndex = -1;
      row.appendChild(div("llm-finding-num llm-finding-digits wa-find-num")).textContent = f.numberDigits;
      const body = div("llm-finding-body");
      // 直す先は候補として添える（R-DSP-01, verify-work-overview#O-83d）。category を出さない（verify-work-overview#O-83n）。
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
    const heading = this.summaryCode(l10n.t("ROSTER"), l10n.t("Agent roster"));
    group.appendChild(heading);
    if (state.settingsChanged) { // R-ORC-21
      const notice = div("wo-note orchestration-notice");
      notice.setAttribute("role", "status");
      notice.textContent = l10n.t("Orchestration settings changed. They apply from the next session; this conversation keeps its starting roster.");
      group.appendChild(notice);
    }
    const conductor = div("orchestration-conductor orchestration-row");
    conductor.append(span("orchestration-kind", l10n.t("CONDUCTOR")), span("orchestration-name", l10n.t("Main thread")));
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
      if (kind !== "runs") group.appendChild(label); // R-DSP-51
      group.appendChild(rows);
      return rows;
    };
    const row = (rows: HTMLElement, title: string, detail: string, badge: string, numbers = ""): HTMLElement => {
      const entry = document.createElement("li");
      entry.className = "orchestration-row";
      const name = span("orchestration-name", "");
      title.split(/( → | · |-|:)/).forEach((part, index) => {
        name.appendChild(span("orchestration-name-part", part));
        if (index % 2 === 1) name.appendChild(document.createElement("wbr"));
      });
      entry.append(span("orchestration-kind", badge), name, span("orchestration-model", detail), span("orchestration-numbers", numbers));
      rows.appendChild(entry);
      return entry;
    };
    const usageLabels: Record<string, string> = {
      input_tokens: l10n.t("Input"), output_tokens: l10n.t("Output"),
      cached_input_tokens: l10n.t("Cached input"), reasoning_output_tokens: l10n.t("Reasoning output"),
      cache_read_input_tokens: l10n.t("Cache read"), cache_creation_input_tokens: l10n.t("Cache write"),
      total_tokens: l10n.t("Total"), thinking_tokens: l10n.t("Thinking"), cache_read_tokens: l10n.t("Cache read"),
    };
    const usage = (value: OrchestrationView["agents"][number]["usage"]): string => value === null ? unknown
      : Object.entries(value).map(([key, count]) => `${usageLabels[key]} ${planTokens(count)}`).join(" · ");
    const children = list(l10n.t("Observed executions"), "agents");
    const recentAgents = [...state.agents].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, 50); // R-ORC-23
    for (const agent of recentAgents) {
      const appliedModel = agent.model ?? unknown; // R-ORC-22
      const appliedEffort = agent.effort ?? unknown; // R-ORC-22
      const entry = row(children, agent.role ?? agent.agentType ?? unknown,
        l10n.t("Applied {0} · {1}", appliedModel, appliedEffort), l10n.t("AGENT"));
      const numbers = entry.querySelector<HTMLElement>(".orchestration-numbers")!;
      numbers.textContent = `${clock(Date.parse(agent.firstSeenAt))} – ${clock(Date.parse(agent.lastActivityAt))} · ${usage(agent.usage)}`;
    }
    const externalRuns = list(l10n.t("External runs"), "runs");
    const recentRuns = [...state.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50); // R-ORC-23
    for (const run of recentRuns) {
      const outcome = run.outcome === "ok" ? l10n.t("Succeeded") : run.outcome === "failed" ? l10n.t("Failed")
        : run.outcome === "timeout" ? l10n.t("Timed out") : l10n.t("Refused");
      const entry = row(externalRuns, `${run.role} · ${EXECUTORS[run.executor].displayName}`,
        `${run.model ?? unknown} · ${run.effort ?? unknown}`, l10n.t("EXTERNAL"), `${outcome} · ${this.hudDuration(run.durationMs).textContent} · ${usage(run.usage)}` + (run.cwd ? ` · ${run.cwd}` : ""));
      if (run.outcome === "failed" || run.outcome === "timeout") entry.querySelector(".orchestration-numbers")!.classList.add("l-failure");
    }
    const requested = list(l10n.t("Starting roster (requested settings)"), "roster");
    for (const member of state.roster.agents) {
      row(requested, `${member.role} → ${member.agentKey}`,
        l10n.t("Requested {0} · {1}", member.model, member.effort ?? unknown), l10n.t("AGENT"));
    }
    for (const member of state.roster.external) {
      row(requested, `${member.role} → ${EXECUTORS[member.executor].displayName}`,
        l10n.t("Requested {0} · {1}", member.model ?? unknown, member.effort ?? unknown), l10n.t("EXTERNAL"));
    }
  }

  private render(): void {
    this.summaryDirty = false;
    this.rootEl.dataset.renderCount = String(++this.summaryRenderCount);
    this.coverageEl.textContent = "";
    this.gistResizeObserver?.disconnect();
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
      // R-DSP-05: 作業が無いときは NO_WORK_SUMMARY_TEXT で済ませ、renderHead / renderHud の空の足場を描かない。
      this.bodyEl.appendChild(span("wo-empty", NO_WORK_SUMMARY_TEXT));
      this.bodyEl.appendChild(this.renderPlanYou(view));
      return;
    }
    this.bodyEl.appendChild(this.renderHead(semantic, view));
    this.bodyEl.appendChild(this.renderHud(view, semantic));
    this.bodyEl.appendChild(this.renderPlanYou(view));
  }

  private renderCoverageRows(coverage: WorkModelPayload["coverage"], timeBuckets?: TimeBucketsCoverage): void {
    this.coverageEl.dataset.coverageSummary = coverage.summary;
    this.coverageEl.dataset.coverageDetails = coverage.details;
    this.coverageEl.dataset.phaseHistory = coverage.phaseHistory;
    const rows = coverageRows(coverage, timeBuckets);
    if (rows.length) this.coverageEl.appendChild(this.summaryCode("COV", l10n.t("Coverage scope")));
    for (const row of rows) {
      const el = span("wo-coverage-row", row.factsText ?? row.text);
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

  private renderHead(semantic: SemanticModelPayload | undefined, view: TimeBucketView | undefined): HTMLElement {
    const head = div("wo-head");
    const code = this.summaryCode(l10n.t("SUMMARY"), l10n.t("Session summary"));
    if (!this.turnRunning && view?.firstAt != null && view.lastAt != null) { // R-DSP-19
      code.appendChild(span("wo-code-right wo-head-range", `${clock(view.firstAt)} – ${clock(view.lastAt)}`));
    }
    head.appendChild(code);
    // firstPromptText 以外の値に「1 つ目のプロンプト」と名乗らせない（R-DSP-02 / R-DSP-01, verify-work-overview#O-50b）。
    // 要約があれば置き換え、モデル名を添える（R-DSP-25）。
    const firstPrompt = semantic?.firstPromptText;
    const summary = this.sessionSummary;
    if ((firstPrompt !== undefined && firstPrompt.length > 0) || summary !== undefined) {
      const gist = div("wo-gist");
      const text = div("wo-gist-t");
      text.lang = document.documentElement.lang;
      text.textContent = summary?.text ?? firstPrompt ?? "";
      text.id = `wo-gist-${this.tabId}`;
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "wo-gist-expand";
      expand.hidden = true;
      expand.setAttribute("aria-controls", text.id);
      const syncExpand = () => {
        expand.setAttribute("aria-expanded", String(this.gistExpanded));
        expand.textContent = this.gistExpanded ? l10n.t("Show less") : l10n.t("Show full text");
        text.classList.toggle("expanded", this.gistExpanded);
      };
      syncExpand();
      this.observeGistOverflow(text, expand, syncExpand);
      expand.onclick = () => { this.gistExpanded = !this.gistExpanded; syncExpand(); };
      const line = div("wo-gist-line");
      const source = div("wo-gist-n");
      source.textContent = summary !== undefined
        ? summary.saveFailed === true
          ? l10n.t("Summary: {0} — could not be saved (retry)", summary.model)
          : l10n.t("Summary: {0} (saved)", summary.model)
        : l10n.t("First prompt");
      line.append(source, this.buildSummaryButton(summary !== undefined));
      gist.append(line, text, expand);
      head.appendChild(gist);
    }
    if (this.summaryFailure !== undefined) {
      const failed = div("wo-gist-err");
      failed.setAttribute("role", "alert");
      failed.textContent = this.summaryFailure;
      head.appendChild(failed);
    }
    return head;
  }

  private observeGistOverflow(text: HTMLElement, expand: HTMLButtonElement, syncExpand: () => void): void {
    this.gistResizeObserver?.disconnect();
    this.gistResizeObserver = new ResizeObserver(() => {
      if (!text.isConnected || text.clientWidth === 0) return;
      // Measure the collapsed layout even while open, then restore it before paint.
      text.classList.remove("expanded");
      const overflows = text.scrollHeight > text.clientHeight;
      if (!overflows) this.gistExpanded = false;
      expand.hidden = !overflows;
      syncExpand();
    });
    this.gistResizeObserver.observe(text);
  }

  // R-DSP-25 / R-ANL-07。押下時の実行中表示は summaryRunning に入れないので、どの再描画でも元へ戻る。
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
    // 失敗の便で既存の要約を消さない（R-DSP-25）。
    this.summaryFailure = running ? undefined : failure;
    this.summaryDirty = true;
    if (this.mode === "summary") this.render();
  }

  private summaryCode(code: string, subtitle: string): HTMLElement {
    const line = div("wo-code");
    line.append(span("wo-code-label", code), span("", subtitle));
    return line;
  }

  private hudGroup(mode: "graph" | "analysis", code: string, subtitle: string, title: string): HTMLButtonElement {
    const group = document.createElement("button");
    group.type = "button";
    group.className = "wo-hud-group";
    group.dataset.pane = mode;
    group.title = title;
    const line = this.summaryCode(code, subtitle);
    line.appendChild(span("wo-code-right", "›"));
    group.appendChild(line);
    group.onclick = () => this.onViewChange(() => this.setMode(mode, true));
    return group;
  }

  private hudFigure(id: string, label: string, value: string | HTMLElement, small = false): HTMLElement {
    const figure = div(`wo-hud-figure${small ? " wo-hud-small" : ""}`);
    figure.dataset.figure = id;
    figure.append(span("wo-hud-key", label), typeof value === "string" ? span("wo-hud-value", value) : value);
    return figure;
  }

  private hudDuration(ms: number | null | undefined): HTMLElement {
    const value = span("wo-hud-value wo-hud-duration", "");
    if (ms === null || ms === undefined) { // R-DSP-11
      value.textContent = "—";
      value.title = l10n.t("Not measured");
      return value;
    }
    const seconds = Math.round(Math.max(0, ms) / 1000);
    const minutes = Math.floor(seconds / 60);
    const parts: [number, string][] = minutes >= 60
      ? [[Math.floor(minutes / 60), l10n.t("h")], [minutes % 60, l10n.t("m")]]
      : [[minutes, l10n.t("m")], [seconds % 60, l10n.t("s")]];
    for (const [number, unit] of parts) {
      const small = document.createElement("small");
      small.textContent = unit;
      value.append(String(number).padStart(value.childNodes.length ? 2 : 1, "0"), small);
    }
    return value;
  }

  private renderHud(view: TimeBucketView | undefined, semantic: SemanticModelPayload | undefined): HTMLElement {
    const hud = div("wo-hud");
    const graph = this.hudGroup("graph", l10n.t("03 GRAPH"), l10n.t("Time"), l10n.t("Open GRAPH (time breakdown and parallelism)"));
    const figures = div("wo-hud-figures");
    const elapsed = this.hudDuration(view?.spanMs);
    if (this.turnRunning && view?.spanMs !== null && view?.firstAt != null) {
      elapsed.dataset.liveElapsed = "session";
      elapsed.dataset.start = String(view.firstAt);
      elapsed.replaceChildren(...Array.from(this.hudDuration((this.nowMs(view) ?? view.lastAt ?? view.firstAt) - view.firstAt).childNodes));
    }
    figures.append(this.hudFigure("elapsed", l10n.t("Elapsed"), elapsed),
      this.hudFigure("processing", l10n.t("Processing"), this.hudDuration(view?.bars.totalMs)),
      this.hudFigure("parallel", this.turnRunning ? l10n.t("Parallelism") : l10n.t("Maximum parallelism"),
        view ? String(this.turnRunning ? view.currentParallel : view.maxConcurrency) : "—", true));
    graph.appendChild(figures);
    const duration = (ms: number | null) => ms === null ? l10n.t("Not measured") : formatDuration(ms);
    const swatch = (tone: string) => span(`wo-hud-swatch wo-hud-${tone}`, "");
    if (view) {
      const split = div("wo-hud-split");
      if (view.bars.mainMs !== null && view.bars.subMs !== null) {
        for (const [tone, ms] of [["main", view.bars.mainMs], ["sub", view.bars.subMs]] as const) {
          const part = span(`wo-hud-${tone}`, "");
          part.style.flex = `${ms} 1 0`;
          split.appendChild(part);
        }
      }
      const legend = div("wo-hud-note");
      legend.append(swatch("main"), l10n.t("Main {0}", duration(view.bars.mainMs)), "　",
        swatch("sub"), l10n.t("Subagent {0}", duration(view.bars.subMs)));
      const strip = div("wo-hud-strip");
      view.blocks.forEach((block) => {
        const row = div(`wo-hud-request${block.running && this.turnRunning ? " current" : ""}`);
        row.style.flex = `${block.durationMs ?? 1} 1 0`;
        const bar = div("wo-hud-request-bar");
        const processing = block.processingMs ?? null;
        if (block.strip != null) {
          for (const [tone, percent] of [["main", block.strip.processingPercent], ["wait", block.strip.replyPercent], ["remainder", block.strip.remainderPercent]] as const) {
            const part = span(`wo-hud-${tone}`, "");
            part.style.width = `${percent}%`;
            bar.appendChild(part);
          }
        }
        const number = block.requestNumber ?? "—";
        row.title = `${number} ${block.text.split(/\r?\n/, 1)[0]}\n${l10n.t("Processing {0} · Waiting for reply {1}", duration(processing), duration(block.replyMs))}`;
        row.append(bar, span("wo-hud-request-number", number));
        strip.appendChild(row);
      });
      const waits = div("wo-hud-note");
      waits.append(swatch("main"), l10n.t("Processing per request"), "　", swatch("wait"), l10n.t("Waiting for reply {0}", duration(view.main.replyMs)));
      graph.append(split, legend, strip, waits);
    }
    hud.append(graph, this.renderSummaryAnalysis(semantic?.summaryAnalysis));
    return hud;
  }

  private renderSummaryAnalysis(view: SemanticModelPayload["summaryAnalysis"]): HTMLElement {
    const group = this.hudGroup("analysis", l10n.t("04 ANALYSIS"), l10n.t("Analysis"), l10n.t("Open ANALYSIS (improvement candidates)"));
    const figures = div("wo-hud-figures");
    const count = (n: number | null | undefined) => n == null ? "—" : String(n);
    figures.append(this.hudFigure("improvable", view?.llmState === "current" ? l10n.t("Improvement candidates") : l10n.t("Improvement candidates (script analysis only)"), count(view?.improvableCount)),
      this.hudFigure("script", l10n.t("Script analysis findings"), count(view?.scriptFindingCount), true));
    if (view?.llmState === "current") figures.appendChild(this.hudFigure("llm", l10n.t("LLM analysis findings"), count(view.llmFindingCount), true));
    const breakdown = div("wo-hud-breakdown");
    const row = (label: string, n: number | null, percent: number | null) => {
      const item = div("wo-hud-breakdown-row");
      item.title = label;
      const track = span("wo-hud-track", "");
      const fill = span("wo-hud-fill", "");
      if (percent !== null) fill.style.width = `${percent}%`;
      track.appendChild(fill);
      item.append(span("wo-hud-breakdown-label", label), track, span("wo-hud-count", count(n)));
      breakdown.appendChild(item);
    };
    breakdown.appendChild(span("wo-hud-breakdown-head", l10n.t("Script analysis · Findings with candidates")));
    row(l10n.t("With candidates (of {0} total)", count(view?.scriptFindingCount)), view?.scriptCandidateCount ?? null, view?.scriptCandidatePercent ?? null);
    breakdown.appendChild(span("wo-hud-breakdown-head", view?.llmState === "current"
      ? l10n.t("LLM analysis · {0} · By improvement area · Rejected {1}", view.generatedAtLabel ?? "—", count(view.rejectedCount))
      : l10n.t("LLM Analysis")));
    const executionText = view?.llmExecutionState === "running" ? l10n.t("LLM analysis running")
      : view?.llmExecutionState === "attemptFailed" ? l10n.t("LLM analysis failed")
      : view?.llmExecutionState === "disabled" ? l10n.t("LLM analysis disabled") : undefined;
    if (executionText) breakdown.appendChild(span("wo-hud-status", executionText));
    for (const area of view?.llmAreas ?? []) row(area.label, area.count, area.percent);
    if (view?.llmState !== "current") breakdown.appendChild(span("wo-hud-none", view === undefined ? l10n.t("Not measured") : view.llmState === "stale"
      ? l10n.t("Results are out of date · Run again to see counts by improvement area")
      : executionText ? l10n.t("Counts unavailable") : l10n.t("Not run · Run to see counts by improvement area")));
    group.append(figures, breakdown);
    return group;
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
    heading.textContent = l10n.t("EARLIER REQUESTS {0} requests", blocks.length);
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
      // R-DSP-34: 手順は宣言の履歴だけから数え、同一性は PLAN と同じ planStepKey で決める（verify-work-overview#O-EARLIER-stepsm）。
      const steps = new Set(history?.flatMap(entry => entry.kind === "todos" ? entry.items.map(item => planStepKey(entry, item)) : []));
      const count = history?.length ? String(steps.size) : "—";
      const usage = this.planUsage?.blocks.find(value => value.blockId === block.blockId);
      const elapsed = span("earlier-elapsed", block.durationMs === null ? "—" : formatDuration(block.durationMs));
      if (block.durationMs !== null && block.running && this.turnRunning) {
        elapsed.dataset.liveElapsed = "block";
        elapsed.dataset.start = String(block.start);
        elapsed.textContent = formatDuration(Math.max(block.durationMs, (this.nowMs(view) ?? block.end) - block.start));
      }
      const stats = span("earlier-stats", "");
      stats.append(at, ` · ${l10n.t("{0} steps", count)} · ${l10n.t("{0} tokens", planTokens(usage?.slices.length ? usage.tokens : null))}`);
      const duration = span("earlier-duration", "");
      if (block.running && this.turnRunning) duration.append(l10n.t("Running"), " ");
      duration.appendChild(elapsed);
      stats.title = l10n.t("Claude tokens. Cache read: {0}", planTokens(usage?.slices.length ? usage.cacheRead : null));
      const title = span("earlier-title", block.text.split(/\r?\n/, 1)[0]);
      if (/[\u3040-\u30ff\u3400-\u9fff]/.test(title.textContent ?? "")) title.lang = "ja";
      const number = span("earlier-number", block.requestNumber ?? "—");
      if (block.running && this.turnRunning) number.classList.add("current");
      row.append(number, title, duration, stats);
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
        if (el.classList.contains("wo-hud-duration")) {
          el.replaceChildren(...Array.from(this.hudDuration(nowMs - start).childNodes));
        } else if (el.dataset.liveElapsed === "bg") {
          el.textContent = l10n.t("· Elapsed {0}", formatDuration(nowMs - start));
        } else {
          el.textContent = formatDuration(nowMs - start);
        }
      }
    }
  }

  // R-TAB-06。行と data-tool-use-id は src/webview/tab.ts が組む。
  private decorateExecLog(full: boolean): void {
    if (full) {
      for (const old of Array.from(this.workEl.querySelectorAll<HTMLElement>(".wl-tag"))) old.remove();
      for (const row of Array.from(this.workEl.querySelectorAll<HTMLElement>(".wl-flag, .wl-fail"))) {
        row.classList.remove("wl-flag", "wl-fail");
      }
      this.decoratedToolUseIds.clear();
    }
    const marks = this.execLogMarks ?? [];
    for (const mark of marks) {
      // findingAnchor の無い印は分析タブに飛び先が無いので貼らない（R-TAB-06, verify-work-overview#O-63b）。
      const anchor = mark.findingAnchor;
      if (anchor === undefined) continue;
      if (this.decoratedToolUseIds.has(`${mark.toolUseId}|${anchor}`)) continue;
      const row = this.workEl.querySelector<HTMLElement>(`:is(.tool-row, .agent-card)[data-tool-use-id="${CSS.escape(mark.toolUseId)}"]`);
      if (row === null) continue;
      this.decoratedToolUseIds.add(`${mark.toolUseId}|${anchor}`);
      row.classList.add(mark.family === "failure" ? "wl-fail" : "wl-flag");
      const tag = div("wl-tag");
      const button = document.createElement("button");
      button.type = "button";
      button.append(span("wl-tag-code", l10n.t("Flag")), " ", span("wl-tag-label", mark.label), ` ${mark.ordinalLabel ?? ""} `, span("wl-tag-target", l10n.t("→ ANALYSIS")));
      button.dataset.findingAnchor = anchor;
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.revealFinding(anchor);
      };
      tag.appendChild(button);
      // 行の本文へ置くと、行を閉じたままでは見えない（R-TAB-06, verify-work-overview#O-72e）。
      const summary = row.querySelector<HTMLElement>(":scope > summary");
      (summary !== null ? summary : row).appendChild(tag);
    }
    this.renderExecLogSummary();
  }

  // R-TAB-07: totalToolCount; totalFailCount; execLogMarks; renderExecLogSummary
  private renderExecLogSummary(): void {
    this.logSumEl.textContent = "";
    const line = div("wl-code");
    line.append(span("l-label", l10n.t("LOG")), span("", l10n.t("Execution record")));
    if (this.payload?.coverage.summary === "complete") {
      const agents = this.payload.phases.reduce((total, phase) => total + phase.agentCount, 0);
      line.appendChild(span("wl-totals", l10n.t("Tools {0} calls · Failures {1} · Subagents {2}", this.totalToolCount(this.payload), this.totalFailCount(this.payload), agents)));
    }
    this.logSumEl.appendChild(line);
    const anchored = (this.execLogMarks ?? []).filter((m) => m.findingAnchor !== undefined);
    if (anchored.length > 0) {
      const flags = div("wl-flags");
      const code = div("wl-code");
      code.append(span("l-label", l10n.t("FLAGS")), span("wl-sum-n", l10n.t("Flags {0}", anchored.length)));
      flags.appendChild(code);
      const byAnchor = new Map<string, { label: string; count: number; failure: boolean }>();
      for (const mark of anchored) {
        const anchor = mark.findingAnchor!;
        const cur = byAnchor.get(anchor) ?? { label: mark.label, count: 0, failure: mark.family === "failure" };
        cur.count++;
        byAnchor.set(anchor, cur);
      }
      for (const [anchor, { label, count, failure }] of byAnchor) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "wl-chip";
        if (failure) chip.append(span("l-failure", "✗ "));
        chip.append(span("wl-tag-label", label), span("wl-flag-count", String(count)), " ›");
        chip.dataset.findingAnchor = anchor;
        chip.onclick = () => this.revealFinding(anchor);
        flags.appendChild(chip);
      }
      this.logSumEl.appendChild(flags);
    }
    this.logHeadEl.hidden = this.mode !== "log";
  }
}
