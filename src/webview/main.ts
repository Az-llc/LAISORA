import { installAccent } from "./accent";
import { setDisplayName } from "./user-label";
import { prependPreservingView } from "./history-scroll";
import * as l10n from "@vscode/l10n";

const applyAccent = installAccent();

import type {
  AccountUsageRow,
  AccountUsageSnapshot,
  ConversationHistoryErrorReason,
  HistoryChunkPagePayload,
  HostToWebview,
  ImageAttachment,
  ImageRefInfo,
  NormalizedEvent,
  PendingAttachmentInfo,
  PermissionModeId,
  ResumeHydrationPhase,
  SemanticModelPayload,
  TabSnapshot,
  UsageSnapshot,
  WorkModelPayload,
} from "../protocol";
import { ACCOUNT_USAGE_REPLY_WAIT_MS, fallbackChipWarning, IMAGE_MAX_COUNT, isCurrentAccountUsageRow, PROTOCOL_VERSION, RENAME_TITLE_MAX, isHostToWebview, withLocalEventDrop } from "../protocol";
import { windowEvents } from "../event-window";
import { findModelRow, resolveModelDisplayName } from "../model-display-name";
import type { AnalysisReport } from "../analysis";
import {
  actionBtn,
  attachBtn,
  attachmentsEl,
  authEl,
  authPickerEl,
  convNextBtn,
  convPrevBtn,
  ctxChipEl,
  exportBtn,
  findBarEl,
  handoffBtn,
  inputEl,
  logsEl,
  modeBtn,
  newTabBtn,
  tabbarEl,
  usageEl,
  usagePanelEl,
  vscode,
  CONTEXT_CHIP_EMPTY,
} from "./dom";
import { applySessionChunk, applySessionHiddenChanged, applySessionListActionFailed, applySessionRenamed, initHistory, openHistPanel } from "./history";
import {
  applyUserSettings,
  closeAuthPicker,
  closeModeMenu,
  composerPlaceholder,
  composerSendKey,
  initMenu,
  openAuthPicker,
  renderAuthPicker,
  syncMenuCursor,
} from "./menu";
import { closeSuggest, handleFilesResponse, initSuggest, insertFilePaths } from "./suggest";
import { setFileLinkHostPlatform, setFileLinkSystemAppExtensions } from "./markdown-ast";
import type { ScrollCarry, ViewMode } from "./tab";
import {
  Tab,
  closeLightbox,
  handleSessionImageError,
  handleSessionImageResult,
  isScrollCarry,
  setOnConvViewShown,
  setOnTabActivity,
} from "./tab";
import { isConvRenderableEvent } from "../conv-renderable";
import { WorkOverview, type WorkViewMode } from "./work-overview";
import type { CoverageBackfillHint } from "./work-graph";
import { renderLlmDiagnosticsView } from "./llm-diagnostics-view";
import { closeFindBar, findNext, initFindBar, isFindBarOpen, openFindBar, refreshFind } from "./find-bar";
import { uiLocale } from "./l10n";

export const MODE_LABELS: Record<PermissionModeId, string> = {
  default: l10n.t("Ask before actions"),
  auto: "Auto",
  acceptEdits: l10n.t("Auto-accept edits"),
  plan: "Plan",
  dontAsk: "DontAsk",
  bypassPermissions: "Bypass",
};
export const MODE_ORDER: PermissionModeId[] = [
  "default",
  "auto",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

const tabs = new Map<string, Tab>();
const overviews = new Map<string, WorkOverview>();
setOnTabActivity((tabId, active) => overviews.get(tabId)?.setActive(active));
setOnConvViewShown((tabId) => resumeConversationChase(tabId));
const localEventDrops = new Map<string, number>();
const hostDroppedAtInstall = new Map<string, number>();
export let activeTabId: string | null = vscode.getState()?.activeTabId ?? null;
let activeTabAfterInit: string | null = null;
const drafts = new Map<string, string>(Object.entries(vscode.getState()?.drafts ?? {}));
const forgottenTabIds = new Set<string>();

export type ResumeHostState = ResumeHydrationPhase;
export type ResumePagerState = "not-installed" | "running" | "exhausted" | "failed";

export interface ResumeLoadCoordinator {
  host: ResumeHostState;
  workPager: ResumePagerState;
  convPager: ResumePagerState;
  journalEventIds: Set<string>;
  convTouched: boolean;
}

const resumeCoordinators = new Map<string, ResumeLoadCoordinator>();

function getOrCreateCoordinator(tabId: string, host: ResumeHostState = "loading"): ResumeLoadCoordinator {
  let coord = resumeCoordinators.get(tabId);
  if (!coord) {
    coord = {
      host,
      workPager: "not-installed",
      convPager: "not-installed",
      journalEventIds: new Set<string>(),
      convTouched: false,
    };
    resumeCoordinators.set(tabId, coord);
  } else {
    coord.host = host;
  }
  return coord;
}

type PersistedState = Parameters<typeof vscode.setState>[0] & { scrollAnchors?: Record<string, unknown> };

function savedScrollAnchors(): Record<string, unknown> {
  const saved = (vscode.getState() as PersistedState | undefined)?.scrollAnchors;
  return typeof saved === "object" && saved !== null ? saved : {};
}

const tabsAddedInDocument = new Set<string>();

function savedScrollCarry(tabId: string): ScrollCarry | undefined {
  if (tabsAddedInDocument.has(tabId)) return undefined;
  const carry = savedScrollAnchors()[tabId];
  return isScrollCarry(carry) ? carry : undefined;
}

export function persistState(): void {
  if (activeTabId) drafts.set(activeTabId, inputEl.value);
  const views: Record<string, ViewMode> = { ...(vscode.getState()?.views ?? {}) };
  const workViews: Record<string, WorkViewMode> = { ...(vscode.getState()?.workViews ?? {}) };
  const analysisViews: Record<string, "script" | "ai"> = { ...(vscode.getState()?.analysisViews ?? {}) };
  const scrollAnchors = { ...savedScrollAnchors() };
  const askChecks = { ...(vscode.getState()?.askChecks ?? {}) };
  const askDismissed = { ...(vscode.getState()?.askDismissed ?? {}) };
  const askResolved = { ...(vscode.getState()?.askResolved ?? {}) };
  const out = Object.fromEntries(drafts);
  for (const id of forgottenTabIds) {
    delete views[id];
    delete workViews[id];
    delete analysisViews[id];
    delete askChecks[id];
    delete askDismissed[id];
    delete askResolved[id];
    delete scrollAnchors[id];
    delete out[id];
  }
  for (const [id, t] of tabs) views[id] = t.viewMode;
  for (const [id, t] of tabs) workViews[id] = t.workViewMode;
  for (const [id, overview] of overviews) analysisViews[id] = overview.analysisSubtab;
  for (const [id, t] of tabs) scrollAnchors[id] = t.captureScrollCarry(false);
  const { askDismissedMessages, askResolvedMessages, askCheckedMessages } = vscode.getState() ?? {};
  const next: PersistedState = { activeTabId, drafts: out, views, workViews, analysisViews, scrollAnchors, askChecks, askDismissed, askDismissedMessages, askResolved, askResolvedMessages, askCheckedMessages };
  vscode.setState(next);
}

const SCROLL_PERSIST_DELAY_MS = 250;
let scrollPersistTimer: ReturnType<typeof setTimeout> | undefined;

function initLogsScroll(): void {
  logsEl.addEventListener("scroll", () => {
    if (!activeTabId) return;
    overviews.get(activeTabId)?.onPortScroll();
    tabs.get(activeTabId)?.noteScroll();
    syncWorklogBackfillScroll(activeTabId);
    if (scrollPersistTimer !== undefined) clearTimeout(scrollPersistTimer);
    scrollPersistTimer = setTimeout(() => {
      scrollPersistTimer = undefined;
      if (activeTabId) tabs.get(activeTabId)?.noteScrollAnchor();
      persistState();
    }, SCROLL_PERSIST_DELAY_MS);
  });
  for (const type of ["wheel", "touchstart"]) {
    logsEl.addEventListener(type, abandonAwaitedScrollAnchor, { passive: true });
  }
  logsEl.addEventListener("pointerdown", (e) => {
    if (e.target === logsEl) abandonAwaitedScrollAnchor();
  }, { passive: true });
  logsEl.addEventListener("keydown", (e) => {
    if (SCROLL_KEYS.has(e.key)) abandonAwaitedScrollAnchor();
  }, { passive: true });
  findBarEl.addEventListener("input", abandonAwaitedScrollAnchor);
  findBarEl.addEventListener("click", abandonAwaitedScrollAnchor);
  findBarEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") abandonAwaitedScrollAnchor();
  });
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

function abandonAwaitedScrollAnchor(): void {
  if (activeTabId) tabs.get(activeTabId)?.stopAwaitingScrollAnchor();
}

const analysisReports = new Map<string, { filePath: string; report: AnalysisReport }>();
export function refreshComposer(): void {
  inputEl.placeholder = composerPlaceholder();
  refreshChrome();
}

let tabActivationDepth = 0;
let surfaceGeneration = 0;

export function noteSurfaceChange(): void {
  surfaceGeneration += 1;
}

export function setActiveTab(tabId: string): void {
  if (!tabs.has(tabId)) return;
  closeSuggest();
  closeModeMenu();
  closeAuthPicker();
  closeLightbox();
  closeFindBar(false);
  if (activeTabId && activeTabId !== tabId && tabs.has(activeTabId)) {
    drafts.set(activeTabId, inputEl.value);
    const leaving = tabs.get(activeTabId)!;
    leaving.noteScroll();
    leaving.noteLeavingScroll();
  }
  if (activeTabId !== tabId) inputEl.value = drafts.get(tabId) ?? "";
  activeTabId = tabId;
  tabActivationDepth += 1;
  noteSurfaceChange();
  try {
    renderAttachments();
    persistState();
    vscode.postMessage({ type: "activeTab", tabId });
    for (const [id, t] of tabs) {
      t.tabBtn.classList.toggle("active", id === tabId);
      t.tabBtn.setAttribute("aria-selected", id === tabId ? "true" : "false");
      t.logEl.classList.toggle("active", id === tabId);
      t.setSessionMenuActive(id === tabId);
    }
    tabs.get(tabId)!.updateStrip();
    refreshComposer();
    resumeConversationChase(tabId);
    resumeWorklogBackfill(tabId);
    autosizeComposer();
    tabs.get(tabId)!.restoreScroll();
  } finally {
    tabActivationDepth -= 1;
  }
}

export function findTabBySessionId(sessionId: string): Tab | undefined {
  for (const t of tabs.values()) {
    if (t.auth?.sessionId === sessionId || t.resumeSessionId === sessionId) return t;
  }
  return undefined;
}

function analysisTargetTab(sessionId: string): string | null {
  for (const [id, t] of tabs) {
    if (t.auth?.sessionId === sessionId || t.resumeSessionId === sessionId) return id;
  }
  if (activeTabId && tabs.has(activeTabId)) return activeTabId;
  return tabs.keys().next().value ?? null;
}

function showAnalysis(sessionId: string, filePath: string, report: AnalysisReport): void {
  analysisReports.set(sessionId, { filePath, report });
  const tabId = analysisTargetTab(sessionId);
  if (!tabId) return;
  setActiveTab(tabId);
  const tab = tabs.get(tabId);
  tab?.withViewChange(() => {
    overviews.get(tabId)?.showAnalysis(sessionId, filePath, report);
    tab.selectPane("analysis");
  });
}

function showAnalysisFailure(msg: Extract<HostToWebview, { type: "analysisFailed" }>): void {
  if (msg.reason === undefined) return;
  const tabId = msg.tabId ?? activeTabId;
  if (!tabId || !tabs.has(tabId)) return;
  if (msg.kind === "script") {
    setActiveTab(tabId);
  }
  const tab = tabs.get(tabId)!;
  tab.withViewChange(() => {
    overviews.get(tabId)?.showAnalysisFailure(msg.reason!);
    if (msg.kind === "script") tab.selectPane("analysis");
  });
}

export function activeTab(): Tab | null {
  return activeTabId ? tabs.get(activeTabId) ?? null : null;
}

let headLayoutPending = false;
function syncActiveHeadLayout(): void {
  if (headLayoutPending) return;
  headLayoutPending = true;
  setTimeout(() => {
    headLayoutPending = false;
    activeTab()?.syncHeadLayout();
  }, 0);
}
window.addEventListener("resize", syncActiveHeadLayout);

function autosizeComposer(): void {
  const previous = inputEl.style.height;
  inputEl.style.height = "auto";
  const next = `${Math.min(inputEl.scrollHeight, 8 * 20)}px`;
  inputEl.style.height = previous;
  if (next === previous) {
    syncActiveHeadLayout();
    return;
  }
  reflowComposer(() => {
    inputEl.style.height = next;
  });
}

function clearComposerInput(): void {
  inputEl.value = "";
  autosizeComposer();
}

export function refreshChrome(): void {
  const t = activeTab();
  const state = t?.turnState ?? "idle";
  if (state === "idle") {
    actionBtn.textContent = "➤";
    actionBtn.className = "icon";
    actionBtn.title = l10n.t("Send (Enter)");
    actionBtn.setAttribute("aria-label", l10n.t("Send"));
    actionBtn.disabled = false;
  } else {
    actionBtn.textContent = "◼";
    actionBtn.className = "icon stop";
    actionBtn.title = l10n.t("Stop");
    actionBtn.setAttribute("aria-label", l10n.t("Stop"));
    actionBtn.disabled = state === "interrupting";
  }
  convPrevBtn.disabled = t === null;
  convNextBtn.disabled = t === null;
  renderAuth(t);
  renderUsage(t?.usage ?? null, t?.contextUsage ?? null);
  renderMode(t);
}

function renderMode(t: Tab | null): void {
  const mode = t?.permissionMode ?? "default";
  modeBtn.textContent = MODE_LABELS[mode];
  modeBtn.className = mode === "bypassPermissions" ? "mode-chip mode-danger" : "mode-chip";
}

export function displayModelName(t: Tab | null): string | undefined {
  const rows = t?.models ?? [];
  if (t?.modelFallback && t.modelFallback.resolvedAt === undefined) return resolveModelDisplayName(rows, t.modelFallback.appliedModel);
  const override = t?.modelOverride;
  if (override) return resolveModelDisplayName(rows, override);
  const raw = override === null ? "default" : (t?.auth?.model ?? t?.appliedModel ?? t?.recordedModel ?? t?.configModel)?.trim();
  if (!raw) return undefined;
  if (raw === "default" && !findModelRow(rows, raw)) return undefined;
  return resolveModelDisplayName(rows, raw);
}

export function renderAuth(t: Tab | null): void {
  const auth = t?.auth ?? null;
  const effort = auth?.effort === null ? l10n.t("Not used")
    : auth?.effort ?? (t?.effortOverride ? l10n.t("{0} (requested)", t.effortOverride)
      : t?.configEffort ? l10n.t("{0} (configured)", t.configEffort)
        : t?.defaultEffort ? l10n.t("{0} (default)", t.defaultEffort)
          : t?.appliedEffort === null ? l10n.t("Not used") : t?.appliedEffort ?? l10n.t("Unconfirmed"));
  const modelName = displayModelName(t);
  const fallback = t !== null && fallbackChipWarning(t.modelFallback, t.modelOverride, t.models);

  if (!auth) {
    const model = modelName || l10n.t("Model unconfirmed");
    authEl.textContent = `${model} / effort: ${effort}`;
    authEl.className = fallback ? "chip model-fallback-warning" : "chip";
    authEl.setAttribute("title", `${model} / effort: ${effort}`);
    return;
  }

  const model = modelName ?? auth.model ?? "?";
  authEl.textContent =
    auth.billingRealm === "subscription"
      ? `${model} / effort: ${effort}`
      : `${auth.billingRealm} ${model} / effort: ${effort}`;
  authEl.className = (auth.billingRealm === "subscription" ? "chip" : "chip warn") + (fallback ? " model-fallback-warning" : "");
  authEl.title = `${auth.credentialSource} / ${auth.billingRealm} · apiKeySource=${
    auth.apiKeySource ?? "?"
  }`;
}

function contextUsageLine(c: NonNullable<Tab["contextUsage"]>): string {
  const locale = uiLocale();
  const threshold = c.autoCompactThreshold === undefined
    ? l10n.t("not fetched")
    : l10n.t("{0} tokens", c.autoCompactThreshold.toLocaleString(locale));
  const disabled = c.isAutoCompactEnabled ? "" : ` ${l10n.t("(auto-compact disabled)")}`;
  return l10n.t(
    "Context: {0}% of limit · current {1} / limit {2} tokens · auto-compact threshold: {3}{4}",
    c.percentage,
    c.totalTokens.toLocaleString(locale),
    c.maxTokens.toLocaleString(locale),
    threshold,
    disabled
  );
}

function omittedEventsNote(n: number): string {
  return l10n.t("{0} older events were omitted", n);
}

function costText(totalCostUsd: number | undefined): string {
  return typeof totalCostUsd === "number" ? `$${totalCostUsd.toFixed(4)}` : l10n.t("cost not fetched");
}

function renderUsage(u: UsageSnapshot | null, contextUsage: Tab["contextUsage"] | null): void {
  const contextTitle = contextUsage ? contextUsageLine(contextUsage) : null;
  const chipText = contextUsage ? `ctx ${contextUsage.percentage}%` : CONTEXT_CHIP_EMPTY;
  if (!u) {
    usageEl.textContent = chipText;
    if (contextTitle) usageEl.title = contextTitle;
    else usageEl.removeAttribute("title");
    return;
  }
  const f = (v: number | undefined) => (typeof v === "number" ? `${v}` : l10n.t("not fetched"));
  const cost = costText(u.totalCostUsd);
  const usageText =
    u.cacheCreationInputTokens !== undefined || u.cacheReadInputTokens !== undefined
      ? l10n.t(
          "Input {0} (cache write {1} / read {2}) · Output {3} · {4}",
          f(u.inputTokens),
          f(u.cacheCreationInputTokens),
          f(u.cacheReadInputTokens),
          f(u.outputTokens),
          cost
        )
      : l10n.t("Input {0} · Output {1} · {2}", f(u.inputTokens), f(u.outputTokens), cost);
  usageEl.textContent = chipText;
  usageEl.title = `${contextTitle ? `${contextTitle}\n` : ""}${l10n.t("This turn's usage: {0}", usageText)}`;
}

let accountUsage: AccountUsageSnapshot | null = null;
let accountUsagePending = false;
let accountUsageRequestId: string | null = null;
let accountUsageRequestSeq = 0;
let accountUsageReplyTimer: ReturnType<typeof setTimeout> | undefined;
let accountUsageResetTimer: ReturnType<typeof setTimeout> | undefined;
const TIMER_DELAY_MAX_MS = 2_147_483_647;

function settleAccountUsageRequest(): void {
  accountUsagePending = false;
  if (accountUsageReplyTimer !== undefined) clearTimeout(accountUsageReplyTimer);
  accountUsageReplyTimer = undefined;
}

function scheduleAccountUsageReset(rows: AccountUsageRow[], now: number): void {
  if (accountUsageResetTimer !== undefined) clearTimeout(accountUsageResetTimer);
  accountUsageResetTimer = undefined;
  const next = Math.min(...rows.map((row) => (row.resetsAt === null ? Infinity : row.resetsAt)));
  if (!Number.isFinite(next)) return;
  accountUsageResetTimer = setTimeout(() => {
    accountUsageResetTimer = undefined;
    if (!usagePanelEl.classList.contains("hidden")) renderUsagePanel();
  }, Math.min(TIMER_DELAY_MAX_MS, Math.max(0, next - now)));
}

function accountUsageRowLabel(row: AccountUsageRow): string {
  switch (row.kind) {
    case "session":
      return l10n.t("5-hour window");
    case "weekly_all":
      return l10n.t("Weekly window");
    case "weekly_scoped":
      return row.scope ? l10n.t("Weekly window ({0})", row.scope) : l10n.t("Weekly window");
    default:
      return row.scope ? `${row.kind} (${row.scope})` : row.kind;
  }
}

function accountUsageLine(text: string): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "usage-line";
  line.textContent = text;
  return line;
}

export function renderUsagePanel(): void {
  usagePanelEl.textContent = "";
  const heading = document.createElement("div");
  heading.className = "auth-picker-heading";
  heading.textContent = "Account & Usage";
  usagePanelEl.appendChild(heading);
  const line = document.createElement("div");
  line.className = "usage-line";
  const curTab = activeTab();
  const u = curTab?.usage;
  const nf = (v: number | undefined) => (v === undefined ? l10n.t("not fetched") : String(v));
  line.textContent = u
    ? l10n.t(
        "Last turn: input {0} / output {1} / cache write {2} read {3} / {4}",
        nf(u.inputTokens),
        nf(u.outputTokens),
        nf(u.cacheCreationInputTokens),
        nf(u.cacheReadInputTokens),
        costText(u.totalCostUsd)
      )
    : l10n.t("Last turn: not measured yet");
  usagePanelEl.appendChild(line);
  const contextLine = document.createElement("div");
  contextLine.className = "usage-line";
  const context = curTab?.contextUsage;
  contextLine.textContent = context ? contextUsageLine(context) : l10n.t("Context: not fetched yet");
  usagePanelEl.appendChild(contextLine);
  if (accountUsagePending || accountUsage === null) {
    usagePanelEl.appendChild(accountUsageLine(l10n.t("Usage: fetching…")));
    return;
  }
  if (accountUsage.state !== "ok") {
    usagePanelEl.appendChild(accountUsageLine(l10n.t("Usage: unavailable")));
    return;
  }
  const fetchedAt = new Date(accountUsage.fetchedAtMs).toLocaleString(uiLocale(), { hour12: false });
  usagePanelEl.appendChild(accountUsageLine(l10n.t("Usage fetched at: {0}", fetchedAt)));
  const now = Date.now();
  const rows = accountUsage.rows.filter((row) => isCurrentAccountUsageRow(row, now));
  scheduleAccountUsageReset(rows, now);
  if (rows.length === 0) usagePanelEl.appendChild(accountUsageLine(l10n.t("Usage: no current windows")));
  for (const rl of rows) {
    const row = document.createElement("div");
    row.className = "usage-rl";
    const pct = Math.round(rl.percent);
    const reset = rl.resetsAt !== null ? new Date(rl.resetsAt).toLocaleString(uiLocale(), { hour12: false }) : "?";
    const label = accountUsageLine(l10n.t("{0}: {1}% · resets {2}", accountUsageRowLabel(rl), pct, reset));
    const barWrap = document.createElement("div");
    barWrap.className = "usage-bar-wrap";
    const bar = document.createElement("div");
    const warn = rl.severity !== undefined ? rl.severity !== "normal" : pct >= 90;
    bar.className = `usage-bar${warn ? " warn" : ""}`;
    bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    barWrap.appendChild(bar);
    row.append(label, barWrap);
    usagePanelEl.appendChild(row);
  }
}

function openUsagePanel(): void {
  if (!accountUsagePending) {
    accountUsagePending = true;
    accountUsageReplyTimer = setTimeout(() => {
      accountUsageReplyTimer = undefined;
      if (!accountUsagePending) return;
      accountUsagePending = false;
      accountUsage = { seq: accountUsage?.seq ?? 0, fetchedAtMs: Date.now(), state: "failed", rows: [] };
      if (!usagePanelEl.classList.contains("hidden")) renderUsagePanel();
    }, ACCOUNT_USAGE_REPLY_WAIT_MS);
    accountUsageRequestId = `usage-${++accountUsageRequestSeq}`;
    vscode.postMessage({ type: "requestAccountUsage", requestId: accountUsageRequestId, ...(activeTabId ? { tabId: activeTabId } : {}) });
  }
  closeAuthPicker();
  closeModeMenu();
  renderUsagePanel();
  usagePanelEl.classList.remove("hidden");
  usageEl.setAttribute("aria-expanded", "true");
}

export function closeUsagePanel(): void {
  if (accountUsageRequestId !== null && !usagePanelEl.classList.contains("hidden")) {
    accountUsageRequestId = null;
    settleAccountUsageRequest();
    vscode.postMessage({ type: "accountUsagePanelClosed" });
  }
  if (accountUsageResetTimer !== undefined) clearTimeout(accountUsageResetTimer);
  accountUsageResetTimer = undefined;
  usagePanelEl.classList.add("hidden");
  usageEl.setAttribute("aria-expanded", "false");
}

function initUsagePanel(): void {
  usageEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (usagePanelEl.classList.contains("hidden")) {
      openUsagePanel();
    } else {
      closeUsagePanel();
    }
  });
  document.addEventListener("click", (e) => {
    if (!usagePanelEl.classList.contains("hidden") && e.target !== usageEl && !usagePanelEl.contains(e.target as Node)) {
      closeUsagePanel();
    }
  });
}

let llmDiagnosticsEl: HTMLElement | undefined;
let llmDiagnosticsAllowed: boolean | undefined;

function llmDiagnosticsPanel(): HTMLElement {
  if (llmDiagnosticsEl === undefined) {
    llmDiagnosticsEl = document.createElement("div");
    llmDiagnosticsEl.className = "llm-diagnostics";
    llmDiagnosticsEl.setAttribute("role", "region");
    llmDiagnosticsEl.setAttribute("aria-label", l10n.t("Rejected LLM findings (diagnostics)"));
    document.body.appendChild(llmDiagnosticsEl);
  }
  return llmDiagnosticsEl;
}

function applyLlmDiagnosticsMode(mode: boolean | undefined): void {
  llmDiagnosticsAllowed = mode;
  if (mode !== false) return;
  if (llmDiagnosticsEl !== undefined) {
    llmDiagnosticsEl.remove();
    llmDiagnosticsEl = undefined;
  }
}

const REPLAY_MAX = 1500;
const HISTORY_REQUEST_TIMEOUT_MS = 30_000;
const CONV_FIRST_TRANSCRIPT_TIMEOUT_MS = 120_000;
const CONV_FIRST_CHUNK_RETRY_MAX = 3;
const CONV_FIRST_CHUNK_RETRY_DELAY_MS = 2_000;

interface HistoryPager {
  anchorUuid?: string;
  phase?: "events" | "transcript";
  eventAnchor?: { generation: number; seq: number };
  status: "idle" | "inflight" | "exhausted" | "error";
  anchor?: { generation: number; seq: number };
  cursor?: string;
  requestId?: string;
  retried: boolean;
  autoSteps?: number;
  chaseBudget?: number;
  chasePaused?: boolean;
  phaseInitialRemaining?: number;
  lastRemainingOlder?: number;
  receivedTranscriptChunk?: boolean;
  firstChunkRetries?: number;
  backfillBudget?: number;
  backfillTotal?: number;
  transcriptRemaining?: number;
  wasAtBottom?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  noteEl?: HTMLElement;
  renderFailedTotal?: number;
  renderFailNoteEl?: HTMLElement;
}

function withoutScrollAnchoring<T>(fn: () => T): T {
  const previous = logsEl.style.overflowAnchor;
  logsEl.style.overflowAnchor = "none";
  try {
    return fn();
  } finally {
    logsEl.style.overflowAnchor = previous;
  }
}

export function swapPreservingConvView(tabId: string, target: Element, replacement: Node): void {
  if (!convPaneVisible(tabId)) {
    target.replaceWith(replacement);
    return;
  }
  withoutScrollAnchoring(() => {
    const portTop = logsEl.getBoundingClientRect().top;
    const nodeTop = target.getBoundingClientRect().top;
    const atBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight <= SCROLL_BOTTOM_GAP_PX;
    const heightBeforeSwap = logsEl.scrollHeight;
    target.replaceWith(replacement);
    const heightAfterSwap = logsEl.scrollHeight;
    if (atBottom) logsEl.scrollTop = logsEl.scrollHeight;
    else if (nodeTop < portTop) logsEl.scrollTop += heightAfterSwap - heightBeforeSwap;
  });
}

export const SCROLL_BOTTOM_GAP_PX = 24;

function convStuckToBottom(): boolean {
  const t = activeTab();
  if (t === null || t.viewMode !== "conv") return false;
  return logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight <= SCROLL_BOTTOM_GAP_PX;
}

function restickConv(stuck: boolean): void {
  if (!stuck) return;
  const t = activeTab();
  if (t === null || t.viewMode !== "conv") return;
  logsEl.scrollTop = logsEl.scrollHeight;
  t.noteScroll();
}

function reflowComposer(mutate: (settle: () => void) => void): void {
  if (tabActivationDepth > 0) {
    mutate(() => {});
    return;
  }
  const stuck = convStuckToBottom();
  const generation = surfaceGeneration;
  let placedTop = logsEl.scrollTop;
  let placedHeight = logsEl.scrollHeight;
  const settleLater = (): void => {
    if (generation !== surfaceGeneration) return;
    const shrank = Math.max(placedHeight - logsEl.scrollHeight, 0);
    if (placedTop - logsEl.scrollTop - shrank > SCROLL_BOTTOM_GAP_PX) return;
    restickConv(stuck);
    placedTop = logsEl.scrollTop;
    placedHeight = logsEl.scrollHeight;
  };
  mutate(settleLater);
  syncActiveHeadLayout();
  restickConv(stuck);
  placedTop = logsEl.scrollTop;
  placedHeight = logsEl.scrollHeight;
  setTimeout(settleLater, 0);
}

const historyPagers = new Map<string, HistoryPager>();
const lastWorkModels = new Map<string, Parameters<typeof withLocalEventDrop>[0]>();
const lastSemanticModels = new Map<string, { model: SemanticModelPayload | undefined; view: boolean | undefined }>();
let historyRequestSeq = 0;

const convPagers = new Map<string, HistoryPager>();
let convRequestSeq = 0;

function stopConvChase(pager: HistoryPager): void {
  pager.autoSteps = undefined;
  pager.lastRemainingOlder = undefined;
  pager.chaseBudget = undefined;
}

function convChaseContinues(
  tabId: string,
  pager: HistoryPager,
  usedCursor: string | undefined,
  page: { nextCursor?: string; hasMore: boolean; coverage: { remainingOlderCount: number } },
  returnedCount: number
): boolean {
  if (pager.autoSteps === undefined) return false;
  if (!page.hasMore || page.nextCursor === undefined) return false;
  if (page.nextCursor === usedCursor) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: cursor が進んでいない (tab=${tabId})`
    );
    return false;
  }
  if (returnedCount === 0) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: 0件の chunk で hasMore=true (tab=${tabId})`
    );
    return false;
  }
  const remaining = page.coverage.remainingOlderCount;
  if (pager.lastRemainingOlder !== undefined && remaining >= pager.lastRemainingOlder) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: 残件数が減らない (${pager.lastRemainingOlder} -> ${remaining}, tab=${tabId})`
    );
    return false;
  }
  pager.lastRemainingOlder = remaining;
  if (pager.chaseBudget !== undefined && pager.autoSteps >= pager.chaseBudget) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: 追走上限 ${pager.chaseBudget} に達した (tab=${tabId})`
    );
    return false;
  }
  pager.chaseBudget = pager.autoSteps + remaining;
  pager.autoSteps++;
  return true;
}

function dropConvPager(tabId: string): void {
  const pager = convPagers.get(tabId);
  if (pager?.timer !== undefined) clearTimeout(pager.timer);
  convPagers.delete(tabId);
}

function convPaneVisible(tabId: string): boolean {
  const t = tabs.get(tabId);
  return t !== undefined && activeTabId === tabId && t.viewMode === "conv";
}

function showConvChaseProgress(tabId: string, pager: HistoryPager, remaining: number): void {
  const coord = resumeCoordinators.get(tabId);
  if (coord) coord.convPager = "running";
  const t = tabs.get(tabId);
  if (t === undefined) return;
  if (pager.phaseInitialRemaining === undefined) pager.phaseInitialRemaining = remaining;
  const total = pager.phaseInitialRemaining;
  const ratio = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 1;
  t.setConvLoadProgress({ phase: "loading", remaining, ratio });
}

export function conversationHistoryGapNote(coverage: {
  malformedLineCount?: number;
  droppedWithoutUuidCount?: number;
}): string | undefined {
  const parts: string[] = [];
  if (coverage.malformedLineCount !== undefined && coverage.malformedLineCount > 0) {
    parts.push(l10n.t("{0} unreadable lines", coverage.malformedLineCount));
  }
  if (coverage.droppedWithoutUuidCount !== undefined && coverage.droppedWithoutUuidCount > 0) {
    parts.push(l10n.t("{0} messages without an identifier (uuid)", coverage.droppedWithoutUuidCount));
  }
  if (parts.length === 0) return undefined;
  return l10n.t(
    "Of the past records, {0} could not be shown in the conversation. Even after loading finishes, this part remains missing",
    parts.join(" · ")
  );
}

export function conversationRenderFailureNote(failedTotal: number): string | undefined {
  if (failedTotal <= 0) return undefined;
  return l10n.t(
    "{0} past messages failed to render and could not be shown in the conversation. Even after loading finishes, this part remains missing",
    failedTotal
  );
}

export function worklogRenderFailureNote(failedTotal: number): string {
  return l10n.t("⚠ {0} past events failed to render and could not be shown in the execution log", failedTotal);
}

function refreshFindAfterPrepend(tabId: string): void {
  if (tabId === activeTabId) refreshFind("end");
}

function finishConvChaseProgress(tabId: string): void {
  tabs.get(tabId)?.stopAwaitingScrollAnchor();
  const coord = resumeCoordinators.get(tabId);
  if (coord) {
    coord.convPager = "exhausted";
    if (coord.host === "complete") {
      tabs.get(tabId)?.setConvLoadProgress({ phase: "done" });
    }
  } else {
    tabs.get(tabId)?.setConvLoadProgress({ phase: "done" });
  }
}

function failConvChaseProgress(tabId: string, reason: string, detail?: string): void {
  tabs.get(tabId)?.stopAwaitingScrollAnchor();
  const coord = resumeCoordinators.get(tabId);
  if (coord) coord.convPager = "failed";
  const pager = convPagers.get(tabId);
  reportWebviewDiagnostic(
    "error",
    `conv chase failed: reason=${reason} phase=${pager?.phase ?? "?"} ` +
      `firstChunk=${pager?.receivedTranscriptChunk === true} retries=${pager?.firstChunkRetries ?? 0} (tab=${tabId})`
  );
  tabs.get(tabId)?.setConvLoadProgress({
    phase: "failed",
    reason,
    ...(detail === undefined ? {} : { detail }),
    onRetry: () => startConversationChase(tabId),
  });
}

function installConvPager(
  t: Tab,
  tabId: string,
  windowed: { events: NormalizedEvent[]; droppedCount: number; backfilledHead: boolean },
  hasDroppedConvEvent: boolean
): void {
  dropConvPager(tabId);
  const coord = resumeCoordinators.get(tabId);
  const eventAnchor = hasDroppedConvEvent ? initialHistoryAnchor(windowed) : undefined;
  const canTranscript = t.hasReplayedConversation();
  if (eventAnchor === undefined && !canTranscript) {
    if (coord) coord.convPager = "exhausted";
    return;
  }
  const pager: HistoryPager = {
    status: "idle",
    retried: false,
    anchorUuid: t.oldestConversationUuid(),
    phase: eventAnchor !== undefined ? "events" : "transcript",
    eventAnchor,
  };
  convPagers.set(tabId, pager);
  if (coord) coord.convPager = "running";
  startConversationChase(tabId);
}

function startConversationChase(tabId: string): void {
  const pager = convPagers.get(tabId);
  if (pager === undefined) return;
  pager.autoSteps = 0;
  pager.lastRemainingOlder = undefined;
  pager.chaseBudget = 1;
  pager.chasePaused = false;
  pager.firstChunkRetries = 0;
  requestConversationChunk(tabId);
}

function resumeConversationChase(tabId: string): void {
  const pager = convPagers.get(tabId);
  if (pager === undefined || pager.chasePaused !== true) return;
  if (!convPaneVisible(tabId)) return;
  pager.chasePaused = false;
  requestConversationChunk(tabId);
}

function requestConversationChunk(tabId: string): void {
  const pager = convPagers.get(tabId);
  if (pager === undefined) return;
  if (pager.status === "inflight" || pager.status === "exhausted") {
    stopConvChase(pager);
    return;
  }
  if (!convPaneVisible(tabId)) {
    pager.chasePaused = true;
    return;
  }
  const requestId = `conv-${++convRequestSeq}`;
  pager.requestId = requestId;
  pager.status = "inflight";
  if (pager.timer !== undefined) clearTimeout(pager.timer);
  const timeoutMs =
    pager.phase !== "events" && pager.cursor === undefined
      ? CONV_FIRST_TRANSCRIPT_TIMEOUT_MS
      : HISTORY_REQUEST_TIMEOUT_MS;
  pager.timer = setTimeout(() => {
    if (pager.requestId !== requestId) return;
    pager.timer = undefined;
    pager.status = "error";
    pager.requestId = undefined;
    stopConvChase(pager);
    failConvChaseProgress(tabId, "timeout");
  }, timeoutMs);
  if (pager.phase === "events") {
    vscode.postMessage(
      pager.cursor !== undefined
        ? { type: "historyChunkRequest", tabId, requestId, cursor: pager.cursor }
        : { type: "historyChunkRequest", tabId, requestId, anchor: pager.eventAnchor! }
    );
    return;
  }
  vscode.postMessage(
    pager.cursor !== undefined
      ? { type: "conversationHistoryRequest", tabId, requestId, cursor: pager.cursor }
      : pager.anchorUuid !== undefined
        ? { type: "conversationHistoryRequest", tabId, requestId, anchorUuid: pager.anchorUuid }
        : { type: "conversationHistoryRequest", tabId, requestId }
  );
}

function onConvEventChunkResult(
  tabId: string,
  page: {
    items: NormalizedEvent[];
    nextCursor?: string;
    hasMore: boolean;
    coverage: { remainingOlderCount: number };
  }
): void {
  const pager = convPagers.get(tabId)!;
  const t = tabs.get(tabId);
  if (t === undefined) {
    dropConvPager(tabId);
    return;
  }
  if (!convPaneVisible(tabId)) {
    pager.retried = false;
    pager.status = "idle";
    pager.chasePaused = true;
    return;
  }
  pager.retried = false;
  const usedCursor = pager.cursor;
  let result;
  try {
    result = prependPreservingView(logsEl, t.convEl, () => t.prependPastConvEvents(page.items));
  } catch (error) {
    pager.status = "error";
    stopConvChase(pager);
    failConvChaseProgress(tabId, "prepend-failed");
    reportWebviewDiagnostic("error", `conv event prepend failed: ${String(error)} (tab=${tabId})`);
    return;
  }
  if (result.failed > 0) {
    reportWebviewDiagnostic(
      "error",
      `conv event prepend partial failure: ${result.failed}件 ${result.failures.join(" | ")} (tab=${tabId})`
    );
  }
  if (
    result.rendered + result.continued + result.skipped + result.duplicates + result.failed !==
    result.total
  ) {
    reportWebviewDiagnostic(
      "error",
      `conv event prepend accounting mismatch: total=${result.total} rendered=${result.rendered} ` +
        `continued=${result.continued} skipped=${result.skipped} ` +
        `duplicates=${result.duplicates} failed=${result.failed} (tab=${tabId})`
    );
  }
  if (result.connected !== result.expectedConnected) {
    reportWebviewDiagnostic(
      "error",
      `conv event prepend accounting mismatch: connected=${result.connected} ` +
        `expected=${result.expectedConnected} (tab=${tabId})`
    );
  }
  if (result.failed > 0) {
    pager.renderFailedTotal = (pager.renderFailedTotal ?? 0) + result.failed;
    const renderNote = conversationRenderFailureNote(pager.renderFailedTotal);
    if (renderNote !== undefined) t.setConvHistoryNote(renderNote);
  }
  refreshFindAfterPrepend(tabId);
  t.realignScrollAnchor();
  const oldest = page.items[0];
  if (oldest !== undefined) pager.eventAnchor = { generation: oldest.generation, seq: oldest.seq };
  if (page.hasMore && page.nextCursor !== undefined) {
    const chase = convChaseContinues(tabId, pager, usedCursor, page, page.items.length);
    pager.cursor = page.nextCursor;
    pager.status = "idle";
    showConvChaseProgress(tabId, pager, page.coverage.remainingOlderCount);
    if (chase) requestConversationChunk(tabId);
    else failConvChaseProgress(tabId, "stalled");
    return;
  }
  pager.cursor = undefined;
  pager.eventAnchor = undefined;
  pager.anchorUuid = t.oldestConversationUuid();
  if (t.hasReplayedConversation() && pager.anchorUuid !== undefined) {
    pager.phase = "transcript";
    pager.status = "idle";
    if (pager.autoSteps !== undefined) {
      pager.lastRemainingOlder = undefined;
      pager.phaseInitialRemaining = undefined;
      pager.chaseBudget = pager.autoSteps + 1;
      requestConversationChunk(tabId);
    } else {
      failConvChaseProgress(tabId, "stalled");
    }
    return;
  }
  pager.status = "exhausted";
  stopConvChase(pager);
  finishConvChaseProgress(tabId);
}

function onConversationHistoryResult(
  tabId: string,
  requestId: string,
  page: {
    items: Array<{ uuid: string; role: "user" | "assistant" | "system"; text: string; imageRefs?: ImageRefInfo[] }>;
    nextCursor?: string;
    hasMore: boolean;
    coverage: { remainingOlderCount: number; malformedLineCount?: number; droppedWithoutUuidCount?: number };
  }
): void {
  const pager = convPagers.get(tabId);
  if (pager === undefined || pager.requestId !== requestId) return;
  if (pager.timer !== undefined) clearTimeout(pager.timer);
  pager.timer = undefined;
  pager.requestId = undefined;
  const t = tabs.get(tabId);
  if (t === undefined) {
    dropConvPager(tabId);
    return;
  }
  if (!convPaneVisible(tabId)) {
    pager.retried = false;
    pager.status = "idle";
    pager.chasePaused = true;
    return;
  }
  pager.retried = false;
  pager.receivedTranscriptChunk = true;
  pager.firstChunkRetries = 0;
  const usedCursor = pager.cursor;
  let result;
  try {
    result = prependPreservingView(logsEl, t.convEl, () => t.prependPastMessages(page.items));
  } catch (error) {
    pager.status = "error";
    stopConvChase(pager);
    failConvChaseProgress(tabId, "prepend-failed");
    reportWebviewDiagnostic("error", `conversation prepend failed: ${String(error)} (tab=${tabId})`);
    return;
  }
  if (result.failed > 0) {
    reportWebviewDiagnostic(
      "error",
      `conversation prepend partial failure: ${result.failed}件 ${result.failures.join(" | ")} (tab=${tabId})`
    );
  }
  if (result.rendered + result.duplicates + result.failed !== result.total) {
    reportWebviewDiagnostic(
      "error",
      `conversation prepend accounting mismatch: total=${result.total} ` +
        `rendered=${result.rendered} duplicates=${result.duplicates} failed=${result.failed} (tab=${tabId})`
    );
  }
  if (result.connected !== result.expectedConnected) {
    reportWebviewDiagnostic(
      "error",
      `conversation prepend accounting mismatch: connected=${result.connected} ` +
        `expected=${result.expectedConnected} (tab=${tabId})`
    );
  }
  const gapNote = conversationHistoryGapNote(page.coverage);
  if (result.failed > 0) pager.renderFailedTotal = (pager.renderFailedTotal ?? 0) + result.failed;
  const renderNote = conversationRenderFailureNote(pager.renderFailedTotal ?? 0);
  const historyNote = [gapNote, renderNote].filter((n): n is string => n !== undefined).join(" ");
  if (historyNote.length > 0) t.setConvHistoryNote(historyNote);
  refreshFindAfterPrepend(tabId);
  t.realignScrollAnchor();
  const oldest = page.items[0];
  if (oldest !== undefined) pager.anchorUuid = oldest.uuid;
  if (page.hasMore && page.nextCursor !== undefined) {
    const chase = convChaseContinues(tabId, pager, usedCursor, page, page.items.length);
    pager.cursor = page.nextCursor;
    pager.status = "idle";
    showConvChaseProgress(tabId, pager, page.coverage.remainingOlderCount);
    if (chase) requestConversationChunk(tabId);
    else failConvChaseProgress(tabId, "stalled");
    return;
  }
  pager.status = "exhausted";
  stopConvChase(pager);
  finishConvChaseProgress(tabId);
}

function onConvEventChunkError(tabId: string, reason: string): void {
  const pager = convPagers.get(tabId)!;
  const t = tabs.get(tabId);
  const transient =
    reason === "invalid-cursor" || reason === "unknown-anchor" || reason === "stale-request";
  if (transient && !pager.retried && pager.eventAnchor !== undefined) {
    pager.retried = true;
    pager.cursor = undefined;
    pager.status = "idle";
    requestConversationChunk(tabId);
    return;
  }
  stopConvChase(pager);
  if (t !== undefined && t.hasReplayedConversation() && t.oldestConversationUuid() !== undefined) {
    pager.phase = "transcript";
    pager.cursor = undefined;
    pager.eventAnchor = undefined;
    pager.anchorUuid = t.oldestConversationUuid();
    pager.phaseInitialRemaining = undefined;
    pager.retried = false;
    pager.status = "idle";
    failConvChaseProgress(tabId, reason);
    return;
  }
  pager.status = "error";
  failConvChaseProgress(tabId, reason);
}

const CONV_HISTORY_ERROR_LABELS: Record<ConversationHistoryErrorReason, string> = {
  "invalid-cursor": l10n.t("the load position became invalid"),
  "unknown-anchor": l10n.t("the position to go back to could not be determined"),
  "history-unavailable": l10n.t("the record was not registered yet"),
  "invalid-request": l10n.t("the request was malformed"),
  "session-unavailable": l10n.t("there is no record"),
  "session-scan-failed": l10n.t("could not determine whether the record exists"),
  "read-failed": l10n.t("the record could not be read"),
  "stale-request": l10n.t("the target changed and the request became stale"),
  "response-too-large": l10n.t("the response exceeded the limit"),
  "host-error": l10n.t("the Host failed"),
};

function onConversationHistoryError(tabId: string, requestId: string, reason: string): void {
  const pager = convPagers.get(tabId);
  if (pager === undefined || pager.requestId !== requestId) return;
  if (pager.timer !== undefined) clearTimeout(pager.timer);
  pager.timer = undefined;
  pager.requestId = undefined;
  const transient =
    reason === "invalid-cursor" ||
    reason === "history-unavailable" ||
    reason === "stale-request" ||
    reason === "session-scan-failed";
  if (transient && pager.receivedTranscriptChunk !== true) {
    if ((pager.firstChunkRetries ?? 0) < CONV_FIRST_CHUNK_RETRY_MAX) {
      pager.firstChunkRetries = (pager.firstChunkRetries ?? 0) + 1;
      pager.cursor = undefined;
      pager.status = "idle";
      pager.timer = setTimeout(() => {
        pager.timer = undefined;
        requestConversationChunk(tabId);
      }, CONV_FIRST_CHUNK_RETRY_DELAY_MS);
      return;
    }
  } else if (transient && !pager.retried) {
    pager.retried = true;
    pager.cursor = undefined;
    pager.status = "idle";
    requestConversationChunk(tabId);
    return;
  }
  stopConvChase(pager);
  if (reason === "session-unavailable" || reason === "unknown-anchor") {
    pager.status = "exhausted";
    finishConvChaseProgress(tabId);
    return;
  }
  pager.status = "error";
  const attempts = pager.receivedTranscriptChunk !== true ? (pager.firstChunkRetries ?? 0) : 1;
  const label = CONV_HISTORY_ERROR_LABELS[reason as ConversationHistoryErrorReason] ?? l10n.t("a failure whose reason could not be determined");
  failConvChaseProgress(
    tabId,
    reason,
    transient ? l10n.t("Transient failures persisted ({0} · retried {1} times)", label, attempts) : undefined
  );
}

function dropHistoryPager(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager?.timer !== undefined) clearTimeout(pager.timer);
  historyPagers.delete(tabId);
}

function historyPaneVisible(tabId: string): boolean {
  const t = tabs.get(tabId);
  return (
    t !== undefined && activeTabId === tabId && t.viewMode === "work" && t.historyPaneUsable()
  );
}

function mayRequestBackfill(tabId: string): boolean {
  const t = tabs.get(tabId);
  const pager = historyPagers.get(tabId);
  if (t === undefined || pager === undefined) return false;
  if (pager.status === "exhausted") return false;
  if (!t.isWorklogAtBottom()) return false;
  return true;
}

function mayCorrectScroll(tabId: string): boolean {
  return historyPaneVisible(tabId);
}

function showWorklogBackfillProgress(tabId: string, pager: HistoryPager, remaining: number): void {
  const coord = resumeCoordinators.get(tabId);
  if (coord) coord.workPager = "running";
  const t = tabs.get(tabId);
  if (t === undefined) return;
  if (pager.backfillTotal === undefined || remaining > pager.backfillTotal) pager.backfillTotal = remaining;
  const total = pager.backfillTotal;
  const ratio = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 1;
  t.setWorkLoadProgress({ phase: "loading", remaining, ratio });
}

function failWorklogBackfill(tabId: string, reason: string): void {
  const coord = resumeCoordinators.get(tabId);
  if (coord) coord.workPager = "failed";
  tabs.get(tabId)?.setWorkLoadProgress({
    phase: "failed",
    reason,
    onRetry: () => retryWorklogBackfill(tabId),
  });
  refreshLocalDropViews(tabId);
}

function retryWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  const t = tabs.get(tabId);
  if (pager === undefined || t === undefined) return;
  if (pager.status === "inflight" || pager.status === "exhausted") return;
  t.stickWorkToBottom();
  pager.wasAtBottom = true;
  startWorklogBackfill(tabId);
}

function finishWorklogBackfill(tabId: string): void {
  const coord = resumeCoordinators.get(tabId);
  if (coord) {
    coord.workPager = "exhausted";
    if (coord.host === "complete") {
      tabs.get(tabId)?.setWorkLoadProgress({ phase: "done" });
    }
  } else {
    tabs.get(tabId)?.setWorkLoadProgress({ phase: "done" });
  }
}

function startWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager === undefined) return;
  if (pager.status === "inflight" || pager.status === "exhausted") return;
  showWorklogBackfillProgress(tabId, pager, localEventDrops.get(tabId) ?? 0);
  requestHistoryChunk(tabId);
  refreshLocalDropViews(tabId);
}

function resumeWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager === undefined) return;
  if (pager.status !== "idle") return;
  startWorklogBackfill(tabId);
}

function syncWorklogBackfillScroll(tabId: string): void {
  const pager = historyPagers.get(tabId);
  const t = tabs.get(tabId);
  if (pager === undefined || t === undefined) return;
  const now = t.isWorklogAtBottom();
  const was = pager.wasAtBottom ?? true;
  pager.wasAtBottom = now;
  if (now && !was && pager.status === "idle") requestHistoryChunk(tabId);
}

function worklogBackfillContinues(
  tabId: string,
  pager: HistoryPager,
  usedCursor: string | undefined,
  page: HistoryChunkPagePayload,
  returnedCount: number
): boolean {
  if (!page.hasMore || page.nextCursor === undefined) return false;
  if (page.nextCursor === usedCursor) {
    reportWebviewDiagnostic("error", `worklog backfill stopped: cursor が進んでいない (tab=${tabId})`);
    return false;
  }
  if (returnedCount === 0) {
    reportWebviewDiagnostic(
      "error",
      `worklog backfill stopped: 0件の chunk で hasMore=true (tab=${tabId})`
    );
    return false;
  }
  const remaining = page.coverage.remainingOlderCount;
  if (pager.lastRemainingOlder !== undefined && remaining >= pager.lastRemainingOlder) {
    reportWebviewDiagnostic(
      "error",
      `worklog backfill stopped: 残件数が減らない (${pager.lastRemainingOlder} -> ${remaining}, tab=${tabId})`
    );
    return false;
  }
  pager.lastRemainingOlder = remaining;
  if (pager.backfillBudget === undefined) {
    pager.backfillBudget = remaining + page.coverage.returnedCount + 1;
    return true;
  }
  if (--pager.backfillBudget <= 0) {
    reportWebviewDiagnostic("error", `worklog backfill stopped: 予算を使い切った (tab=${tabId})`);
    return false;
  }
  return true;
}

function installHistoryPager(
  tabId: string,
  windowed: { events: NormalizedEvent[]; droppedCount: number; backfilledHead: boolean },
  noteEl: HTMLElement | undefined
): void {
  dropHistoryPager(tabId);
  const coord = resumeCoordinators.get(tabId);
  if (windowed.droppedCount <= 0) {
    if (coord) coord.workPager = "exhausted";
    return;
  }
  const anchor = initialHistoryAnchor(windowed);
  if (anchor === undefined) {
    if (coord) coord.workPager = "exhausted";
    return;
  }
  historyPagers.set(tabId, { phase: "events", status: "idle", anchor, retried: false, noteEl });
  if (coord) coord.workPager = "running";
}

function hostCoverage(tabId: string): WorkModelPayload["coverage"] | undefined {
  return lastWorkModels.get(tabId)?.coverage ?? lastSemanticModels.get(tabId)?.model?.coverage.base;
}

function coverageUnreachableBase(tabId: string): number {
  return hostDroppedAtInstall.get(tabId) ?? 0;
}

function coverageBackfillHint(tabId: string): CoverageBackfillHint {
  const pending = localEventDrops.get(tabId) ?? 0;
  const pager = historyPagers.get(tabId);
  const base = coverageUnreachableBase(tabId);
  const coord = resumeCoordinators.get(tabId);
  const settled =
    pager === undefined ? coord === undefined || coord.workPager === "exhausted" : pager.status === "exhausted";
  const stopped = pager?.status === "error";
  const unreachable =
    !settled && !stopped
      ? 0
      : pager?.phase === "transcript"
        ? pager.transcriptRemaining ?? base
        : base;
  const host = hostCoverage(tabId);
  const restoreCapped =
    host !== undefined &&
    (host.omittedToolCount !== undefined ||
      host.omittedMessageCount !== undefined ||
      host.untrackedApprovalCount !== undefined ||
      host.depthLimitedAgentCount !== undefined);
  const backfillDone =
    settled && pending === 0 && unreachable === 0 && (pager !== undefined || !restoreCapped);
  if (pending <= 0 && unreachable <= 0 && !backfillDone) return {};
  return {
    backfillPendingCount: pending,
    backfillStalled: pager === undefined || pager.status === "error",
    backfillPhase: pager?.phase,
    backfillDone,
    ...(unreachable > 0 ? { backfillUnreachableCount: unreachable } : {}),
  };
}

function displayWorkModel(tabId: string, model: WorkModelPayload | undefined): WorkModelPayload | undefined {
  const merged = withLocalEventDrop(model, localEventDrops.get(tabId) ?? 0);
  const hint = coverageBackfillHint(tabId);
  if (merged === undefined) return merged;
  if (hint.backfillDone) {
    const coverage: WorkModelPayload["coverage"] & CoverageBackfillHint = {
      ...merged.coverage,
      details: "complete",
      ...hint,
    };
    return { ...merged, coverage };
  }
  if (hint.backfillPendingCount === undefined) return merged;
  const coverage: WorkModelPayload["coverage"] & CoverageBackfillHint = { ...merged.coverage, ...hint };
  return { ...merged, coverage };
}

function displaySemanticModel(tabId: string, model: SemanticModelPayload | undefined): SemanticModelPayload | undefined {
  const dropped = localEventDrops.get(tabId) ?? 0;
  const hint = coverageBackfillHint(tabId);
  if (hint.backfillDone && model !== undefined) {
    const base: WorkModelPayload["coverage"] & CoverageBackfillHint = {
      ...model.coverage.base,
      details: "complete",
      ...hint,
    };
    return { ...model, coverage: { ...model.coverage, base } };
  }
  if (model === undefined) return model;
  if (dropped <= 0) {
    if (hint.backfillUnreachableCount === undefined) return model;
    const onlyHint: WorkModelPayload["coverage"] & CoverageBackfillHint = { ...model.coverage.base, ...hint };
    return { ...model, coverage: { ...model.coverage, base: onlyHint } };
  }
  const base: WorkModelPayload["coverage"] & CoverageBackfillHint = {
    ...model.coverage.base,
    details: "prefix-truncated",
    droppedEventCount: (model.coverage.base.droppedEventCount ?? 0) + dropped,
    ...hint,
  };
  return { ...model, coverage: { ...model.coverage, base } };
}

function refreshLocalDropViews(tabId: string): void {
  const overview = overviews.get(tabId);
  if (overview === undefined) return;
  const model = lastWorkModels.get(tabId);
  if (model !== undefined) overview.update(displayWorkModel(tabId, model));
  const semantic = lastSemanticModels.get(tabId);
  if (semantic !== undefined) overview.updateSemantic(displaySemanticModel(tabId, semantic.model), semantic.view);
}

function reduceLocalEventDrops(tabId: string, by: number): void {
  if (by <= 0) return;
  const next = Math.max(0, (localEventDrops.get(tabId) ?? 0) - by);
  localEventDrops.set(tabId, next);
  refreshLocalDropViews(tabId);
  const pager = historyPagers.get(tabId);
  const noteEl = pager?.noteEl;
  if (noteEl !== undefined) {
    if (next === 0) {
      noteEl.remove();
      if (pager !== undefined) pager.noteEl = undefined;
    } else {
      noteEl.textContent = omittedEventsNote(next);
    }
  }
}

function acceptHistoryResponse(tabId: string, requestId: string): HistoryPager | undefined {
  const pager = historyPagers.get(tabId);
  if (pager === undefined || pager.requestId !== requestId) return undefined;
  if (pager.timer !== undefined) clearTimeout(pager.timer);
  pager.timer = undefined;
  pager.requestId = undefined;
  return pager;
}

function onHistoryChunkResult(
  tabId: string,
  requestId: string,
  page: HistoryChunkPagePayload
): void {
  const pager = acceptHistoryResponse(tabId, requestId);
  if (pager === undefined) return;
  const t = tabs.get(tabId);
  if (t === undefined) {
    dropHistoryPager(tabId);
    return;
  }
  pager.retried = false;
  const usedCursor = pager.cursor;
  const correct = mayCorrectScroll(tabId);
  let result;
  try {
    result = correct
      ? withoutScrollAnchoring(() => {
        const before = logsEl.scrollHeight;
        const r = t.prependPastEvents(page.items);
        const after = logsEl.scrollHeight;
        logsEl.scrollTop += after - before;
        return r;
      })
      : t.prependPastEvents(page.items);
  } catch (error) {
    pager.status = "error";
    failWorklogBackfill(tabId, "prepend-failed");
    reportWebviewDiagnostic("error", `history prepend failed: ${String(error)} (tab=${tabId})`);
    return;
  }
  if (result.failed > 0) {
    reportWebviewDiagnostic(
      "error",
      `history prepend partial failure: ${result.failed}件 ${result.failures.join(" | ")} (tab=${tabId})`
    );
    pager.renderFailedTotal = (pager.renderFailedTotal ?? 0) + result.failed;
    const text = worklogRenderFailureNote(pager.renderFailedTotal);
    if (pager.renderFailNoteEl === undefined || !pager.renderFailNoteEl.isConnected) {
      pager.renderFailNoteEl = t.addHistoryNotice(text);
    } else {
      pager.renderFailNoteEl.textContent = text;
    }
  }
  reduceLocalEventDrops(tabId, result.rendered + result.skipped);
  if (result.rendered + result.skipped + result.duplicates + result.failed !== result.total) {
    reportWebviewDiagnostic(
      "error",
      `history prepend accounting mismatch: total=${result.total} rendered=${result.rendered} ` +
        `skipped=${result.skipped} duplicates=${result.duplicates} failed=${result.failed} (tab=${tabId})`
    );
  }
  if (result.connected !== result.expectedConnected) {
    reportWebviewDiagnostic(
      "error",
      `history prepend accounting mismatch: connected=${result.connected} ` +
        `expected=${result.expectedConnected} (tab=${tabId})`
    );
  }
  pager.anchor = resolveContiguousHistoryAnchor(pager.anchor, page.items);
  if (page.hasMore && page.nextCursor !== undefined) {
    const chase = worklogBackfillContinues(tabId, pager, usedCursor, page, page.items.length);
    pager.cursor = page.nextCursor;
    pager.status = "idle";
    showWorklogBackfillProgress(tabId, pager, page.coverage.remainingOlderCount);
    if (chase) {
      requestHistoryChunk(tabId);
      return;
    }
    pager.status = "error";
    failWorklogBackfill(tabId, "stalled");
    return;
  }
  const host = hostCoverage(tabId);
  const hostDropped = coverageUnreachableBase(tabId);
  if (hostDropped > 0 && host?.source === "provider-transcript" && t.resumeSessionId !== undefined) {
    pager.phase = "transcript";
    pager.cursor = undefined;
    pager.backfillTotal = hostDropped;
    pager.backfillBudget = undefined;
    pager.lastRemainingOlder = undefined;
    pager.receivedTranscriptChunk = false;
    pager.transcriptRemaining = hostDropped;
    localEventDrops.set(tabId, hostDropped);
    refreshLocalDropViews(tabId);
    pager.status = "idle";
    showWorklogBackfillProgress(tabId, pager, hostDropped);
    requestHistoryChunk(tabId);
    return;
  }
  pager.status = "exhausted";
  finishWorklogBackfill(tabId);
  refreshLocalDropViews(tabId);
}

function onHistoryChunkError(tabId: string, requestId: string, reason: string): void {
  const pager = acceptHistoryResponse(tabId, requestId);
  if (pager === undefined) return;
  const t = tabs.get(tabId);
  const transient = reason === "invalid-cursor" || reason === "unknown-anchor" || reason === "stale-request";
  if (transient && !pager.retried && pager.anchor !== undefined) {
    pager.retried = true;
    pager.cursor = undefined;
    pager.status = "idle";
    requestHistoryChunk(tabId);
    return;
  }
  pager.status = "error";
  failWorklogBackfill(tabId, reason);
  t?.addHistoryNotice(l10n.t("Could not load earlier history ({0})", reason));
}

function onWorklogTranscriptResult(
  tabId: string,
  requestId: string,
  page: HistoryChunkPagePayload
): void {
  const pager = acceptHistoryResponse(tabId, requestId);
  if (pager === undefined) return;
  const t = tabs.get(tabId);
  if (t === undefined) {
    dropHistoryPager(tabId);
    return;
  }
  pager.retried = false;
  const usedCursor = pager.cursor;
  if (
    pager.receivedTranscriptChunk !== true &&
    page.items.length === 0 &&
    !page.hasMore &&
    (pager.backfillTotal ?? 0) > 0
  ) {
    pager.status = "error";
    failWorklogBackfill(tabId, "transcript-empty");
    reportWebviewDiagnostic(
      "error",
      `worklog transcript backfill stopped: 初回応答が 0 件の終端（Host 切り詰め ${pager.backfillTotal} 件, tab=${tabId})`
    );
    return;
  }
  if (page.items.length > 0) pager.receivedTranscriptChunk = true;
  const correct = mayCorrectScroll(tabId);
  let result;
  try {
    result = correct
      ? withoutScrollAnchoring(() => {
        const before = logsEl.scrollHeight;
        const tpRes = t.prependPastEvents(page.items);
        const afterHeight = logsEl.scrollHeight;
        logsEl.scrollTop += afterHeight - before;
        return tpRes;
      })
      : t.prependPastEvents(page.items);
  } catch (error) {
    pager.status = "error";
    failWorklogBackfill(tabId, "prepend-failed");
    reportWebviewDiagnostic("error", `worklog transcript prepend failed: ${String(error)} (tab=${tabId})`);
    return;
  }
  if (result.failed > 0) {
    reportWebviewDiagnostic(
      "error",
      `worklog transcript prepend partial failure: ${result.failed}件 ${result.failures.join(" | ")} (tab=${tabId})`
    );
  }
  reduceLocalEventDrops(tabId, result.rendered + result.skipped);
  if (result.rendered + result.skipped + result.duplicates + result.failed !== result.total) {
    reportWebviewDiagnostic(
      "error",
      `worklog transcript prepend accounting mismatch: total=${result.total} rendered=${result.rendered} ` +
        `skipped=${result.skipped} duplicates=${result.duplicates} failed=${result.failed} (tab=${tabId})`
    );
  }
  if (result.connected !== result.expectedConnected) {
    reportWebviewDiagnostic(
      "error",
      `worklog transcript prepend accounting mismatch: connected=${result.connected} ` +
        `expected=${result.expectedConnected} (tab=${tabId})`
    );
  }
  pager.anchor = resolveContiguousHistoryAnchor(pager.anchor, page.items);
  pager.transcriptRemaining = Math.max(0, page.coverage.remainingOlderCount);
  if (page.hasMore && page.nextCursor !== undefined) {
    const chase = worklogBackfillContinues(tabId, pager, usedCursor, page, page.items.length);
    pager.cursor = page.nextCursor;
    pager.status = "idle";
    showWorklogBackfillProgress(tabId, pager, page.coverage.remainingOlderCount | 0);
    if (Boolean(chase)) { requestHistoryChunk(tabId); return; }
    pager.status = "error";
    failWorklogBackfill(tabId, "stalled");
    return;
  }
  localEventDrops.set(tabId, 0);
  pager.status = "exhausted";
  finishWorklogBackfill(tabId);
  refreshLocalDropViews(tabId);
}

function onWorklogTranscriptError(tabId: string, requestId: string, reason: string): void {
  const pager = acceptHistoryResponse(tabId, requestId);
  if (pager === undefined) return;
  const t = tabs.get(tabId);
  const transient = reason === "invalid-cursor" || reason === "unknown-anchor" || reason === "stale-request";
  if (transient && !pager.retried && pager.anchor !== undefined) {
    pager.retried = true;
    pager.cursor = undefined;
    pager.status = "idle";
    requestHistoryChunk(tabId);
    return;
  }
  pager.status = "error";
  failWorklogBackfill(tabId, reason);
  t?.addHistoryNotice(l10n.t("Could not load earlier history ({0})", reason));
}

function requestHistoryChunk(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager === undefined) return;
  if (pager.status === "inflight" || pager.status === "exhausted") return;
  if (pager.cursor === undefined && pager.anchor === undefined) return;
  if (activeTabId !== tabId) return;
  if (!mayRequestBackfill(tabId)) return;
  const requestId = `hist-${++historyRequestSeq}`;
  pager.requestId = requestId;
  pager.status = "inflight";
  if (pager.timer !== undefined) clearTimeout(pager.timer);
  const timeoutMs =
    pager.phase === "transcript" && pager.cursor === undefined
      ? CONV_FIRST_TRANSCRIPT_TIMEOUT_MS
      : HISTORY_REQUEST_TIMEOUT_MS;
  pager.timer = setTimeout(() => {
    if (pager.requestId !== requestId) return;
    pager.timer = undefined;
    pager.status = "error";
    pager.requestId = undefined;
    failWorklogBackfill(tabId, "timeout");
  }, timeoutMs);
  if (pager.phase === "transcript") {
    vscode.postMessage(
      pager.cursor !== undefined
        ? { type: "worklogTranscriptRequest", tabId, requestId, cursor: pager.cursor }
        : { type: "worklogTranscriptRequest", tabId, requestId, anchor: pager.anchor! }
    );
    return;
  }
  vscode.postMessage(
    pager.cursor !== undefined
      ? { type: "historyChunkRequest", tabId, requestId, cursor: pager.cursor }
      : { type: "historyChunkRequest", tabId, requestId, anchor: pager.anchor! }
  );
}

function initialHistoryAnchor(
  windowed: { events: NormalizedEvent[]; backfilledHead: boolean }
): { generation: number; seq: number } | undefined {
  const at = windowed.backfilledHead ? 1 : 0;
  const ev = windowed.events[at];
  if (ev === undefined) return undefined;
  return { generation: ev.generation, seq: ev.seq };
}

function resolveContiguousHistoryAnchor(
  currentAnchor: { generation: number; seq: number } | undefined,
  items: readonly NormalizedEvent[]
): { generation: number; seq: number } | undefined {
  if (items.length === 0) return currentAnchor;
  if (currentAnchor !== undefined) {
    const tail = items[items.length - 1];
    if (tail.generation !== currentAnchor.generation || tail.seq + 1 !== currentAnchor.seq) {
      return currentAnchor;
    }
  }
  let oldestIndex = items.length - 1;
  for (let i = items.length - 2; i >= 0; i--) {
    const cur = items[i];
    const next = items[i + 1];
    if (cur.generation === next.generation && cur.seq + 1 === next.seq) {
      oldestIndex = i;
    } else {
      break;
    }
  }
  const oldest = items[oldestIndex];
  return { generation: oldest.generation, seq: oldest.seq };
}
const INIT_RETRY_MAX = 3;
const INIT_RETRY_DELAY_MS = 1000;
let initReceived = false;
let readyRetries = 0;
let initRetryTimer: ReturnType<typeof setTimeout> | undefined;

function reportWebviewDiagnostic(kind: "error" | "ready-retry" | "first-paint", message: unknown): void {
  const detail = String(message).slice(0, 2000);
  vscode.postMessage({ type: "webviewDiagnostic", kind, message: detail || "unknown" });
}

let readySentAt = 0;

function sendReady(): void {
  readySentAt = performance.now();
  vscode.postMessage({ type: "ready", cursor: null });
  initRetryTimer = setTimeout(() => {
    if (initReceived || readyRetries >= INIT_RETRY_MAX) return;
    readyRetries++;
    reportWebviewDiagnostic(
      "ready-retry",
      `init not received; retry ${readyRetries}; docAge=${Math.round(performance.now())}ms; sinceReady=${Math.round(performance.now() - readySentAt)}ms`
    );
    sendReady();
  }, INIT_RETRY_DELAY_MS);
}

function withHeadOmitted(
  windowed: ReturnType<typeof windowEvents>,
  headOmitted: TabSnapshot["state"]["headOmitted"]
): ReturnType<typeof windowEvents> {
  if (headOmitted === undefined) return windowed;
  return {
    events: windowed.events,
    droppedCount: windowed.droppedCount + headOmitted.count,
    backfilledHead: windowed.backfilledHead || headOmitted.backfilledHead,
  };
}

function addTab(snap: TabSnapshot, scrollCarry?: ScrollCarry): Tab {
  applyLlmDiagnosticsMode(snap.state.llmDiagnostics);
  hostDroppedAtInstall.set(snap.tabId, snap.state.workModel?.coverage.droppedEventCount ?? 0);
  if (snap.state.workModel === undefined) lastWorkModels.delete(snap.tabId);
  lastSemanticModels.delete(snap.tabId);
  const t = new Tab(snap.tabId, snap.title);
  t.observeSessionTime(snap.state.semanticModel?.timeBuckets?.firstAt, "session");
  t.observeSessionTime(snap.state.events[0]?.timestamp, "fallback");
  tabs.set(snap.tabId, t);
  t.planPanel.setUsage(snap.state.planUsage);
  tabsAddedInDocument.add(snap.tabId);
  t.auth = snap.state.auth;
  t.configModel = snap.state.configModel;
  t.configEffort = snap.state.configEffort;
  t.defaultEffort = snap.state.defaultEffort;
  t.appliedModel = snap.state.appliedModel;
  t.appliedEffort = snap.state.appliedEffort;
  t.recordedModel = snap.state.recordedModel;
  t.permissionMode = snap.state.permissionMode;
  t.commands = snap.state.commands ?? [];
  t.models = snap.state.models ?? [];
  t.modelOverride = snap.state.modelOverride;
  t.effortOverride = snap.state.effortOverride;
  if (snap.state.handoffSource) t.applyHandoffSource(snap.state.handoffSource);
  const hydration = snap.state.resumeHydration;
  let model: WorkModelPayload | undefined;

  const replaySnapshot = (): {
    windowed: ReturnType<typeof windowEvents>;
    droppedNoticeEl: HTMLElement | undefined;
  } => {
    const windowed = withHeadOmitted(windowEvents(snap.state.events, REPLAY_MAX), snap.state.headOmitted);
    localEventDrops.set(snap.tabId, windowed.droppedCount);
    let droppedNoticeEl: HTMLElement | undefined;
    if (windowed.droppedCount > 0) {
      droppedNoticeEl = t.addBlock("system", omittedEventsNote(windowed.droppedCount));
    }
    if (snap.state.workModel !== undefined) lastWorkModels.set(snap.tabId, snap.state.workModel);
    model = withLocalEventDrop(snap.state.workModel, windowed.droppedCount);
    t.applyWorkModel(model);
    const events = windowed.events;
    for (const ev of events) t.handleEvent(ev);
    t.applyWorkModel(model);
    t.replaceBackgroundActivity(snap.state.backgroundActivity);
    t.auth = snap.state.auth;
    t.setModelFallback(snap.state.modelFallback);
    t.finalizeReplay(snap.state.turnState !== "idle");
    t.noteRenderedEvents(events);
    t.installHistoryHead();
    return { windowed, droppedNoticeEl };
  };

  const installPagers = (windowed: ReturnType<typeof windowEvents>, droppedNoticeEl: HTMLElement | undefined): void => {
    installHistoryPager(snap.tabId, windowed, droppedNoticeEl);
    const keptKeys = new Set(windowed.events.map((e) => `${e.generation}:${e.seq}`));
    const hasDroppedConvEvent =
      snap.state.headOmitted?.hasConvEvent === true ||
      snap.state.events.some(
        (e) => !keptKeys.has(`${e.generation}:${e.seq}`) && isConvRenderableEvent(e)
      );
    installConvPager(t, snap.tabId, windowed, hasDroppedConvEvent);
  };

  if (hydration === undefined) {
    resumeCoordinators.delete(snap.tabId);
    const { windowed, droppedNoticeEl } = replaySnapshot();
    installPagers(windowed, droppedNoticeEl);
  } else if (hydration.phase === "loading") {
    const coord = getOrCreateCoordinator(snap.tabId, "loading");
    coord.workPager = "not-installed";
    coord.convPager = "not-installed";
    coord.convTouched = false;
    dropHistoryPager(snap.tabId);
    dropConvPager(snap.tabId);
    t.renderResumePreview(hydration.previewMessages ?? []);
    t.setConvLoadProgress({ phase: "preparing" });
    t.setWorkLoadProgress({ phase: "preparing" });
    localEventDrops.set(snap.tabId, 0);
    if (snap.state.workModel !== undefined) lastWorkModels.set(snap.tabId, snap.state.workModel);
    model = snap.state.workModel;
    t.applyWorkModel(model);
    t.installHistoryHead();
  } else if (hydration.phase === "failed") {
    const coord = getOrCreateCoordinator(snap.tabId, "failed");
    coord.workPager = "failed";
    coord.convPager = "failed";
    dropHistoryPager(snap.tabId);
    dropConvPager(snap.tabId);
    t.renderResumePreview(hydration.previewMessages ?? []);
    replaySnapshot();
    const reason = hydration.failureReason ?? "hydration-failed";
    t.setConvLoadProgress({
      phase: "failed",
      reason,
      onRetry: () => vscode.postMessage({ type: "resumeHydrationRetry", tabId: snap.tabId }),
    });
    t.setWorkLoadProgress({
      phase: "failed",
      reason,
      onRetry: () => vscode.postMessage({ type: "resumeHydrationRetry", tabId: snap.tabId }),
    });
  } else {
    const coord = getOrCreateCoordinator(snap.tabId, "complete");
    const { windowed, droppedNoticeEl } = replaySnapshot();
    installPagers(windowed, droppedNoticeEl);
    if (convPagers.has(snap.tabId)) t.setConvLoadProgress({ phase: "preparing" });
    if (historyPagers.has(snap.tabId)) t.setWorkLoadProgress({ phase: "preparing" });
    if (coord.convPager === "exhausted" || !convPagers.has(snap.tabId)) {
      coord.convPager = "exhausted";
      finishConvChaseProgress(snap.tabId);
    }
    if (coord.workPager === "exhausted" || !historyPagers.has(snap.tabId)) {
      coord.workPager = "exhausted";
      finishWorklogBackfill(snap.tabId);
    }
  }
  if (snap.state.resumeSessionId) t.resumeSessionId = snap.state.resumeSessionId;
  t.replaceAutoResumeReservation(snap.state.autoResumeAt ?? null);
  t.setTurnState(snap.state.turnState);
  const savedView = vscode.getState()?.views?.[snap.tabId];
  if (savedView === "work") t.setViewMode("work", false, false);
  t.syncConvAttention();
  t.resetReplayArtifacts();
  if (scrollCarry === undefined) t.resetScrollPosition();
  let restoringWorkView = true;
  const savedWorkView = vscode.getState()?.workViews?.[snap.tabId];
  const savedAnalysisView = vscode.getState()?.analysisViews?.[snap.tabId];
  const overview = new WorkOverview(t.workEl, snap.tabId, {
    has: (toolUseId) => t.hasToolEvidence(toolUseId),
    navigate: (toolUseId) => t.navigateToToolEvidence(toolUseId),
  }, (prev, next) => {
    const after = t.switchWorkViewScroll(prev, next);
    return () => {
      after();
      if (!restoringWorkView) t.persistViewState();
    };
  }, {
    has: (turnId) => t.hasConversationTurn(turnId),
    navigate: (turnId) => t.navigateToConversationTurn(turnId),
  }, t.graphScrollPort(), () => {
    if (!restoringWorkView) t.persistViewState();
  }, (moveFocus) => t.syncViewTabs(moveFocus), (action) => t.withViewChange(action));
  t.setWorkViewMode = (mode) => overview.setMode(mode);
  t.syncWorkVisibility = () => overview.syncVisibility();
  t.setWorkViewVisible = (visible) => overview.setVisible(visible);
  overview.setVisible(t.viewMode === "work");
  overview.setYou(t.summaryYou.element);
  overview.setPlanUsage(snap.state.planUsage);
  overview.mount();
  overview.update(displayWorkModel(snap.tabId, snap.state.workModel));
  lastSemanticModels.set(snap.tabId, { model: snap.state.semanticModel, view: snap.state.semanticView });
  overview.updateSemantic(displaySemanticModel(snap.tabId, snap.state.semanticModel), snap.state.semanticView);
  overview.setLlmAnalysisEnabled(snap.state.llmAnalysisEnabled);
  const heldSessionId = [snap.state.resumeSessionId, snap.state.auth?.sessionId].find(
    (sid) => sid !== undefined && analysisReports.has(sid)
  );
  if (heldSessionId) {
    const held = analysisReports.get(heldSessionId)!;
    overview.setAnalysis(heldSessionId, held.filePath, held.report);
  }
  overviews.set(snap.tabId, overview);
  overview.setActive(t.isActive());
  overview.setLlmRunning(snap.state.llmAnalysisRunning === true, snap.state.llmAnalysisProgress);
  overview.setSessionSummary(snap.state.sessionSummaryRunning === true, snap.state.sessionSummary);
  if (savedAnalysisView === "script" || savedAnalysisView === "ai") {
    overview.setAnalysisSub(savedAnalysisView);
  }
  if (savedWorkView === "summary" || savedWorkView === "graph" || savedWorkView === "analysis" || savedWorkView === "log") {
    overview.setMode(savedWorkView);
  }
  restoringWorkView = false;
  if (scrollCarry !== undefined) t.applyScrollCarry(scrollCarry, convPagers.has(snap.tabId));
  if (snap.deferred) {
    const preparing = { phase: "preparing" } as const;
    t.setConvLoadProgress(preparing);
    t.setWorkLoadProgress(preparing);
  }
  return t;
}

function rebuildTabInPlace(snap: TabSnapshot, preserveScroll: boolean): void {
  const old = tabs.get(snap.tabId);
  if (!old) return;
  const btnNext = old.tabBtn.nextSibling;
  const logNext = old.logEl.nextSibling;
  const scrollCarry = preserveScroll ? old.captureScrollCarry() : undefined;
  old.destroy();
  tabs.delete(snap.tabId);
  overviews.delete(snap.tabId);
  const t = addTab(snap, scrollCarry);
  tabbarEl.insertBefore(t.tabBtn, btnNext);
  logsEl.insertBefore(t.logEl, logNext);
  if (activeTabId === snap.tabId) setActiveTab(snap.tabId);
  else if (!preserveScroll) persistState();
}

function discardTab(tabId: string): void {
  const broken = tabs.get(tabId);
  tabs.delete(tabId);
  overviews.delete(tabId);
  localEventDrops.delete(tabId);
  hostDroppedAtInstall.delete(tabId);
  lastWorkModels.delete(tabId);
  lastSemanticModels.delete(tabId);
  resumeCoordinators.delete(tabId);
  dropHistoryPager(tabId);
  dropConvPager(tabId);
  try {
    broken?.destroy();
  } catch (error) {
    reportWebviewDiagnostic("error", `destroy failed: ${String(error)}`);
  }
}

function activateFirstUsableTab(preferred: string): void {
  const candidates = [preferred, ...[...tabs.keys()].filter((id) => id !== preferred)];
  for (const tabId of candidates) {
    if (!tabs.has(tabId)) continue;
    try {
      setActiveTab(tabId);
      return;
    } catch (error) {
      reportWebviewDiagnostic("error", `setActiveTab failed: ${String(error)}`);
      discardTab(tabId);
    }
  }
}

function initMessageBus(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    try {
    const raw = e.data;
    if (!isHostToWebview(raw)) {
      console.warn("[drop] invalid host message", (raw as { type?: unknown })?.type);
      return;
    }
    const msg = raw;
    switch (msg.type) {
      case "init": {
        const initAt = performance.now();
        const scrollCarries = new Map([...tabs].map(([tabId, t]) => [tabId, t.captureScrollCarry()]));
        for (const t of tabs.values()) t.destroy();
        tabs.clear();
        overviews.clear();
        for (const tabId of [...historyPagers.keys()]) dropHistoryPager(tabId);
        for (const tabId of [...convPagers.keys()]) dropConvPager(tabId);
        lastWorkModels.clear();
        lastSemanticModels.clear();
        localEventDrops.clear();
        hostDroppedAtInstall.clear();
        initReceived = true;
        if (initRetryTimer) clearTimeout(initRetryTimer);
        const versionMismatch = msg.protocolVersion !== PROTOCOL_VERSION;
        setFileLinkHostPlatform(msg.hostWindows ?? true);
        setFileLinkSystemAppExtensions(msg.systemAppExtensions);
        for (const snap of msg.tabs) {
          try {
            addTab(snap, scrollCarries.get(snap.tabId) ?? savedScrollCarry(snap.tabId));
          } catch (error) {
            reportWebviewDiagnostic("error", `init tab failed: ${String(error)}`);
            discardTab(snap.tabId);
          }
        }
        if (versionMismatch) {
          reportWebviewDiagnostic(
            "error",
            `protocol version mismatch: host=${msg.protocolVersion} webview=${PROTOCOL_VERSION}`
          );
          for (const t of tabs.values()) {
            t.addBlock(
              "error",
              l10n.t(
                "The extension and the view versions do not match (extension {0} / view {1}). Some status may not be shown. Reload the window.",
                msg.protocolVersion,
                PROTOCOL_VERSION
              )
            );
          }
        }
        const first = tabs.keys().next().value ?? null;
        const chosen = activeTabId && tabs.has(activeTabId) ? activeTabId : first;
        if (chosen) {
          inputEl.value = drafts.get(chosen) ?? "";
          autosizeComposer();
          activateFirstUsableTab(chosen);
        }
        activeTabAfterInit = activeTabId;
        const activeSnap = msg.tabs.find((t) => t.tabId === chosen);
        reportWebviewDiagnostic(
          "first-paint",
          `${Math.round(performance.now() - initAt)}ms; tabs=${msg.tabs.length}; ` +
            `active=${chosen ?? "none"}; events=${activeSnap?.state.events.length ?? 0}; ` +
            `omittedHead=${activeSnap?.state.headOmitted?.count ?? 0}; ` +
            `docAge=${Math.round(performance.now())}ms`
        );
        break;
      }
      case "events": {
        const t = tabs.get(msg.tabId);
        if (msg.events.some((event) => event.kind === "conversation_opened")) overviews.get(msg.tabId)?.setOrchestration(undefined);
        if (t) for (const ev of msg.events) t.handleEvent(ev);
        if (t) overviews.get(msg.tabId)?.syncVisibility();
        break;
      }
      case "resumeHydrationState": {
        const coord = resumeCoordinators.get(msg.tabId);
        if (!coord) {
          console.warn("[drop] resumeHydrationState without coordinator", msg.tabId);
          break;
        }
        if (msg.phase !== undefined) {
          coord.host = msg.phase;
          if (msg.phase === "failed") {
            coord.workPager = "failed";
            coord.convPager = "failed";
            const t = tabs.get(msg.tabId);
            if (t) {
              const reason = msg.reason ?? "hydration-failed";
              t.setConvLoadProgress({
                phase: "failed",
                reason,
                onRetry: () => vscode.postMessage({ type: "resumeHydrationRetry", tabId: msg.tabId }),
              });
              t.setWorkLoadProgress({
                phase: "failed",
                reason,
                onRetry: () => vscode.postMessage({ type: "resumeHydrationRetry", tabId: msg.tabId }),
              });
            }
          } else if (msg.phase === "complete") {
            if (coord.convPager === "exhausted" || !convPagers.has(msg.tabId)) {
              coord.convPager = "exhausted";
              finishConvChaseProgress(msg.tabId);
            }
            if (coord.workPager === "exhausted" || !historyPagers.has(msg.tabId)) {
              coord.workPager = "exhausted";
              finishWorklogBackfill(msg.tabId);
            }
          }
        }
        const previewMessages = "previewMessages" in msg ? msg.previewMessages : undefined;
        if (previewMessages !== undefined && !coord.convTouched) {
          tabs.get(msg.tabId)?.renderResumePreview(previewMessages);
        }
        const displayEvent = "displayEvent" in msg ? msg.displayEvent : undefined;
        if (displayEvent !== undefined) {
          if (!coord.journalEventIds.has(displayEvent.journalEventId)) {
            coord.journalEventIds.add(displayEvent.journalEventId);
            coord.convTouched = true;
            const t = tabs.get(msg.tabId);
            if (t) {
              t.handleEvent(displayEvent.event);
              overviews.get(msg.tabId)?.syncVisibility();
            }
          }
        }
        const sendDisposition = "sendDisposition" in msg ? msg.sendDisposition : undefined;
        if (sendDisposition !== undefined) {
          const t = tabs.get(msg.tabId);
          const disp = sendDisposition;
          if (disp.disposition === "rejected" || disp.disposition === "accepted-nonhuman") {
            t?.removeOptimisticBubble(disp.clientToken);
          } else if (disp.disposition === "accepted-human") {
            t?.markOptimisticBubbleAccepted(disp.clientToken);
          }
        }
        break;
      }
      case "workModel": {
        lastWorkModels.set(msg.tabId, msg.model);
        const model = displayWorkModel(msg.tabId, msg.model);
        overviews.get(msg.tabId)?.update(model);
        tabs.get(msg.tabId)?.applyWorkModel(model);
        break;
      }
      case "orchestrationView": {
        tabs.get(msg.tabId)?.planPanel.setOrchestration(msg.state);
        overviews.get(msg.tabId)?.setOrchestration(msg.state);
        break;
      }
      case "planUsage": {
        tabs.get(msg.tabId)?.planPanel.setUsage(msg.state);
        overviews.get(msg.tabId)?.setPlanUsage(msg.state);
        break;
      }
      case "semanticModel": {
        tabs.get(msg.tabId)?.observeSessionTime(msg.model?.timeBuckets?.firstAt, "session");
        lastSemanticModels.set(msg.tabId, { model: msg.model, view: true });
        overviews.get(msg.tabId)?.updateSemantic(displaySemanticModel(msg.tabId, msg.model), true);
        break;
      }
      case "llmAnalysisSetting": {
        for (const ov of overviews.values()) {
          ov.setLlmAnalysisEnabled(msg.enabled);
        }
        break;
      }
      case "userSettings": {
        applyAccent(msg.appearance);
        setDisplayName(msg.displayName ?? "");
        applyUserSettings(msg);
        refreshComposer();
        break;
      }
      case "tabNotice": {
        tabs.get(msg.tabId)?.addBlock("system", msg.text);
        break;
      }
      case "sessionNameSuggestion": {
        tabs.get(msg.tabId)?.receiveSessionNameSuggestion(msg);
        break;
      }
      case "sessionSummary": {
        overviews.get(msg.tabId)?.setSessionSummary(msg.running, msg.summary, msg.saveFailed === true, msg.failure);
        break;
      }
      case "llmAnalysisRunState": {
        overviews.get(msg.tabId)?.setLlmRunning(msg.running, msg.progress, msg.failure, msg.refusal);
        break;
      }
      case "llmFindingDiagnostics": {
        if (llmDiagnosticsAllowed === false) {
          console.warn("[drop] llm diagnostics while disabled", msg.tabId);
          break;
        }
        renderLlmDiagnosticsView(llmDiagnosticsPanel(), msg.tabId, msg.payload);
        break;
      }
      case "conversationHistoryResult": {
        onConversationHistoryResult(msg.tabId, msg.requestId, msg.page);
        break;
      }
      case "conversationHistoryError": {
        onConversationHistoryError(msg.tabId, msg.requestId, msg.reason);
        break;
      }
      case "sessionImageResult": {
        handleSessionImageResult(msg.tabId, msg.requestId, msg.mediaType, msg.data);
        break;
      }
      case "sessionImageError": {
        handleSessionImageError(msg.requestId);
        break;
      }
      case "historyChunkResult": {
        const convPager = convPagers.get(msg.tabId);
        if (convPager !== undefined && convPager.requestId === msg.requestId) {
          if (convPager.timer !== undefined) clearTimeout(convPager.timer);
          convPager.timer = undefined;
          convPager.requestId = undefined;
          onConvEventChunkResult(msg.tabId, msg.page);
          break;
        }
        onHistoryChunkResult(msg.tabId, msg.requestId, msg.page);
        break;
      }
      case "historyChunkError": {
        const convPager = convPagers.get(msg.tabId);
        if (convPager !== undefined && convPager.requestId === msg.requestId) {
          if (convPager.timer !== undefined) clearTimeout(convPager.timer);
          convPager.timer = undefined;
          convPager.requestId = undefined;
          onConvEventChunkError(msg.tabId, msg.reason);
          break;
        }
        onHistoryChunkError(msg.tabId, msg.requestId, msg.reason);
        break;
      }
      case "worklogTranscriptResult": {
        onWorklogTranscriptResult(msg.tabId, msg.requestId, msg.page);
        break;
      }
      case "worklogTranscriptError": {
        onWorklogTranscriptError(msg.tabId, msg.requestId, msg.reason);
        break;
      }
      case "agentInspectorResult": {
        overviews.get(msg.tabId)?.handleInspectorResult(msg);
        break;
      }
      case "agentInspectorError": {
        overviews.get(msg.tabId)?.handleInspectorError(msg);
        break;
      }
      case "tabCreated": {
        if (tabs.has(msg.tab.tabId)) {
          rebuildTabInPlace(msg.tab, false);
          if (msg.activate && activeTabId === activeTabAfterInit) setActiveTab(msg.tab.tabId);
        } else {
          addTab(msg.tab);
          if (msg.activate) setActiveTab(msg.tab.tabId);
        }
        break;
      }
      case "activateTab": {
        if (tabs.has(msg.tabId)) setActiveTab(msg.tabId);
        break;
      }
      case "tabRenamed": {
        tabs.get(msg.tabId)?.rename(msg.title);
        break;
      }
      case "handoffStatus": {
        tabs.get(msg.tabId)?.showHandoffStatus(msg);
        break;
      }
      case "handoffDetail": {
        tabs.get(msg.tabId)?.showHandoffDetail(msg);
        break;
      }
      case "modeChanged": {
        const t = tabs.get(msg.tabId);
        if (t) {
          t.permissionMode = msg.mode;
          if (activeTabId === msg.tabId) renderMode(t);
        }
        break;
      }
      case "commands": {
        const t = tabs.get(msg.tabId);
        if (t) t.commands = msg.commands;
        break;
      }
      case "models": {
        const t = tabs.get(msg.tabId);
        if (t) {
          t.setModels(msg.models);
          if (activeTabId === msg.tabId) {
            renderAuth(t);
            if (!authPickerEl.classList.contains("hidden")) {
              renderAuthPicker();
              syncMenuCursor(authPickerEl, "ap-item-");
            }
          }
        }
        break;
      }
      case "modelChanged": {
        const t = tabs.get(msg.tabId);
        if (t) {
          if (msg.notice) t.addBlock("system", msg.notice);
          t.modelOverride = msg.model;
          if (msg.applied) t.chooseModel(msg.model ?? t.models.find(row => row.id === "default")?.resolvedModel);
          if (t.auth) t.auth = { ...t.auth, effort: undefined };
          if (activeTabId === msg.tabId) {
            renderAuth(t);
            if (!authPickerEl.classList.contains("hidden")) {
              renderAuthPicker();
              syncMenuCursor(authPickerEl, "ap-item-");
            }
          }
        }
        break;
      }
      case "configuredEffortChanged": {
        const t = tabs.get(msg.tabId);
        if (t) {
          t.configEffort = msg.effort ?? undefined;
          t.defaultEffort = msg.defaultEffort ?? undefined;
          t.appliedModel = msg.appliedModel ?? undefined;
          t.observeAppliedModel(msg.appliedModel);
          t.appliedEffort = msg.appliedEffort;
          if (msg.model !== undefined) t.configModel = msg.model ?? undefined;
          if (activeTabId === msg.tabId) {
            renderAuth(t);
            if (!authPickerEl.classList.contains("hidden")) {
              renderAuthPicker();
              syncMenuCursor(authPickerEl, "ap-item-");
            }
          }
        }
        break;
      }
      case "effortChanged": {
        const t = tabs.get(msg.tabId);
        if (t) {
          if (msg.notice) t.addBlock("system", msg.notice);
          t.effortOverride = msg.effort;
          if (t.auth) t.auth = { ...t.auth, effort: undefined };
          if (activeTabId === msg.tabId) {
            renderAuth(t);
            if (!authPickerEl.classList.contains("hidden")) {
              renderAuthPicker();
              syncMenuCursor(authPickerEl, "ap-item-");
            }
          }
        }
        break;
      }
      case "files": {
        handleFilesResponse(msg.reqId, msg.paths);
        break;
      }
      case "pickedFiles": {
        onPickedFiles(msg.reqId, msg.paths, msg.images);
        break;
      }
      case "attachments": {
        if (msg.items.length === 0) attachmentsByTab.delete(msg.tabId);
        else attachmentsByTab.set(msg.tabId, msg.items);
        if (activeTabId === msg.tabId) renderAttachments();
        break;
      }
      case "sessions": {
        applySessionChunk(msg.requestId, msg.sessions, msg.complete, msg.degraded, msg.source, msg.nextCursor, msg.append, msg.showHidden);
        break;
      }
      case "sessionRenamed": {
        applySessionRenamed(msg.sessionId, msg.title, msg.requestId);
        break;
      }
      case "sessionHiddenChanged": {
        applySessionHiddenChanged(msg.sessionId, msg.hidden);
        break;
      }
      case "sessionListActionFailed": {
        applySessionListActionFailed(msg.reason, msg.sessionId, msg.action, msg.requestId);
        break;
      }
      case "analysisFailed": {
        showAnalysisFailure(msg);
        break;
      }
      case "analysis": {
        showAnalysis(msg.sessionId, msg.filePath, msg.report as AnalysisReport);
        break;
      }
      case "composerPrefill": {
        drafts.set(msg.tabId, msg.text);
        if (activeTabId === msg.tabId) {
          inputEl.value = msg.text;
          autosizeComposer();
          inputEl.focus();
        }
        persistState();
        break;
      }
      case "accountUsage": {
        if (msg.replyTo !== accountUsageRequestId) break;
        accountUsageRequestId = null;
        accountUsage = { seq: msg.seq, fetchedAtMs: msg.fetchedAtMs, state: msg.state, rows: msg.rows };
        settleAccountUsageRequest();
        if (!usagePanelEl.classList.contains("hidden")) renderUsagePanel();
        break;
      }
      case "editorContext": {
        editorContext = { path: msg.path, startLine: msg.startLine, endLine: msg.endLine };
        renderCtxChip();
        break;
      }
      case "analysisPersistenceState": {
        const badge = document.querySelector(`.llm-persistence-badge[data-artifact-id="${msg.artifactId}"]`);
        if (badge) {
          badge.textContent = msg.persistenceLabel;
          badge.setAttribute("data-persistence", msg.persistence);
        }
        break;
      }
      case "tabCleared": {
        rebuildTabInPlace(msg.tab, false);
        break;
      }
      case "tabRestored": {
        rebuildTabInPlace(msg.tab, true);
        break;
      }
      case "tabClosed": {
        const t = tabs.get(msg.tabId);
        if (t) {
          t.destroy();
          tabs.delete(msg.tabId);
          overviews.delete(msg.tabId);
          localEventDrops.delete(msg.tabId);
          hostDroppedAtInstall.delete(msg.tabId);
          lastWorkModels.delete(msg.tabId);
          lastSemanticModels.delete(msg.tabId);
          resumeCoordinators.delete(msg.tabId);
          dropHistoryPager(msg.tabId);
          dropConvPager(msg.tabId);
          drafts.delete(msg.tabId);
          attachmentsByTab.delete(msg.tabId);
          forgottenTabIds.add(msg.tabId);
          if (activeTabId === msg.tabId) activeTabId = null;
          persistState();
          const next = [...tabs.keys()][0] ?? null;
          if (!activeTabId && next) setActiveTab(next);
          else if (!activeTabId) refreshChrome();
        }
        break;
      }
    }
    } catch (error) {
      reportWebviewDiagnostic("error", `message handler failed: ${String(error)}`);
    }
  });
}

const attachmentsByTab = new Map<string, PendingAttachmentInfo[]>();

function attachmentsOf(tabId: string | null): PendingAttachmentInfo[] {
  return tabId ? attachmentsByTab.get(tabId) ?? [] : [];
}

function renderAttachments(): void {
  reflowComposer((settle) => {
    attachmentsEl.textContent = "";
    const tabId = activeTabId;
    attachmentsOf(tabId).forEach((im, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "attachment";
      const img = document.createElement("img");
      const settleAfterLayout = (): void => { setTimeout(settle, 0); };
      img.onload = settleAfterLayout;
      img.onerror = settleAfterLayout;
      img.src = `data:${im.mediaType};base64,${im.data}`;
      img.alt = l10n.t("Attachment {0}", idx + 1);
      const rm = document.createElement("button");
      rm.className = "attachment-remove";
      rm.textContent = "×";
      rm.title = l10n.t("Remove attachment");
      rm.onclick = () => {
        if (!tabId) return;
        vscode.postMessage({ type: "removeAttachment", tabId, attachmentId: im.id });
      };
      wrap.append(img, rm);
      attachmentsEl.appendChild(wrap);
    });
  });
}

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function addImageFile(file: File, mediaType: string): void {
  if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) return;
  const tabId = activeTabId;
  if (!tabId) return;
  if (attachmentsOf(tabId).length >= IMAGE_MAX_COUNT) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    vscode.postMessage({
      type: "attachImage",
      tabId,
      mediaType: mediaType as ImageAttachment["mediaType"],
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    });
  };
  reader.readAsDataURL(file);
}

let pickFilesSeq = 0;
let latestPickFilesReqId = -1;
let pickFilesTabId: string | null = null;

function openFilePicker(): void {
  const reqId = ++pickFilesSeq;
  latestPickFilesReqId = reqId;
  pickFilesTabId = activeTabId;
  vscode.postMessage({
    type: "pickFiles",
    reqId,
    imageSlots: Math.max(0, IMAGE_MAX_COUNT - attachmentsOf(activeTabId).length),
  });
}

function onPickedFiles(reqId: number, paths: string[], images: ImageAttachment[]): void {
  if (reqId !== latestPickFilesReqId) return;
  if (pickFilesTabId) {
    for (const im of images) {
      vscode.postMessage({
        type: "attachImage",
        tabId: pickFilesTabId,
        mediaType: im.mediaType,
        data: im.data,
      });
    }
  }
  insertFilePaths(paths);
}

function initComposer(): void {
  actionBtn.onclick = () => {
    const t = activeTab();
    if (!t) return;
    if (t.turnState === "idle") send();
    else if (activeTabId) {
      t.setTurnState("interrupting");
      vscode.postMessage({ type: "interrupt", tabId: activeTabId });
    }
  };
  inputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey === (composerSendKey() === "shiftEnter")) {
      e.preventDefault();
      send();
    }
  });

  inputEl.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      if (!ALLOWED_IMAGE_TYPES.includes(item.type)) continue;
      if (attachmentsOf(activeTabId).length >= IMAGE_MAX_COUNT) break;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      addImageFile(file, item.type);
    }
  });

  convPrevBtn.onclick = () => {
    activeTab()?.scrollToPreviousUserBlock();
  };
  convNextBtn.onclick = () => {
    activeTab()?.scrollToLatest();
    if (activeTabId) syncWorklogBackfillScroll(activeTabId);
  };

  attachBtn.onclick = () => openFilePicker();

  inputEl.addEventListener("input", () => {
    autosizeComposer();
    persistState();
  });
  newTabBtn.onclick = () => vscode.postMessage({ type: "newTab" });
  handoffBtn.onclick = () => {
    if (activeTabId) vscode.postMessage({ type: "startHandoff", tabId: activeTabId });
  };
  exportBtn.onclick = () => {
    if (activeTabId) vscode.postMessage({ type: "exportTab", tabId: activeTabId });
  };
}

function cycleTab(direction: 1 | -1): void {
  const ids = [...tabs.keys()];
  if (ids.length < 2) return;
  const idx = activeTabId ? ids.indexOf(activeTabId) : -1;
  const next =
    idx === -1
      ? direction === 1
        ? ids[0]
        : ids[ids.length - 1]
      : ids[(idx + direction + ids.length) % ids.length];
  setActiveTab(next);
}

function initGlobalShortcuts(): void {
  document.addEventListener("keydown", (e) => {
    if (isFindBarOpen()) {
      if (e.key === "F3") {
        e.preventDefault();
        e.stopPropagation();
        abandonAwaitedScrollAnchor();
        findNext(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeFindBar();
        return;
      }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "f" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      abandonAwaitedScrollAnchor();
      openFindBar();
    } else if (key === "w" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (activeTabId) {
        vscode.postMessage({ type: "closeTab", tabId: activeTabId });
      }
    } else if (key === "t" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "newTab" });
    } else if (key === "tab") {
      e.preventDefault();
      e.stopPropagation();
      cycleTab(e.shiftKey ? -1 : 1);
    }
  });
}

function initTabbarKeys(): void {
  tabbarEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const ids = [...tabs.keys()];
    if (!activeTabId || ids.length < 2) return;
    const idx = ids.indexOf(activeTabId);
    const next = ids[(idx + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
    setActiveTab(next);
    tabs.get(next)?.tabBtn.focus();
    e.preventDefault();
  });
}

let editorContext: { path: string; startLine: number; endLine: number } | null = null;

function ctxLabel(ctx: { path: string; startLine: number; endLine: number }): string {
  const loc = ctx.startLine === ctx.endLine ? `${ctx.path}:${ctx.startLine}` : `${ctx.path}:${ctx.startLine}-${ctx.endLine}`;
  return `📄 ${loc}`;
}

function renderCtxChip(): void {
  reflowComposer(() => {
    ctxChipEl.textContent = "";
    if (!editorContext) {
      ctxChipEl.classList.add("hidden");
      return;
    }
    const label = document.createElement("span");
    label.textContent = ctxLabel(editorContext);
    label.title = ctxLabel(editorContext);
    const rm = document.createElement("button");
    rm.className = "ctx-chip-remove";
    rm.textContent = "×";
    rm.title = l10n.t("Remove reference");
    rm.setAttribute("aria-label", l10n.t("Remove reference"));
    rm.onclick = () => {
      editorContext = null;
      renderCtxChip();
    };
    ctxChipEl.append(label, rm);
    ctxChipEl.classList.remove("hidden");
  });
}

const UNSUPPORTED_TERMINAL_HINT = new Map<string, string>([
  ["/config", l10n.t("Edit ~/.claude/settings.json directly (model and effort can be changed from the chips).")],
]);
const UNSUPPORTED_TERMINAL_COMMANDS = new Map<string, string>(
  ["/context", "/insights", "/recap", "/agents", "/mcp", "/config"].map((cmd) => [
    cmd,
    l10n.t(
      "{0} assumes a terminal UI and does not work in LAISORA. {1}",
      cmd,
      UNSUPPORTED_TERMINAL_HINT.get(cmd) ?? l10n.t("Run it in the Claude Code terminal.")
    ),
  ])
);

function send(): void {
  const running = activeTab()?.turnState !== "idle";
  if (activeTab()?.turnState === "interrupting") {
    activeTab()?.addBlock("system warn", l10n.t("Cannot send while interrupting."));
    return;
  }
  const text = inputEl.value.trim();
  if (text === "/clear") {
    const ct = activeTab();
    if (ct && ct.turnState !== "idle") {
      ct.addBlock("system warn", l10n.t("Cannot use /clear during a turn. Wait for completion or interrupt, then try again."));
      return;
    }
    clearComposerInput();
    persistState();
    if (activeTabId) vscode.postMessage({ type: "clearTab", tabId: activeTabId });
    return;
  }
  if (text === "/export") {
    clearComposerInput();
    persistState();
    if (activeTabId) vscode.postMessage({ type: "exportTab", tabId: activeTabId });
    return;
  }
  if (text === "/model") {
    clearComposerInput();
    persistState();
    const t = activeTab();
    if (t && t.models.length === 0) {
      t.addBlock("system", l10n.t("Loading models. This may take a few seconds after starting a conversation."));
    } else {
      queueMicrotask(() => openAuthPicker(inputEl));
    }
    return;
  }
  if (text === "/color" || text === "/theme") {
    clearComposerInput();
    persistState();
    vscode.postMessage({ type: "openThemePicker" });
    return;
  }
  if (text === "/resume" || text === "/history") {
    clearComposerInput();
    persistState();
    queueMicrotask(openHistPanel);
    return;
  }
  if (text === "/effort" || text.startsWith("/effort ")) {
    clearComposerInput();
    persistState();
    const arg = text.slice("/effort".length).trim();
    const t = activeTab();
    if (!arg) {
      queueMicrotask(() => openAuthPicker(inputEl, "effort"));
    } else if (arg === "default") {
      if (activeTabId) vscode.postMessage({ type: "setEffort", tabId: activeTabId, effort: null });
    } else if ((EFFORT_ORDER as readonly string[]).includes(arg)) {
      if (activeTabId) vscode.postMessage({ type: "setEffort", tabId: activeTabId, effort: arg });
    } else {
      t?.addBlock("system warn", l10n.t("Usage: /effort <{0}|default>", EFFORT_ORDER.join("|")));
    }
    return;
  }
  if (text === "/usage" || text.startsWith("/usage ")) {
    clearComposerInput();
    persistState();
    queueMicrotask(openUsagePanel);
    return;
  }
  const rename = /^\/rename(?:\s+([\s\S]*))?$/.exec(text);
  if (rename !== null) {
    const t = activeTab();
    if (!t) return;
    clearComposerInput();
    persistState();
    const title = (rename[1] ?? "").split("\n")[0].trim();
    if (!title) {
      t.addBlock("system warn", l10n.t("Usage: /rename <new name>"));
    } else if (title.length > RENAME_TITLE_MAX) {
      t.addBlock("system warn", l10n.t("The name is too long (maximum {0} characters).", RENAME_TITLE_MAX));
    } else if (activeTabId) {
      vscode.postMessage({ type: "renameTab", tabId: activeTabId, title });
    }
    return;
  }
  const unsupportedTerminalCommand = UNSUPPORTED_TERMINAL_COMMANDS.get(text.split(/\s+/)[0]);
  if (unsupportedTerminalCommand !== undefined) {
    const t = activeTab();
    if (!t) return;
    clearComposerInput();
    persistState();
    t.addBlock("system warn", unsupportedTerminalCommand);
    return;
  }
  if ((!text && attachmentsOf(activeTabId).length === 0) || !activeTabId) return;
  clearComposerInput();
  persistState();
  const t = activeTab();
  t?.clearCancelledHandoffNotice();
  if (t && !running) {
    t.pendingSend = true;
    t.setTurnState("running");
  } else if (t && running) {
    t.addBlock("system", l10n.t("Added to the running turn"));
  }
  const shown = attachmentsOf(activeTabId);
  const images = shown.length > 0 ? shown.map((im) => ({ mediaType: im.mediaType, data: im.data })) : undefined;
  const finalText = editorContext
    ? `${l10n.t(
        "Reference: {0}",
        `${editorContext.path}:${
          editorContext.startLine === editorContext.endLine
            ? editorContext.startLine
            : `${editorContext.startLine}-${editorContext.endLine}`
        }`
      )}\n${text}`
    : text;
  editorContext = null;
  renderCtxChip();
  const coord = activeTabId ? resumeCoordinators.get(activeTabId) : undefined;
  if (coord && coord.host === "loading") {
    const clientToken = crypto.randomUUID();
    const bubble = t?.renderOptimisticUserBubble(finalText, clientToken, images);
    if (bubble) {
      coord.convTouched = true;
    }
    vscode.postMessage({ type: "send", tabId: activeTabId, text: finalText, clientToken });
  } else {
    vscode.postMessage({ type: "send", tabId: activeTabId, text: finalText });
  }
}

function initTicker(): void {
  setInterval(() => {
    const nowMs = Date.now();
    activeTab()?.tickStrip();
    activeTab()?.planPanel.tick(nowMs);
    if (activeTabId) {
      overviews.get(activeTabId)?.tick(nowMs);
    }
  }, 1000);
}

window.addEventListener("error", (event) => {
  reportWebviewDiagnostic("error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportWebviewDiagnostic("error", event.reason);
});
for (const [name, step] of [
  ["initLogsScroll", initLogsScroll],
  ["initUsagePanel", initUsagePanel],
  ["initMessageBus", initMessageBus],
  ["initComposer", initComposer],
  ["initMenu", initMenu],
  ["initGlobalShortcuts", initGlobalShortcuts],
  ["initFindBar", initFindBar],
  ["initSuggest", initSuggest],
  ["initTabbarKeys", initTabbarKeys],
  ["initHistory", initHistory],
  ["initTicker", initTicker],
] as const) {
  try {
    step();
  } catch (error) {
    reportWebviewDiagnostic("error", `init ${name} failed: ${String(error)}`);
  }
}
sendReady();
window.__laisoraBootstrap?.complete();
