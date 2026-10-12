import * as l10n from "@vscode/l10n";
import { ROW_H } from "./row-frame";
import { planConductorRunning, planFrame, planLive, planMemberEnd, planNow, planRowIndexAt, planRowPeriod, planRowProvisional, planSpansMs, UNMEASURED_LABEL, type PlanFrameMembers, type PlanRowPeriod, type PlanSpan } from "../plan-steps";
import type { SemanticModelPayload, TimeBucketsCoverage, WorkAgentNode, WorkModelPayload } from "../protocol";
import type { AgentSpanView, BackgroundTaskSpanView, ConductorModel, PlanBlockStepView, RequestBlockView, TimeBucket, TimeBucketInterval, TimeBucketView } from "../time-buckets";
import type { AgentInspector, InspectorAxis } from "./agent-inspector";
import { failureCount } from "./failure-count";
import { formatDuration, clock, dayClock } from "./format";
import { formatDateTime } from "./l10n";
import { termSpan, type TermKey } from "./term";

export const NO_WORK_SUMMARY_TEXT = l10n.t("No work summary yet.");

export function agentLabel(a: { description?: string }): string {
  return a.description || l10n.t("Subagent");
}

type WorkCoverageView = WorkModelPayload["coverage"];

export interface CoverageBackfillHint {
  backfillPendingCount?: number;
  backfillStalled?: boolean;
  backfillPhase?: "events" | "transcript";
  backfillDone?: boolean;
  backfillUnreachableCount?: number;
}

export interface CoverageRow {
  factsText?: string;
  scope: "summary" | "details";
  state?: string;
  text: string;
  detail?: string;
}

export function coverageRows(coverage: WorkCoverageView & CoverageBackfillHint, timeBuckets?: TimeBucketsCoverage, onlyProblems = false): CoverageRow[] {
  const summaryGaps: string[] = [];
  const reasons: string[] = [];
  if (timeBuckets?.sessionReadError !== undefined) {
    summaryGaps.push(l10n.t("Could not fully read the session record, so measured times are not shown"));
    reasons.push(timeBuckets.sessionReadError);
  }
  if (timeBuckets?.subagentReadError !== undefined) {
    summaryGaps.push(l10n.t("Could not read the subagent records, so subagent time is not included in the totals"));
    reasons.push(timeBuckets.subagentReadError);
  }
  if (timeBuckets?.transcriptReadFailureCount !== undefined) {
    summaryGaps.push(l10n.t("Could not read the records of {0} subagents, so their time is not included in the totals", timeBuckets.transcriptReadFailureCount));
  }
  if (timeBuckets?.omittedTranscriptCount !== undefined) {
    summaryGaps.push(l10n.t("The records of {0} subagents were not read because of the limit, so their time is not included in the totals", timeBuckets.omittedTranscriptCount));
  }
  if (timeBuckets?.malformedMetaCount !== undefined) {
    summaryGaps.push(l10n.t("The records of {0} subagents are malformed and are not included in the totals", timeBuckets.malformedMetaCount));
  }
  if (coverage.phaseHistory === "prefix-compacted") {
    summaryGaps.push(l10n.t("The oldest {0} phases are merged into \"Early work\"", coverage.compactedPhaseCount));
  }
  if (coverage.unreadableAgentCount !== undefined) {
    summaryGaps.push(l10n.t("{0} subagents are unreadable", coverage.unreadableAgentCount));
  }
  if (coverage.omittedTranscriptCount !== undefined) {
    summaryGaps.push(l10n.t("Records for {0} subagents were not read and are not included in the totals", coverage.omittedTranscriptCount));
  }
  if (coverage.untrackedBackgroundCount !== undefined) {
    summaryGaps.push(l10n.t("{0} background tasks are no longer tracked and are not included in the totals", coverage.untrackedBackgroundCount));
  }
  let summaryCauseExplained = false;
  if (coverage.hydrationUnconfirmed === "loading") {
    summaryCauseExplained = true;
    if (!onlyProblems) summaryGaps.push(l10n.t("History is still loading, so work before the restore is not yet included in the totals"));
  } else if (coverage.hydrationUnconfirmed === "failed") {
    summaryCauseExplained = true;
    summaryGaps.push(l10n.t("History restore failed, so work before the restore is not included in the totals"));
  }
  if (coverage.hierarchyIncomplete === true) {
    summaryCauseExplained = true;
    summaryGaps.push(l10n.t("Could not fully read the subagent list, so the unread work is not included in the totals"));
  }
  if (coverage.reducerErrorCount !== undefined) {
    summaryCauseExplained = true;
    summaryGaps.push(l10n.t("Aggregation failed for {0} events, which are not included in the totals", coverage.reducerErrorCount));
  }
  if (coverage.historyReadError !== undefined) {
    summaryCauseExplained = true;
    summaryGaps.push(l10n.t("Reading the record failed partway, so later work is not included in the totals"));
    reasons.push(coverage.historyReadError);
  }
  if (coverage.historyMalformedLineCount !== undefined) {
    summaryCauseExplained = true;
    summaryGaps.push(l10n.t("{0} lines of the record are malformed, so their work is not included in the totals", coverage.historyMalformedLineCount));
  }
  if (coverage.unparsedTaskInputCount !== undefined) {
    summaryCauseExplained = true;
    summaryGaps.push(l10n.t("The input of {0} Task tool calls could not be parsed, so they are not included in the totals", coverage.unparsedTaskInputCount));
  }
  if (coverage.evidenceFoldErrorCount !== undefined) {
    summaryGaps.push(l10n.t("{0} events are missing from the evidence index, so status and analysis lack their evidence", coverage.evidenceFoldErrorCount));
  }
  if (coverage.semanticDerivationFailed === "stale") {
    summaryGaps.push(l10n.t("Building the status failed; the status and graph are as of the last success"));
  } else if (coverage.semanticDerivationFailed === "unavailable") {
    summaryGaps.push(l10n.t("Building the status failed; the status and graph cannot be shown"));
  }
  const summaryParts = [
    coverage.summary !== "complete"
      ? summaryCauseExplained
        ? l10n.t("Summary: partially missing")
        : l10n.t("Summary: partially missing (earliest work not counted)")
      : summaryGaps.length > 0
        ? l10n.t("Summary: partially missing")
        : l10n.t("Summary: whole session"),
    ...summaryGaps,
  ];
  const backfillPending = coverage.backfillPendingCount ?? 0;
  const unreachable = coverage.backfillUnreachableCount ?? 0;
  const detailParts = [
    onlyProblems || (backfillPending === 0 && unreachable > 0)
      ? l10n.t("Details: partially missing")
      : coverage.details === "complete"
        ? l10n.t("Details: all shown")
        : l10n.t("Details: recent only"),
  ];
  if (!coverage.backfillDone && coverage.omittedToolCount !== undefined) {
    detailParts.push(l10n.t("{0} tools are not shown in the initial view", coverage.omittedToolCount));
  }
  if (!coverage.backfillDone && coverage.omittedMessageCount !== undefined) {
    detailParts.push(l10n.t("{0} messages are not shown in the initial view", coverage.omittedMessageCount));
  }
  if (!coverage.backfillDone) {
    const stalled = coverage.backfillStalled === true ? Math.max(backfillPending, unreachable) : 0;
    if (stalled > 0) {
      detailParts.push(l10n.t("Loading {0} older events into the run log has stalled", stalled));
    } else if (backfillPending > 0) {
      detailParts.push(
        coverage.backfillPhase === "transcript"
          ? l10n.t("Loading {0} older events into the run log (from the record)", backfillPending)
          : l10n.t("Loading {0} older events into the run log", backfillPending)
      );
    }
    if (unreachable > 0 && stalled === 0) {
      detailParts.push(
        l10n.t("{0} older events could not be read from the record, so they are not shown in the run log", unreachable)
      );
    }
  }
  if (coverage.untrackedApprovalCount !== undefined) {
    detailParts.push(l10n.t("{0} approvals are untracked", coverage.untrackedApprovalCount));
  }
  if (coverage.depthLimitedAgentCount !== undefined) {
    detailParts.push(l10n.t("{0} deeply nested items have unconfirmed hierarchy", coverage.depthLimitedAgentCount));
  }
  const rows: CoverageRow[] = [];
  if ((coverage.summary !== "complete" && (!onlyProblems || !summaryCauseExplained)) || summaryGaps.length > 0) {
    rows.push({
      scope: "summary",
      state: coverage.summary,
      text: summaryParts.join(" · "),
      factsText: [
        ...(coverage.summary !== "complete" && !summaryCauseExplained ? [l10n.t("Earliest work is not counted")] : []),
        ...summaryGaps,
      ].join(" · "),
      ...(reasons.length > 0 ? { detail: reasons.join(" / ") } : {}),
    });
  }
  if (coverage.details !== "complete" || detailParts.length > 1) {
    rows.push({ scope: "details", state: coverage.details, text: detailParts.join(" · ") });
  }
  return rows;
}

export function graphCoverageRows(coverage: WorkCoverageView & CoverageBackfillHint, timeBuckets?: TimeBucketsCoverage): CoverageRow[] {
  const normalized = { ...coverage, details: "complete" as const,
    omittedToolCount: undefined, omittedMessageCount: undefined,
    backfillPendingCount: coverage.backfillStalled ? coverage.backfillPendingCount : 0,
    backfillDone: (coverage.backfillUnreachableCount ?? 0) > 0 || coverage.backfillStalled ? false : coverage.backfillDone };
  const nonzero = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== 0)) as T;
  return coverageRows(nonzero(normalized), timeBuckets ? nonzero(timeBuckets) : undefined, true);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_W = 288;
const PAD_L = 8;
const PAD_R = 8;
const AXIS_H = 22;
const TOGGLE_PAD_PX = 5;
const NARROW_TOGGLE_H = 30;
const FOLD_PX = 30;
const FOLD_MIN_MS = 5 * 60_000;
const MINI_ARIA_LABEL = l10n.t("Activity distribution across the whole session. Click to zoom in on the rows at that time");
const MINI_UNFRAMED_ARIA_LABEL = l10n.t("The visible range covers every row. Click to center the rows at that time");
const GRID_MS = 15 * 60_000;
const LABEL_MS = 2 * GRID_MS;
const HOUR_MS = 2 * LABEL_MS;
export type GraphCategory = "g" | "t" | "d" | "a" | "wait" | "sub";
export function defaultGraphHidden(): Set<GraphCategory> { return new Set(["wait"]); }
export function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
const ZOOM_ARIA_LABEL = l10n.t("Press anywhere on the minimap to move the visible range to that time. Drag to move; double-click the frame for the whole session");
const MIN_WINDOW_ROWS = 3;
const MINI_DBL_MS = 400;
const MINI_DBL_PX = 6;
const FOCUS_NO_SCROLL: FocusOptions = { preventScroll: true };

type Zoom = { kind: "all" } | { kind: "window"; anchor: RowKey; anchorIndex: number; rowCount: number };
const ZOOM_ALL: Zoom = { kind: "all" };

interface ResolvedRange {
  start: number;
  end: number;
  axisStart: number;
  axisEnd: number;
  framed: boolean;
  band?: { i: number; j: number; running: boolean };
}

interface Band {
  i: number;
  j: number;
  rowCount: number;
}

interface PortMetrics {
  pinTop: number;
  portTop: number;
  portBottom: number;
  rowsTop: number;
  rowCount: number;
}

export interface GraphScrollPort {
  rect(): { top: number; bottom: number } | undefined;
  scrollBy(deltaPx: number): void;
  element(): HTMLElement;
  setHold(hold: boolean): void;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

type RowKey = string;

interface GraphRow {
  key: RowKey;
  kind: "block" | "item" | "conductor" | "agent" | "bg";
  item?: PlanBlockStepView;
  conductorSpans?: PlanSpan[];
  conductorOpenFrom?: number;
  conductorIntervals?: TimeBucketInterval[];
  conductorTail?: number;
  conductorModels?: ConductorModel[];
  block?: RequestBlockView;
  agent?: AgentSpanView;
  bgTask?: BackgroundTaskSpanView;
  parentBlock?: RequestBlockView;
  parentItem?: RowKey;
  members?: { agents: AgentSpanView[]; bgTasks: BackgroundTaskSpanView[] };
  // Head rows only: the number and title src/plan-steps.ts#planFrame gives both GRAPH and ANALYSIS.
  number?: string;
  title?: string;
  // Head and member rows: src/plan-steps.ts#planRowPeriod / #planMemberEnd at this render's now; undefined is "nothing started".
  period?: PlanRowPeriod;
  provisional?: boolean;
  // What the row occupies on the time axis (period, conductor work, live tail), for layout only.
  extent: [number, number];
}

type FoldKind = "reply" | "confirm" | "unobserved";

function isFoldBucket(bucket: TimeBucket): bucket is "reply" | "confirm" {
  return bucket === "reply" || bucket === "confirm";
}

interface WaitFold {
  start: number;
  end: number;
  kind: FoldKind;
  backgroundOverlapMs?: number;
  open?: boolean;
}

interface ScaleFold {
  start: number;
  end: number;
  x0: number;
  x1: number;
  kind: FoldKind;
  backgroundOverlapMs?: number;
  open?: boolean;
  cut: boolean;
}

interface Scale {
  x(t: number): number;
  timeAt(x: number): number;
  folds: ScaleFold[];
  ticks: { t: number; elapsed: number }[];
  cutMs: number;
  elapsedTotal: number;
  offset: number;
  start: number;
  end: number;
  width: number;
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number | undefined>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  return el;
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  const glyph = document.createElement("span");
  glyph.className = `l-icon ${icon}`;
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph);
  button.addEventListener("click", onClick);
  return button;
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}


function bucketClass(bucket: TimeBucket): "g" | "t" | "d" | "a" {
  return bucket === "generate" ? "g" : bucket === "tool" ? "t" : bucket === "delegation" ? "d" : "a";
}

function bucketWord(bucket: TimeBucket): string {
  return bucket === "generate" ? l10n.t("LLM generation") : bucket === "tool" ? l10n.t("Tool execution")
    : bucket === "delegation" ? l10n.t("Waiting for subagent") : l10n.t("Waiting for your answer");
}

function segTitle(word: string, start: number, end: number | null, extra?: string): string {
  const timeRange = end === null ? `${clock(start)}– · ${l10n.t("Running")}` : `${clock(start)}–${clock(end)} · ${formatDuration(end - start)}`;
  return extra !== undefined ? `${word} ${timeRange} · ${extra}` : `${word} ${timeRange}`;
}

function titled<T extends SVGElement>(el: T, text: string): T {
  const t = svgEl("title", {});
  t.textContent = text;
  el.appendChild(t);
  return el;
}

function blockDuration(b: RequestBlockView, end: number): string {
  if (b.durationMs === null) return l10n.t("Not measured");
  return `${b.metrics?.provisional ? "≈" : ""}${formatDuration(b.running ? Math.max(b.durationMs, end - b.start) : b.durationMs)}`;
}

function clip(text: string, max: number): string {
  const line = text.split(/\r?\n/, 1)[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function buildScale(start: number, end: number, waits: readonly WaitFold[], linearWidth: number, offset: number,
  hidden: ReadonlySet<GraphCategory> = defaultGraphHidden(), compress = true): Scale {
  const gaps = waits.map((w) => ({ ...w, start: Math.max(start, w.start), end: Math.min(end, w.end),
    cut: (w.kind === "reply" && hidden.has("wait")) || (w.kind === "confirm" && hidden.has("a")) }))
    .filter((w) => w.end > w.start && (w.cut || (compress && w.end - w.start >= FOLD_MIN_MS)))
    .sort((a, b) => a.start - b.start);
  const folds = gaps.filter((w) => !w.cut);
  const foldedMs = gaps.reduce((acc, f) => acc + f.end - f.start, 0);
  const linearMs = Math.max(1, end - start - foldedMs);
  const foldPx = folds.length === 0 ? FOLD_PX : Math.min(FOLD_PX, linearWidth / (2 * folds.length));
  const linearPx = linearWidth - folds.length * foldPx;
  const pieces: { s: number; e: number; x0: number; x1: number; cut: boolean }[] = [];
  const scaledGaps: ScaleFold[] = [];
  let cursor = start, x = offset;
  for (const f of gaps) {
    if (f.start > cursor) {
      const w = (f.start - cursor) / linearMs * linearPx;
      pieces.push({ s: cursor, e: f.start, x0: x, x1: x + w, cut: false });
      x += w;
    }
    const w = f.cut ? 0 : foldPx;
    pieces.push({ s: f.start, e: f.end, x0: x, x1: x + w, cut: f.cut });
    scaledGaps.push({ ...f, x0: x, x1: x + w });
    x += w;
    cursor = f.end;
  }
  if (cursor < end || pieces.length === 0) {
    const w = (end - cursor) / linearMs * linearPx;
    pieces.push({ s: cursor, e: Math.max(end, cursor), x0: x, x1: x + w, cut: false });
    x += w;
  }
  const xOf = (t: number): number => {
    const c = Math.max(start, Math.min(end, t));
    for (const p of pieces) if (c >= p.s && c <= p.e) {
      return p.e <= p.s || p.cut ? p.x0 : p.x0 + (c - p.s) / (p.e - p.s) * (p.x1 - p.x0);
    }
    return x;
  };
  const timeAt = (px: number): number => {
    const c = Math.max(offset, Math.min(x, px));
    for (const p of pieces) if (!p.cut && p.x1 > p.x0 && c >= p.x0 && c < p.x1) {
      return p.s + (c - p.x0) / (p.x1 - p.x0) * (p.e - p.s);
    }
    return end;
  };
  const cutMs = gaps.filter((f) => f.cut).reduce((acc, f) => acc + f.end - f.start, 0);
  const elapsedTotal = Math.max(0, end - start - cutMs);
  const atElapsed = (elapsed: number): number => {
    let acc = 0;
    for (const p of pieces) {
      if (p.cut) continue;
      const d = p.e - p.s;
      if (elapsed <= acc + d) return p.s + elapsed - acc;
      acc += d;
    }
    return end;
  };
  const ticks: Scale["ticks"] = [];
  for (let elapsed = 0; elapsed <= elapsedTotal; elapsed += GRID_MS) {
    const t = atElapsed(elapsed);
    if (!gaps.some((f) => t > f.start && t < f.end)) ticks.push({ t, elapsed });
  }
  return { x: xOf, timeAt, folds: scaledGaps, ticks, cutMs, elapsedTotal, offset, start, end, width: offset + linearWidth + PAD_R };
}

export function graphTotalText(scale: Pick<Scale, "cutMs" | "elapsedTotal">): string {
  return scale.cutMs > 0
    ? l10n.t("Total {0} (excluding hidden waits {1})", elapsedLabel(scale.elapsedTotal), elapsedLabel(scale.cutMs))
    : l10n.t("Total {0}", elapsedLabel(scale.elapsedTotal));
}

export function graphTickLabels(scale: Scale, measure: (text: string) => number = (text) => text.length * 6): { t: number; elapsed: number; x: number; anchor: "start" | "middle" | "end"; text: string }[] {
  const taken: { lo: number; hi: number }[] = [];
  const labels: ReturnType<typeof graphTickLabels> = [];
  const candidates = [{ t: scale.end, elapsed: scale.elapsedTotal, end: true },
    ...scale.ticks.filter((t) => t.elapsed % LABEL_MS === 0)
      .sort((a, b) => a.elapsed % HOUR_MS - b.elapsed % HOUR_MS || a.elapsed - b.elapsed)
      .map((t) => ({ ...t, end: false }))];
  for (const tick of candidates) {
    const text = elapsedLabel(tick.elapsed), w = measure(text) + 2;
    const anchor = tick.end ? "end" : tick.elapsed === 0 ? "start" : "middle";
    const x = tick.end ? Math.max(scale.offset + w, scale.x(tick.t)) : scale.x(tick.t);
    const lo = anchor === "end" ? x - w : anchor === "start" ? x : x - w / 2, hi = lo + w;
    if (lo < scale.offset || hi > scale.width - PAD_R + 2 || taken.some((s) => hi + 3 > s.lo && lo - 3 < s.hi)) continue;
    taken.push({ lo, hi });
    labels.push({ ...tick, x, anchor, text });
  }
  return labels;
}

export class WorkGraph {
  readonly rootEl: HTMLElement;
  private readonly coverageEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly headEl: HTMLElement;
  private readonly zoomBarEl: HTMLElement;
  private readonly zoomRangeEl: HTMLElement;
  private readonly zoomAllEl: HTMLButtonElement;
  private readonly zoomLiveEl: HTMLElement;
  private readonly miniEl: SVGSVGElement;
  private readonly legendEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly axisEl: SVGSVGElement;
  private readonly bodyEl: HTMLElement;
  private readonly chartPaneEl: HTMLElement;
  private readonly chartEl: SVGSVGElement;
  private readonly emptyEl: HTMLElement;
  private payload: WorkModelPayload | undefined;
  private semantic: SemanticModelPayload | undefined;
  private semanticView: boolean | undefined;
  private zoom: Zoom = ZOOM_ALL;
  private lastRange: ResolvedRange | undefined;
  private lastBand: Band | undefined;
  private pendingReanchor = 0;
  private drag: { pointerId: number; off: number; miniLeft: number; miniWidth: number; moved: boolean } | undefined;
  private lastMiniDown: { x: number; y: number; pointerType: string; timer: number } | undefined;
  private announcePending = false;
  private rows: GraphRow[] = [];
  private rowEls = new Map<RowKey, SVGGElement>();
  private selectedKey: RowKey | undefined;
  private openKey: RowKey | undefined;
  private readonly expandedItems = new Set<RowKey>();
  private pendingToggleFocus: RowKey | undefined;
  private readonly toggleLayerEl: HTMLElement;
  private readonly expandAllEl: HTMLButtonElement;
  private readonly collapseAllEl: HTMLButtonElement;
  private hiddenCategories = defaultGraphHidden();
  private rowHeight = ROW_H;
  private labelWidth = LABEL_W;
  private narrow = false;
  private miniScale: Scale | undefined;
  private readonly totalEl: HTMLElement;
  private readonly timelineEl: HTMLElement;
  private visible = false;
  private dirty = false;
  private running = false;
  private lastTickMs: number | undefined;
  private renderCount = 0;
  private rafId: number | undefined;
  constructor(
    private readonly tabId: string,
    private readonly inspector: AgentInspector,
    private readonly scrollPort?: GraphScrollPort,
    private readonly modelDisplayName: (model: string) => string | undefined = model => model
  ) {
    this.rootEl = document.createElement("div");
    this.rootEl.className = "work-graph";
    this.rootEl.id = `wg-panel-${this.tabId}`;
    this.rootEl.setAttribute("role", "tabpanel");
    this.rootEl.setAttribute("aria-labelledby", `wotab-graph-${this.tabId}`);
    this.rootEl.tabIndex = 0;

    this.coverageEl = document.createElement("div");
    this.coverageEl.className = "wg-coverage";
    this.stageEl = document.createElement("div");
    this.stageEl.className = "wg-stage";
    this.headEl = document.createElement("div");
    this.headEl.className = "wg-head";
    this.zoomBarEl = document.createElement("div");
    this.zoomBarEl.className = "wg-zoom-bar";
    this.zoomRangeEl = document.createElement("span");
    this.zoomRangeEl.className = "wg-zoom-range";
    this.zoomAllEl = document.createElement("button");
    this.zoomAllEl.className = "wg-zoom-all";
    this.zoomAllEl.type = "button";
    this.zoomAllEl.textContent = l10n.t("Whole");
    this.zoomAllEl.title = l10n.t("Back to the whole session (Esc on a row, or double-click / quickly press the minimap frame twice also returns)");
    this.zoomAllEl.setAttribute("aria-pressed", "true");
    this.zoomAllEl.addEventListener("click", () => {
      if (this.zoom.kind === "all") return;
      this.clearSelection();
      this.setZoom(ZOOM_ALL, true);
    });
    this.zoomLiveEl = document.createElement("span");
    this.zoomLiveEl.className = "wg-zoom-live";
    this.zoomLiveEl.setAttribute("aria-live", "polite");
    this.zoomLiveEl.setAttribute("aria-atomic", "true");
    this.zoomBarEl.append(this.zoomRangeEl, this.zoomAllEl, this.zoomLiveEl);
    this.miniEl = svgEl("svg", { class: "wg-mini", role: "group", "aria-label": MINI_ARIA_LABEL });
    this.miniEl.addEventListener("pointerdown", (e) => this.onMiniPointerDown(e));
    this.miniEl.addEventListener("pointermove", (e) => this.onMiniPointerMove(e));
    this.miniEl.addEventListener("pointerup", (e) => this.onMiniPointerUp(e));
    this.miniEl.addEventListener("pointercancel", (e) => this.onMiniPointerUp(e));
    this.miniEl.addEventListener("lostpointercapture", (e) => this.onMiniPointerUp(e));
    this.miniEl.addEventListener("dblclick", (e) => this.onMiniDblClick(e));
    this.legendEl = document.createElement("div");
    this.legendEl.className = "wg-legend";
    this.legendEl.setAttribute("role", "group");
    this.legendEl.setAttribute("aria-label", l10n.t("Graph legend"));
    this.noteEl = document.createElement("div");
    this.noteEl.className = "wg-note";
    this.axisEl = svgEl("svg", { class: "wg-axis", "aria-hidden": "true" });
    this.totalEl = span("wg-total", "");
    this.timelineEl = document.createElement("div");
    this.timelineEl.className = "wg-timeline-head";
    const heading = document.createElement("div");
    this.expandAllEl = iconButton("l-icon-expand-all", l10n.t("Expand all items"), () => this.setExpanded(this.togglableKeys(), true));
    this.collapseAllEl = iconButton("l-icon-collapse-all", l10n.t("Collapse all items"), () => this.setExpanded([...this.expandedItems], false));
    const foldAll = document.createElement("span");
    foldAll.className = "wg-fold-all";
    foldAll.setAttribute("role", "group");
    foldAll.append(this.expandAllEl, this.collapseAllEl);
    heading.append(span("wg-code", "TIMELINE"), span("wg-caption", l10n.t("Request blocks and subagents")), foldAll, this.totalEl);
    this.timelineEl.append(heading, this.axisEl);
    this.zoomBarEl.prepend(span("wg-code", "MAP"), span("wg-caption wg-map-caption", l10n.t("Whole session")));
    this.headEl.append(this.zoomBarEl, this.miniEl, this.legendEl, this.timelineEl);
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "wg-body";
    this.chartPaneEl = document.createElement("div");
    this.chartPaneEl.className = "wg-chart-pane";
    this.chartEl = svgEl("svg", { class: "wg-chart", role: "group", "aria-label": l10n.t("Timeline of request blocks and subagents") });
    this.chartEl.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.toggleLayerEl = document.createElement("div");
    this.toggleLayerEl.className = "wg-toggle-layer";
    this.chartPaneEl.append(this.chartEl, this.toggleLayerEl);
    this.bodyEl.appendChild(this.chartPaneEl);
    this.emptyEl = span("wg-empty", NO_WORK_SUMMARY_TEXT);
    this.stageEl.append(this.headEl, this.bodyEl, this.emptyEl, this.inspector.rootEl);
    this.rootEl.append(this.coverageEl, this.noteEl, this.stageEl);

    (this.rootEl as HTMLElement & {
      laisoraSemanticUpdate?: (model: SemanticModelPayload | undefined, semanticView?: boolean) => void;
      laisoraTick?: (nowMs: number) => void;
      laisoraOpenAgent?: (agentId: string) => boolean;
    }).laisoraSemanticUpdate = (model, semanticView) => this.updateSemantic(model, semanticView);
    (this.rootEl as HTMLElement & {
      laisoraTick?: (nowMs: number) => void;
      laisoraOpenAgent?: (agentId: string) => boolean;
    }).laisoraTick = (nowMs) => this.tick(nowMs);
    (this.rootEl as HTMLElement & {
      laisoraOpenAgent?: (agentId: string) => boolean;
    }).laisoraOpenAgent = (agentId) => this.openAgentByWorkAgentId(agentId);
    (this.rootEl as HTMLElement & { laisoraPortResized?: () => void }).laisoraPortResized = () => this.onPortResized();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.onPortResized());
      observer.observe(this.chartPaneEl);
      if (this.scrollPort !== undefined) observer.observe(this.scrollPort.element());
    }
  }

  private onPortResized(): void {
    this.dirty = true;
    if (this.visible) this.scheduleRender();
  }

  onPortScroll(): void {
    const measurable = this.scrollPort?.rect() !== undefined;
    if (measurable && this.pendingReanchor !== 0) {
      const delta = this.pendingReanchor;
      this.pendingReanchor = 0;
      this.scrollPort?.scrollBy(delta * this.rowHeight);
    }
    if (this.zoom.kind !== "window" || !this.visible || !measurable) return;
    const band = this.resolveBand();
    if (band === undefined) return;
    const last = this.lastBand;
    if (last !== undefined && last.i === band.i && last.j === band.j) return;
    this.dirty = true;
    this.scheduleRender();
  }

  setVisible(visible: boolean): void {
    if (visible && !this.visible) {
      this.hiddenCategories = defaultGraphHidden();
      this.dirty = true;
    }
    this.visible = visible;
    if (visible && this.dirty) {
      if (this.rafId !== undefined) {
        cancelAnimationFrame(this.rafId);
        this.rafId = undefined;
      }
      this.render();
    }
  }

  update(payload: WorkModelPayload | undefined): void {
    this.payload = payload;
    this.dirty = true;
    if (this.visible) this.scheduleRender();
  }

  updateSemantic(model: SemanticModelPayload | undefined, semanticView?: boolean): void {
    this.semantic = model;
    this.semanticView = semanticView;
    this.dirty = true;
    if (this.visible) this.scheduleRender();
  }

  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.dirty = true;
    if (this.visible) this.scheduleRender();
  }

  tick(nowMs: number): void {
    this.lastTickMs = nowMs;
    if (!this.visible || !this.running) return;
    this.dirty = true;
    this.scheduleRender();
  }

  onInspectorClosed(): void {
    this.openKey = undefined;
    for (const el of this.rowEls.values()) el.classList.remove("open");
  }

  openAgentByWorkAgentId(agentId: string): boolean {
    const agent = this.findWorkAgent(agentId);
    const itemKey = agent === undefined ? undefined
      : this.rows.find((r) => r.kind === "item" && r.members?.agents.some((a) => a.toolUseId === agent.toolUseId))?.key;
    if (itemKey !== undefined && !this.expandedItems.has(itemKey)) {
      this.expandedItems.add(itemKey);
      const view = this.activeView();
      if (view !== undefined) this.rows = this.buildRows(view);
      this.dirty = true;
      if (this.visible) this.render();
    }
    const row = this.rows.find((r) => r.kind === "agent" && r.agent !== undefined && agent !== undefined && r.agent.toolUseId === agent.toolUseId);
    if (row !== undefined) {
      this.openRow(row);
      return true;
    }
    this.inspector.open({ kind: "agent", agentId, label: agentLabel(agent ?? {}) });
    return agent !== undefined;
  }

  private scheduleRender(): void {
    if (this.rafId !== undefined) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = undefined;
      if (this.visible) this.render();
    });
  }

  private activeView(): TimeBucketView | undefined {
    const semantic = this.semanticView === false ? undefined : this.semantic;
    return semantic?.timeBuckets;
  }

  private render(): void {
    this.dirty = false;
    this.rootEl.dataset.renderCount = String(++this.renderCount);
    const semantic = this.semanticView === false ? undefined : this.semantic;
    if (semantic !== undefined) this.rootEl.dataset.semanticMode = semantic.mode;
    else delete this.rootEl.dataset.semanticMode;
    this.coverageEl.textContent = "";
    const coverage = semantic?.coverage.base ?? this.payload?.coverage;
    if (coverage !== undefined) {
      for (const row of graphCoverageRows(coverage, semantic?.timeBucketsCoverage)) {
        const el = span("wg-coverage-row", row.text);
        el.dataset.coverageScope = row.scope;
        if (row.state !== undefined) el.dataset.state = row.state;
        if (row.detail !== undefined) el.title = row.detail;
        this.coverageEl.appendChild(el);
      }
    }
    this.coverageEl.hidden = this.coverageEl.childElementCount === 0;
    if (!this.coverageEl.hidden) {
      const heading = document.createElement("div");
      heading.append(span("wg-code", "COV"), span("wg-caption", l10n.t("Coverage scope")));
      this.coverageEl.prepend(heading);
    }
    const view = this.activeView();
    const hasData = view !== undefined && view.firstAt !== null && view.lastAt !== null && (view.blocks.length > 0 || view.agents.length > 0 || view.intervals.length > 0);
    this.emptyEl.hidden = hasData;
    this.headEl.hidden = !hasData;
    this.bodyEl.hidden = !hasData;
    this.rowEls = new Map();
    this.rows = [];
    if (!hasData || view === undefined) {
      this.resetZoom();
      this.lastRange = undefined;
      this.rootEl.dataset.zoom = "all";
      delete this.rootEl.dataset.windowBand;
      delete this.rootEl.dataset.windowBandSource;
      this.chartEl.textContent = "";
      this.axisEl.textContent = "";
      this.renderToggles([], 0);
      return;
    }
    const focusedKey = this.focusedRowKey();
    const active = document.activeElement;
    const toggleFocus = this.pendingToggleFocus ?? (active instanceof HTMLElement && this.toggleLayerEl.contains(active) ? active.dataset.rowKey : undefined);
    this.pendingToggleFocus = undefined;
    const legendFocus = document.activeElement instanceof HTMLElement && this.legendEl.contains(document.activeElement)
      ? document.activeElement.dataset.bucket : undefined;
    this.renderLegend(view);
    if (legendFocus) this.legendEl.querySelector<HTMLButtonElement>(`[data-bucket="${legendFocus}"]`)?.focus(FOCUS_NO_SCROLL);
    const chartWidth = Math.max(1, this.chartPaneEl.clientWidth);
    this.narrow = chartWidth < 640;
    this.labelWidth = this.narrow ? 0 : LABEL_W;
    this.rowHeight = this.narrow ? 44 : ROW_H;
    this.rootEl.classList.toggle("wg-narrow", this.narrow);
    this.renderNote(view);
    const tail = view.tail ?? { main: null, anyOpen: true };
    const end = this.windowEnd(view);
    this.rows = this.buildRows(view);
    this.chartEl.setAttribute("height", String(this.rows.length * this.rowHeight + 8));
    this.reanchor();
    const range = this.viewRange(view, end);
    this.lastRange = range;
    this.rootEl.dataset.zoom = this.zoom.kind;
    const waits: WaitFold[] = view.intervals
      .flatMap((i) => isFoldBucket(i.bucket)
        ? [{
          start: Math.max(i.start, range.start),
          end: Math.min(i.end, range.end),
          kind: i.bucket,
          backgroundOverlapMs: i.backgroundOverlapMs,
        }]
        : [])
      .filter((w) => w.end > w.start);
    const lastAt = view.lastAt as number;
    const uStart = Math.max(lastAt, range.start);
    const uEnd = Math.min(end, range.end);
    if (!tail.anyOpen && uEnd > uStart) {
      waits.push({ start: uStart, end: uEnd, kind: "unobserved" });
    } else if (tail.main === "confirm" && uEnd > uStart) {
      waits.push({ start: uStart, end: uEnd, kind: "confirm", open: true });
    }
    const scale = buildScale(range.start, range.end, waits, chartWidth - this.labelWidth - (this.narrow ? 0 : PAD_L) - PAD_R, this.labelWidth + (this.narrow ? 0 : PAD_L), this.hiddenCategories);
    this.totalEl.textContent = graphTotalText(scale);
    this.renderZoomBar(view, range);
    this.renderMini(view, end, tail, range);
    this.renderAxisLabels(scale);
    this.renderChart(view, scale, end, range, tail);
    if (this.selectedKey !== undefined && !this.rowEls.has(this.selectedKey)) this.selectedKey = undefined;
    if (toggleFocus !== undefined) {
      Array.from(this.toggleLayerEl.querySelectorAll<HTMLButtonElement>(".wg-item-toggle")).find((button) => button.dataset.rowKey === toggleFocus)?.focus(FOCUS_NO_SCROLL);
    }
    if (focusedKey !== undefined) {
      const el = this.rowEls.get(focusedKey);
      if (el !== undefined) {
        el.focus(FOCUS_NO_SCROLL);
      } else {
        this.zoomAllEl.focus(FOCUS_NO_SCROLL);
      }
    }
  }

  private focusedRowKey(): RowKey | undefined {
    const active = document.activeElement;
    if (!(active instanceof Element) || !this.chartEl.contains(active)) return undefined;
    const row = active.closest<SVGGElement>(".wg-row");
    return row?.dataset.rowKey;
  }

  private windowEnd(view: TimeBucketView): number {
    return planNow(view, this.lastTickMs, this.running);
  }

  private buildRows(view: TimeBucketView, now = this.windowEnd(view)): GraphRow[] {
    const rows: GraphRow[] = [];
    const live = planLive(view);
    const frame = planFrame(view);
    for (const row of frame.rows) {
      const parentBlock = row.block;
      const period = planRowPeriod(row, now, live);
      const provisional = planRowProvisional(row, period);
      const conductor = row.item === undefined ? { conductorSpans: row.conductorSpans, conductorOpenFrom: row.conductorOpenFrom,
        conductorIntervals: row.conductorWork.filter(interval => interval.bucket !== "reply"), conductorTail: row.conductorTail } : {};
      const intervals = row.item?.conductorIntervals ?? conductor.conductorIntervals ?? [];
      const blockEnd = planRowPeriod({ kind: "block", block: parentBlock, members: { agents: [], bgTasks: [] } }, now, live)!.end;
      const starts = [...(period ? [period.start] : []), ...intervals.map(interval => interval.start)];
      const ends = [...(period ? [period.end] : []), ...intervals.map(interval => interval.end)];
      const extent: [number, number] = starts.length === 0 ? [blockEnd, blockEnd] : [Math.min(...starts), Math.max(...ends)];
      const head = { item: row.item, parentBlock, period, provisional, extent, conductorModels: row.conductorModels, ...conductor };
      rows.push({ key: row.key, kind: "item", members: row.members, number: row.number, title: row.title, ...head });
      if (this.expandedItems.has(row.key)) {
        rows.push({ key: row.key.replace(/^item:/, "conductor:"), kind: "conductor", parentItem: row.key, ...head });
        this.memberRows(rows, row.members, now, live, parentBlock, row.key);
      }
    }
    this.memberRows(rows, frame.unplaced, now, live);
    return rows;
  }

  private memberRows(rows: GraphRow[], members: PlanFrameMembers, now: number, live: boolean, parentBlock?: RequestBlockView, parentItem?: RowKey): void {
    const period = (member: AgentSpanView | BackgroundTaskSpanView): Pick<GraphRow, "period" | "extent"> => {
      const end = planMemberEnd(member, now, live);
      return { period: { start: member.start, end, running: live && member.open, spans: [{ start: member.start, end }] }, extent: [member.start, end] };
    };
    for (const agent of members.agents) rows.push({ key: `agent:${agent.toolUseId}`, kind: "agent", agent, parentBlock, parentItem, ...period(agent) });
    for (const bg of members.bgTasks) rows.push({ key: `bg:${bg.toolUseId}`, kind: "bg", bgTask: bg, parentBlock, parentItem, ...period(bg) });
  }

  private subagentCount(row: GraphRow): number {
    return (row.members?.agents.length ?? 0) + (row.members?.bgTasks.filter((bg) => bg.subagent).length ?? 0);
  }

  private togglableKeys(): RowKey[] {
    return this.rows.filter((row) => row.kind === "item").map((row) => row.key);
  }

  private setExpanded(keys: readonly RowKey[], expanded: boolean, focusKey?: RowKey): void {
    for (const key of keys) {
      if (expanded) this.expandedItems.add(key); else this.expandedItems.delete(key);
    }
    this.pendingToggleFocus = focusKey;
    this.dirty = true;
    if (this.visible) this.render();
  }

  private drawPlanMarkers(g: SVGElement, block: RequestBlockView, scale: Scale, range: ResolvedRange, cy: number, span?: [number, number]): void {
    for (const marker of block.userMessages ?? []) {
      if (marker.at < range.start || marker.at > range.end) continue;
      if (span !== undefined && (marker.at < span[0] || marker.at > span[1])) continue;
      const mark = svgEl("path", { d: `M ${scale.x(marker.at)} ${cy - 9} v 18`, class: "wg-user-marker wg-group-line" });
      titled(mark, marker.text);
      g.appendChild(mark);
    }
  }

  private renderLegend(view: TimeBucketView): void {
    this.legendEl.textContent = "";
    this.legendEl.append(span("wg-code", "KEY"), span("wg-caption", l10n.t("Legend")));
    const items: [GraphCategory, TermKey][] = [
      ["g", "LLM generation"],
      ["t", "Tool execution"],
      ["sub", "Subagent"],
      ["d", "Waiting for subagent"],
      ["a", "Waiting for your answer"],
      ["wait", "Waiting for reply"],
    ];
    const totals = { g: view.main.generateMs, t: view.main.toolMs, d: view.main.subagentWaitMs, a: view.main.confirmMs, wait: view.main.replyMs, sub: view.bars.subMs };
    for (const [cls, label] of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("aria-pressed", String(!this.hiddenCategories.has(cls)));
      item.title = l10n.t("Toggle graph visibility (values stay the same)");
      item.addEventListener("click", () => {
        if (this.hiddenCategories.has(cls)) this.hiddenCategories.delete(cls); else this.hiddenCategories.add(cls);
        this.render();
      });
      item.className = "wg-legend-item";
      item.dataset.bucket = cls;
      const sw = span(`wg-sw wg-sw-${cls}`, "");
      sw.setAttribute("aria-hidden", "true");
      const term = termSpan(label);
      if (term instanceof HTMLElement) {
        term.removeAttribute("tabindex");
        item.setAttribute("aria-description", term.title);
        item.title = `${term.title}\n${item.title}`;
      }
      item.append(sw, term, span("wg-value", totals[cls] === null ? l10n.t("Not measured") : formatDuration(totals[cls])));
      this.legendEl.appendChild(item);
    }
    if (this.hiddenCategories.size > 0) {
      const status = span("wg-hidden-status", this.hiddenCategories.has("wait") || this.hiddenCategories.has("a")
        ? l10n.t("Hidden {0} · Values unchanged · Waits removed from the axis", this.hiddenCategories.size)
        : l10n.t("Hidden {0} · Values and scale unchanged", this.hiddenCategories.size));
      status.setAttribute("role", "status");
      const all = document.createElement("button");
      all.type = "button";
      all.textContent = l10n.t("Show all");
      all.dataset.bucket = "all";
      all.onclick = () => { this.hiddenCategories.clear(); this.render(); this.legendEl.querySelector<HTMLButtonElement>("button")?.focus(FOCUS_NO_SCROLL); };
      status.append(all);
      this.legendEl.append(status);
    }
  }

  private renderNote(view: TimeBucketView): void {
    this.noteEl.textContent = "";
    this.noteEl.hidden = true;
    if (view.fidelity === "inherited") {
      this.noteEl.hidden = false;
      this.noteEl.dataset.fidelity = "inherited";
      this.noteEl.textContent = l10n.t("LLM generation and waiting for reply are not shown because this path does not record actual times. Tool execution and waiting for your answer are measured.");
    }
    if (view.droppedIntervalCount > 0 || view.droppedBlockCount > 0) {
      this.noteEl.hidden = false;
      this.noteEl.append(span("wg-note-line", l10n.t("Older records were dropped because of the limit ({0} intervals · {1} work blocks).", view.droppedIntervalCount, view.droppedBlockCount)));
    }
  }

  private renderMini(view: TimeBucketView, end: number, tail: TimeBucketView["tail"], range: ResolvedRange): void {
    const mini = this.miniEl;
    mini.textContent = "";
    const defs = svgEl("defs", {});
    const pattern = svgEl("pattern", {
      id: `wg-hatch-mini-${this.tabId}`,
      width: "6",
      height: "6",
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    pattern.appendChild(svgEl("line", { x1: "0", y1: "0", x2: "0", y2: "6", stroke: "var(--vscode-descriptionForeground)", "stroke-width": "1.5", opacity: "0.5" }));
    defs.appendChild(pattern);
    mini.appendChild(defs);

    const start = view.firstAt as number;
    const lastAt = view.lastAt as number;

    const W = 1000;
    mini.setAttribute("viewBox", `0 0 ${W} 30`);
    mini.setAttribute("preserveAspectRatio", "none");
    const waits: WaitFold[] = view.intervals.filter((i) => isFoldBucket(i.bucket)).map((i) => ({ ...i, kind: i.bucket as FoldKind }));
    if (tail.main === "confirm" && end > lastAt) waits.push({ start: lastAt, end, kind: "confirm" });
    this.miniScale = buildScale(start, end, waits, W, 0, this.hiddenCategories, false);
    const px = this.miniScale.x;
    if (!this.hiddenCategories.has("wait")) mini.appendChild(svgEl("rect", { x: 0, y: 4, width: px(lastAt), height: 16, class: "wg-seg-wait", rx: 2 }));
    for (const i of view.intervals) {
      if (i.bucket === "reply" || this.hiddenCategories.has(bucketClass(i.bucket))) continue;
      const thin = i.bucket === "delegation";
      mini.appendChild(svgEl("rect", { x: px(i.start), y: thin ? 8 : 4, width: Math.max(0.8, px(i.end) - px(i.start)), height: thin ? 8 : 16, class: `wg-seg wg-seg-${bucketClass(i.bucket)}` }));
    }
    if (end > lastAt) {
      if (tail.main !== null && !this.hiddenCategories.has(bucketClass(tail.main))) {
        const thin = tail.main === "delegation";
        const ext = svgEl("rect", {
          x: px(lastAt),
          y: thin ? 8 : 4,
          width: Math.max(0.8, px(end) - px(lastAt)),
          height: thin ? 8 : 16,
          class: `wg-seg wg-seg-${bucketClass(tail.main)} open`,
          rx: 2,
        });
        ext.dataset.bucket = tail.main;
        ext.dataset.tail = "main";
        mini.appendChild(ext);
      } else if (!tail.anyOpen) {
        mini.appendChild(svgEl("rect", {
          x: px(lastAt),
          y: 4,
          width: Math.max(0.8, px(end) - px(lastAt)),
          height: 16,
          class: "wg-seg open",
          fill: `url(#wg-hatch-mini-${this.tabId})`,
          rx: 2,
        }));
      }
    }
    for (const a of this.hiddenCategories.has("sub") ? [] : view.agents) {
      const aEnd = planMemberEnd(a, end, planLive(view));
      mini.appendChild(svgEl("rect", { x: px(a.start), y: 23, width: Math.max(0.8, px(aEnd) - px(a.start)), height: 4, class: `wg-seg wg-seg-sub${a.open ? " open" : ""}`, rx: 1 }));
    }
    for (const bg of this.hiddenCategories.has("sub") ? [] : view.backgroundTasks ?? []) {
      const bgEnd = planMemberEnd(bg, end, planLive(view));
      mini.appendChild(svgEl("rect", { x: px(bg.start), y: 23, width: Math.max(0.8, px(bgEnd) - px(bg.start)), height: 4, class: `wg-seg wg-seg-sub${bg.open ? " open" : ""}`, rx: 1 }));
    }
    if (range.framed) {
      const winX = px(range.start);
      const winW = Math.max(3, px(range.end) - px(range.start));
      const winRect = svgEl("rect", {
        x: winX,
        y: 1,
        width: winW,
        height: 28,
        rx: 2,
        class: "wg-mini-win",
        "data-part": "window",
      });
      titled(winRect, `${l10n.t("Visible range {0} – {1}", dayClock(range.start), dayClock(range.end))}\n${ZOOM_ARIA_LABEL}`);
      mini.appendChild(winRect);

      mini.classList.add("can-drag");
      mini.setAttribute("aria-label", ZOOM_ARIA_LABEL);
    } else {
      mini.classList.remove("can-drag");
      mini.setAttribute("aria-label", this.zoom.kind === "window" ? MINI_UNFRAMED_ARIA_LABEL : MINI_ARIA_LABEL);
    }
  }

  private renderAxisLabels(scale: Scale): void {
    const svg = this.axisEl;
    svg.textContent = "";
    const offset = this.narrow ? 0 : this.labelWidth;
    this.timelineEl.style.gridTemplateColumns = this.narrow ? "minmax(0, 1fr)" : `${this.labelWidth}px minmax(0, 1fr)`;
    svg.setAttribute("viewBox", `${offset} 0 ${scale.width - offset} ${AXIS_H}`);
    svg.setAttribute("width", String(scale.width - offset));
    svg.setAttribute("height", String(AXIS_H));
    for (const { t } of [...scale.ticks, { t: scale.end }]) {
      svg.append(svgEl("line", { x1: scale.x(t), x2: scale.x(t), y1: AXIS_H - 3, y2: AXIS_H, class: "wg-axis-tick" }));
    }
    const context = document.createElement("canvas").getContext("2d");
    if (context) context.font = `10px ${getComputedStyle(this.rootEl).fontFamily}`;
    for (const tick of graphTickLabels(scale, context ? (text) => context.measureText(text).width : undefined)) {
      const label = svgEl("text", { x: tick.x, y: AXIS_H - 7, "text-anchor": tick.anchor, class: "wg-tick" });
      label.textContent = tick.text;
      label.dataset.elapsed = String(tick.elapsed);
      titled(label, clock(tick.t));
      svg.append(label);
    }
  }

  private renderChart(view: TimeBucketView, scale: Scale, end: number, range: ResolvedRange, tail: TimeBucketView["tail"]): void {
    const svg = this.chartEl;
    svg.textContent = "";
    const defs = svgEl("defs", {});
    const pattern = svgEl("pattern", {
      id: `wg-hatch-${this.tabId}`,
      width: "8",
      height: "8",
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    pattern.appendChild(svgEl("line", { x1: "0", y1: "0", x2: "0", y2: "8", stroke: "var(--vscode-descriptionForeground)", "stroke-width": "2", opacity: "0.5" }));
    defs.appendChild(pattern);
    svg.appendChild(defs);

    const height = this.rows.length * this.rowHeight + 8;
    svg.setAttribute("viewBox", `0 0 ${scale.width} ${height}`);
    svg.setAttribute("width", String(scale.width));
    svg.setAttribute("height", String(height));

    for (const { t } of scale.ticks) {
      const x = Math.round(scale.x(t)) + .5;
      svg.appendChild(svgEl("line", { x1: x, y1: 0, x2: x, y2: height - 6, class: "wg-tick-line" }));
    }

    const intervals = view.intervals.filter((i) => i.bucket !== "reply" && !this.hiddenCategories.has(bucketClass(i.bucket)) && i.end > range.start && i.start < range.end);
    const canvas = document.createElement("canvas").getContext("2d");
    const fontOf = (element: SVGTextElement): string => {
      const style = getComputedStyle(element);
      return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    };
    const fit = (text: string, width: number, font: string, middle = false): string => {
      if (!canvas) return text;
      canvas.font = font;
      if (canvas.measureText(text).width <= width) return text;
      for (let n = text.length - 1; n > 0; n--) {
        const candidate = middle ? `${text.slice(0, Math.ceil(n / 2))}…${text.slice(text.length - Math.floor(n / 2))}` : `${text.slice(0, n)}…`;
        if (canvas.measureText(candidate).width <= width) return candidate;
      }
      return "…";
    };
    const drawMain = (g: SVGElement, cy: number, wait: [number, number], host: [number, number], provisional: boolean, running: boolean, source: readonly TimeBucketInterval[] = intervals, drawWait = true, tailFrom = view.lastAt as number): void => {
      const [waitFrom, waitTo] = wait;
      const [from, to] = host;
      if (drawWait && waitTo > range.start && view.fidelity === "record" && !this.hiddenCategories.has("wait")) {
        const x0 = scale.x(Math.max(waitFrom, range.start));
        const x1 = scale.x(Math.min(waitTo, range.end));
        const rect = svgEl("rect", { x: x0, y: cy - (this.narrow ? 5 : 6), width: Math.max(1, x1 - x0), height: this.narrow ? 10 : 12, class: "wg-seg-wait" });
        rect.dataset.bucket = "reply";
        const clipWait = this.clipped(waitFrom, waitTo, range);
        if (clipWait !== undefined) rect.dataset.clipped = clipWait;
        g.appendChild(rect);
      }
      for (const i of source) {
        if (this.hiddenCategories.has(bucketClass(i.bucket))) continue;
        const hostS = Math.max(i.start, from);
        const hostE = Math.min(i.end, to);
        const s = Math.max(hostS, range.start);
        const e = Math.min(hostE, range.end);
        if (e <= s) continue;
        const half = this.segHalf(i.bucket);
        const seg = svgEl("rect", { x: scale.x(s), y: cy - half, width: Math.max(1.2, scale.x(e) - scale.x(s)), height: half * 2, class: `wg-seg wg-seg-${bucketClass(i.bucket)}` });
        seg.dataset.bucket = i.bucket;
        const word = bucketWord(i.bucket);
        const clipSeg = this.clipped(hostS, hostE, range);
        if (clipSeg !== undefined) seg.dataset.clipped = clipSeg;
        titled(seg, `${provisional ? "≈" : ""}${segTitle(word, s, e, clipSeg !== undefined ? l10n.t("Continues outside the window") : undefined)}`);
        g.appendChild(seg);
      }
      if (running && tail.main !== null && !this.hiddenCategories.has(bucketClass(tail.main)) && this.running && end > tailFrom && tailFrom < range.end) {
        if (tail.main !== "generate" || view.fidelity === "record") {
          const lastAtVal = tailFrom;
          const extX0 = scale.x(Math.max(lastAtVal, range.start));
          const extX1 = scale.x(Math.min(end, range.end));
          const half = this.segHalf(tail.main);
          const ext = svgEl("rect", {
            x: extX0,
            y: cy - half,
            width: Math.max(1.2, extX1 - extX0),
            height: half * 2,
            class: `wg-seg wg-seg-${bucketClass(tail.main)} open`,
          });
          ext.dataset.bucket = tail.main;
          ext.dataset.tail = "main";
          const clipExt = this.clipped(lastAtVal, end, range);
          if (clipExt !== undefined) ext.dataset.clipped = clipExt;
          const word = bucketWord(tail.main);
          titled(ext, segTitle(word, lastAtVal, null, clipExt !== undefined ? l10n.t("Continues outside the window") : undefined));
          g.appendChild(ext);
        }
      }
    };
    const toggles: { key: RowKey; y: number; label: string; expanded: boolean; g: SVGGElement }[] = [];
    this.rows.forEach((row, index) => {
      const y = index * this.rowHeight;
      const cy = y + (this.narrow ? 37 : 18);
      const labelY = y + 14;
      const labelEnd = (this.narrow ? scale.width : this.labelWidth) - 28;
      const head = row.kind === "block" || row.kind === "item";
      const labelStart = head ? (this.narrow ? 20 : 24) : (this.narrow ? 32 : 40);
      const addLabels = (name: string, meta: string, duration: string, full = name, model?: string, durationNote?: string): void => {
        const label = svgEl("text", { x: labelStart, y: labelY, class: "wg-lbl" });
        const value = svgEl("text", { x: labelEnd, y: labelY, "text-anchor": "end", class: "wg-row-value" });
        value.textContent = duration;
        if (durationNote !== undefined) titled(value, durationNote);
        const sub = svgEl("text", { x: labelStart, y: labelY + 13, class: "wg-lbl-dim" });
        g.append(label, value, sub);
        if (canvas) canvas.font = fontOf(value);
        const durationWidth = canvas ? canvas.measureText(duration).width : duration.length * 11.5;
        label.textContent = fit(name.split(/\r?\n/, 1)[0], Math.max(0, labelEnd - labelStart - durationWidth - 8), fontOf(label));
        titled(label, full);
        const metaWidth = labelEnd - labelStart;
        if (model && canvas && meta.endsWith(` · ${model}`)) {
          canvas.font = fontOf(sub);
          const suffix = ` · ${model}`;
          sub.textContent = fit(meta.slice(0, -suffix.length), metaWidth - canvas.measureText(suffix).width, fontOf(sub), true) + suffix;
        } else sub.textContent = fit(meta, metaWidth, fontOf(sub));
        titled(sub, meta);
      };
      const g = svgEl("g", { class: "wg-row", tabindex: "0", role: "button", transform: "" });
      g.dataset.rowKey = row.key;
      g.dataset.kind = row.kind;
      svg.appendChild(g);
      g.appendChild(svgEl("rect", { x: 0, y, width: scale.width, height: this.rowHeight, class: "wg-row-bg" }));
      if (head) {
        if (index > 0) g.append(svgEl("line", { x1: 0, x2: scale.width, y1: y, y2: y, class: "wg-group-line" }));
        const label = row.number;
        if (label) {
          const number = svgEl("text", { x: 0, y: labelY, class: "wg-block-number" });
          number.textContent = label;
          g.append(number);
        }
      }
      const outside = this.outside(row, range);
      if (outside !== undefined) {
        g.dataset.outside = outside;
        const mark = outside === "before"
          ? svgEl("text", { x: this.labelWidth + PAD_L, y: cy + 4, class: "wg-lbl-dim" })
          : svgEl("text", { x: scale.width - PAD_R, y: cy + 4, "text-anchor": "end", class: "wg-lbl-dim" });
        mark.textContent = outside === "before" ? `◂ ${l10n.t("Before the visible range")}` : `${l10n.t("After the visible range")} ▸`;
        g.appendChild(mark);
      }
      const drawBars = outside === undefined;
      const outsideSuffix = outside === undefined ? "" : outside === "before" ? ` · ${l10n.t("Before the visible range")}` : ` · ${l10n.t("After the visible range")}`;
      if (row.kind === "block" && row.block !== undefined) {
        const b = row.block;
        const bEnd = row.extent[1];
        const meta = [clock(b.anchorAt), b.toolCount > 0 ? l10n.t("{0} main-agent tool calls", b.toolCount) : "", b.agentCount > 0 ? l10n.t("{0} subagents", b.agentCount) : ""].filter(Boolean).join(" · ");
        const untilNext = b.durationMs !== null && view.blocks[view.blocks.length - 1] !== b ? b.kind === "plan" ? l10n.t("Until the next work block") : l10n.t("Until the next request") : undefined;
        addLabels(b.text, meta, blockDuration(b, bEnd), b.text, undefined, untilNext);
        if (drawBars) drawMain(g, cy, [b.anchorAt, b.end], [b.start, bEnd], row.provisional === true, row.period?.running === true);
        if (row.period?.running) g.classList.add("running");
        if (drawBars && b.kind === "plan") this.drawPlanMarkers(g, b, scale, range, cy);
        g.setAttribute("aria-label", `${b.kind === "plan" ? l10n.t("Work block") : l10n.t("Request block")} ${clip(b.text, 40)} ${clock(b.anchorAt)} ${blockDuration(b, bEnd)}${untilNext === undefined ? "" : ` (${untilNext})`}${outsideSuffix}`);
      } else if (row.kind === "item" && row.parentBlock !== undefined) {
        const item = row.item;
        const span = row.period;
        const running = span?.running === true;
        const provisional = row.provisional === true;
        const subagents = this.subagentCount(row);
        const expanded = this.expandedItems.has(row.key);
        const title = row.title ?? "";
        const number = row.number ?? "";
        const duration = span === undefined ? UNMEASURED_LABEL : `${provisional ? "≈" : ""}${formatDuration(planSpansMs(span.spans))}`;
        const facts = [span !== undefined ? clock(span.start) : item?.removed ? "" : item?.status === "completed" ? l10n.t("Completed") : l10n.t("Not started"),
          item?.removed ? l10n.t("Removed") : "",
          subagents > 0 ? l10n.t("{0} subagents", subagents) : ""].filter(Boolean).join(" · ");
        addLabels(title, `${facts} ${expanded ? "▾" : "▸"}`, duration, title);
        if (drawBars) {
          for (const part of span?.spans ?? []) {
            if (part.end < range.start || part.start > range.end) continue;
            const x0 = scale.x(Math.max(part.start, range.start));
            const x1 = scale.x(Math.min(part.end, range.end));
            const half = this.narrow ? 6 : 7;
            const bar = svgEl("rect", { x: x0, y: cy - half, width: Math.max(2, x1 - x0), height: half * 2, rx: 2,
              fill: "var(--l-chart-c4)", "fill-opacity": running ? .6 : 1 });
            bar.dataset.bucket = "span";
            titled(bar, segTitle(l10n.t("Step"), part.start, running && part.end === span!.end ? null : part.end));
            g.appendChild(bar);
          }
        }
        if (running) g.classList.add("running");
        g.setAttribute("aria-label", `${l10n.t("Step")} ${[number, clip(title, 40), span === undefined ? "" : clock(span.start), duration].filter(Boolean).join(" ")}${outsideSuffix}`);
        toggles.push({ key: row.key, y, label: [number, title, facts].filter(Boolean).join(" · "), expanded, g });
      } else if (row.kind === "conductor" && row.parentBlock !== undefined) {
        const item = row.item;
        const b = row.parentBlock;
        const conductorTail = item?.conductorTail ?? row.conductorTail;
        const running = planConductorRunning(row, row.period);
        addLabels(l10n.t("Conductor"), (row.conductorModels ?? []).map(entry =>
          [this.modelDisplayName(entry.model), entry.effort].filter(Boolean).join(" · ")).join(", "), "");
        if (drawBars) drawMain(g, cy, [0, 0], [Math.min(b.start, row.extent[0]), Math.max(row.extent[1], running ? end : -Infinity)], row.provisional === true,
          running, item?.conductorIntervals ?? row.conductorIntervals ?? [], false, conductorTail ?? undefined);
        if (running) g.classList.add("running");
        g.setAttribute("aria-label", `${l10n.t("Conductor")}${outsideSuffix}`);
      } else if (row.agent !== undefined) {
        const a = row.agent;
        const aEnd = row.extent[1];
        addLabels(agentLabel(a), [a.subagentType, a.model].filter(Boolean).join(" · "), formatDuration(aEnd - a.start), agentLabel(a), a.model);
        if (drawBars && !this.hiddenCategories.has("sub")) {
          const x0 = scale.x(Math.max(a.start, range.start));
          const x1 = scale.x(Math.min(aEnd, range.end));
          g.appendChild(svgEl("path", { d: `M ${x0} ${this.narrow ? cy - 8 : y - 2} V ${cy} h 4`, class: "wg-sub-link" }));
          const bar = svgEl("rect", { x: x0, y: cy - (this.narrow ? 3 : 4), width: Math.max(2, x1 - x0), height: this.narrow ? 6 : 8, class: `wg-seg wg-seg-sub${a.open ? " open" : ""}` });
          bar.dataset.bucket = "sub";
          const clipA = this.clipped(a.start, aEnd, range);
          if (clipA !== undefined) bar.dataset.clipped = clipA;
          titled(bar, segTitle(l10n.t("Subagent"), a.start, row.period?.running ? null : aEnd, clipA !== undefined ? l10n.t("Continues outside the window") : undefined));
          g.appendChild(bar);
        }
        if (row.period?.running) g.classList.add("running");
        const name = agentLabel(a);
        g.setAttribute("aria-label", `${a.description ? `${l10n.t("Subagent")} ` : ""}${clip(name, 40)} ${clock(a.start)} ${formatDuration(aEnd - a.start)}${outsideSuffix}`);
      } else if (row.kind === "bg" && row.bgTask !== undefined) {
        const bg = row.bgTask;
        const bgEnd = row.extent[1];
        const desc = bg.description || bg.taskId;
        const word = bg.subagent ? l10n.t("Subagent") : l10n.t("Background");
        addLabels(bg.subagent ? desc : `↻ ${desc}`, word, formatDuration(bgEnd - bg.start), desc);
        if (drawBars && !this.hiddenCategories.has("sub")) {
          const x0 = scale.x(Math.max(bg.start, range.start));
          const x1 = scale.x(Math.min(bgEnd, range.end));
          g.appendChild(svgEl("path", { d: `M ${x0} ${this.narrow ? cy - 8 : y - 2} V ${cy} h 4`, class: "wg-sub-link" }));
          const bar = svgEl("rect", { x: x0, y: cy - (this.narrow ? 3 : 4), width: Math.max(2, x1 - x0), height: this.narrow ? 6 : 8, class: `wg-seg wg-seg-sub${bg.open ? " open" : ""}` });
          bar.dataset.bucket = "sub";
          const clipBg = this.clipped(bg.start, bgEnd, range);
          if (clipBg !== undefined) bar.dataset.clipped = clipBg;
          titled(bar, segTitle(word, bg.start, row.period?.running ? null : bgEnd, clipBg !== undefined ? l10n.t("Continues outside the window") : undefined));
          g.appendChild(bar);
        }
        if (row.period?.running) g.classList.add("running");
        g.setAttribute("aria-label", `${word} ${clip(desc, 40)} ${clock(bg.start)} ${formatDuration(bgEnd - bg.start)}${outsideSuffix}`);
      }
      if (this.canOpen(row)) {
        const open = svgEl("text", { x: (this.narrow ? scale.width : this.labelWidth) - 14, y: labelY + 7, class: "wg-open", "aria-hidden": "true" });
        open.textContent = "›";
        open.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openRow(row);
        });
        g.appendChild(open);
      }
      g.addEventListener("click", () => this.select(row.key));
      g.classList.toggle("on", row.key === this.selectedKey);
      g.classList.toggle("open", row.key === this.openKey);
      this.rowEls.set(row.key, g);
    });
    this.renderToggles(toggles, (this.narrow ? scale.width : this.labelWidth) - 28);
  }

  private renderToggles(toggles: readonly { key: RowKey; y: number; label: string; expanded: boolean; g: SVGGElement }[], labelEnd: number): void {
    this.toggleLayerEl.textContent = "";
    for (const toggle of toggles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wg-item-toggle";
      button.dataset.rowKey = toggle.key;
      button.setAttribute("aria-expanded", String(toggle.expanded));
      button.setAttribute("aria-label", toggle.label);
      button.style.left = `${-TOGGLE_PAD_PX}px`;
      button.style.top = `${toggle.y}px`;
      button.style.width = `${labelEnd + TOGGLE_PAD_PX * 2}px`;
      button.style.height = `${this.narrow ? NARROW_TOGGLE_H : this.rowHeight}px`;
      button.addEventListener("click", () => this.setExpanded([toggle.key], !toggle.expanded, toggle.key));
      button.addEventListener("mouseenter", () => toggle.g.classList.add("toggle-hover"));
      button.addEventListener("mouseleave", () => toggle.g.classList.remove("toggle-hover"));
      this.toggleLayerEl.appendChild(button);
    }
    const keys = this.togglableKeys();
    this.expandAllEl.disabled = keys.every((key) => this.expandedItems.has(key));
    this.collapseAllEl.disabled = !keys.some((key) => this.expandedItems.has(key));
  }

  private segHalf(bucket: TimeBucket): number {
    if (bucket === "delegation") return this.narrow ? 3 : 4;
    return this.narrow ? 5 : 6;
  }

  private canOpen(row: GraphRow): boolean {
    if (row.kind === "block") return row.block?.kind !== "command";
    if (row.kind === "item") return true;
    return row.agent !== undefined && this.workAgentIdFor(row.agent) !== undefined;
  }

  private select(key: RowKey): void {
    if (this.selectedKey === key) {
      const row = this.rows.find((r) => r.key === key);
      if (row !== undefined && this.canOpen(row)) this.openRow(row);
      return;
    }
    this.selectedKey = key;
    for (const [k, el] of this.rowEls) el.classList.toggle("on", k === key);
    this.enterWindow();
    this.centerRow(key);
  }

  private axisFor(start: number, end: number): InspectorAxis | undefined {
    const view = this.activeView();
    if (view === undefined || view.firstAt === null) return undefined;
    return { windowStart: view.firstAt, windowEnd: this.windowEnd(view), start, end };
  }

  private openRow(row: GraphRow): void {
    const opener = () => this.rowEls.get(row.key) as unknown as HTMLElement | undefined;
    this.selectedKey = row.key;
    this.openKey = row.key;
    for (const [k, e] of this.rowEls) {
      e.classList.toggle("on", k === row.key);
      e.classList.toggle("open", k === row.key);
    }
    this.enterWindow();
    this.centerRow(row.key);
    if (row.kind === "agent" && row.agent !== undefined) {
      const agentId = this.workAgentIdFor(row.agent);
      if (agentId === undefined) return;
      const a = row.agent;
      this.inspector.open({
        kind: "agent",
        agentId,
        label: agentLabel(a),
        meta: [a.subagentType, a.model, formatDuration(a.end - a.start)].filter((v) => v !== undefined && v !== "").join(" · "),
        axis: this.axisFor(a.start, a.end),
        stats: { toolCount: a.toolCount, failCount: a.failCount },
      }, opener);
      return;
    }
    if (row.kind === "item" && row.parentBlock !== undefined) {
      const period = row.period;
      const span: [number, number] | undefined = period === undefined ? undefined : [period.start, period.end];
      const title = row.title ?? "";
      this.inspector.open({
        kind: "block",
        label: clip(title, 60),
        meta: span === undefined ? undefined : `${clock(span[0])} · ${formatDuration(planSpansMs(period!.spans))}`,
        axis: span === undefined ? undefined : this.axisFor(span[0], span[1]),
        text: title,
        rows: this.itemRows(row, span),
      }, opener);
      return;
    }
    if (row.block !== undefined) {
      const b = row.block;
      this.inspector.open({
        kind: "block",
        label: clip(b.text, 60),
        meta: `${clock(b.anchorAt)} · ${blockDuration(b, b.end)}`,
        axis: this.axisFor(b.anchorAt, b.end),
        text: b.text,
        rows: this.blockRows(b),
      }, opener);
    }
  }

  private blockRows(b: RequestBlockView): [TermKey | Node, string | Node][] {
    const text = (s: string) => document.createTextNode(s);
    const duration = (ms: number) => `${b.metrics?.provisional ? "≈" : ""}${formatDuration(ms)}`;
    const rows: [TermKey | Node, string | Node][] = [
      [text(l10n.t("Kind")), b.kind === "plan" ? l10n.t("Work block") : l10n.t("Request block (a person's message)")],
      [text(l10n.t("Start")), formatDateTime(b.anchorAt)],
      [text(l10n.t("Elapsed")), blockDuration(b, b.end)],
    ];
    if (b.generateMs !== null) rows.push(["LLM generation", duration(b.generateMs)]);
    rows.push(["Tool execution", duration(b.toolMs)]);
    if (b.subagentWaitMs > 0) rows.push(["Waiting for subagent", duration(b.subagentWaitMs)]);
    rows.push(["Waiting for your answer", duration(b.confirmMs)]);
    if (b.replyMs !== null) rows.push(["Waiting for reply", duration(b.replyMs)]);
    rows.push([text(l10n.t("Tool operations")), l10n.t("{0} calls", b.toolCount)]);
    rows.push([text(l10n.t("Failures")), failureCount(b.failCount)]);
    if (b.agentCount > 0) rows.push(["Subagent", `${b.agentCount}`]);
    return rows;
  }

  private itemRows(row: GraphRow, span: [number, number] | undefined): [TermKey | Node, string | Node][] {
    const text = (s: string) => document.createTextNode(s);
    const item = row.item;
    const provisional = row.provisional === true;
    const duration = (ms: number) => `${provisional ? "≈" : ""}${formatDuration(ms)}`;
    const rows: [TermKey | Node, string | Node][] = [[text(l10n.t("Kind")), item === undefined ? l10n.t("Work block") : l10n.t("Step")]];
    if (span !== undefined) {
      rows.push([text(l10n.t("Start")), formatDateTime(span[0])], [text(l10n.t("Elapsed")), duration(span[1] - span[0])]);
    }
    if (item !== undefined && item.startedAt !== null) {
      if (item.generateMs !== null) rows.push(["LLM generation", duration(item.generateMs)]);
      if (item.toolMs !== null) rows.push(["Tool execution", duration(item.toolMs)]);
      if (item.subagentWaitMs !== null && item.subagentWaitMs > 0) rows.push(["Waiting for subagent", duration(item.subagentWaitMs)]);
      if (item.decisionWaitMs !== null) rows.push(["Waiting for your answer", duration(item.decisionWaitMs)]);
      if (item.replyWaitMs !== null) rows.push(["Waiting for reply", duration(item.replyWaitMs)]);
    }
    const subagents = this.subagentCount(row);
    if (subagents > 0) rows.push(["Subagent", `${subagents}`]);
    return rows;
  }

  private workAgentIdFor(agent: AgentSpanView): string | undefined {
    const byToolUse = this.findWorkAgentByToolUseId(agent.toolUseId);
    if (byToolUse !== undefined) return byToolUse.agentId;
    if (agent.transcriptAgentId !== undefined && this.findWorkAgent(agent.transcriptAgentId) !== undefined) return agent.transcriptAgentId;
    return undefined;
  }

  private findWorkAgent(agentId: string): WorkAgentNode | undefined {
    return this.findWorkAgentBy((a) => a.agentId === agentId);
  }

  private findWorkAgentByToolUseId(toolUseId: string): WorkAgentNode | undefined {
    return this.findWorkAgentBy((a) => a.toolUseId === toolUseId);
  }

  private findWorkAgentBy(pred: (a: WorkAgentNode) => boolean): WorkAgentNode | undefined {
    const payload = this.payload;
    if (payload === undefined) return undefined;
    const stack: WorkAgentNode[] = [...payload.unlinkedAgents];
    for (const phase of payload.phases) stack.push(...phase.agents);
    while (stack.length > 0) {
      const a = stack.pop() as WorkAgentNode;
      if (pred(a)) return a;
      stack.push(...a.children);
    }
    return undefined;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target instanceof Element ? e.target.closest<SVGGElement>(".wg-row") : null;
    if (target === null) return;
    const key = target.dataset.rowKey;
    if (key === undefined) return;
    if (e.key === "Escape" && this.zoom.kind !== "all") {
      this.clearSelection();
      this.setZoom(ZOOM_ALL, true);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const index = this.rows.findIndex((r) => r.key === key);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = this.rows[index + (e.key === "ArrowDown" ? 1 : -1)];
      if (next !== undefined) this.rowEls.get(next.key)?.focus();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.select(key);
    }
  }

  private fullRange(view: TimeBucketView, end: number): ResolvedRange {
    const firstAt = view.firstAt as number;
    return { start: firstAt, end, axisStart: firstAt, axisEnd: end, framed: false };
  }

  private viewRange(view: TimeBucketView, end: number): ResolvedRange {
    if (this.zoom.kind !== "window") {
      this.lastBand = undefined;
      delete this.rootEl.dataset.windowBand;
      delete this.rootEl.dataset.windowBandSource;
      return this.fullRange(view, end);
    }
    const z = this.zoom;
    const n = this.rows.length;
    const measured = this.resolveBand();
    let band: Band;
    if (measured !== undefined) {
      band = measured;
      z.anchor = this.rows[band.i].key;
      z.anchorIndex = band.i;
      z.rowCount = band.rowCount;
    } else {
      const k = this.rows.findIndex((r) => r.key === z.anchor);
      const j = Math.min(n, (k < 0 ? 0 : k) + z.rowCount);
      const i = Math.max(0, Math.min(k < 0 ? 0 : k, j - MIN_WINDOW_ROWS));
      band = { i, j, rowCount: z.rowCount };
    }
    this.lastBand = band;
    this.rootEl.dataset.windowBand = `${band.i}:${band.j}`;
    this.rootEl.dataset.windowBandSource = measured !== undefined ? "measured" : "fallback";
    return this.bandRange(band, view, end);
  }

  private bandRange(band: Band, view: TimeBucketView, end: number): ResolvedRange {
    const firstAt = view.firstAt as number;
    const heads: [number, number][] = [];
    let running = false;
    for (let k = band.i; k < band.j; k++) {
      const row = this.rows[k];
      if (row.kind !== "block" && row.kind !== "item") continue;
      heads.push(row.extent);
      running ||= row.period?.running === true;
    }
    let s: number;
    let e: number;
    if (heads.length === 0) {
      s = Number.POSITIVE_INFINITY;
      e = Number.NEGATIVE_INFINITY;
      for (let k = band.i; k < band.j; k++) {
        const [rs, re] = this.rows[k].extent;
        s = Math.min(s, rs);
        e = Math.max(e, re);
      }
    } else {
      s = Math.min(...heads.map((span) => span[0]));
      for (let k = band.i; k < band.j; k++) {
        const row = this.rows[k];
        if (row.kind === "block" || row.kind === "item") break;
        s = Math.min(s, row.extent[0]);
      }
      e = Math.max(...heads.map((span) => span[1]));
    }
    s = Math.max(s, firstAt);
    e = Math.min(e, end);
    if (e <= s) return { ...this.fullRange(view, end), band: { i: band.i, j: band.j, running } };
    return { start: s, end: e, axisStart: firstAt, axisEnd: end, framed: s > firstAt || e < end, band: { i: band.i, j: band.j, running } };
  }

  private measurePort(): PortMetrics | undefined {
    const r = this.scrollPort?.rect();
    if (r === undefined) return undefined;
    const head = this.headEl.getBoundingClientRect();
    const chart = this.chartEl.getBoundingClientRect();
    if (head.height <= 0 || chart.width <= 0) return undefined;
    const pinTop = r.top + head.height;
    if (r.bottom <= pinTop) return undefined;
    return {
      pinTop,
      portTop: Math.max(pinTop, head.bottom),
      portBottom: r.bottom,
      rowsTop: chart.top,
      rowCount: Math.max(MIN_WINDOW_ROWS, Math.floor((r.bottom - pinTop) / this.rowHeight)),
    };
  }

  private bandOf(m: PortMetrics): Band {
    const n = this.rows.length;
    let i = clampInt(Math.floor((m.portTop - m.rowsTop + 1) / this.rowHeight), 0, Math.max(0, n - 1));
    const j = Math.min(n, i + m.rowCount);
    if (j - i < MIN_WINDOW_ROWS) i = Math.max(0, j - MIN_WINDOW_ROWS);
    return { i, j, rowCount: m.rowCount };
  }

  private resolveBand(): Band | undefined {
    if (this.rows.length === 0) return undefined;
    const m = this.measurePort();
    return m === undefined ? undefined : this.bandOf(m);
  }

  private blockRowIndexAt(t: number): number {
    return planRowIndexAt(this.rows, t);
  }

  private outside(row: GraphRow, range: ResolvedRange): "before" | "after" | undefined {
    if (!range.framed) return undefined;
    const [s, e] = row.extent;
    if (e <= range.start) return "before";
    if (s >= range.end) return "after";
    return undefined;
  }

  private reanchor(): void {
    if (this.zoom.kind !== "window") return;
    const z = this.zoom;
    const k = this.rows.findIndex((r) => r.key === z.anchor);
    if (k < 0) return;
    const delta = k - z.anchorIndex;
    z.anchorIndex = k;
    if (delta === 0) return;
    if (this.visible && this.scrollPort?.rect() !== undefined) this.scrollPort.scrollBy(delta * this.rowHeight);
    else this.pendingReanchor += delta;
  }

  private alignTo(i: number, m: PortMetrics): void {
    this.scrollPort?.scrollBy(m.rowsTop + i * this.rowHeight - m.pinTop);
    this.onPortScroll();
  }

  private centerRow(key: RowKey): void {
    const k = this.rows.findIndex((r) => r.key === key);
    if (k < 0) return;
    const m = this.measurePort();
    if (m === undefined) return;
    const band = this.bandOf(m);
    const rowTop = m.rowsTop + k * this.rowHeight;
    const inBand = band.i <= k && k < band.j;
    const fullyVisible = rowTop >= m.portTop - 1 && rowTop + this.rowHeight <= m.portBottom + 1;
    if (inBand && fullyVisible) return;
    const n = this.rows.length;
    this.alignTo(clampInt(k - Math.floor(m.rowCount / 2), 0, Math.max(0, n - m.rowCount)), m);
  }

  private enterWindow(): void {
    if (this.zoom.kind === "window" || this.rows.length === 0) return;
    const band = this.resolveBand() ?? { i: 0, j: Math.min(this.rows.length, MIN_WINDOW_ROWS), rowCount: MIN_WINDOW_ROWS };
    this.setZoom({ kind: "window", anchor: this.rows[band.i].key, anchorIndex: band.i, rowCount: band.rowCount }, true);
  }

  private resetZoom(): void {
    this.zoom = ZOOM_ALL;
    this.pendingReanchor = 0;
    this.lastBand = undefined;
    this.scrollPort?.setHold(false);
  }

  private clearSelection(): void {
    this.selectedKey = undefined;
    this.openKey = undefined;
    for (const el of this.rowEls.values()) {
      el.classList.remove("on", "open");
    }
  }

  private setZoom(z: Zoom, announce: boolean): void {
    const prev = this.zoom;
    if (prev.kind === "all" && z.kind === "all") return;
    if (prev.kind === "window" && z.kind === "window" && prev.anchor === z.anchor && prev.rowCount === z.rowCount) return;
    this.zoom = z;
    if (z.kind === "all") {
      this.pendingReanchor = 0;
      this.scrollPort?.setHold(false);
    } else if (prev.kind === "all") {
      this.scrollPort?.setHold(true);
    }
    if (announce && (z.kind === "all" || prev.kind === "all")) this.announcePending = true;
    this.dirty = true;
    if (this.visible) this.scheduleRender();
  }

  private announce(text: string): void {
    this.zoomLiveEl.textContent = text;
  }

  private clipped(hostStart: number, hostEnd: number, range: ResolvedRange): "start" | "end" | "both" | undefined {
    const s = hostStart < range.start;
    const e = hostEnd > range.end;
    return s && e ? "both" : s ? "start" : e ? "end" : undefined;
  }

  private renderZoomBar(view: TimeBucketView, range: ResolvedRange): void {
    let rangeText: string;
    if (this.zoom.kind === "all" || range.band === undefined) {
      rangeText = l10n.t("Visible range {0} – {1} (whole)", dayClock(range.start), dayClock(range.end));
    } else {
      const b = range.band;
      rangeText = `${l10n.t("Visible range {0} – {1}", dayClock(range.start), dayClock(range.end))}${b.running ? ` · ${l10n.t("Running")}` : ""} · ${l10n.t("{0} rows that fit on screen", b.j - b.i)}`;
    }
    this.zoomRangeEl.textContent = rangeText;
    this.zoomAllEl.setAttribute("aria-pressed", this.zoom.kind === "all" ? "true" : "false");
    if (this.announcePending) {
      this.announcePending = false;
      this.announce(rangeText);
    }
    void view;
  }

  private miniTimeAt(clientX: number, left: number, width: number): number | undefined {
    const r = this.lastRange;
    if (r === undefined || width <= 0) return undefined;
    return this.miniScale?.timeAt((clientX - left) / width * 1000);
  }

  private onMiniPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const prev = this.lastMiniDown;
    this.clearMiniDown();
    const onWindow = e.target instanceof Element && e.target.getAttribute("data-part") === "window";
    if (prev !== undefined && onWindow && prev.pointerType === e.pointerType && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= MINI_DBL_PX) {
      if (this.zoom.kind !== "all") {
        this.clearSelection();
        this.setZoom(ZOOM_ALL, true);
      }
      e.preventDefault();
      return;
    }
    this.lastMiniDown = {
      x: e.clientX,
      y: e.clientY,
      pointerType: e.pointerType,
      timer: window.setTimeout(() => { this.lastMiniDown = undefined; }, MINI_DBL_MS),
    };
    const view = this.activeView();
    if (view === undefined || this.rows.length === 0) return;
    const rect = this.miniEl.getBoundingClientRect();
    const t = this.miniTimeAt(e.clientX, rect.left, rect.width);
    if (t === undefined) return;
    const k = this.blockRowIndexAt(t);
    this.enterWindow();
    this.centerRow(this.rows[k].key);
    const band = this.resolveBand();
    const i = band !== undefined ? band.i : this.zoom.kind === "window" ? this.zoom.anchorIndex : 0;
    this.drag = { pointerId: e.pointerId, off: k - i, miniLeft: rect.left, miniWidth: rect.width, moved: false };
    try {
      this.miniEl.setPointerCapture(e.pointerId);
    } catch (_err) {
      void _err;
    }
    this.miniEl.classList.add("dragging");
    e.preventDefault();
  }

  private onMiniPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (d === undefined || d.pointerId !== e.pointerId) return;
    const view = this.activeView();
    if (view === undefined) return;
    const t = this.miniTimeAt(e.clientX, d.miniLeft, d.miniWidth);
    if (t === undefined) return;
    const k = this.blockRowIndexAt(t);
    const m = this.measurePort();
    if (m === undefined) return;
    const band = this.bandOf(m);
    const i = clampInt(k - d.off, 0, Math.max(0, this.rows.length - m.rowCount));
    if (i === band.i) return;
    d.moved = true;
    this.alignTo(i, m);
  }

  private clearMiniDown(): void {
    if (this.lastMiniDown === undefined) return;
    clearTimeout(this.lastMiniDown.timer);
    this.lastMiniDown = undefined;
  }

  private onMiniPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (d === undefined || d.pointerId !== e.pointerId) return;
    this.drag = undefined;
    this.miniEl.classList.remove("dragging");
    if (!d.moved) return;
    this.clearMiniDown();
    this.announcePending = true;
    this.dirty = true;
    if (this.visible) this.scheduleRender();
  }

  private onMiniDblClick(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.getAttribute("data-part") !== "window") return;
    this.clearSelection();
    this.setZoom(ZOOM_ALL, true);
    e.preventDefault();
  }
}
