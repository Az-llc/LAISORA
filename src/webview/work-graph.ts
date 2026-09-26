// グラフ（時間軸）。行 = 依頼ブロックとサブエージェント、横軸 = 実時刻。値は Host が
// SemanticModelPayload.timeBuckets（src/time-buckets.ts）で確定したものを描くだけで、
// 表示側で区分・帰属・並行度を再計算しない。
// 依存の辺を描かない。観測できる証跡が記録に無く、描けば推測になる（R-DSP-11）。
// 「時間重複 N 件」を数として出さない。重なりは軸の上にそのまま描く（R-DSP-10）。
import * as l10n from "@vscode/l10n";
import type { SemanticModelPayload, TimeBucketsCoverage, WorkAgentNode, WorkModelPayload } from "../protocol";
import type { AgentSpanView, BackgroundTaskSpanView, RequestBlockView, TimeBucket, TimeBucketView } from "../time-buckets";
import { AgentInspector, type InspectorAxis } from "./agent-inspector";
import { formatDateTime, formatDuration, clock, dayClock } from "./format";
import { termSpan, type TermKey } from "./term";

export const NO_WORK_SUMMARY_TEXT = l10n.t("No work summary yet.");

export function agentLabel(a: { description?: string }): string {
  return a.description || l10n.t("Subagent");
}

type WorkCoverageView = WorkModelPayload["coverage"];

// 表示側だけの付記（protocol の WorkCoverage には無い。main.ts が添える）。
// この画面に出ていない件数を、裏読みで戻る分と記録からも戻らない分に分けて運ぶ。
// **描き手が droppedEventCount から引き算で導かない**: あの値は live の切り詰めで増え続け、
// 増えた分は画面に描き終えている（R-DSP-01）
export interface CoverageBackfillHint {
  backfillPendingCount?: number;
  backfillStalled?: boolean;
  backfillPhase?: "events" | "transcript";
  backfillDone?: boolean;
  backfillUnreachableCount?: number;
}

export interface CoverageRow {
  scope: "summary" | "details";
  state?: string;
  text: string;
  // 生の理由（エラー文字列）。本文には出さず title に載せる
  detail?: string;
}

// 概要とグラフで同じ文言・同じ分け方にする（summary と details を別々に出す）。
// 2箇所で組み立てると、片方だけ欠落表示が増えたときに気付けない。
// 出所行を描かない。「復元したセッションログ」は利用者の判断を変えない（R-DSP-10）
export function coverageRows(coverage: WorkCoverageView & CoverageBackfillHint, timeBuckets?: TimeBucketsCoverage): CoverageRow[] {
  // 集計に入っていないものだけをここへ入れる。表示を絞っただけのものは detail 側。
  const summaryGaps: string[] = [];
  const reasons: string[] = [];
  // 時間軸の読み直しで読めなかったもの。読めなかった subagents/ を 0 本として描くと
  // 並列していたセッションが「直列」に見える（R-DSP-01）
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
  // 上限超過・読取失敗で丸ごと読めなかった子の記録。遡っても戻らない欠落なので、
  // 表示を絞っただけの「直近のみ」と別の言葉で説明する（R-DSP-03）
  if (coverage.omittedTranscriptCount !== undefined) {
    summaryGaps.push(l10n.t("Records for {0} subagents were not read and are not included in the totals", coverage.omittedTranscriptCount));
  }
  // 通知を待っていた背景タスクが上限退避で追跡から外れた。完了通知が来ても完了と断言しない
  if (coverage.untrackedBackgroundCount !== undefined) {
    summaryGaps.push(l10n.t("{0} background tasks are no longer tracked and are not included in the totals", coverage.untrackedBackgroundCount));
  }
  // summary を倒した原因は種類ごとに別の文にする。原因が 1 つも無いときだけ reducer 自身の上限退避
  // （最古の task / placement を捨てた）と読み「先頭の作業は集計外」と書く。原因が分かっているのに
  // その文へ倒すと、階層の読取失敗や復元失敗を「先頭切り詰め」と断定する（R-DSP-01。G-COV-7）
  let summaryCauseExplained = false;
  if (coverage.hydrationUnconfirmed === "loading") {
    summaryCauseExplained = true;
    summaryGaps.push(l10n.t("History is still loading, so work before the restore is not yet included in the totals"));
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
  // 根拠の索引（evidenceIndex）から落ちたイベント。件数の集計は通っているが、状況・分析の根拠が欠ける（G-COV-8）
  if (coverage.evidenceFoldErrorCount !== undefined) {
    summaryGaps.push(l10n.t("{0} events are missing from the evidence index, so status and analysis lack their evidence", coverage.evidenceFoldErrorCount));
  }
  // 状況の導出が失敗した。古い表示を「現在」として残さない（G-COV-8）
  if (coverage.semanticDerivationFailed === "stale") {
    summaryGaps.push(l10n.t("Building the status failed; the status and graph are as of the last success"));
  } else if (coverage.semanticDerivationFailed === "unavailable") {
    summaryGaps.push(l10n.t("Building the status failed; the status and graph cannot be shown"));
  }
  // droppedEventCount を summaryGaps へ入れない。Host は reduceWorkModel と evidenceIndex を全イベントに
  // 当ててから trimEventLog するので、概要の数字は先頭を含む（実測: 13,004 件 fold → ツール 6,500 = 全件）。
  // 欠けるのは実行ログの行と LLM 分析の入力だけで、それは details 側の文が担う（R-DSP-01。G-COV-6）
  // 欠落を並べながら「セッション全体」と名乗らない（R-DSP-01）
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
  // 記録からも読めなかった件数。遡りが尽きるまでは 0 で、尽きた後だけ確定する（R-TAB-08）
  const unreachable = coverage.backfillUnreachableCount ?? 0;
  // 読み終わって欠けだけが残った画面を「直近のみ」と呼ばない（出ている範囲は直近ではない）。
  // 概要行と同じ「一部欠け」にして、欠けの件数を下の文で出す（R-DSP-01 / R-DSP-23）
  // 欠けの判定を details より先に見る。Host の details が complete でも、この画面に出せなかった
  // 行があるなら「すべて表示」とは言えない（R-DSP-01）
  const detailParts = [
    backfillPending === 0 && unreachable > 0
      ? l10n.t("Details: partially missing")
      : coverage.details === "complete"
        ? l10n.t("Details: all shown")
        : l10n.t("Details: recent only"),
  ];
  // この 2 件数は初期表示から外した総数であり、現在の未読込件数ではない。
  // 読み込みの進行・停止は下の backfill 行に任せ、完了後は「すべて表示」と矛盾するため出さない。
  if (!coverage.backfillDone && coverage.omittedToolCount !== undefined) {
    detailParts.push(l10n.t("{0} tools are not shown in the initial view", coverage.omittedToolCount));
  }
  if (!coverage.backfillDone && coverage.omittedMessageCount !== undefined) {
    detailParts.push(l10n.t("{0} messages are not shown in the initial view", coverage.omittedMessageCount));
  }
  // 「破棄」と書かない（落ちたのは実行ログの行だけで、集計は落とす前に畳んである。R-DSP-01 / R-DSP-23）。
  // 裏読みで戻る分と記録からも読めなかった分を同じ文にしない（R-TAB-08）
  if (!coverage.backfillDone) {
    // 止まったときは残件を 1 文にまとめる（画面に出ていない件数は同じものなので二度数えない）
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
    // 読めなかった欠けは黙って隠さない（R-DSP-03）
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
  // complete かつ付記なしの行は出さない。「正常です」を毎回宣言するのは無情報で、
  // 出すのは全量カバーを達成できなかった申告だけ（R-DSP-23）
  const rows: CoverageRow[] = [];
  if (coverage.summary !== "complete" || summaryGaps.length > 0) {
    rows.push({
      scope: "summary",
      state: coverage.summary,
      text: summaryParts.join(" · "),
      ...(reasons.length > 0 ? { detail: reasons.join(" / ") } : {}),
    });
  }
  if (coverage.details !== "complete" || detailParts.length > 1) {
    rows.push({ scope: "details", state: coverage.details, text: detailParts.join(" · ") });
  }
  return rows;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_W = 236;
const PAD_L = 6;
const PAD_R = 14;
const AXIS_H = 22;
const ROW_H = 30;
const FOLD_PX = 30;
// 長い返信待ち・LLM質問確認待ち（live の回答待ちを含む）を折りたたむ。畳まないと 1 ブロックが画面の 6 割を占める（R-DSP-21）
const FOLD_MIN_MS = 5 * 60_000;
const MIN_CHART_W = 520;
const MINI_ARIA_LABEL = l10n.t("Activity distribution across the whole session. Click to zoom in on the rows at that time");
const MINI_UNFRAMED_ARIA_LABEL = l10n.t("The visible range covers every row. Click to center the rows at that time");
const TICK_STEPS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
const ZOOM_ARIA_LABEL = l10n.t("Press anywhere on the minimap to move the visible range to that time. Drag to move; double-click the frame for the whole session");
const MINI_HINT = l10n.t("Drag to move · Double-click for whole");
const HINT_MIN_PX = 200;
const MIN_WINDOW_ROWS = 3;
// pointerdown の preventDefault が互換 mouse イベントを抑え、実機では枠の dblclick が届かない（E2E-3b 実測）。
// ダブル押下は pointerdown の並びから自前で判定する。猶予は setTimeout で測る（時計を検査と共有し、
// 実時間の経過に依らない）。解除するのは 2 回目が枠（data-part=window）の上のときだけ —
// ミニマップ全域は「その時刻へ移す」入口で、枠外の連打は移動であって全体復帰ではない
const MINI_DBL_MS = 400;
const MINI_DBL_PX = 6;
// 再フォーカスの focus() は既定でフォーカス先をスクロールポート内へ寄せ、窓（可視帯）を動かす
const FOCUS_NO_SCROLL: FocusOptions = { preventScroll: true };

// window: 横軸は可視帯（scrollTop と pin 位置）から毎回解く。anchor / anchorIndex / rowCount は
// ポートを測れないときの代替値と、行の増減で scrollTop を補正する基準（reanchor）でしかない
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

// 縦スクロールの主（#logs）は tab.ts が持つ。top = .log-head の下端、bottom = #logs の下端。
// 測れない（非表示・幅 0）ときは undefined
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
  kind: "block" | "agent" | "bg";
  block?: RequestBlockView;
  agent?: AgentSpanView;
  bgTask?: BackgroundTaskSpanView;
  parentBlock?: RequestBlockView;
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
}

interface Scale {
  x(t: number): number;
  folds: ScaleFold[];
  ticks: number[];
  start: number;
  end: number;
  width: number;
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number | undefined>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  return el;
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}


function bucketClass(bucket: TimeBucket): "g" | "t" | "a" {
  return bucket === "generate" ? "g" : bucket === "tool" ? "t" : "a";
}

// 区分語は折り目の <title> に置く。ラベルへ足すと FOLD_LABEL_W の前提が崩れて目盛りラベルを消す
function foldWord(kind: FoldKind): string {
  return kind === "confirm" ? l10n.t("Waiting for your answer") : l10n.t("Waiting for reply");
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

// 依頼ブロックの経過。start が継承値（durationMs=null）なら数字を出さない（R-DSP-11）。
// 実行中のブロックだけは終端が伸びるので、測れている start から現在の終端までを出す
function blockDuration(b: RequestBlockView, end: number): string {
  if (b.durationMs === null) return l10n.t("Not measured");
  return formatDuration(b.running ? Math.max(b.durationMs, end - b.start) : b.durationMs);
}

function clip(text: string, max: number): string {
  const line = text.split(/\r?\n/, 1)[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function foldLabelPriority(a: ScaleFold, b: ScaleFold): number {
  const ua = a.kind === "unobserved" ? 1 : 0;
  const ub = b.kind === "unobserved" ? 1 : 0;
  return ua - ub || (b.end - b.start) - (a.end - a.start) || a.start - b.start;
}

// 折りたたみ付きの横軸。返信待ち・LLM質問確認待ち（live の回答待ちを含む）が FOLD_MIN_MS を超える区間は固定幅 FOLD_PX に畳み、残りを線形に配る
function buildScale(start: number, end: number, waits: readonly WaitFold[], linearWidth: number, offset: number): Scale {
  const folds = waits
    .filter((w) => w.end - w.start >= FOLD_MIN_MS && w.start >= start && w.end <= end)
    .sort((a, b) => a.start - b.start);
  const foldedMs = folds.reduce((acc, f) => acc + (f.end - f.start), 0);
  const linearMs = Math.max(1, end - start - foldedMs);
  // foldPx は折り目が稼働部に譲る
  const foldPx = folds.length === 0 ? FOLD_PX : Math.min(FOLD_PX, linearWidth / (2 * folds.length));
  const linearPx = linearWidth - folds.length * foldPx;
  const pieces: { s: number; e: number; x0: number; x1: number; folded: boolean; kind?: FoldKind; backgroundOverlapMs?: number; open?: boolean }[] = [];
  let cursor = start;
  let x = offset;
  for (const f of folds) {
    if (f.start > cursor) {
      const w = (f.start - cursor) / linearMs * linearPx;
      pieces.push({ s: cursor, e: f.start, x0: x, x1: x + w, folded: false });
      x += w;
    }
    pieces.push({ s: f.start, e: f.end, x0: x, x1: x + foldPx, folded: true, kind: f.kind, backgroundOverlapMs: f.backgroundOverlapMs, open: f.open });
    x += foldPx;
    cursor = f.end;
  }
  if (cursor < end || pieces.length === 0) {
    const w = (end - cursor) / linearMs * linearPx;
    pieces.push({ s: cursor, e: Math.max(end, cursor), x0: x, x1: x + w, folded: false });
    x += w;
  }
  const xOf = (t: number): number => {
    const c = Math.max(start, Math.min(end, t));
    for (const p of pieces) {
      if (c >= p.s && c <= p.e) {
        const d = p.e - p.s;
        return d <= 0 ? p.x0 : p.x0 + (c - p.s) / d * (p.x1 - p.x0);
      }
    }
    return x;
  };
  let step = TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  for (const candidate of TICK_STEPS_MS) {
    if (linearMs / candidate <= 8) {
      step = candidate;
      break;
    }
  }
  const ticks: number[] = [];
  const firstTick = Math.ceil(start / step) * step;
  for (let t = firstTick; t <= end; t += step) {
    if (folds.some((f) => t > f.start && t < f.end)) continue;
    ticks.push(t);
  }
  return {
    x: xOf,
    folds: pieces.filter((p) => p.folded).map((p) => ({ start: p.s, end: p.e, x0: p.x0, x1: p.x1, kind: p.kind!, backgroundOverlapMs: p.backgroundOverlapMs, open: p.open })),
    ticks,
    start,
    end,
    width: x + PAD_R,
  };
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
  private visible = false;
  private dirty = false;
  private running = false;
  private lastTickMs: number | undefined;
  private renderCount = 0;
  private rafId: number | undefined;
  constructor(
    private readonly tabId: string,
    private readonly inspector: AgentInspector,
    private readonly scrollPort?: GraphScrollPort
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
    this.legendEl.setAttribute("role", "note");
    this.legendEl.setAttribute("aria-label", l10n.t("Graph legend"));
    this.noteEl = document.createElement("div");
    this.noteEl.className = "wg-note";
    // 目盛りの代替は zoom bar の表示範囲文言。軸ラベルは支援技術に読ませない
    this.axisEl = svgEl("svg", { class: "wg-axis", "aria-hidden": "true" });
    this.headEl.append(this.zoomBarEl, this.miniEl, this.legendEl, this.noteEl, this.axisEl);
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "wg-body";
    this.chartPaneEl = document.createElement("div");
    this.chartPaneEl.className = "wg-chart-pane";
    this.chartEl = svgEl("svg", { class: "wg-chart", role: "group", "aria-label": l10n.t("Timeline of request blocks and subagents") });
    this.chartEl.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.chartPaneEl.appendChild(this.chartEl);
    // 行選択の情報パネル（wg-side）は置かない。行の内訳は行から開くインスペクターが
    // 同じ内容を出すので二重になる（G-74b が不在を固定）
    this.bodyEl.appendChild(this.chartPaneEl);
    this.emptyEl = span("wg-empty", NO_WORK_SUMMARY_TEXT);
    this.stageEl.append(this.headEl, this.bodyEl, this.emptyEl, this.inspector.rootEl);
    this.rootEl.append(this.coverageEl, this.stageEl);

    // 検査が DOM 経由で直接呼ぶ外部駆動点。未配線でも消さない
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
    // headless（--dump-dom）では ResizeObserver が描画機会まで届かないので、検査はここから同じ経路を叩く
    (this.rootEl as HTMLElement & { laisoraPortResized?: () => void }).laisoraPortResized = () => this.onPortResized();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.onPortResized());
      observer.observe(this.chartPaneEl);
      if (this.scrollPort !== undefined) observer.observe(this.scrollPort.element());
    }
  }

  // ポート高（#logs）の変化は行数 N を変える。非表示中の変化は dirty に残し、復帰の setVisible が描く
  private onPortResized(): void {
    this.dirty = true;
    if (this.visible) this.scheduleRender();
  }

  // #logs の scroll（main.ts の唯一のリスナ）から。window 中だけ可視帯を解き直す。
  // scrollTop を書くのは非表示中に溜めた reanchor の適用だけで、溜める側と同じく「測れるとき」に限る。
  // #logs は会話面と共用なので、測れないまま適用すると会話のスクロールを動かす
  onPortScroll(): void {
    const measurable = this.scrollPort?.rect() !== undefined;
    if (measurable && this.pendingReanchor !== 0) {
      const delta = this.pendingReanchor;
      this.pendingReanchor = 0;
      this.scrollPort?.scrollBy(delta * ROW_H);
    }
    if (this.zoom.kind !== "window" || !this.visible || !measurable) return;
    const band = this.resolveBand();
    if (band === undefined) return;
    const last = this.lastBand;
    if (last !== undefined && last.i === band.i && last.j === band.j) return;
    this.dirty = true;
    this.scheduleRender();
  }

  // 非表示のあいだは描画しない。SVG の全再構成を他タブを見ている間に繰り返さない
  setVisible(visible: boolean): void {
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

  // 概要・分析の証跡導線から。WorkModel の agentId で行を探し、無ければ行に依らず開く
  openAgentByWorkAgentId(agentId: string): boolean {
    const agent = this.findWorkAgent(agentId);
    const row = this.rows.find((r) => r.kind === "agent" && r.agent !== undefined && agent !== undefined && r.agent.toolUseId === agent.toolUseId);
    if (row !== undefined) {
      this.openRow(row);
      return true;
    }
    this.inspector.open({ kind: "agent", agentId, label: agent?.description || agentId });
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
      for (const row of coverageRows(coverage, semantic?.timeBucketsCoverage)) {
        const el = span("wg-coverage-row", row.text);
        el.dataset.coverageScope = row.scope;
        if (row.state !== undefined) el.dataset.state = row.state;
        if (row.detail !== undefined) el.title = row.detail;
        this.coverageEl.appendChild(el);
      }
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
      return;
    }
    const focusedKey = this.focusedRowKey();
    this.renderLegend(view);
    this.renderNote(view);
    // tail は Host 事実で view は intervals から判定しない（R-DSP-15）
    const tail = view.tail ?? { main: null, anyOpen: true };
    const end = this.windowEnd(view);
    this.rows = this.buildRows(view);
    // 高さを先に伸ばす。後だと reanchor の scrollBy が旧 scrollHeight で clamp される
    this.chartEl.setAttribute("height", String(this.rows.length * ROW_H + 8));
    this.reanchor();
    const range = this.viewRange(view, end);
    this.lastRange = range;
    this.rootEl.dataset.zoom = this.zoom.kind;
    const chartWidth = Math.max(MIN_CHART_W, this.chartPaneEl.clientWidth || 0);
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
    // 閾値は buildScale の filter が掛ける。折り目の閾値を 2 箇所に持たない
    if (!tail.anyOpen && uEnd > uStart) {
      waits.push({ start: uStart, end: uEnd, kind: "unobserved" });
    } else if (tail.main === "confirm" && uEnd > uStart) {
      waits.push({ start: uStart, end: uEnd, kind: "confirm", open: true });
    }
    const scale = buildScale(range.start, range.end, waits, chartWidth - LABEL_W - PAD_R, LABEL_W);
    this.renderZoomBar(view, range);
    this.renderMini(view, end, tail, range);
    this.renderAxisLabels(scale);
    this.renderChart(view, scale, end, range, tail);
    if (this.selectedKey !== undefined && !this.rowEls.has(this.selectedKey)) this.selectedKey = undefined;
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
    const lastAt = view.lastAt as number;
    if (this.running && this.lastTickMs !== undefined && this.lastTickMs > lastAt) return this.lastTickMs;
    return lastAt;
  }

  private buildRows(view: TimeBucketView): GraphRow[] {
    const rows: GraphRow[] = [];
    const placed = new Set<string>();
    for (const block of view.blocks) {
      rows.push({ key: `block:${block.blockId}`, kind: "block", block });
      for (const agent of view.agents) {
        if (agent.blockId !== block.blockId) continue;
        placed.add(`agent:${agent.toolUseId}`);
        rows.push({ key: `agent:${agent.toolUseId}`, kind: "agent", agent, parentBlock: block });
      }
      for (const bg of view.backgroundTasks ?? []) {
        if (bg.blockId !== block.blockId) continue;
        placed.add(`bg:${bg.toolUseId}`);
        rows.push({ key: `bg:${bg.toolUseId}`, kind: "bg", bgTask: bg, parentBlock: block });
      }
    }
    for (const agent of view.agents) {
      if (placed.has(`agent:${agent.toolUseId}`)) continue;
      rows.push({ key: `agent:${agent.toolUseId}`, kind: "agent", agent });
    }
    for (const bg of view.backgroundTasks ?? []) {
      if (placed.has(`bg:${bg.toolUseId}`)) continue;
      rows.push({ key: `bg:${bg.toolUseId}`, kind: "bg", bgTask: bg });
    }
    return rows;
  }

  private renderLegend(view: TimeBucketView): void {
    this.legendEl.textContent = "";
    // 第 2 要素は term.ts のキー（英語）。termSpan が用語表のラベルと注記を付ける
    const items: [string, TermKey][] = [
      ["g", "LLM generation"],
      ["t", "Tool execution"],
      ["a", "Waiting for your answer"],
      ["wait", "Waiting for reply"],
      ["sub", "Subagent"],
    ];
    for (const [cls, label] of items) {
      const item = document.createElement("span");
      item.className = "wg-legend-item";
      item.dataset.bucket = cls;
      const sw = span(`wg-sw wg-sw-${cls}`, "");
      sw.setAttribute("aria-hidden", "true");
      item.append(sw, termSpan(label));
      this.legendEl.appendChild(item);
    }
    void view;
  }

  private renderNote(view: TimeBucketView): void {
    this.noteEl.textContent = "";
    this.noteEl.hidden = true;
    // 境界イベントが継承時刻のときは LLM 生成 / 返信待ちを数字にしない。live の user_message /
    // turn_started は継承値で、返信待ちが LLM 生成へ積まれた嘘の数字になる（R-DSP-15）
    if (view.fidelity === "inherited") {
      this.noteEl.hidden = false;
      this.noteEl.dataset.fidelity = "inherited";
      this.noteEl.textContent = l10n.t("LLM generation and waiting for reply are not shown because this path does not record actual times. Tool execution and waiting for your answer are measured.");
    }
    if (view.droppedIntervalCount > 0 || view.droppedBlockCount > 0) {
      this.noteEl.hidden = false;
      this.noteEl.append(span("wg-note-line", l10n.t("Older records were dropped because of the limit ({0} intervals · {1} request blocks).", view.droppedIntervalCount, view.droppedBlockCount)));
    }
  }

  private renderMini(view: TimeBucketView, end: number, tail: { main: "generate" | "tool" | "confirm" | null; anyOpen: boolean }, range: ResolvedRange): void {
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
    pattern.appendChild(svgEl("line", { x1: "0", y1: "0", x2: "0", y2: "6", stroke: "var(--vscode-descriptionForeground, #888)", "stroke-width": "1.5", opacity: "0.5" }));
    defs.appendChild(pattern);
    mini.appendChild(defs);

    const start = view.firstAt as number;
    const lastAt = view.lastAt as number;
    const total = Math.max(1, end - start);
    const W = 1000;
    mini.setAttribute("viewBox", `0 0 ${W} 34`);
    mini.setAttribute("preserveAspectRatio", "none");
    const px = (t: number) => (Math.max(start, Math.min(end, t)) - start) / total * W;
    mini.appendChild(svgEl("rect", { x: 0, y: 8, width: px(lastAt), height: 18, class: "wg-seg-wait", rx: 2 }));
    for (const i of view.intervals) {
      if (i.bucket === "reply") continue;
      mini.appendChild(svgEl("rect", { x: px(i.start), y: 8, width: Math.max(0.8, px(i.end) - px(i.start)), height: 18, class: `wg-seg wg-seg-${bucketClass(i.bucket)}` }));
    }
    if (end > lastAt) {
      if (tail.main !== null) {
        const ext = svgEl("rect", {
          x: px(lastAt),
          y: 8,
          width: Math.max(0.8, px(end) - px(lastAt)),
          height: 18,
          class: `wg-seg wg-seg-${bucketClass(tail.main)} open`,
          rx: 2,
        });
        ext.dataset.bucket = tail.main;
        ext.dataset.tail = "main";
        mini.appendChild(ext);
      } else if (!tail.anyOpen) {
        mini.appendChild(svgEl("rect", {
          x: px(lastAt),
          y: 8,
          width: Math.max(0.8, px(end) - px(lastAt)),
          height: 18,
          class: "wg-seg open",
          fill: `url(#wg-hatch-mini-${this.tabId})`,
          rx: 2,
        }));
      }
    }
    for (const a of view.agents) {
      const aEnd = this.agentEnd(a, end);
      mini.appendChild(svgEl("rect", { x: px(a.start), y: 27, width: Math.max(0.8, px(aEnd) - px(a.start)), height: 5, class: `wg-seg wg-seg-sub${a.open ? " open" : ""}`, rx: 1 }));
    }
    for (const bg of view.backgroundTasks ?? []) {
      const bgEnd = this.bgEnd(bg, end);
      mini.appendChild(svgEl("rect", { x: px(bg.start), y: 27, width: Math.max(0.8, px(bgEnd) - px(bg.start)), height: 5, class: `wg-seg wg-seg-sub${bg.open ? " open" : ""}`, rx: 1 }));
    }
    if (range.framed) {
      const winX = px(range.start);
      const winW = Math.max(3, px(range.end) - px(range.start));
      const winRect = svgEl("rect", {
        x: winX,
        y: 2,
        width: winW,
        height: 30,
        rx: 2,
        class: "wg-mini-win",
        "data-part": "window",
      });
      titled(winRect, l10n.t("Visible range {0} – {1}", dayClock(range.start), dayClock(range.end)));
      mini.appendChild(winRect);

      const miniRect = this.miniEl.getBoundingClientRect();
      const miniWidth = miniRect.width || W;
      const sx = W / miniWidth;
      const cssWidth = (px(range.end) - px(range.start)) / sx;
      if (cssWidth >= HINT_MIN_PX) {
        const hint = svgEl("text", {
          class: "wg-tick wg-mini-hint",
          "aria-hidden": "true",
          transform: `translate(${px(range.start) + 6 * sx} 22) scale(${sx} 1)`,
        });
        hint.textContent = MINI_HINT;
        mini.appendChild(hint);
      }
      mini.classList.add("can-drag");
      mini.setAttribute("aria-label", ZOOM_ARIA_LABEL);
    } else {
      mini.classList.remove("can-drag");
      mini.setAttribute("aria-label", this.zoom.kind === "window" ? MINI_UNFRAMED_ARIA_LABEL : MINI_ARIA_LABEL);
    }
  }

  // 折り目ラベルと目盛りラベルは sticky な .wg-head 内の .wg-axis に描き、行が流れても見える位置に置く。
  // 幅の定数は 11px フォントの実測相当で、これより詰めると文字が重なって読めない
  private renderAxisLabels(scale: Scale): void {
    const svg = this.axisEl;
    svg.textContent = "";
    svg.setAttribute("viewBox", `0 0 ${scale.width} ${AXIS_H}`);
    svg.setAttribute("width", String(scale.width));
    svg.setAttribute("height", String(AXIS_H));
    const TICK_LABEL_W = 38;
    const FOLD_LABEL_W = 58;
    const foldLabelSpans: { lo: number; hi: number }[] = [];
    const foldLabels: { x: number; el: SVGTextElement }[] = [];
    for (const f of [...scale.folds].sort(foldLabelPriority)) {
      const c = (f.x0 + f.x1) / 2;
      const lo = c - FOLD_LABEL_W / 2;
      const hi = c + FOLD_LABEL_W / 2;
      if (foldLabelSpans.some((sp) => hi > sp.lo && lo < sp.hi)) continue;
      foldLabelSpans.push({ lo, hi });
      const label = svgEl("text", { x: c, y: AXIS_H - 9, "text-anchor": "middle", class: "wg-tick wg-fold-label" });
      label.textContent = `⋯${formatDuration(f.end - f.start)}`;
      label.dataset.foldKind = f.kind;
      titled(label, this.foldTitle(f));
      foldLabels.push({ x: c, el: label });
    }
    foldLabels.sort((a, b) => a.x - b.x);
    for (const l of foldLabels) svg.appendChild(l.el);
    let lastTickLabelEnd = Number.NEGATIVE_INFINITY;
    for (const t of scale.ticks) {
      const x = scale.x(t);
      const lo = x - TICK_LABEL_W / 2;
      const hi = x + TICK_LABEL_W / 2;
      if (lo < lastTickLabelEnd || foldLabelSpans.some((sp) => hi > sp.lo && lo < sp.hi)) continue;
      lastTickLabelEnd = hi;
      const label = svgEl("text", { x, y: AXIS_H - 9, "text-anchor": "middle", class: "wg-tick" });
      label.textContent = clock(t);
      svg.appendChild(label);
    }
  }

  private foldTitle(f: ScaleFold): string {
    if (f.kind === "unobserved") return l10n.t("No observations after {0} · {1}", clock(f.start), formatDuration(f.end - f.start));
    const bgMs = f.backgroundOverlapMs !== undefined && f.backgroundOverlapMs > 0 ? f.backgroundOverlapMs : undefined;
    return f.open === true
      ? segTitle(foldWord(f.kind), f.start, null, formatDuration(f.end - f.start))
      : segTitle(foldWord(f.kind), f.start, f.end, bgMs === undefined ? undefined : l10n.t("Background continues {0}", formatDuration(bgMs)));
  }

  private renderChart(view: TimeBucketView, scale: Scale, end: number, range: ResolvedRange, tail: { main: "generate" | "tool" | "confirm" | null; anyOpen: boolean }): void {
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
    pattern.appendChild(svgEl("line", { x1: "0", y1: "0", x2: "0", y2: "8", stroke: "var(--vscode-descriptionForeground, #888)", "stroke-width": "2", opacity: "0.5" }));
    defs.appendChild(pattern);
    svg.appendChild(defs);

    const height = this.rows.length * ROW_H + 8;
    svg.setAttribute("viewBox", `0 0 ${scale.width} ${height}`);
    svg.setAttribute("width", String(scale.width));
    svg.setAttribute("height", String(height));

    // 畳んだ事実は画面に出す。隠したことが分かる縮退にしない（R-DSP-03）
    for (const f of scale.folds) {
      const band = svgEl("rect", { x: f.x0, y: 0, width: f.x1 - f.x0, height: height - 6, class: "wg-fold" });
      band.dataset.foldMs = String(f.end - f.start);
      band.dataset.foldKind = f.kind;
      if (f.kind === "unobserved") {
        band.setAttribute("fill", `url(#wg-hatch-${this.tabId})`);
      } else if (f.backgroundOverlapMs !== undefined && f.backgroundOverlapMs > 0) {
        band.classList.add("wg-fold-bg");
        band.dataset.foldBgMs = String(f.backgroundOverlapMs);
      }
      titled(band, this.foldTitle(f));
      svg.appendChild(band);
    }
    for (const t of scale.ticks) {
      const x = scale.x(t);
      svg.appendChild(svgEl("line", { x1: x, y1: 0, x2: x, y2: height - 6, class: "wg-tick-line" }));
    }

    const intervals = view.intervals.filter((i) => i.bucket !== "reply" && i.end > range.start && i.start < range.end);
    this.rows.forEach((row, index) => {
      const y = index * ROW_H;
      const cy = y + ROW_H / 2;
      const g = svgEl("g", { class: "wg-row", tabindex: "0", role: "button", transform: "" });
      g.dataset.rowKey = row.key;
      g.dataset.kind = row.kind;
      g.appendChild(svgEl("rect", { x: 0, y, width: scale.width, height: ROW_H, class: "wg-row-bg", rx: 3 }));
      // 窓外の行は消さず、棒の代わりに窓との前後を示す。1〜2px の欠片を端に描かない
      const outside = this.outside(row, range, end);
      if (outside !== undefined) {
        g.dataset.outside = outside;
        const mark = outside === "before"
          ? svgEl("text", { x: LABEL_W + PAD_L, y: cy + 4, class: "wg-lbl-dim" })
          : svgEl("text", { x: scale.width - PAD_R, y: cy + 4, "text-anchor": "end", class: "wg-lbl-dim" });
        mark.textContent = outside === "before" ? `◂ ${l10n.t("Before the visible range")}` : `${l10n.t("After the visible range")} ▸`;
        g.appendChild(mark);
      }
      const drawBars = outside === undefined;
      const outsideSuffix = outside === undefined ? "" : outside === "before" ? ` · ${l10n.t("Before the visible range")}` : ` · ${l10n.t("After the visible range")}`;
      if (row.kind === "block" && row.block !== undefined) {
        const b = row.block;
        const bEnd = this.blockEnd(b, end);
        const label = svgEl("text", { x: PAD_L, y: cy - 2, class: "wg-lbl" });
        label.textContent = clip(b.text, 22);
        const sub = svgEl("text", { x: PAD_L, y: cy + 12, class: "wg-lbl-dim" });
        sub.textContent = `${clock(b.anchorAt)} · ${blockDuration(b, bEnd)}${b.toolCount > 0 ? ` · ${l10n.t("{0} tool calls", b.toolCount)}` : ""}${b.agentCount > 0 ? ` · ${l10n.t("{0} subagents", b.agentCount)}` : ""}`;
        g.append(label, sub);
        if (drawBars && b.end > range.start) {
          const x0 = scale.x(Math.max(b.anchorAt, range.start));
          const x1 = scale.x(Math.min(b.end, range.end));
          if (view.fidelity === "record") {
            const wait = svgEl("rect", { x: x0, y: cy - 8, width: Math.max(1, x1 - x0), height: 16, class: "wg-seg-wait", rx: 3 });
            wait.dataset.bucket = "reply";
            const clipWait = this.clipped(b.anchorAt, b.end, range);
            if (clipWait !== undefined) wait.dataset.clipped = clipWait;
            g.appendChild(wait);
          }
        }
        for (const i of drawBars ? intervals : []) {
          const hostS = Math.max(i.start, b.start);
          const hostE = Math.min(i.end, bEnd);
          const s = Math.max(hostS, range.start);
          const e = Math.min(hostE, range.end);
          if (e <= s) continue;
          const seg = svgEl("rect", { x: scale.x(s), y: cy - 8, width: Math.max(1.2, scale.x(e) - scale.x(s)), height: 16, class: `wg-seg wg-seg-${bucketClass(i.bucket)}` });
          seg.dataset.bucket = i.bucket;
          const word = i.bucket === "generate" ? l10n.t("LLM generation") : i.bucket === "tool" ? l10n.t("Tool execution") : l10n.t("Waiting for your answer");
          const clipSeg = this.clipped(hostS, hostE, range);
          if (clipSeg !== undefined) seg.dataset.clipped = clipSeg;
          titled(seg, segTitle(word, s, e, clipSeg !== undefined ? l10n.t("Continues outside the window") : undefined));
          g.appendChild(seg);
        }
        if (drawBars && b.running && tail.main !== null && this.running && end > (view.lastAt as number) && (view.lastAt as number) < range.end) {
          if (tail.main !== "generate" || view.fidelity === "record") {
            const lastAtVal = view.lastAt as number;
            const extX0 = scale.x(Math.max(lastAtVal, range.start));
            const extX1 = scale.x(Math.min(end, range.end));
            const ext = svgEl("rect", {
              x: extX0,
              y: cy - 8,
              width: Math.max(1.2, extX1 - extX0),
              height: 16,
              class: `wg-seg wg-seg-${bucketClass(tail.main)} open`,
            });
            ext.dataset.bucket = tail.main;
            ext.dataset.tail = "main";
            const clipExt = this.clipped(lastAtVal, end, range);
            if (clipExt !== undefined) ext.dataset.clipped = clipExt;
            const word = tail.main === "generate" ? l10n.t("LLM generation") : tail.main === "tool" ? l10n.t("Tool execution") : l10n.t("Waiting for your answer");
            titled(ext, segTitle(word, lastAtVal, null, clipExt !== undefined ? l10n.t("Continues outside the window") : undefined));
            g.appendChild(ext);
          }
        }
        if (b.running) g.classList.add("running");
        g.setAttribute("aria-label", `${l10n.t("Request block")} ${clip(b.text, 40)} ${clock(b.anchorAt)} ${blockDuration(b, bEnd)}${outsideSuffix}`);
      } else if (row.agent !== undefined) {
        const a = row.agent;
        const aEnd = this.agentEnd(a, end);
        const label = svgEl("text", { x: PAD_L + 18, y: cy - 2, class: "wg-lbl" });
        label.textContent = `└ ${clip(agentLabel(a), 20)}`;
        const sub = svgEl("text", { x: PAD_L + 18, y: cy + 12, class: "wg-lbl-dim" });
        sub.textContent = [a.subagentType, a.model, formatDuration(aEnd - a.start)].filter((v) => v !== undefined && v !== "").join(" · ");
        g.append(label, sub);
        if (drawBars) {
          const x0 = scale.x(Math.max(a.start, range.start));
          const x1 = scale.x(Math.min(aEnd, range.end));
          g.appendChild(svgEl("path", { d: `M ${x0} ${y - ROW_H / 2 + 8} V ${cy - 6} h 6`, class: "wg-sub-link" }));
          const bar = svgEl("rect", { x: x0, y: cy - 6, width: Math.max(2, x1 - x0), height: 12, class: `wg-seg wg-seg-sub${a.open ? " open" : ""}`, rx: 3 });
          bar.dataset.bucket = "sub";
          const clipA = this.clipped(a.start, aEnd, range);
          if (clipA !== undefined) bar.dataset.clipped = clipA;
          titled(bar, segTitle(l10n.t("Subagent"), a.start, a.open && this.running ? null : aEnd, clipA !== undefined ? l10n.t("Continues outside the window") : undefined));
          g.appendChild(bar);
        }
        if (a.open && this.running) g.classList.add("running");
        g.setAttribute("aria-label", `${l10n.t("Subagent")} ${clip(a.description || a.toolUseId, 40)} ${clock(a.start)} ${formatDuration(aEnd - a.start)}${outsideSuffix}`);
      } else if (row.kind === "bg" && row.bgTask !== undefined) {
        const bg = row.bgTask;
        const bgEnd = this.bgEnd(bg, end);
        const label = svgEl("text", { x: PAD_L + 18, y: cy - 2, class: "wg-lbl" });
        const desc = bg.description || bg.taskId;
        label.textContent = `└ 🔄 ${clip(desc, 20)}`;
        const sub = svgEl("text", { x: PAD_L + 18, y: cy + 12, class: "wg-lbl-dim" });
        sub.textContent = `${l10n.t("Background")} · ${formatDuration(bgEnd - bg.start)}`;
        g.append(label, sub);
        if (drawBars) {
          const x0 = scale.x(Math.max(bg.start, range.start));
          const x1 = scale.x(Math.min(bgEnd, range.end));
          g.appendChild(svgEl("path", { d: `M ${x0} ${y - ROW_H / 2 + 8} V ${cy - 6} h 6`, class: "wg-sub-link" }));
          const bar = svgEl("rect", { x: x0, y: cy - 6, width: Math.max(2, x1 - x0), height: 12, class: `wg-seg wg-seg-sub${bg.open ? " open" : ""}`, rx: 3 });
          bar.dataset.bucket = "sub";
          const clipBg = this.clipped(bg.start, bgEnd, range);
          if (clipBg !== undefined) bar.dataset.clipped = clipBg;
          titled(bar, segTitle(l10n.t("Background"), bg.start, bg.open && this.running ? null : bgEnd, clipBg !== undefined ? l10n.t("Continues outside the window") : undefined));
          g.appendChild(bar);
        }
        if (bg.open && this.running) g.classList.add("running");
        g.setAttribute("aria-label", `${l10n.t("Background")} ${clip(desc, 40)} ${clock(bg.start)} ${formatDuration(bgEnd - bg.start)}${outsideSuffix}`);
      }
      if (this.canOpen(row)) {
        const open = svgEl("text", { x: LABEL_W - 14, y: cy + 5, class: "wg-open", "aria-hidden": "true" });
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
      svg.appendChild(g);
      this.rowEls.set(row.key, g);
    });
  }



  // 中身を作っていないコマンド行に開く印を出さない。押しても何も起きない印は意味を持たない（R-DSP-10）
  private canOpen(row: GraphRow): boolean {
    if (row.kind === "block") return row.block?.kind !== "command";
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
        label: a.description || a.toolUseId,
        meta: [a.subagentType, a.model, formatDuration(a.end - a.start)].filter((v) => v !== undefined && v !== "").join(" · "),
        axis: this.axisFor(a.start, a.end),
        stats: { toolCount: a.toolCount, failCount: a.failCount },
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

  private blockRows(b: RequestBlockView): [TermKey | Node, string][] {
    const text = (s: string) => document.createTextNode(s);
    const rows: [TermKey | Node, string][] = [
      [text(l10n.t("Kind")), l10n.t("Request block (a person's message)")],
      [text(l10n.t("Start")), formatDateTime(b.anchorAt)],
      [text(l10n.t("Elapsed")), blockDuration(b, b.end)],
    ];
    if (b.generateMs !== null) rows.push(["LLM generation", formatDuration(b.generateMs)]);
    rows.push(["Tool execution", formatDuration(b.toolMs)]);
    rows.push(["Waiting for your answer", formatDuration(b.confirmMs)]);
    if (b.replyMs !== null) rows.push(["Waiting for reply", formatDuration(b.replyMs)]);
    rows.push([text(l10n.t("Tool operations")), l10n.t("{0} calls", b.toolCount)]);
    rows.push([text(l10n.t("Failures")), l10n.t("{0} items", b.failCount)]);
    if (b.agentCount > 0) rows.push(["Subagent", `${b.agentCount}`]);
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

  // 窓の解決はここ 1 箇所。window は可視帯（measured）か zoom の代替値（fallback）の行区間から時間区間を導く
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

  // 可視帯 [i, j) → 時間区間。ブロックが時間軸を分割するので帯のブロック集合 B は連続した区間になる。
  // 帯の先頭の子行（親が B に無い）は自分の start まで左端を下げるだけで、親の頭までは伸ばさない
  private bandRange(band: Band, view: TimeBucketView, end: number): ResolvedRange {
    const firstAt = view.firstAt as number;
    const B: RequestBlockView[] = [];
    for (let k = band.i; k < band.j; k++) {
      const b = this.rows[k].block;
      if (b !== undefined) B.push(b);
    }
    let s: number;
    let e: number;
    if (B.length === 0) {
      s = Number.POSITIVE_INFINITY;
      e = Number.NEGATIVE_INFINITY;
      for (let k = band.i; k < band.j; k++) {
        const [rs, re] = this.rowSpan(this.rows[k], end);
        s = Math.min(s, rs);
        e = Math.max(e, re);
      }
    } else {
      s = Math.min(...B.map((b) => b.anchorAt));
      for (let k = band.i; k < band.j; k++) {
        const row = this.rows[k];
        if (row.kind === "block") break;
        s = Math.min(s, this.rowSpan(row, end)[0]);
      }
      e = Math.max(...B.map((b) => this.blockEnd(b, end)));
    }
    const running = B.some((b) => b.running);
    s = Math.max(s, firstAt);
    e = Math.min(e, end);
    if (e <= s) return { ...this.fullRange(view, end), band: { i: band.i, j: band.j, running } };
    return { start: s, end: e, axisStart: firstAt, axisEnd: end, framed: s > firstAt || e < end, band: { i: band.i, j: band.j, running } };
  }

  // pin 位置 = .log-head の下端 + .wg-head の高さ（sticky で貼り付いたときの .wg-head 下端）。
  // N はポート高でなく pin 位置から取る（貼り付く前後で揺れない）
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
      rowCount: Math.max(MIN_WINDOW_ROWS, Math.floor((r.bottom - pinTop) / ROW_H)),
    };
  }

  private bandOf(m: PortMetrics): Band {
    const n = this.rows.length;
    // +1px: scrollTop の丸めで行の上端が pin より 1px 下に落ちても前の行を帯の先頭にしない
    let i = clampInt(Math.floor((m.portTop - m.rowsTop + 1) / ROW_H), 0, Math.max(0, n - 1));
    const j = Math.min(n, i + m.rowCount);
    if (j - i < MIN_WINDOW_ROWS) i = Math.max(0, j - MIN_WINDOW_ROWS);
    return { i, j, rowCount: m.rowCount };
  }

  private resolveBand(): Band | undefined {
    if (this.rows.length === 0) return undefined;
    const m = this.measurePort();
    return m === undefined ? undefined : this.bandOf(m);
  }

  private blockRowIndexAt(t: number, end: number): number {
    let first = -1;
    let last = -1;
    for (let k = 0; k < this.rows.length; k++) {
      const b = this.rows[k].block;
      if (b === undefined) continue;
      if (first < 0) first = k;
      if (b.anchorAt <= t && t < this.blockEnd(b, end)) return k;
      if (b.anchorAt <= t) last = k;
    }
    if (last >= 0) return last;
    return first >= 0 ? first : 0;
  }

  private outside(row: GraphRow, range: ResolvedRange, end: number): "before" | "after" | undefined {
    if (!range.framed) return undefined;
    const [s, e] = this.rowSpan(row, end);
    if (e <= range.start) return "before";
    if (s >= range.end) return "after";
    return undefined;
  }

  // 行の増減で anchor 行の index が動いた分だけ scrollTop を補正し、帯の key 集合を保つ。
  // 測れないときは pendingReanchor に溜め、復帰後の最初の onPortScroll で適用する
  private reanchor(): void {
    if (this.zoom.kind !== "window") return;
    const z = this.zoom;
    const k = this.rows.findIndex((r) => r.key === z.anchor);
    if (k < 0) return;
    const delta = k - z.anchorIndex;
    z.anchorIndex = k;
    if (delta === 0) return;
    if (this.visible && this.scrollPort?.rect() !== undefined) this.scrollPort.scrollBy(delta * ROW_H);
    else this.pendingReanchor += delta;
  }

  // scrollBy の後に自分で帯を解き直す。scroll イベントは次の描画機会まで遅れ、同じ帯なら no-op で収束する
  private alignTo(i: number, m: PortMetrics): void {
    this.scrollPort?.scrollBy(m.rowsTop + i * ROW_H - m.pinTop);
    this.onPortScroll();
  }

  // 行 key を帯の中心に置く。帯内かつ完全に見えている行は動かさない（2 回目のクリックが同じ行に届く）
  private centerRow(key: RowKey): void {
    const k = this.rows.findIndex((r) => r.key === key);
    if (k < 0) return;
    const m = this.measurePort();
    if (m === undefined) return;
    const band = this.bandOf(m);
    const rowTop = m.rowsTop + k * ROW_H;
    const inBand = band.i <= k && k < band.j;
    // ±1px: sticky の貼り付き位置と pin の計算が小数で 1px ずれても、帯の先頭行のクリックで行が跳ねない
    const fullyVisible = rowTop >= m.portTop - 1 && rowTop + ROW_H <= m.portBottom + 1;
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

  // window 同士は anchor と rowCount で同値（anchorIndex は reanchor が動かす値で同じ行を指す）。
  // 読み上げは all ⇄ window の遷移だけ。window 内で帯が動く読み上げはドラッグ終了（moved）が担う
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

  private blockEnd(b: RequestBlockView, end: number): number {
    return b.running ? Math.max(b.end, end) : b.end;
  }

  private agentEnd(a: AgentSpanView, end: number): number {
    return a.open && this.running ? Math.max(a.end, end) : a.end;
  }

  private bgEnd(bg: BackgroundTaskSpanView, end: number): number {
    return bg.open && this.running ? Math.max(bg.end, end) : bg.end;
  }

  private rowSpan(row: GraphRow, end: number): [number, number] {
    if (row.kind === "block" && row.block !== undefined) {
      return [row.block.anchorAt, this.blockEnd(row.block, end)];
    }
    if (row.kind === "agent" && row.agent !== undefined) {
      return [row.agent.start, this.agentEnd(row.agent, end)];
    }
    if (row.kind === "bg" && row.bgTask !== undefined) {
      return [row.bgTask.start, this.bgEnd(row.bgTask, end)];
    }
    return [0, 0];
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
    return r.axisStart + (clientX - left) / width * (r.axisEnd - r.axisStart);
  }

  // どこを押しても、その時刻のブロック行を中心に置いてからドラッグを始める（all からも同じ）。
  // 掴んだブロック行の帯内オフセット off を保ち、移動中もその行が帯に残る
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
    const k = this.blockRowIndexAt(t, this.windowEnd(view));
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
    const k = this.blockRowIndexAt(t, this.windowEnd(view));
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
    // 掴んで動かした後の押下は移動の続きで、ダブル押下の 1 回目ではない
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
