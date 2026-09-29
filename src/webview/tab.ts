import { createLoader } from "./loader";
import { mergeAskChoice } from "./ask-choice";
import { createSessionHeader } from "./session-header";
import { PlanPanel } from "./plan-panel";
import { applyFallbackModel, fallbackNeedsConfirmation, fallbackNoticeOriginal, foldModelFallback, resolveFallbackByChoice } from "../protocol";
import type { ModelFallbackState } from "../protocol";
import { YouList } from "./you-list";
import type { YouItem } from "./you-items";
import { shortModelDisplayName } from "../model-display-name";
import type {
  AuthStatus,
  ConversationSnapshot,
  HostToWebview,
  ImageAttachment,
  ImageRefInfo,
  ModelInfo,
  NormalizedEvent,
  PermissionModeId,
  ResumePreviewMessage,
  SessionImageRef,
  SlashCommandInfo,
  UsageSnapshot,
  WorkAgentStateView,
  WorkEventInfo,
  WorkModelPayload,
  WorkPlacementView,
  WorkSegmentView,
  WorkTaskItemView,
  WorkTaskTotalsView,
} from "../protocol";
import { DECISIONS_REWRITE_RATIO } from "../protocol";
import * as l10n from "@vscode/l10n";
import { inputEl, logsEl, tabbarEl, usagePanelEl, sessionActionsEl, vscode } from "./dom";
import { buildApprovalBody } from "./approval";
import { clock, formatDuration, monthDayClock, toolSummary, uiLocale } from "./format";
import { createCopyButton, renderMarkdownInto } from "./markdown";
import { askHeading, askOptionContent, updateAskCounters } from "./ask-view";
import { createYouItems, encodeAskDismissal, youAnchor, type AskIdentity, type YouItemsReader } from "./you-items";
import { appendRecordPart, findCommitBoundary, joinRecordTexts, prependRecordParts, recordSeparator, type RecordTextPart } from "./commit-boundary";
import { isConvRenderableEvent } from "../conv-renderable";
import {
  applyActivityEvent,
  backgroundActivityFromSnapshot,
  createBackgroundActivityState,
  hasRunningDelegation,
  liveBackgroundTasks,
  notePastLifecycle,
  runningDelegationIds,
  type BackgroundActivitySnapshot,
  type BackgroundActivityState,
} from "../background-activity";
import type { HandoffFailReason } from "../handoff-runner";
import type { WorkViewMode } from "./work-overview";
import type { GraphScrollPort } from "./work-graph";
import { refreshFind, refreshFindCount } from "./find-bar";
import { deriveStatusLine, statusLineText, truncateToolIntent, type ToolIntentInput } from "./status-line";
import {
  SCROLL_BOTTOM_GAP_PX,
  activeTabId,
  findTabBySessionId,
  noteSurfaceChange,
  persistState,
  rateLimits,
  refreshChrome,
  renderUsagePanel,
  setActiveTab,
  swapPreservingConvView,
  refreshComposer,
} from "./main";

export function requestIsOpen(id: string, latest: string | undefined, overrides: ReadonlyMap<string, boolean>): boolean {
  return overrides.get(id) ?? id === latest;
}

export function agentElapsed(state: WorkAgentStateView, now: number): number {
  return state.elapsedMs + (state.status === "running" && (state.runStartedAt ?? 0) > 0
    ? Math.max(0, now - state.runStartedAt!) : 0);
}

type LogRequest = {
  anchor?: HTMLElement;
  members: Set<HTMLElement>;
  turns: Set<string>;
  last?: { row: HTMLElement; order: number[] };
  preview?: { row: HTMLElement; home: Comment };
};

type HandoffStatusMessage = Extract<HostToWebview, { type: "handoffStatus" }>;
type HandoffDetailMessage = Extract<HostToWebview, { type: "handoffDetail" }>;

function buildHandoffDetail(label: string): HTMLElement {
  const wrap = document.createElement("details");
  wrap.className = "handoff-detail";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.className = "handoff-detail-body";
  wrap.append(summary, pre);
  return wrap;
}

function detailBodyOf(card: HTMLElement, index: number): HTMLElement {
  return card.querySelectorAll<HTMLElement>(".handoff-detail-body")[index];
}

type HandoffDecisionCounts = NonNullable<HandoffStatusMessage["decisions"]>;

// R-HND-11 / R-HND-12: handoffStatus と handoffDetail の件数を同じ文面で出すため、描き手は renderDecisionCounts だけにする。
function renderDecisionCounts(card: HTMLElement, counts: HandoffDecisionCounts): void {
  const slot = card.querySelector<HTMLElement>(".handoff-decisions-lines");
  if (slot === null) return;
  slot.textContent = "";
  const rows: Array<{ text: string; warn?: boolean }> = [
    { text: l10n.t("{0} decision lines carried forward ({1} new, {2} from earlier generations)", counts.total, counts.extracted, counts.carried) },
  ];
  if (counts.removed > 0) rows.push({ text: l10n.t("{0} decision lines were removed this time", counts.removed) });
  if (counts.unknownIdRefs > 0) {
    rows.push({ text: l10n.t("⚠ {0} lines named an id that does not exist and were ignored", counts.unknownIdRefs), warn: true });
  }
  if (counts.carried > 0 && counts.extracted >= counts.carried * DECISIONS_REWRITE_RATIO) {
    rows.push({
      text: l10n.t("⚠ Lines that were already carried forward may have been rewritten ({0} new against {1} carried over)", counts.extracted, counts.carried),
      warn: true,
    });
  }
  if (counts.warn !== undefined) {
    rows.push({
      text: l10n.t("⚠ {0} decision lines / {1} KB are attached. Consider tidying them up.", counts.warn.entries, Math.round(counts.warn.bytes / 1024)),
      warn: true,
    });
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.textContent = row.text;
    if (row.warn) el.className = "handoff-card-warn";
    slot.appendChild(el);
  }
}

function decisionLineText(entry: { id: string; t: string; g: number; s: string }): string {
  return `${entry.id} [${entry.t}] g${entry.g} ${entry.s}`;
}

function utteranceText(u: HandoffDetailMessage["utterances"][number]): string {
  const head = `#${u.n}${u.at === "" ? "" : ` ${u.at}`}`;
  const questions = u.questions === undefined ? "" : `${u.questions.join("\n")}\n`;
  return `${head}\n${questions}${u.text}`;
}

export interface LightboxSource {
  ref?: SessionImageRef;
  inline?: ImageAttachment;
}

let activeLightbox: HTMLElement | null = null;
let lightboxKeyHandler: ((e: KeyboardEvent) => void) | null = null;

export function closeLightbox(): void {
  if (activeLightbox) {
    activeLightbox.remove();
    activeLightbox = null;
  }
  if (lightboxKeyHandler) {
    window.removeEventListener("keydown", lightboxKeyHandler);
    lightboxKeyHandler = null;
  }
}

export function openLightbox(tabId: string, src: string, source: LightboxSource): void {
  closeLightbox();
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.addEventListener("click", () => closeLightbox());

  const img = document.createElement("img");
  img.src = src;
  img.alt = l10n.t("Enlarged image");
  img.addEventListener("click", () => closeLightbox());
  overlay.appendChild(img);

  const btn = document.createElement("button");
  btn.className = "image-lightbox-open-editor";
  btn.textContent = l10n.t("Open in editor");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (source.ref) {
      vscode.postMessage({ type: "openSessionImage", tabId, ref: source.ref });
    } else if (source.inline) {
      vscode.postMessage({
        type: "openSessionImage",
        tabId,
        inline: { mediaType: source.inline.mediaType, data: source.inline.data },
      });
    }
    closeLightbox();
  });
  overlay.appendChild(btn);

  lightboxKeyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeLightbox();
    }
  };
  window.addEventListener("keydown", lightboxKeyHandler);
  document.body.appendChild(overlay);
  activeLightbox = overlay;
}

export function attachLightboxHandlers(
  img: HTMLImageElement,
  tabId: string,
  source: LightboxSource
): void {
  img.tabIndex = 0;
  img.title = l10n.t("Click to enlarge");
  const open = (e: Event) => {
    e.stopPropagation();
    openLightbox(tabId, img.src, source);
  };
  img.addEventListener("click", open);
  img.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(e);
    }
  });
}

function createImageSlot(tabId: string, ref: SessionImageRef): HTMLSpanElement {
  const slot = document.createElement("span");
  slot.className = "user-image-slot";
  slot.dataset.imageState = "pending";
  slot.dataset.imageRef = JSON.stringify(ref);
  slot.dataset.tabId = tabId;
  slot.textContent = l10n.t("Loading image…");
  return slot;
}

interface InFlightImageJob {
  tabId: string;
  requestId: string;
  slot: HTMLElement;
  ref: SessionImageRef;
}

let inFlightImageJob: InFlightImageJob | null = null;
let imageLoadRequestSeq = 0;
const pendingImageTabs = new Set<Tab>();
let imageLoadScheduled = false;

function drainImageLoadQueue(): void {
  for (const tab of pendingImageTabs) {
    const slots = Array.from(
      tab.convEl.querySelectorAll<HTMLElement>('.user-image-slot[data-image-state="pending"]')
    );
    if (slots.length === 0) {
      pendingImageTabs.delete(tab);
      continue;
    }
    const ordered = slots.reverse();
    for (const slot of ordered) {
      if (inFlightImageJob !== null) return;
      if (!slot.isConnected) continue;
      const refStr = slot.dataset.imageRef;
      if (!refStr) continue;
      let ref: SessionImageRef;
      try {
        ref = JSON.parse(refStr);
      } catch {
        slot.dataset.imageState = "error";
        slot.textContent = l10n.t("Could not load the image");
        continue;
      }
      slot.dataset.imageState = "loading";
      const requestId = `img-req-${++imageLoadRequestSeq}`;
      inFlightImageJob = { tabId: tab.tabId, requestId, slot, ref };
      vscode.postMessage({
        type: "sessionImageRequest",
        tabId: tab.tabId,
        requestId,
        ref,
      });
    }
  }
}

export function scheduleImageLoads(tab: Tab): void {
  pendingImageTabs.add(tab);
  if (imageLoadScheduled) return;
  imageLoadScheduled = true;
  requestAnimationFrame(() => {
    setTimeout(() => {
      imageLoadScheduled = false;
      drainImageLoadQueue();
    }, 0);
  });
}

export function handleSessionImageResult(
  tabId: string,
  requestId: string,
  mediaType: ImageAttachment["mediaType"],
  data: string
): void {
  if (!inFlightImageJob || inFlightImageJob.requestId !== requestId) return;
  const { slot, ref } = inFlightImageJob;
  inFlightImageJob = null;
  const img = document.createElement("img");
  img.className = "user-image";
  img.src = `data:${mediaType};base64,${data}`;
  img.alt = l10n.t("Attached image");
  img.dataset.imageRef = JSON.stringify(ref);
  attachLightboxHandlers(img, tabId, { ref });
  // 復号前に差し替えると swapPreservingConvView の測定が実寸を含まない（verify-history-prepend#HPmut-25）。
  // 寸法属性で代用しない。`.user-image` の CSS は最大寸法だけを持つので、属性を与えると縦横比が崩れる。
  const place = (): void => {
    if (slot.isConnected) swapPreservingConvView(tabId, slot, img);
    drainImageLoadQueue();
  };
  void img.decode().then(place, place);
}

export function handleSessionImageError(requestId: string): void {
  if (!inFlightImageJob || inFlightImageJob.requestId !== requestId) return;
  const { slot } = inFlightImageJob;
  inFlightImageJob = null;
  slot.dataset.imageState = "error";
  slot.textContent = l10n.t("Could not load the image");
  drainImageLoadQueue();
}

export function clearPendingImageLoads(tab: Tab): void {
  pendingImageTabs.delete(tab);
  if (inFlightImageJob && inFlightImageJob.tabId === tab.tabId) {
    inFlightImageJob = null;
    drainImageLoadQueue();
  }
}

// 長い compact の後に出た失敗理由を読む前に消さないよう、失敗表示は次の引き継ぎが始まるまで最長 HANDOFF_FAILURE_VISIBLE_MS 残す。
const HANDOFF_FAILURE_VISIBLE_MS = 120_000;
const HANDOFF_RUN_MEMORY = 1_000;
const HANDOFF_DETAIL_UNAVAILABLE = l10n.t("Could not read the details");

const HANDOFF_FAILURE_MESSAGES = {
  compact_rejected_analysis: l10n.t("The AI model refused to generate the summary, or the summary was incomplete"),
  compact_rejected_structure: l10n.t("The AI model refused to generate the summary, or the summary was incomplete"),
  compact_rejected_length: l10n.t("The AI model refused to generate the summary, or the summary was incomplete"),
  compact_timeout: l10n.t("The summary was not generated in time"),
  cancelled: l10n.t("Cancelled"),
  source_busy: l10n.t("Cannot hand off while a turn is running (wait for it to finish or interrupt it)"),
  already_running: l10n.t("A handoff is already running"),
  tab_failed: l10n.t("The handoff was created. You can open it from history"),
  // compact_failed と hook_not_fired は src/handoff-runner.ts#HandoffFailReason の中でも複数の経路から出るので、文面で原因を断定しない。具体的な理由は detail が運ぶ。
  // 元の会話が変わっていない旨は showHandoffStatus が後置するので、ここへ重ねない。
  compact_failed: l10n.t("Could not summarize the conversation. Please try again"),
  hook_not_fired: l10n.t("The summary did not run. Please try again"),
  fork_failed: l10n.t("Could not create the handoff conversation. Wait a moment and try again"),
  fork_path_unresolved: l10n.t("The handoff conversation was not found. Wait a moment and try again"),
  fork_path_scan_failed: l10n.t("Could not check whether the handoff conversation exists. Check sync and permissions"),
  verbatim_extract_failed: l10n.t("Could not extract your messages. Please try again"),
  envelope_append_failed: l10n.t("Could not write the handoff content. Please try again"),
  commit_failed: l10n.t("Could not finalize the handoff. Please try again"),
} satisfies Record<HandoffFailReason | "tab_failed", string>;

function handoffFailureMessage(reason: string | undefined): string {
  const known =
    reason === undefined
      ? undefined
      : (HANDOFF_FAILURE_MESSAGES as Record<string, string | undefined>)[reason];
  return known ?? l10n.t("Handoff aborted ({0})", reason ?? "unknown");
}

// R-DSP-01: CLI の応答は要約開始の観測点にならないので、compacting は心拍が届くまで要約中と表示しない（verify-webview-wiring#W-HND-9rmut）。
const HANDOFF_PHASE_TEXTS: Record<string, string> = {
  forking: l10n.t("(creating a copy)"),
  extracting: l10n.t("(extracting messages)"),
  compacting: l10n.t("(waiting for the summary response)"),
  accepting: l10n.t("(checking the summary)"),
  appending: l10n.t("(writing the handoff content)"),
  finishing: l10n.t("(writing the handoff content)"),
};

function handoffElapsedText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? l10n.t("{0}s", total) : l10n.t("{0}m {1}s", Math.floor(total / 60), total % 60);
}

function handoffRunningText(msg: HandoffStatusMessage): string {
  const progress = msg.progress;
  if (msg.phase === "compacting" && progress !== undefined && progress.heartbeats > 0) {
    const origin = progress.since === "result" ? l10n.t("since last response") : l10n.t("since start");
    return l10n.t(
      "Handing off… (summarizing · {0} responses · {1} {2})",
      progress.heartbeats,
      handoffElapsedText(progress.elapsedMs),
      origin
    );
  }
  return l10n.t("Handing off…{0}", HANDOFF_PHASE_TEXTS[msg.phase ?? ""] ?? "");
}

// HANDOFF_QUIET_MS は src/handoff-runner.ts#COMPACT_HEARTBEAT_GRACE_MS とは独立した webview 側の表示タイマーで、protocol に載せない。
const HANDOFF_QUIET_MS = 90_000;

function handoffPlayfulLines(): string[] {
  return [
    l10n.t("A hamster is running the wheel at full power 🐹"),
    l10n.t("Fairies are carrying your data backstage"),
    l10n.t("Brewing tea while this runs. Grab a cup ☕"),
    l10n.t("Waiting for the server koala to wake up"),
    l10n.t("The owl librarian is re-reading the conversation 🦉"),
    l10n.t("A capybara is thinking it over in the hot spring ♨"),
    l10n.t("A line of ants is carrying the data one grain at a time 🐜"),
    l10n.t("A cat is sleeping on the summary. Politely asking it to move 🐈"),
    l10n.t("The penguins are lining up in order 🐧"),
    l10n.t("A bear woke from hibernation and started sorting 🐻"),
  ];
}

function formatHandoffTokens(compact: { preTokens: number; postTokens: number } | undefined): string {
  if (compact === undefined) return l10n.t("— → — tokens");
  return l10n.t("{0} → {1} tokens", compact.preTokens.toLocaleString(uiLocale()), compact.postTokens.toLocaleString(uiLocale()));
}

function handoffSummaryHeading(summary: string | undefined): string {
  let fence: string | undefined;
  for (const line of (summary ?? "").split(/\r?\n/)) {
    const mark = /^(?:`{3,}|~{3,})/.exec(line.trim())?.[0][0];
    if (mark !== undefined) {
      if (fence === undefined) fence = mark;
      else if (fence === mark) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = /^(?:#{1,6}\s+|\d+[.)]\s+|\*\*|__)+(.+?)\s*$/.exec(line.trim());
    if (heading) {
      const label = heading[1].replace(/\s+#+$/, "").replace(/\*\*|__/g, "").replace(/:$/, "").trim();
      if (label) return label;
    }
  }
  return l10n.t("Summary");
}

// カードは segmentId で同定する。現在のカードで同定すると、切替後に終わった前カードのツールの集計が次のカードへ混入する（verify-detail-cards#C-1）。
interface SegmentCard {
  segmentId: string;
  el: HTMLDetailsElement;
  summaryEl: HTMLElement;
  lastLabel: string;
}

interface AgentCardEntry {
  card: HTMLDetailsElement;
  statusEl: HTMLElement;
  metaEl: HTMLElement;
  chipsEl: HTMLElement;
  childrenEl: HTMLElement;
}

// 集計値を WorkRowData で数えない。集計は WorkModelPayload と WorkEventInfo の値を使う。
interface WorkRowData {
  toolUseId: string;
  kind: "tool" | "agent";
  toolName: string;
  summaryText: string;
  inputPreview: string;
  status: "running" | "done" | "failed" | "stale";
  // provider 時刻。0 は未観測で、時刻列を空にする。
  startedAt: number;
  resultPreview?: string;
  elapsedLabel?: string;
  statusGlyph?: string;
  metaText?: string;
  chips?: { kind: string; text: string }[];
  childIds?: string[];
}

// 状態語は WorkAgentStateView の status から引き、DOM のクラスから逆算しない。
const AGENT_STATUS_WORD: Record<WorkAgentStateView["status"], string> = {
  running: l10n.t("Running"),
  completed: l10n.t("Completed"),
  failed: l10n.t("Failed"),
  stale: l10n.t("Tracking stopped"),
  unknown: l10n.t("Unknown"),
};

function permissionDeniedText(ev: { toolName: string; reason: string }): string {
  return l10n.t("Auto-denied: {0} — {1}", ev.toolName, ev.reason);
}
function compactBoundaryText(ev: { trigger: "auto" | "manual"; preTokens?: number }): string {
  const trigger = ev.trigger === "auto" ? l10n.t("auto") : l10n.t("manual");
  const from = typeof ev.preTokens === "number" ? l10n.t(", from {0} tokens", ev.preTokens.toLocaleString(uiLocale())) : "";
  return l10n.t("── Context compacted ({0}{1}) ──", trigger, from);
}
const APPROVAL_REF_SUFFIX = l10n.t(" (respond in the Conversation tab)");

// model チップは subagent_info で後着して宣言値を置き換えるので、並びは到着順でなく AGENT_CHIP_ORDER で決める。
const AGENT_CHIP_ORDER = ["type", "model", "effort"];
function chipRank(kind: string): number {
  const index = AGENT_CHIP_ORDER.indexOf(kind);
  return index < 0 ? AGENT_CHIP_ORDER.length : index;
}

function setRowChip(data: WorkRowData, kind: string, text: string): void {
  const chips = data.chips ?? (data.chips = []);
  const existing = chips.find((chip) => chip.kind === kind);
  if (existing) existing.text = text;
  else chips.push({ kind, text });
  chips.sort((a, b) => chipRank(a.kind) - chipRank(b.kind));
}

function fillChips(chipsEl: HTMLElement, data: WorkRowData): void {
  chipsEl.textContent = "";
  for (const chip of data.chips ?? []) {
    const el = document.createElement("span");
    el.className = `agent-chip agent-chip-${chip.kind}`;
    el.dataset.chip = chip.kind;
    el.textContent = chip.text;
    chipsEl.appendChild(el);
  }
}

function shortModelLabel(model: string): string {
  return model.replace(/^claude-/, "");
}

function taskLabel(item: WorkTaskItemView): string {
  return item.status === "in_progress" && item.activeForm ? item.activeForm : item.description;
}

// taskKey だけで比べると、状態やラベルだけが変わった更新で TODO カードが描き直されない。
function sameTaskItems(a: readonly WorkTaskItemView[], b: readonly WorkTaskItemView[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      item.taskKey === other.taskKey &&
      item.description === other.description &&
      item.activeForm === other.activeForm &&
      item.status === other.status
    );
  });
}

// anchors は容器ごとに、その再生で最初に入れた時点の firstChild を固定する。毎回取り直すと chunk 内が逆順になる（verify-history-prepend#HPmut-7）。
// createdNow の容器は空から作るので append する。anchor が summary でも、Chromium は最初の summary 子を表示用に割り当てるので表示順は崩れない。
interface PastRenderContext {
  frag: DocumentFragment;
  anchors: Map<Node, Node | null>;
  createdNow: Set<Node>;
  rendered: number;
  skipped: number;
  created: number;
  failed: number;
  failures: string[];
}

// 突合は src/webview/main.ts#onHistoryChunkResult が行う。connected を突き合わせるのは、未接続コンテナへの appendChild が例外を出さないため（verify-history-prepend#HPmut-5）。
export interface PastPrependResult {
  total: number;
  rendered: number;
  skipped: number;
  duplicates: number;
  failed: number;
  connected: number;
  expectedConnected: number;
  failures: string[];
}

type PastRenderOutcome = "created" | "applied" | "skipped";

export interface ConvPrependResult {
  total: number;
  rendered: number;
  duplicates: number;
  failed: number;
  failures: string[];
  connected: number;
  expectedConnected: number;
}

// events 由来の chunk だけが skipped と continued を持つ。duplicates へ畳むと重複と誤読される（verify-conversation-history#CH-C22mut-a）。
export interface ConvEventPrependResult extends ConvPrependResult {
  // isConvRenderableEvent が false の件数。
  skipped: number;
  // 既存の assistant ブロックへ本文を足しただけの件数。connected は data-conv-past の実数なので rendered へ入れない（verify-conversation-history#CH-C22mut-b）。
  continued: number;
}

export type ViewMode = "conv" | "work";

// 作り直しをまたぐ位置を画素位置で持たない。上に中身が増えると別の行を指す。
// offset の基準は logsEl の上端（ヘッダの高さは帯の有無で変わる）。
export interface RowAnchor {
  attr: "msgUuid" | "turnId" | "toolUseId";
  id: string;
  user?: boolean;
  ordinal: number;
  offset: number;
}
export interface ScrollCarrySurface {
  atBottom: boolean;
  scrollPos: number;
  anchor?: RowAnchor;
}
export interface ScrollCarry {
  conv: ScrollCarrySurface;
  work: ScrollCarrySurface;
  workView: WorkViewMode;
  workViewAtBottom: Record<WorkViewMode, boolean>;
  workViewScrollPos: Record<WorkViewMode, number>;
}

const WORK_VIEW_MODES: readonly WorkViewMode[] = ["summary", "graph", "analysis", "log"];

function isRowAnchor(v: unknown): v is RowAnchor {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    (a.attr === "msgUuid" || a.attr === "turnId" || a.attr === "toolUseId") &&
    typeof a.id === "string" && a.id.length > 0 &&
    (a.user === undefined || typeof a.user === "boolean") &&
    Number.isInteger(a.ordinal) && (a.ordinal as number) >= 0 &&
    Number.isFinite(a.offset)
  );
}

function isScrollCarrySurface(v: unknown): v is ScrollCarrySurface {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.atBottom === "boolean" && Number.isFinite(s.scrollPos) && (s.anchor === undefined || isRowAnchor(s.anchor));
}

// setState に残した値は別の版の webview が書いたものでもありうる
export function isScrollCarry(v: unknown): v is ScrollCarry {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const atBottom = c.workViewAtBottom as Record<string, unknown> | null | undefined;
  const scrollPos = c.workViewScrollPos as Record<string, unknown> | null | undefined;
  return (
    isScrollCarrySurface(c.conv) && isScrollCarrySurface(c.work) &&
    WORK_VIEW_MODES.includes(c.workView as WorkViewMode) &&
    typeof atBottom === "object" && atBottom !== null && WORK_VIEW_MODES.every((m) => typeof atBottom[m] === "boolean") &&
    typeof scrollPos === "object" && scrollPos !== null && WORK_VIEW_MODES.every((m) => Number.isFinite(scrollPos[m]))
  );
}

// 窓境界を跨ぐツールは 1 ターン分に収まるので、ORPHAN_FINISH_MAX を超える退避は想定外の並びとして捨てる。
// 解放されない蓄積を避けるためで、捨てた分は running 表示が残る。
const ORPHAN_FINISH_MAX = 512;

export type LoadProgressState =
  | { phase: "preparing" }
  | { phase: "loading"; remaining: number; ratio: number }
  | { phase: "failed"; reason: string; detail?: string; onRetry: () => void };

function clockLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(uiLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// 新規作成と撤回後の描き直しはどちらも buildSegParts で組む。片方だけ形を変えると増分描画の前提が崩れる。
function buildSegParts(seg: HTMLElement): { committed: HTMLElement; tail: HTMLElement } {
  seg.textContent = "";
  const committed = document.createElement("div");
  committed.className = "seg-committed";
  const tail = document.createElement("div");
  tail.className = "seg-tail";
  seg.append(committed, tail);
  return { committed, tail };
}

// R-TAB-06: 実行ログの状態を色だけで区別しない。
const TOOL_STATUS_GLYPH: Record<WorkRowData["status"], string> = { running: "", done: "✓", failed: "✗", stale: "⏸" };
// 同じ文字列でも代入すると子のテキストノードが作り直され、視界の上端がそこにあるとブラウザの scroll anchoring の基準が失われる（verify-history-prepend#HPmut-10）。
function setTextIfChanged(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
// R-ANL-11 / R-ANL-12: 分析タブを張り付きで始めると初回に末尾へ飛び、ボタンが画面から消える。追記に追従するのは実行ログだけ。
const WORK_VIEW_AT_BOTTOM_INITIAL: Record<WorkViewMode, boolean> = { summary: false, graph: false, analysis: false, log: true };

// R-SES-02 / R-DSP-20: 概要の実行中はタブのドットと同じ isTabActive の変化を onTabActivity で受ける。
export let onTabActivity: ((tabId: string, active: boolean) => void) | undefined;
export function setOnTabActivity(fn: typeof onTabActivity): void {
  onTabActivity = fn;
}

export let onConvViewShown: ((tabId: string) => void) | undefined;
export function setOnConvViewShown(fn: typeof onConvViewShown): void {
  onConvViewShown = fn;
}

// Record-keyed ask state is tab-independent and never pruned by tab close, so it is bounded here.
const ASK_MESSAGE_STATE_MAX = 500;

export class Tab {
  private youStoreValue?: ReturnType<typeof createYouItems>;
  private get youStore(): ReturnType<typeof createYouItems> {
    if (this.youStoreValue === undefined) {
      const state = vscode.getState();
      this.youStoreValue = createYouItems(this.tabId,
        { tab: state?.askDismissed?.[this.tabId] ?? [], messages: state?.askDismissedMessages ?? [] },
        (replyId, offset) => this.locateAsk(replyId, offset));
    }
    return this.youStoreValue;
  }
  private readonly recordReplyIds = new Set<string>();

  private locateAsk(replyId: string, offset: number): { message: string; start: number } | undefined {
    if (this.recordReplyIds.has(replyId)) return { message: replyId, start: 0 };
    const past = this.pastConvRecords.get(replyId);
    let joined = "";
    for (const run of past ?? this.assistantRuns.filter((run) => run.seg.dataset.askSource === replyId)) {
      joined += recordSeparator(joined);
      const start = joined.length;
      joined += run.text;
      if (offset < joined.length) return offset >= start && run.uuid !== null ? { message: run.uuid, start } : undefined;
    }
    return undefined;
  }

  private persistAskDismissals(identities: readonly AskIdentity[]): void {
    if (identities.length === 0) return;
    const state = vscode.getState() ?? { activeTabId: null };
    const askDismissed = { ...state.askDismissed };
    const superseded = new Set(identities.filter((i) => i.message !== undefined).map((i) => encodeAskDismissal({ content: i.content })));
    askDismissed[this.tabId] = [...new Set([...(askDismissed[this.tabId] ?? []).filter((e) => !superseded.has(e)), ...identities.map(encodeAskDismissal)])];
    const messages = identities.flatMap((i) => (i.message === undefined ? [] : [i.message]));
    const askDismissedMessages = [...new Set([...(state.askDismissedMessages ?? []), ...messages])].slice(-ASK_MESSAGE_STATE_MAX);
    vscode.setState({ ...state, askDismissed, askDismissedMessages });
  }
  get youItems(): YouItemsReader { return this.youStore.reader; }
  private askReplyEvents = new Map<string, NormalizedEvent>();
  private askRenderEnds = new WeakMap<HTMLElement, number>();
  private askReplyParts = new Map<string, number>();
  private askCountersScheduled = false;

  private observeYouEvent(ev: NormalizedEvent): void {
    this.youStore.observe(ev);
    if (ev.kind === "assistant_text_delta") this.askReplyEvents.set(ev.turnId, ev);
  }

  private readonly askChoiceLines = new Map<string, string>();

  private renderReplyMarkdown(container: HTMLElement, text: string, replyId = this.currentAssistantBlock?.dataset.askSource ?? this.currentSegTurnId ?? this.currentTurnId ?? "", offset = 0, at?: number, order?: number, generation?: number): void {
    const event = this.askReplyEvents.get(replyId) ?? this.askReplyEvents.get(this.currentSegTurnId ?? "");
    const ids = new Set<string>();
    const hadAsks = container.querySelector(".laisora-ask") !== null;
    renderMarkdownInto(container, text, this.tabId, {
      replyId, offset,
      register: (ask, position) => {
        ids.add(`ask:${replyId}:${position}`);
        return this.youStore.ask(ask, { replyId, offset: position, createdAt: at ?? event?.timestamp ?? 0, order: order ?? event?.seq, generation: generation ?? event?.generation });
      },
      choose: (value, askKey, title) => {
        setActiveTab(this.tabId);
        const merged = mergeAskChoice(inputEl.value, askKey, title, value, this.askChoiceLines.get(askKey));
        inputEl.value = merged.text;
        this.askChoiceLines.set(merged.askKey, value);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.focus();
        inputEl.setSelectionRange(merged.caret, merged.caret);
        persistState();
      },
      checked: (id, step) => {
        const state = vscode.getState();
        const message = this.youStore.messageOf(id);
        const byMessage = message === undefined ? undefined : state?.askCheckedMessages?.[message]?.[step];
        return (byMessage ?? state?.askChecks?.[this.tabId]?.[id]?.[step]) === true;
      },
      check: (id, step, checked) => {
        const state = vscode.getState() ?? { activeTabId: null };
        const askChecks = { ...state.askChecks };
        const tabChecks = { ...askChecks[this.tabId] };
        const values = [...(tabChecks[id] ?? [])];
        values[step] = checked;
        tabChecks[id] = values;
        askChecks[this.tabId] = tabChecks;
        const message = this.youStore.messageOf(id);
        let askCheckedMessages = state.askCheckedMessages;
        if (message !== undefined) {
          const { [message]: previous, ...rest } = askCheckedMessages ?? {};
          const next = [...(previous ?? [])];
          next[step] = checked;
          askCheckedMessages = Object.fromEntries([...Object.entries(rest), [message, next]].slice(-ASK_MESSAGE_STATE_MAX));
        }
        vscode.setState({ ...state, askChecks, askCheckedMessages });
      },
    });
    this.youStore.retain(replyId, offset, Math.max(offset + text.length, this.askRenderEnds.get(container) ?? 0), ids);
    this.askRenderEnds.set(container, offset + text.length);
    if ((hadAsks || ids.size > 0) && !this.askCountersScheduled) {
      this.askCountersScheduled = true;
      queueMicrotask(() => { this.askCountersScheduled = false; updateAskCounters(this.convEl); });
    }
  }

  readonly planPanel: PlanPanel;
  readonly summaryYou: YouList;
  private readonly chatYou: YouList;
  readonly logEl: HTMLElement;
  // 会話面へ描く種別は src/conv-renderable.ts#isConvRenderableEvent が決める。
  readonly convEl: HTMLElement;
  readonly workEl: HTMLElement;
  private headEl!: HTMLElement;
  private viewTabs = {} as Record<"chat" | WorkViewMode, HTMLButtonElement>;
  private viewNav!: HTMLElement;
  private viewNavObserver?: ResizeObserver;
  private turnRailResizeObserver?: ResizeObserver;
  private turnRailMutationObserver?: MutationObserver;
  private changingView = false;
  setWorkViewMode?: (mode: WorkViewMode) => void;
  syncWorkVisibility?: () => void;
  setWorkViewVisible?: (visible: boolean) => void;
  // クラス名は `conv-load` だが、状況面の進行もこの要素に描く（renderLoadSlot）。
  private convLoadEl!: HTMLElement;
  private convLoadIconEl!: HTMLElement;
  private convLoadTextEl!: HTMLElement;
  private convLoadBarEl!: HTMLElement;
  private convLoadFillEl!: HTMLElement;
  private convLoadRetryEl!: HTMLButtonElement;
  private convLoadState: LoadProgressState | null = null;
  private workLoadState: LoadProgressState | null = null;
  private handoffStatusEl!: HTMLElement;
  private handoffStatusIconEl!: HTMLElement;
  private handoffStatusLinesEl!: HTMLElement;
  private handoffStatusTextEl!: HTMLElement;
  private handoffCancelEl!: HTMLButtonElement;
  private handoffPlayfulEl: HTMLElement | null = null;
  // 心拍ごとの独立抽選へ変えない。同じ行が続けて出る。verify-webview-wiring#W-HND-11 はこの退化を確実には落とさない。
  private handoffPlayfulDeck: string[] = [];
  private handoffPlayfulLast: string | null = null;
  private handoffQuietTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffRunId: string | null = null;
  private readonly handoffEndedRunIds = new Set<string>();
  private readonly handoffCardRunIds = new Set<string>();
  private restoredHandoffCard: HTMLElement | undefined;
  handoffSource?: NonNullable<ConversationSnapshot["handoffSource"]>;
  private readonly handoffCardEls = new Map<string, HTMLElement>();
  // 重複・逆順の part を捨て、次の要求を二重に出さないために持つ。
  private readonly handoffExpectedPart = new Map<string, number>();
  private readonly handoffDetailRequested = new Set<string>();
  private handoffClearTimer: ReturnType<typeof setTimeout> | null = null;
  private convCursorEl: HTMLElement | null = null;
  viewMode: ViewMode = "conv";
  private scrollPos: Record<ViewMode, number> = { conv: 0, work: 0 };
  // R-TAB-06: サブタブを往復しても位置を失わないよう、サブタブごとに持つ。
  private workViewScrollPos: Record<WorkViewMode, number> = { summary: 0, graph: 0, analysis: 0, log: 0 };
  private workViewAtBottom: Record<WorkViewMode, boolean> = { ...WORK_VIEW_AT_BOTTOM_INITIAL };
  // 初期値は src/webview/work-overview.ts#WorkOverview の mode の初期値と揃える。
  private workView: WorkViewMode = "summary";
  get workViewMode(): WorkViewMode { return this.workView; }
  private workViewReturnRow: HTMLElement | null = null;
  // live では発言がターン開始より先に届くので、noteHumanHeadline が lastHumanHeadline へ持ち越す。
  private lastHumanHeadline: string | null = null;
  // history では turn_started が user_message より先に届くので、見出しを後から埋める。live の区切りだけを指し、
  // pastPendingAnchor と共有しない。共有すると後から届く live の発言が過去の区切りへ入り、以後の見出しがずれる（R-TAB-09、verify-history-prepend#HP-C26）。
  private pendingHeadlineAnchor: HTMLElement | null = null;
  // chunk は新しい順に届き chunk 内は時系列順なので、区切りと発言の組は chunk 境界で割れうる。turnId の無い発言は
  // 直後に始まったターンにだけ付け、chunk 末尾に残った分は takePastChunkTail が渡す。見出し待ちの区切りへ即座に入れると、
  // 発言なしで始まったターンが次の発言を引き取り、以後の見出しがずれる（R-TAB-09、verify-history-prepend#HPmut-21）。
  private pastPendingAnchor: HTMLElement | null = null;
  private pastPendingChunk = 0;
  private pastPendingFirst = false;
  private pastChunkTurnSeen = false;
  private pastHeadline: { text: string; turnId: string | null; chunk: number | null } | null = null;
  private pastChunkSerial = 0;
  private atBottom: Record<ViewMode, boolean> = { conv: true, work: true };
  // 書き手は src/webview/work-graph.ts#GraphScrollPort の setHold だけ。
  private graphHold = false;
  // restoreScroll が当てるまでは退避の答えも unappliedCarry を使う。新しい DOM の scrollTop はまだ当てていない値。
  private unappliedCarry: ScrollCarry | undefined;
  // restoreScroll が当てる前の logsEl.scrollTop は前のタブの値。
  private scrollRestored = false;
  private carryAnchor: Partial<Record<ViewMode, RowAnchor>> = {};
  private carryAwaitsConvBackfill = false;
  // persistState は打鍵ごとに呼ばれるので、位置が動いていなければ elementsFromPoint で測り直さない。
  private knownAnchor: Partial<Record<ViewMode, RowAnchor>> = {};
  // 今の logsEl.scrollTop と違えば knownAnchor は古い位置の行で、新しい scrollPos と組にすると復元が別の行へ合う。
  // scroll イベントや scrollPos では判定しない（移動系は scroll イベントより先に scrollPos を書き、イベントは次のフレームまで届かない）。
  private anchorMeasuredTop: number | undefined;
  // 諦めの判定に scrollTop の変化を使わない。画像差し替えなどの補正も scroll を起こす。利用者の操作は src/webview/main.ts#abandonAwaitedScrollAnchor が伝える。
  private awaitedConvAnchor: RowAnchor | undefined;
  // ツールを挟んでも同じターンの本文を別の回答に見せないためのコンテナ。
  private currentAssistantTurn: HTMLElement | null = null;
  readonly tabBtn: HTMLElement;
  labelEl!: HTMLElement;
  private sessionHeader!: ReturnType<typeof createSessionHeader>;

  receiveSessionNameSuggestion(message: Extract<HostToWebview, { type: "sessionNameSuggestion" }>): void {
    this.sessionHeader.receiveSuggestion(message);
  }
  private sessionFirstAt: number | undefined;
  private sessionObservedAt: number | undefined;
  private sessionFallbackAt: number | undefined;
  private titleDateEl: HTMLElement | undefined;

  observeSessionTime(at: number | null | undefined, source: "turn" | "session" | "fallback" = "turn"): void {
    if (at == null || at <= 0 || !Number.isFinite(new Date(at).getTime())) return;
    const previousFirstAt = this.sessionObservedAt ?? this.sessionFirstAt ?? this.sessionFallbackAt;
    if (source === "session") this.sessionObservedAt = at;
    else if (source === "fallback") this.sessionFallbackAt = at;
    else this.sessionFirstAt = Math.min(this.sessionFirstAt ?? at, at);
    const firstAt = this.sessionObservedAt ?? this.sessionFirstAt ?? this.sessionFallbackAt!;
    if (firstAt === previousFirstAt) return;
    const date = new Date(firstAt);
    if (!this.titleDateEl) {
      this.titleDateEl = document.createElement("div");
      this.titleDateEl.className = "conv-title-date";
      this.sessionHeader.element.after(this.titleDateEl);
    }
    this.titleDateEl.textContent = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")} · ${clock(firstAt)}`;
  }

  setSessionMenuActive(active: boolean): void {
    this.sessionHeader.mountMenu(active ? sessionActionsEl : null);
  }

  rename(title: string): void {
    this.title = title;
    this.labelEl.textContent = title;
    this.labelEl.title = title;
    this.sessionHeader.updateTitle(title);
  }

  // 文面は HANDOFF_FAILURE_MESSAGES と handoffRunningText が決め、Host の message は読まない。
  showHandoffStatus(msg: HandoffStatusMessage): void {
    if (msg.state === "done" && msg.fork?.tabId === this.tabId && !this.handoffCardRunIds.has(msg.runId)) {
      this.handoffCardRunIds.add(msg.runId);
      this.restoredHandoffCard?.remove();
      this.restoredHandoffCard = undefined;
      this.handoffCardEls.set(msg.runId, this.renderHandoffCard({ ...msg, runId: msg.runId }));
    }
    // R-HND-08: 終端を出した実行と、表示中でない実行の通知は表示を触らない（verify-webview-wiring#W-HND-1mut）。
    // 終端で所有権を手放すのは、次の実行の running を捨てないため。
    if (this.handoffEndedRunIds.has(msg.runId)) return;
    if (this.handoffRunId !== null && this.handoffRunId !== msg.runId) return;
    if (msg.state === "done") {
      this.noteHandoffEnded(msg.runId);
      if (this.handoffRunId === msg.runId) this.clearHandoffStatus();
      return;
    }
    if (this.handoffClearTimer !== null) {
      clearTimeout(this.handoffClearTimer);
      this.handoffClearTimer = null;
    }
    const failed = msg.state === "failed";
    this.handoffRunId = failed ? null : msg.runId;
    this.handoffStatusEl.classList.toggle("failed", failed);
    this.handoffStatusEl.setAttribute("role", failed ? "alert" : "status");
    this.handoffStatusIconEl.replaceChildren(failed ? document.createTextNode("✕") : createLoader(12));
    const detail =
      failed && typeof msg.detail === "string" && msg.detail.length > 0
        ? l10n.t("Reason: {0}", msg.detail.slice(0, 200))
        : "";
    this.handoffStatusTextEl.textContent = failed
      ? [handoffFailureMessage(msg.reason), detail, l10n.t("The original conversation was not changed")]
          .filter((part) => part.length > 0)
          .join(" ")
      : handoffRunningText(msg);
    this.handoffCancelEl.classList.toggle("hidden", failed);
    this.handoffCancelEl.onclick = failed
      ? null
      : () => vscode.postMessage({ type: "cancelHandoff", tabId: this.tabId, runId: msg.runId });
    this.handoffStatusEl.classList.remove("hidden");
    if (!failed && msg.phase === "compacting" && (msg.progress?.heartbeats ?? 0) > 0) {
      this.showHandoffPlayful(this.nextHandoffPlayful(), true);
      this.armHandoffQuiet();
    } else if (!failed) {
      this.endHandoffPlayful();
    }
    if (failed) {
      this.endHandoffPlayful();
      this.noteHandoffEnded(msg.runId);
      this.handoffClearTimer = setTimeout(() => this.clearHandoffStatus(), HANDOFF_FAILURE_VISIBLE_MS);
      this.flagConvAttention();
    }
  }

  // decorative=true は装飾（読み上げから隠す）。false は CLI 停止の警告で、
  // 隠すと画面を見ていない利用者に異常が一切届かない
  private showHandoffPlayful(text: string, decorative: boolean): void {
    if (this.handoffPlayfulEl === null) {
      const el = document.createElement("div");
      el.className = "handoff-status-playful";
      this.handoffPlayfulEl = el;
      this.handoffStatusLinesEl.appendChild(el);
    }
    const el = this.handoffPlayfulEl;
    el.classList.toggle("stalled", !decorative);
    if (decorative) {
      el.setAttribute("aria-hidden", "true");
      el.removeAttribute("role");
    } else {
      el.removeAttribute("aria-hidden");
      el.setAttribute("role", "status");
    }
    el.textContent = text;
  }

  private endHandoffPlayful(): void {
    if (this.handoffQuietTimer !== null) {
      clearTimeout(this.handoffQuietTimer);
      this.handoffQuietTimer = null;
    }
    this.handoffPlayfulEl?.remove();
    this.handoffPlayfulEl = null;
    this.handoffPlayfulDeck = [];
  }

  private armHandoffQuiet(): void {
    if (this.handoffQuietTimer !== null) clearTimeout(this.handoffQuietTimer);
    this.handoffQuietTimer = setTimeout(() => {
      this.handoffQuietTimer = null;
      this.showHandoffPlayful(l10n.t("No response for 90 seconds. The CLI may have stopped responding."), false);
    }, HANDOFF_QUIET_MS);
  }

  private nextHandoffPlayful(): string {
    if (this.handoffPlayfulDeck.length === 0) {
      const deck = handoffPlayfulLines();
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      if (deck[deck.length - 1] === this.handoffPlayfulLast) deck.unshift(deck.pop() as string);
      this.handoffPlayfulDeck = deck;
    }
    const line = this.handoffPlayfulDeck.pop() as string;
    this.handoffPlayfulLast = line;
    return line;
  }

  // 逐語は大きくなりうるので、全文を 1 つの文字列へ組み立てず、届いた part ごとに描く。
  showHandoffDetail(msg: HandoffDetailMessage): void {
    const card = this.handoffCardEls.get(msg.runId);
    if (card === undefined) return;
    if (msg.part !== (this.handoffExpectedPart.get(msg.runId) ?? 0)) return;
    if (msg.total === 0) {
      detailBodyOf(card, 0).textContent = HANDOFF_DETAIL_UNAVAILABLE;
      detailBodyOf(card, 1).textContent = HANDOFF_DETAIL_UNAVAILABLE;
      // 一時的な読取失敗で二度と取りに行かない状態にしない。開き直せばもう一度要求する
      this.handoffDetailRequested.delete(msg.runId);
      return;
    }
    // 要約だけ取れない記録がある。発言と決定行は出したまま、要約の欄にだけ取得不能を出す
    if (msg.part === 0) {
      detailBodyOf(card, 0).textContent = msg.summary ?? HANDOFF_DETAIL_UNAVAILABLE;
      card.querySelector(".handoff-detail summary")!.textContent = handoffSummaryHeading(msg.summary);
    }
    if (msg.decisions !== undefined) {
      const decisions = msg.decisions;
      // 初回描画で件数を知らなかったカードへの後付け。決定行を持たない引き継ぎには置かない
      // （空の展開が残る）。外すと detailBodyOf(card, 2) が undefined になる
      if (card.querySelectorAll(".handoff-detail").length < 3) {
        card.appendChild(buildHandoffDetail(l10n.t("Show the decision lines")));
      }
      renderDecisionCounts(card, {
        total: decisions.entries.length,
        carried: decisions.carried,
        extracted: decisions.extracted,
        removed: decisions.removed,
        unknownIdRefs: decisions.unknownIdRefs,
        ...(decisions.warn !== undefined ? { warn: decisions.warn } : {}),
      });
      const removed = decisions.removedLastGen ?? [];
      detailBodyOf(card, 2).textContent = [
        ...decisions.entries.map(decisionLineText),
        ...(removed.length === 0
          ? []
          : [l10n.t("--- removed this time ---"), ...removed.map(decisionLineText)]),
      ].join("\n");
    }
    const body = detailBodyOf(card, 1);
    for (const u of msg.utterances) {
      body.appendChild(document.createTextNode(`${body.childNodes.length === 0 ? "" : "\n\n"}${utteranceText(u)}`));
    }
    this.handoffExpectedPart.set(msg.runId, msg.part + 1);
    if (msg.part + 1 < msg.total) {
      vscode.postMessage({ type: "getHandoffDetail", tabId: this.tabId, runId: msg.runId, part: msg.part + 1 });
    }
  }

  // HANDOFF_RUN_MEMORY に達しても古い runId を追い出さない。カードを残したまま重複排除だけ消すと、done の再送でカードが複製される。
  private noteHandoffEnded(runId: string): void {
    if (this.handoffEndedRunIds.size < HANDOFF_RUN_MEMORY) this.handoffEndedRunIds.add(runId);
  }

  private clearHandoffStatus(): void {
    if (this.handoffClearTimer !== null) {
      clearTimeout(this.handoffClearTimer);
      this.handoffClearTimer = null;
    }
    this.endHandoffPlayful();
    this.handoffRunId = null;
    this.handoffCancelEl.onclick = null;
    this.handoffStatusTextEl.textContent = "";
    this.handoffStatusEl.classList.add("hidden");
  }

  applyHandoffSource(source: NonNullable<ConversationSnapshot["handoffSource"]>): void {
    this.handoffSource = source;
    if (this.handoffCardRunIds.size > 0 || this.restoredHandoffCard) return;
    const card = this.renderHandoffCard({
      source: { sessionId: source.sessionId, title: source.title },
      compact: source.compact,
      utteranceCount: source.utteranceCount,
      ...(source.decisionCount !== undefined ? { decisionCount: source.decisionCount } : {}),
      ...(source.detailRunId !== undefined ? { runId: source.detailRunId } : {}),
    });
    this.restoredHandoffCard = card;
    // showHandoffDetail は handoffCardEls からしか引かない。ここへ入れないと、
    // Host が返した本文が Webview 側で黙って捨てられる（R-HND-10）
    if (source.detailRunId !== undefined) this.handoffCardEls.set(source.detailRunId, card);
  }

  private renderHandoffCard(msg: {
    source: { sessionId: string; title?: string };
    compact?: { preTokens: number; postTokens: number };
    utteranceCount?: number;
    unreadableLineCount?: number;
    runId?: string;
    decisions?: HandoffDecisionCounts;
    decisionCount?: number;
  }): HTMLElement {
    const card = document.createElement("div");
    card.className = "block system handoff-card";

    const sourceRow = document.createElement("div");
    sourceRow.className = "handoff-source-row";
    const sourceLabel = document.createElement("span");
    sourceLabel.className = "handoff-source-label";
    sourceLabel.textContent = msg.source.title ? l10n.t("Handed off from: {0}", msg.source.title) : l10n.t("Previous conversation");
    sourceRow.appendChild(sourceLabel);

    if (msg.source.sessionId) {
      const linkBtn = document.createElement("button");
      linkBtn.type = "button";
      linkBtn.className = "handoff-source-link";
      linkBtn.textContent = l10n.t("Open previous conversation");
      linkBtn.title = msg.source.title ? l10n.t("Open previous conversation: {0}", msg.source.title) : l10n.t("Open previous conversation");
      linkBtn.setAttribute("aria-label", linkBtn.title);
      linkBtn.onclick = (e) => {
        e.preventDefault();
        const existing = findTabBySessionId(msg.source.sessionId);
        if (existing) {
          setActiveTab(existing.tabId);
          return;
        }
        vscode.postMessage({
          type: "openHandoffSource",
          tabId: this.tabId,
          sourceSessionId: msg.source.sessionId,
        });
      };
      sourceRow.appendChild(linkBtn);
    }
    card.appendChild(sourceRow);

    const lines: Array<{ text: string; warn?: boolean }> = [
      { text: l10n.t("Summary: {0}", formatHandoffTokens(msg.compact)) },
      { text: l10n.t("{0} of your messages attached verbatim", msg.utteranceCount ?? 0) },
      ...(msg.unreadableLineCount !== undefined
        ? [
            {
              text: l10n.t(
                "⚠ {0} lines of the record could not be read; messages on those lines may be missing from the attachment",
                msg.unreadableLineCount
              ),
              warn: true,
            },
          ]
        : []),
      { text: l10n.t("Your first message starts from this context") },
    ];
    for (const line of lines) {
      const row = document.createElement("div");
      row.textContent = line.text;
      if (line.warn) row.className = "handoff-card-warn";
      card.appendChild(row);
    }
    const decisionsSlot = document.createElement("div");
    decisionsSlot.className = "handoff-decisions-lines";
    card.appendChild(decisionsSlot);
    if (msg.decisions !== undefined) renderDecisionCounts(card, msg.decisions);
    if (msg.runId) {
      const summaryEl = buildHandoffDetail(handoffSummaryHeading(undefined));
      summaryEl.title = l10n.t("Show summary");
      const utterancesEl = buildHandoffDetail(l10n.t("Show {0} messages", msg.utteranceCount ?? 0));
      card.append(summaryEl, utterancesEl);
      const runId = msg.runId;
      const request = (): void => {
        if (this.handoffDetailRequested.has(runId)) return;
        this.handoffDetailRequested.add(runId);
        vscode.postMessage({ type: "getHandoffDetail", tabId: this.tabId, runId, part: 0 });
      };
      summaryEl.addEventListener("toggle", request);
      utterancesEl.addEventListener("toggle", request);
      // 決定行を持つ引き継ぎだけに 3 つ目を置く（持たない引き継ぎに空の展開を残さない）。
      // 本文の取得を待って足すと、要約か発言を先に開くまで決定行への導線が無い
      const lines =
        msg.decisions !== undefined ? msg.decisions.total + msg.decisions.removed : msg.decisionCount ?? 0;
      if (lines > 0) {
        const decisionsEl = buildHandoffDetail(l10n.t("Show the decision lines"));
        card.appendChild(decisionsEl);
        decisionsEl.addEventListener("toggle", request);
      }
    }
    // R-HND-09: live と復元のどちらでも、履歴 head より前の会話面の先頭に置く。
    this.convEl.insertBefore(card, this.convEl.firstChild);
    this.convEl.scrollTop = this.convEl.scrollHeight;
    return card;
  }

  auth: AuthStatus | null = null;
  resumeSessionId: string | undefined;
  configModel: string | undefined;
  configEffort: string | undefined;
  defaultEffort: string | undefined;
  appliedEffort: string | null | undefined;
  appliedModel: string | undefined;
  modelFallback?: ModelFallbackState;

  private modelLabel(model: string): string {
    return this.models.find(row => row.id === model || (row.id !== "default" && row.resolvedModel === model))?.label ?? model;
  }

  private fallbackText(ev: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): string {
    const label = (model: string): string => this.modelLabel(model);
    return ev.scope === "local"
      ? l10n.t("Local model fallback: {0} → {1} (category: {2})", label(ev.originalModel), label(ev.fallbackModel), ev.category ?? l10n.t("Unknown"))
      : l10n.t("Model switched: {0} → {1} (category: {2})", label(ev.originalModel), label(ev.fallbackModel), ev.category ?? l10n.t("Unknown"));
  }

  private fallbackStatusText(ev: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): string | undefined {
    const original = this.modelLabel(fallbackNoticeOriginal(this.modelFallback, ev));
    return ev.autoRevert === "pending" ? l10n.t("{0} will be restored automatically when this turn ends.", original)
      : ev.autoRevert === "off" ? l10n.t("Automatic restore is off; restore {0} from YOU.", original)
        : undefined;
  }

  private fallbackRevertText(ev: Extract<NormalizedEvent, { kind: "model_fallback_revert" }>): string {
    const original = this.modelLabel(ev.originalModel);
    return ev.outcome === "applied" ? l10n.t("Restored the original model {0} automatically.", original)
      : ev.outcome === "deferred" ? l10n.t("The conversation will start on the original model {0} next time.", original)
        : ev.outcome === "failed" ? l10n.t("Could not restore the original model {0} automatically; restore it from YOU.", original)
          : l10n.t("Your model selection replaced the fallback model.");
  }

  private fallbackLogText(ev: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): string {
    const status = this.fallbackStatusText(ev);
    return status === undefined ? this.fallbackText(ev) : `${this.fallbackText(ev)} ${status}`;
  }

  private decorateFallbackBlock(block: HTMLElement, ev: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): void {
    block.id = youAnchor(this.tabId, `fallback:${ev.generation}:${ev.seq}`);
    for (const [className, text] of [["you-summary", ev.explanation], ["fallback-status", this.fallbackStatusText(ev)]] as const) {
      if (!text) continue;
      const secondary = document.createElement("p");
      secondary.className = className;
      secondary.textContent = text;
      block.append(secondary);
    }
  }

  setModelFallback(state: ModelFallbackState | undefined): void {
    this.modelFallback = state;
    if (state && fallbackNeedsConfirmation(state)) {
      this.youStore.fallback(state, this.fallbackText(state.notice));
      this.youStore.appliedModel(state.appliedModel, state.resolvedAt ?? state.notice.timestamp, this.models);
    }
  }

  observeAppliedModel(model: string | null | undefined): void {
    const next = applyFallbackModel(this.modelFallback, model, Date.now(), this.models);
    if (next !== this.modelFallback) this.setModelFallback(next);
    if (model) this.youStore.appliedModel(model, Date.now(), this.models);
  }

  chooseModel(model: string | null | undefined): void {
    this.setModelFallback(resolveFallbackByChoice(this.modelFallback, model, Date.now()));
    if (model) this.youStore.appliedModel(model, Date.now(), this.models);
  }

  private restoreFallbackModel(model: string): void {
    vscode.postMessage({ type: "setModel", tabId: this.tabId, model, sessionOnly: true });
  }

  recordedModel: string | undefined;
  permissionMode: PermissionModeId = "default";
  commands: SlashCommandInfo[] = [];
  models: ModelInfo[] = [];
  modelOverride: string | null | undefined = undefined;
  effortOverride: string | null | undefined = undefined;
  turnState: "idle" | "running" | "interrupting" = "idle";
  usage: UsageSnapshot | null = null;
  contextUsage: Extract<NormalizedEvent, { kind: "context_usage" }> | null = null;
  currentTurnId: string | null = null;
  // 孤児デルタの採用可否は adoptOrphanTurn が knownTurnIds で決める。既知の turnId を採用すると、次のターン開始後に届く遅延 final が
  // 終わったターンを開き直す（verify-detail-cards#OAmut-2）。adoptedTurnIds は採用したターンを turn_started で開き直さないために持つ。
  private readonly knownTurnIds = new Set<string>();
  private readonly adoptedTurnIds = new Set<string>();
  // src/webview/main.ts は再生しない経路でも installHistoryHead を呼ぶので、replayDone が再生中かどうかの唯一の目印になる。
  // 再生窓が turn_started を落としただけの採用を live の異常として診断しない（verify-detail-cards#OA-8）。
  private replayDone = false;
  pendingSend = false;
  private currentAssistantBlock: HTMLElement | null = null;
  private assistantBuffer = "";
  private liveRecordOpen = false;
  private replyFinished = false;
  private convBlockAfterRecordIn: HTMLElement | null = null;
  // R-CNV-15: 返信フッターは replyFooterAnchor の直後に置く。
  private replyFooterAnchor: HTMLElement | null = null;
  private readonly suspendedReplies = new Map<string, ReturnType<Tab["captureReply"]>>();
  private retryBlock: HTMLElement | null = null;

  // R-DSP-01: 撤去しないと、回復後や再生後も再試行中の警告が残る。
  private clearRetryBlock(): void {
    this.retryBlock?.remove();
    this.retryBlock = null;
  }
  private pendingDeltaText = "";
  private rafScheduled = false;
  // currentTurnId は次の turn_started で先に進むので、セグメントの帰属はデルタ受理時の値で決める。
  private pendingDeltaTurnId: string | null = null;
  private currentSegTurnId: string | null = null;
  // R-CNV-09: prependPastConvEvents が裏読みの本文を結合する先。keepRecordOpen で末尾が書き込み可能なままの候補も含む。
  private topConvSeg: { turnId: string; el: HTMLElement; text: string; records: RecordTextPart[] } | null = null;
  private toolCards = new Map<string, HTMLElement>();
  private segmentCards = new Map<string, SegmentCard>();
  private replayMarkerShown = false;
  private lastObservedModel: string | null = null;
  // 会話の過去 chunk は replayMarkerEl より上へ入れる。マーカーより下は復元分を意味するので、より古い分を下へ入れると意味が逆になる。
  private replayMarkerEl: HTMLElement | null = null;
  private convHistoryEl: HTMLElement | null = null;
  private convHistoryBodyEl: HTMLElement | null = null;
  // live の復元ブロックも登録する。登録しないと取り寄せた過去 chunk と重複する（verify-conversation-history#CH-C4）。
  private convMessageUuids = new Set<string>();
  private convPrependedTotal = 0;
  // renderedEventKeys と共有しない。同じ chunk が両面へ別々に流れるので、共有すると作業ログ側が先に描いた時点で会話側が描かれなくなる。
  private renderedConvEventKeys = new Set<string>();
  private pastConvTurns = new Map<string, { el: HTMLElement; text: string }>();
  private pastConvRecords = new Map<string, RecordTextPart[]>();
  private assistantLeadingRecord: { turnId: string; uuid: string } | null = null;
  // events 由来の chunk では本文と完了時刻が別の chunk に割れうるので、pastConvFooters と pastTurnCompletedAt を turnId で持ち越して突き合わせる。
  private pastConvFooters = new Map<string, HTMLElement>();
  private pastTurnCompletedAt = new Map<string, number>();
  private lastPastModel: string | null = null;
  private workReplayMarkerShown = false;
  private todoCardEl: HTMLDetailsElement | null = null;
  private todoSummaryEl: HTMLElement | null = null;
  private todoListEl: HTMLElement | null = null;
  private todoWork = new Map<string, HTMLElement>();
  // 展開状態は利用者の操作でだけ変える。再描画や状態の変化で開閉しない。
  private todoRowOpen = new Map<string, boolean>();
  // reducer が配置を作らなかった開始の toolUseId。終了側でツール行として扱わないために持つ。
  private nonWorkToolUseIds = new Set<string>();
  private toolStartTimes = new Map<string, number>();
  private agentCards = new Map<string, AgentCardEntry>();
  private rowData = new Map<string, WorkRowData>();
  private bgTaskIdToToolUseId = new Map<string, string>();
  private workRevision = 0;
  private segmentTotals = new Map<string, WorkSegmentView>();
  // R-TAB-09: 過去カードの描画にだけ使い、segmentTotals と agentStates へ混ぜない。chunk は新しい側から届くので、revision が新しい値だけを残す。
  private pastSegmentTotals = new Map<string, WorkSegmentView>();
  private pastAgentStates = new Map<string, WorkAgentStateView>();
  private taskTotals = new Map<string, WorkTaskTotalsView>();
  private agentStates = new Map<string, WorkAgentStateView>();
  private taskItems: WorkTaskItemView[] = [];
  // 件数は WorkEventInfo の pendingApprovalCount から受ける。承認カードは会話面・作業ログ・ミラーに現れうるので DOM を数えない。
  private pendingApprovalCount = 0;
  private approvalCards = new Map<string, HTMLElement>();
  private approvalRefs = new Map<string, HTMLElement>();
  // イベントごとに報告すると診断が溢れるので、一度だけ報告する。
  private missingWorkInfoReported = false;
  private pastRender: PastRenderContext | null = null;
  private historyHeadEl: HTMLElement | null = null;
  private historyMoreEl: HTMLElement | null = null;
  private historyBodyEl: HTMLElement | null = null;
  // cursor は消費されないので同じ chunk が何度でも返る。要求単位でなくイベント単位で弾く（verify-history-prepend#HPmut-2）。
  private renderedEventKeys = new Set<string>();
  // 窓境界や chunk 境界を跨ぐと、更新が対象の行より先に処理される。保留しないとツールが running のまま残り、
  // モデルチップが宣言値のまま、解決済み承認が未解決に見える。対象を作った時点で当て直して消す（verify-history-prepend#HPmut-3）。
  private orphanFinishes = new Map<string, Extract<NormalizedEvent, { kind: "tool_call_finished" }>>();
  private orphanSubagentInfo = new Map<string, Extract<NormalizedEvent, { kind: "subagent_info" }>>();
  private orphanApprovalResolved = new Map<
    string,
    Extract<NormalizedEvent, { kind: "approval_resolved" }>
  >();
  // reducer が stale へ移したが行がまだ無かった toolUseId（verify-history-prepend#HPmut-14）。
  private orphanStaled = new Set<string>();
  // workEl 配下の `.hll-past` の実数と一致しなければ、作った行が未接続コンテナへ落ちている（verify-history-prepend#HPmut-5）。
  // 履歴状態は tabCleared でも Tab ごと作り直されるので、個別の破棄経路を持たない。
  private pastRenderedTotal = 0;

  // 親の委任を観測できない間も isTabActive でタブを点灯させるために持つ。
  private runningChildTools = new Map<string, { name: string; parentId: string }>();
  // 規則は src/background-activity.ts だけが持つ。snapshot の Host 現在値で置き換える（replaceBackgroundActivity）。
  // 再生したイベントだけから作ると、窓から起動が落ちた背景だけのタブが消灯する（R-SES-02）。
  private activity: BackgroundActivityState = createBackgroundActivityState();
  // 新規セッションの最初のターンは provider 時刻が未観測で turn_started の timestamp が 0 になり、Host は実時計で埋めない。
  // 0 を起点にすると経過表示がエポック起点になるので、表示用の起点は webview の壁時計で補う。
  private stripStartedAt: number | null = null;
  private stripSince: number | null = null;
  private runningMainTools = new Map<string, { name: string; intentInput?: ToolIntentInput }>();
  private logRefreshPending = false;
  private readonly logFoldOverrides = new Map<string, boolean>();
  private readonly logTurnAliases = new Map<string, string>();
  private readonly logTurnEnds = new Map<string, number>();
  private readonly logRequests = new Map<string, LogRequest>();
  private readonly logAnchors = new Map<string, HTMLElement>();
  private readonly logTaskRequests = new Set<string>();
  private readonly logDirty = new Set<string>();
  private readonly logToolRequests = new Map<string, string>();
  private readonly logFinishOrder = new Map<string, number[]>();
  private readonly logRunningLabels = new Map<string, (now: number) => void>();
  private readonly logRequestMeta = new Map<string, NonNullable<WorkModelPayload["requests"]>[number]>();
  private logLatestRequest: string | undefined;
  private logEventTurn: string | undefined;
  private workModel: WorkModelPayload | undefined;
  private openYouCount = 0;
  private stripWrapEl!: HTMLElement;
  private stripEl!: HTMLElement;
  private stripSpinnerEl!: HTMLElement;
  private stripTextEl!: HTMLElement;
  private stripTimeEl!: HTMLElement;
  private stripNoteEl!: HTMLElement;

  constructor(readonly tabId: string, public title: string) {
    this.logEl = document.createElement("div");
    this.logEl.className = "log";
    // パネルより前に置かないと logsEl に対する sticky が効かない。
    this.headEl = document.createElement("div");
    this.headEl.className = "log-head";
    this.headEl.dataset.view = "conv";
    const content = document.createElement("div");
    content.className = "log-content";
    content.appendChild(this.headEl);
    this.sessionHeader = createSessionHeader(this.tabId, title, message => vscode.postMessage(message));
    const heading = document.createElement("div");
    heading.className = "session-header";
    const titleBlock = document.createElement("div");
    titleBlock.className = "session-heading-block";
    titleBlock.appendChild(this.sessionHeader.element);
    this.headEl.appendChild(heading);
    this.buildViewSwitch();
    const progress = document.createElement("div");
    progress.className = "pane-progress-row";
    progress.append(this.buildConvLoad(), this.buildHandoffStatus());
    heading.append(titleBlock, progress);
    this.buildStrip(progress);
    // headEl の高さは syncHeadLayout を通らない契機でも変わるので、ResizeObserver でも syncLogHeadHeight を呼ぶ。
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.syncLogHeadHeight()).observe(this.headEl);

    this.convEl = document.createElement("div");
    this.convEl.className = "panel panel-conv active";
    this.convEl.id = `panel-conv-${this.tabId}`;
    this.convEl.setAttribute("role", "tabpanel");
    this.convEl.setAttribute("aria-labelledby", `viewtab-conv-${this.tabId}`);
    this.convEl.tabIndex = 0;
    this.workEl = document.createElement("div");
    this.workEl.className = "panel panel-work";
    this.workEl.id = `panel-work-${this.tabId}`;
    const chat = document.createElement("div");
    chat.className = "plan-chat";
    chat.append(this.convEl);
    content.append(chat, this.workEl);
    this.planPanel = new PlanPanel(chat, this.headEl, this.tabId);
    this.chatYou = new YouList(this.youItems, item => this.navigateToYou(item), (count, total) => {
      this.planPanel.setWaiting(count, total);
      this.openYouCount = count;
      // R-SES-11: the constructor's initial notification precedes tabBtn; updateStrip uses syncTabDot.
      if (this.tabBtn !== undefined) this.updateStrip();
    }, item => this.dismissYou(item), model => this.restoreFallbackModel(model));
    this.summaryYou = new YouList(this.youItems, item => this.navigateToYou(item), undefined, item => this.dismissYou(item), model => this.restoreFallbackModel(model));
    this.planPanel.you.append(this.chatYou.element);
    this.logEl.appendChild(content);
    logsEl.appendChild(this.logEl);
    this.observeTurnRails();

    // button 入れ子は HTML/ARIA 違反のため div[role=tab] にする
    this.tabBtn = document.createElement("div");
    this.tabBtn.className = "tab";
    this.tabBtn.setAttribute("role", "tab");
    this.tabBtn.tabIndex = 0;
    this.tabBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setActiveTab(this.tabId);
      }
    });
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = title;
    // タブ名は CSS で切れるので、似た名前のセッションを見分けるために rename だけでなく生成時にも title を設定する。
    label.title = title;
    this.labelEl = label;
    const dot = document.createElement("span");
    dot.className = "tab-dot";
    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = l10n.t("Close tab");
    close.setAttribute("aria-label", l10n.t("Close {0}", title));
    close.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "closeTab", tabId: this.tabId });
    };
    this.tabBtn.append(dot, label, close);
    this.tabBtn.onclick = () => setActiveTab(this.tabId);
    tabbarEl.appendChild(this.tabBtn);
  }

  destroy(): void {
    this.chatYou.destroy();
    this.summaryYou.destroy();
    this.planPanel.destroy();
    clearPendingImageLoads(this);
    this.viewNavObserver?.disconnect();
    this.turnRailResizeObserver?.disconnect();
    this.turnRailMutationObserver?.disconnect();
    this.sessionHeader.mountMenu(null);
    this.logEl.remove();
    this.tabBtn.remove();
  }

  private observeTurnRails(): void {
    const resize = new ResizeObserver(() => this.syncTurnRails());
    this.turnRailResizeObserver = resize;
    resize.observe(this.convEl);
    this.turnRailMutationObserver = new MutationObserver(records => {
      if (!records.some(record => record.target === this.convEl ||
        record.target instanceof HTMLElement && record.target.matches(".convlog-history, .convlog-history-body"))) return;
      resize.disconnect();
      resize.observe(this.convEl);
      for (const row of Array.from(this.convEl.querySelectorAll(":scope > *, .convlog-history > *, .convlog-history-body > *"))) {
        resize.observe(row);
      }
      this.syncTurnRails();
    });
    this.turnRailMutationObserver.observe(this.convEl, { childList: true, subtree: true });
  }

  private syncTurnRails(): void {
    if (this.convEl.getClientRects().length === 0) return;
    const turns = Array.from(this.convEl.querySelectorAll<HTMLElement>(".block.user, .block.assistant, .block.assistant-turn"));
    const heights = turns.map((turn, index) => {
      if (!turn.classList.contains("user")) return null;
      const next = turns[index + 1];
      // Both markers share the same centre offset; preserve fractional pixels to stop exactly at the next marker.
      return next ? `${next.getBoundingClientRect().top - turn.getBoundingClientRect().top}px` : "";
    });
    turns.forEach((turn, index) => {
      const height = heights[index];
      if (height !== null && turn.style.getPropertyValue("--user-rail-height") !== height) {
        if (height) turn.style.setProperty("--user-rail-height", height);
        else turn.style.removeProperty("--user-rail-height");
      }
    });
  }

  syncHeadLayout(): void {
    if (activeTabId !== this.tabId) return;
    if (logsEl.clientHeight <= 0) return;
    // Resize/composer updates must also cap the separate navigation rail;
    // ResizeObserver delivery may lag behind the scroll to the new bottom.
    this.syncViewNavHeight();
    this.syncLogHeadHeight();
  }

  // `--log-head-h` は media/main.css の `.wg-head` の top が読む。
  private syncLogHeadHeight(): number {
    const headH = this.headEl.getBoundingClientRect().height;
    if (headH > 0) this.logEl.style.setProperty("--log-head-h", `${headH}px`);
    return headH;
  }

  private buildViewSwitch(): void {
    const list = document.createElement("nav");
    list.className = "view-switch";
    this.viewNav = list;
    const tabsWrap = document.createElement("div");
    tabsWrap.className = "view-switch-tabs";
    tabsWrap.setAttribute("role", "tablist");
    tabsWrap.setAttribute("aria-orientation", "vertical");
    tabsWrap.setAttribute("aria-label", l10n.t("Switch view"));
    const defs: Array<{ pane: "chat" | WorkViewMode; label: string; panelId: string }> = [
      { pane: "chat", label: l10n.t("Chat"), panelId: `panel-conv-${this.tabId}` },
      { pane: "summary", label: l10n.t("Summary"), panelId: `wo-panel-${this.tabId}` },
      { pane: "graph", label: l10n.t("Graph"), panelId: `wg-panel-${this.tabId}` },
      { pane: "analysis", label: l10n.t("Analysis"), panelId: `wa-panel-${this.tabId}` },
      { pane: "log", label: l10n.t("Log"), panelId: `panel-work-${this.tabId}` },
    ];
    defs.forEach((d, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = d.pane === "chat" ? "view-switch-tab" : "view-switch-tab work-view-tab";
      btn.dataset.pane = d.pane;
      btn.setAttribute("role", "tab");
      btn.id = d.pane === "chat" ? `viewtab-conv-${this.tabId}` : `wotab-${d.pane}-${this.tabId}`;
      btn.setAttribute("aria-controls", d.panelId);
      btn.setAttribute("aria-label", d.label);
      const number = document.createElement("span");
      number.className = "view-switch-number";
      number.setAttribute("aria-hidden", "true");
      number.textContent = String(index + 1).padStart(2, "0");
      const label = document.createElement("span");
      label.className = "view-switch-label";
      label.textContent = d.pane.toUpperCase();
      btn.append(number, label);
      btn.onclick = () => this.selectPane(d.pane);
      btn.addEventListener("keydown", (e) => {
        let next: number;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (index + 1) % defs.length;
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (index + defs.length - 1) % defs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = defs.length - 1;
        else return;
        e.preventDefault();
        this.selectPane(defs[next].pane, true);
      });
      this.viewTabs[d.pane] = btn;
      tabsWrap.appendChild(btn);
    });
    list.appendChild(tabsWrap);
    this.logEl.appendChild(list);
    this.syncViewTabs();
    // Bound the rail to the actual scroll port. Its own overflow must never
    // lengthen a short conversation (R-TAB-10 / R-CNV-13).
    this.viewNavObserver = new ResizeObserver(() => this.syncViewNavHeight());
    this.viewNavObserver.observe(logsEl);
    this.viewNavObserver.observe(tabsWrap);
  }

  private syncViewNavHeight(): void {
    const tabsWrap = this.viewNav.firstElementChild!;
    const height = Math.min(tabsWrap.scrollHeight, Math.max(0, logsEl.clientHeight - 24));
    this.viewNav.style.setProperty("--view-nav-h", `${height}px`);
  }

  syncViewTabs(moveFocus = false): void {
    const selected = this.viewMode === "conv" ? "chat" : this.workView;
    for (const [pane, btn] of Object.entries(this.viewTabs)) {
      btn.classList.toggle("active", pane === selected);
      btn.setAttribute("aria-selected", String(pane === selected));
      btn.tabIndex = pane === selected ? 0 : -1;
    }
    if (moveFocus && activeTabId === this.tabId) {
      const btn = this.viewTabs[selected];
      btn.focus({ preventScroll: true });
      const rail = this.viewNav.getBoundingClientRect();
      const target = btn.getBoundingClientRect();
      if (target.top < rail.top) this.viewNav.scrollTop -= rail.top - target.top;
      else if (target.bottom > rail.bottom) this.viewNav.scrollTop += target.bottom - rail.bottom;
    }
  }

  persistViewState(): void {
    if (!this.changingView) persistState();
  }

  withViewChange(action: () => void): void {
    const outer = this.changingView;
    this.changingView = true;
    try { action(); }
    finally { this.changingView = outer; }
    this.persistViewState();
  }

  selectPane(pane: "chat" | WorkViewMode, moveFocus = false): void {
    const selected = this.viewMode === "conv" ? "chat" : this.workView;
    if (pane !== selected) {
      this.withViewChange(() => {
        if (pane === "chat") this.setViewMode("conv");
        else {
          this.setWorkViewMode?.(pane);
          // setMode restores the work subview's position. Do not place it twice.
          if (this.viewMode === "conv") this.setViewMode("work");
        }
      });
    }
    this.syncViewTabs(moveFocus);
  }

  private buildHandoffStatus(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "handoff-status hidden";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    this.handoffStatusIconEl = document.createElement("span");
    this.handoffStatusIconEl.className = "handoff-status-icon";
    this.handoffStatusIconEl.setAttribute("aria-hidden", "true");
    this.handoffStatusLinesEl = document.createElement("div");
    this.handoffStatusLinesEl.className = "handoff-status-lines";
    this.handoffStatusTextEl = document.createElement("div");
    this.handoffStatusTextEl.className = "handoff-status-text";
    this.handoffStatusLinesEl.appendChild(this.handoffStatusTextEl);
    this.handoffCancelEl = document.createElement("button");
    this.handoffCancelEl.type = "button";
    this.handoffCancelEl.className = "handoff-status-cancel";
    this.handoffCancelEl.textContent = l10n.t("Cancel");
    wrap.append(this.handoffStatusIconEl, this.handoffStatusLinesEl, this.handoffCancelEl);
    this.handoffStatusEl = wrap;
    return wrap;
  }

  private buildConvLoad(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "conv-load hidden";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    this.convLoadIconEl = document.createElement("span");
    this.convLoadIconEl.className = "conv-load-icon";
    this.convLoadIconEl.setAttribute("aria-hidden", "true");
    this.convLoadTextEl = document.createElement("span");
    this.convLoadTextEl.className = "conv-load-text";
    this.convLoadBarEl = document.createElement("span");
    this.convLoadBarEl.className = "conv-load-bar";
    this.convLoadBarEl.setAttribute("aria-hidden", "true");
    this.convLoadFillEl = document.createElement("i");
    this.convLoadBarEl.appendChild(this.convLoadFillEl);
    this.convLoadRetryEl = document.createElement("button");
    this.convLoadRetryEl.type = "button";
    this.convLoadRetryEl.className = "conv-load-retry hidden";
    this.convLoadRetryEl.textContent = l10n.t("Resume");
    wrap.append(this.convLoadIconEl, this.convLoadTextEl, this.convLoadBarEl, this.convLoadRetryEl);
    this.convLoadEl = wrap;
    return wrap;
  }

  // remaining に単位語を付けない。取得元によって数える単位が変わる。
  setConvLoadProgress(state: LoadProgressState | { phase: "done" }): void {
    // R-CNV-02: 完了状態を表示しない。
    this.convLoadState = state.phase === "done" ? null : state;
    this.renderLoadSlot();
    // 検索の件数注記は読み込み状態に連動する。ここで描き直さないと終端後も「読み込み中」が残る（R-DSP-03）
    if (this.tabId === activeTabId) refreshFindCount();
  }

  convHistoryLoadState(): "loading" | "failed" | null {
    const state = this.convLoadState;
    if (state === null) return null;
    return state.phase === "failed" ? "failed" : "loading";
  }

  setWorkLoadProgress(state: LoadProgressState | { phase: "done" }): void {
    // R-TAB-08: 完了状態を表示しない。
    this.workLoadState = state.phase === "done" ? null : state;
    this.renderLoadSlot();
  }

  // R-CNV-02 / R-TAB-08: 見ている面の進行だけを描き、裏で続くもう一方の面の進行は描かない。
  private renderLoadSlot(): void {
    const state = this.viewMode === "conv" ? this.convLoadState : this.workLoadState;
    if (state === null) {
      this.convLoadTextEl.textContent = "";
      this.convLoadEl.removeAttribute("title");
      this.convLoadEl.removeAttribute("data-load-face");
      this.convLoadRetryEl.onclick = null;
      this.convLoadEl.classList.add("hidden");
      return;
    }
    this.convLoadEl.dataset.loadFace = this.viewMode;
    if (state.phase === "preparing") {
      this.convLoadIconEl.replaceChildren(createLoader(12));
      this.convLoadTextEl.textContent = l10n.t("Preparing history");
      this.convLoadEl.removeAttribute("title");
      this.convLoadRetryEl.onclick = null;
    } else if (state.phase === "loading") {
      this.convLoadIconEl.replaceChildren(createLoader(12));
      this.convLoadTextEl.textContent = l10n.t("Loading history · {0} remaining", state.remaining);
      this.convLoadFillEl.style.width = `${Math.round(state.ratio * 100)}%`;
      this.convLoadEl.removeAttribute("title");
      this.convLoadRetryEl.onclick = null;
    } else {
      this.convLoadIconEl.textContent = "✕";
      // 一過性の失敗が続いて止まったことは本文に出す。title だけだと「行き止まり」に読まれる
      this.convLoadTextEl.textContent =
        state.detail === undefined ? l10n.t("History loading stopped") : l10n.t("History loading stopped ({0})", state.detail);
      this.convLoadEl.title = state.reason;
      const retry = state.onRetry;
      this.convLoadRetryEl.onclick = () => retry();
    }
    this.convLoadEl.classList.toggle("failed", state.phase === "failed");
    this.convLoadBarEl.classList.toggle("hidden", state.phase !== "loading");
    this.convLoadRetryEl.classList.toggle("hidden", state.phase !== "failed");
    this.convLoadEl.classList.remove("hidden");
  }

  // 復元中は persist を false にする。復元の途中で persistState を呼ぶと、未登録タブの状態が欠落し、下書きを空で上書きする。
  setViewMode(mode: ViewMode, moveFocus = false, persist = true): void {
    if (mode !== this.viewMode && activeTabId === this.tabId) noteSurfaceChange();
    if (mode !== this.viewMode) {
      if (activeTabId === this.tabId) {
        this.scrollPos[this.viewMode] = logsEl.scrollTop;
        this.knownAnchor[this.viewMode] = this.atBottom[this.viewMode] ? undefined : this.measureAnchor(this.viewMode);
        this.anchorMeasuredTop = undefined;
      }
      this.viewMode = mode;
    }
    if (mode === "conv") this.clearConvAttention();
    this.headEl.dataset.view = mode;
    this.convEl.parentElement!.hidden = mode !== "conv";
    if (mode !== "conv") this.planPanel.close();
    this.convEl.classList.toggle("active", mode === "conv");
    this.workEl.classList.toggle("active", mode === "work");
    this.syncViewTabs();
    if (activeTabId === this.tabId) {
      this.syncHeadLayout();
      this.placeSurface(mode);
      if (moveFocus) this.syncViewTabs(true);
    }
    // placeSurface より後に呼ぶ。先に見せると溜めた行の補正を当てた位置を placeSurface の復元が上書きする（verify-work-graph#G-100）。
    this.setWorkViewVisible?.(mode === "work");
    refreshComposer();
    this.renderLoadSlot();
    if (mode === "conv") onConvViewShown?.(this.tabId);
    if (persist) this.persistViewState();
  }

  hasToolEvidence(toolUseId: string): boolean {
    return this.toolCards.has(toolUseId) || this.agentCards.has(toolUseId);
  }

  navigateToToolEvidence(toolUseId: string): void {
    const target = this.toolCards.get(toolUseId) ?? this.agentCards.get(toolUseId)?.card;
    if (target === undefined) return;
    this.selectPane("log");
    this.refreshLogRequests();
    this.openLogRequest(target);
    let details = target.closest("details");
    while (details instanceof HTMLDetailsElement) {
      this.openLogRequest(details);
      details.open = true;
      details = details.parentElement?.closest("details") ?? null;
    }
    const stickyHeight = this.headEl.getBoundingClientRect().height + (this.workEl.querySelector(".wl-head")?.getBoundingClientRect().height ?? 0);
    target.style.scrollMarginTop = `${Math.ceil(stickyHeight) + 8}px`;
    target.scrollIntoView({ block: "start" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
    target.querySelector<HTMLElement>("summary")?.focus();
    this.atBottom.work = false;
    this.scrollPos.work = logsEl.scrollTop;
  }

  dismissYou(item: YouItem): void {
    const identity = this.youStore.dismiss(item.id);
    if (identity !== undefined) this.persistAskDismissals([identity]);
  }

  navigateToYou(item: YouItem): void {
    this.planPanel.close(false);
    this.selectPane("chat");
    const target = this.convEl.querySelector<HTMLElement>(`#${CSS.escape(item.anchor.id)}`);
    if (!target) return;
    let details = target.closest("details");
    while (details instanceof HTMLDetailsElement) {
      details.open = true;
      details = details.parentElement?.closest("details") ?? null;
    }
    target.style.scrollMarginTop = `${Math.ceil(this.headEl.getBoundingClientRect().height) + 8}px`;
    target.scrollIntoView({ block: "start" });
    target.classList.add("flash");
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    setTimeout(() => target.classList.remove("flash"), 1200);
    this.atBottom.conv = false;
    this.scrollPos.conv = logsEl.scrollTop;
  }

  hasConversationTurn(turnId: string): boolean {
    return this.convEl.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`) !== null;
  }

  navigateToConversationTurn(turnId: string): void {
    const target = this.convEl.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (target === null) return;
    if (this.viewMode !== "conv") this.setViewMode("conv");
    const stickyHeight = this.headEl.getBoundingClientRect().height;
    target.style.scrollMarginTop = `${Math.ceil(stickyHeight) + 8}px`;
    target.scrollIntoView({ block: "start" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
    this.atBottom.conv = false;
    this.scrollPos.conv = logsEl.scrollTop;
  }

  // src/webview/work-overview.ts#WorkOverview の setMode が面を隠す前に呼び、返した関数を面の付け替え後に呼ぶ。
  // 隠れた面の scrollTop は内容高が縮んで clamp されるので、退避は隠す前に行う。
  switchWorkViewScroll(prev: WorkViewMode, next: WorkViewMode): () => void {
    const visible = activeTabId === this.tabId && this.viewMode === "work";
    // holdsWorkScroll は現在の workView を見る。書き換える前後で離れる側・入る側の hold を取る
    const heldPrev = this.holdsWorkScroll();
    this.workView = next;
    const heldNext = this.holdsWorkScroll();
    if (visible) {
      const gap = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight;
      this.workViewScrollPos[prev] = logsEl.scrollTop;
      this.workViewAtBottom[prev] = gap <= SCROLL_BOTTOM_GAP_PX && !heldPrev;
      if (prev === "log") this.workViewReturnRow = this.topVisibleToolRow();
    } else {
      // 隠れている間の切替（分析結果の到着など）。scrollTop は読めないので、面として退避してある値を引き継ぐ
      this.workViewScrollPos[prev] = this.scrollPos.work;
      this.workViewAtBottom[prev] = this.atBottom.work;
    }
    return () => {
      // hold 中は記録した値に関わらず末尾へ復元しない（記録側と二重に見る）
      const toBottom = this.workViewAtBottom[next] && !heldNext;
      if (!visible) {
        this.atBottom.work = toBottom;
        this.scrollPos.work = this.workViewScrollPos[next];
        return;
      }
      logsEl.scrollTop = toBottom ? logsEl.scrollHeight : this.workViewScrollPos[next];
      this.atBottom.work = toBottom;
      this.scrollPos.work = logsEl.scrollTop;
      const row = this.workViewReturnRow;
      if (next === "log" && row !== null && row.isConnected) {
        row.classList.add("wl-back");
        setTimeout(() => row.classList.remove("wl-back"), 1400);
      }
    };
  }

  // top は topVisibleToolRow と同じ基準にする。状況面が非表示だと矩形が 0 になるので、rect は undefined を返す。
  graphScrollPort(): GraphScrollPort {
    return {
      rect: () => {
        if (activeTabId !== this.tabId || this.viewMode !== "work") return undefined;
        const port = logsEl.getBoundingClientRect();
        if (port.width <= 0 || port.height <= 0) return undefined;
        return { top: this.headEl.getBoundingClientRect().bottom, bottom: port.bottom };
      },
      scrollBy: (deltaPx) => {
        logsEl.scrollTop += deltaPx;
      },
      element: () => logsEl,
      setHold: (hold) => {
        this.graphHold = hold;
        // 窓へ入った時点で張り付きを降ろす。scroll が一度も来ないまま面・サブタブを往復すると、
        // 復元経路（setViewMode / switchWorkViewScroll）が残った true を見て末尾へ飛ぶ
        if (hold && this.workView === "graph") this.atBottom.work = false;
      },
    };
  }

  private topVisibleToolRow(): HTMLElement | null {
    const port = logsEl.getBoundingClientRect();
    const top = Math.max(port.top, this.headEl.getBoundingClientRect().bottom);
    const bottom = Math.min(port.bottom, window.innerHeight);
    const left = Math.max(port.left, 0);
    const right = Math.min(port.right, window.innerWidth);
    if (bottom <= top || right <= left) return null;

    // 戻り先の印に使うのは、履歴全体ではなく現在の可視行だけ。履歴の先頭から
    // getBoundingClientRect() を読むと、末尾では行数ぶんの同期レイアウトが発生する。
    const inset = Math.min(12, (right - left) / 2);
    const xs = [left + inset, left + (right - left) / 2, right - inset];
    for (let y = top + 2; y < bottom; y += 16) {
      for (const x of xs) {
        for (const hit of document.elementsFromPoint(x, y)) {
          const row = hit.closest<HTMLElement>(".tool-row");
          if (row !== null && this.workEl.contains(row)) return row;
        }
      }
    }
    return null;
  }

  // R-CNV-03: 会話面の `.block.user` を document 順に走査し、live・復元・取り寄せた過去を区別しない。
  scrollToPreviousUserBlock(): void {
    // 起点の計算は会話面の描画後の寸法に依存し、非表示パネル（display:none）では矩形が
    // すべて 0 になる。測る前に会話面へ出す。既に会話面なら通さない —
    // setViewMode は同じ mode でも退避済みスクロール位置を当て直すため、
    // 通すと測る前に視点が動く
    if (this.viewMode !== "conv") this.setViewMode("conv");
    const blocks = Array.from(this.convEl.querySelectorAll<HTMLElement>(".block.user"));
    if (blocks.length === 0) return;
    let index: number;
    if (this.convCursorEl !== null && this.convCursorEl.isConnected) {
      index = blocks.indexOf(this.convCursorEl) - 1;
    } else {
      // 起点が無いときは「画面上端より上にある最後の発言」から始める。
      // 上端より上に 1 件も無ければ、遡る先が無いということなので動かない。
      // ここを「最新」で初期化すると、1 回目の ↑ が最新へ飛び降りる（R-CNV-03 に反する）
      const top = logsEl.getBoundingClientRect().top;
      index = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].getBoundingClientRect().top < top) {
          index = i;
          break;
        }
      }
    }
    if (index < 0) return;
    const target = blocks[index];
    this.convCursorEl = target;
    // sticky ヘッダの実高でよける。裏読みの帯が出ている間は高さが変わるので毎回測る
    const stickyHeight = this.headEl.getBoundingClientRect().height;
    target.style.scrollMarginTop = `${Math.ceil(stickyHeight) + 8}px`;
    target.scrollIntoView({ block: "start" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
    this.atBottom.conv = false;
    this.scrollPos.conv = logsEl.scrollTop;
  }

  scrollToLatest(): void {
    this.convCursorEl = null;
    // 明示操作なので遡り中の張り付き抑止を解除する。順序を入れ替えると ↓ が効かない（R-CNV-04）
    this.atBottom[this.viewMode] = true;
    this.scrollToBottom(this.viewMode, true);
  }

  // 画面は自動で切り替えず、切替タブ側で注意を促すに留める。
  private flagConvAttention(): void {
    if (this.viewMode === "conv") return;
    this.viewTabs.chat?.classList.add("needs-attention");
  }

  private clearConvAttention(): void {
    this.viewTabs.chat?.classList.remove("needs-attention");
  }

  // 再生中は viewMode がまだ会話面なので flagConvAttention が何もしない。復元後にここで貼り直す。過去の失敗は応答待ちではないので貼り直さない。
  syncConvAttention(): void {
    if (this.hasPendingApproval()) this.flagConvAttention();
  }

  private hasPendingApproval(): boolean {
    return this.pendingApprovalCount > 0;
  }

  private buildStrip(progress: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "status-strip-wrap hidden";
    this.stripWrapEl = wrap;

    this.stripEl = document.createElement("div");
    this.stripEl.className = "status-strip";
    this.stripEl.setAttribute("role", "status");

    const spinner = document.createElement("span");
    spinner.className = "status-strip-spinner";
    spinner.append(createLoader());
    this.stripTextEl = document.createElement("span");
    this.stripTextEl.className = "status-strip-text";
    this.stripTimeEl = document.createElement("span");
    this.stripTimeEl.className = "status-strip-time";
    this.stripSpinnerEl = spinner;
    this.stripNoteEl = document.createElement("span");
    this.stripNoteEl.className = "status-strip-note";
    this.stripEl.append(this.stripTextEl, this.stripNoteEl, this.stripTimeEl, spinner);

    wrap.append(this.stripEl);
    progress.appendChild(wrap);
  }

  // R-SES-11: src/webview/status-line.ts#deriveStatusLine selects the observed status.
  updateStrip(): void {
    this.syncTabDot();
    const runningTool = [...this.runningMainTools.values()].at(-1);
    const line = deriveStatusLine({
      turnState: this.turnState,
      turnStartedAt: this.stripStartedAt,
      runningTool: runningTool?.name ?? null,
      intentInput: runningTool?.intentInput,
      runningDelegations: runningDelegationIds(this.activity),
      workModel: this.workModel,
      openYouCount: this.openYouCount,
      declared: this.taskItems.find(item => item.status === "in_progress")?.activeForm ?? null,
    });
    this.stripWrapEl.classList.toggle("hidden", line.kind === "none");
    this.stripSpinnerEl.hidden = line.kind === "waiting";
    const label = statusLineText(line);
    this.stripTextEl.textContent = truncateToolIntent(label);
    this.stripTextEl.title = label;
    this.stripNoteEl.textContent = line.kind === "conductor" || line.kind === "delegated" ? line.declared ?? "" : "";
    this.stripSince = line.kind === "conductor" || line.kind === "delegated" ? line.since : null;
    this.updateStripElapsed();
    this.syncHeadLayout();
  }

  // R-SES-02: turnState 単独で判定しない。委任の項を外すと、サブエージェントだけが動いているタブが turn_completed で消灯する（verify-conversation-history#CH-S1mut）。
  private isTabActive(): boolean {
    return (
      this.turnState !== "idle" ||
      liveBackgroundTasks(this.activity).length > 0 ||
      hasRunningDelegation(this.activity) ||
      this.runningChildTools.size > 0
    );
  }

  // snapshot にこのフィールドが無いときは再生の結果をそのまま使う。再生の後に呼ぶ:
  // 再生は同じ状態を古い順に書き換えるので、先に入れると窓内の途中状態が Host の現在値を上書きする（R-SES-02）
  replaceBackgroundActivity(snap: BackgroundActivitySnapshot | undefined): void {
    if (snap === undefined) return;
    this.activity = backgroundActivityFromSnapshot(snap);
    this.updateStrip();
  }

  // タブのドットを現在の内部状態から引き直す。updateStrip() の先頭から必ず通る。
  // 述語の変化はここでしか通知しない（ドットと概要の「実行中」が食い違わない）
  private syncTabDot(): void {
    const active = this.isTabActive();
    this.tabBtn.classList.toggle("running", active);
    if (this.notifiedActive !== active) {
      this.notifiedActive = active;
      onTabActivity?.(this.tabId, active);
    }
  }

  isActive(): boolean {
    return this.isTabActive();
  }

  private updateStripElapsed(): void {
    if (this.stripSince === null) {
      this.stripTimeEl.textContent = "";
      return;
    }
    const sec = Math.max(0, Math.floor((Date.now() - this.stripSince) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    this.stripTimeEl.textContent = `${mm}:${ss}`;
  }

  // タブごとの setInterval を持たない。閉じたタブのタイマーを残さないよう、src/webview/main.ts#initTicker の共通タイマーから呼ぶ。
  tickStrip(now = Date.now()): void {
    if ((this.viewMode === "work" && this.workView === "log") || this.logRunningLabels.size > 0) {
      for (const update of this.logRunningLabels.values()) update(now);
    }
    if (this.stripSince !== null) this.updateStripElapsed();
  }

  private notifiedActive: boolean | undefined;

  setTurnState(state: "idle" | "running" | "interrupting"): void {
    if (this.turnState !== state && this.currentTurnId !== null) {
      this.logDirty.add(this.logTurnAliases.get(this.currentTurnId) ?? this.currentTurnId);
      this.scheduleLogRefresh();
    }
    this.turnState = state;
    this.updateStrip();
    if (activeTabId === this.tabId) refreshChrome();
  }

  private prependTurnLabel(block: HTMLElement, role: "user" | "assistant", model: string | null = null): void {
    const label = document.createElement("div");
    label.className = "turn-label";
    const name = document.createElement("span");
    name.className = "turn-label-name";
    name.textContent = role === "user" ? l10n.t("You") : model ? this.modelDisplayName(model) : "";
    label.appendChild(name);
    block.prepend(label);
  }

  addBlock(cls: string, text: string, markdown = false, target: ViewMode = "conv", model: string | null = null): HTMLElement {
    // 進行中の assistant コンテナを閉じないと、このブロックの後に再開した本文がこのブロックより上のコンテナへ入り、時系列が逆転する。
    // クラス名の前方一致で除外しない（再生した assistant ブロックのクラスも一致する）。記録の途中の扱いは endAssistantTurnBeforeConvBlock が持つ。
    if (target === "conv") this.endAssistantTurnBeforeConvBlock();
    const div = document.createElement("div");
    div.className = `block ${cls}`;
    if (markdown) renderMarkdownInto(div, text, this.tabId);
    else div.textContent = text;
    if (target === "conv") {
      if (div.classList.contains("user")) this.prependTurnLabel(div, "user");
      else if (div.classList.contains("assistant")) this.prependTurnLabel(div, "assistant", model);
    }
    if (target === "work") this.registerLogMember(div);
    (target === "work" ? this.workEl : this.convEl).appendChild(div);
    // 新しい発言が末尾へ増えたら「↑」の起点を最新へ戻す。上へ prepend されたときは
    // 起点が指す要素は変わらないので落とさない
    if (target === "conv" && cls.startsWith("user")) this.convCursorEl = null;
    this.scrollToBottom(target);
    if (target === "conv" && this.tabId === activeTabId) refreshFind();
    return div;
  }

  // 裏の面は張り付いていたときだけ末尾へ更新し、途中まで読んだ位置を奪わない。
  // graphHold 中は、利用者の明示操作（explicit）以外の追記で見ている区間を動かさない。
  private scrollToBottom(target: ViewMode = this.viewMode, explicit = false): void {
    if (!explicit && target === "work" && this.holdsWorkScroll()) return;
    if (activeTabId !== this.tabId) {
      if (this.atBottom[target]) this.scrollPos[target] = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (this.viewMode !== target) {
      if (this.atBottom[target]) this.scrollPos[target] = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (!this.atBottom[target]) return;
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  // scrollToBottom・noteScroll・switchWorkViewScroll はどれもこの述語を見る。どれか一つでも外すと、復元経路が末尾へ飛ぶ材料が残る。
  private holdsWorkScroll(): boolean {
    return this.workView === "graph" && this.graphHold;
  }

  // 面ごとの張り付き状態の読み取り口。main.ts は書き換えない
  isAtBottom(mode: ViewMode): boolean {
    return this.atBottom[mode];
  }

  noteScroll(): void {
    const gap = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight;
    // hold 中は張り付きを記録しない。復元経路（setViewMode / restoreScroll / switchWorkViewScroll）が末尾へ飛ぶ材料になる
    this.atBottom[this.viewMode] = gap <= SCROLL_BOTTOM_GAP_PX && !(this.viewMode === "work" && this.holdsWorkScroll());
    this.scrollPos[this.viewMode] = logsEl.scrollTop;
  }

  restoreScroll(): void {
    this.syncHeadLayout();
    this.placeSurface(this.viewMode);
    this.unappliedCarry = undefined;
    this.scrollRestored = true;
  }

  private placeSurface(mode: ViewMode): void {
    const anchor = this.carryAnchor[mode];
    delete this.carryAnchor[mode];
    const usable = anchor !== undefined && !this.atBottom[mode] &&
      !(mode === "work" && (this.workView !== "log" || this.holdsWorkScroll()));
    if (!usable) {
      logsEl.scrollTop = this.atBottom[mode] ? logsEl.scrollHeight : this.scrollPos[mode];
      return;
    }
    if (this.alignToAnchor(mode, anchor)) return;
    if (mode === "work") {
      this.placeWorkAtBottomForBackfill();
      return;
    }
    // 行が窓に無い＝末尾送りで落ちた先頭側にある。画素位置は別の中身を指し、末尾へ clamp されうるので使わない
    logsEl.scrollTop = 0;
    this.scrollPos.conv = logsEl.scrollTop;
    this.knownAnchor.conv = anchor;
    if (this.carryAwaitsConvBackfill) this.awaitedConvAnchor = anchor;
  }

  // R-TAB-07: src/webview/main.ts#mayRequestBackfill は実行ログの張り付きを見るので、末尾に置かないと裏読みが止まり、状況の数字が読み終わらない。
  private placeWorkAtBottomForBackfill(): void {
    delete this.knownAnchor.work;
    this.stickWorkToBottom();
  }

  private alignToAnchor(mode: ViewMode, anchor: RowAnchor): boolean {
    const row = this.findAnchorRow(mode, anchor);
    if (row === null) return false;
    logsEl.scrollTop += row.getBoundingClientRect().top - logsEl.getBoundingClientRect().top - anchor.offset;
    this.atBottom[mode] = false;
    this.scrollPos[mode] = logsEl.scrollTop;
    this.knownAnchor[mode] = anchor;
    return true;
  }

  private anchorSelector(mode: ViewMode, attr?: RowAnchor["attr"], id?: string): string {
    const eq = (name: string): string => (id === undefined ? `[${name}]` : `[${name}="${CSS.escape(id)}"]`);
    if (mode === "conv") {
      if (attr === "msgUuid") return `.block${eq("data-msg-uuid")}`;
      if (attr === "turnId") return `.block${eq("data-turn-id")}`;
      return `.block${eq("data-msg-uuid")}, .block${eq("data-turn-id")}`;
    }
    if (attr === "toolUseId") return `.tool-row${eq("data-tool-use-id")}`;
    if (attr === "turnId") return `.worklog-turn${eq("data-turn-id")}`;
    return `.tool-row${eq("data-tool-use-id")}, .worklog-turn${eq("data-turn-id")}`;
  }

  private anchorRowInDom(mode: ViewMode, anchor: RowAnchor): HTMLElement | null {
    const root = mode === "conv" ? this.convEl : this.workEl;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(this.anchorSelector(mode, anchor.attr, anchor.id)))
      .filter((row) => anchor.user === undefined || row.classList.contains("user") === anchor.user);
    return rows[anchor.ordinal] ?? null;
  }

  private findAnchorRow(mode: ViewMode, anchor: RowAnchor): HTMLElement | null {
    const root = mode === "conv" ? this.convEl : this.workEl;
    let row = this.anchorRowInDom(mode, anchor);
    // 作り直しで details は既定の開閉へ戻る。畳まれた中の行は矩形を持たないので、見えている祖先へ寄せる
    while (row !== null && row !== root && row.getClientRects().length === 0) row = row.parentElement;
    return row === root ? null : row;
  }

  private measureAnchor(mode: ViewMode): RowAnchor | undefined {
    if (activeTabId !== this.tabId || this.viewMode !== mode) return undefined;
    if (mode === "work" && this.workView !== "log") return undefined;
    const root = mode === "conv" ? this.convEl : this.workEl;
    const port = logsEl.getBoundingClientRect();
    const top = Math.max(port.top, this.headEl.getBoundingClientRect().bottom);
    const bottom = Math.min(port.bottom, window.innerHeight);
    const left = Math.max(port.left, 0);
    const right = Math.min(port.right, window.innerWidth);
    if (bottom <= top || right <= left) return undefined;
    const selector = this.anchorSelector(mode);
    const inset = Math.min(12, (right - left) / 2);
    const xs = [left + inset, left + (right - left) / 2, right - inset];
    for (let y = top + 2; y < bottom; y += 16) {
      for (const x of xs) {
        for (const hit of document.elementsFromPoint(x, y)) {
          const row = hit.closest<HTMLElement>(selector);
          if (row === null || !root.contains(row)) continue;
          const offset = row.getBoundingClientRect().top - port.top;
          const uuid = row.dataset.msgUuid;
          if (mode === "conv" && uuid !== undefined && uuid.length > 0) return { attr: "msgUuid", id: uuid, ordinal: 0, offset };
          const toolUseId = row.dataset.toolUseId;
          if (mode === "work" && toolUseId !== undefined && toolUseId.length > 0) return { attr: "toolUseId", id: toolUseId, ordinal: 0, offset };
          const turnId = row.dataset.turnId;
          if (turnId === undefined || turnId.length === 0) continue;
          // 同じ turnId の中で発言と応答を分けて数える。窓の切れ目で割れたターンは、遡りが発言だけを前へ足す
          const user = mode === "conv" ? row.classList.contains("user") : undefined;
          const same = Array.from(root.querySelectorAll<HTMLElement>(this.anchorSelector(mode, "turnId", turnId)))
            .filter((el) => user === undefined || el.classList.contains("user") === user);
          return { attr: "turnId", id: turnId, ...(user === undefined ? {} : { user }), ordinal: Math.max(0, same.indexOf(row)), offset };
        }
      }
    }
    return undefined;
  }

  captureScrollCarry(measure = true): ScrollCarry {
    if (this.unappliedCarry !== undefined) return this.unappliedCarry;
    const live = activeTabId === this.tabId && this.scrollRestored && (measure || logsEl.scrollTop !== this.anchorMeasuredTop);
    const surface = (mode: ViewMode): ScrollCarrySurface => {
      const awaited = mode === "conv" ? this.awaitedConvAnchor : undefined;
      if (live && mode === this.viewMode) {
        const scrollPos = logsEl.scrollTop;
        this.anchorMeasuredTop = scrollPos;
        if (awaited !== undefined) return { atBottom: false, scrollPos, anchor: awaited };
        const gap = logsEl.scrollHeight - scrollPos - logsEl.clientHeight;
        const atBottom = gap <= SCROLL_BOTTOM_GAP_PX && !(mode === "work" && this.holdsWorkScroll());
        const anchor = atBottom ? undefined : this.measureAnchor(mode);
        this.knownAnchor[mode] = anchor;
        return anchor === undefined ? { atBottom, scrollPos } : { atBottom, scrollPos, anchor };
      }
      const atBottom = awaited === undefined && this.atBottom[mode];
      const anchor = atBottom ? undefined : (awaited ?? this.carryAnchor[mode] ?? this.knownAnchor[mode]);
      return anchor === undefined ? { atBottom, scrollPos: this.scrollPos[mode] } : { atBottom, scrollPos: this.scrollPos[mode], anchor };
    };
    return {
      conv: surface("conv"),
      work: surface("work"),
      workView: this.workView,
      workViewAtBottom: { ...this.workViewAtBottom },
      workViewScrollPos: { ...this.workViewScrollPos },
    };
  }

  // src/webview/main.ts#addTab で状況のサブタブを戻した後に呼ぶ。switchWorkViewScroll が面の値を書き換えるので、先に入れると上書きされる。
  applyScrollCarry(carry: ScrollCarry, convBackfill: boolean): void {
    const held = this.holdsWorkScroll();
    const sameWorkView = carry.workView === this.workView;
    this.workViewScrollPos = { ...carry.workViewScrollPos };
    this.workViewAtBottom = { ...carry.workViewAtBottom };
    this.atBottom = {
      conv: carry.conv.atBottom,
      work: (sameWorkView ? carry.work.atBottom : this.workViewAtBottom[this.workView]) && !held,
    };
    this.scrollPos = {
      conv: carry.conv.scrollPos,
      work: sameWorkView ? carry.work.scrollPos : this.workViewScrollPos[this.workView],
    };
    this.carryAnchor = {};
    if (!this.atBottom.conv && carry.conv.anchor !== undefined) this.carryAnchor.conv = carry.conv.anchor;
    const workAnchor = sameWorkView && !this.atBottom.work ? carry.work.anchor : undefined;
    if (workAnchor !== undefined) {
      // 面を開く前でも裏読みは実行ログの張り付きを見るので、行が無いと分かった時点で末尾へ戻す
      if (this.anchorRowInDom("work", workAnchor) === null) this.placeWorkAtBottomForBackfill();
      else this.carryAnchor.work = workAnchor;
    }
    this.carryAwaitsConvBackfill = convBackfill;
    this.unappliedCarry = carry;
  }

  noteScrollAnchor(): void {
    if (this.unappliedCarry === undefined && activeTabId === this.tabId && this.scrollRestored) this.captureScrollCarry();
  }

  // タブを離れた後は矩形が測れないので、ここで行を控える。
  noteLeavingScroll(): void {
    this.awaitedConvAnchor = undefined;
    this.knownAnchor[this.viewMode] = this.atBottom[this.viewMode] ? undefined : this.measureAnchor(this.viewMode);
    this.anchorMeasuredTop = undefined;
    this.scrollRestored = false;
  }

  realignScrollAnchor(): void {
    const anchor = this.awaitedConvAnchor;
    if (anchor === undefined || activeTabId !== this.tabId || this.viewMode !== "conv") return;
    if (this.alignToAnchor("conv", anchor)) this.awaitedConvAnchor = undefined;
  }

  stopAwaitingScrollAnchor(): void {
    this.awaitedConvAnchor = undefined;
  }

  // 旧 DOM への参照は、位置を持ち越す作り直しでも消す。
  resetReplayArtifacts(): void {
    this.convCursorEl = null;
  }

  // 持ち越す位置が無いときだけ呼ぶ。
  resetScrollPosition(): void {
    this.workViewScrollPos = { summary: 0, graph: 0, analysis: 0, log: 0 };
    this.workViewAtBottom = { ...WORK_VIEW_AT_BOTTOM_INITIAL };
    this.atBottom = { conv: true, work: this.workViewAtBottom[this.workView] };
    this.scrollPos = { conv: 0, work: 0 };
    if (activeTabId === this.tabId) logsEl.scrollTop = this.atBottom[this.viewMode] ? logsEl.scrollHeight : 0;
  }

  // R-TAB-07: src/webview/main.ts#mayRequestBackfill が読む。他のサブタブを見ている間も、実行ログ側に退避した張り付きで答える。
  isWorklogAtBottom(): boolean {
    return this.workView === "log" ? this.atBottom.work : this.workViewAtBottom.log;
  }

  // R-TAB-08: 上へ遡って止めた状態からでも裏読みの再開を進める入口。他のサブタブを見ている間はその位置を動かさない。
  stickWorkToBottom(): void {
    this.workViewAtBottom.log = true;
    if (this.workView !== "log") return;
    this.atBottom.work = true;
    if (activeTabId === this.tabId && this.viewMode === "work") {
      logsEl.scrollTop = logsEl.scrollHeight;
      this.scrollPos.work = logsEl.scrollTop;
    } else {
      this.scrollPos.work = Number.MAX_SAFE_INTEGER;
    }
  }

  // 実行中のターンを復元した場合は閉じない。閉じると続きのデルタが別の回答に分かれる。
  finalizeReplay(stillRunning: boolean): void {
    if (!stillRunning) this.endAssistantTurn();
  }

  // stale への移行は reducer が決め、指名された toolUseId の表示だけを変える。DOM を走査して実行中に見えるものを探さない（完了済みまで巻き込む）。
  private applyStaled(toolUseIds: readonly string[]): void {
    for (const toolUseId of toolUseIds) {
      this.logRunningLabels.delete(toolUseId);
      const data = this.rowData.get(toolUseId);
      // 行がまだ無いのは開始が窓の外にあるとき。裏読みが行を作った時点で当て直さないと、中断済みのツールが実行中として育つ（R-TAB-09、verify-history-prepend#HPmut-14）。
      if (data === undefined) {
        if (this.orphanStaled.size < ORPHAN_FINISH_MAX) this.orphanStaled.add(toolUseId);
        continue;
      }
      if (data.status === "running") {
        data.status = "stale";
        data.statusGlyph = TOOL_STATUS_GLYPH.stale;
        data.metaText = l10n.t("Tracking stopped (completion could not be confirmed)");
      }
      const row = this.toolCards.get(toolUseId);
      if (row) {
        row.classList.remove("running");
        const status = row.querySelector<HTMLElement>(".tool-status");
        if (status) {
          status.className = "tool-status stale";
          status.textContent = TOOL_STATUS_GLYPH.stale;
        }
        const rowSummary = row.querySelector("summary");
        if (rowSummary) {
          // refreshLogRow の実行中の経過は描いた時点の時計を読む。止まった行に残すと、描き直した時刻で値が変わる（verify-detail-cards#C-7）。
          if (data.elapsedLabel === undefined) rowSummary.querySelector(".tool-elapsed")?.remove();
          let metaEl = rowSummary.querySelector<HTMLElement>(".tool-meta");
          if (!metaEl) {
            metaEl = document.createElement("span");
            metaEl.className = "tool-meta";
            const elapsed = rowSummary.querySelector(".tool-elapsed");
            if (elapsed) rowSummary.insertBefore(metaEl, elapsed);
            else rowSummary.appendChild(metaEl);
          }
          metaEl.textContent = l10n.t("Tracking stopped (completion could not be confirmed)");
        }
      }
      const agent = this.agentCards.get(toolUseId);
      if (agent) {
        agent.statusEl.className = "tool-status stale";
        agent.statusEl.textContent = "";
      }
    }
  }

  // 失敗数は src/webview/work-overview.ts#WorkOverview と同じ規則で数える。
  private fillSegmentSummary(summaryEl: HTMLElement, totals: WorkSegmentView, lastLabel: string): void {
    const failed = totals.failCount + totals.childFailCount;
    summaryEl.textContent = "";
    const status = document.createElement("span");
    status.className =
      "tool-status" +
      (totals.runningCount > 0
        ? " running"
        : totals.staleCount > 0
          ? " stale"
          : failed > 0
            ? " failed"
            : " done");
    if (totals.runningCount > 0) status.append(createLoader(12));
    const label = document.createElement("span");
    label.className = "toolgroup-label";
    label.textContent = l10n.t("⚙ Work");
    const badge = document.createElement("span");
    badge.className = "toolgroup-badge";
    badge.textContent = String(totals.toolCount);
    summaryEl.append(status, label, badge);
    if (failed > 0 || totals.elapsedMs > 0) {
      const stats = document.createElement("span");
      stats.className = "toolgroup-stats";
      if (failed > 0) stats.classList.add("has-fail");
      let text = "";
      if (failed > 0) text += `✗${failed}`;
      if (totals.elapsedMs > 0) text += (text ? " · " : "") + formatDuration(totals.elapsedMs);
      stats.textContent = text;
      summaryEl.append(stats);
    }
    if (lastLabel) {
      const last = document.createElement("span");
      last.className = "toolgroup-last";
      last.textContent = lastLabel;
      summaryEl.append(last);
    }
  }

  private renderSegmentCard(card: SegmentCard): void {
    const totals = this.segmentTotals.get(card.segmentId) ?? this.pastSegmentTotals.get(card.segmentId);
    if (!totals) return;
    card.el.dataset.workRevision = String(totals.revision);
    card.el.dataset.phaseId = totals.phaseId;
    this.fillSegmentSummary(card.summaryEl, totals, card.lastLabel);
  }

  // placement だけで置き先を決め、現在のカードを見ない。見るとカード切替後の遅延完了が次のカードへ入る（verify-detail-cards#C-1）。
  private placeWork(el: HTMLElement, placement: WorkPlacementView, lastLabel: string): void {
    const toolUseId = el.dataset.toolUseId ?? "";
    if (placement.ownerToolUseId !== undefined) {
      const owner = this.agentCards.get(placement.ownerToolUseId);
      const ownerData = this.rowData.get(placement.ownerToolUseId);
      // 親カードが無いのは、その開始イベントが再生範囲の外にある場合。行を捨てずに通常の配置先へ出す。
      if (owner && ownerData) {
        this.insertWork(owner.childrenEl, el);
        (ownerData.childIds ?? (ownerData.childIds = [])).push(toolUseId);
        return;
      }
    }
    if (placement.taskKey !== undefined) {
      if (this.todoCardEl) {
        this.registerLogMember(this.todoCardEl, el.dataset.logRequestId);
      }
      const container = this.ensureTodoWorkContainer(placement.taskKey);
      // 過去 chunk の taskKey は現在の WorkModel から消えていることがあり、その容器は接続されないまま行が画面から消える。
      // 過去再生では履歴ブロック直下へ落とす（verify-history-prepend#HPmut-5）。
      if (this.pastRender === null || container.isConnected) {
        this.insertWork(container, el);
        return;
      }
      this.insertWork(this.pastRender.frag, el);
      return;
    }
    const card = this.ensureSegmentCard(placement);
    if (!card) {
      // 過去再生で segmentId 無しの行を捨てると突合が合わない。
      if (this.pastRender !== null) this.insertWork(this.pastRender.frag, el);
      return;
    }
    this.insertWork(card.el, el);
    card.lastLabel = lastLabel;
    this.renderSegmentCard(card);
  }

  // frag は空から chunk 順に積むので常に append する。anchor を使うと、ensureSegmentCard が先に append したカードへ anchor が固定され、
  // 以後の平文行がカードの上へ潜り込む。
  private insertWork(container: Node, el: Node): void {
    if (el instanceof HTMLElement && !el.dataset.logRequestId) this.registerLogMember(el);
    const ctx = this.pastRender;
    if (ctx === null || ctx.createdNow.has(container) || container === ctx.frag) {
      container.appendChild(el);
      return;
    }
    let anchor = ctx.anchors.get(container);
    if (anchor === undefined) {
      anchor = container.firstChild;
      ctx.anchors.set(container, anchor);
    }
    container.insertBefore(el, anchor);
  }

  private createAgentCard(ev: Extract<NormalizedEvent, { kind: "tool_call_started" }>): HTMLDetailsElement {
    const data: WorkRowData = {
      toolUseId: ev.toolUseId,
      kind: "agent",
      toolName: ev.toolName,
      summaryText: toolSummary(ev),
      inputPreview: ev.inputPreview,
      status: "running",
      startedAt: ev.timestamp,
      childIds: [],
    };
    if (ev.subagentType) setRowChip(data, "type", ev.subagentType);
    if (ev.subagentModel) setRowChip(data, "model", shortModelLabel(ev.subagentModel));
    if (ev.subagentEffort) setRowChip(data, "effort", `effort: ${ev.subagentEffort}`);
    this.rowData.set(ev.toolUseId, data);
    const entry = this.buildAgentCardDom(data);
    this.agentCards.set(ev.toolUseId, entry);
    this.registerLogRow(entry.card, ev);
    return entry.card;
  }

  private buildAgentCardDom(data: WorkRowData): AgentCardEntry {
    const card = document.createElement("details");
    card.className = "agent-card";
    card.dataset.toolUseId = data.toolUseId;
    const summary = document.createElement("summary");
    const status = document.createElement("span");
    status.className = "tool-status running";
    status.append(createLoader(12));
    const nameEl = document.createElement("span");
    nameEl.className = "agent-name";
    nameEl.textContent = data.summaryText;
    const chipsEl = document.createElement("span");
    chipsEl.className = "agent-chips";
    const meta = document.createElement("span");
    meta.className = "agent-meta";
    const at = document.createElement("span");
    at.className = "tool-at";
    at.textContent = data.startedAt > 0 ? clockLabel(data.startedAt) : "";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = l10n.t("AGENT");
    nameEl.appendChild(chipsEl);
    summary.append(at, status, name, nameEl, meta);
    card.appendChild(summary);
    const childrenEl = document.createElement("div");
    childrenEl.className = "agent-children";
    card.appendChild(childrenEl);
    const entry: AgentCardEntry = { card, statusEl: status, metaEl: meta, chipsEl, childrenEl };
    fillChips(chipsEl, data);
    for (const childId of data.childIds ?? []) {
      const child = this.buildRowDom(childId);
      if (child) childrenEl.appendChild(child);
    }
    if (data.resultPreview !== undefined) {
      const result = document.createElement("div");
      result.className = "agent-result";
      result.textContent = data.resultPreview;
      card.appendChild(result);
    }
    this.paintAgent(entry, data);
    return entry;
  }

  private paintAgent(entry: AgentCardEntry, data: WorkRowData): void {
    const state = this.agentStates.get(data.toolUseId) ?? this.pastAgentStates.get(data.toolUseId);
    if (!state) return;
    entry.card.dataset.workRevision = String(state.revision);
    entry.statusEl.className = `tool-status ${
      state.status === "completed" ? "done" : state.status === "unknown" ? "stale" : state.status
    }`;
    entry.statusEl.replaceChildren(...(state.status === "running" ? [createLoader(12)] : []));
    entry.card.classList.toggle("running", state.status === "running");
    entry.card.classList.toggle("failed", state.status === "failed");
    if (state.status !== "running") entry.statusEl.textContent = state.status === "failed" ? "✗" : state.status === "completed" ? "✓" : TOOL_STATUS_GLYPH.stale;
    const elapsed = agentElapsed(state, Date.now());
    entry.metaEl.textContent = l10n.t("{0} calls · {1}", state.childCount, formatDuration(elapsed));
    entry.metaEl.title = AGENT_STATUS_WORD[state.status];
    if (state.modelMeasured) {
      setRowChip(data, "model", shortModelLabel(state.modelMeasured));
      fillChips(entry.chipsEl, data);
    }
  }

  private renderAgentMeta(toolUseId: string): void {
    const entry = this.agentCards.get(toolUseId);
    const data = this.rowData.get(toolUseId);
    if (entry && data) this.paintAgent(entry, data);
    this.refreshLogRow(toolUseId);
  }

  private buildToolRow(ev: Extract<NormalizedEvent, { kind: "tool_call_started" }>, summaryText: string): HTMLDetailsElement {
    const data: WorkRowData = {
      toolUseId: ev.toolUseId,
      kind: "tool",
      toolName: ev.toolName,
      summaryText,
      inputPreview: ev.inputPreview,
      status: "running",
      startedAt: ev.timestamp,
    };
    this.rowData.set(ev.toolUseId, data);
    const row = this.buildToolRowDom(data);
    this.toolCards.set(ev.toolUseId, row);
    this.registerLogRow(row, ev);
    return row;
  }

  private buildToolRowDom(data: WorkRowData): HTMLDetailsElement {
    const row = document.createElement("details");
    row.className = data.status === "stale" ? "tool-row" : `tool-row ${data.status}`;
    row.dataset.toolUseId = data.toolUseId;
    const rowSummary = document.createElement("summary");
    // R-TAB-06
    const at = document.createElement("span");
    at.className = "tool-at";
    at.textContent = data.startedAt > 0 ? clockLabel(data.startedAt) : "";
    const status = document.createElement("span");
    status.className = `tool-status ${data.status}${data.statusGlyph === "🔄" ? " bg-running" : ""}`;
    status.replaceChildren(data.status === "running" ? createLoader(12) : document.createTextNode(data.statusGlyph ?? TOOL_STATUS_GLYPH[data.status]));
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = data.toolName.startsWith("Task") ? l10n.t("TASK") : data.toolName;
    const preview = document.createElement("span");
    preview.className = data.toolName.startsWith("Task") ? "tool-preview tool-preview-ui" : "tool-preview";
    preview.textContent = data.summaryText;
    rowSummary.append(at, status, name, preview);
    if (data.metaText !== undefined) {
      const metaEl = document.createElement("span");
      metaEl.className = "tool-meta";
      metaEl.textContent = data.metaText;
      rowSummary.appendChild(metaEl);
    }
    if (data.elapsedLabel !== undefined) {
      const elapsedEl = document.createElement("span");
      elapsedEl.className = "tool-elapsed";
      elapsedEl.textContent = data.elapsedLabel;
      rowSummary.appendChild(elapsedEl);
    }
    row.appendChild(rowSummary);

    const inputPre = document.createElement("pre");
    inputPre.className = "tool-input";
    inputPre.textContent = data.inputPreview;
    row.appendChild(inputPre);
    if (data.resultPreview !== undefined) {
      const resultPre = document.createElement("pre");
      resultPre.className = data.status === "failed" ? "tool-result tool-result-error" : "tool-result";
      resultPre.textContent = data.resultPreview;
      row.appendChild(resultPre);
    }
    return row;
  }

  // 表示中の DOM を読まずに rowData から組む。読むと構築の順序制約が戻る。
  private buildRowDom(toolUseId: string): HTMLElement | null {
    const data = this.rowData.get(toolUseId);
    if (!data) return null;
    return data.kind === "agent" ? this.buildAgentCardDom(data).card : this.buildToolRowDom(data);
  }

  // カードをログ末尾へ移動しない。再挿入でカード内の選択とフォーカスが壊れ、末尾へ移る TODO カードと順序を奪い合う。
  private ensureSegmentCard(placement: WorkPlacementView): SegmentCard | undefined {
    const segmentId = placement.segmentId;
    if (segmentId === undefined) return undefined;
    const existing = this.segmentCards.get(segmentId);
    // 単一巨大ターンでは live 窓がターンの途中から始まるので、同じ segmentId が過去 chunk と live の双方に出る。
    if (existing) return existing;
    const details = document.createElement("details");
    details.className = "block toolgroup";
    details.open = true;
    details.dataset.segmentId = segmentId;
    details.dataset.phaseId = placement.phaseId;
    const summary = document.createElement("summary");
    summary.hidden = true;
    details.appendChild(summary);
    if (this.pastRender !== null) {
      this.pastRender.createdNow.add(details);
      this.insertWork(this.pastRender.frag, details);
    } else {
      this.workEl.appendChild(details);
    }
    const card: SegmentCard = { segmentId, el: details, summaryEl: summary, lastLabel: "" };
    this.segmentCards.set(segmentId, card);
    return card;
  }

  // segCommittedEl の中は確定後に触れない（選択が壊れない）。segTailEl は最後の確定境界から末尾までをデルタごとに描き直す。
  // 確定境界は findCommitBoundary が決め、境界が現れない長い末尾は毎デルタ丸ごと描き直される（未修正の既知の問題）。
  private segCommittedEl: HTMLElement | null = null;
  private segTailEl: HTMLElement | null = null;
  private committedLen = 0;

  // R-DSP-26: 撤回は wire uuid で来るが、本文は uuid より先に届くので、出した本文を run として持ち assistant_message_uuid で後から名前を付ける。
  // beginTurn が run をリセットする。遅延した撤回のための保持は captureReply と suspendedReplies が担い、onConversationClosed が解放する。
  private assistantRuns: { uuid: string | null; text: string; seg: HTMLElement }[] = [];

  // 直近に組んだ返信フッターのコピー元（R-CNV-15）。closure がこの入れ物を読むので、
  // 完了後に届いた本文・撤回が text の書き換えだけでコピーへ反映される
  private liveReplyText: { turnId: string; text: string } | null = null;

  // いま「最新」の印を持つ返信フッター（R-CNV-15）。印の付け外しはここと
  // refreshLatestReplyFooter だけが行う（他所で data-latest を書くと両者がずれる）
  private latestReplyFooter: HTMLElement | null = null;

  // R-CNV-16: 楽観バブルを取り消すときにフッターも実体で消す。
  private readonly optimisticFoots = new Map<string, HTMLElement>();

  private appendAssistantSegment(): HTMLElement {
    if (!this.currentAssistantTurn || !this.currentAssistantTurn.isConnected) {
      const turn = document.createElement("div");
      turn.className = "block assistant-turn";
      this.prependTurnLabel(turn, "assistant", this.lastObservedModel);
      if (this.currentTurnId !== null) turn.dataset.turnId = this.currentTurnId;
      this.convEl.appendChild(turn);
      this.currentAssistantTurn = turn;
      this.replyFooterAnchor = turn;
    }
    const seg = document.createElement("div");
    seg.className = "assistant-seg streaming";
    const key = this.pendingDeltaTurnId ?? this.currentTurnId ?? "";
    const part = this.askReplyParts.get(key) ?? 0;
    seg.dataset.askSource = part === 0 ? key : `${key}:part:${part}`;
    this.askReplyParts.set(key, part + 1);
    const parts = buildSegParts(seg);
    this.segCommittedEl = parts.committed;
    this.segTailEl = parts.tail;
    this.committedLen = 0;
    this.currentAssistantTurn.appendChild(seg);
    return seg;
  }

  private noteAssistantRun(text: string): void {
    if (!text || !this.currentAssistantBlock) return;
    const last = this.assistantRuns.at(-1);
    if (last !== undefined && last.uuid === null && last.seg === this.currentAssistantBlock) {
      last.text += text;
    } else {
      this.assistantRuns.push({ uuid: null, text, seg: this.currentAssistantBlock });
    }
    this.refreshLiveReplyText();
  }

  private assistantRunsText(): string {
    return joinRecordTexts(this.assistantRuns.map((run) => run.text));
  }

  private refreshLiveReplyText(): void {
    const holder = this.liveReplyText;
    if (holder === null || holder.turnId !== this.currentTurnId) return;
    holder.text = this.assistantRunsText();
  }

  private onAssistantMessageUuid(ev: Extract<NormalizedEvent, { kind: "assistant_message_uuid" }>): void {
    // R-DSP-26: history の本文は run を作らない（onAssistantTextDelta）。history のラベルを通すと、
    // 未ラベルの live run が記録側の uuid で名付けられ、live の撤回がそれを見つけられなくなる
    if (ev.provenance?.path === "history") return;
    if (this.withSuspendedReply(ev.turnId, () => this.onAssistantMessageUuid(ev))) return;
    // R-CNV-42: retain a replay-leading boundary before any text adopts the turn.
    if (!this.replayDone && this.currentTurnId === null && this.assistantRuns.length === 0) {
      this.assistantLeadingRecord = { turnId: ev.turnId, uuid: ev.uuid };
      return;
    }
    // R-CNV-42: onAssistantMessageUuid must not label another turn's assistantRuns.
    if (ev.turnId !== this.currentTurnId) return;
    this.flushDelta();
    // The replay window may start at the UUID, with its text in the preceding page.
    if (this.assistantRuns.length === 0) this.assistantLeadingRecord = { turnId: ev.turnId, uuid: ev.uuid };
    for (let i = this.assistantRuns.length - 1; i >= 0; i--) {
      if (this.assistantRuns[i].uuid !== null) break;
      this.assistantRuns[i].uuid = ev.uuid;
    }
    // Before turn_started clears the runs, so asks keep their record identity (R-CNV-39).
    this.persistAskDismissals(this.youStore.relabel());
    this.closeLiveRecord();
    if (this.replyFinished) this.endAssistantTurn();
  }

  // 撤回は冪等（未知・撤回済みの uuid は no-op）。turnId では絞らない——通知は
  // currentTurnId が無い状態でも届き、対象は uuid だけで決まる
  private onAssistantRetracted(ev: Extract<NormalizedEvent, { kind: "assistant_retracted" }>, suspended = false): void {
    if (!suspended) {
      for (const turnId of this.suspendedReplies.keys()) {
        this.withSuspendedReply(turnId, () => this.onAssistantRetracted(ev, true));
      }
    }
    // 撤回したターンは孤児デルタとして採用し直さない（R-DSP-26 の撤回が無効になる）
    if (ev.turnId !== null) this.knownTurnIds.add(ev.turnId);
    this.flushDelta();
    const dropped = new Set(ev.uuids);
    const touched: HTMLElement[] = [];
    const kept: typeof this.assistantRuns = [];
    for (const run of this.assistantRuns) {
      if (run.uuid !== null && dropped.has(run.uuid)) {
        if (!touched.includes(run.seg)) touched.push(run.seg);
        continue;
      }
      kept.push(run);
    }
    if (touched.length === 0) return;
    // R-CNV-42: retracting a labelled record must not close a surviving unlabelled run.
    if (suspended && !kept.some(run => run.uuid === null)) this.liveRecordOpen = false;
    this.assistantRuns = kept;
    this.refreshLiveReplyText();
    for (const seg of touched) this.rebuildAssistantSegment(seg);
    if (this.tabId === activeTabId) refreshFind();
  }

  private rebuildAssistantSegment(seg: HTMLElement): void {
    const text = joinRecordTexts(this.assistantRuns.filter((run) => run.seg === seg).map((run) => run.text));
    const askSource = seg.dataset.askSource ?? seg.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId;
    if (askSource !== undefined) this.youStore.retain(askSource, 0, Infinity, new Set());
    const open = this.currentAssistantBlock === seg;
    if (this.topConvSeg !== null && this.topConvSeg.el === seg) this.topConvSeg = null;
    if (this.convCursorEl === seg) this.convCursorEl = null;
    if (!text.trim()) {
      const turn = seg.parentElement;
      seg.remove();
      if (open) {
        this.currentAssistantBlock = null;
        this.segCommittedEl = null;
        this.segTailEl = null;
        this.committedLen = 0;
        this.assistantBuffer = "";
      }
      if (turn !== null && !turn.querySelector(".assistant-seg")) {
        if (this.currentAssistantTurn === turn) this.currentAssistantTurn = null;
        // ターンが丸ごと消えるなら、完了時に付けた返信フッター（直後の兄弟）も一緒に外す。
        // 残すとコピーが空文字のフッターと日時だけが宙に浮き、「最新」の印もそこに留まる
        const footer = turn.nextElementSibling;
        turn.remove();
        if (footer !== null && footer.classList.contains("reply-footer")) footer.remove();
        this.refreshLatestReplyFooter();
      }
      return;
    }
    const parts = buildSegParts(seg);
    if (open) {
      this.segCommittedEl = parts.committed;
      this.segTailEl = parts.tail;
      this.committedLen = 0;
      this.assistantBuffer = text;
      this.renderReplyMarkdown(parts.tail, text, seg.dataset.askSource ?? seg.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId);
      return;
    }
    parts.tail.remove();
    this.renderReplyMarkdown(parts.committed, text, seg.dataset.askSource ?? seg.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId);
  }

  flushDelta(): void {
    this.rafScheduled = false;
    if (!this.pendingDeltaText) return;
    if (!this.currentAssistantBlock) {
      // ここで作業カードを区切らない。区切りは reducer の segment だけが決める。
      // ツールを挟む本文も同じセグメントへ連結し、Markdown 構造を保つ。
      this.currentAssistantBlock = this.appendAssistantSegment();
      this.currentSegTurnId = this.pendingDeltaTurnId;
      this.assistantBuffer = "";
    }
    const appended = this.pendingDeltaText;
    const last = this.assistantRuns.at(-1);
    if (last !== undefined && last.uuid !== null && last.seg === this.currentAssistantBlock) {
      this.assistantBuffer += recordSeparator(this.assistantBuffer);
    }
    this.assistantBuffer += appended;
    this.pendingDeltaText = "";
    this.noteAssistantRun(appended);
    const boundary = findCommitBoundary(this.assistantBuffer, this.committedLen);
    if (boundary > this.committedLen && this.segCommittedEl) {
      const chunk = this.assistantBuffer.slice(this.committedLen, boundary);
      if (chunk.trim()) {
        const block = document.createElement("div");
        this.renderReplyMarkdown(block, chunk, undefined, this.committedLen);
        this.segCommittedEl.appendChild(block);
      }
      this.committedLen = boundary;
    }
    if (this.segTailEl) {
      this.renderReplyMarkdown(this.segTailEl, this.assistantBuffer.slice(this.committedLen), undefined, this.committedLen);
    }
    this.scrollToBottom("conv");
  }

  // inputPreview を解釈せず、WorkModel が運ぶタスクと taskTotals だけを描く。
  private renderTaskCard(items: WorkTaskItemView[]): void {
    this.taskItems = items;
    if (!this.todoCardEl) {
      const details = document.createElement("details");
      details.className = "block todocard";
      details.open = true;
      const summary = document.createElement("summary");
      details.appendChild(summary);
      const list = document.createElement("div");
      list.className = "todocard-list";
      details.appendChild(list);
      this.todoCardEl = details;
      this.todoSummaryEl = summary;
      this.todoListEl = list;
    }
    this.todoCardEl.dataset.workRevision = String(this.workRevision);
    this.fillTaskSummary(this.todoSummaryEl!);
    this.fillTaskList(this.todoListEl!);
    this.registerLogMember(this.todoCardEl);
    this.workEl.appendChild(this.todoCardEl);
    this.scheduleLogRefresh();
    this.scrollToBottom("work");
    this.updateStrip();
  }

  private fillTaskSummary(summaryEl: HTMLElement): void {
    const items = this.taskItems;
    const done = items.filter((it) => it.status === "completed").length;
    summaryEl.textContent = "";
    const label = document.createElement("span");
    label.className = "todocard-summary-label l-label";
    label.textContent = l10n.t("TASKS {0}/{1}", done, items.length);
    summaryEl.appendChild(label);
  }

  private fillTaskList(listEl: HTMLElement): void {
    listEl.textContent = "";
    for (const item of this.taskItems) {
      const row = document.createElement("details");
      row.className = `todo-item todocard-${item.status}`;
      row.open = this.todoRowOpen.get(item.taskKey) ?? false;
      row.dataset.todoKey = item.taskKey;
      // toggleは非同期発火のため、再描画でデタッチ済みの旧行のイベントが後着し
      // ユーザーの直前の開閉を上書きしうる。接続中の行のみ記録する
      row.addEventListener("toggle", () => {
        if (row.isConnected) this.todoRowOpen.set(item.taskKey, row.open);
      });
      const rowSummary = document.createElement("summary");
      const icon = document.createElement("span");
      icon.className = "todocard-icon";
      icon.setAttribute("aria-label", item.status === "completed" ? l10n.t("Completed") : item.status === "in_progress" ? l10n.t("Running") : l10n.t("Pending"));
      const label = document.createElement("span");
      label.className = "todocard-label";
      label.textContent = taskLabel(item);
      rowSummary.append(icon, label);
      const badge = this.buildTaskBadge(item.taskKey);
      if (badge) rowSummary.appendChild(badge);
      row.appendChild(rowSummary);
      const work = this.todoWork.get(item.taskKey);
      if (work) row.appendChild(work);
      listEl.appendChild(row);
    }
  }

  private buildTaskBadge(taskKey: string): HTMLElement | null {
    const totals = this.taskTotals.get(taskKey);
    if (!totals || totals.toolCount === 0) return null;
    const failed = totals.failCount + totals.childFailCount;
    const badge = document.createElement("span");
    badge.className = "todo-work-badge";
    let text = `⚙${totals.toolCount}`;
    if (failed > 0) text += ` ✗${failed}`;
    if (totals.elapsedMs > 0) text += ` · ${formatDuration(totals.elapsedMs)}`;
    badge.textContent = text;
    badge.classList.toggle("has-fail", failed > 0);
    return badge;
  }

  // 集計だけが変わったときは行を作り直さない（作り直すと配下のツール行が再挿入され、
  // 読んでいる最中のテキスト選択とフォーカスが飛ぶ）。バッジとヘッダだけ差し替える
  private refreshTaskTotals(taskKeys: readonly string[]): void {
    if (!this.todoListEl || !this.todoSummaryEl) return;
    for (const taskKey of taskKeys) {
      const row = this.todoListEl.querySelector<HTMLElement>(`[data-todo-key="${CSS.escape(taskKey)}"]`);
      const summary = row?.querySelector("summary");
      if (!summary) continue;
      summary.querySelector(".todo-work-badge")?.remove();
      const badge = this.buildTaskBadge(taskKey);
      if (badge) summary.appendChild(badge);
    }
    this.fillTaskSummary(this.todoSummaryEl);
    if (this.todoCardEl) this.todoCardEl.dataset.workRevision = String(this.workRevision);
  }

  // todo 行がまだ無ければ容器を未接続のまま返し、次のタスク一覧の再構築で接続される。
  private ensureTodoWorkContainer(key: string): HTMLElement {
    let container = this.todoWork.get(key);
    if (!container) {
      container = document.createElement("div");
      container.className = "todo-work";
      this.todoWork.set(key, container);
      this.pastRender?.createdNow.add(container);
    }
    const row = this.todoListEl?.querySelector<HTMLElement>(`[data-todo-key="${CSS.escape(key)}"]`);
    if (row && container.parentElement !== row) {
      row.appendChild(container);
    }
    return container;
  }

  // 確定はターン境界・会話ブロックの差し込み・closeLiveRecord の記録境界でだけ起こす。ツール開始から呼ぶ経路を足すと、
  // 表・箇条書き・単語がツール呼び出しをまたいで途中で切れる（R-DSP-24、verify-markdown#M-31）。
  // 短いテキストを進行メモと推測して作業ログへ移さない。進行メモか回答かは後続で決まるので、回答本文を誤って隠す。
  private endAssistantBlock(keepRecordOpen = false): void {
    this.flushDelta();
    if (this.currentAssistantBlock) {
      const text = this.assistantBuffer.trim();
      if (!text) {
        this.currentAssistantBlock.remove();
      } else {
        this.currentAssistantBlock.classList.remove("streaming");
        // R-CNV-42: suspended replies can finalize out of order; select by DOM order.
        const first = this.topConvSeg === null || Array.from(this.convEl.querySelectorAll(".assistant-seg"))
          .find(el => el === this.currentAssistantBlock || el === this.topConvSeg?.el) === this.currentAssistantBlock;
        if (first && this.currentSegTurnId !== null) {
          this.topConvSeg = {
            turnId: this.currentSegTurnId,
            el: this.currentAssistantBlock,
            text: this.assistantBuffer,
            records: [
              ...(this.assistantLeadingRecord?.turnId === this.currentSegTurnId
                ? [{ text: "", uuid: this.assistantLeadingRecord.uuid }] : []),
              ...this.assistantRuns.filter((run) => run.seg === this.currentAssistantBlock),
            ],
          };
        }
        // A completed suspended reply is history-joinable, but its final delta may still arrive.
        // Keep the rendered tail and its incremental state until the UUID closes the record.
        if (keepRecordOpen) return;
        if (this.segTailEl && this.segCommittedEl) {
          const rest = this.assistantBuffer.slice(this.committedLen);
          if (rest.trim()) {
            const block = document.createElement("div");
            this.renderReplyMarkdown(block, rest, undefined, this.committedLen);
            this.segCommittedEl.appendChild(block);
          }
          this.segTailEl.remove();
        } else {
          this.renderReplyMarkdown(this.currentAssistantBlock, this.assistantBuffer);
        }
      }
    }
    this.currentAssistantBlock = null;
    this.segCommittedEl = null;
    this.segTailEl = null;
    this.committedLen = 0;
    this.assistantBuffer = "";
  }

  // R-CNV-09: 実行中の送信（steering）の発言・注記・承認は本文の記録の途中で届く。ここでコンテナを
  // 閉じると同じ記録の残りが発言の後ろの別ブロックへ出て、laisora-ask 等のフェンスが割れる。
  // 記録が開いている間はコンテナを開けたままブロックをその後ろへ置き、記録が閉じたときに閉じる
  private endAssistantTurnBeforeConvBlock(): void {
    if (!this.liveRecordOpen) {
      this.endAssistantTurn();
      return;
    }
    // 未描画のデルタが残っているとコンテナがまだ無く、ブロックより後ろに作られる
    this.flushDelta();
    this.convBlockAfterRecordIn = this.currentAssistantTurn;
  }

  private closeLiveRecord(): void {
    this.liveRecordOpen = false;
    const placedIn = this.convBlockAfterRecordIn;
    this.convBlockAfterRecordIn = null;
    if (placedIn !== null && placedIn === this.currentAssistantTurn) this.endAssistantTurn();
  }

  private endAssistantTurn(): void {
    this.liveRecordOpen = false;
    this.convBlockAfterRecordIn = null;
    this.endAssistantBlock();
    if (this.currentAssistantTurn && !this.currentAssistantTurn.querySelector(".assistant-seg")) {
      this.currentAssistantTurn.remove();
    }
    this.currentAssistantTurn = null;
    if (this.tabId === activeTabId) refreshFind();
  }

  // R-TAB-11: reconcileLogRequests uses Host request membership for command runs.
  private appendTurnAnchor(
    turnId: string,
    timestamp: number,
    headline: string | null,
    cliInserted = false
  ): HTMLElement {
    const anchor = this.buildTurnAnchor(turnId, timestamp, headline, false, cliInserted);
    this.workEl.appendChild(anchor);
    // 見出しの引き取り先は live の区切りだけ（過去の区切りは pastPendingAnchor が持つ）。
    // CLI が開いた区切りは引き取り先にならず、先行する引き取り待ちも潰さない——null で上書きすると、
    // まだ発言が届いていない直前のターンが永久に見出しを埋められなくなる
    if (!cliInserted) this.pendingHeadlineAnchor = headline === null ? anchor : null;
    return anchor;
  }

  private buildTurnAnchor(
    turnId: string,
    timestamp: number,
    headline: string | null,
    past: boolean,
    cliInserted = false
  ): HTMLElement {
    const anchor = document.createElement("div");
    anchor.className = past ? "worklog-turn hll-past" : "worklog-turn";
    anchor.dataset.turnId = turnId;
    anchor.dataset.startedAt = String(timestamp > 0 ? timestamp : past ? 0 : Date.now());
    anchor.setAttribute("role", "button");
    anchor.tabIndex = 0;
    const toggle = () => {
      const id = this.logTurnAliases.get(turnId) ?? turnId;
      this.logFoldOverrides.set(id, anchor.getAttribute("aria-expanded") !== "true");
      this.logDirty.add(id);
      this.refreshLogRequests();
    };
    anchor.onclick = toggle;
    anchor.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
    };
    const b = document.createElement("b");
    // CLI が開いたターンは見出しを持たない（本文を発言として出さない）。空の区切りと同じ
    // 「ターン開始」で出すと、利用者が打っていない行がある事実まで消える
    b.dataset.emptyLabel = cliInserted
      ? l10n.t("Started by Claude Code (not your message)")
      : l10n.t("Turn started");
    if (headline !== null) b.textContent = headline;
    const time = document.createElement("span");
    // timestamp が 0 なら provider 時刻は未観測。live は stripStartedAt と同じく壁時計で補い、再生では補えないので未観測と出す。
    // 0 のまま整形するとエポックの現地時刻が出る。
    time.textContent = timestamp > 0 ? clockLabel(timestamp) : past ? l10n.t("Time not observed") : clockLabel(Date.now());
    time.className = "wl-request-meta";
    const number = document.createElement("span");
    number.className = "wl-request-number";
    const duration = document.createElement("span");
    duration.className = "wl-request-duration";
    anchor.append(number, b, duration, time);
    const request = this.logRequests.get(turnId) ?? { members: new Set<HTMLElement>(), turns: new Set([turnId]) };
    this.logRequests.set(turnId, request);
    request.turns.add(turnId);
    request.anchor ??= anchor;
    this.logAnchors.set(turnId, anchor);
    const latest = this.logLatestRequest;
    if (!past || latest === undefined || timestamp > Number(this.logRequests.get(latest)?.anchor?.dataset.startedAt ?? 0)) {
      if (latest !== undefined) this.logDirty.add(latest);
      this.logLatestRequest = turnId;
    }
    this.logDirty.add(turnId);
    return anchor;
  }

  private logRequest(turnId: string): LogRequest {
    const id = this.logTurnAliases.get(turnId) ?? turnId;
    let request = this.logRequests.get(id);
    if (!request) {
      request = { members: new Set(), turns: new Set([turnId]) };
      this.logRequests.set(id, request);
    }
    return request;
  }

  private registerLogMember(node: HTMLElement, turnId = this.logEventTurn ?? this.currentTurnId ?? undefined): void {
    if (turnId === undefined || node.matches(".worklog-turn, .toolgroup")) return;
    const id = this.logTurnAliases.get(turnId) ?? turnId;
    if (node === this.todoCardEl) {
      this.logTaskRequests.add(id);
      this.logDirty.add(id);
      return;
    }
    const previous = node.dataset.logRequestId;
    if (previous !== undefined && previous !== id) {
      this.logRequests.get(previous)?.members.delete(node);
      this.logDirty.add(previous);
    }
    node.dataset.logRequestId = id;
    this.logRequest(id).members.add(node);
    this.logDirty.add(id);
  }

  private registerLogRow(row: HTMLElement, ev: Extract<NormalizedEvent, { kind: "tool_call_started" }>): void {
    this.registerLogMember(row, this.logToolRequests.get(ev.parentToolUseId ?? "") ?? ev.turnId);
    const id = row.dataset.logRequestId!;
    this.logToolRequests.set(ev.toolUseId, id);
    const request = this.logRequest(id);
    const order = [ev.generation, ev.seq, ev.timestamp];
    const last = request.last;
    const newer = !last || order.some((value, index) => value > last.order[index] && order.slice(0, index).every((v, i) => v === last.order[i]));
    if (newer && (ev.parentToolUseId === null || !this.agentCards.has(ev.parentToolUseId))) request.last = { row, order };
    this.refreshLogRow(ev.toolUseId);
  }

  private observeLogEvent(ev: NormalizedEvent): void {
    this.logEventTurn = "turnId" in ev ? ev.turnId ?? undefined : undefined;
    if (ev.kind === "turn_completed" || ev.kind === "turn_interrupted" || ev.kind === "turn_failed") {
      this.logTurnEnds.set(ev.turnId, Math.max(this.logTurnEnds.get(ev.turnId) ?? 0, ev.timestamp));
      this.logDirty.add(this.logTurnAliases.get(ev.turnId) ?? ev.turnId);
    }
  }

  private refreshLogRow(id: string): void {
    const requestId = this.logToolRequests.get(id);
    if (requestId !== undefined) this.logDirty.add(requestId);
    const data = this.rowData.get(id);
    const row = this.toolCards.get(id);
    const agent = this.agentCards.get(id);
    const state = this.agentStates.get(id) ?? this.pastAgentStates.get(id);
    this.logRunningLabels.delete(id);
    if (agent && state?.status === "running") {
      const update = (now: number) => { agent.metaEl.textContent = l10n.t("{0} calls · {1}", state.childCount, formatDuration(agentElapsed(state, now))); };
      this.logRunningLabels.set(id, update);
      update(Date.now());
    } else if (row && data?.status === "running" && data.startedAt > 0) {
      const summary = row.querySelector("summary")!;
      let elapsed = summary.querySelector<HTMLElement>(".tool-elapsed");
      if (!elapsed) { elapsed = document.createElement("span"); elapsed.className = "tool-elapsed"; summary.appendChild(elapsed); }
      const update = (now: number) => { elapsed!.textContent = formatDuration(Math.max(0, now - data.startedAt)); };
      this.logRunningLabels.set(id, update);
      update(Date.now());
    }
    if (row) for (const pre of Array.from(row.querySelectorAll<HTMLElement>(":scope > pre"))) {
      pre.dataset.label = pre.classList.contains("tool-input") ? l10n.t("INPUT") : pre.classList.contains("tool-result-error") ? l10n.t("ERROR") : l10n.t("RESULT");
    }
    if (agent) for (const result of Array.from(agent.card.querySelectorAll<HTMLElement>(":scope > .agent-result"))) result.dataset.label = l10n.t("REPORT");
  }

  private openLogRequest(target: HTMLElement): void {
    const id = target.dataset.logRequestId ?? target.closest<HTMLElement>("[data-log-request-id]")?.dataset.logRequestId;
    if (id === undefined || requestIsOpen(id, this.logLatestRequest, this.logFoldOverrides)) return;
    this.logFoldOverrides.set(id, true);
    this.logDirty.add(id);
    this.refreshLogRequests();
  }

  private scheduleLogRefresh(): void {
    if (this.logRefreshPending || this.logDirty.size === 0) return;
    this.logRefreshPending = true;
    queueMicrotask(() => {
      this.logRefreshPending = false;
      this.refreshLogRequests();
    });
  }

  private restoreLogPreview(request: LogRequest): void {
    if (!request.preview) return;
    const { row, home } = request.preview;
    home.replaceWith(row);
    row.hidden = false;
    row.onclick = null;
    row.classList.remove("wl-request-last");
    request.preview = undefined;
  }

  private reconcileLogRequests(): void {
    for (const meta of new Set(this.logRequestMeta.values())) {
      const id = meta.turnIds[0];
      if (id === undefined) continue;
      const entries = [...this.logRequests].filter(([key, request]) => key === id || meta.turnIds.some(turn => request.turns.has(turn)));
      for (const turn of meta.turnIds) this.logTurnAliases.set(turn, id);
      if (entries.length === 0) continue;
      const request = this.logRequests.get(id) ?? { members: new Set<HTMLElement>(), turns: new Set<string>() };
      const anchors = meta.turnIds.map(turn => this.logAnchors.get(turn)).filter((anchor): anchor is HTMLElement => !!anchor);
      const anchor = anchors[0] ?? request.anchor;
      const changed = entries.some(([key]) => key !== id) || request.anchor !== anchor || anchors.length > 1;
      if (!changed) continue;
      for (const [key, member] of entries) {
        this.restoreLogPreview(member);
        for (const node of member.members) {
          node.dataset.logRequestId = id;
          request.members.add(node);
        }
        for (const turn of member.turns) request.turns.add(turn);
        const last = member.last;
        if (last && (!request.last || last.order.some((value, i) => value > request.last!.order[i] && last.order.slice(0, i).every((v, j) => v === request.last!.order[j])))) request.last = last;
        if (!this.logFoldOverrides.has(id) && this.logFoldOverrides.has(key)) this.logFoldOverrides.set(id, this.logFoldOverrides.get(key)!);
        if (this.logLatestRequest === key) this.logLatestRequest = id;
        if (key !== id) {
          this.logRequests.delete(key);
          this.logFoldOverrides.delete(key);
          this.logDirty.delete(key);
          this.logRunningLabels.delete(`request:${key}`);
        }
      }
      for (const redundant of anchors.slice(1)) {
        if (this.pendingHeadlineAnchor === redundant) this.pendingHeadlineAnchor = anchor ?? null;
        if (this.pastPendingAnchor === redundant) this.pastPendingAnchor = anchor ?? null;
        this.logAnchors.delete(redundant.dataset.turnId!);
        redundant.remove();
      }
      request.anchor = anchor;
      this.logRequests.set(id, request);
      this.logDirty.add(id);
      for (const [tool, owner] of this.logToolRequests) if (this.logTurnAliases.get(owner) === id) this.logToolRequests.set(tool, id);
    }
  }

  private refreshLogRequests(): void {
    this.reconcileLogRequests();
    for (const id of this.logDirty) {
      const request = this.logRequests.get(id);
      const anchor = request?.anchor;
      if (!request || !anchor) continue;
      const open = requestIsOpen(id, this.logLatestRequest, this.logFoldOverrides);
      anchor.setAttribute("aria-expanded", String(open));
      anchor.classList.toggle("wl-request-closed", !open);
      const totals = this.logRequestMeta.get(id);
      setTextIfChanged(anchor.querySelector<HTMLElement>(".wl-request-number")!, totals?.number ?? "");
      let repeated = anchor.querySelector<HTMLElement>(".wl-rep");
      if (!repeated && totals && totals.turnIds.length > 1) {
        repeated = document.createElement("span");
        repeated.className = "wl-rep";
        anchor.appendChild(repeated);
      }
      if (repeated) setTextIfChanged(repeated, totals && totals.turnIds.length > 1 ? l10n.t("Same command {0} times", totals.turnIds.length) : "");
      const startedAt = Number(anchor.dataset.startedAt);
      const current = this.currentTurnId;
      const running = current !== null && request.turns.has(current) && !this.logTurnEnds.has(current) && this.turnState !== "idle";
      let end = running ? undefined : this.logTurnEnds.get(id);
      if (!running) {
        for (const turn of request.turns) {
          const endedAt = this.logTurnEnds.get(turn);
          if (endedAt !== undefined) end = Math.max(end ?? 0, endedAt);
        }
      }
      anchor.classList.toggle("wl-request-running", running);
      const duration = anchor.querySelector<HTMLElement>(".wl-request-duration")!;
      const update = (now: number) => {
        setTextIfChanged(duration, startedAt > 0 && (end !== undefined || running)
          ? running ? l10n.t({ message: "Running {0}", args: [formatDuration(Math.max(0, now - startedAt))], comment: ["LOG request elapsed time"] }) : formatDuration(end! - startedAt) : "");
        if (running || !duration.textContent) {
          duration.removeAttribute("title");
          duration.removeAttribute("aria-label");
          return;
        }
        const note = l10n.t("Until the last reply");
        duration.title = note;
        duration.setAttribute("aria-label", `${duration.textContent} (${note})`);
      };
      this.logRunningLabels.delete(`request:${id}`);
      if (running) this.logRunningLabels.set(`request:${id}`, update);
      update(Date.now());
      const meta = anchor.querySelector<HTMLElement>(".wl-request-meta")!;
      const nextMeta = document.createElement("span");
      nextMeta.textContent = startedAt > 0 ? new Date(startedAt).toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }) : l10n.t("Time not observed");
      // R-TAB-07: logRequestMeta contains only complete Host aggregates.
      if (totals) {
        nextMeta.append(" · " + l10n.t("Tools {0} calls (incl. subagents)", totals.toolCount));
        if (totals.agentCount > 0) nextMeta.append(" · " + l10n.t("Subagents {0}", totals.agentCount));
        if (totals.failCount > 0) {
          const failure = document.createElement("span");
          failure.className = "l-failure";
          failure.textContent = l10n.t("Failures {0}", totals.failCount);
          nextMeta.append(" · ", failure);
        }
      }
      // setTextIfChanged と同じ理由で、同じ内容なら子を差し替えない。
      if (meta.textContent !== nextMeta.textContent) meta.replaceChildren(...Array.from(nextMeta.childNodes));
      const last = request.last?.row;
      if (request.preview && (open || request.preview.row !== last)) {
        this.restoreLogPreview(request);
      }
      for (const node of request.members) {
        node.classList.toggle("wl-request-hidden", !open && node !== last);
        node.classList.toggle("wl-request-last", !open && node === last);
        if (node.matches(".tool-row, .agent-card")) node.onclick = null;
      }
      if (!open && last) {
        if (!request.preview && last.parentNode) {
          const home = document.createComment("LOG preview home");
          last.before(home);
          request.preview = { row: last, home };
        }
        anchor.after(last);
        last.onclick = () => this.openLogRequest(last);
      }
    }
    // R-TAB-11: shared TASKS stays visible for every open owner in logTaskRequests.
    if (this.todoCardEl) this.todoCardEl.classList.toggle("wl-request-hidden", this.logTaskRequests.size > 0 &&
      [...this.logTaskRequests].every(turn => {
        const id = this.logTurnAliases.get(turn) ?? turn;
        return !!this.logRequests.get(id)?.anchor && !requestIsOpen(id, this.logLatestRequest, this.logFoldOverrides);
      }));
    this.logDirty.clear();
    // R-TAB-11: syncWorkVisibility; verify-exec-log#EL-19m; verify-exec-log#EL-20m
    this.syncWorkVisibility?.();
  }

  private static headlineOf(text: string): string {
    return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  }

  private static fillHeadline(anchor: HTMLElement, headline: string): void {
    const b = anchor.querySelector("b");
    if (b !== null && b.textContent === "") b.textContent = headline;
  }

  // turnId の無い発言は見出し待ちの区切りへ入れず、次の turn_started へ持ち越す。入れると発言なしで始まったターンが
  // 後から届く発言を引き取り、以後の見出しがずれる（R-TAB-09）。
  private noteHumanHeadline(text: string, turnId: string | null): void {
    const headline = Tab.headlineOf(text);
    if (headline.length === 0) return;
    const pending = this.pendingHeadlineAnchor;
    const own = pending !== null && pending.isConnected && pending.dataset.turnId === turnId;
    if (own) {
      Tab.fillHeadline(pending, headline);
      this.pendingHeadlineAnchor = null;
      return;
    }
    if (turnId === null) this.lastHumanHeadline = headline;
  }

  private notePastHumanHeadline(text: string, turnId: string | null): boolean {
    const headline = Tab.headlineOf(text);
    if (headline.length === 0) return false;
    const pending = this.pastPendingAnchor;
    if (pending !== null && pending.dataset.turnId === turnId) {
      Tab.fillHeadline(pending, headline);
      this.pastPendingAnchor = null;
      return true;
    }
    this.pastHeadline = { text: headline, turnId, chunk: turnId === null ? this.pastChunkSerial : null };
    return false;
  }

  // chunk 末尾に残った turnId の無い発言は、直前に積んだ chunk の先頭の区切りにだけ渡し、それ以外なら捨てる（R-TAB-09）。
  private takePastChunkTail(): void {
    const stash = this.pastHeadline;
    if (stash === null || stash.turnId !== null || stash.chunk !== this.pastChunkSerial) return;
    this.pastHeadline = null;
    const pending = this.pastPendingAnchor;
    if (pending === null || !this.pastPendingFirst || this.pastPendingChunk !== this.pastChunkSerial - 1) return;
    Tab.fillHeadline(pending, stash.text);
    this.pastPendingAnchor = null;
  }

  // R-CNV-15 / R-CNV-16: 時刻が未観測なら出さない。0 のまま整形するとエポックの現地時刻が出る。
  private static footerTime(at: number | undefined): HTMLElement | null {
    if (at === undefined || at <= 0) return null;
    const time = document.createElement("span");
    time.textContent = monthDayClock(at);
    return time;
  }

  // 返信フッター（R-CNV-15）。source は遅延評価: 過去 chunk の本文は
  // 後続 chunk の統合で前へ伸びるので、生成時の文字列を捕まえると欠けた本文をコピーする
  private buildReplyFooter(at: number | undefined, source: () => string): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "reply-footer";
    // 並びは buildUserFoot と揃える。後から分かる日時は applyFooterTime が先頭へ入れる。
    const { button, status } = createCopyButton("msg-copy-button", l10n.t("Copy reply"), source);
    const time = Tab.footerTime(at);
    if (time !== null) {
      time.className = "reply-footer-time";
      footer.appendChild(time);
    }
    footer.appendChild(button);
    footer.appendChild(status);
    return footer;
  }

  private static applyFooterTime(footer: HTMLElement, at: number | undefined): void {
    if (footer.querySelector(".reply-footer-time") !== null) return;
    const time = Tab.footerTime(at);
    if (time === null) return;
    time.className = "reply-footer-time";
    footer.prepend(time);
  }

  // R-CNV-15: 最新の印は latestReplyFooter から付け替える。古い返信にもフッターを足す finishSuspendedReply は、後で refreshLatestReplyFooter が DOM 順に直す。
  // anchor は返信のコンテナ。記録の後ろへ発言が入ったターンで末尾へ足すと、フッターが返信から離れ、撤回時の後始末（直後の兄弟だけを見る）からも漏れる。
  private appendReplyFooter(at: number | undefined, source: () => string, anchor: HTMLElement | null = null): void {
    const footer = this.buildReplyFooter(at, source);
    if (anchor !== null && anchor.isConnected) anchor.after(footer);
    else this.convEl.appendChild(footer);
    this.latestReplyFooter?.removeAttribute("data-latest");
    footer.dataset.latest = "1";
    this.latestReplyFooter = footer;
  }

  private refreshLatestReplyFooter(): void {
    const footers = this.convEl.querySelectorAll<HTMLElement>(".reply-footer");
    const latest = footers.length > 0 ? footers[footers.length - 1] : null;
    footers.forEach((footer) => {
      if (footer === latest) footer.dataset.latest = "1";
      else footer.removeAttribute("data-latest");
    });
    this.latestReplyFooter = latest;
  }

  // R-CNV-16: フッターは `.block.user` の中へ入れず直後の兄弟に置く。中へ入れると吹き出しの枠が広がる（verify-history-prepend#FTmut-17）。
  // コピー元は DOM でなく渡された原文にする。`.block.user` の textContent は画像スロットの読み込み文言を含む。
  private buildUserFoot(at: number | undefined, text: string): HTMLElement {
    const foot = document.createElement("div");
    foot.className = "msg-foot";
    // 並びは buildReplyFooter と揃える。
    const time = Tab.footerTime(at);
    if (time !== null) {
      time.className = "msg-foot-time";
      foot.appendChild(time);
    }
    if (text.length > 0) {
      const { button, status } = createCopyButton("msg-copy-button", l10n.t("Copy message"), () => text);
      foot.appendChild(button);
      foot.appendChild(status);
    }
    return foot;
  }

  // block は呼び出し時点で親（convEl か prepend 用の fragment）に入っていること。
  // 親が無いと after() は何もせず、フッターが無言で消える
  private appendUserFoot(block: HTMLElement, at: number | undefined, text: string): HTMLElement {
    const foot = this.buildUserFoot(at, text);
    block.after(foot);
    return foot;
  }

  handleEvent(ev: NormalizedEvent): void {
    this.observeLogEvent(ev);
    this.observeYouEvent(ev);
    const fallback = foldModelFallback(this.modelFallback, ev, this.models);
    if (fallback !== this.modelFallback) {
      this.setModelFallback(fallback);
      if (activeTabId === this.tabId) refreshChrome();
    }
    // 描画より前に畳む。完了の記録が applyWork や帯の再描画より後になると、終わったタスクが帯に残る（verify-conversation-history#CH-S1bmut-a）。
    const activityChanged = applyActivityEvent(this.activity, ev);
    switch (ev.kind) {
      case "conversation_opened":
        this.onConversationOpened(ev);
        if (activityChanged) this.updateStrip();
        break;
      case "conversation_closed":
        this.onConversationClosed(ev);
        break;
      case "model_refusal_fallback": {
        this.addBlock("system", this.fallbackLogText(ev), false, "work");
        this.decorateFallbackBlock(this.addBlock("system", this.fallbackText(ev)), ev);
        if (activeTabId === this.tabId) refreshChrome();
        break;
      }
      case "model_fallback_revert":
        this.addBlock("system", this.fallbackRevertText(ev), false, "work");
        this.addBlock("system", this.fallbackRevertText(ev));
        break;
      case "auth_status":
        this.onAuthStatus(ev);
        break;
      case "background_tasks":
        this.updateStrip();
        break;
      case "turn_started":
        this.onTurnStarted(ev);
        break;
      case "turn_completed":
        this.onTurnCompleted(ev);
        break;
      case "turn_interrupted":
        this.onTurnInterrupted(ev);
        break;
      case "turn_failed":
        this.onTurnFailed(ev);
        break;
      case "api_retry":
        this.onApiRetry(ev);
        break;
      case "assistant_text_delta":
        this.onAssistantTextDelta(ev);
        break;
      case "assistant_message_uuid":
        this.onAssistantMessageUuid(ev);
        break;
      case "assistant_retracted":
        this.onAssistantRetracted(ev);
        break;
      case "user_message":
        this.onUserMessage(ev);
        break;
      case "replayed_message":
        this.onReplayedMessage(ev);
        break;
      case "tool_call_started":
        this.onToolCallStarted(ev);
        break;
      case "tool_call_finished":
        this.onToolCallFinished(ev, activityChanged);
        break;
      case "subagent_info":
        this.onSubagentInfo(ev);
        break;
      case "model_observed":
        this.onModelObserved(ev);
        break;
      case "compact_boundary":
        if (isConvRenderableEvent(ev)) this.onCompactBoundary(ev);
        break;
      case "permission_denied":
        this.onPermissionDenied(ev);
        break;
      case "approval_request":
        this.onApprovalRequest(ev);
        break;
      case "approval_resolved":
        this.onApprovalResolved(ev);
        break;
      case "usage_update":
        this.onUsageUpdate(ev);
        break;
      case "context_usage":
        this.onContextUsage(ev);
        break;
      case "auto_resume":
        this.onAutoResume(ev);
        break;
      case "rate_limit":
        this.onRateLimit(ev);
        break;
      case "error":
        this.onError(ev);
        break;
    }
    if (ev.kind === "tool_call_started" || ev.kind === "tool_call_finished" || ev.kind === "subagent_info") {
      const id = ev.kind === "tool_call_finished" ? ev.taskNotification?.toolUseId ?? this.bgTaskIdToToolUseId.get(ev.taskNotification?.agentId ?? "") ?? ev.toolUseId : ev.toolUseId;
      this.refreshLogRow(id);
    }
    this.logEventTurn = undefined;
    if (ev.kind !== "assistant_text_delta") this.scheduleLogRefresh();
  }

  private onConversationOpened(_ev: Extract<NormalizedEvent, { kind: "conversation_opened" }>): void {
    this.contextUsage = null;
    if (activeTabId === this.tabId) refreshChrome();
  }

  private onConversationClosed(ev: Extract<NormalizedEvent, { kind: "conversation_closed" }>): void {
    for (const turnId of this.suspendedReplies.keys()) {
      this.withSuspendedReply(turnId, () => this.endAssistantTurn());
    }
    this.suspendedReplies.clear();
    this.autoResumeBlock?.remove();
    this.autoResumeBlock = null;
    // turn_failed を経ない突然死でも streaming ブロックを終端する
    this.endAssistantTurn();
    this.applyWork(ev.work);
    this.runningChildTools.clear();
    this.runningMainTools.clear();
    this.stripStartedAt = null;
    this.addBlock("system", l10n.t("Conversation ended: {0}", ev.reason));
    this.setTurnState("idle");
    this.updateStrip();
  }

  private onAuthStatus(ev: Extract<NormalizedEvent, { kind: "auth_status" }>): void {
    this.auth = ev.auth;
    if (activeTabId === this.tabId) refreshChrome();
  }

  private captureReply() {
    return {
      currentTurnId: this.currentTurnId,
      currentAssistantTurn: this.currentAssistantTurn,
      currentAssistantBlock: this.currentAssistantBlock,
      currentSegTurnId: this.currentSegTurnId,
      pendingDeltaTurnId: this.pendingDeltaTurnId,
      assistantBuffer: this.assistantBuffer,
      assistantRuns: this.assistantRuns,
      assistantLeadingRecord: this.assistantLeadingRecord,
      segCommittedEl: this.segCommittedEl,
      segTailEl: this.segTailEl,
      committedLen: this.committedLen,
      liveRecordOpen: this.liveRecordOpen,
      replyFinished: this.replyFinished,
      convBlockAfterRecordIn: this.convBlockAfterRecordIn,
      replyFooterAnchor: this.replyFooterAnchor,
      liveReplyText: this.liveReplyText,
    };
  }

  private withSuspendedReply(turnId: string | null, apply: () => void): boolean {
    if (turnId === null || turnId === this.currentTurnId) return false;
    const reply = this.suspendedReplies.get(turnId);
    if (reply === undefined) return false;
    this.flushDelta();
    const current = this.captureReply();
    Object.assign(this, reply);
    try {
      apply();
      this.flushDelta();
      this.suspendedReplies.set(turnId, this.captureReply());
    } finally {
      Object.assign(this, current);
    }
    return true;
  }

  private finishSuspendedReply(ev: Extract<NormalizedEvent, { kind: "turn_completed" | "turn_interrupted" | "turn_failed" }>): boolean {
    const finished = this.withSuspendedReply(ev.turnId, () => {
      if (this.replyFinished) return;
      this.replyFinished = true;
      // Completion can precede the final delta/UUID. Keep that record's segment writable.
      if (this.liveRecordOpen && ev.kind === "turn_completed") this.endAssistantBlock(true);
      else this.endAssistantTurn();
      if (ev.kind === "turn_completed") {
        this.appendLiveReplyFooter(ev);
        this.refreshLatestReplyFooter();
      }
    });
    if (finished) {
      // Retain runs for late UUIDs and retractions until onConversationClosed clears them.
      this.applyWork(ev.work);
    }
    return finished;
  }

  // turn_started と adoptOrphanTurn の両方がここを通る。assistantRuns のクリアはここだけに置く。他所へ移すと、
  // 採用したターンが続いたとき次のフッターが前ターンの本文をコピーする（verify-detail-cards#OA-3）。
  private beginTurn(
    turnId: string,
    timestamp: number,
    cliInserted: boolean,
    work: WorkEventInfo | undefined
  ): void {
    this.pendingSend = false;
    // R-CNV-42: preserve captureReply before switching currentTurnId (verify-record-join#LR-1・verify-record-join#LR-2).
    this.flushDelta();
    if (this.liveRecordOpen && this.currentTurnId !== null) {
      this.suspendedReplies.set(this.currentTurnId, this.captureReply());
      this.currentAssistantTurn = null;
      this.currentAssistantBlock = null;
      this.segCommittedEl = null;
      this.segTailEl = null;
      this.assistantBuffer = "";
      this.committedLen = 0;
      this.liveRecordOpen = false;
      this.convBlockAfterRecordIn = null;
    } else {
      this.endAssistantTurn();
    }
    this.currentTurnId = turnId;
    this.knownTurnIds.add(turnId);
    this.assistantRuns = [];
    this.replyFinished = false;
    this.liveReplyText = null;
    this.replyFooterAnchor = null;
    if (this.assistantLeadingRecord?.turnId !== turnId) this.assistantLeadingRecord = null;
    // CLI が開いたターンは見出しを取らない。持ち越しの消費もしない——消すと、その発言を待っている
    // 次の人間のターンが見出しを失う（復元タブは hydration 済み履歴をこの経路へ流すので実際に起こる）
    const headline = cliInserted ? null : this.lastHumanHeadline;
    if (!cliInserted) this.lastHumanHeadline = null;
    this.appendTurnAnchor(turnId, timestamp, headline, cliInserted);
    this.applyWork(work);
    this.clearRetryBlock();
    // activity はここで消さない。前ターンで起動した背景の委任は今も動いており、消すと次の turn_completed で消灯する（R-SES-02）。
    this.runningChildTools.clear();
    this.runningMainTools.clear();
    // 起点は timestamp を優先する。壁時計にすると再生時に再生時刻起点になる。
    this.stripStartedAt = timestamp > 0 ? timestamp : Date.now();
    this.setTurnState("running");
  }

  private onTurnStarted(ev: Extract<NormalizedEvent, { kind: "turn_started" }>): void {
    // 本文デルタで既に開いたターンを開き直すと、同じターンが別々の回答として描かれる（verify-detail-cards#OA-5）。
    if (this.adoptedTurnIds.has(ev.turnId)) {
      this.applyWork(ev.work);
      return;
    }
    this.beginTurn(ev.turnId, ev.timestamp, ev.cliInserted === true, ev.work);
  }

  private onTurnCompleted(ev: Extract<NormalizedEvent, { kind: "turn_completed" }>): void {
    if (this.finishSuspendedReply(ev)) return;
    this.knownTurnIds.add(ev.turnId);
    this.endAssistantTurn();
    this.applyWork(ev.work);
    this.runningChildTools.clear();
    this.runningMainTools.clear();
    // 委任（activity）はここでは触らない。background 委任はメインのターンが終わった後も
    // 動き続けるので、消すと「サブエージェントだけが動いている間」に消灯する（R-SES-02）
    this.clearRetryBlock();
    this.stripStartedAt = null;
    this.setTurnState("idle");
    this.appendLiveReplyFooter(ev);
    if (ev.usage) {
      this.usage = ev.usage;
      if (activeTabId === this.tabId) refreshChrome();
    }
  }

  private appendLiveReplyFooter(ev: Extract<NormalizedEvent, { kind: "turn_completed" }>): void {
    // 返信フッター（R-CNV-15）。コピー元は文字列ではなく入れ物で持つ: turn_completed の時点で
    // 確定させると、完了後に届く遅延 final（本文 gate は currentTurnId のままなので描画はされる）と
    // 完了後の撤回がコピーに入らない／残る。更新は noteAssistantRun と onAssistantRetracted。
    // 履歴由来のターンの会話は replayed_message が後からまとめて描くので、ここでは積まない
    if (ev.provenance?.path !== "history") {
      const holder = { turnId: ev.turnId, text: this.assistantRunsText() };
      if (holder.text.trim().length > 0) {
        this.liveReplyText = holder;
        this.appendReplyFooter(ev.timestamp > 0 ? ev.timestamp : undefined, () => {
          const top = this.topConvSeg?.turnId === holder.turnId ? this.topConvSeg : undefined;
          const past = this.pastConvTurns.get(holder.turnId);
          return past !== undefined && top !== undefined ? past.text + holder.text.slice(top.text.length) : holder.text;
        }, this.replyFooterAnchor);
        this.scrollToBottom("conv");
      }
    }
  }

  private onTurnInterrupted(ev: Extract<NormalizedEvent, { kind: "turn_interrupted" }>): void {
    if (this.finishSuspendedReply(ev)) return;
    this.knownTurnIds.add(ev.turnId);
    this.endAssistantTurn();
    this.applyWork(ev.work);
    this.runningChildTools.clear();
    this.runningMainTools.clear();
    this.clearRetryBlock();
    this.stripStartedAt = null;
    this.addBlock("system warn", l10n.t("Turn interrupted"));
    this.setTurnState("idle");
  }

  private autoResumeBlock: HTMLElement | null = null;

  private onAutoResume(ev: Extract<NormalizedEvent, { kind: "auto_resume" }>): void {
    this.autoResumeBlock?.remove();
    this.autoResumeBlock = null;
    if (ev.state === "pending") {
      const line = this.addBlock("system auto-resume", l10n.t("Resuming automatically at {0}", monthDayClock(ev.at)));
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = l10n.t({ message: "Cancel", comment: ["Cancel automatic resume"] });
      cancel.addEventListener("click", () => vscode.postMessage({ type: "cancelAutoResume", tabId: this.tabId }));
      line.appendChild(cancel);
      this.autoResumeBlock = line;
    } else if (ev.state === "fired") {
      this.addBlock("system", l10n.t("Resumed automatically because the usage limit reset."));
    } else if (ev.state === "exhausted") {
      this.addBlock("system", l10n.t("Automatic resume stopped after three consecutive usage-limit retries."));
    }
  }

  private onTurnFailed(ev: Extract<NormalizedEvent, { kind: "turn_failed" }>): void {
    if (this.finishSuspendedReply(ev)) return;
    this.knownTurnIds.add(ev.turnId);
    this.flagConvAttention();
    this.endAssistantTurn();
    this.applyWork(ev.work);
    this.runningChildTools.clear();
    this.runningMainTools.clear();
    this.clearRetryBlock();
    this.stripStartedAt = null;
    if (ev.errorKind === "usage_limit") {
      const when =
        typeof ev.resetsAt === "number"
          ? new Date(ev.resetsAt).toLocaleString(uiLocale(), {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : null;
      // detail はSDK原文（"You've hit your Fable limit" 等）。モデル別limitの区別はここに出る
      const head = ev.detail ? l10n.t("Limit reached: {0}", ev.detail) : l10n.t("Usage limit reached");
      this.addBlock("error", when ? l10n.t("{0} (resets at {1})", head, when) : head);
    } else {
      this.addBlock("error", l10n.t("Turn failed: {0}", ev.reason));
    }
    this.setTurnState("idle");
  }

  private onApiRetry(ev: Extract<NormalizedEvent, { kind: "api_retry" }>): void {
    const cause = ev.errorStatus
      ? `HTTP ${ev.errorStatus}`
      : ev.errorType
        ? ev.errorType
        : "";
    const status =
      l10n.t("Retrying API ({0}/{1})", ev.attempt, ev.maxRetries) +
      (cause ? ` — ${cause}` : "") +
      (ev.retryDelayMs ? l10n.t(", retrying in {0} s", Math.round(ev.retryDelayMs / 1000)) : "");
    if (this.retryBlock && this.retryBlock.isConnected) {
      this.retryBlock.textContent = status;
    } else {
      // 内部進行の情報なので会話本文には挟まない（実行中の状況はストリップで分かる）
      this.retryBlock = this.addBlock("system warn", status, false, "work");
    }
  }

  private onAssistantTextDelta(ev: Extract<NormalizedEvent, { kind: "assistant_text_delta" }>): void {
    if (ev.provenance?.path === "history") return;
    // R-CNV-42: withSuspendedReply continues the existing record without adoptOrphanTurn.
    if (this.withSuspendedReply(ev.turnId, () => {
      if (this.liveRecordOpen) this.onAssistantTextDelta(ev);
    })) return;
    if (ev.turnId !== this.currentTurnId && !this.adoptOrphanTurn(ev)) return;
    if (ev.text.length > 0) this.liveRecordOpen = true;
    this.pendingDeltaText += ev.text;
    this.pendingDeltaTurnId = ev.turnId;
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      requestAnimationFrame(() => this.flushDelta());
    }
  }

  // Host の gate が turn_started を落としたターンの本文を捨てない（verify-detail-cards#OAmut-1）。保持した返信への遅延本文は、
  // この判定より前に onAssistantTextDelta が withSuspendedReply へ渡す。本文は webview 側にしか無いので Host へ取り寄せに行かない。
  private adoptOrphanTurn(ev: Extract<NormalizedEvent, { kind: "assistant_text_delta" }>): boolean {
    if (this.knownTurnIds.has(ev.turnId)) return false;
    this.adoptedTurnIds.add(ev.turnId);
    this.beginTurn(ev.turnId, ev.timestamp, false, ev.work);
    // 再生中の採用は再生窓が turn_started を落としただけなので診断しない（verify-detail-cards#OA-8）。
    // Output は利用者の目に触れる恒久ログなので、診断に本文を載せない（verify-detail-cards#OAmut-6）。
    if (this.replayDone) {
      vscode.postMessage({
        type: "webviewDiagnostic",
        kind: "orphan-turn-adopted",
        message: `tab=${this.tabId} turn=${ev.turnId}`,
      });
    }
    return true;
  }

  private onUserMessage(ev: Extract<NormalizedEvent, { kind: "user_message" }>): void {
    // history の発言はここで描かないので、開いた live 記録の後ろへ置いた扱いにしない
    if (ev.provenance?.path !== "history" || !this.liveRecordOpen) this.endAssistantTurnBeforeConvBlock();
    this.applyWork(ev.work);
    this.noteHumanHeadline(ev.text, ev.turnId);
    if (ev.provenance?.path === "history") return;
    const block = this.addBlock("user", ev.text);
    if (ev.turnId !== null) block.dataset.turnId = ev.turnId;
    for (const im of ev.images ?? []) {
      const img = document.createElement("img");
      img.className = "user-image";
      img.src = `data:${im.mediaType};base64,${im.data}`;
      img.alt = l10n.t("Attached image");
      attachLightboxHandlers(img, this.tabId, { inline: im });
      block.appendChild(img);
    }
    if (ev.imageRefs && ev.imageRefs.length > 0) {
      for (const info of ev.imageRefs) {
        block.appendChild(createImageSlot(this.tabId, info.ref));
      }
      scheduleImageLoads(this);
    }
    this.observeSessionTime(ev.sentAt);
    this.appendUserFoot(block, ev.sentAt ?? (ev.timestamp > 0 ? ev.timestamp : undefined), ev.text);
    // フッターは addBlock の末尾追従より後に行を伸ばす。追い直さないと下に隙間が残り、SCROLL_BOTTOM_GAP_PX による張り付き判定も折れる。
    this.scrollToBottom("conv");
  }

  private onReplayedMessage(ev: Extract<NormalizedEvent, { kind: "replayed_message" }>): void {
    if (!this.replayMarkerShown) {
      this.replayMarkerShown = true;
      this.replayMarkerEl = this.addBlock("system", l10n.t("── Restored previous session ──"));
    }
    if (ev.role === "assistant" && ev.model) {
      if (this.lastObservedModel !== null && this.lastObservedModel !== ev.model) {
        const divider = this.addBlock("system", l10n.t("── {0} from here ──", this.modelDisplayName(ev.model)));
        divider.dataset.modelDivider = ev.model;
      }
      this.lastObservedModel = ev.model;
    }
    const block =
      ev.role === "user"
        ? this.addBlock("user replayed", ev.text)
        : this.addBlock("assistant replayed", ev.text, false, "conv", ev.model ?? null);
    if (ev.role === "assistant") {
      if (ev.uuid) this.recordReplyIds.add(ev.uuid);
      this.renderReplyMarkdown(block, ev.text, ev.uuid ?? `replay:${ev.generation}:${ev.seq}`, 0, ev.recordedAt ?? 0, ev.seq, ev.generation);
      this.prependTurnLabel(block, "assistant", ev.model ?? null);
      // addBlock が素の本文で検索した後に本文を描き直すので、ここで検索し直さないと印が外れたまま件数だけ残る（verify-conversation-history#CH-U32b）
      if (this.tabId === activeTabId) refreshFind();
    }
    if (ev.uuid !== undefined && ev.uuid.length > 0) {
      block.dataset.msgUuid = ev.uuid;
      this.convMessageUuids.add(ev.uuid);
    }
    if (ev.role === "user" && ev.imageRefs && ev.imageRefs.length > 0) {
      for (const info of ev.imageRefs) {
        block.appendChild(createImageSlot(this.tabId, info.ref));
      }
      scheduleImageLoads(this);
    }
    // 日時は recordedAt（レコード自身の時刻）だけを使う。envelope の timestamp は
    // fold の継承値で、復元分は全件が同じ値になる
    this.observeSessionTime(ev.recordedAt ?? ev.sentAt);
    if (ev.role === "user") this.appendUserFoot(block, ev.recordedAt ?? ev.sentAt ?? undefined, ev.text);
    else this.appendReplyFooter(ev.recordedAt, () => ev.text);
    this.scrollToBottom("conv");
  }

  private applyWork(work: WorkEventInfo | undefined): void {
    if (!work) return;
    this.workRevision = work.revision;
    if (work.tasks) this.renderTaskCard(work.tasks);
    if (work.taskTotals) {
      for (const totals of work.taskTotals) this.taskTotals.set(totals.taskKey, totals);
      this.refreshTaskTotals(work.taskTotals.map((totals) => totals.taskKey));
    }
    if (work.segments) {
      for (const segment of work.segments) {
        this.segmentTotals.set(segment.segmentId, segment);
        const card = this.segmentCards.get(segment.segmentId);
        if (card) this.renderSegmentCard(card);
      }
    }
    if (work.agents) {
      for (const agent of work.agents) {
        this.agentStates.set(agent.toolUseId, agent);
        this.renderAgentMeta(agent.toolUseId);
      }
    }
    if (work.staled) this.applyStaled(work.staled);
    if (work.pendingApprovalCount !== undefined) {
      this.pendingApprovalCount = work.pendingApprovalCount;
      if (this.pendingApprovalCount === 0) {
        this.tabBtn.classList.remove("needs-approval");
        // 会話タブ側の注意表示も同じ条件で解除する。解除しないと応答不要になっても残る。
        this.clearConvAttention();
      }
    }
    this.updateStrip();
  }

  private applyLogModel(model: WorkModelPayload | undefined): void {
    const previousMeta = new Map(this.logRequestMeta);
    this.logRequestMeta.clear();
    if (model?.coverage.summary === "complete" && !model.coverage.hydrationUnconfirmed) {
      for (const request of model.requests ?? []) for (const turnId of request.turnIds) this.logRequestMeta.set(turnId, request);
    }
    for (const id of this.logRequests.keys()) {
      const before = previousMeta.get(id);
      const after = this.logRequestMeta.get(id);
      if (before?.revision !== after?.revision || before?.number !== after?.number || (!!before !== !!after)) this.logDirty.add(id);
    }
    if (!model) {
      this.scheduleLogRefresh();
      return;
    }
    const visitAgent = (agent: WorkModelPayload["unlinkedAgents"][number]): void => {
      const before = this.agentStates.get(agent.toolUseId);
      if (!before || before.revision < agent.revision || before.runStartedAt !== agent.runStartedAt) {
        this.agentStates.set(agent.toolUseId, agent);
        this.renderAgentMeta(agent.toolUseId);
      }
      for (const child of agent.children) visitAgent(child);
    };
    for (const phase of model.phases) for (const agent of phase.agents) visitAgent(agent);
    for (const agent of model.unlinkedAgents) visitAgent(agent);
    this.scheduleLogRefresh();
  }

  // 再生窓からタスク更新のイベントが落ちていると、ここで取り込まない限り TODO 行が作られず、窓内の配下のツール行まで未接続 DOM へ入って消える。
  // 集計だけの更新では refreshTaskTotals と同じ理由で行を作り直さない。
  applyWorkModel(model: WorkModelPayload | undefined): void {
    this.planPanel.setModel(model);
    this.workModel = model;
    this.applyLogModel(model);
    if (model?.runningMainTools !== undefined) {
      this.runningMainTools = new Map(model.runningMainTools.map(tool => [tool.id, tool]));
    }
    this.updateStrip();
    if (!model) return;
    if (model.revision > this.workRevision) this.workRevision = model.revision;
    for (const totals of model.taskTotals) this.taskTotals.set(totals.taskKey, totals);
    if (sameTaskItems(this.taskItems, model.tasks)) {
      this.refreshTaskTotals(model.taskTotals.map((totals) => totals.taskKey));
      return;
    }
    if (model.tasks.length === 0 && this.todoCardEl === null) return;
    this.renderTaskCard(model.tasks);
  }

  // Host と webview の版が食い違ったときにしか起きない。現在のカードへ落とすと詳細ログが WorkModel と別の帰属規則を持つので、捨てて報告する。
  private dropUnplacedEvent(kind: string): void {
    if (this.missingWorkInfoReported) return;
    this.missingWorkInfoReported = true;
    vscode.postMessage({
      type: "webviewDiagnostic",
      kind: "error",
      message: `work placement missing on ${kind}; detail row dropped (tab=${this.tabId})`,
    });
    // 黙って消さない。行が出ない理由と復旧手段（再読み込み）を作業ログ側にも出す
    this.addBlock(
      "system warn",
      l10n.t(
        "Some status information is not shown because an event without placement information was received. The extension and the view may be out of sync (reloading the window fixes this)."
      ),
      false,
      "work"
    );
  }

  private onToolCallStarted(ev: Extract<NormalizedEvent, { kind: "tool_call_started" }>): void {
    const isHistory = ev.provenance?.path === "history";
    // uuid が届かない記録（wire uuid 欠落）でもツール開始で閉じる。サブエージェントのツールは
    // root の本文と並行して走るので境界にしない
    if (!isHistory && ev.parentToolUseId === null) {
      if (!this.withSuspendedReply(ev.turnId, () => this.closeLiveRecord()) && ev.turnId === this.currentTurnId) this.closeLiveRecord();
    }
    if (isHistory && !this.workReplayMarkerShown) {
      this.workReplayMarkerShown = true;
      this.addBlock("system", l10n.t("── Restored previous session ──"), false, "work");
    }
    // 履歴の開始も記録する。無いと完了が所要時間を書かず、refreshLogRow の実行中の経過が残る（verify-exec-log#EL-23m）。
    this.toolStartTimes.set(ev.toolUseId, ev.timestamp);
    if (!isHistory && ev.parentToolUseId === null) {
      this.runningMainTools.set(ev.toolUseId, { name: ev.toolName, intentInput: ev.intentInput });
      this.updateStrip();
    }
    this.applyWork(ev.work);
    if (!ev.work) {
      this.nonWorkToolUseIds.add(ev.toolUseId);
      this.dropUnplacedEvent(ev.kind);
      return;
    }
    const placement = ev.work.placement;
    // ev.work supplies placement; runningMainTools also observes calls without placement.
    if (!placement) {
      this.nonWorkToolUseIds.add(ev.toolUseId);
      return;
    }

    if (!isHistory) {
      // 入れ子エージェント（子がAgent/Task）も数える。下の agent 分岐がそこで return するため、その前に登録する
      if (placement.ownerToolUseId !== undefined) {
        this.runningChildTools.set(ev.toolUseId, {
          name: ev.inputSummary ?? ev.toolName,
          parentId: placement.ownerToolUseId,
        });
      }
    }

    // サブエージェント起動かどうかは reducer の判定（work の agents に載るか）に従う。
    if (ev.work.agents?.some((agent) => agent.toolUseId === ev.toolUseId)) {
      this.flushDelta();
      const card = this.createAgentCard(ev);
      if (isHistory) card.classList.add("replayed");
      this.placeWork(card, placement, `🤖 ${toolSummary(ev)}`);
      this.renderAgentMeta(ev.toolUseId);
      if (!isHistory) this.updateStrip();
      this.scrollToBottom("work");
      return;
    }

    this.flushDelta();
    const summaryText = toolSummary(ev);
    const row = this.buildToolRow(ev, summaryText);
    if (isHistory) row.classList.add("replayed");
    this.placeWork(row, placement, `${ev.toolName}: ${summaryText}`);
    if (!isHistory) this.updateStrip();
    this.scrollToBottom("work");
  }

  private onToolCallFinished(ev: Extract<NormalizedEvent, { kind: "tool_call_finished" }>, activityChanged: boolean): void {
    this.runningChildTools.delete(ev.toolUseId);
    const mainToolFinished = this.runningMainTools.delete(ev.toolUseId);
    // tool_call_finished は work を伴わないことがあり、その経路では applyWork 経由の
    // 再描画が起きない。委任が閉じた（開いた）ならここで引き直す（R-SES-02）
    if (activityChanged || mainToolFinished) this.updateStrip();
    this.applyWork(ev.work);
    if (this.nonWorkToolUseIds.has(ev.toolUseId)) {
      this.nonWorkToolUseIds.delete(ev.toolUseId);
      this.toolStartTimes.delete(ev.toolUseId);
      return;
    }

    // 行が無い（開始が窓の外）ときは退避し、後から過去 chunk が同じ行を作ったときに当て直す（verify-history-prepend#HPmut-3）。
    if (!this.applyToolFinishDom(ev)) this.rememberOrphanFinish(ev);
  }

  // 反映先の行が無ければ false を返し、呼び出し側が退避する。
  private applyToolFinishDom(ev: Extract<NormalizedEvent, { kind: "tool_call_finished" }>): boolean {
    if (ev.backgroundTaskId !== undefined && !ev.isError) {
      this.bgTaskIdToToolUseId.set(ev.backgroundTaskId, ev.toolUseId);
    }
    if (ev.asyncLaunchedAgentId !== undefined && !ev.isError) {
      this.bgTaskIdToToolUseId.set(ev.asyncLaunchedAgentId, ev.toolUseId);
    }

    const finishedId = ev.taskNotification?.toolUseId ?? this.bgTaskIdToToolUseId.get(ev.taskNotification?.agentId ?? "") ?? ev.toolUseId;
    if (this.rowData.has(finishedId)) {
      const order = [ev.generation, ev.seq, ev.timestamp];
      const previous = this.logFinishOrder.get(finishedId);
      // R-TAB-09: logFinishOrder; verify-exec-log#EL-17
      if (previous && order.some((value, index) => value < previous[index] && order.slice(0, index).every((v, i) => v === previous[i]))) return true;
      this.logFinishOrder.set(finishedId, order);
    }

    if (ev.taskNotification !== undefined) {
      const targetId =
        ev.taskNotification.toolUseId ??
        this.bgTaskIdToToolUseId.get(ev.taskNotification.agentId) ??
        ev.toolUseId;
      const startedAt = this.toolStartTimes.get(targetId);
      this.toolStartTimes.delete(targetId);
      const elapsedMs = startedAt !== undefined ? ev.timestamp - startedAt : 0;

      const notifStatus = ev.taskNotification.status;
      const finalStatus: WorkRowData["status"] =
        notifStatus === "completed" ? "done" : notifStatus === "failed" ? "failed" : "stale";
      const finalGlyph = TOOL_STATUS_GLYPH[finalStatus];

      const data = this.rowData.get(targetId);
      if (data) {
        data.status = finalStatus;
        data.statusGlyph = finalGlyph;
        data.metaText = finalStatus === "stale" ? l10n.t("Tracking stopped (completion could not be confirmed)") : undefined;
        if (ev.resultPreview) data.resultPreview = ev.resultPreview;
        if (data.kind === "tool" && startedAt !== undefined) {
          data.elapsedLabel = formatDuration(elapsedMs);
        }
      }

      const agentEntry = this.agentCards.get(targetId);
      if (agentEntry) {
        if (ev.resultPreview) {
          const result = document.createElement("div");
          result.className = "agent-result";
          result.textContent = ev.resultPreview;
          agentEntry.card.appendChild(result);
        }
        agentEntry.statusEl.className = `tool-status ${finalStatus}`;
        agentEntry.statusEl.textContent = finalGlyph;
        return true;
      }

      const row = this.toolCards.get(targetId);
      if (row) {
        row.classList.remove("running");
        row.classList.remove("failed", "done");
        if (finalStatus !== "stale") row.classList.add(finalStatus);
        const status = row.querySelector<HTMLElement>(".tool-status");
        if (status) {
          status.className = `tool-status ${finalStatus}`;
          status.textContent = finalGlyph;
        }
        const rowSummary = row.querySelector("summary");
        if (rowSummary) {
          let metaEl = rowSummary.querySelector<HTMLElement>(".tool-meta");
          if (finalStatus === "stale") {
            if (!metaEl) {
              metaEl = document.createElement("span");
              metaEl.className = "tool-meta";
              const elapsed = rowSummary.querySelector(".tool-elapsed");
              if (elapsed) rowSummary.insertBefore(metaEl, elapsed);
              else rowSummary.appendChild(metaEl);
            }
            metaEl.textContent = l10n.t("Tracking stopped (completion could not be confirmed)");
          } else if (metaEl) {
            metaEl.remove();
          }
          if (startedAt !== undefined) {
            let elapsedEl = rowSummary.querySelector<HTMLElement>(".tool-elapsed");
            if (!elapsedEl) {
              elapsedEl = document.createElement("span");
              elapsedEl.className = "tool-elapsed";
              rowSummary.appendChild(elapsedEl);
            }
            elapsedEl.textContent = formatDuration(elapsedMs);
          }
        }
        if (ev.resultPreview) {
          let resultPre = row.querySelector<HTMLPreElement>(".tool-result");
          if (!resultPre) {
            resultPre = document.createElement("pre");
            row.appendChild(resultPre);
          }
          resultPre.className = finalStatus === "failed" ? "tool-result tool-result-error" : "tool-result";
          resultPre.textContent = ev.resultPreview;
        }
        return true;
      }
      return false;
    }

    const isAsyncAck =
      (ev.backgroundTaskId !== undefined || ev.asyncLaunchedAgentId !== undefined) && !ev.isError;
    if (isAsyncAck) {
      const data = this.rowData.get(ev.toolUseId);
      // 過去 chunk・退避の当て直しでは完了が起動 ACK より先に当たることがある。終端済みの行を running へ戻さない。
      // ここで false を返すと ACK が退避されるので、退避済みの完了を上書きしない側は rememberOrphanFinish が持つ（verify-history-prepend#HP-C31）。
      if (data && data.status !== "running") return true;
      if (data) {
        data.status = "running";
        data.statusGlyph = "🔄";
        data.metaText = l10n.t("Running in background");
        if (ev.resultPreview) data.resultPreview = ev.resultPreview;
      }
      const row = this.toolCards.get(ev.toolUseId);
      if (row) {
        row.classList.add("running");
        row.classList.remove("failed", "done");
        const status = row.querySelector<HTMLElement>(".tool-status");
        if (status) {
          status.className = "tool-status running bg-running";
          status.replaceChildren(createLoader(12));
        }
        const rowSummary = row.querySelector("summary");
        if (rowSummary) {
          let metaEl = rowSummary.querySelector<HTMLElement>(".tool-meta");
          if (!metaEl) {
            metaEl = document.createElement("span");
            metaEl.className = "tool-meta";
            const elapsed = rowSummary.querySelector(".tool-elapsed");
            if (elapsed) rowSummary.insertBefore(metaEl, elapsed);
            else rowSummary.appendChild(metaEl);
          }
          metaEl.textContent = l10n.t("Running in background");
        }
        if (ev.resultPreview) {
          let resultPre = row.querySelector<HTMLPreElement>(".tool-result");
          if (!resultPre) {
            resultPre = document.createElement("pre");
            row.appendChild(resultPre);
          }
          resultPre.className = "tool-result";
          resultPre.textContent = ev.resultPreview;
        }
        return true;
      }
      const agentEntry = this.agentCards.get(ev.toolUseId);
      if (agentEntry) {
        agentEntry.statusEl.className = "tool-status running bg-running";
        agentEntry.statusEl.replaceChildren(createLoader(12));
        return true;
      }
      return false;
    }

    const startedAt = this.toolStartTimes.get(ev.toolUseId);
    this.toolStartTimes.delete(ev.toolUseId);
    const elapsedMs = startedAt !== undefined ? ev.timestamp - startedAt : 0;

    const data = this.rowData.get(ev.toolUseId);
    if (data) {
      data.status = ev.isError ? "failed" : "done";
      data.statusGlyph = ev.isError ? TOOL_STATUS_GLYPH.failed : TOOL_STATUS_GLYPH.done;
      data.metaText = undefined;
      data.resultPreview = ev.resultPreview;
      if (data.kind === "tool" && startedAt !== undefined) data.elapsedLabel = formatDuration(elapsedMs);
    }

    // 状態と集計は applyWork と notePastWork が WorkModel の値で描くので、ここでは報告だけを足す。
    const agentEntry = this.agentCards.get(ev.toolUseId);
    if (agentEntry) {
      const result = document.createElement("div");
      result.className = "agent-result";
      result.textContent = ev.resultPreview;
      agentEntry.card.appendChild(result);
      return true;
    }

    const row = this.toolCards.get(ev.toolUseId);
    if (row) {
      row.classList.remove("running");
      row.classList.add(ev.isError ? "failed" : "done");
      const status = row.querySelector<HTMLElement>(".tool-status");
      if (status) {
        status.className = `tool-status ${ev.isError ? "failed" : "done"}`;
        status.textContent = ev.isError ? TOOL_STATUS_GLYPH.failed : TOOL_STATUS_GLYPH.done;
      }
      const resultPre = document.createElement("pre");
      resultPre.className = ev.isError ? "tool-result tool-result-error" : "tool-result";
      resultPre.textContent = ev.resultPreview;
      row.appendChild(resultPre);
      const rowSummary = row.querySelector("summary");
      if (rowSummary && startedAt !== undefined) {
        let elapsedEl = rowSummary.querySelector<HTMLElement>(".tool-elapsed");
        if (!elapsedEl) {
          elapsedEl = document.createElement("span");
          elapsedEl.className = "tool-elapsed";
          rowSummary.appendChild(elapsedEl);
        }
        elapsedEl.textContent = formatDuration(elapsedMs);
      }
    }
    // ツール失敗で別のエラーブロックを出さない。行自体が失敗表示になり、結果も行内に出る。
    return row !== undefined;
  }

  private rememberOrphanFinish(ev: Extract<NormalizedEvent, { kind: "tool_call_finished" }>): void {
    if (this.orphanFinishes.size >= ORPHAN_FINISH_MAX) return;
    const key =
      ev.taskNotification?.toolUseId ??
      this.bgTaskIdToToolUseId.get(ev.taskNotification?.agentId ?? "") ??
      ev.toolUseId;
    if (this.orphanFinishes.get(key)?.taskNotification !== undefined && ev.taskNotification === undefined) return;
    this.orphanFinishes.set(key, ev);
  }

  private drainOrphanUpdates(toolUseId: string): void {
    const finish = this.orphanFinishes.get(toolUseId);
    if (finish !== undefined) {
      this.orphanFinishes.delete(toolUseId);
      this.applyToolFinishDom(finish);
    }
    const info = this.orphanSubagentInfo.get(toolUseId);
    if (info !== undefined) {
      this.orphanSubagentInfo.delete(toolUseId);
      this.renderPastSubagentInfo(info);
    }
    // finish より後に当てる。applyStaled は running のときだけ stale にするので、
    // 終端が先に当たっていれば空振りする（終端済みの行を stale へ落とさない）
    if (this.orphanStaled.delete(toolUseId)) this.applyStaled([toolUseId]);
  }

  // subagent_info のモデルは最初の sidechain assistant メッセージの観測値で、inherit や既定の変更を映すので宣言値のチップより優先する。
  private onSubagentInfo(ev: Extract<NormalizedEvent, { kind: "subagent_info" }>): void {
    // 観測モデルは reducer が agent へ持たせ、applyWork がチップを差し替える。agent 記録が上限で退避されて WorkModel に無いときだけ、イベントから直接出す。
    this.applyWork(ev.work);
    if (ev.model === undefined) return;
    if (this.agentStates.get(ev.toolUseId)?.modelMeasured !== undefined) return;
    const entry = this.agentCards.get(ev.toolUseId);
    const data = this.rowData.get(ev.toolUseId);
    if (!entry || !data) {
      // カードがまだ無い（起動が窓の外）。過去 chunk が作った時点で当て直す
      if (this.orphanSubagentInfo.size < ORPHAN_FINISH_MAX) {
        this.orphanSubagentInfo.set(ev.toolUseId, ev);
      }
      return;
    }
    setRowChip(data, "model", shortModelLabel(ev.model));
    fillChips(entry.chipsEl, data);
  }

  modelDisplayName(model: string): string {
    const shortName = shortModelDisplayName(model);
    return shortName !== model ? shortName : this.models.find((m) => m.id === model)?.label ?? model;
  }

  private onModelObserved(ev: Extract<NormalizedEvent, { kind: "model_observed" }>): void {
    if (ev.turnId !== null) {
      const label = this.currentAssistantTurn?.dataset.turnId === ev.turnId
        ? this.currentAssistantTurn.querySelector<HTMLElement>(":scope > .turn-label > .turn-label-name")
        : this.convEl.querySelector<HTMLElement>(`.block.assistant-turn[data-turn-id="${CSS.escape(ev.turnId)}"] > .turn-label > .turn-label-name`);
      if (label) label.textContent = this.modelDisplayName(ev.model);
    }
    if (this.lastObservedModel !== null && this.lastObservedModel !== ev.model) {
      // live では本文の delta が先に描かれ、model を持つ assistant record は後着する。
      // 進行中のコンテナがこのターンのものなら、その前（＝利用者の発言の直後）へ入れる。
      // addBlock はコンテナを閉じる（記録の途中なら記録の終わりで閉じる）のでここでは使わない
      const anchor =
        this.currentAssistantTurn !== null &&
        this.currentAssistantTurn.isConnected &&
        ev.turnId !== null &&
        this.currentAssistantTurn.dataset.turnId === ev.turnId
          ? this.currentAssistantTurn
          : null;
      const text = l10n.t("── {0} from here ──", this.modelDisplayName(ev.model));
      let row: HTMLElement;
      if (anchor) {
        row = document.createElement("div");
        row.className = "block system";
        row.textContent = text;
        anchor.before(row);
      } else {
        row = this.addBlock("system", text);
      }
      row.dataset.modelDivider = ev.model;
    }
    this.lastObservedModel = ev.model;
  }

  private onCompactBoundary(ev: Extract<NormalizedEvent, { kind: "compact_boundary" }>): void {
    const row = this.addBlock("system", compactBoundaryText(ev));
    row.dataset.compactBoundary = ev.trigger;
  }

  private onPermissionDenied(ev: Extract<NormalizedEvent, { kind: "permission_denied" }>): void {
    this.addBlock("error", permissionDeniedText(ev));
  }

  private onApprovalRequest(ev: Extract<NormalizedEvent, { kind: "approval_request" }>): void {
    this.applyWork(ev.work);
    this.renderApproval(ev);
    this.tabBtn.classList.add("needs-approval");
    this.flagConvAttention();
  }

  private onApprovalResolved(ev: Extract<NormalizedEvent, { kind: "approval_resolved" }>): void {
    // カードは控えた参照で引く。DOM 検索は範囲を誤るとヘッダのミラーを掴む。
    this.applyWork(ev.work);
    const el = this.approvalCards.get(ev.requestId);
    if (el) {
      el.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
      el.querySelectorAll("input").forEach((i) => ((i as HTMLInputElement).disabled = true));
      el.classList.add(ev.behavior === "allow" ? "approved" : "denied");
      const det = el.querySelector<HTMLDetailsElement>("details.approval-det");
      const titleEl = det?.querySelector<HTMLElement>("summary.approval-title");
      if (titleEl && !titleEl.querySelector(".approval-verdict")) {
        const verdict = document.createElement("span");
        verdict.className = `approval-verdict ${ev.behavior}`;
        verdict.textContent = ev.behavior === "allow" ? l10n.t("✔ Allowed") : l10n.t("✕ Denied");
        titleEl.appendChild(verdict);
      }
      if (det) det.open = false;
      const refRow = this.approvalRefs.get(ev.requestId);
      if (refRow && !refRow.classList.contains("resolved")) {
        refRow.classList.add("resolved", ev.behavior);
        refRow.textContent =
          (refRow.textContent?.replace(APPROVAL_REF_SUFFIX, "") ?? "") +
          (ev.behavior === "allow" ? l10n.t(" (Allowed)") : l10n.t(" (Denied)"));
      }
      // details の外に置き、畳んだ後も回答が見えるようにする。再生で二度処理されうるので重ねて足さない。
      if (ev.answers && Object.keys(ev.answers).length > 0 && !el.querySelector(".askq-answers-summary")) {
        const summary = document.createElement("div");
        summary.className = "askq-answers-summary";
        for (const [q, a] of Object.entries(ev.answers)) {
          const line = document.createElement("div");
          line.textContent = l10n.t("Answer: {0} → {1}", q, a);
          summary.appendChild(line);
        }
        el.appendChild(summary);
      }
    }
    if (!this.hasPendingApproval()) {
      this.tabBtn.classList.remove("needs-approval");
      // 会話タブ側の注意表示も同じ条件で解除する。解除しないと応答不要になっても残る。
      this.clearConvAttention();
    }
  }

  private onUsageUpdate(ev: Extract<NormalizedEvent, { kind: "usage_update" }>): void {
    this.usage = ev.usage;
    if (activeTabId === this.tabId) refreshChrome();
  }

  private onContextUsage(ev: Extract<NormalizedEvent, { kind: "context_usage" }>): void {
    this.contextUsage = ev;
    if (activeTabId === this.tabId) refreshChrome();
    if (!usagePanelEl.classList.contains("hidden")) renderUsagePanel();
  }

  private onRateLimit(ev: Extract<NormalizedEvent, { kind: "rate_limit" }>): void {
    rateLimits.set(ev.rateLimitType, {
      utilization: ev.utilization,
      resetsAt: ev.resetsAt,
      isUsingOverage: ev.isUsingOverage,
    });
    if (!usagePanelEl.classList.contains("hidden")) renderUsagePanel();
  }

  private onError(ev: Extract<NormalizedEvent, { kind: "error" }>): void {
    this.addBlock("error", ev.message);
    this.flagConvAttention();
    if (activeTabId === this.tabId) refreshChrome();
    // idle へ戻さないと、会話の開始失敗や連投ガードで running のまま固まる。起動時の API キー除去の警告は送信失敗ではないので戻さない。
    if (this.pendingSend && !ev.message.includes("ANTHROPIC_API_KEY")) {
      this.pendingSend = false;
      this.setTurnState("idle");
    }
  }

  private renderApproval(ev: Extract<NormalizedEvent, { kind: "approval_request" }>): void {
    const { requestId, toolName, rawInputJson, questions } = ev;
    // バックグラウンドのサブエージェントの承認は root の本文の途中にも届く
    this.endAssistantTurnBeforeConvBlock();
    const div = document.createElement("div");
    div.className = "block approval";
    div.dataset.approval = requestId;
    div.id = youAnchor(this.tabId, `approval:${requestId}`);
    this.approvalCards.set(requestId, div);
    const det = document.createElement("details");
    det.className = "approval-det";
    det.open = true;
    const title = document.createElement("summary");
    title.className = "approval-title";
    title.textContent = questions ? l10n.t("Question: {0}", toolName) : l10n.t("Approval request: {0}", toolName);

    const denyBtn = document.createElement("button");
    denyBtn.className = "danger";
    denyBtn.textContent = questions ? l10n.t("Don't answer") : l10n.t("Deny");
    denyBtn.onclick = () =>
      vscode.postMessage({ type: "approvalDecision", tabId: this.tabId, requestId, behavior: "deny" });

    if (questions && questions.questions.length > 0) {
      const answers = new Map<string, string[]>();
      const allowBtn = document.createElement("button");
      allowBtn.className = "primary";
      allowBtn.textContent = l10n.t("Answer and allow");
      allowBtn.disabled = true;

      const updateAllowState = () => {
        const answered = questions.questions.every((q) => (answers.get(q.question) ?? []).length > 0);
        allowBtn.disabled = !answered;
      };

      div.classList.add("askq-approval");
      const cards = questions.questions.map((q, questionIndex) => {
        const card = document.createElement("div");
        card.className = "askq-item laisora-ask ask-decide";
        card.append(...askHeading("decide", q.question, `${questionIndex + 1} / ${questions.questions.length}`, q.header));

        const optsEl = document.createElement("div");
        optsEl.className = "askq-options ask-options";
        const selected = new Set<string>();
        // classList と aria-pressed がずれないよう、選択の変更は setSelected と clearSelected だけで行う。
        const setSelected = (el: Element, on: boolean) => {
          el.classList.toggle("selected", on);
          el.setAttribute("aria-pressed", on ? "true" : "false");
        };
        // tsconfig の lib に DOM.Iterable が無く NodeList は for...of できない
        const clearSelected = () => optsEl.querySelectorAll(".askq-option").forEach((b) => setSelected(b, false));
        const otherInput = document.createElement("input");
        otherInput.type = "text";
        otherInput.className = "askq-other";
        otherInput.placeholder = l10n.t("Other (free text)");
        // src/protocol.ts#isWebviewToHost の値の上限と揃える。
        otherInput.maxLength = 10_000;

        const commit = () => {
          const other = otherInput.value.trim();
          const vals = q.multiSelect ? [...selected, ...(other ? [other] : [])] : other ? [other] : [...selected];
          if (vals.length > 0) answers.set(q.question, vals);
          else answers.delete(q.question);
          updateAllowState();
        };

        for (const [optionIndex, opt] of q.options.entries()) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "askq-option ask-option";
          btn.setAttribute("aria-pressed", "false");
          btn.append(...askOptionContent(optionIndex, opt.label, opt.description));
          btn.onclick = () => {
            if (q.multiSelect) {
              if (selected.has(opt.label)) selected.delete(opt.label);
              else selected.add(opt.label);
              setSelected(btn, selected.has(opt.label));
            } else {
              selected.clear();
              selected.add(opt.label);
              clearSelected();
              setSelected(btn, true);
              if (otherInput.value) otherInput.value = "";
            }
            commit();
          };
          optsEl.appendChild(btn);
        }
        card.appendChild(optsEl);
        otherInput.oninput = () => {
          if (!q.multiSelect && otherInput.value.trim()) {
            selected.clear();
            clearSelected();
          }
          commit();
        };
        card.appendChild(otherInput);
        return card;
      });

      allowBtn.onclick = () => {
        // src/protocol.ts#isWebviewToHost の検証と揃える。揃わないと approvalDecision が無言で捨てられる。
        const out: Record<string, string> = {};
        for (const [question, vals] of answers) {
          const key = question.slice(0, 2000);
          if (key.length === 0) continue;
          if (Object.keys(out).length >= 8) break;
          out[key] = vals.join(", ").slice(0, 10_000);
        }
        vscode.postMessage({
          type: "approvalDecision",
          tabId: this.tabId,
          requestId,
          behavior: "allow",
          answers: out,
        });
      };

      const actions = document.createElement("div");
      actions.className = "approval-actions";
      actions.append(allowBtn, denyBtn);
      det.append(title, ...cards, actions);
      div.append(det);
    } else {
      const body = buildApprovalBody(toolName, ev.inputJson, ev.inputSummary);
      // 要約だけで許可させないよう、原データの全文を残す。
      const detail = document.createElement("details");
      const detailSummary = document.createElement("summary");
      detailSummary.textContent = l10n.t("Show raw data (JSON)");
      const pre = document.createElement("pre");
      pre.textContent = rawInputJson;
      detail.append(detailSummary, pre);
      const allowBtn = document.createElement("button");
      allowBtn.className = "primary";
      allowBtn.textContent = l10n.t("Allow");
      allowBtn.onclick = () =>
        vscode.postMessage({ type: "approvalDecision", tabId: this.tabId, requestId, behavior: "allow" });
      const actions = document.createElement("div");
      actions.className = "approval-actions";
      actions.append(allowBtn, denyBtn);
      det.append(title, ...body, detail, actions);
      div.append(det);
    }
    // 作業ログ側には参照行だけを置き、ボタンを複製しない。同じ承認を二箇所から解決できると二重送信になる。
    this.convEl.appendChild(div);
    const ref = this.buildApprovalRefRow(ev);
    this.registerLogMember(ref, ev.turnId ?? undefined);
    this.workEl.appendChild(ref);
    this.scrollToBottom("conv");
  }

  // 作業ログ側の監査用参照行。live と過去 chunk で同じ行を使う（別実装にすると
  // 過去だけ文言や data 属性がずれ、承認の解決表示が当たらなくなる）
  private buildApprovalRefRow(
    ev: Extract<NormalizedEvent, { kind: "approval_request" }>
  ): HTMLElement {
    const ref = document.createElement("div");
    ref.className = "block worklog-approval-ref";
    ref.dataset.approvalRef = ev.requestId;
    this.approvalRefs.set(ev.requestId, ref);
    ref.textContent =
      (ev.questions ? l10n.t("Question: {0}", ev.toolName) : l10n.t("Approval request: {0}", ev.toolName)) +
      (ev.inputSummary ? ` — ${ev.inputSummary}` : "") +
      APPROVAL_REF_SUFFIX;
    return ref;
  }

  // R-HND-09: 挿入点は引き継ぎカードの後、復元マーカーと会話本文の前に置く（verify-history-prepend#HP-HNDtop）。
  installConvHistoryHead(): HTMLElement {
    if (this.convHistoryEl !== null && this.convHistoryEl.isConnected) return this.convHistoryEl;
    const head = document.createElement("div");
    head.className = "convlog-history";
    const body = document.createElement("div");
    body.className = "convlog-history-body";
    head.append(body);
    const marker = this.replayMarkerEl;
    // isConnected は「document に繋がっているか」で「convEl の子か」ではない。
    // 子でない要素を渡すと insertBefore が NotFoundError を投げる
    const cards = new Set([this.restoredHandoffCard, ...this.handoffCardEls.values()]);
    const lastCard = Array.from(this.convEl.children).filter((el) => cards.has(el as HTMLElement)).pop();
    const before = lastCard ? lastCard.nextSibling
      : marker !== null && marker.parentNode === this.convEl ? marker : this.convEl.firstChild;
    this.convEl.insertBefore(head, before);
    this.convHistoryEl = head;
    this.convHistoryBodyEl = body;
    return head;
  }

  setConvHistoryNote(text: string): void {
    const head = this.installConvHistoryHead();
    let note = head.querySelector<HTMLElement>(".convlog-history-note");
    if (note === null) {
      note = document.createElement("div");
      note.className = "convlog-history-note";
      note.setAttribute("role", "status");
      head.insertBefore(note, head.firstChild);
    }
    note.textContent = `⚠ ${text}`;
  }

  // 復元ブロックが1件も無ければ会話の遡りは成立しない（Host も session-unavailable を返す）
  hasReplayedConversation(): boolean {
    return this.oldestConversationUuid() !== undefined;
  }

  // Host が resume 時点で控えた uuid を起点にすると、再接続で窓から落ちた復元ブロックが起点より新しくなり、通知も出ずに欠落する（verify-conversation-history#CH-C8）。
  oldestConversationUuid(): string | undefined {
    const el = this.convEl.querySelector<HTMLElement>("[data-msg-uuid]");
    return el?.dataset.msgUuid;
  }

  // src/webview/main.ts#REPLAY_MAX の窓で落ちた会話イベントを会話面へ積む。transcript 由来の過去メッセージとは uuid 空間を共有するので重複しない。
  // 窓は先頭から落ちるので、復元マーカーが DOM にある限り落ちた前半に live の会話は含まれず、マーカーより上へ入れてよい。
  // addBlock は endAssistantTurn を走らせるので通さない。
  prependPastConvEvents(events: readonly NormalizedEvent[]): ConvEventPrependResult {
    const frag = document.createDocumentFragment();
    let rendered = 0;
    let duplicates = 0;
    let skipped = 0;
    let continued = 0;
    let failed = 0;
    const failures: string[] = [];
    // chunk 境界を跨いだターンも pastConvTurns で引き継いで一つのブロックに統合する。統合しないと chunk 境界が markdown の意味境界として現れる（verify-conversation-history#CH-C14mut）。
    const turns = new Map<string, { el: HTMLElement }>();
    const records = new Map<string, RecordTextPart[]>();
    for (const ev of events) {
      // turn_completed は会話面の白リストに無く描かれないが、返信フッターの日時の出所は
      // これしかない（assistant_text_delta の envelope timestamp は継承値）
      if (ev.kind === "turn_completed" && ev.timestamp > 0) this.pastTurnCompletedAt.set(ev.turnId, ev.timestamp);
      const key = `${ev.generation}:${ev.seq}`;
      if (this.renderedConvEventKeys.has(key)) {
        duplicates++;
        continue;
      }
      try {
        const outcome = this.renderPastConvEvent(ev, frag, turns);
        if (ev.provenance?.path !== "history" && (ev.kind === "assistant_text_delta" || ev.kind === "assistant_message_uuid")) {
          const parts = records.get(ev.turnId) ?? [];
          appendRecordPart(parts, ev.kind === "assistant_text_delta" ? { text: ev.text, uuid: null } : { text: "", uuid: ev.uuid });
          records.set(ev.turnId, parts);
        }
        this.renderedConvEventKeys.add(key);
        if (outcome === "skipped") skipped++;
        else if (outcome === "duplicate") duplicates++;
        else if (outcome === "continued") continued++;
        else rendered++;
      } catch (error) {
        failed++;
        if (failures.length < 5) failures.push(`${ev.kind}: ${String(error)}`);
      }
    }
    // 遡りは新しい chunk から古い chunk の順に届くので、既存ターンへは前へ結合する。
    // 結合後の全文を一度に render する（部分 render では意味境界が chunk 位置に依存する）
    for (const [turnId, parts] of records) {
      // 初回の統合先は窓の先頭で描いた live セグメント（topConvSeg）。統合後は pastConvTurns が
      // 同じ el と全文を持つので、以後はそちらから引く
      const top = this.topConvSeg;
      const carried =
        this.pastConvTurns.get(turnId) ??
        (top !== null && top.turnId === turnId ? top : undefined);
      const joined = prependRecordParts(parts, this.pastConvRecords.get(turnId) ?? (top !== null && carried === top ? top.records : []));
      this.pastConvRecords.set(turnId, joined);
      const turn = turns.get(turnId) ?? carried;
      if (turn === undefined) continue;
      const merged = joinRecordTexts(joined.map((part) => part.text));
      this.youStore.retain(turnId, 0, Infinity, new Set());
      this.pastConvTurns.set(turnId, { el: turn.el, text: merged });
      this.renderReplyMarkdown(turn.el, merged, turnId);
    }
    for (const [turnId, footer] of this.pastConvFooters) {
      Tab.applyFooterTime(footer, this.pastTurnCompletedAt.get(turnId));
    }
    this.installConvHistoryHead();
    const body = this.convHistoryBodyEl!;
    body.insertBefore(frag, body.firstChild);
    this.refreshLatestReplyFooter();
    this.convPrependedTotal += rendered;
    scheduleImageLoads(this);
    return {
      total: events.length,
      rendered,
      duplicates,
      skipped,
      continued,
      failed,
      failures,
      connected: this.convEl.querySelectorAll("[data-conv-past]").length,
      expectedConnected: this.convPrependedTotal,
    };
  }

  private renderPastConvEvent(
    ev: NormalizedEvent,
    frag: DocumentFragment,
    turns: Map<string, { el: HTMLElement }>
  ): "created" | "duplicate" | "continued" | "skipped" {
    this.observeYouEvent(ev);
    if (!isConvRenderableEvent(ev)) return "skipped";
    if (ev.kind === "model_refusal_fallback" || ev.kind === "model_fallback_revert") {
      const div = document.createElement("div");
      div.className = "block system";
      div.dataset.convPast = "1";
      if (ev.kind === "model_refusal_fallback") {
        div.textContent = this.fallbackText(ev);
        this.decorateFallbackBlock(div, ev);
      } else {
        div.textContent = this.fallbackRevertText(ev);
      }
      frag.append(div);
      return "created";
    }
    if (ev.kind === "replayed_message") {
      const uuid = ev.uuid;
      if (uuid !== undefined && this.convMessageUuids.has(uuid)) return "duplicate";
      const div = document.createElement("div");
      div.className = ev.role === "user" ? "block user replayed" : "block assistant replayed";
      div.dataset.convPast = "1";
      if (uuid !== undefined && uuid.length > 0) {
        div.dataset.msgUuid = uuid;
        this.convMessageUuids.add(uuid);
      }
      if (ev.role === "assistant") {
        if (uuid) this.recordReplyIds.add(uuid);
        this.renderReplyMarkdown(div, ev.text, ev.uuid ?? `replay:${ev.generation}:${ev.seq}`, 0, ev.recordedAt ?? 0, ev.seq, ev.generation);
      }
      else div.textContent = ev.text;
      this.prependTurnLabel(div, ev.role, ev.model ?? null);
      this.observeSessionTime(ev.recordedAt ?? ev.sentAt);
      if (ev.role === "user" && ev.imageRefs && ev.imageRefs.length > 0) {
        for (const info of ev.imageRefs) {
          div.appendChild(createImageSlot(this.tabId, info.ref));
        }
      }
      frag.appendChild(div);
      // フッターに data-conv-past は付けない。prepend の照合（connected と
      // expectedConnected）は data-conv-past の実数を数えるので、行以外に付けると差が出る
      if (ev.role === "user") this.appendUserFoot(div, ev.recordedAt ?? ev.sentAt ?? undefined, ev.text);
      else frag.appendChild(this.buildReplyFooter(ev.recordedAt, () => ev.text));
      return "created";
    }
    if (ev.kind === "user_message") {
      const div = document.createElement("div");
      div.className = "block user";
      div.dataset.convPast = "1";
      if (ev.turnId !== null) div.dataset.turnId = ev.turnId;
      div.textContent = ev.text;
      this.prependTurnLabel(div, "user");
      for (const im of ev.images ?? []) {
        const img = document.createElement("img");
        img.className = "user-image";
        img.src = `data:${im.mediaType};base64,${im.data}`;
        img.alt = l10n.t("Attached image");
        attachLightboxHandlers(img, this.tabId, { inline: im });
        div.appendChild(img);
      }
      if (ev.imageRefs !== undefined && ev.imageRefs.length > 0) {
        for (const info of ev.imageRefs) {
          div.appendChild(createImageSlot(this.tabId, info.ref));
        }
      }
      frag.appendChild(div);
      this.observeSessionTime(ev.sentAt);
      this.appendUserFoot(div, ev.sentAt ?? (ev.timestamp > 0 ? ev.timestamp : undefined), ev.text);
      return "created";
    }
    if (ev.kind === "assistant_text_delta") {
      const existing = turns.get(ev.turnId);
      if (existing !== undefined) {
        return "continued";
      }
      const carried = this.pastConvTurns.get(ev.turnId);
      if (carried !== undefined && carried.el.isConnected) {
        turns.set(ev.turnId, { el: carried.el });
        return "continued";
      }
      // R-CNV-09: 再生窓の切れ目で割れたターンは、別ブロックを作らず topConvSeg へ統合する。
      const top = this.topConvSeg;
      if (top !== null && top.turnId === ev.turnId && top.el.isConnected) {
        turns.set(ev.turnId, { el: top.el });
        return "continued";
      }
      const turn = document.createElement("div");
      turn.className = "block assistant-turn";
      this.prependTurnLabel(turn, "assistant", null);
      turn.dataset.convPast = "1";
      turn.dataset.turnId = ev.turnId;
      const seg = document.createElement("div");
      seg.className = "assistant-seg";
      turn.appendChild(seg);
      frag.appendChild(turn);
      turns.set(ev.turnId, { el: seg });
      const turnId = ev.turnId;
      const footer = this.buildReplyFooter(undefined, () => this.pastConvTurns.get(turnId)?.text ?? "");
      this.pastConvFooters.set(turnId, footer);
      frag.appendChild(footer);
      return "created";
    }
    if (ev.kind === "model_observed") {
      const turn = ev.turnId === null ? undefined : turns.get(ev.turnId) ?? this.pastConvTurns.get(ev.turnId);
      const label = turn?.el.closest(".block.assistant-turn")?.querySelector<HTMLElement>(":scope > .turn-label > .turn-label-name");
      if (label) label.textContent = this.modelDisplayName(ev.model);
      let created = false;
      if (this.lastPastModel !== null && this.lastPastModel !== ev.model) {
        const div = document.createElement("div");
        div.className = "block system";
        div.dataset.convPast = "1";
        div.dataset.modelDivider = ev.model;
        div.textContent = l10n.t("── {0} from here ──", this.modelDisplayName(ev.model));
        frag.appendChild(div);
        created = true;
      }
      this.lastPastModel = ev.model;
      return created ? "created" : "skipped";
    }
    if (ev.kind === "compact_boundary") {
      const div = document.createElement("div");
      div.className = "block system";
      div.dataset.convPast = "1";
      div.dataset.compactBoundary = ev.trigger;
      div.textContent = compactBoundaryText(ev);
      frag.appendChild(div);
      return "created";
    }
    return "skipped";
  }

  // addBlock を通さない。addBlock は進行中の assistant コンテナを閉じるので、ストリーミング中の本文が確定される（verify-conversation-history#CH-C5）。
  prependPastMessages(
    items: ReadonlyArray<{
      uuid: string;
      role: "user" | "assistant";
      text: string;
      imageRefs?: ImageRefInfo[];
      model?: string;
      // ConversationHistoryMessagePayload は timestamp を持つ。型から落とすとフッターの
      // 日時が全件消える
      timestamp?: number;
    }>
  ): ConvPrependResult {
    const frag = document.createDocumentFragment();
    let rendered = 0;
    let duplicates = 0;
    let failed = 0;
    const failures: string[] = [];
    let pastModel: string | null = null;
    let dividersCreated = 0;
    for (const m of items) {
      if (m.uuid.length === 0 || this.convMessageUuids.has(m.uuid)) {
        duplicates++;
        continue;
      }
      try {
        if (m.role === "assistant" && m.model) {
          if (pastModel !== null && pastModel !== m.model) {
            const div = document.createElement("div");
            div.className = "block system";
            div.dataset.convPast = "1";
            div.dataset.modelDivider = m.model;
            div.textContent = l10n.t("── {0} from here ──", this.modelDisplayName(m.model));
            frag.appendChild(div);
            dividersCreated++;
          }
          pastModel = m.model;
        }
        const div = document.createElement("div");
        div.className = m.role === "user" ? "block user replayed" : "block assistant replayed";
        div.dataset.msgUuid = m.uuid;
        div.dataset.convPast = "1";
        if (m.role === "assistant") {
          this.recordReplyIds.add(m.uuid);
          this.renderReplyMarkdown(div, m.text, m.uuid, 0, m.timestamp ?? 0);
        }
        else {
          div.textContent = m.text;
          this.youStore.reply(m.uuid, m.timestamp ?? 0, undefined, undefined, m.text);
        }
        this.prependTurnLabel(div, m.role, m.model ?? null);
        this.observeSessionTime(m.timestamp);
        if (m.role === "user" && m.imageRefs && m.imageRefs.length > 0) {
          for (const info of m.imageRefs) {
            div.appendChild(createImageSlot(this.tabId, info.ref));
          }
        }
        frag.appendChild(div);
        if (m.role === "user") this.appendUserFoot(div, m.timestamp, m.text);
        else frag.appendChild(this.buildReplyFooter(m.timestamp, () => m.text));
      } catch (error) {
        failed++;
        if (failures.length < 5) failures.push(String(error));
        continue;
      }
      this.convMessageUuids.add(m.uuid);
      rendered++;
    }
    this.installConvHistoryHead();
    const body = this.convHistoryBodyEl!;
    body.insertBefore(frag, body.firstChild);
    this.refreshLatestReplyFooter();
    this.convPrependedTotal += rendered + dividersCreated;
    scheduleImageLoads(this);
    return {
      total: items.length,
      rendered,
      duplicates,
      failed,
      failures,
      connected: this.convEl.querySelectorAll("[data-conv-past]").length,
      expectedConnected: this.convPrependedTotal,
    };
  }

  // src/webview/main.ts は再生の直後、概要の要素を workEl 先頭へ入れる前に呼ぶ。この順で概要の要素が挿入点より上に入る。
  installHistoryHead(): HTMLElement {
    this.replayDone = true;
    if (this.historyHeadEl !== null && this.historyHeadEl.isConnected) return this.historyHeadEl;
    // 後から届く chunk ほど古いので、毎回 body の先頭へ入れれば時系列順に積み上がる。
    const head = document.createElement("div");
    head.className = "worklog-history";
    const more = document.createElement("div");
    more.className = "worklog-history-more";
    const body = document.createElement("div");
    body.className = "worklog-history-body";
    head.append(more, body);
    this.workEl.insertBefore(head, this.workEl.firstChild);
    this.historyHeadEl = head;
    this.historyMoreEl = more;
    this.historyBodyEl = body;
    return head;
  }

  // src/webview/work-overview.ts#WorkOverview の applyMode は workEl 直下の子を隠す。見えていない所へ積むと scrollHeight が動かず、視界を保てない。
  historyPaneUsable(): boolean {
    return this.historyHeadEl !== null && this.historyHeadEl.isConnected && !this.historyHeadEl.hidden;
  }

  addHistoryNotice(text: string): HTMLElement {
    this.installHistoryHead();
    const div = document.createElement("div");
    div.className = "block system warn";
    div.textContent = text;
    this.historyMoreEl!.appendChild(div);
    return div;
  }

  // src/webview/main.ts#addTab で再生した窓の分もここで登録する。
  noteRenderedEvents(events: readonly NormalizedEvent[]): void {
    for (const ev of events) this.renderedEventKeys.add(`${ev.generation}:${ev.seq}`);
  }

  prependPastEvents(events: readonly NormalizedEvent[]): PastPrependResult {
    const ctx: PastRenderContext = {
      frag: document.createDocumentFragment(),
      anchors: new Map(),
      createdNow: new Set(),
      rendered: 0,
      skipped: 0,
      created: 0,
      failed: 0,
      failures: [],
    };
    let duplicates = 0;
    const bgFinishedChanged = notePastLifecycle(this.activity, events, (ev) => this.renderedEventKeys.has(`${ev.generation}:${ev.seq}`));
    this.pastRender = ctx;
    this.pastChunkSerial++;
    this.pastChunkTurnSeen = false;
    // chunk は新しい側から順に届くので、前 chunk の末尾（より新しい）と比較すると偽の区切りになる
    this.lastPastModel = null;
    try {
      for (const ev of events) {
        const key = `${ev.generation}:${ev.seq}`;
        if (this.renderedEventKeys.has(key)) {
          duplicates++;
          continue;
        }
        // 1件の例外で chunk 全体を落とさない。落とすと frag が挿入されないまま
        // 識別子だけ登録され、取り直しても duplicates で弾かれて永久に欠落する。
        // 失敗した件は識別子を登録しないので、もう一度取れば再挑戦できる
        let outcome: PastRenderOutcome;
        try {
          this.observeLogEvent(ev);
          outcome = this.renderPastEvent(ev);
          if (ev.kind === "tool_call_started" || ev.kind === "tool_call_finished" || ev.kind === "subagent_info") this.refreshLogRow(ev.toolUseId);
        } catch (error) {
          ctx.failed++;
          if (ctx.failures.length < 5) ctx.failures.push(`${ev.kind}: ${String(error)}`);
          continue;
        }
        this.renderedEventKeys.add(key);
        if (outcome === "skipped") ctx.skipped++;
        else ctx.rendered++;
        if (outcome === "created") ctx.created++;
      }
      this.takePastChunkTail();
    } finally {
      this.pastRender = null;
      this.logEventTurn = undefined;
    }
    this.installHistoryHead();
    const body = this.historyBodyEl!;
    body.insertBefore(ctx.frag, body.firstChild);
    this.refreshLogRequests();
    this.pastRenderedTotal += ctx.created;
    if (bgFinishedChanged) this.updateStrip();
    return {
      total: events.length,
      rendered: ctx.rendered,
      skipped: ctx.skipped,
      duplicates,
      failed: ctx.failed,
      // 未接続コンテナへ落ちた行はここに数えられない。それが検出したい状態
      connected: this.workEl.querySelectorAll(".hll-past").length,
      expectedConnected: this.pastRenderedTotal,
      failures: ctx.failures,
    };
  }

  // created だけが pastRenderedTotal に数えられ、接続済み DOM と突き合わされる。
  private renderPastEvent(ev: NormalizedEvent): PastRenderOutcome {
    this.youStore.observe(ev);
    this.notePastWork(ev.work);
    switch (ev.kind) {
      case "turn_started":
        return this.renderPastTurnStart(ev);
      case "user_message":
        return this.notePastHumanHeadline(ev.text, ev.turnId) ? "applied" : "skipped";
      case "tool_call_started":
        return this.renderPastToolStarted(ev);
      case "tool_call_finished": {
        if (this.applyToolFinishDom(ev)) return "applied";
        // 開始行は古い側の chunk にあるので、退避して当て直す（verify-history-prepend#HPmut-8）。
        this.rememberOrphanFinish(ev);
        return "skipped";
      }
      case "subagent_info":
        return this.renderPastSubagentInfo(ev);
      case "approval_request": {
        // 会話面の操作カードは作らない。過去の承認は解決済みで、操作させると二重送信の入口になる
        const ref = this.buildApprovalRefRow(ev);
        ref.classList.add("hll-past");
        this.insertWork(this.pastRender!.frag, ref);
        const pendingResolve = this.orphanApprovalResolved.get(ev.requestId);
        if (pendingResolve !== undefined) {
          this.orphanApprovalResolved.delete(ev.requestId);
          this.applyApprovalRefResolved(pendingResolve);
        }
        return "created";
      }
      case "approval_resolved": {
        if (this.applyApprovalRefResolved(ev)) return "applied";
        if (this.orphanApprovalResolved.size < ORPHAN_FINISH_MAX) {
          this.orphanApprovalResolved.set(ev.requestId, ev);
        }
        return "skipped";
      }
      case "permission_denied":
        return this.renderPastPlainRow(
          permissionDeniedText(ev),
          "error"
        );
      case "model_refusal_fallback":
        return this.renderPastPlainRow(this.fallbackLogText(ev), "system");
      case "model_fallback_revert":
        return this.renderPastPlainRow(this.fallbackRevertText(ev), "system");
      case "error":
        return this.renderPastPlainRow(ev.message, "error");
      case "api_retry":
        return this.renderPastPlainRow(
          l10n.t("API retry ({0}/{1})", ev.attempt, ev.maxRetries),
          "system warn"
        );
      default:
        return "skipped";
    }
  }

  // applyWork を通すと、現在の segment・タスク・帯・agent 状態を過去の値で書き換える（R-TAB-09）
  private notePastWork(work: WorkEventInfo | undefined): void {
    for (const segment of work?.segments ?? []) {
      const stored = this.pastSegmentTotals.get(segment.segmentId);
      if (stored !== undefined && stored.revision >= segment.revision) continue;
      this.pastSegmentTotals.set(segment.segmentId, segment);
      const card = this.segmentCards.get(segment.segmentId);
      if (card) this.renderSegmentCard(card);
    }
    for (const agent of work?.agents ?? []) {
      const stored = this.pastAgentStates.get(agent.toolUseId);
      if (stored !== undefined && stored.revision >= agent.revision) continue;
      this.pastAgentStates.set(agent.toolUseId, agent);
      this.renderAgentMeta(agent.toolUseId);
    }
  }

  private renderPastTurnStart(
    ev: Extract<NormalizedEvent, { kind: "turn_started" }>
  ): PastRenderOutcome {
    const cliInserted = ev.cliInserted === true;
    const stash = this.pastHeadline;
    // CLI が開いたターンは持ち越した見出しを引き取らない。引き取ると、利用者が打った発言が
    // 打っていないターンの見出しになり、以後の見出しが 1 つずつずれる
    const takes =
      stash !== null &&
      !cliInserted &&
      (stash.turnId !== null ? stash.turnId === ev.turnId : stash.chunk === this.pastChunkSerial);
    const headline = takes ? stash.text : null;
    if (takes) {
      this.pastHeadline = null;
    } else if (cliInserted && stash !== null && stash.turnId === null && stash.chunk === this.pastChunkSerial) {
      // 位置で引き当てる持ち越し（turnId 無し）が CLI のターンを跨いだら持ち主が決まらない。
      // 残すと後続の人間ターンが引き取り、以後の見出しが 1 つずつずれる。turnId を持つ持ち越しは
      // id で照合するので残す
      this.pastHeadline = null;
    }
    const anchor = this.buildTurnAnchor(ev.turnId, ev.timestamp, headline, true, cliInserted);
    // CLI の区切りは引き取り待ちにならず、先行する引き取り待ちも潰さない。
    // pastPendingAnchor・pastPendingChunk・pastPendingFirst は組なので、更新するときは同時に動かす。
    if (!cliInserted) {
      this.pastPendingAnchor = headline === null ? anchor : null;
      this.pastPendingChunk = this.pastChunkSerial;
      this.pastPendingFirst = !this.pastChunkTurnSeen;
    }
    this.pastChunkTurnSeen = true;
    this.insertWork(this.pastRender!.frag, anchor);
    return "created";
  }

  private renderPastPlainRow(text: string, cls: string): PastRenderOutcome {
    const div = document.createElement("div");
    div.className = `block ${cls} hll-past`;
    div.textContent = text;
    this.insertWork(this.pastRender!.frag, div);
    return "created";
  }

  private renderPastToolStarted(
    ev: Extract<NormalizedEvent, { kind: "tool_call_started" }>
  ): PastRenderOutcome {
    if (this.rowData.has(ev.toolUseId)) return "skipped";
    const placement = ev.work?.placement;
    // live も配置の無い開始には行を作らないので、過去でも作らない。
    if (!placement) return "skipped";
    this.toolStartTimes.set(ev.toolUseId, ev.timestamp);
    const isAgent = ev.work?.agents?.some((agent) => agent.toolUseId === ev.toolUseId) === true;
    const el = isAgent ? this.createAgentCard(ev) : this.buildToolRow(ev, toolSummary(ev));
    el.classList.add("replayed", "hll-past");
    this.placeWork(
      el,
      placement,
      isAgent ? `🤖 ${toolSummary(ev)}` : `${ev.toolName}: ${toolSummary(ev)}`
    );
    if (isAgent) this.renderAgentMeta(ev.toolUseId);
    // 窓の外で開始し窓の中で終わったツールは、行ができた今その終端を当て直さないと running のまま固着する（verify-history-prepend#HPmut-3）。
    this.drainOrphanUpdates(ev.toolUseId);
    return "created";
  }

  private renderPastSubagentInfo(
    ev: Extract<NormalizedEvent, { kind: "subagent_info" }>
  ): PastRenderOutcome {
    if (ev.model === undefined) return "skipped";
    const entry = this.agentCards.get(ev.toolUseId);
    const data = this.rowData.get(ev.toolUseId);
    if (!entry || !data) {
      if (this.orphanSubagentInfo.size < ORPHAN_FINISH_MAX) {
        this.orphanSubagentInfo.set(ev.toolUseId, ev);
      }
      return "skipped";
    }
    setRowChip(data, "model", shortModelLabel(ev.model));
    fillChips(entry.chipsEl, data);
    return "applied";
  }

  private applyApprovalRefResolved(
    ev: Extract<NormalizedEvent, { kind: "approval_resolved" }>
  ): boolean {
    const refRow = this.approvalRefs.get(ev.requestId);
    if (!refRow || refRow.classList.contains("resolved")) return false;
    refRow.classList.add("resolved", ev.behavior);
    refRow.textContent =
      (refRow.textContent?.replace(APPROVAL_REF_SUFFIX, "") ?? "") +
      (ev.behavior === "allow" ? l10n.t(" (Allowed)") : l10n.t(" (Denied)"));
    return true;
  }

  // Display-only preview (no event identity, no pager anchors, no [data-msg-uuid])
  renderResumePreview(messages: ResumePreviewMessage[]): void {
    if (messages.length === 0) return;
    if (!this.replayMarkerShown) {
      this.replayMarkerShown = true;
      this.replayMarkerEl = this.addBlock("system", l10n.t("── Restored previous session ──"));
    }
    for (const msg of messages) {
      if (msg.role === "user") {
        const block = this.addBlock("user replayed", msg.text);
        if (msg.imageRefs && msg.imageRefs.length > 0) {
          for (const info of msg.imageRefs) {
            block.appendChild(createImageSlot(this.tabId, info.ref));
          }
        }
      } else {
        if (msg.model) {
          if (this.lastObservedModel !== null && this.lastObservedModel !== msg.model) {
            const divider = this.addBlock("system", l10n.t("── {0} from here ──", this.modelDisplayName(msg.model)));
            divider.dataset.modelDivider = msg.model;
          }
          this.lastObservedModel = msg.model;
        }
        this.addBlock("assistant replayed", msg.text, true, "conv", msg.model ?? null);
      }
    }
    scheduleImageLoads(this);
  }

  renderOptimisticUserBubble(text: string, clientToken: string, images?: ImageAttachment[]): HTMLElement {
    this.endAssistantTurn();
    const block = this.addBlock("user", text);
    block.dataset.hydrationOptimistic = "true";
    block.dataset.clientToken = clientToken;
    for (const im of images ?? []) {
      const img = document.createElement("img");
      img.className = "user-image";
      img.src = `data:${im.mediaType};base64,${im.data}`;
      img.alt = l10n.t("Attached image");
      attachLightboxHandlers(img, this.tabId, { inline: im });
      block.appendChild(img);
    }
    this.optimisticFoots.set(clientToken, this.appendUserFoot(block, Date.now(), text));
    this.scrollToBottom("conv");
    return block;
  }

  removeOptimisticBubble(clientToken: string): void {
    const el = this.convEl.querySelector<HTMLElement>(
      `.block.user[data-hydration-optimistic="true"][data-client-token="${CSS.escape(clientToken)}"]`
    );
    // フッターは吹き出しの外にある。行だけ消すと日時とコピーボタンが取り残される。
    // 位置ではなく生成時に控えた実体で消す（間に要素が入っても取りこぼさない）
    const foot = this.optimisticFoots.get(clientToken);
    if (foot !== undefined) {
      foot.remove();
      this.optimisticFoots.delete(clientToken);
    }
    if (el) el.remove();
  }

  markOptimisticBubbleAccepted(clientToken: string): void {
    const el = this.convEl.querySelector<HTMLElement>(
      `.block.user[data-hydration-optimistic="true"][data-client-token="${CSS.escape(clientToken)}"]`
    );
    if (el) {
      el.dataset.hydrationAccepted = "true";
      el.dataset.disposition = "accepted-human";
    }
  }
}
