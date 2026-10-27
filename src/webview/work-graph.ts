import * as l10n from "@vscode/l10n";
import { ROW_H } from "./row-frame";
import { foregroundExternalCalls, viewTimeProvisional, planConductorRunning, planMemberDelegationCount, planFrame, planLive, planMemberEnd, planNow, planMainIntervals, planWaitSpans, timePartShown, type ShownTimePartKey, planRowIndexAt, planRowPeriod, planRowProvisional, UNMEASURED_LABEL, type PlanFrameMembers, type PlanRowPeriod, type PlanSpan } from "../plan-steps";
import { agentElapsedMs, displayedAncestorUsageGap, subagentDetailUnreadCount, type SemanticModelPayload, type TimeBucketsCoverage, type WorkAgentNode, type WorkModelPayload } from "../protocol";
import type { AgentSpanView, BackgroundTaskSpanView, ConductorModel, ExternalRunCallView, PlanBlockStepView, RequestBlockView, TimeBucket, TimeBucketInterval, TimeBucketView } from "../time-buckets";
import type { AgentInspector, InspectorAxis, InspectorTarget } from "./agent-inspector";
import { approx, approxDuration, formatDuration, clock, dayClock } from "./format";
import { memberRunTimes, runElapsedMs, runSpans } from "../spans";
import { TERM_NOTES, termSpan, type TermKey } from "./term";
import { FOLD_MARK_SLOT_PX, MARKS, foldGlyph } from "./marks";

export const NO_WORK_SUMMARY_TEXT = l10n.t("No work summary yet.");

export function agentLabel(a: { description?: string }): string {
  return a.description || l10n.t("Subagent");
}

type WorkCoverageView = WorkModelPayload["coverage"];

export function historyUndetermined(coverage: WorkCoverageView | undefined): boolean {
  return coverage?.hydrationUnconfirmed === "loading";
}

export function loadingHistoryText(): string {
  return l10n.t("Loading history…");
}

export function emptyWorkText(coverage: WorkCoverageView | undefined): string {
  return historyUndetermined(coverage) ? loadingHistoryText() : NO_WORK_SUMMARY_TEXT;
}

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

export interface SubagentRecordGaps { usageUnread: number; usagePending: number; detailUnread: number }

export function subagentRecordGaps(coverage: Pick<WorkCoverageView, "unreadableAgentCount" | "usagePendingTranscriptCount" | "usageOnlyTranscriptCount">,
  timeBuckets?: Pick<TimeBucketsCoverage, "unreadSubagentCount">): SubagentRecordGaps {
  return { usageUnread: coverage.unreadableAgentCount ?? 0, usagePending: coverage.usagePendingTranscriptCount ?? 0,
    detailUnread: timeBuckets?.unreadSubagentCount ?? subagentDetailUnreadCount(coverage) };
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
  const subagentGaps = subagentRecordGaps(coverage, timeBuckets);
  if (subagentGaps.usageUnread > 0) {
    summaryGaps.push(l10n.t("The token usage of {0} subagent records could not be read and is not included in the totals", subagentGaps.usageUnread));
  }
  if (subagentGaps.usagePending > 0) {
    summaryGaps.push(l10n.t("The token usage of {0} subagent records is still being read and is not yet included in the totals", subagentGaps.usagePending));
  }
  if (subagentGaps.detailUnread > 0) {
    summaryGaps.push(l10n.t("{0} subagent records were not read in full, so some of their time and tool calls are not included in the totals", subagentGaps.detailUnread));
  }
  if (coverage.phaseHistory === "prefix-compacted") {
    summaryGaps.push(l10n.t("The oldest {0} phases are merged into \"Early work\"", coverage.compactedPhaseCount));
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
  const ancestorUsageGap = timeBuckets?.ancestorUsageReadError ?? displayedAncestorUsageGap(coverage);
  if (ancestorUsageGap !== undefined) {
    summaryGaps.push(l10n.t("Could not fully read the earlier conversation's records, so child token usage recorded there is not included in the totals"));
    reasons.push(ancestorUsageGap);
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
  return coverageRows(nonzero(normalized), timeBuckets ? { ...nonzero(timeBuckets), unreadSubagentCount: timeBuckets.unreadSubagentCount } : undefined, true);
}

export function fillProblemCoverage(target: HTMLElement, coverage: (WorkCoverageView & CoverageBackfillHint) | undefined, timeBuckets?: TimeBucketsCoverage): void {
  target.textContent = "";
  for (const row of coverage === undefined ? [] : graphCoverageRows(coverage, timeBuckets)) {
    const el = span("wg-coverage-row", row.text);
    el.dataset.coverageScope = row.scope;
    if (row.state !== undefined) el.dataset.state = row.state;
    if (row.detail !== undefined) el.title = row.detail;
    target.appendChild(el);
  }
  target.hidden = target.childElementCount === 0;
  if (!target.hidden) {
    const heading = document.createElement("div");
    heading.append(span("wg-code", "COV"), span("wg-caption", l10n.t("Coverage scope")));
    target.prepend(heading);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_W = 288;
const PAD_L = 8;
const PAD_R = 8;
const LABEL_GAP_PX = 8;
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
export type GraphCategory = "g" | "t" | "d" | "sub" | "bgonly";
export function defaultGraphHidden(): Set<GraphCategory> { return new Set(); }
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

function fullyVisibleBand(m: PortMetrics, n: number, rowHeight: number): Band {
  let i = clampInt(Math.ceil((m.portTop - m.rowsTop - 1) / rowHeight), 0, Math.max(0, n - 1));
  const fit = Math.floor((m.portBottom - m.rowsTop + 1) / rowHeight);
  const j = Math.min(n, i + m.rowCount, Math.max(i + 1, fit));
  if (j - i < MIN_WINDOW_ROWS) i = Math.max(0, j - MIN_WINDOW_ROWS);
  return { i, j, rowCount: m.rowCount };
}

type RowKey = string;
type GraphToggle = { key: RowKey; y: number; label: string; expanded: boolean; g: SVGGElement; mark: number };

interface GraphRow {
  key: RowKey;
  kind: "item" | "conductor" | "agent" | "bg" | "ext" | "unknown";
  item?: PlanBlockStepView;
  conductorSpans?: PlanSpan[];
  conductorOpenFrom?: number;
  conductorIntervals?: TimeBucketInterval[];
  conductorTail?: number;
  conductorModels?: ConductorModel[];
  conductorWork?: TimeBucketInterval[];
  agent?: AgentSpanView;
  bgTask?: BackgroundTaskSpanView;
  extRun?: ExternalRunCallView;
  parentBlock?: RequestBlockView;
  parentItem?: RowKey;
  depth?: number;
  nestedCount?: number;
  members?: PlanFrameMembers;
  // Head rows only: the number and title src/plan-steps.ts#planFrame gives both GRAPH and ANALYSIS.
  number?: string;
  title?: string;
  // Head and member rows: src/plan-steps.ts#planRowPeriod / #planMemberEnd at this render's now; undefined is "nothing started".
  period?: PlanRowPeriod;
  provisional?: boolean;
  // What the row occupies on the time axis (period, conductor work, live tail), for layout only.
  extent: [number, number];
}

type FoldKind = "wait" | "unobserved";

export const foldsOnPress = (row: { kind: string }): boolean => row.kind === "item" || row.kind === "unknown";

interface WaitFold {
  start: number;
  end: number;
  kind: FoldKind;
}

interface Scale {
  x(t: number): number;
  timeAt(x: number): number;
  ticks: { t: number; elapsed: number }[];
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


function bucketClass(bucket: ShownTimePartKey & TimeBucket): "g" | "t" | "d" {
  return bucket === "generate" ? "g" : bucket === "tool" ? "t" : "d";
}

function bucketWord(bucket: ShownTimePartKey & TimeBucket): string {
  return bucket === "generate" ? l10n.t("LLM generation") : bucket === "tool" ? l10n.t("Tool execution") : l10n.t("Waiting for subagent");
}

function shownBucket(bucket: TimeBucket | null): bucket is ShownTimePartKey & TimeBucket {
  return bucket !== null && timePartShown(bucket);
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

function inspectorSignature(target: InspectorTarget): string {
  return JSON.stringify([target.meta, target.axis, target.stats]);
}

function clip(text: string, max: number): string {
  const line = text.split(/\r?\n/, 1)[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function buildScale(start: number, end: number, waits: readonly WaitFold[], linearWidth: number, offset: number, compress = true): Scale {
  const gaps = waits.map((w) => ({ ...w, start: Math.max(start, w.start), end: Math.min(end, w.end), cut: w.kind !== "unobserved" }))
    .filter((w) => w.end > w.start && (w.cut || (compress && w.end - w.start >= FOLD_MIN_MS)))
    .sort((a, b) => a.start - b.start);
  const folds = gaps.filter((w) => !w.cut);
  const foldedMs = gaps.reduce((acc, f) => acc + f.end - f.start, 0);
  const linearMs = Math.max(1, end - start - foldedMs);
  const foldPx = folds.length === 0 ? FOLD_PX : Math.min(FOLD_PX, linearWidth / (2 * folds.length));
  const linearPx = linearWidth - folds.length * foldPx;
  const pieces: { s: number; e: number; x0: number; x1: number; cut: boolean }[] = [];
  let cursor = start, x = offset;
  for (const f of gaps) {
    if (f.start > cursor) {
      const w = (f.start - cursor) / linearMs * linearPx;
      pieces.push({ s: cursor, e: f.start, x0: x, x1: x + w, cut: false });
      x += w;
    }
    const w = f.cut ? 0 : foldPx;
    pieces.push({ s: f.start, e: f.end, x0: x, x1: x + w, cut: f.cut });
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
  return { x: xOf, timeAt, ticks, elapsedTotal, offset, start, end, width: offset + linearWidth + PAD_R };
}

export function graphTotalText(scale: Pick<Scale, "elapsedTotal">): string {
  return l10n.t("Total {0}", formatDuration(scale.elapsedTotal));
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
  private openTargetSignature: string | undefined;
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
    const item = agent === undefined ? undefined
      : this.rows.find((r) => r.kind === "item" && (r.members?.agents.some((a) => a.toolUseId === agent.toolUseId)
        || r.members?.nested?.some((entry) => entry.agent?.toolUseId === agent.toolUseId) || r.members?.unknown?.some((a) => a.toolUseId === agent.toolUseId)));
    const nested = item?.members?.nested ?? [];
    const above: RowKey[] = [];
    for (let id = nested.find((entry) => entry.agent?.toolUseId === agent?.toolUseId)?.parentToolUseId; id !== undefined;
      id = nested.find((entry) => entry.agent?.toolUseId === id)?.parentToolUseId) above.push(`agent:${id}`);
    if (item?.members?.unknown?.some((a) => a.toolUseId === agent?.toolUseId)) above.push(`unknown:${item.key}`);
    const keys = item === undefined ? [] : [item.key, ...above].filter((key) => !this.expandedItems.has(key));
    if (keys.length > 0) {
      for (const key of keys) this.expandedItems.add(key);
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
    const now = this.lastTickMs ?? Date.now();
    this.openKey = undefined;
    this.openTargetSignature = undefined;
    this.inspector.open({ agentId, label: agentLabel(agent ?? {}),
      ...(agent === undefined ? {} : { stats: { failCount: agent.failCount, run: {
        ...(agent.startedAt === undefined ? {} : { start: agent.startedAt }), ...(agent.endedAt === undefined ? {} : { end: agent.endedAt }),
        running: agent.status === "running", elapsedMs: agentElapsedMs(agent, now), approximate: agent.status === "running" } } }) });
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
    const coverage = semantic?.coverage.base ?? this.payload?.coverage;
    fillProblemCoverage(this.coverageEl, coverage, semantic?.timeBucketsCoverage);
    const view = this.activeView();
    this.emptyEl.textContent = emptyWorkText(coverage);
    const hasData = !historyUndetermined(coverage) && view !== undefined && view.firstAt !== null && view.lastAt !== null && (view.blocks.length > 0 || view.agents.length > 0 || view.intervals.length > 0);
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
      this.renderToggles([]);
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
    const waits: WaitFold[] = planWaitSpans(view, end, planLive(view))
      .map(([start, stop]) => ({ start: Math.max(start, range.start), end: Math.min(stop, range.end), kind: "wait" as const }))
      .filter((w) => w.end > w.start);
    const lastAt = view.lastAt as number;
    const uStart = Math.max(lastAt, range.start);
    const uEnd = Math.min(end, range.end);
    if (!tail.anyOpen && uEnd > uStart) waits.push({ start: uStart, end: uEnd, kind: "unobserved" });
    const scale = buildScale(range.start, range.end, waits, chartWidth - this.labelWidth - (this.narrow ? 0 : PAD_L) - PAD_R, this.labelWidth + (this.narrow ? 0 : PAD_L));
    this.totalEl.textContent = graphTotalText(scale);
    this.renderZoomBar(view, range);
    this.renderMini(view, end, tail, range);
    this.renderAxisLabels(scale);
    this.renderChart(view, scale, end, range, tail);
    this.refreshOpenInspector();
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
        conductorIntervals: row.conductorWork.filter(interval => timePartShown(interval.bucket)), conductorTail: row.conductorTail } : {};
      const intervals = row.item?.conductorIntervals ?? conductor.conductorIntervals ?? [];
      const blockEnd = planRowPeriod({ kind: "block", block: parentBlock, members: { agents: [], bgTasks: [], externalRuns: [] } }, now, live)!.end;
      const starts = [...(period ? [period.start] : []), ...intervals.map(interval => interval.start)];
      const ends = [...(period ? [period.end] : []), ...intervals.map(interval => interval.end)];
      const extent: [number, number] = starts.length === 0 ? [blockEnd, blockEnd] : [Math.min(...starts), Math.max(...ends)];
      const head = { item: row.item, parentBlock, period, provisional, extent, conductorModels: row.conductorModels, conductorWork: row.conductorWork, ...conductor };
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
    const period = (member: AgentSpanView | BackgroundTaskSpanView | ExternalRunCallView): Pick<GraphRow, "period" | "provisional" | "extent"> => {
      const end = planMemberEnd(member, now, live);
      const spans = runSpans(memberRunTimes(member, end)).map(([start, stop]) => ({ start, end: stop }));
      const memberPeriod = { start: member.start, end, running: live && member.open, spans };
      return { period: memberPeriod, provisional: planRowProvisional({}, memberPeriod), extent: [member.start, end] };
    };
    const nested = members.nested ?? [];
    const below = (toolUseId: string): Pick<GraphRow, "nestedCount"> => {
      const count = members.nestedRanges?.get(toolUseId)?.count;
      return count === undefined ? {} : { nestedCount: count };
    };
    const pushBelow = (toolUseId: string, key: RowKey, offset = 0): void => {
      const range = members.nestedRanges?.get(toolUseId);
      if (range === undefined || !this.expandedItems.has(key)) return;
      for (const entry of nested.slice(range.start, range.start + range.count)) {
        if (entry.parentToolUseId !== toolUseId) continue;
        if (entry.agent !== undefined) {
          const row: GraphRow = { key: `agent:${entry.agent.toolUseId}`, kind: "agent", agent: entry.agent, parentBlock, parentItem, depth: entry.depth + offset,
            ...below(entry.agent.toolUseId), ...period(entry.agent) };
          rows.push(row);
          pushBelow(entry.agent.toolUseId, row.key, offset);
        } else if (entry.extRun !== undefined) {
          rows.push({ key: `ext:${entry.extRun.toolUseId}`, kind: "ext", extRun: entry.extRun, parentBlock, parentItem, depth: entry.depth + offset, ...period(entry.extRun) });
        }
      }
    };
    for (const agent of members.agents) {
      const key = `agent:${agent.toolUseId}`;
      rows.push({ key, kind: "agent", agent, parentBlock, parentItem, depth: 0, ...below(agent.toolUseId), ...period(agent) });
      pushBelow(agent.toolUseId, key);
    }
    for (const run of members.externalRuns) rows.push({ key: `ext:${run.toolUseId}`, kind: "ext", extRun: run, parentBlock, parentItem, ...period(run) });
    for (const bg of members.bgTasks) rows.push({ key: `bg:${bg.toolUseId}`, kind: "bg", bgTask: bg, parentBlock, parentItem, ...period(bg) });
    const unknown = members.unknown ?? [];
    if (unknown.length > 0) {
      const key = `unknown:${parentItem ?? "unplaced"}`;
      rows.push({ key, kind: "unknown", parentBlock, parentItem, depth: 0,
        nestedCount: unknown.reduce((sum, agent) => sum + 1 + (members.nestedRanges?.get(agent.toolUseId)?.count ?? 0), 0),
        extent: [Math.min(...unknown.map(agent => agent.start)), Math.max(...unknown.map(agent => agent.end))] });
      if (this.expandedItems.has(key)) {
        for (const agent of unknown) {
          const row: GraphRow = { key: `agent:${agent.toolUseId}`, kind: "agent", agent, parentBlock, parentItem, depth: 1, ...below(agent.toolUseId), ...period(agent) };
          rows.push(row);
          pushBelow(agent.toolUseId, row.key, 1);
        }
      }
    }
  }

  private memberElapsedMs(row: GraphRow): number | undefined {
    const member = row.agent ?? row.extRun ?? row.bgTask;
    if (member === undefined || row.period === undefined) return undefined;
    return (row.agent === undefined ? this.externalRunDurationMs(member.toolUseId) : undefined) ?? runElapsedMs(memberRunTimes(member, row.period.end));
  }

  // ROLES and ANALYSIS show an external run's time from the Host (src/role-summary.ts#externalRun, #externalCallRun); the call span stands in only while it has none.
  private externalRunDurationMs(toolUseId: string): number | undefined {
    for (const role of this.semantic?.roleSummary?.roles ?? []) {
      const run = role.runs.find((value) => value.source === "external" && value.toolUseId === toolUseId);
      if (run !== undefined) return run.durationMs ?? undefined;
    }
    return undefined;
  }

  private memberDuration(row: GraphRow): string {
    const ms = this.memberElapsedMs(row);
    return ms === undefined ? UNMEASURED_LABEL : approxDuration(ms, row.provisional === true);
  }

  private subagentCount(row: GraphRow): number {
    return planMemberDelegationCount(row.members);
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

  private renderLegend(view: TimeBucketView): void {
    this.legendEl.textContent = "";
    this.legendEl.append(span("wg-code", "KEY"), span("wg-caption", l10n.t("Legend")));
    const items: [GraphCategory, TermKey][] = [
      ["g", "LLM generation"],
      ["t", "Tool execution"],
      ["sub", "Subagent"],
      ["d", "Waiting for subagent"],
      ["bgonly", "Background only"],
    ];
    const totals = { g: view.main.generateMs, t: view.main.toolMs, d: view.main.subagentWaitMs, bgonly: view.main.backgroundOnlyMs ?? null, sub: view.bars.subMs };
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
      item.append(sw, term, span("wg-value", totals[cls] === null ? l10n.t("Not measured") : approx(formatDuration(totals[cls]), viewTimeProvisional(view))));
      this.legendEl.appendChild(item);
    }
    if (this.hiddenCategories.size > 0) {
      const status = span("wg-hidden-status", l10n.t("Hidden {0} · Values and scale unchanged", this.hiddenCategories.size));
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
      this.noteEl.textContent = l10n.t("LLM generation is not shown because this path does not record actual times. Tool execution is measured.");
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
    const waits: WaitFold[] = planWaitSpans(view, end, planLive(view)).map(([start, stop]) => ({ start, end: stop, kind: "wait" as const }));
    this.miniScale = buildScale(start, end, waits, W, 0, false);
    const px = this.miniScale.x;
    for (const i of planMainIntervals(view)) {
      if (!shownBucket(i.bucket) || this.hiddenCategories.has(bucketClass(i.bucket))) continue;
      const thin = i.bucket === "delegation";
      mini.appendChild(svgEl("rect", { x: px(i.start), y: thin ? 8 : 4, width: Math.max(0.8, px(i.end) - px(i.start)), height: thin ? 8 : 16, class: `wg-seg wg-seg-${bucketClass(i.bucket)}` }));
    }
    if (end > lastAt) {
      if (shownBucket(tail.main) && !this.hiddenCategories.has(bucketClass(tail.main))) {
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
      for (const [runStart, runEnd] of runSpans(memberRunTimes(a, planMemberEnd(a, end, planLive(view))))) {
        mini.appendChild(svgEl("rect", { x: px(runStart), y: 23, width: Math.max(0.8, px(runEnd) - px(runStart)), height: 4, class: `wg-seg wg-seg-sub${a.open ? " open" : ""}`, rx: 1 }));
      }
    }
    const delegations = [...(view.backgroundTasks ?? []).filter((bg) => bg.subagent), ...foregroundExternalCalls(view)];
    const others = (view.backgroundTasks ?? []).filter((task) => !task.subagent);
    for (const [bg, delegation] of [...(this.hiddenCategories.has("sub") ? [] : delegations).map((member) => [member, true] as const), ...others.map((member) => [member, false] as const)]) {
      const bgEnd = planMemberEnd(bg, end, planLive(view));
      mini.appendChild(svgEl("rect", { x: px(bg.start), y: 23, width: Math.max(0.8, px(bgEnd) - px(bg.start)), height: 4, rx: 1,
        class: delegation ? `wg-seg wg-seg-sub${bg.open ? " open" : ""}` : "wg-seg wg-seg-bgtask" }));
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
    const drawMain = (g: SVGElement, cy: number, host: [number, number], provisional: boolean, running: boolean, source: readonly TimeBucketInterval[],
      backgroundOnly: readonly (readonly [number, number])[], tailFrom = view.lastAt as number): void => {
      const [from, to] = host;
      for (const i of source) {
        if (!shownBucket(i.bucket) || this.hiddenCategories.has(bucketClass(i.bucket))) continue;
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
        titled(seg, approx(segTitle(word, s, e, clipSeg !== undefined ? l10n.t("Continues outside the window") : undefined), provisional));
        g.appendChild(seg);
      }
      if (view.fidelity === "record" && !this.hiddenCategories.has("bgonly")) for (const [bs, be] of backgroundOnly) {
        const s = Math.max(bs, from, range.start);
        const e = Math.min(be, to, range.end);
        if (e <= s) continue;
        const half = this.segHalf("tool");
        const seg = svgEl("rect", { x: scale.x(s), y: cy - half, width: Math.max(1.2, scale.x(e) - scale.x(s)), height: half * 2, class: "wg-seg wg-seg-bgonly" });
        seg.dataset.bucket = "backgroundOnly";
        titled(seg, approx(segTitle(l10n.t("Background only"), s, e), provisional));
        g.appendChild(seg);
      }
      if (running && shownBucket(tail.main) && !this.hiddenCategories.has(bucketClass(tail.main)) && this.running && end > tailFrom && tailFrom < range.end) {
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
    const toggles: GraphToggle[] = [];
    this.rows.forEach((row, index) => {
      const y = index * this.rowHeight;
      const cy = y + (this.narrow ? 37 : 18);
      const labelY = y + 14;
      const labelEnd = this.narrow ? scale.width - PAD_R : this.labelWidth - LABEL_GAP_PX;
      const head = row.kind === "item";
      const labelStart = (head ? (this.narrow ? 20 : 24) : (this.narrow ? 32 : 40)) + FOLD_MARK_SLOT_PX + (row.depth ?? 0) * 16;
      const markX = head ? 0 : labelStart - FOLD_MARK_SLOT_PX;
      const addFoldMark = (open: boolean): void => {
        const mark = svgEl("text", { x: markX, y: labelY, class: "fold-mark", "aria-hidden": "true" });
        mark.textContent = foldGlyph(open);
        g.appendChild(mark);
      };
      const addLabels = (name: string, meta: string, duration: string, full = name, model?: string, durationNote?: string, lead?: string): void => {
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
        const kept = lead !== undefined && meta.startsWith(`${lead} · `) ? `${lead} · ` : "";
        const body = meta.slice(kept.length);
        if (canvas) canvas.font = fontOf(sub);
        const metaWidth = labelEnd - labelStart - (kept && canvas ? canvas.measureText(kept).width : 0);
        if (model && canvas && body.endsWith(` · ${model}`)) {
          const suffix = ` · ${model}`;
          sub.textContent = kept + fit(body.slice(0, -suffix.length), metaWidth - canvas.measureText(suffix).width, fontOf(sub), true) + suffix;
        } else sub.textContent = kept + fit(body, metaWidth, fontOf(sub));
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
          const number = svgEl("text", { x: FOLD_MARK_SLOT_PX, y: labelY, class: "wg-block-number" });
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
        mark.textContent = outside === "before" ? `${MARKS.before} ${l10n.t("Before the visible range")}` : `${l10n.t("After the visible range")} ${MARKS.after}`;
        g.appendChild(mark);
      }
      const drawBars = outside === undefined;
      const outsideSuffix = outside === undefined ? "" : outside === "before" ? ` · ${l10n.t("Before the visible range")}` : ` · ${l10n.t("After the visible range")}`;
      if (row.kind === "item" && row.parentBlock !== undefined) {
        const item = row.item;
        const span = row.period;
        const running = span?.running === true;
        const subagents = this.subagentCount(row);
        const expanded = this.expandedItems.has(row.key);
        const title = row.title ?? "";
        const number = row.number ?? "";
        const duration = this.itemDuration(row);
        const facts = [span !== undefined ? clock(span.start) : item?.removed ? "" : item?.status === "completed" ? l10n.t("Completed") : l10n.t("Not started"),
          item?.removed ? l10n.t("Removed") : "",
          subagents > 0 ? l10n.t("{0} subagents", subagents) : ""].filter(Boolean).join(" · ");
        addLabels(title, facts, duration, title);
        if (drawBars) {
          for (const part of span?.spans ?? []) {
            if (part.end < range.start || part.start > range.end) continue;
            const x0 = scale.x(Math.max(part.start, range.start));
            const x1 = scale.x(Math.min(part.end, range.end));
            const half = this.narrow ? 6 : 7;
            const bar = svgEl("rect", { x: x0, y: cy - half, width: Math.max(2, x1 - x0), height: half * 2, rx: 2, class: "wg-seg wg-seg-period" });
            bar.dataset.bucket = "span";
            titled(bar, segTitle(l10n.t("Step"), part.start, running && part.end === span!.end ? null : part.end));
            g.appendChild(bar);
          }
        }
        if (running) g.classList.add("running");
        g.setAttribute("aria-label", `${l10n.t("Step")} ${[number, clip(title, 40), span === undefined ? "" : clock(span.start), duration].filter(Boolean).join(" ")}${outsideSuffix}`);
        addFoldMark(expanded);
        g.setAttribute("aria-expanded", String(expanded));
      } else if (row.kind === "conductor" && row.parentBlock !== undefined) {
        const item = row.item;
        const b = row.parentBlock;
        const conductorTail = item?.conductorTail ?? row.conductorTail;
        const running = planConductorRunning(row, row.period);
        addLabels(l10n.t("Conductor"), (row.conductorModels ?? []).map(entry =>
          [this.modelDisplayName(entry.model), entry.effort].filter(Boolean).join(" · ")).join(", "), "");
        if (drawBars) drawMain(g, cy, [Math.min(b.start, row.extent[0]), Math.max(row.extent[1], running ? end : -Infinity)], row.provisional === true,
          running, item?.conductorIntervals ?? row.conductorIntervals ?? [],
          this.semantic?.analysisPlans?.plans.find((plan) => plan.key === row.parentItem)?.backgroundOnlySpans ?? [], conductorTail ?? undefined);
        if (running) g.classList.add("running");
        g.setAttribute("aria-label", `${l10n.t("Conductor")}${outsideSuffix}`);
      } else if (row.kind === "unknown") {
        const unknownOpen = this.expandedItems.has(row.key);
        addLabels(l10n.t("Unknown launcher"), [l10n.t("Subagent"), unknownOpen ? "" : `+${row.nestedCount ?? 0}`].filter(Boolean).join(" · "), "");
        addFoldMark(unknownOpen);
        g.setAttribute("aria-expanded", String(unknownOpen));
        g.setAttribute("aria-label", `${l10n.t("Unknown launcher")}${outsideSuffix}`);
      } else if (row.agent !== undefined) {
        const a = row.agent;
        const aEnd = row.extent[1];
        const duration = this.memberDuration(row);
        const nestedOpen = row.nestedCount !== undefined && this.expandedItems.has(row.key);
        const folded = row.nestedCount !== undefined && !nestedOpen ? `+${row.nestedCount}` : "";
        const lead = [l10n.t("Subagent"), folded].filter(Boolean).join(" · ");
        addLabels(agentLabel(a), [lead, a.subagentType, a.model].filter(Boolean).join(" · "), duration, agentLabel(a), a.model, undefined, folded ? lead : undefined);
        if (row.nestedCount !== undefined) {
          addFoldMark(nestedOpen);
          toggles.push({ key: row.key, y, label: `${agentLabel(a)} · ${l10n.t("{0} subagents", row.nestedCount)}`, expanded: nestedOpen, g, mark: markX });
        }
        if (drawBars && !this.hiddenCategories.has("sub")) {
          const runs = row.period?.spans ?? [{ start: a.start, end: aEnd }];
          g.appendChild(svgEl("path", { d: `M ${scale.x(Math.max(a.start, range.start))} ${this.narrow ? cy - 8 : y - 2} V ${cy} h 4`, class: "wg-sub-link" }));
          runs.forEach((run, index) => {
            const last = index === runs.length - 1;
            if (runs.length > 1 && (run.end < range.start || run.start > range.end)) return;
            const x0 = scale.x(Math.max(run.start, range.start));
            const x1 = scale.x(Math.min(run.end, range.end));
            const bar = svgEl("rect", { x: x0, y: cy - (this.narrow ? 3 : 4), width: Math.max(2, x1 - x0), height: this.narrow ? 6 : 8, class: `wg-seg wg-seg-sub${a.open && last ? " open" : ""}` });
            bar.dataset.bucket = "sub";
            const clipA = this.clipped(run.start, run.end, range);
            if (clipA !== undefined) bar.dataset.clipped = clipA;
            titled(bar, segTitle(l10n.t("Subagent"), run.start, row.period?.running && last ? null : run.end, clipA !== undefined ? l10n.t("Continues outside the window") : undefined));
            g.appendChild(bar);
          });
        }
        if (row.period?.running) g.classList.add("running");
        const name = agentLabel(a);
        g.setAttribute("aria-label", `${a.description ? `${l10n.t("Subagent")} ` : ""}${clip(name, 40)} ${clock(a.start)} ${duration}${outsideSuffix}`);
      } else if (row.bgTask !== undefined || row.extRun !== undefined) {
        const bg = row.bgTask ?? row.extRun!;
        const delegation = row.bgTask?.subagent ?? true;
        const bgEnd = row.extent[1];
        const desc = bg.description || (row.bgTask?.taskId ?? "");
        const external = row.extRun !== undefined || (view.externalRunCalls ?? []).some((call) => call.toolUseId === bg.toolUseId);
        const word = external ? l10n.t("External run") : delegation ? l10n.t("Subagent") : l10n.t("Background");
        const duration = this.memberDuration(row);
        addLabels(delegation ? desc : `↻ ${desc}`, word, duration, desc);
        if (drawBars && !(delegation && this.hiddenCategories.has("sub"))) {
          const x0 = scale.x(Math.max(bg.start, range.start));
          const x1 = scale.x(Math.min(bgEnd, range.end));
          g.appendChild(svgEl("path", { d: `M ${x0} ${this.narrow ? cy - 8 : y - 2} V ${cy} h 4`, class: "wg-sub-link" }));
          const bar = svgEl("rect", { x: x0, y: cy - (this.narrow ? 3 : 4), width: Math.max(2, x1 - x0), height: this.narrow ? 6 : 8,
            class: delegation ? `wg-seg wg-seg-sub${bg.open ? " open" : ""}` : "wg-seg wg-seg-bgtask" });
          bar.dataset.bucket = delegation ? "sub" : "span";
          const clipBg = this.clipped(bg.start, bgEnd, range);
          if (clipBg !== undefined) bar.dataset.clipped = clipBg;
          titled(bar, segTitle(word, bg.start, row.period?.running ? null : bgEnd, clipBg !== undefined ? l10n.t("Continues outside the window") : undefined));
          g.appendChild(bar);
        }
        if (row.period?.running) g.classList.add("running");
        if (!delegation) {
          const note = svgEl("title", {});
          note.textContent = TERM_NOTES.Background.note;
          g.prepend(note);
        }
        g.setAttribute("aria-label", `${word} ${clip(desc, 40)} ${clock(bg.start)} ${duration}${outsideSuffix}`);
      }
      g.addEventListener("click", () => this.press(row.key));
      g.classList.toggle("on", row.key === this.selectedKey);
      g.classList.toggle("open", row.key === this.openKey);
      this.rowEls.set(row.key, g);
    });
    this.renderToggles(toggles);
  }

  private renderToggles(toggles: readonly GraphToggle[]): void {
    this.toggleLayerEl.textContent = "";
    for (const toggle of toggles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wg-item-toggle";
      button.dataset.rowKey = toggle.key;
      button.setAttribute("aria-expanded", String(toggle.expanded));
      button.setAttribute("aria-label", toggle.label);
      button.style.left = `${toggle.mark - TOGGLE_PAD_PX}px`;
      button.style.top = `${toggle.y}px`;
      button.style.width = `${FOLD_MARK_SLOT_PX + TOGGLE_PAD_PX}px`;
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
    return row.agent !== undefined && this.workAgentIdFor(row.agent) !== undefined;
  }

  private press(key: RowKey): void {
    const row = this.rows.find((r) => r.key === key);
    if (row !== undefined && foldsOnPress(row)) {
      this.setExpanded([key], !this.expandedItems.has(key));
      return;
    }
    this.select(key);
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
    const target = this.inspectorTarget(row);
    if (target === undefined) return;
    this.openTargetSignature = inspectorSignature(target);
    this.inspector.open(target, opener);
  }

  private refreshOpenInspector(): void {
    if (this.openKey === undefined || !this.inspector.isOpen()) return;
    const row = this.rows.find((r) => r.key === this.openKey);
    const target = row === undefined ? undefined : this.inspectorTarget(row);
    if (target === undefined) return;
    const signature = inspectorSignature(target);
    if (signature === this.openTargetSignature) return;
    this.openTargetSignature = signature;
    this.inspector.refresh(target);
  }

  private inspectorTarget(row: GraphRow): InspectorTarget | undefined {
    if (row.kind === "agent" && row.agent !== undefined) {
      const agentId = this.workAgentIdFor(row.agent);
      if (agentId === undefined || row.period === undefined) return undefined;
      const a = row.agent;
      return {
        agentId,
        label: agentLabel(a),
        meta: [a.subagentType, a.model, this.memberDuration(row)].filter((v) => v !== undefined && v !== "").join(" · "),
        axis: this.axisFor(row.period.start, row.period.end),
        stats: { toolCount: a.toolCount, failCount: a.failCount, run: { start: row.period.start, end: row.period.end, running: row.period.running,
          elapsedMs: this.memberElapsedMs(row) ?? 0, approximate: row.provisional === true } },
      };
    }
    return undefined;
  }

  private itemDuration(row: GraphRow): string {
    const ms = this.semantic?.analysisPlans?.plans.find((plan) => plan.key === row.key)?.time.totalMs;
    return ms == null ? UNMEASURED_LABEL : approxDuration(ms, row.provisional === true);
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
      this.press(key);
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
      if (row.kind !== "item") continue;
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
        if (row.kind === "item") break;
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
    return fullyVisibleBand(m, this.rows.length, this.rowHeight);
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
