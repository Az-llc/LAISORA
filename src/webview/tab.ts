import { createLoader } from "./loader";
import { mergeAskChoice } from "./ask-choice";
import { createSessionHeader } from "./session-header";
import { PlanPanel } from "./plan-panel";
import { applyFallbackModel, fallbackNeedsConfirmation, fallbackNoticeOriginal, foldModelFallback, resolveFallbackByChoice } from "../protocol";
import type { ModelFallbackState } from "../protocol";
import { YouList } from "./you-list";
import { bindUserLabel, onUserLabelChange, userLabel } from "./user-label";
import type { YouItem } from "./you-items";
import { resolveModelDisplayName } from "../model-display-name";
import type {
  AuthStatus,
  HostToWebview,
  ImageAttachment,
  ImageRefInfo,
  ModelInfo,
  NormalizedEvent,
  PermissionModeId,
  ResumePreviewMessage,
  RestoredApprovalCard,
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
import type { HandoffContextMeasurement, HandoffDecisionCounts, HandoffSourceSnapshot } from "../protocol";
import type { HandoffCompactStats, HandoffContextUsage, HandoffDecisionEntry } from "../handoff-envelope";
import * as l10n from "@vscode/l10n";
import { inputEl, logsEl, tabbarEl, usagePanelEl, sessionActionsEl, vscode } from "./dom";
import { buildApprovalBody, buildRestoredApprovalCard } from "./approval";
import { clock, formatDuration, monthDayClock, toolSummary } from "./format";
import { uiLocale } from "./l10n";
import { createCopyButton, renderMarkdownInto } from "./markdown";
import { askHeading, askOptionContent, updateAskCounters } from "./ask-view";
import { createYouItems, encodeAskDismissal, encodeAskResolution, youAnchor, type AskIdentity, type AskResolutionRecord, type YouItemsReader } from "./you-items";
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

function writeModelText(span: HTMLElement, text: string): boolean {
  if (span.textContent === text) return false;
  span.textContent = text;
  return true;
}

type HandoffDetailKind = "messages" | "decisions" | "summary";

interface HandoffCardInput {
  source: { sessionId: string; title?: string };
  compact?: HandoffCompactStats;
  contextUsage?: HandoffContextUsage;
  utteranceCount?: number;
  unreadableLineCount?: number;
  runId?: string;
  decisions?: HandoffDecisionCounts;
  decisionCount?: number;
}

interface HandoffRowParts {
  row: HTMLElement;
  sub: HTMLElement;
  num: HTMLElement;
  warns: HTMLElement;
}

function handoffNode(tag: string, className: string, ...children: Array<Node | string | null>): HTMLElement {
  const el = document.createElement(tag);
  if (className !== "") el.className = className;
  for (const child of children) {
    if (child === null) continue;
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function handoffWarn(text: string): HTMLElement {
  return handoffNode("div", "handoff-card-warn", handoffNode("span", "", text));
}

function buildHandoffRow(code: string, text: string, name: string, kind?: HandoffDetailKind): HandoffRowParts {
  const sub = handoffNode("span", "handoff-row-sub");
  const num = handoffNode("span", "handoff-row-num");
  const line = handoffNode("div", "handoff-line",
    handoffNode("span", "handoff-row-code", code),
    handoffNode("span", "handoff-row-text", handoffNode("span", "handoff-row-label", text), sub),
    num,
    handoffNode("span", "handoff-row-chev", kind === undefined ? "" : "›"));
  const warns = handoffNode("div", "handoff-row-warns");
  const head = handoffNode(kind === undefined ? "div" : "summary", "handoff-row-head", line, warns);
  const row = handoffNode(kind === undefined ? "div" : "details",
    `handoff-row handoff-row-${name}${kind === undefined ? "" : ` handoff-detail handoff-detail-${kind}`}`, head);
  if (kind !== undefined) row.appendChild(handoffNode("div", "handoff-detail-body"));
  return { row, sub, num, warns };
}

function renderHandoffCount(cell: HTMLElement, count: number): void {
  cell.textContent = "";
  cell.append(document.createTextNode(String(count)), handoffNode("span", "handoff-num-unit", l10n.t("items")));
}

function detailBodyOf(card: HTMLElement, kind: HandoffDetailKind): HTMLElement | null {
  return card.querySelector<HTMLElement>(`.handoff-detail-${kind} .handoff-detail-body`);
}

function fillHandoffDetail(body: HTMLElement, ...content: HTMLElement[]): void {
  body.dataset.state = "ready";
  body.textContent = "";
  body.append(...content);
}

function setHandoffDetailLoading(body: HTMLElement): void {
  body.dataset.state = "loading";
  body.textContent = "";
  body.appendChild(handoffNode("div", "handoff-detail-state", createLoader(12),
    handoffNode("span", "handoff-detail-state-muted", l10n.t("Loading…"))));
}

function setHandoffDetailFailed(body: HTMLElement, retry: () => void): void {
  body.dataset.state = "failed";
  body.textContent = "";
  const retryBtn = handoffNode("button", "handoff-detail-retry", l10n.t("Retry")) as HTMLButtonElement;
  retryBtn.type = "button";
  retryBtn.onclick = (e) => {
    e.preventDefault();
    retry();
  };
  body.appendChild(handoffNode("div", "handoff-detail-state",
    handoffNode("span", "handoff-detail-failed", handoffNode("span", "handoff-detail-failed-mark", "✗"), " ", HANDOFF_DETAIL_UNAVAILABLE),
    retryBtn));
}

function renderDecisionCounts(card: HTMLElement, counts: HandoffDecisionCounts): void {
  const row = card.querySelector<HTMLElement>(".handoff-row-decisions");
  if (row === null) return;
  const sub = row.querySelector<HTMLElement>(".handoff-row-sub");
  if (sub !== null) {
    sub.textContent = counts.removed > 0
      ? l10n.t("{0} new · {1} from earlier generations · {2} removed this time", counts.extracted, counts.carried, counts.removed)
      : l10n.t("{0} new · {1} from earlier generations", counts.extracted, counts.carried);
  }
  const num = row.querySelector<HTMLElement>(".handoff-row-num");
  if (num !== null) renderHandoffCount(num, counts.total);
  const slot = row.querySelector<HTMLElement>(".handoff-decisions-lines");
  if (slot === null) return;
  slot.textContent = "";
  for (const text of decisionWarnings(counts)) slot.appendChild(handoffWarn(text));
}

function decisionWarnings(counts: HandoffDecisionCounts): string[] {
  const out: string[] = [];
  if (counts.unknownIdRefs > 0) {
    out.push(l10n.t("⚠ {0} lines named an id that does not exist and were ignored", counts.unknownIdRefs));
  }
  if (counts.carried > 0 && counts.extracted >= counts.carried * DECISIONS_REWRITE_RATIO) {
    out.push(l10n.t("⚠ Lines that were already carried forward may have been rewritten ({0} new against {1} carried over)", counts.extracted, counts.carried));
  }
  if (counts.warn !== undefined) {
    out.push(l10n.t("⚠ {0} decision lines / {1} KB are attached. Consider tidying them up.", counts.warn.entries, Math.round(counts.warn.bytes / 1024)));
  }
  return out;
}

function buildHandoffDecisionRows(entries: HandoffDecisionEntry[], removed: HandoffDecisionEntry[]): HTMLElement[] {
  const row = (entry: HandoffDecisionEntry, done: boolean): HTMLElement => handoffNode("div", done ? "handoff-dec removed" : "handoff-dec",
    handoffNode("span", "handoff-dec-id", entry.id),
    handoffNode("span", "handoff-dec-tag", done ? "DONE" : entry.t),
    handoffNode("span", "handoff-dec-text", entry.s),
    handoffNode("span", "handoff-dec-g", `g${entry.g}`));
  const out = [handoffNode("div", "handoff-decs", ...entries.map((entry) => row(entry, false)))];
  if (removed.length > 0) {
    out.push(handoffNode("div", "handoff-dec-group", l10n.t("Removed this time")),
      handoffNode("div", "handoff-decs", ...removed.map((entry) => row(entry, true))));
  }
  return out;
}

function buildHandoffUtterance(u: HandoffDetailMessage["utterances"][number]): HTMLElement {
  const body = handoffNode("div", "handoff-utt-body");
  for (const question of u.questions ?? []) body.appendChild(handoffNode("p", "handoff-utt-q", question));
  body.appendChild(handoffNode("pre", "handoff-utt-text", u.text));
  const at = Date.parse(u.at);
  return handoffNode("div", "handoff-utt",
    handoffNode("span", "handoff-utt-no", String(u.n).padStart(2, "0")),
    body,
    handoffNode("span", "handoff-utt-at", Number.isFinite(at) ? clock(at) : u.at));
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

const HANDOFF_FAILURE_VISIBLE_MS = 120_000;
const HANDOFF_CANCEL_VISIBLE_MS = 5000;
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

function renderHandoffContext(cell: HTMLElement, usage: HandoffContextUsage | undefined): void {
  type Value = HandoffContextUsage["after"];
  const measured = (v: Value): v is HandoffContextMeasurement => typeof v === "object" && v !== null;
  const missing = (v: Value): string => v === "pending" ? l10n.t("Retrieving…") : v === null ? l10n.t("Could not retrieve") : l10n.t("Unavailable");
  const value = (v: Value): Node => measured(v)
    ? document.createTextNode(v.totalTokens.toLocaleString(uiLocale()))
    : handoffNode("span", "handoff-num-na", missing(v));
  const arrow = (): HTMLElement => handoffNode("span", "handoff-num-arrow", "→");
  const unit = (): HTMLElement => handoffNode("span", "handoff-num-unit", l10n.t("tokens"));
  const before = usage?.before;
  const after = usage?.after;
  cell.textContent = "";
  if (!measured(before) && !measured(after)) {
    if (missing(before) === missing(after)) cell.append(value(after));
    else cell.append(value(before), arrow(), value(after));
  } else if (measured(after)) {
    cell.append(value(before), arrow(), value(after), unit());
  } else {
    cell.append(value(before), unit(), arrow(), value(after));
  }
}

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

interface WorkRowData {
  toolUseId: string;
  kind: "tool" | "agent";
  toolName: string;
  summaryText: string;
  inputPreview: string;
  status: "running" | "done" | "failed" | "stale";
  startedAt: number;
  resultPreview?: string;
  elapsedLabel?: string;
  statusGlyph?: string;
  metaText?: string;
  chips?: { kind: string; text: string }[];
  childIds?: string[];
}

const AGENT_STATUS_WORD: Record<WorkAgentStateView["status"], string> = {
  running: l10n.t("Running"),
  completed: l10n.t("Completed"),
  failed: l10n.t("Failed"),
  stale: l10n.t("Tracking stopped"),
  unknown: l10n.t("Unknown"),
};

function permissionDeniedText(ev: { toolName: string; reason: string; classifierUnavailable?: boolean }): string {
  if (ev.classifierUnavailable) return l10n.t("Could not evaluate: {0} — safety classifier unavailable", ev.toolName);
  return l10n.t("Auto-denied: {0} — {1}", ev.toolName, ev.reason);
}
function compactBoundaryText(ev: { trigger: "auto" | "manual"; preTokens?: number }): string {
  const trigger = ev.trigger === "auto" ? l10n.t("auto") : l10n.t("manual");
  const from = typeof ev.preTokens === "number" ? l10n.t(", from {0} tokens", ev.preTokens.toLocaleString(uiLocale())) : "";
  return l10n.t("── Context compacted ({0}{1}) ──", trigger, from);
}
const APPROVAL_REF_SUFFIX = l10n.t(" (respond in the Conversation tab)");

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

export interface ConvEventPrependResult extends ConvPrependResult {
  skipped: number;
  continued: number;
}

export type ViewMode = "conv" | "work";

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

function buildSegParts(seg: HTMLElement): { committed: HTMLElement; tail: HTMLElement } {
  seg.textContent = "";
  const committed = document.createElement("div");
  committed.className = "seg-committed";
  const tail = document.createElement("div");
  tail.className = "seg-tail";
  seg.append(committed, tail);
  return { committed, tail };
}

const TOOL_STATUS_GLYPH: Record<WorkRowData["status"], string> = { running: "", done: "✓", failed: "✗", stale: "⏸" };
function setTextIfChanged(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
const WORK_VIEW_AT_BOTTOM_INITIAL: Record<WorkViewMode, boolean> = { summary: false, graph: false, analysis: false, log: true };

export let onTabActivity: ((tabId: string, active: boolean) => void) | undefined;
export function setOnTabActivity(fn: typeof onTabActivity): void {
  onTabActivity = fn;
}

export let onConvViewShown: ((tabId: string) => void) | undefined;
export function setOnConvViewShown(fn: typeof onConvViewShown): void {
  onConvViewShown = fn;
}

const ASK_MESSAGE_STATE_MAX = 500;

export class Tab {
  private youStoreValue?: ReturnType<typeof createYouItems>;
  private get youStore(): ReturnType<typeof createYouItems> {
    if (this.youStoreValue === undefined) {
      const state = vscode.getState();
      this.youStoreValue = createYouItems(this.tabId,
        { tab: state?.askDismissed?.[this.tabId] ?? [], messages: state?.askDismissedMessages ?? [],
          resolvedTab: state?.askResolved?.[this.tabId] ?? [], resolvedMessages: state?.askResolvedMessages ?? [] },
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
  private askResolutionBatchDepth = 0;
  private withAskResolutionBatch<T extends { failed: number }>(work: () => T): T {
    this.askResolutionBatchDepth++;
    let result: T | undefined;
    try {
      result = work();
      return result;
    } finally {
      this.askResolutionBatchDepth--;
      if (result !== undefined && result.failed === 0 && this.askResolutionBatchDepth === 0) this.persistAskResolutions();
    }
  }
  private persistAskResolutions(): void {
    if (this.askResolutionBatchDepth > 0) return;
    const records = this.youStore.resolutionRecords?.() ?? [];
    if (records.length === 0) return;
    const state = vscode.getState() ?? { activeTabId: null };
    const decode = (entry: string): AskResolutionRecord | undefined => {
      try {
        const value = JSON.parse(entry) as { m?: unknown; c?: unknown; r?: unknown; t?: unknown };
        if (typeof value.c !== "string" || (value.m !== undefined && typeof value.m !== "string") ||
          (value.r !== "replied" && value.r !== "superseded") || typeof value.t !== "number") return undefined;
        return { identity: { content: value.c, ...(typeof value.m === "string" ? { message: value.m } : {}) },
          resolution: value.r, at: value.t };
      } catch { return undefined; }
    };
    const merge = (old: readonly string[], updates: readonly AskResolutionRecord[]): string[] => {
      const entries = new Map<string, string>();
      for (const encoded of old) {
        const record = decode(encoded);
        if (record) entries.set(record.identity.message ?? `content:${record.identity.content}`, encoded);
      }
      for (const record of updates) {
        if (record.identity.message) entries.delete(`content:${record.identity.content}`);
        entries.set(record.identity.message ?? `content:${record.identity.content}`, encodeAskResolution(record));
      }
      return [...entries.values()].slice(-ASK_MESSAGE_STATE_MAX);
    };
    const askResolved = { ...state.askResolved };
    askResolved[this.tabId] = merge(askResolved[this.tabId] ?? [], records);
    const askResolvedMessages = merge(state.askResolvedMessages ?? [], records.filter(record => record.identity.message !== undefined));
    vscode.setState({ ...state, askResolved, askResolvedMessages });
  }
  get youItems(): YouItemsReader { return this.youStore.reader; }
  private askReplyEvents = new Map<string, NormalizedEvent>();
  private askRenderEnds = new WeakMap<HTMLElement, number>();
  private askReplyParts = new Map<string, number>();
  private askCountersScheduled = false;

  private observeYouEvent(ev: NormalizedEvent): void {
    this.youStore.observe(ev);
    if (ev.kind === "user_message" || (ev.kind === "replayed_message" && ev.role === "user")) this.persistAskResolutions();
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
        const id = this.youStore.ask(ask, { replyId, offset: position, createdAt: at ?? event?.timestamp ?? 0, order: order ?? event?.seq, generation: generation ?? event?.generation });
        return id;
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
    if (ids.size > 0) this.persistAskResolutions();
    if ((hadAsks || ids.size > 0) && !this.askCountersScheduled) {
      this.askCountersScheduled = true;
      queueMicrotask(() => { this.askCountersScheduled = false; updateAskCounters(this.convEl); });
    }
  }

  readonly planPanel: PlanPanel;
  readonly summaryYou: YouList;
  private readonly chatYou: YouList;
  readonly logEl: HTMLElement;
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
  private handoffStatusSubEl!: HTMLElement;
  private handoffCancelEl!: HTMLButtonElement;
  private handoffDismissEl: HTMLButtonElement | null = null;
  private handoffPlayfulEl: HTMLElement | null = null;
  private handoffPlayfulDeck: string[] = [];
  private handoffPlayfulLast: string | null = null;
  private handoffQuietTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffRunId: string | null = null;
  private readonly handoffEndedRunIds = new Set<string>();
  private readonly handoffCardRunIds = new Set<string>();
  private restoredHandoffCard: HTMLElement | undefined;
  handoffSource?: HandoffSourceSnapshot;
  private readonly handoffCardEls = new Map<string, HTMLElement>();
  private readonly handoffExpectedPart = new Map<string, number>();
  private readonly handoffDetailRequested = new Set<string>();
  private handoffClearTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffCancelledNotice = false;
  private convCursorEl: HTMLElement | null = null;
  viewMode: ViewMode = "conv";
  private scrollPos: Record<ViewMode, number> = { conv: 0, work: 0 };
  private workViewScrollPos: Record<WorkViewMode, number> = { summary: 0, graph: 0, analysis: 0, log: 0 };
  private workViewAtBottom: Record<WorkViewMode, boolean> = { ...WORK_VIEW_AT_BOTTOM_INITIAL };
  private workView: WorkViewMode = "summary";
  get workViewMode(): WorkViewMode { return this.workView; }
  private workViewReturnRow: HTMLElement | null = null;
  private lastHumanHeadline: string | null = null;
  private pendingHeadlineAnchor: HTMLElement | null = null;
  private pastPendingAnchor: HTMLElement | null = null;
  private pastPendingChunk = 0;
  private pastPendingFirst = false;
  private pastChunkTurnSeen = false;
  private pastHeadline: { text: string; turnId: string | null; chunk: number | null } | null = null;
  private pastChunkSerial = 0;
  private atBottom: Record<ViewMode, boolean> = { conv: true, work: true };
  private graphHold = false;
  private unappliedCarry: ScrollCarry | undefined;
  private scrollRestored = false;
  private carryAnchor: Partial<Record<ViewMode, RowAnchor>> = {};
  private carryAwaitsConvBackfill = false;
  private knownAnchor: Partial<Record<ViewMode, RowAnchor>> = {};
  private anchorMeasuredTop: number | undefined;
  private preservedScroll: { mode: ViewMode; top: number } | undefined;
  private awaitedConvAnchor: RowAnchor | undefined;
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

  showHandoffStatus(msg: HandoffStatusMessage): void {
    if (msg.state === "done" && msg.fork?.tabId === this.tabId && !this.handoffCardRunIds.has(msg.runId)) {
      this.handoffCardRunIds.add(msg.runId);
      this.restoredHandoffCard?.remove();
      this.restoredHandoffCard = undefined;
      this.handoffCardEls.set(msg.runId, this.renderHandoffCard({ ...msg, runId: msg.runId }));
    }
    if (msg.state === "done") {
      const cell = this.handoffCardEls.get(msg.runId)?.querySelector<HTMLElement>(".handoff-context");
      if (cell) renderHandoffContext(cell, msg.contextUsage);
    }
    if (this.handoffEndedRunIds.has(msg.runId)) return;
    if (this.handoffRunId !== null && this.handoffRunId !== msg.runId) return;
    const cancelled = msg.state === "failed" && msg.reason === "cancelled";
    if (cancelled && this.handoffRunId !== msg.runId) {
      this.noteHandoffEnded(msg.runId);
      return;
    }
    if (msg.state === "done") {
      this.noteHandoffEnded(msg.runId);
      if (this.handoffRunId === msg.runId) {
        if (msg.fork !== undefined && msg.fork.tabId !== this.tabId) this.showHandoffDoneNotice(msg.fork);
        else this.clearHandoffStatus();
      }
      return;
    }
    if (this.handoffClearTimer !== null) {
      clearTimeout(this.handoffClearTimer);
      this.handoffClearTimer = null;
    }
    const terminal = msg.state === "failed";
    const failed = terminal && !cancelled;
    this.handoffCancelledNotice = cancelled;
    this.handoffRunId = terminal ? null : msg.runId;
    this.setHandoffStatusKind(failed ? "failed" : cancelled ? "cancelled" : "running");
    this.handoffStatusEl.setAttribute("role", failed ? "alert" : "status");
    this.handoffStatusIconEl.replaceChildren(terminal ? document.createTextNode(failed ? "✗" : "◼") : createLoader());
    if (failed) {
      const detail = typeof msg.detail === "string" && msg.detail.length > 0
        ? l10n.t("Reason: {0}", msg.detail)
        : "";
      this.writeHandoffStatusText(l10n.t("Handoff failed"), handoffFailureMessage(msg.reason));
      for (const line of [detail, l10n.t("The original conversation was not changed")]) {
        if (line.length > 0) this.handoffStatusSubEl.appendChild(handoffNode("div", "", line));
      }
      const failureDismiss = this.attachHandoffDismiss();
      failureDismiss.onclick = () => this.clearHandoffStatus();
    } else if (cancelled) {
      this.writeHandoffStatusText(l10n.t("Cancelled"), l10n.t("The original conversation was not changed"));
      const dismiss = this.attachHandoffDismiss();
      dismiss.onclick = () => this.clearCancelledHandoffNotice();
    } else {
      this.handoffStatusTextEl.textContent = handoffRunningText(msg);
    }
    this.handoffCancelEl.classList.toggle("hidden", terminal);
    this.handoffCancelEl.onclick = terminal
      ? null
      : () => vscode.postMessage({ type: "cancelHandoff", tabId: this.tabId, runId: msg.runId });
    this.handoffStatusEl.classList.remove("hidden");
    if (!terminal && msg.phase === "compacting" && (msg.progress?.heartbeats ?? 0) > 0) {
      this.showHandoffPlayful(this.nextHandoffPlayful(), true);
      this.armHandoffQuiet();
    } else if (!terminal) {
      this.endHandoffPlayful();
    }
    if (failed) {
      this.endHandoffPlayful();
      this.noteHandoffEnded(msg.runId);
      this.handoffClearTimer = setTimeout(() => this.clearHandoffStatus(), HANDOFF_FAILURE_VISIBLE_MS);
      this.flagConvAttention();
    }
    if (cancelled) {
      this.endHandoffPlayful();
      this.noteHandoffEnded(msg.runId);
      this.handoffClearTimer = setTimeout(() => this.clearCancelledHandoffNotice(), HANDOFF_CANCEL_VISIBLE_MS);
    }
  }

  private setHandoffStatusKind(kind: "running" | "failed" | "cancelled" | "done" | null): void {
    for (const name of ["failed", "cancelled", "done"] as const) this.handoffStatusEl.classList.toggle(name, kind === name);
    this.handoffStatusEl.classList.toggle("terminal", kind !== "running" && kind !== null);
    this.handoffDismissEl?.remove();
    this.handoffDismissEl = null;
    this.handoffStatusSubEl.textContent = "";
  }

  private writeHandoffStatusText(word: string, rest: string, ...after: Node[]): void {
    this.handoffStatusTextEl.textContent = "";
    this.handoffStatusTextEl.append(handoffNode("b", "", word), document.createTextNode(` · ${rest}`), ...after);
  }

  private attachHandoffDismiss(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "handoff-status-dismiss";
    button.textContent = l10n.t("Close");
    button.setAttribute("aria-label", l10n.t("Close"));
    this.handoffStatusEl.insertBefore(button, this.handoffStatusIconEl);
    this.handoffDismissEl = button;
    return button;
  }

  private showHandoffDoneNotice(fork: { tabId: string; title: string }): void {
    if (this.handoffClearTimer !== null) {
      clearTimeout(this.handoffClearTimer);
      this.handoffClearTimer = null;
    }
    this.handoffRunId = null;
    this.endHandoffPlayful();
    this.handoffCancelledNotice = true;
    this.setHandoffStatusKind("done");
    this.handoffStatusEl.setAttribute("role", "status");
    this.handoffStatusIconEl.replaceChildren(document.createTextNode("✓"));
    const open = handoffNode("button", "handoff-status-link", l10n.t("Open new tab ›")) as HTMLButtonElement;
    open.type = "button";
    open.onclick = () => setActiveTab(fork.tabId);
    this.writeHandoffStatusText(l10n.t("Handed off"), l10n.t("New tab \"{0}\"", fork.title), document.createTextNode(" "), open);
    this.handoffCancelEl.classList.add("hidden");
    this.handoffCancelEl.onclick = null;
    this.handoffStatusEl.classList.remove("hidden");
    this.handoffClearTimer = setTimeout(() => this.clearCancelledHandoffNotice(), HANDOFF_CANCEL_VISIBLE_MS);
  }

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

  showHandoffDetail(msg: HandoffDetailMessage): void {
    const card = this.handoffCardEls.get(msg.runId);
    if (card === undefined) return;
    if (msg.part !== (this.handoffExpectedPart.get(msg.runId) ?? 0)) return;
    const retry = (): void => this.retryHandoffDetail(msg.runId, card);
    if (msg.total === 0) {
      for (const body of Array.from(card.querySelectorAll<HTMLElement>(".handoff-detail-body"))) setHandoffDetailFailed(body, retry);
      this.handoffDetailRequested.delete(msg.runId);
      return;
    }
    const summaryBody = detailBodyOf(card, "summary");
    const messagesBody = detailBodyOf(card, "messages");
    if (msg.part === 0) {
      if (summaryBody !== null) {
        if (msg.summary === undefined) setHandoffDetailFailed(summaryBody, retry);
        else fillHandoffDetail(summaryBody, handoffNode("pre", "handoff-summary-text", msg.summary));
      }
      if (messagesBody !== null) fillHandoffDetail(messagesBody, handoffNode("div", "handoff-utts"));
    }
    if (msg.decisions !== undefined) {
      const decisions = msg.decisions;
      this.ensureHandoffDecisionsRow(card, msg.runId);
      renderDecisionCounts(card, {
        total: decisions.entries.length,
        carried: decisions.carried,
        extracted: decisions.extracted,
        removed: decisions.removed,
        unknownIdRefs: decisions.unknownIdRefs,
        ...(decisions.warn !== undefined ? { warn: decisions.warn } : {}),
      });
      const removed = decisions.removedLastGen ?? [];
      const decisionsBody = detailBodyOf(card, "decisions");
      if (decisionsBody !== null) fillHandoffDetail(decisionsBody, ...buildHandoffDecisionRows(decisions.entries, removed));
    }
    const list = messagesBody?.querySelector<HTMLElement>(".handoff-utts");
    for (const u of msg.utterances) list?.appendChild(buildHandoffUtterance(u));
    this.handoffExpectedPart.set(msg.runId, msg.part + 1);
    if (msg.part + 1 < msg.total) {
      vscode.postMessage({ type: "getHandoffDetail", tabId: this.tabId, runId: msg.runId, part: msg.part + 1 });
    }
  }

  private requestHandoffDetail(runId: string, card: HTMLElement, refresh = false): void {
    if (this.handoffDetailRequested.has(runId)) return;
    this.handoffDetailRequested.add(runId);
    for (const body of Array.from(card.querySelectorAll<HTMLElement>(".handoff-detail-body"))) {
      if (body.dataset.state !== "ready") setHandoffDetailLoading(body);
    }
    vscode.postMessage({ type: "getHandoffDetail", tabId: this.tabId, runId, part: 0, ...(refresh ? { refresh: true as const } : {}) });
  }

  private retryHandoffDetail(runId: string, card: HTMLElement): void {
    this.handoffDetailRequested.delete(runId);
    this.handoffExpectedPart.set(runId, 0);
    for (const body of Array.from(card.querySelectorAll<HTMLElement>(".handoff-detail-body"))) body.dataset.state = "stale";
    this.requestHandoffDetail(runId, card, true);
  }

  private buildHandoffDetailRow(card: HTMLElement, runId: string | undefined, code: string, text: string, kind: HandoffDetailKind): HandoffRowParts {
    const parts = buildHandoffRow(code, text, kind, runId === undefined ? undefined : kind);
    if (runId !== undefined) {
      const row = parts.row as HTMLDetailsElement;
      row.addEventListener("toggle", () => {
        if (row.open) this.requestHandoffDetail(runId, card);
      });
    }
    return parts;
  }

  private ensureHandoffDecisionsRow(card: HTMLElement, runId: string): void {
    if (card.querySelector(".handoff-row-decisions") !== null) return;
    const parts = this.buildHandoffDetailRow(card, runId, "DECISIONS", l10n.t("Decision lines"), "decisions");
    parts.warns.className = "handoff-row-warns handoff-decisions-lines";
    const summary = card.querySelector<HTMLElement>(".handoff-row-summary");
    const rows = card.querySelector<HTMLElement>(".handoff-rows");
    if (summary !== null && summary.parentNode !== null) summary.parentNode.insertBefore(parts.row, summary);
    else rows?.appendChild(parts.row);
  }

  private noteHandoffEnded(runId: string): void {
    if (this.handoffEndedRunIds.size < HANDOFF_RUN_MEMORY) this.handoffEndedRunIds.add(runId);
  }

  clearCancelledHandoffNotice(): void {
    if (this.handoffCancelledNotice) this.clearHandoffStatus();
  }

  private clearHandoffStatus(): void {
    if (this.handoffClearTimer !== null) {
      clearTimeout(this.handoffClearTimer);
      this.handoffClearTimer = null;
    }
    this.endHandoffPlayful();
    this.handoffRunId = null;
    this.handoffCancelledNotice = false;
    this.setHandoffStatusKind(null);
    this.handoffStatusIconEl.replaceChildren();
    this.handoffCancelEl.onclick = null;
    this.handoffStatusTextEl.textContent = "";
    this.handoffStatusEl.classList.add("hidden");
  }

  applyHandoffSource(source: HandoffSourceSnapshot): void {
    this.handoffSource = source;
    if (this.handoffCardRunIds.size > 0 || this.restoredHandoffCard) return;
    const card = this.renderHandoffCard({
      source: { sessionId: source.sessionId, title: source.title },
      compact: source.compact,
      contextUsage: source.contextUsage,
      utteranceCount: source.utteranceCount,
      ...(source.unreadableLineCount !== undefined ? { unreadableLineCount: source.unreadableLineCount } : {}),
      ...(source.decisions !== undefined ? { decisions: source.decisions } : {}),
      ...(source.decisionCount !== undefined ? { decisionCount: source.decisionCount } : {}),
      ...(source.detailRunId !== undefined ? { runId: source.detailRunId } : {}),
    });
    this.restoredHandoffCard = card;
    if (source.detailRunId !== undefined) this.handoffCardEls.set(source.detailRunId, card);
  }

  private buildHandoffSourceLink(source: { sessionId: string; title?: string }): HTMLElement {
    const linkBtn = document.createElement("button");
    linkBtn.type = "button";
    linkBtn.className = "handoff-source-link";
    linkBtn.textContent = l10n.t("Open previous conversation ›");
    linkBtn.setAttribute("aria-label", source.title ? l10n.t("Open previous conversation: {0}", source.title) : l10n.t("Open previous conversation"));
    linkBtn.onclick = (e) => {
      e.preventDefault();
      const existing = findTabBySessionId(source.sessionId);
      if (existing) {
        setActiveTab(existing.tabId);
        return;
      }
      vscode.postMessage({
        type: "openHandoffSource",
        tabId: this.tabId,
        sourceSessionId: source.sessionId,
      });
    };
    return linkBtn;
  }

  private renderHandoffCard(msg: HandoffCardInput): HTMLElement {
    const card = document.createElement("section");
    card.className = "block handoff-card";
    card.setAttribute("aria-label", l10n.t("Handoff"));
    const label = handoffNode("div", "handoff-label", handoffNode("b", "", "HANDOFF"), handoffNode("span", "", l10n.t("Previous conversation")));
    card.appendChild(label);
    const link = msg.source.sessionId ? this.buildHandoffSourceLink(msg.source) : null;
    if (msg.source.title) card.appendChild(handoffNode("div", "handoff-head", handoffNode("h3", "handoff-title", msg.source.title), link));
    else if (link !== null) label.appendChild(link);
    card.appendChild(handoffNode("p", "handoff-lede", l10n.t("Your first message starts from this context")));
    const rows = handoffNode("div", "handoff-rows");
    card.appendChild(rows);

    const context = buildHandoffRow("CONTEXT", l10n.t("Context size"), "context");
    context.num.className = "handoff-row-num handoff-context";
    renderHandoffContext(context.num, msg.contextUsage);
    if (msg.compact?.retainedResponseCount !== undefined) {
      context.warns.appendChild(handoffWarn(l10n.t("⚠ {0} earlier response groups remain in context", msg.compact.retainedResponseCount)));
    }
    rows.appendChild(context.row);

    const runId = msg.runId;
    const messages = this.buildHandoffDetailRow(card, runId, "MESSAGES", l10n.t("Your messages (verbatim)"), "messages");
    renderHandoffCount(messages.num, msg.utteranceCount ?? 0);
    if (msg.unreadableLineCount !== undefined) {
      messages.warns.appendChild(handoffWarn(l10n.t(
        "⚠ {0} lines of the record could not be read; messages on those lines may be missing from the attachment",
        msg.unreadableLineCount
      )));
    }
    rows.appendChild(messages.row);

    const lines = msg.decisions !== undefined ? msg.decisions.total + msg.decisions.removed : msg.decisionCount ?? 0;
    if (lines > 0 || (msg.decisions !== undefined && decisionWarnings(msg.decisions).length > 0)) {
      const decisionsRow = this.buildHandoffDetailRow(card, runId, "DECISIONS", l10n.t("Decision lines"), "decisions");
      decisionsRow.warns.className = "handoff-row-warns handoff-decisions-lines";
      rows.appendChild(decisionsRow.row);
      if (msg.decisions !== undefined) renderDecisionCounts(card, msg.decisions);
    }

    if (runId !== undefined) {
      const summary = this.buildHandoffDetailRow(card, runId, "SUMMARY", l10n.t("Handoff summary"), "summary");
      summary.row.title = l10n.t("Show summary");
      rows.appendChild(summary.row);
    }
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
    return resolveModelDisplayName(this.models, model) ?? l10n.t("Unknown");
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
      : ev.autoRevert === "off" ? l10n.t("Automatic restore is off; restore {0} from {1}.", original, userLabel())
        : undefined;
  }

  private fallbackRevertText(ev: Extract<NormalizedEvent, { kind: "model_fallback_revert" }>): string {
    const original = this.modelLabel(ev.originalModel);
    return ev.outcome === "applied" ? l10n.t("Restored the original model {0} automatically.", original)
      : ev.outcome === "deferred" ? l10n.t("The conversation will start on the original model {0} next time.", original)
        : ev.outcome === "failed" ? l10n.t("Could not restore the original model {0} automatically; restore it from {1}.", original, userLabel())
          : l10n.t("Your model selection replaced the fallback model.");
  }

  private fallbackLogText(ev: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): string {
    const status = this.fallbackStatusText(ev);
    return status === undefined ? this.fallbackText(ev) : `${this.fallbackText(ev)} ${status}`;
  }

  private decorateFallbackBlock(block: HTMLElement, ev: Extract<NormalizedEvent, { kind: "model_refusal_fallback" }>): void {
    block.id = youAnchor(this.tabId, `fallback:${ev.generation}:${ev.seq}`);
    if (ev.explanation) {
      const summary = document.createElement("p");
      summary.className = "you-summary";
      summary.textContent = ev.explanation;
      block.append(summary);
    }
    if (this.fallbackStatusText(ev) !== undefined) {
      const status = document.createElement("p");
      status.className = "fallback-status";
      block.append(this.bindModelText(status, () => this.fallbackStatusText(ev) ?? ""));
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
    this.setModelFallback(resolveFallbackByChoice(this.modelFallback, model, Date.now(), this.models));
    if (model) this.youStore.appliedModel(model, Date.now(), this.models);
  }

  private restoreFallbackModel(model: string): void {
    vscode.postMessage({ type: "setModel", tabId: this.tabId, model, sessionOnly: true });
  }

  recordedModel: string | undefined;
  permissionMode: PermissionModeId = "default";
  commands: SlashCommandInfo[] = [];
  models: ModelInfo[] = [];
  private readonly modelTexts = new WeakMap<HTMLElement, { span: HTMLElement; text: () => string }>();
  private readonly modelTextRefs = new Set<WeakRef<HTMLElement>>();
  private readonly unsubscribeUserLabel = onUserLabelChange(() => {
    this.refreshModelTexts();
    if (this.tabId === activeTabId) refreshFind();
  });
  modelOverride: string | null | undefined = undefined;
  effortOverride: string | null | undefined = undefined;
  turnState: "idle" | "running" | "interrupting" = "idle";
  usage: UsageSnapshot | null = null;
  contextUsage: Extract<NormalizedEvent, { kind: "context_usage" }> | null = null;
  currentTurnId: string | null = null;
  private readonly knownTurnIds = new Set<string>();
  private readonly adoptedTurnIds = new Set<string>();
  private replayDone = false;
  pendingSend = false;
  private currentAssistantBlock: HTMLElement | null = null;
  private assistantBuffer = "";
  private liveRecordOpen = false;
  private replyFinished = false;
  private convBlockAfterRecordIn: HTMLElement | null = null;
  private replyFooterAnchor: HTMLElement | null = null;
  private readonly suspendedReplies = new Map<string, ReturnType<Tab["captureReply"]>>();
  private retryBlock: HTMLElement | null = null;

  private clearRetryBlock(): void {
    this.retryBlock?.remove();
    this.retryBlock = null;
  }
  private pendingDeltaText = "";
  private rafScheduled = false;
  private pendingDeltaTurnId: string | null = null;
  private currentSegTurnId: string | null = null;
  private topConvSeg: { turnId: string; el: HTMLElement; text: string; records: RecordTextPart[] } | null = null;
  private toolCards = new Map<string, HTMLElement>();
  private segmentCards = new Map<string, SegmentCard>();
  private replayMarkerShown = false;
  private lastObservedModel: string | null = null;
  private replayMarkerEl: HTMLElement | null = null;
  private convHistoryEl: HTMLElement | null = null;
  private convHistoryBodyEl: HTMLElement | null = null;
  private convMessageUuids = new Set<string>();
  private convPrependedTotal = 0;
  private renderedConvEventKeys = new Set<string>();
  private pastConvTurns = new Map<string, { el: HTMLElement; text: string }>();
  private pastConvRecords = new Map<string, RecordTextPart[]>();
  private assistantLeadingRecord: { turnId: string; uuid: string } | null = null;
  private pastConvFooters = new Map<string, HTMLElement>();
  private pastTurnCompletedAt = new Map<string, number>();
  private lastPastModel: string | null = null;
  private workReplayMarkerShown = false;
  private todoCardEl: HTMLDetailsElement | null = null;
  private todoSummaryEl: HTMLElement | null = null;
  private todoListEl: HTMLElement | null = null;
  private todoWork = new Map<string, HTMLElement>();
  private todoRowOpen = new Map<string, boolean>();
  private nonWorkToolUseIds = new Set<string>();
  private toolStartTimes = new Map<string, number>();
  private agentCards = new Map<string, AgentCardEntry>();
  private rowData = new Map<string, WorkRowData>();
  private bgTaskIdToToolUseId = new Map<string, string>();
  private workRevision = 0;
  private segmentTotals = new Map<string, WorkSegmentView>();
  private pastSegmentTotals = new Map<string, WorkSegmentView>();
  private pastAgentStates = new Map<string, WorkAgentStateView>();
  private taskTotals = new Map<string, WorkTaskTotalsView>();
  private agentStates = new Map<string, WorkAgentStateView>();
  private taskItems: WorkTaskItemView[] = [];
  private pendingApprovalCount = 0;
  private approvalCards = new Map<string, HTMLElement>();
  private approvalRefs = new Map<string, HTMLElement>();
  private missingWorkInfoReported = false;
  private pastRender: PastRenderContext | null = null;
  private historyHeadEl: HTMLElement | null = null;
  private historyMoreEl: HTMLElement | null = null;
  private historyBodyEl: HTMLElement | null = null;
  private renderedEventKeys = new Set<string>();
  private orphanFinishes = new Map<string, Extract<NormalizedEvent, { kind: "tool_call_finished" }>>();
  private orphanSubagentInfo = new Map<string, Extract<NormalizedEvent, { kind: "subagent_info" }>>();
  private orphanApprovalResolved = new Map<
    string,
    Extract<NormalizedEvent, { kind: "approval_resolved" }>
  >();
  private orphanStaled = new Set<string>();
  private pastRenderedTotal = 0;

  private runningChildTools = new Map<string, { name: string; parentId: string }>();
  private activity: BackgroundActivityState = createBackgroundActivityState();
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
    this.chatYou = new YouList(this.youItems, item => this.navigateToYou(item), count => {
      this.planPanel.setWaiting(count);
      this.openYouCount = count;
      if (this.tabBtn !== undefined) this.updateStrip();
    }, item => this.dismissYou(item), model => this.restoreFallbackModel(model));
    this.summaryYou = new YouList(this.youItems, item => this.navigateToYou(item), undefined, item => this.dismissYou(item), model => this.restoreFallbackModel(model));
    this.planPanel.you.append(this.chatYou.element);
    this.logEl.appendChild(content);
    logsEl.appendChild(this.logEl);
    this.observeTurnRails();

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
    this.unsubscribeUserLabel();
    this.clearHandoffStatus();
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
    this.syncViewNavHeight();
    this.syncLogHeadHeight();
  }

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
    if (this.tabBtn !== undefined) this.updateStrip();
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
    this.handoffStatusSubEl = document.createElement("div");
    this.handoffStatusSubEl.className = "handoff-status-sub";
    this.handoffStatusLinesEl.append(this.handoffStatusTextEl, this.handoffStatusSubEl);
    this.handoffCancelEl = document.createElement("button");
    this.handoffCancelEl.type = "button";
    this.handoffCancelEl.className = "handoff-status-cancel";
    this.handoffCancelEl.textContent = l10n.t("Cancel");
    wrap.append(this.handoffStatusLinesEl, this.handoffCancelEl, this.handoffStatusIconEl);
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
    wrap.append(this.convLoadTextEl, this.convLoadBarEl, this.convLoadRetryEl, this.convLoadIconEl);
    this.convLoadEl = wrap;
    return wrap;
  }

  setConvLoadProgress(state: LoadProgressState | { phase: "done" }): void {
    this.convLoadState = state.phase === "done" ? null : state;
    this.renderLoadSlot();
    if (this.tabId === activeTabId) refreshFindCount();
  }

  convHistoryLoadState(): "loading" | "failed" | null {
    const state = this.convLoadState;
    if (state === null) return null;
    return state.phase === "failed" ? "failed" : "loading";
  }

  setWorkLoadProgress(state: LoadProgressState | { phase: "done" }): void {
    this.workLoadState = state.phase === "done" ? null : state;
    this.renderLoadSlot();
  }

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
      this.convLoadIconEl.replaceChildren(createLoader());
      this.convLoadTextEl.textContent = l10n.t("Preparing history");
      this.convLoadEl.removeAttribute("title");
      this.convLoadRetryEl.onclick = null;
    } else if (state.phase === "loading") {
      this.convLoadIconEl.replaceChildren(createLoader());
      this.convLoadTextEl.textContent = l10n.t("Loading history · {0} remaining", state.remaining);
      this.convLoadFillEl.style.width = `${Math.round(state.ratio * 100)}%`;
      this.convLoadEl.removeAttribute("title");
      this.convLoadRetryEl.onclick = null;
    } else {
      this.convLoadIconEl.textContent = "✕";
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

  switchWorkViewScroll(prev: WorkViewMode, next: WorkViewMode): () => void {
    const visible = activeTabId === this.tabId && this.viewMode === "work";
    const heldPrev = this.holdsWorkScroll();
    this.workView = next;
    const heldNext = this.holdsWorkScroll();
    if (visible) {
      const gap = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight;
      this.workViewScrollPos[prev] = logsEl.scrollTop;
      this.workViewAtBottom[prev] = gap <= SCROLL_BOTTOM_GAP_PX && !heldPrev;
      if (prev === "log") this.workViewReturnRow = this.topVisibleToolRow();
    } else {
      this.workViewScrollPos[prev] = this.scrollPos.work;
      this.workViewAtBottom[prev] = this.atBottom.work;
    }
    return () => {
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

  scrollToPreviousUserBlock(): void {
    if (this.viewMode !== "conv") this.setViewMode("conv");
    const blocks = Array.from(this.convEl.querySelectorAll<HTMLElement>(".block.user"));
    if (blocks.length === 0) return;
    let index: number;
    if (this.convCursorEl !== null && this.convCursorEl.isConnected) {
      index = blocks.indexOf(this.convCursorEl) - 1;
    } else {
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
    this.atBottom[this.viewMode] = true;
    this.scrollToBottom(this.viewMode, true);
  }

  private flagConvAttention(): void {
    if (this.viewMode === "conv") return;
    this.viewTabs.chat?.classList.add("needs-attention");
  }

  private clearConvAttention(): void {
    this.viewTabs.chat?.classList.remove("needs-attention");
  }

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

  updateStrip(now = Date.now()): void {
    this.syncTabDot();
    const runningTool = [...this.runningMainTools.values()].at(-1);
    const line = deriveStatusLine({
      now,
      autoResumeAt: this.autoResumeAt,
      turnState: this.turnState,
      turnStartedAt: this.stripStartedAt,
      runningTool: runningTool?.name ?? null,
      intentInput: runningTool?.intentInput,
      runningDelegations: runningDelegationIds(this.activity),
      workModel: this.workModel,
      openYouCount: this.openYouCount,
      viewHasYouCount: this.viewMode === "conv" || this.workView === "summary",
      declared: this.taskItems.find(item => item.status === "in_progress")?.activeForm ?? null,
    });
    this.stripWrapEl.classList.toggle("hidden", line.kind === "none");
    this.stripSpinnerEl.hidden = line.kind === "waiting" || line.kind === "limit";
    const label = statusLineText(line);
    this.stripTextEl.textContent = truncateToolIntent(label);
    this.stripTextEl.title = label;
    this.planPanel.setStatus(truncateToolIntent(label));
    this.stripNoteEl.textContent = line.kind === "conductor" || line.kind === "delegated" ? line.declared ?? "" : "";
    this.stripSince = line.kind === "conductor" || line.kind === "delegated" ? line.since : null;
    this.updateStripElapsed();
    this.syncHeadLayout();
  }

  private isTabActive(): boolean {
    return (
      this.turnState !== "idle" ||
      liveBackgroundTasks(this.activity).length > 0 ||
      hasRunningDelegation(this.activity) ||
      this.runningChildTools.size > 0
    );
  }

  replaceBackgroundActivity(snap: BackgroundActivitySnapshot | undefined): void {
    if (snap === undefined) return;
    this.activity = backgroundActivityFromSnapshot(snap);
    this.updateStrip();
  }

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

  tickStrip(now = Date.now()): void {
    if ((this.viewMode === "work" && this.workView === "log") || this.logRunningLabels.size > 0) {
      for (const update of this.logRunningLabels.values()) update(now);
    }
    if (this.autoResumeAt !== null) this.updateStrip(now);
    else if (this.stripSince !== null) this.updateStripElapsed();
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
    if (role === "user") bindUserLabel(name);
    else if (model) this.bindModelName(name, model);
    label.appendChild(name);
    block.prepend(label);
  }

  addBlock(cls: string, text: string, markdown = false, target: ViewMode = "conv", model: string | null = null): HTMLElement {
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
    if (target === "conv" && cls.startsWith("user")) this.convCursorEl = null;
    this.scrollToBottom(target);
    if (target === "conv" && this.tabId === activeTabId) refreshFind();
    return div;
  }

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

  private holdsWorkScroll(): boolean {
    return this.workView === "graph" && this.graphHold;
  }

  isAtBottom(mode: ViewMode): boolean {
    return this.atBottom[mode];
  }

  noteScroll(): void {
    this.scrollPos[this.viewMode] = logsEl.scrollTop;
    if (this.preservedScroll?.mode === this.viewMode && logsEl.scrollTop === this.preservedScroll.top) return;
    this.preservedScroll = undefined;
    const gap = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight;
    this.atBottom[this.viewMode] = gap <= SCROLL_BOTTOM_GAP_PX && !(this.viewMode === "work" && this.holdsWorkScroll());
  }

  restoreScroll(): void {
    this.syncHeadLayout();
    this.placeSurface(this.viewMode);
    this.preservedScroll = this.atBottom[this.viewMode] ? undefined : { mode: this.viewMode, top: logsEl.scrollTop };
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
    logsEl.scrollTop = 0;
    this.scrollPos.conv = logsEl.scrollTop;
    this.knownAnchor.conv = anchor;
    if (this.carryAwaitsConvBackfill) this.awaitedConvAnchor = anchor;
  }

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
    this.preservedScroll = { mode, top: logsEl.scrollTop };
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
        const atBottom = this.preservedScroll?.mode === mode && scrollPos === this.preservedScroll.top ? this.atBottom[mode]
          : gap <= SCROLL_BOTTOM_GAP_PX && !(mode === "work" && this.holdsWorkScroll());
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
      if (this.anchorRowInDom("work", workAnchor) === null) this.placeWorkAtBottomForBackfill();
      else this.carryAnchor.work = workAnchor;
    }
    this.carryAwaitsConvBackfill = convBackfill;
    this.unappliedCarry = carry;
  }

  noteScrollAnchor(): void {
    if (this.unappliedCarry === undefined && activeTabId === this.tabId && this.scrollRestored) this.captureScrollCarry();
  }

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

  resetReplayArtifacts(): void {
    this.convCursorEl = null;
  }

  resetScrollPosition(): void {
    this.workViewScrollPos = { summary: 0, graph: 0, analysis: 0, log: 0 };
    this.workViewAtBottom = { ...WORK_VIEW_AT_BOTTOM_INITIAL };
    this.atBottom = { conv: true, work: this.workViewAtBottom[this.workView] };
    this.scrollPos = { conv: 0, work: 0 };
    if (activeTabId === this.tabId) logsEl.scrollTop = this.atBottom[this.viewMode] ? logsEl.scrollHeight : 0;
  }

  isWorklogAtBottom(): boolean {
    return this.workView === "log" ? this.atBottom.work : this.workViewAtBottom.log;
  }

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

  finalizeReplay(stillRunning: boolean): void {
    if (!stillRunning) this.endAssistantTurn();
  }

  private applyStaled(toolUseIds: readonly string[]): void {
    for (const toolUseId of toolUseIds) {
      this.logRunningLabels.delete(toolUseId);
      const data = this.rowData.get(toolUseId);
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

  private placeWork(el: HTMLElement, placement: WorkPlacementView, lastLabel: string): void {
    const toolUseId = el.dataset.toolUseId ?? "";
    if (placement.ownerToolUseId !== undefined) {
      const owner = this.agentCards.get(placement.ownerToolUseId);
      const ownerData = this.rowData.get(placement.ownerToolUseId);
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
      if (this.pastRender === null || container.isConnected) {
        this.insertWork(container, el);
        return;
      }
      this.insertWork(this.pastRender.frag, el);
      return;
    }
    const card = this.ensureSegmentCard(placement);
    if (!card) {
      if (this.pastRender !== null) this.insertWork(this.pastRender.frag, el);
      return;
    }
    this.insertWork(card.el, el);
    card.lastLabel = lastLabel;
    this.renderSegmentCard(card);
  }

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

  private buildRowDom(toolUseId: string): HTMLElement | null {
    const data = this.rowData.get(toolUseId);
    if (!data) return null;
    return data.kind === "agent" ? this.buildAgentCardDom(data).card : this.buildToolRowDom(data);
  }

  private ensureSegmentCard(placement: WorkPlacementView): SegmentCard | undefined {
    const segmentId = placement.segmentId;
    if (segmentId === undefined) return undefined;
    const existing = this.segmentCards.get(segmentId);
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

  private segCommittedEl: HTMLElement | null = null;
  private segTailEl: HTMLElement | null = null;
  private committedLen = 0;

  private assistantRuns: { uuid: string | null; text: string; seg: HTMLElement; complete?: true }[] = [];

  private liveReplyText: { turnId: string; text: string } | null = null;

  private latestReplyFooter: HTMLElement | null = null;

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
    if (ev.provenance?.path === "history") return;
    if (this.withSuspendedReply(ev.turnId, () => this.onAssistantMessageUuid(ev))) return;
    if (!this.replayDone && this.currentTurnId === null && this.assistantRuns.length === 0) {
      this.assistantLeadingRecord = { turnId: ev.turnId, uuid: ev.uuid };
      return;
    }
    if (ev.turnId !== this.currentTurnId) return;
    this.flushDelta();
    if (this.assistantRuns.length === 0) this.assistantLeadingRecord = { turnId: ev.turnId, uuid: ev.uuid };
    const last = this.assistantRuns.at(-1);
    if (!(last?.complete && last.uuid === ev.uuid)) {
      let i = this.assistantRuns.length - 1;
      // Only completed standalone records can intervene before a trailing UUID.
      while (i >= 0 && this.assistantRuns[i].complete) i--;
      for (; i >= 0; i--) {
        if (this.assistantRuns[i].uuid !== null || this.assistantRuns[i].complete) break;
        this.assistantRuns[i].uuid = ev.uuid;
      }
    }
    this.persistAskDismissals(this.youStore.relabel());
    this.persistAskResolutions();
    this.closeLiveRecord();
    this.liveRecordOpen = this.assistantRuns.some(run => run.uuid === null && !run.complete);
    if (this.replyFinished && !this.liveRecordOpen) this.endAssistantTurn();
  }

  private onAssistantRetracted(ev: Extract<NormalizedEvent, { kind: "assistant_retracted" }>, suspended = false): void {
    if (!suspended) {
      for (const turnId of this.suspendedReplies.keys()) {
        this.withSuspendedReply(turnId, () => this.onAssistantRetracted(ev, true));
      }
    }
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

  private endAssistantBlock(keepRecordOpen = false): void {
    this.flushDelta();
    if (this.currentAssistantBlock) {
      const text = this.assistantBuffer.trim();
      if (!text) {
        this.currentAssistantBlock.remove();
      } else {
        this.currentAssistantBlock.classList.remove("streaming");
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

  private endAssistantTurnBeforeConvBlock(): void {
    if (!this.liveRecordOpen) {
      this.endAssistantTurn();
      return;
    }
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

  private appendTurnAnchor(
    turnId: string,
    timestamp: number,
    headline: string | null,
    cliInserted = false
  ): HTMLElement {
    const anchor = this.buildTurnAnchor(turnId, timestamp, headline, false, cliInserted);
    this.workEl.appendChild(anchor);
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
    b.dataset.emptyLabel = cliInserted
      ? l10n.t("Started by Claude Code (not your message)")
      : l10n.t("Turn started");
    if (headline !== null) b.textContent = headline;
    const time = document.createElement("span");
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
    if (this.todoCardEl) this.todoCardEl.classList.toggle("wl-request-hidden", this.logTaskRequests.size > 0 &&
      [...this.logTaskRequests].every(turn => {
        const id = this.logTurnAliases.get(turn) ?? turn;
        return !!this.logRequests.get(id)?.anchor && !requestIsOpen(id, this.logLatestRequest, this.logFoldOverrides);
      }));
    this.logDirty.clear();
    this.syncWorkVisibility?.();
  }

  private static headlineOf(text: string): string {
    return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  }

  private static fillHeadline(anchor: HTMLElement, headline: string): void {
    const b = anchor.querySelector("b");
    if (b !== null && b.textContent === "") b.textContent = headline;
  }

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

  private takePastChunkTail(): void {
    const stash = this.pastHeadline;
    if (stash === null || stash.turnId !== null || stash.chunk !== this.pastChunkSerial) return;
    this.pastHeadline = null;
    const pending = this.pastPendingAnchor;
    if (pending === null || !this.pastPendingFirst || this.pastPendingChunk !== this.pastChunkSerial - 1) return;
    Tab.fillHeadline(pending, stash.text);
    this.pastPendingAnchor = null;
  }

  private static footerTime(at: number | undefined): HTMLElement | null {
    if (at === undefined || at <= 0) return null;
    const time = document.createElement("span");
    time.textContent = monthDayClock(at);
    return time;
  }

  private buildReplyFooter(at: number | undefined, source: () => string): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "reply-footer";
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

  private buildUserFoot(at: number | undefined, text: string): HTMLElement {
    const foot = document.createElement("div");
    foot.className = "msg-foot";
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
        this.addModelBlock(() => this.fallbackLogText(ev), "work");
        this.decorateFallbackBlock(this.addModelBlock(() => this.fallbackText(ev)), ev);
        if (activeTabId === this.tabId) refreshChrome();
        break;
      }
      case "model_fallback_revert":
        this.addModelBlock(() => this.fallbackRevertText(ev), "work");
        this.addModelBlock(() => this.fallbackRevertText(ev));
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
      case "local_command_output":
        if (isConvRenderableEvent(ev)) this.onLocalCommandOutput(ev);
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
      if (this.liveRecordOpen && ev.kind === "turn_completed") this.endAssistantBlock(true);
      else this.endAssistantTurn();
      if (ev.kind === "turn_completed") {
        this.appendLiveReplyFooter(ev);
        this.refreshLatestReplyFooter();
      }
    });
    if (finished) {
      this.applyWork(ev.work);
    }
    return finished;
  }

  private beginTurn(
    turnId: string,
    timestamp: number,
    cliInserted: boolean,
    work: WorkEventInfo | undefined
  ): void {
    this.pendingSend = false;
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
    const headline = cliInserted ? null : this.lastHumanHeadline;
    if (!cliInserted) this.lastHumanHeadline = null;
    this.appendTurnAnchor(turnId, timestamp, headline, cliInserted);
    this.applyWork(work);
    this.clearRetryBlock();
    this.runningChildTools.clear();
    this.runningMainTools.clear();
    this.stripStartedAt = timestamp > 0 ? timestamp : Date.now();
    this.setTurnState("running");
  }

  private onTurnStarted(ev: Extract<NormalizedEvent, { kind: "turn_started" }>): void {
    this.clearCancelledHandoffNotice();
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
  private autoResumeAt: number | null = null;

  replaceAutoResumeReservation(at: number | null): void {
    this.autoResumeAt = at;
    this.updateStrip();
  }

  private onAutoResume(ev: Extract<NormalizedEvent, { kind: "auto_resume" }>): void {
    this.autoResumeAt = ev.state === "pending" ? ev.at : null;
    this.updateStrip();
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
      this.retryBlock = this.addBlock("system warn", status, false, "work");
    }
  }

  private onAssistantTextDelta(ev: Extract<NormalizedEvent, { kind: "assistant_text_delta" }>): void {
    if (ev.provenance?.path === "history") return;
    if (this.withSuspendedReply(ev.turnId, () => {
      if (this.liveRecordOpen) this.onAssistantTextDelta(ev);
    })) return;
    if (ev.turnId !== this.currentTurnId && !this.adoptOrphanTurn(ev)) return;
    const recordUuid = ev.recordUuid;
    const pendingOrdinary = this.liveRecordOpen;
    if (recordUuid !== undefined) this.endAssistantBlock();
    if (ev.text.length > 0) this.liveRecordOpen = true;
    this.pendingDeltaText += ev.text;
    this.pendingDeltaTurnId = ev.turnId;
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      requestAnimationFrame(() => this.flushDelta());
    }
    if (recordUuid !== undefined) {
      this.flushDelta();
      const run = this.assistantRuns.at(-1);
      if (run !== undefined && run.seg === this.currentAssistantBlock) {
        run.uuid = recordUuid;
        run.complete = true;
      }
      this.endAssistantBlock();
      this.liveRecordOpen = pendingOrdinary;
    }
  }

  private adoptOrphanTurn(ev: Extract<NormalizedEvent, { kind: "assistant_text_delta" }>): boolean {
    if (this.knownTurnIds.has(ev.turnId)) return false;
    this.adoptedTurnIds.add(ev.turnId);
    this.beginTurn(ev.turnId, ev.timestamp, false, ev.work);
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
    this.scrollToBottom("conv");
  }

  private onLocalCommandOutput(ev: Extract<NormalizedEvent, { kind: "local_command_output" }>): void {
    if (ev.uuid && this.convMessageUuids.has(ev.uuid)) return;
    const block = this.addBlock("system", ev.text);
    if (ev.uuid) {
      block.dataset.msgUuid = ev.uuid;
      this.convMessageUuids.add(ev.uuid);
    }
    this.scrollToBottom("conv");
  }

  private onReplayedMessage(ev: Extract<NormalizedEvent, { kind: "replayed_message" }>): void {
    if (!this.replayMarkerShown) {
      this.replayMarkerShown = true;
      this.replayMarkerEl = this.addBlock("system", l10n.t("── Restored previous session ──"));
    }
    if (ev.restoredApproval) {
      if (ev.uuid && this.convMessageUuids.has(ev.uuid)) return;
      const card = buildRestoredApprovalCard(ev.restoredApproval, this.tabId);
      if (ev.uuid) {
        card.dataset.msgUuid = ev.uuid;
        this.convMessageUuids.add(ev.uuid);
      }
      this.convEl.append(card);
      return;
    }
    if (ev.role === "assistant" && ev.model) {
      this.lastObservedModel = this.observeModelSwitch(ev.model, this.lastObservedModel, (key) => this.addModelDivider(key));
    }
    const block =
      ev.role === "user"
        ? this.addBlock("user replayed", ev.text)
        : ev.role === "system" ? this.addBlock("system", ev.text)
        : this.addBlock("assistant replayed", ev.text, false, "conv", ev.model ?? null);
    if (ev.role === "assistant") {
      if (ev.uuid) this.recordReplyIds.add(ev.uuid);
      this.renderReplyMarkdown(block, ev.text, ev.uuid ?? `replay:${ev.generation}:${ev.seq}`, 0, ev.recordedAt ?? 0, ev.seq, ev.generation);
      this.prependTurnLabel(block, "assistant", ev.model ?? null);
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
    this.observeSessionTime(ev.recordedAt ?? ev.sentAt);
    if (ev.role === "user") this.appendUserFoot(block, ev.recordedAt ?? ev.sentAt ?? undefined, ev.text);
    else if (ev.role === "assistant") this.appendReplyFooter(ev.recordedAt, () => ev.text);
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

  private dropUnplacedEvent(kind: string): void {
    if (this.missingWorkInfoReported) return;
    this.missingWorkInfoReported = true;
    vscode.postMessage({
      type: "webviewDiagnostic",
      kind: "error",
      message: `work placement missing on ${kind}; detail row dropped (tab=${this.tabId})`,
    });
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
    if (!isHistory && ev.parentToolUseId === null) {
      if (!this.withSuspendedReply(ev.turnId, () => this.closeLiveRecord()) && ev.turnId === this.currentTurnId) this.closeLiveRecord();
    }
    if (isHistory && !this.workReplayMarkerShown) {
      this.workReplayMarkerShown = true;
      this.addBlock("system", l10n.t("── Restored previous session ──"), false, "work");
    }
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
    if (!placement) {
      this.nonWorkToolUseIds.add(ev.toolUseId);
      return;
    }

    if (!isHistory) {
      if (placement.ownerToolUseId !== undefined) {
        this.runningChildTools.set(ev.toolUseId, {
          name: ev.inputSummary ?? ev.toolName,
          parentId: placement.ownerToolUseId,
        });
      }
    }

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
    if (activityChanged || mainToolFinished) this.updateStrip();
    this.applyWork(ev.work);
    if (this.nonWorkToolUseIds.has(ev.toolUseId)) {
      this.nonWorkToolUseIds.delete(ev.toolUseId);
      this.toolStartTimes.delete(ev.toolUseId);
      return;
    }

    if (!this.applyToolFinishDom(ev)) this.rememberOrphanFinish(ev);
  }

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
    if (this.orphanStaled.delete(toolUseId)) this.applyStaled([toolUseId]);
  }

  private onSubagentInfo(ev: Extract<NormalizedEvent, { kind: "subagent_info" }>): void {
    this.applyWork(ev.work);
    if (ev.model === undefined) return;
    if (this.agentStates.get(ev.toolUseId)?.modelMeasured !== undefined) return;
    const entry = this.agentCards.get(ev.toolUseId);
    const data = this.rowData.get(ev.toolUseId);
    if (!entry || !data) {
      if (this.orphanSubagentInfo.size < ORPHAN_FINISH_MAX) {
        this.orphanSubagentInfo.set(ev.toolUseId, ev);
      }
      return;
    }
    setRowChip(data, "model", shortModelLabel(ev.model));
    fillChips(entry.chipsEl, data);
  }

  modelDisplayName(model: string): string | undefined {
    return resolveModelDisplayName(this.models, model);
  }

  setModels(models: ModelInfo[]): void {
    this.models = models;
    const changed = this.refreshModelTexts();
    if (this.modelFallback && fallbackNeedsConfirmation(this.modelFallback)) this.youStore.fallback(this.modelFallback, this.fallbackText(this.modelFallback.notice));
    if (changed && this.tabId === activeTabId) refreshFind();
  }

  private refreshModelTexts(): boolean {
    let changed = false;
    for (const ref of this.modelTextRefs) {
      const el = ref.deref();
      const bound = el && this.modelTexts.get(el);
      if (!bound) this.modelTextRefs.delete(ref);
      else changed = writeModelText(bound.span, bound.text()) || changed;
    }
    return changed;
  }

  private bindModelText<T extends HTMLElement>(el: T, text: () => string): T {
    let span = this.modelTexts.get(el)?.span;
    if (!span) {
      span = document.createElement("span");
      span.className = "model-text";
      el.prepend(span);
      this.modelTextRefs.add(new WeakRef(el));
    }
    this.modelTexts.set(el, { span, text });
    writeModelText(span, text());
    return el;
  }

  private modelKey(model: string | null | undefined): string | undefined {
    return model == null || this.modelDisplayName(model) === undefined ? undefined : model.trim();
  }

  private observeModelSwitch(model: string | null | undefined, last: string | null, divide: (key: string) => void): string | null {
    const key = this.modelKey(model);
    if (key === undefined) return last;
    if (last !== null && last !== key) divide(key);
    return key;
  }

  private addModelDivider(model: string): HTMLElement {
    const el = this.modelDivider(this.addBlock("system", ""), model);
    if (this.tabId === activeTabId) refreshFind();
    return el;
  }

  private bindModelName(el: HTMLElement, model: string): void {
    this.bindModelText(el, () => this.modelDisplayName(model) ?? "");
  }

  private modelDividerText(model: string): string {
    return l10n.t("── {0} from here ──", this.modelDisplayName(model) ?? "");
  }

  private modelDivider(el: HTMLElement, model: string): HTMLElement {
    el.dataset.modelDivider = model;
    return this.bindModelText(el, () => this.modelDividerText(model));
  }

  private addModelBlock(text: () => string, target: ViewMode = "conv"): HTMLElement {
    const el = this.bindModelText(this.addBlock("system", "", false, target), text);
    if (target === "conv" && this.tabId === activeTabId) refreshFind();
    return el;
  }

  private onModelObserved(ev: Extract<NormalizedEvent, { kind: "model_observed" }>): void {
    const key = this.modelKey(ev.model);
    if (key === undefined) return;
    if (ev.turnId !== null) {
      const label = this.currentAssistantTurn?.dataset.turnId === ev.turnId
        ? this.currentAssistantTurn.querySelector<HTMLElement>(":scope > .turn-label > .turn-label-name")
        : this.convEl.querySelector<HTMLElement>(`.block.assistant-turn[data-turn-id="${CSS.escape(ev.turnId)}"] > .turn-label > .turn-label-name`);
      if (label) this.bindModelName(label, ev.model);
    }
    if (this.lastObservedModel !== null && this.lastObservedModel !== key) {
      const anchor =
        this.currentAssistantTurn !== null &&
        this.currentAssistantTurn.isConnected &&
        ev.turnId !== null &&
        this.currentAssistantTurn.dataset.turnId === ev.turnId
          ? this.currentAssistantTurn
          : null;
      if (anchor) {
        const row = document.createElement("div");
        row.className = "block system";
        anchor.before(this.modelDivider(row, key));
        if (this.tabId === activeTabId) refreshFind();
      } else {
        this.addModelDivider(key);
      }
    }
    this.lastObservedModel = key;
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
    this.applyWork(ev.work);
    const el = this.approvalCards.get(ev.requestId);
    if (el) {
      el.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
      el.querySelectorAll("input").forEach((i) => ((i as HTMLInputElement).disabled = true));
      const withdrawn = ev.behavior === "withdrawn" || ev.resolvedBy === "withdrawn";
      el.classList.add(withdrawn ? "withdrawn" : ev.behavior === "allow" ? "approved" : "denied");
      const det = el.querySelector<HTMLDetailsElement>("details.approval-det");
      const titleEl = det?.querySelector<HTMLElement>("summary.approval-title");
      if (titleEl && !titleEl.querySelector(".approval-verdict")) {
        const verdict = document.createElement("span");
        verdict.className = `approval-verdict ${withdrawn ? "withdrawn" : ev.behavior}`;
        verdict.textContent = withdrawn ? l10n.t("Withdrawn")
          : ev.behavior === "allow" ? l10n.t("✔ Allowed") : l10n.t("✕ Denied");
        titleEl.appendChild(verdict);
      }
      if (det) det.open = false;
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
    this.applyApprovalRefResolved(ev);
    if (!this.hasPendingApproval()) {
      this.tabBtn.classList.remove("needs-approval");
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

  private onError(ev: Extract<NormalizedEvent, { kind: "error" }>): void {
    this.addBlock("error", ev.message);
    this.flagConvAttention();
    if (activeTabId === this.tabId) refreshChrome();
    if (this.pendingSend && !ev.message.includes("ANTHROPIC_API_KEY")) {
      this.pendingSend = false;
      this.setTurnState("idle");
    }
  }

  private renderApproval(ev: Extract<NormalizedEvent, { kind: "approval_request" }>): void {
    const { requestId, toolName, rawInputJson, questions } = ev;
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
        const setSelected = (el: Element, on: boolean) => {
          el.classList.toggle("selected", on);
          el.setAttribute("aria-pressed", on ? "true" : "false");
        };
        const clearSelected = () => optsEl.querySelectorAll(".askq-option").forEach((b) => setSelected(b, false));
        const otherInput = document.createElement("input");
        otherInput.type = "text";
        otherInput.className = "askq-other";
        otherInput.placeholder = l10n.t("Other (free text)");
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
    this.convEl.appendChild(div);
    const ref = this.buildApprovalRefRow(ev);
    this.registerLogMember(ref, ev.turnId ?? undefined);
    this.workEl.appendChild(ref);
    this.scrollToBottom("conv");
  }

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

  installConvHistoryHead(): HTMLElement {
    if (this.convHistoryEl !== null && this.convHistoryEl.isConnected) return this.convHistoryEl;
    const head = document.createElement("div");
    head.className = "convlog-history";
    const body = document.createElement("div");
    body.className = "convlog-history-body";
    head.append(body);
    const marker = this.replayMarkerEl;
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

  hasReplayedConversation(): boolean {
    return this.oldestConversationUuid() !== undefined;
  }

  oldestConversationUuid(): string | undefined {
    const el = this.convEl.querySelector<HTMLElement>("[data-msg-uuid]");
    return el?.dataset.msgUuid;
  }

  prependPastConvEvents(events: readonly NormalizedEvent[]): ConvEventPrependResult {
    return this.withAskResolutionBatch(() => {
    const frag = document.createDocumentFragment();
    let rendered = 0;
    let duplicates = 0;
    let skipped = 0;
    let continued = 0;
    let failed = 0;
    const failures: string[] = [];
    const turns = new Map<string, { el: HTMLElement }>();
    const records = new Map<string, RecordTextPart[]>();
    for (const ev of events) {
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
          appendRecordPart(parts, ev.kind === "assistant_text_delta"
            ? ev.recordUuid === undefined ? { text: ev.text, uuid: null }
              : { text: ev.text, uuid: ev.recordUuid, complete: true }
            : { text: "", uuid: ev.uuid });
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
    for (const [turnId, parts] of records) {
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
    });
  }

  private renderPastConvEvent(
    ev: NormalizedEvent,
    frag: DocumentFragment,
    turns: Map<string, { el: HTMLElement }>
  ): "created" | "duplicate" | "continued" | "skipped" {
    this.observeYouEvent(ev);
    if (!isConvRenderableEvent(ev)) return "skipped";
    if (ev.kind === "local_command_output") {
      if (ev.uuid && this.convMessageUuids.has(ev.uuid)) return "duplicate";
      const div = document.createElement("div");
      div.className = "block system";
      div.dataset.convPast = "1";
      div.textContent = ev.text;
      if (ev.uuid) {
        div.dataset.msgUuid = ev.uuid;
        this.convMessageUuids.add(ev.uuid);
      }
      frag.append(div);
      return "created";
    }
    if (ev.kind === "model_refusal_fallback" || ev.kind === "model_fallback_revert") {
      const div = document.createElement("div");
      div.className = "block system";
      div.dataset.convPast = "1";
      if (ev.kind === "model_refusal_fallback") {
        this.decorateFallbackBlock(this.bindModelText(div, () => this.fallbackText(ev)), ev);
      } else {
        this.bindModelText(div, () => this.fallbackRevertText(ev));
      }
      frag.append(div);
      return "created";
    }
    if (ev.kind === "replayed_message") {
      const uuid = ev.uuid;
      if (uuid !== undefined && this.convMessageUuids.has(uuid)) return "duplicate";
      if (ev.restoredApproval) {
        const card = buildRestoredApprovalCard(ev.restoredApproval, this.tabId);
        card.dataset.convPast = "1";
        if (uuid) {
          card.dataset.msgUuid = uuid;
          this.convMessageUuids.add(uuid);
        }
        frag.append(card);
        return "created";
      }
      const div = document.createElement("div");
      div.className = ev.role === "system" ? "block system" : ev.role === "user" ? "block user replayed" : "block assistant replayed";
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
      if (ev.role !== "system") this.prependTurnLabel(div, ev.role, ev.model ?? null);
      this.observeSessionTime(ev.recordedAt ?? ev.sentAt);
      if (ev.role === "user" && ev.imageRefs && ev.imageRefs.length > 0) {
        for (const info of ev.imageRefs) {
          div.appendChild(createImageSlot(this.tabId, info.ref));
        }
      }
      frag.appendChild(div);
      if (ev.role === "user") this.appendUserFoot(div, ev.recordedAt ?? ev.sentAt ?? undefined, ev.text);
      else if (ev.role === "assistant") frag.appendChild(this.buildReplyFooter(ev.recordedAt, () => ev.text));
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
      const key = this.modelKey(ev.model);
      if (key === undefined) return "skipped";
      if (label) this.bindModelName(label, key);
      let created = false;
      if (this.lastPastModel !== null && this.lastPastModel !== key) {
        const div = document.createElement("div");
        div.className = "block system";
        div.dataset.convPast = "1";
        frag.appendChild(this.modelDivider(div, key));
        created = true;
      }
      this.lastPastModel = key;
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

  prependPastMessages(
    items: ReadonlyArray<{
      uuid: string;
      role: "user" | "assistant" | "system";
      text: string;
      imageRefs?: ImageRefInfo[];
      model?: string;
      timestamp?: number;
      restoredApproval?: RestoredApprovalCard;
    }>
  ): ConvPrependResult {
    return this.withAskResolutionBatch(() => {
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
        if (m.restoredApproval) {
          const card = buildRestoredApprovalCard(m.restoredApproval, this.tabId);
          card.dataset.msgUuid = m.uuid;
          card.dataset.convPast = "1";
          frag.append(card);
          this.youStore.restoreApproval(m.restoredApproval, m.timestamp ?? 0);
          this.convMessageUuids.add(m.uuid);
          rendered++;
          continue;
        }
        if (m.role === "assistant" && m.model) {
          pastModel = this.observeModelSwitch(m.model, pastModel, (key) => {
            const div = document.createElement("div");
            div.className = "block system";
            div.dataset.convPast = "1";
            frag.appendChild(this.modelDivider(div, key));
            dividersCreated++;
          });
        }
        const div = document.createElement("div");
        div.className = m.role === "system" ? "block system" : m.role === "user" ? "block user replayed" : "block assistant replayed";
        div.dataset.msgUuid = m.uuid;
        div.dataset.convPast = "1";
        if (m.role === "assistant") {
          this.recordReplyIds.add(m.uuid);
          this.renderReplyMarkdown(div, m.text, m.uuid, 0, m.timestamp ?? 0);
          this.youStore.assistantReply(m.uuid, m.timestamp ?? 0);
        }
        else if (m.role === "user") {
          div.textContent = m.text;
          this.youStore.reply(m.uuid, m.timestamp ?? 0, undefined, undefined, m.text);
          this.persistAskResolutions();
        } else div.textContent = m.text;
        if (m.role !== "system") this.prependTurnLabel(div, m.role, m.model ?? null);
        this.observeSessionTime(m.timestamp);
        if (m.role === "user" && m.imageRefs && m.imageRefs.length > 0) {
          for (const info of m.imageRefs) {
            div.appendChild(createImageSlot(this.tabId, info.ref));
          }
        }
        frag.appendChild(div);
        if (m.role === "user") this.appendUserFoot(div, m.timestamp, m.text);
        else if (m.role === "assistant") frag.appendChild(this.buildReplyFooter(m.timestamp, () => m.text));
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
    });
  }

  installHistoryHead(): HTMLElement {
    this.replayDone = true;
    if (this.historyHeadEl !== null && this.historyHeadEl.isConnected) return this.historyHeadEl;
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

  noteRenderedEvents(events: readonly NormalizedEvent[]): void {
    for (const ev of events) this.renderedEventKeys.add(`${ev.generation}:${ev.seq}`);
  }

  prependPastEvents(events: readonly NormalizedEvent[]): PastPrependResult {
    return this.withAskResolutionBatch(() => {
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
    this.lastPastModel = null;
    try {
      for (const ev of events) {
        const key = `${ev.generation}:${ev.seq}`;
        if (this.renderedEventKeys.has(key)) {
          duplicates++;
          continue;
        }
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
      connected: this.workEl.querySelectorAll(".hll-past").length,
      expectedConnected: this.pastRenderedTotal,
      failures: ctx.failures,
    };
    });
  }

  private renderPastEvent(ev: NormalizedEvent): PastRenderOutcome {
    this.youStore.observe(ev);
    if (ev.kind === "user_message" || (ev.kind === "replayed_message" && ev.role === "user")) this.persistAskResolutions();
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
        this.rememberOrphanFinish(ev);
        return "skipped";
      }
      case "subagent_info":
        return this.renderPastSubagentInfo(ev);
      case "approval_request": {
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
        return this.renderPastPlainRow(() => this.fallbackLogText(ev), "system");
      case "model_fallback_revert":
        return this.renderPastPlainRow(() => this.fallbackRevertText(ev), "system");
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
    const takes =
      stash !== null &&
      !cliInserted &&
      (stash.turnId !== null ? stash.turnId === ev.turnId : stash.chunk === this.pastChunkSerial);
    const headline = takes ? stash.text : null;
    if (takes) {
      this.pastHeadline = null;
    } else if (cliInserted && stash !== null && stash.turnId === null && stash.chunk === this.pastChunkSerial) {
      this.pastHeadline = null;
    }
    const anchor = this.buildTurnAnchor(ev.turnId, ev.timestamp, headline, true, cliInserted);
    if (!cliInserted) {
      this.pastPendingAnchor = headline === null ? anchor : null;
      this.pastPendingChunk = this.pastChunkSerial;
      this.pastPendingFirst = !this.pastChunkTurnSeen;
    }
    this.pastChunkTurnSeen = true;
    this.insertWork(this.pastRender!.frag, anchor);
    return "created";
  }

  private renderPastPlainRow(text: string | (() => string), cls: string): PastRenderOutcome {
    const div = document.createElement("div");
    div.className = `block ${cls} hll-past`;
    if (typeof text === "string") div.textContent = text;
    else this.bindModelText(div, text);
    this.insertWork(this.pastRender!.frag, div);
    return "created";
  }

  private renderPastToolStarted(
    ev: Extract<NormalizedEvent, { kind: "tool_call_started" }>
  ): PastRenderOutcome {
    if (this.rowData.has(ev.toolUseId)) return "skipped";
    const placement = ev.work?.placement;
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
    const withdrawn = ev.behavior === "withdrawn" || ev.resolvedBy === "withdrawn";
    refRow.classList.add("resolved", withdrawn ? "withdrawn" : ev.behavior);
    refRow.textContent =
      (refRow.textContent?.replace(APPROVAL_REF_SUFFIX, "") ?? "") +
      (withdrawn ? l10n.t(" (Withdrawn)")
        : ev.behavior === "allow" ? l10n.t(" (Allowed)") : l10n.t(" (Denied)"));
    return true;
  }

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
          this.lastObservedModel = this.observeModelSwitch(msg.model, this.lastObservedModel, (key) => this.addModelDivider(key));
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
