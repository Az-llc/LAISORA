import { installAccent } from "./accent";
import { prependPreservingView } from "./history-scroll";
import * as l10n from "@vscode/l10n";

const applyAccent = installAccent();

// モデル・利用者由来のテキストは textContent で DOM 化し、innerHTML へ流さない（verify-markdown#T4-S1）。

import type {
  ConversationHistoryErrorReason,
  HistoryChunkPagePayload,
  HostToWebview,
  ImageAttachment,
  ImageRefInfo,
  ModelInfo,
  NormalizedEvent,
  PendingAttachmentInfo,
  PermissionModeId,
  ResumeHydrationPhase,
  SemanticModelPayload,
  TabSnapshot,
  UsageSnapshot,
  WorkModelPayload,
} from "../protocol";
import { fallbackChipWarning, IMAGE_MAX_COUNT, PROTOCOL_VERSION, RENAME_TITLE_MAX, isHostToWebview, withLocalEventDrop } from "../protocol";
import { windowEvents } from "../event-window";
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
import { applySessionChunk, initHistory, openHistPanel } from "./history";
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
import { uiLocale } from "./format";

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
// Host の coverage は REPLAY_MAX による画面側の窓落ちを含まない。displayWorkModel が受信のたびに合流させる（verify-history-prepend#HPmut-13）。
const localEventDrops = new Map<string, number>();
const hostDroppedAtInstall = new Map<string, number>();
export let activeTabId: string | null = vscode.getState()?.activeTabId ?? null;
// init 済みのタブを tabCreated が作り直すときは、activeTabId が init の選んだ activeTabAfterInit のまま（利用者が別タブへ移っていない）
// ときだけ activate に従う。移った後に従うと、利用者の選択を後から届いた復元が奪う。
let activeTabAfterInit: string | null = null;
// 下書きはタブごとに持つ。共有の inputEl だけに置くと別のタブへ送る。
const drafts = new Map<string, string>(Object.entries(vscode.getState()?.drafts ?? {}));
// persistState は保存済みの値へ上書きマージするので、閉じたタブは forgottenTabIds で明示的に消す。
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

// savedScrollCarry の値は前の document のもの。同じ document で作り直すときは init が destroy より先に取った持ち越しの方が新しい。
const tabsAddedInDocument = new Set<string>();

function savedScrollCarry(tabId: string): ScrollCarry | undefined {
  if (tabsAddedInDocument.has(tabId)) return undefined;
  const carry = savedScrollAnchors()[tabId];
  return isScrollCarry(carry) ? carry : undefined;
}

export function persistState(): void {
  if (activeTabId) drafts.set(activeTabId, inputEl.value);
  // 保存済みの値へ上書きマージする。全置換にすると tabs が揃う前の呼び出しで未登録タブの設定が消える。
  const views: Record<string, ViewMode> = { ...(vscode.getState()?.views ?? {}) };
  const workViews: Record<string, WorkViewMode> = { ...(vscode.getState()?.workViews ?? {}) };
  const analysisViews: Record<string, "script" | "ai"> = { ...(vscode.getState()?.analysisViews ?? {}) };
  const scrollAnchors = { ...savedScrollAnchors() };
  const askChecks = { ...(vscode.getState()?.askChecks ?? {}) };
  const askDismissed = { ...(vscode.getState()?.askDismissed ?? {}) };
  const out = Object.fromEntries(drafts);
  for (const id of forgottenTabIds) {
    delete views[id];
    delete workViews[id];
    delete analysisViews[id];
    delete askChecks[id];
    delete askDismissed[id];
    delete scrollAnchors[id];
    delete out[id];
  }
  for (const [id, t] of tabs) views[id] = t.viewMode;
  for (const [id, t] of tabs) workViews[id] = t.workViewMode;
  for (const [id, overview] of overviews) analysisViews[id] = overview.analysisSubtab;
  for (const [id, t] of tabs) scrollAnchors[id] = t.captureScrollCarry(false);
  const { askDismissedMessages, askCheckedMessages } = vscode.getState() ?? {};
  const next: PersistedState = { activeTabId, drafts: out, views, workViews, analysisViews, scrollAnchors, askChecks, askDismissed, askDismissedMessages, askCheckedMessages };
  vscode.setState(next);
}

// 非表示で document ごと破棄される（src/extension.ts は retainContextWhenHidden を偽で渡す）。破棄直前のイベントに頼らず、
// 位置はスクロールのたびに SCROLL_PERSIST_DELAY_MS 遅れで保存する。
const SCROLL_PERSIST_DELAY_MS = 250;
let scrollPersistTimer: ReturnType<typeof setTimeout> | undefined;

function initLogsScroll(): void {
  logsEl.addEventListener("scroll", () => {
    if (!activeTabId) return;
    // onPortScroll を noteScroll より先に呼ぶ。逆順だとグラフの補正前の scrollTop が張り付き状態として記録される。
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
  // スクロールバーの操作は #logs 自身が target になる。中身への pointerdown では abandonAwaitedScrollAnchor を呼ばない。
  logsEl.addEventListener("pointerdown", (e) => {
    if (e.target === logsEl) abandonAwaitedScrollAnchor();
  }, { passive: true });
  logsEl.addEventListener("keydown", (e) => {
    if (SCROLL_KEYS.has(e.key)) abandonAwaitedScrollAnchor();
  }, { passive: true });
  // 検索は #logs に触れずにスクロールするので、findBarEl の操作でも遡り待ちを諦める。
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

// init で消さない。再 init 後に同じ sessionId を開いたタブへ引き継ぐ（verify-webview-wiring#T4-3）。
const analysisReports = new Map<string, { filePath: string; report: AnalysisReport }>();
export function refreshComposer(): void {
  inputEl.placeholder = composerPlaceholder();
  refreshChrome();
}

// tabActivationDepth が正の間、reflowComposer は #logs の位置を張り付きとして記録しない。位置はまだ離れるタブのもので、
// 記録すると restoreScroll が新しいタブを末尾へ飛ばす。surfaceGeneration は切替より前に積まれた遅延の張り付け直しを無効にする。
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
    // R-CNV-11: renderAttachments を外すと前のタブの添付が画面に残る。
    renderAttachments();
    persistState();
    // 切替のたびに送る。可視化時の init（src/store-surfaces.ts#restoreVisible）は document の作り直しより先に出る。
    vscode.postMessage({ type: "activeTab", tabId });
    for (const [id, t] of tabs) {
      t.tabBtn.classList.toggle("active", id === tabId);
      t.tabBtn.setAttribute("aria-selected", id === tabId ? "true" : "false");
      t.logEl.classList.toggle("active", id === tabId);
      t.setSessionMenuActive(id === tabId);
    }
    refreshComposer();
    resumeConversationChase(tabId);
    resumeWorklogBackfill(tabId);
    // autosizeComposer を restoreScroll より先に呼ぶ。restoreScroll は #logs の高さから scrollTop を決める。
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

// R-ANL-11: 失敗は要求元のタブへ出す。script 以外は操作元の画面から切り替えない。
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

// src/webview/tab.ts#syncHeadLayout は #logs の実高から測る。ポート高だけが変わる経路は Tab 側のイベントに現れないので、
// resize とコンポーザの伸縮からここで測り直す。
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

// height を auto に戻してから測る。戻さないと scrollHeight が伸びた側に張り付いて縮まない。
// inputEl はタブ間で共有なので、value を差し替える経路はすべてここを通す。
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

// 高さは autosizeComposer で戻す。style.height を直接書くと reflowComposer の張り付け直しと syncActiveHeadLayout を飛ばす。
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
  // 表示面で無効化しない。src/webview/tab.ts#scrollToPreviousUserBlock は会話面へ切り替えてから遡る。
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

// R-CMD-02: 表示名は CLI が返した行のラベルだけから取る。適用済みのモデルは解決後の id で届き、行の id は選択用の綴りなので
// resolvedModel でも引く。default の行は指し先であってモデル名ではないので resolvedModel の照合から外す（verify-webview-menu#MODEL-ALIAS）。
function findModelRow(t: Tab | null, value: string): ModelInfo | undefined {
  const rows = t?.models ?? [];
  return (
    rows.find((m) => m.id === value) ??
    rows.find((m) => m.id !== "default" && m.resolvedModel === value)
  );
}

// R-GW-07: an unresolved fallback outranks the requested selection (verify-webview-menu#RF-UI).
// src/conversation-lifecycle.ts#applyModelChange answers with modelChanged and does not resend auth_status,
// so an explicit selection outranks auth.model (verify-webview-menu#MODEL-ALIAS).
export function displayModelName(t: Tab | null): string | undefined {
  if (t?.modelFallback && t.modelFallback.resolvedAt === undefined) {
    const model = t.modelFallback.appliedModel;
    return findModelRow(t, model)?.label ?? model;
  }
  const override = t?.modelOverride;
  if (override) {
    const label = findModelRow(t, override)?.label;
    return label && label !== override ? label : t?.modelDisplayName(override) ?? override;
  }
  // 空白だけの設定値は trim で未設定へ落とす。落とさないとチップが空のまま出る。照合も raw で行う。
  const raw = override === null ? "default" : (t?.auth?.model ?? t?.appliedModel ?? t?.recordedModel ?? t?.configModel)?.trim();
  if (!raw) return undefined;
  const info = findModelRow(t, raw);
  // default は指し先なので、findModelRow の行が無ければ文字列のまま出さない。
  if (raw === "default") return info?.label;
  return info?.label && info.label !== raw ? info.label : t?.modelDisplayName(raw) ?? raw;
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
  } session=${auth.sessionId ?? "?"}`;
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
  // R-CNV-06: チップ本文はコンテキスト利用率だけ。他の消費情報は title へ回す。
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

let cachedUsageFetchedAt = 0;
// utilization はパーセント値で持つ（SDK の SDKControlGetUsageResponse の rate_limits と同じ単位）。生産者は
// src/webview/tab.ts#onRateLimit と cachedUsage の受信で、どちらも換算しない。片方だけ換算すると同じ Map に尺度が混ざる。
export const rateLimits = new Map<string, { utilization: number; resetsAt: number | null; isUsingOverage: boolean }>();
const RATE_LABELS: Record<string, string> = {
  five_hour: l10n.t("5-hour window"),
  weekly: l10n.t("Weekly window"),
  seven_day: l10n.t("Weekly window"),
  seven_day_opus: l10n.t("Weekly window (Opus)"),
  seven_day_sonnet: l10n.t("Weekly window (Sonnet)"),
};

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
  if (rateLimits.size === 0) {
    const none = document.createElement("div");
    none.className = "usage-line";
    // 実測: CLI は利用率を実APIコールを伴うターンでしか送ってこない。/usage を打っても
    // 送られない（ローカル処理のターンでは rate_limit が来ない）ため、待てば出る類ではない
    none.textContent = l10n.t("Usage: not fetched (arrives from the CLI after one exchange)");
    usagePanelEl.appendChild(none);
  }
  if (cachedUsageFetchedAt > 0 && rateLimits.size > 0) {
    const at = document.createElement("div");
    at.className = "usage-line";
    const fetchedAt = new Date(cachedUsageFetchedAt).toLocaleString(uiLocale(), { hour12: false });
    at.textContent = l10n.t("Usage fetched at: {0}", fetchedAt);
    usagePanelEl.appendChild(at);
  }
  for (const [type, rl] of rateLimits) {
    const row = document.createElement("div");
    row.className = "usage-rl";
    const label = document.createElement("div");
    label.className = "usage-line";
    const pct = Math.round(rl.utilization);
    const reset = rl.resetsAt ? new Date(rl.resetsAt).toLocaleString(uiLocale(), { hour12: false }) : "?";
    const rateLabel = RATE_LABELS[type] ?? type;
    label.textContent = rl.isUsingOverage
      ? l10n.t("{0}: {1}% (using overage) · resets {2}", rateLabel, pct, reset)
      : l10n.t("{0}: {1}% · resets {2}", rateLabel, pct, reset);
    const barWrap = document.createElement("div");
    barWrap.className = "usage-bar-wrap";
    const bar = document.createElement("div");
    bar.className = `usage-bar${pct >= 90 ? " warn" : ""}`;
    bar.style.width = `${Math.min(100, pct)}%`;
    barWrap.appendChild(bar);
    row.append(label, barWrap);
    usagePanelEl.appendChild(row);
  }
}

function openUsagePanel(): void {
  vscode.postMessage({ type: "requestCachedUsage" });
  // 外側クリックで閉じる判定は stopPropagation する経路で走らないので、開く側で closeAuthPicker と closeModeMenu を呼ぶ。
  closeAuthPicker();
  closeModeMenu();
  renderUsagePanel();
  usagePanelEl.classList.remove("hidden");
  usageEl.setAttribute("aria-expanded", "true");
}

export function closeUsagePanel(): void {
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
// undefined は未着で、撤去も抑止もしない（verify-webview-wiring#D5-2）。
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

// 明示 off では hidden でなく DOM から外す（verify-webview-wiring#D5-4）。on だけではパネルを作らない。作ると空枠が
// 未実行を 0 件と描く（verify-webview-wiring#D5-1）。
function applyLlmDiagnosticsMode(mode: boolean | undefined): void {
  llmDiagnosticsAllowed = mode;
  if (mode !== false) return;
  if (llmDiagnosticsEl !== undefined) {
    llmDiagnosticsEl.remove();
    llmDiagnosticsEl = undefined;
  }
}

const REPLAY_MAX = 1500;
// 応答が失われると status が inflight のまま固着するので、HISTORY_REQUEST_TIMEOUT_MS で error へ降ろして再開を出す。
const HISTORY_REQUEST_TIMEOUT_MS = 30_000;
// cursor 無しの transcript 要求は Host がセッションの記録を全読みするので、HISTORY_REQUEST_TIMEOUT_MS より長く待つ
// （verify-conversation-history#CH-T1mut）。
const CONV_FIRST_TRANSCRIPT_TIMEOUT_MS = 120_000;
const CONV_FIRST_CHUNK_RETRY_MAX = 3;
const CONV_FIRST_CHUNK_RETRY_DELAY_MS = 2_000;

interface HistoryPager {
  anchorUuid?: string;
  // events を尽くしてから transcript へ移る。events の方が新しいので、上へ積むだけで時系列順になる。
  phase?: "events" | "transcript";
  eventAnchor?: { generation: number; seq: number };
  status: "idle" | "inflight" | "exhausted" | "error";
  // anchor と cursor を同じ要求に載せない。src/protocol.ts#isWebviewToHost が拒否する。
  anchor?: { generation: number; seq: number };
  cursor?: string;
  requestId?: string;
  retried: boolean;
  // undefined は追走していない印。stopConvChase は undefined に戻して追走を止め、convChaseContinues はそれを見て続けない。
  autoSteps?: number;
  chaseBudget?: number;
  chasePaused?: boolean;
  phaseInitialRemaining?: number;
  lastRemainingOlder?: number;
  receivedTranscriptChunk?: boolean;
  firstChunkRetries?: number;
  backfillBudget?: number;
  backfillTotal?: number;
  // 読了の判定は transcriptRemaining で行う。transcript 位相に入った事実で判定すると、渡されなかった分が読了扱いになる。
  // hostDroppedAtInstall との差で代用しない。記録の fold と live の fold は件数が一致しない。
  transcriptRemaining?: number;
  wasAtBottom?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  noteEl?: HTMLElement;
  renderFailedTotal?: number;
  renderFailNoteEl?: HTMLElement;
}

// prepend の間だけ scroll anchoring を止める。自前の補正と重なると二重に補正される（verify-history-prepend#HPmut-10）。
// #logs で恒久的に止めると、画面外の上の行が伸びたときに表示が跳ねる（verify-history-prepend#HP-C17）。
function withoutScrollAnchoring<T>(fn: () => T): T {
  const previous = logsEl.style.overflowAnchor;
  logsEl.style.overflowAnchor = "none";
  try {
    return fn();
  } finally {
    logsEl.style.overflowAnchor = previous;
  }
}

// R-TAB-07: 見えていない面では scrollHeight が動かないので補正しない。補正は視界の上端より上の差し替えに限る。
// prepend と違い、画像スロットは視界より下でも差し替わる（verify-history-prepend#HPmut-24）。
export function swapPreservingConvView(tabId: string, target: Element, replacement: Node): void {
  if (!convPaneVisible(tabId)) {
    target.replaceWith(replacement);
    return;
  }
  withoutScrollAnchoring(() => {
    const portTop = logsEl.getBoundingClientRect().top;
    const nodeTop = target.getBoundingClientRect().top;
    // Tab の atBottom は scroll イベントでしか更新されず直前の追記を含まないので、SCROLL_BOTTOM_GAP_PX で測り直す。
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
  // 上の見出しが縮むと scroll anchoring が同じだけ scrollTop を下げる。縮んだ分で説明できない下げ幅が
  // SCROLL_BOTTOM_GAP_PX を超えたときだけ、利用者が遡ったとみなして張り付け直さない。
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
  // syncActiveHeadLayout のタイマーより後に積むので、その測り直しで動いた scrollHeight に対して張り付け直せる。
  setTimeout(settleLater, 0);
}

const historyPagers = new Map<string, HistoryPager>();
// localEventDrops を当てる前の値。refreshLocalDropViews が件数の変化を当て直す。
const lastWorkModels = new Map<string, Parameters<typeof withLocalEventDrop>[0]>();
// 概要とグラフは semantic の coverage.base を読むので、こちらも素の値を持って displaySemanticModel で当て直す。
const lastSemanticModels = new Map<string, { model: SemanticModelPayload | undefined; view: boolean | undefined }>();
let historyRequestSeq = 0;

const convPagers = new Map<string, HistoryPager>();
let convRequestSeq = 0;

// R-CNV-01: 追走は描画の結果では止めない（verify-conversation-history#CH-C25mut、verify-conversation-history#CH-C28mut）。
// 一過性のエラーでも止めない（verify-conversation-history#CH-E1mut）。前進の検査は convChaseContinues が持つ。
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
  // cursor が進まない応答で無限追走にしない（R-CNV-01）
  if (page.nextCursor === usedCursor) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: cursor が進んでいない (tab=${tabId})`
    );
    return false;
  }
  // 0 件で hasMore を信じ続けると終端へ着かない（R-CNV-01）
  if (returnedCount === 0) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: 0件の chunk で hasMore=true (tab=${tabId})`
    );
    return false;
  }
  const remaining = page.coverage.remainingOlderCount;
  // 残件が減らない応答は前進していない（R-CNV-01）
  if (pager.lastRemainingOlder !== undefined && remaining >= pager.lastRemainingOlder) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: 残件数が減らない (${pager.lastRemainingOlder} -> ${remaining}, tab=${tabId})`
    );
    return false;
  }
  pager.lastRemainingOlder = remaining;
  // R-CNV-01: 上限は直前の応答の残件から引き直す。固定値にすると長い会話が終端の前に止まる（verify-conversation-history#CH-C32mut）。
  if (pager.chaseBudget !== undefined && pager.autoSteps >= pager.chaseBudget) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: 追走上限 ${pager.chaseBudget} に達した (tab=${tabId})`
    );
    return false;
  }
  // 余裕を足さない。残件は直前の検査で必ず減るので、足すと chaseBudget に到達しなくなる。
  pager.chaseBudget = pager.autoSteps + remaining;
  pager.autoSteps++;
  return true;
}

function dropConvPager(tabId: string): void {
  const pager = convPagers.get(tabId);
  if (pager?.timer !== undefined) clearTimeout(pager.timer);
  convPagers.delete(tabId);
}

// logsEl はタブ横断の単一容器で、非表示パネルでは scrollHeight が動かず視界維持の補正が成立しない。
function convPaneVisible(tabId: string): boolean {
  const t = tabs.get(tabId);
  return t !== undefined && activeTabId === tabId && t.viewMode === "conv";
}

// R-CNV-02: 分母の phaseInitialRemaining は phase ごとに取り直す。phase で数える単位が違う。
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

// R-DSP-03: 欠落の種類ごとに件数を分けて出す。
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

// 描画失敗を診断だけに出すと、進行表示が消えたとき全件出たと読まれる（verify-conversation-history#CHmut-C41）。
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

// prepend の後に数え直さないと過去の一致が検索の件数に入らない（verify-conversation-history#CHmut-U32c-a）。
function refreshFindAfterPrepend(tabId: string): void {
  if (tabId === activeTabId) refreshFind("end");
}

function finishConvChaseProgress(tabId: string): void {
  tabs.get(tabId)?.stopAwaitingScrollAnchor();
  const coord = resumeCoordinators.get(tabId);
  if (coord) {
    coord.convPager = "exhausted";
    // R-CNV-02: 進行表示は Host の complete と pager の exhausted が揃ったときだけ消す。
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
  // droppedCount で判定しない。落ちた区間が会話に描けないイベントだけでも追走を起こす（verify-conversation-history#CH-C20mut-a）。
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
  // 起点は画面に出ている最古。Host の resume 時点の起点に任せると、窓から落ちた復元ブロックが黙って欠ける（verify-conversation-history#CHmut-4）。
  const pager: HistoryPager = {
    status: "idle",
    retried: false,
    anchorUuid: t.oldestConversationUuid(),
    phase: eventAnchor !== undefined ? "events" : "transcript",
    eventAnchor,
  };
  convPagers.set(tabId, pager);
  if (coord) coord.convPager = "running";
  // R-CNV-01: 開いた時点で追走を始める（verify-conversation-history#CH-C31amut）。
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
  // 並列 fetch にしない。同時要求は cursor 空間を壊す（R-CNV-01）
  if (pager.status === "inflight" || pager.status === "exhausted") {
    stopConvChase(pager);
    return;
  }
  // R-CNV-01: 非表示の面へは要求を出さずに退避し、convPaneVisible になったら resumeConversationChase で継ぐ。
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
  // R-CNV-01: 見えていない面へは描かず、cursor を進めずに退避する。戻ったら同じ chunk から読み直す。
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
  // skipped と continued を duplicates へ畳まない。畳むと重複だったと読まれる。
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
  // 描画失敗の件数は進行表示が消える前に会話面へ出す（verify-conversation-history#CHmut-C41c）。
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
    // 続けられないのに残件があるときは停止として扱い、読了として消さない。
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
    // events が描画なしで尽きても止めずに transcript へ入る。
    if (pager.autoSteps !== undefined) {
      // phase で数える単位が変わるので、残件の比較・分母・上限を取り直す（verify-conversation-history#CH-C31bmut2）。
      pager.lastRemainingOlder = undefined;
      pager.phaseInitialRemaining = undefined;
      pager.chaseBudget = pager.autoSteps + 1;
      requestConversationChunk(tabId);
    } else {
      // R-CNV-02: 到達しない想定の保険。追走が止まったまま phase だけ移ると、進行表示が読み込み中のまま残り再開手段も出ない。
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
    items: Array<{ uuid: string; role: "user" | "assistant"; text: string; imageRefs?: ImageRefInfo[] }>;
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
  // R-CNV-01: 見えていない面へは描かず、cursor を進めずに退避する（verify-conversation-history#CH-C33mut）。
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
  // R-DSP-03: 欠落の注記は進行表示が消える前に出す（verify-conversation-history#CHmut-C40）。
  const gapNote = conversationHistoryGapNote(page.coverage);
  // 描画失敗も同じ注記に並べる。events 位相の分も renderFailedTotal に累計済み（verify-conversation-history#CHmut-C41）。
  if (result.failed > 0) pager.renderFailedTotal = (pager.renderFailedTotal ?? 0) + result.failed;
  const renderNote = conversationRenderFailureNote(pager.renderFailedTotal ?? 0);
  const historyNote = [gapNote, renderNote].filter((n): n is string => n !== undefined).join(" ");
  if (historyNote.length > 0) t.setConvHistoryNote(historyNote);
  refreshFindAfterPrepend(tabId);
  t.realignScrollAnchor();
  // cursor が無効になったときの取り直しは anchorUuid から始まるので、描画済みの最古を控える。
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
  // R-CNV-01: 一過性のエラーでも追走の状態を落とさない（verify-conversation-history#CH-E2mut）。無限に続かないのは、
  // retried が再 anchor を応答の成功まで 1 回に限り、前進の検査を convChaseContinues が持つため。
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

// 進行表示の本文に理由コードを生で出さない（R-DSP-12）
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
  // 一過性の失敗は cursor を捨て、anchorUuid（画面の最古）から取り直す。Host の起点に任せると遡った位置が黙って巻き戻る。
  // R-CNV-01: 追走の状態は落とさない（verify-conversation-history#CH-E1mut）。session-scan-failed は解けうるので一過性に含め、
  // 終端にしない（verify-conversation-history#CH-C7b-mut）。
  const transient =
    reason === "invalid-cursor" ||
    reason === "history-unavailable" ||
    reason === "stale-request" ||
    reason === "session-scan-failed";
  if (transient && pager.receivedTranscriptChunk !== true) {
    // chunk を受け取る前の一過性失敗は CONV_FIRST_CHUNK_RETRY_DELAY_MS 置いて取り直す。再読込直後は Host 側の登録し直しと
    // 重なって続く（verify-conversation-history#CH-T2mut）。使い切っても即時の取り直しへ落とさない。失う cursor が無く、
    // ロックもまだ解けていない（verify-conversation-history#CH-T3mut-a）。
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
  // 終端にするのは遡る対象が無いと確定した理由だけ。取り直しても結果が変わらず、そのたびに Host が記録を全読みする。
  // 一過性の理由を使い切った場合は error として出す。
  if (reason === "session-unavailable" || reason === "unknown-anchor") {
    pager.status = "exhausted";
    finishConvChaseProgress(tabId);
    return;
  }
  pager.status = "error";
  // 取り直しを使い切ったことを本文に出す（verify-conversation-history#CH-T3）。
  const attempts = pager.receivedTranscriptChunk !== true ? (pager.firstChunkRetries ?? 0) : 1;
  const label = CONV_HISTORY_ERROR_LABELS[reason as ConversationHistoryErrorReason] ?? l10n.t("a failure whose reason could not be determined");
  failConvChaseProgress(
    tabId,
    reason,
    transient ? l10n.t("Transient failures persisted ({0} · retried {1} times)", label, attempts) : undefined
  );
}

// lastWorkModels をここで消さない。addTab が installHistoryPager より前に控えた値を refreshLocalDropViews が使う。
function dropHistoryPager(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager?.timer !== undefined) clearTimeout(pager.timer);
  historyPagers.delete(tabId);
}

// 視界補正の可否にだけ使う。発行条件にすると見えていないタブが読み進まない（verify-history-prepend#HPmut-11）。
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
  // 実行ログを遡っている間は止め、syncWorklogBackfillScroll と retryWorklogBackfill で再開する
  // （verify-history-prepend#HPmut-15、verify-history-prepend#HPmut-19）。R-TAB-07: 見るのは実行ログの張り付きで、
  // 表示中のサブタブの位置ではない。
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

// R-TAB-08: 最下部へ戻してから始める。戻さないと mayRequestBackfill が偽のまま要求が出ない（verify-history-prepend#HPmut-19）。
function retryWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  const t = tabs.get(tabId);
  if (pager === undefined || t === undefined) return;
  if (pager.status === "inflight" || pager.status === "exhausted") return;
  t.stickWorkToBottom();
  pager.wasAtBottom = true;
  startWorklogBackfill(tabId);
}

// R-TAB-08: 進行表示は pager が exhausted になったときだけ消す。残件数からは消さない（verify-history-prepend#HPmut-17）。
function finishWorklogBackfill(tabId: string): void {
  const coord = resumeCoordinators.get(tabId);
  if (coord) {
    coord.workPager = "exhausted";
    // R-TAB-08: Host の complete と pager の exhausted が揃ったときだけ消す。
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

// error で止まった裏読みはアクティブ化で再開しない。再開は retryWorklogBackfill だけ。
function resumeWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager === undefined) return;
  if (pager.status !== "idle") return;
  startWorklogBackfill(tabId);
}

// 最下部へ戻った遷移で再開する（verify-history-prepend#HPmut-15）。毎スクロールでは要求しない。
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
  // cursor が進まない応答で無限追走にしない（R-TAB-07）
  if (page.nextCursor === usedCursor) {
    reportWebviewDiagnostic("error", `worklog backfill stopped: cursor が進んでいない (tab=${tabId})`);
    return false;
  }
  // 0 件で hasMore を信じ続けると終端へ着かない（R-TAB-07）
  if (returnedCount === 0) {
    reportWebviewDiagnostic(
      "error",
      `worklog backfill stopped: 0件の chunk で hasMore=true (tab=${tabId})`
    );
    return false;
  }
  const remaining = page.coverage.remainingOlderCount;
  // 残件が減らない応答は前進していない（R-TAB-07）
  if (pager.lastRemainingOlder !== undefined && remaining >= pager.lastRemainingOlder) {
    reportWebviewDiagnostic(
      "error",
      `worklog backfill stopped: 残件数が減らない (${pager.lastRemainingOlder} -> ${remaining}, tab=${tabId})`
    );
    return false;
  }
  pager.lastRemainingOlder = remaining;
  // R-TAB-07: 予算は初回応答の coverage から導く。chunk は最低 1 件を返す（src/history-serving.ts#HISTORY_CHUNK_MIN_ITEMS_LADDER）
  // ので、予算を超える往復は cursor か索引が壊れている。固定値にすると 1 件ずつ返る長い履歴で足りない。
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

// R-TAB-07 / R-TAB-08: 手動の読み込みボタンを置かず、窓落ちを裏読みで埋める。ここでは要求を出さない。init は全タブを
// 作るので、出すとタブの数だけ連鎖が同時に走る（verify-history-prepend#HP-C25）。
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
  // 誤った anchor を送ると Host が欠落区間を黙って落とすので、initialHistoryAnchor が取れなければ遡らない。
  if (anchor === undefined) {
    if (coord) coord.workPager = "exhausted";
    return;
  }
  historyPagers.set(tabId, { phase: "events", status: "idle", anchor, retried: false, noteEl });
  if (coord) coord.workPager = "running";
}

// localEventDrops を合流する前の値。窓落ちを足した表示用の値と混ぜない。
function hostCoverage(tabId: string): WorkModelPayload["coverage"] | undefined {
  return lastWorkModels.get(tabId)?.coverage ?? lastSemanticModels.get(tabId)?.model?.coverage.base;
}

// R-DSP-01: 現在の droppedEventCount を使わない。再生より後に落ちた分は live で描き終えている。
function coverageUnreachableBase(tabId: string): number {
  return hostDroppedAtInstall.get(tabId) ?? 0;
}

function coverageBackfillHint(tabId: string): CoverageBackfillHint {
  const pending = localEventDrops.get(tabId) ?? 0;
  const pager = historyPagers.get(tabId);
  const base = coverageUnreachableBase(tabId);
  // pager が無いのは遡る先が無いときか hydration が終わっていないときで、resumeCoordinators で見分ける。前者を読了にしないと
  // live の切り詰めで直近のみの表示が残り続ける。
  const coord = resumeCoordinators.get(tabId);
  const settled =
    pager === undefined ? coord === undefined || coord.workPager === "exhausted" : pager.status === "exhausted";
  // 止まった遡りも件数は確定している。出さないと欠けが黙って消える（R-DSP-03）
  const stopped = pager?.status === "error";
  const unreachable =
    !settled && !stopped
      ? 0
      : pager?.phase === "transcript"
        ? pager.transcriptRemaining ?? base
        : base;
  // R-DSP-03: pager の無いタブでは復元時に外した件数が残っているので、restoreCapped なら complete を名乗らない。
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

// src/protocol.ts#withLocalEventDrop と同じ規則を coverage.base へ当てる。変えるときは両方を変える。
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
  // R-DSP-03: 窓落ちが無くても付記は載せる。載せないと記録から読めなかった欠落が semantic の画面にだけ出ない。
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

// 受信を待たずに描き直す。受信時にしか withLocalEventDrop を当て直さないと、idle 中に遡り終えても前方切り詰めの表示が残る。
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

// requestId だけで照合し、generation を破棄条件に使わない。CLI の再起動で世代だけ進んでも Host の登録は生きている。
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
  // R-TAB-07: 見えていない面へも描き、補正だけ落とす。
  const correct = mayCorrectScroll(tabId);
  let result;
  try {
    // 測定から補正までを同じ同期ブロックで行う。間にフレーム待ちを挟むと跳ねが見える。
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
    // acceptHistoryResponse がタイマーを消しているので、ここで error にしないと inflight のまま固着する。
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
    // 描画失敗の件数は実行ログの先頭に残す（verify-conversation-history#CHmut-C41d）。
    pager.renderFailedTotal = (pager.renderFailedTotal ?? 0) + result.failed;
    const text = worklogRenderFailureNote(pager.renderFailedTotal);
    if (pager.renderFailNoteEl === undefined || !pager.renderFailNoteEl.isConnected) {
      pager.renderFailNoteEl = t.addHistoryNotice(text);
    } else {
      pager.renderFailNoteEl.textContent = text;
    }
  }
  reduceLocalEventDrops(tabId, result.rendered + result.skipped);
  // 未接続のコンテナへの appendChild は例外を出さないので、件数に加えて connected も突き合わせる。
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
    // R-TAB-08: 続けられないのに残件があるときは停止として扱い、読了として消さない。
    if (chase) {
      requestHistoryChunk(tabId);
      return;
    }
    // idle に置くと resumeWorklogBackfill と syncWorklogBackfillScroll が再開してしまう。
    pager.status = "error";
    failWorklogBackfill(tabId, "stalled");
    return;
  }
  const host = hostCoverage(tabId);
  // R-TAB-08: 現在値でなく coverageUnreachableBase を使う。現在値だと live で描き終えた分まで読みに行き、終端が矛盾して止まる。
  const hostDropped = coverageUnreachableBase(tabId);
  // live で作ったタブは記録の fold とイベントの番号が対応せず Host も history-unavailable で拒むので、resumeSessionId の
  // あるタブだけ transcript 位相へ入る。入れない分は記録から読めなかった件数として残す（verify-history-prepend#HP-R48-3）。
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
  // stale-request は CLI の再起動による世代更新で出るので一過性に含める。
  const transient = reason === "invalid-cursor" || reason === "unknown-anchor" || reason === "stale-request";
  if (transient && !pager.retried && pager.anchor !== undefined) {
    pager.retried = true;
    pager.cursor = undefined;
    pager.status = "idle";
    requestHistoryChunk(tabId);
    return;
  }
  pager.status = "error";
  // 取り直さない経路は失敗表示に「再開」を残す。黙って止めない（R-TAB-08）
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
  // 切り詰め分（backfillTotal）を読みに来て初回が空の終端なのは矛盾。終端扱いにすると何も積まずに全件表示になる。
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
  // 残件（transcriptRemaining）を終端で 0 へ上書きしない。渡されなかった分が読了として隠れる
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
  // 並列 fetch にしない。同時要求は cursor 空間を壊す。この早期 return が
  // スクロール再開路（syncWorklogBackfillScroll）の二重発行防止も兼ねる（R-TAB-07）
  if (pager.status === "inflight" || pager.status === "exhausted") return;
  if (pager.cursor === undefined && pager.anchor === undefined) return;
  // 同時に走る連鎖をアクティブタブの 1 本に抑える。他のタブは idle のまま resumeWorklogBackfill で継ぐ（verify-history-prepend#HPmut-16）。
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

// backfilledHead の窓では先頭が戻した飛び地なので、その次を anchor にする。先頭にすると窓外の区間が黙って落ちる（verify-history-prepend#HPmut-6）。
function initialHistoryAnchor(
  windowed: { events: NormalizedEvent[]; backfilledHead: boolean }
): { generation: number; seq: number } | undefined {
  const at = windowed.backfilledHead ? 1 : 0;
  const ev = windowed.events[at];
  if (ev === undefined) return undefined;
  return { generation: ev.generation, seq: ev.seq };
}

// R-TAB-07: 飛び地で anchor を上書きしない。上書きすると再 anchor や transcript の要求で窓外の区間が黙って落ちる。
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
    // Date.now を使わない（verify-time-buckets#TB-7）。performance.now は document の経過時間なので、再送と別 document の起動を見分けられる。
    reportWebviewDiagnostic(
      "ready-retry",
      `init not received; retry ${readyRetries}; docAge=${Math.round(performance.now())}ms; sinceReady=${Math.round(performance.now() - readySentAt)}ms`
    );
    sendReady();
  }, INIT_RETRY_DELAY_MS);
}

// headOmitted を droppedCount へ合流する。しないと installHistoryPager が遡る先が無いと判定し、復帰のたびに古い区間が黙って消える。
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
  // 明示 off を運ぶのは snapshot だけなので、再生で投げる前に当てる。
  applyLlmDiagnosticsMode(snap.state.llmDiagnostics);
  // R-DSP-01: 作り直しのたびに取り直す。持ち越すと前の中身の数字で被覆を判定する。
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

  // replaySnapshot を経路ごとに複製しない。複製すると変異注入の的が一意に決まらず、片方の欠落を検査が見逃す。
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
    // applyWorkModel を再生より先に当てる。窓から Task の更新が落ちていると TODO 行が無く、配下のツール行が未接続の DOM へ入って消える。
    t.applyWorkModel(model);
    const events = windowed.events;
    for (const ev of events) t.handleEvent(ev);
    // R-SES-11: replayed turn boundaries may clear calls that the current model still observes.
    t.applyWorkModel(model);
    t.replaceBackgroundActivity(snap.state.backgroundActivity);
    // 再生した init イベントは後のモデル・effort の変更より古いので、auth は TabSnapshot の値で上書きする。
    t.auth = snap.state.auth;
    t.setModelFallback(snap.state.modelFallback);
    t.finalizeReplay(snap.state.turnState !== "idle");
    t.noteRenderedEvents(events);
    t.installHistoryHead();
    return { windowed, droppedNoticeEl };
  };

  // Host の履歴窓（src/history-window.ts#registerHistoryWindow）の scope は snapshot の events と同じ列なので、窓に残らなかった分が
  // そのまま遡る先になる。
  const installPagers = (windowed: ReturnType<typeof windowEvents>, droppedNoticeEl: HTMLElement | undefined): void => {
    // R-TAB-07 / R-TAB-08: 窓落ちはタブの種別で分けずに裏読みで埋める。
    installHistoryPager(snap.tabId, windowed, droppedNoticeEl);
    const keptKeys = new Set(windowed.events.map((e) => `${e.generation}:${e.seq}`));
    // Host が落とした先頭側は events に無いので、Host が src/conv-renderable.ts#isConvRenderableEvent で数えた hasConvEvent を合流する。
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
    // loading 中は pager を置かない。Host が登録していない scope へ要求が飛ぶ（verify-conversation-history#CHmut-C1c）。
    dropHistoryPager(snap.tabId);
    dropConvPager(snap.tabId);
    // preview は遡りの起点にしない（verify-conversation-history#CHmut-C1b）。
    t.renderResumePreview(hydration.previewMessages ?? []);
    // R-TAB-08 / R-CNV-02: loading 中も進行表示を出す（verify-history-prepend#HPmut-29）。
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
    // failed でも確定済みの events は replaySnapshot で再生する。再読み込みで送信済みの発言を失わない。
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
    // R-TAB-08 / R-CNV-02: 作り直しで進行表示は消えているので、遡る対象が残る面は応答を待たずに出し直す。待つと点滅する。
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
  // 再生が turnState を上書きするので最後に当て直す。interrupting が running へ戻ると二度目の中断が効かない。
  t.setTurnState(snap.state.turnState);
  // 復元途中に保存しない（setViewMode の persist を偽にする）。tabs が揃う前の保存は他タブの設定を壊す。
  const savedView = vscode.getState()?.views?.[snap.tabId];
  if (savedView === "work") t.setViewMode("work", false, false);
  // 再生中は viewMode が会話面のままで注意表示が付かないので、復元後に syncConvAttention で貼り直す。
  t.syncConvAttention();
  // 持ち越す位置があるときは resetScrollPosition を呼ばない。applyScrollCarry が入れ、活性化の restoreScroll が最後に当てる。
  t.resetReplayArtifacts();
  if (scrollCarry === undefined) t.resetScrollPosition();
  // 概要は installHistoryHead の後に作る。先に作ると取り寄せた過去の chunk が概要の上に積まれる。
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
  // 明示 off と未着を区別して渡す（verify-webview-wiring#T4-4）。
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
  // R-CNV-02 / R-TAB-08: deferred のタブは空を何も無いと見せない。tabRestored の作り直しで消える。
  if (snap.deferred) {
    // loading 分岐と同じ綴りにしない。変異注入の的が一意でなくなる（verify-history-prepend#HPmut-29、verify-conversation-history#CHmut-C1c）。
    const preparing = { phase: "preparing" } as const;
    t.setConvLoadProgress(preparing);
    t.setWorkLoadProgress(preparing);
  }
  return t;
}

// preserveScroll は中身が同じ会話の作り直し（tabRestored）でだけ真にする。
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
  // 保存済みの位置は前の中身の行を指すので、document が作り直される前に persistState で書き換える。
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

// setActiveTab が投げても空白画面で終わらせず、次の候補を試す（verify-webview-wiring#sol-2）。
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
    // isHostToWebview で拒否したメッセージは黙って捨てず [drop] を記録する。
    if (!isHostToWebview(raw)) {
      console.warn("[drop] invalid host message", (raw as { type?: unknown })?.type);
      return;
    }
    const msg = raw;
    switch (msg.type) {
      case "init": {
        const initAt = performance.now();
        // captureScrollCarry は destroy より先に呼ぶ。後では DOM が外れて測れない。
        const scrollCarries = new Map([...tabs].map(([tabId, t]) => [tabId, t.captureScrollCarry()]));
        for (const t of tabs.values()) t.destroy();
        tabs.clear();
        overviews.clear();
        // pager はタブの DOM と同じ寿命。残すと作り直したタブへ旧世代の応答が当たる。
        for (const tabId of [...historyPagers.keys()]) dropHistoryPager(tabId);
        for (const tabId of [...convPagers.keys()]) dropConvPager(tabId);
        lastWorkModels.clear();
        lastSemanticModels.clear();
        localEventDrops.clear();
        hostDroppedAtInstall.clear();
        initReceived = true;
        if (initRetryTimer) clearTimeout(initRetryTimer);
        // PROTOCOL_VERSION の食い違いでは止めずに注記する。詳細ログが黙って空になる理由を出す。
        const versionMismatch = msg.protocolVersion !== PROTOCOL_VERSION;
        // タブを描く前に入れる。後から入れると描画済みの本文が Windows 前提の拒否のまま残る（R-CNV-12）
        setFileLinkHostPlatform(msg.hostWindows ?? true);
        setFileLinkSystemAppExtensions(msg.systemAppExtensions);
        for (const snap of msg.tabs) {
          try {
            addTab(snap, scrollCarries.get(snap.tabId) ?? savedScrollCarry(snap.tabId));
          } catch (error) {
            reportWebviewDiagnostic("error", `init tab failed: ${String(error)}`);
            // addTab は再生より先に tabs へ入れるので、外さないと壊れたタブが activate の候補に残る（verify-webview-wiring#sol-2）。
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
        // setActiveTab は同じタブへの切替では inputEl を書き換えないので、ここで下書きを戻す。
        if (chosen) {
          inputEl.value = drafts.get(chosen) ?? "";
          autosizeComposer();
          activateFirstUsableTab(chosen);
        }
        activeTabAfterInit = activeTabId;
        // init の受信から活性タブが載るまでを測る。Date.now を使わない（verify-time-buckets#TB-7）。
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
        // 新しく追加された行にも syncVisibility で表示切替を当てる。
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
        // 追送 preview は描く（verify-conversation-history#CHmut-C39）。ただし convTouched なら描かない。renderResumePreview は
        // 末尾へ足すので、過去の会話が live の表示より後ろに並ぶ（verify-conversation-history#CHmut-C39b）。
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
        // src/webview/tab.ts#applyWorkModel; src/webview/tab.ts#applyLogModel
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
        // Host は semanticView が有効なときだけ送るので view を真にする（verify-webview-wiring#S3-3）。
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
        // 最後に観測したのが明示 off なら payload を描かない（verify-webview-wiring#D5-5）。
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
        // 作業ログと会話の両方の pager がこの応答を使うので、requestId で振り分ける。
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
        // init が同じ tabId を先に運んでいることがある。重ねて addTab すると閉じても古い DOM が残る（verify-webview-wiring#TR-13）。
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
          t.models = msg.models;
          if (activeTabId === msg.tabId) {
            renderAuth(t);
            if (!authPickerEl.classList.contains("hidden")) {
              // openAuthPicker で開き直すとカーソルとフォーカスが飛ぶので、開いたまま作り直す。
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
              // openAuthPicker で開き直すとカーソルとフォーカスが飛ぶので、開いたまま作り直す。
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
              // openAuthPicker で開き直すとカーソルとフォーカスが飛ぶので、開いたまま作り直す。
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
        // 差分でなく全量で attachmentsByTab を置き換える。差分だと応答の入れ違いで消えた添付が戻る。
        if (msg.items.length === 0) attachmentsByTab.delete(msg.tabId);
        else attachmentsByTab.set(msg.tabId, msg.items);
        if (activeTabId === msg.tabId) renderAttachments();
        break;
      }
      case "sessions": {
        applySessionChunk(msg.requestId, msg.sessions, msg.complete, msg.degraded, msg.source, msg.nextCursor, msg.append);
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
      case "cachedUsage": {
        cachedUsageFetchedAt = msg.fetchedAtMs;
        for (const l of msg.limits) {
          if (rateLimits.has(l.type)) continue;
          // rateLimits と同じ単位で届くので換算しない。
          rateLimits.set(l.type, { utilization: l.utilization, resetsAt: l.resetsAt, isUsingOverage: false });
        }
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
          // persistState より先に activeTabId を外す。残すと persistState が閉じたタブの下書きを書き戻す。
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

// R-CNV-11: 添付の実体は Host が持ち、attachmentsByTab は描画用の写し。送信の積荷をここから作らない。document の破棄で消え、
// 送信時のタブを取り違える。
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
      // 読み込み完了の時点では折り返し後のレイアウトがまだ読めないので、次のタスクで reflowComposer の settle を呼ぶ。
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
  // R-CNV-11: 宛先は読み取り開始時のタブで固定する。onload で activeTabId を引き直すと、読み取り中の切替で別の会話へ入る。
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

// R-CNV-11: latestPickFilesReqId と pickFilesTabId は同時に更新する。片方だけだと受理される応答の宛先が別の要求のタブになる。
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
  // 古いダイアログ応答で入力欄を書き換えない（R-CNV-05）
  if (reqId !== latestPickFilesReqId) return;
  // 宛先はダイアログを開いた時点のタブ。ダイアログは待たされるので activeTabId は動きうる
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

// コンポーザ（送信/中断ボタン・入力欄・添付・新規タブ・書き出し）のリスナ登録。
// 文の並びがリスナの登録順なので、入れ替えてはならない。
function initComposer(): void {
  actionBtn.onclick = () => {
    const t = activeTab();
    if (!t) return;
    if (t.turnState === "idle") send();
    else if (activeTabId) {
      // Host は中断中への遷移をイベントで通知しないので、ここで setTurnState する。
      t.setTurnState("interrupting");
      vscode.postMessage({ type: "interrupt", tabId: activeTabId });
    }
  };
  inputEl.addEventListener("keydown", (e) => {
    // keyCode 229 は isComposing を立てない IME 確定（Windows の一部 IME）
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
    // 既に最下部なら scroll イベントが出ないので、syncWorklogBackfillScroll を直接呼ぶ。
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
      // openFindBar の先入れ検索がスクロールするので、遡り待ちを先に諦める。
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
    // 狭い幅では省略記号で切るため、全文は title に残す（R-DSP-03）
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

// 実測（probe-commands）で応答0文字＝無反応だったコマンド（/doctor は応答があるため対象外）。素通しすると打っても
// 何も起きないので、理由と代替手段を会話へ出す。
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
  // 中断中のターンへ入力を混ぜない。inputEl は消さず再送できるようにする。
  if (activeTab()?.turnState === "interrupting") {
    activeTab()?.addBlock("system warn", l10n.t("Cannot send while interrupting."));
    return;
  }
  const text = inputEl.value.trim();
  if (text === "/clear") {
    // R-SES-08: 実行中はローカルで先に拒否し、入力欄は消さない
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
      // /model 経路はフォーカスが入力欄にあるので、閉じたら入力欄へ戻す。
      // 開くのは現在のクリックディスパッチ完了後にする（▶ボタン送信のとき、
      // 気泡が document の外側クリック判定に届いて開いた直後に閉じられるため）
      queueMicrotask(() => openAuthPicker(inputEl));
    }
    return;
  }
  // 素通しすると CLI のセッション色が変わるだけで拡張の見た目は変わらないので、openThemePicker を送る。
  if (text === "/color" || text === "/theme") {
    clearComposerInput();
    persistState();
    vscode.postMessage({ type: "openThemePicker" });
    return;
  }
  // 素通しすると CLI が端末用のピッカーを出そうとして何も起きないので、openHistPanel を開く。
  if (text === "/resume" || text === "/history") {
    clearComposerInput();
    persistState();
    queueMicrotask(openHistPanel); // ▶クリックの気泡で即閉じされるのを避ける（M-1と同じ理由）
    return;
  }
  // 素通しすると CLI がこのセッションだけに適用し、拡張側の状態と設定ファイルが食い違うので setEffort を送る。
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
  // /usage は既存の使用量ポップアップを開く。素通しすると CLI が端末用の画面を出そうとして
  // 応答が0文字になり何も起きないため（実測済み）。
  if (text === "/usage" || text.startsWith("/usage ")) {
    clearComposerInput();
    persistState();
    queueMicrotask(openUsagePanel); // ▶クリックの気泡で即閉じされるのを避ける（M-1と同じ理由）
    return;
  }
  // /rename はローカルで受ける。SDK へ素通しすると custom-title が JSONL に書かれず、
  // タブ名にも履歴一覧にも反映されない（R-SES-05）。実行中でも受ける（ターンへは投入しない）
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
  // UNSUPPORTED_TERMINAL_COMMANDS は先頭の語で引く。完全一致だと引数付きが素通しになる。
  const unsupportedTerminalCommand = UNSUPPORTED_TERMINAL_COMMANDS.get(text.split(/\s+/)[0]);
  if (unsupportedTerminalCommand !== undefined) {
    // 出力先のタブが無いときは clearComposerInput を呼ばない。
    const t = activeTab();
    if (!t) return;
    clearComposerInput();
    persistState();
    t.addBlock("system warn", unsupportedTerminalCommand);
    return;
  }
  if ((!text && attachmentsOf(activeTabId).length === 0) || !activeTabId) return;
  // 発言は Host が記録して返す user_message で描く。ここで描くのは hydration の loading 中の楽観バブルだけ。
  clearComposerInput();
  persistState();
  const t = activeTab();
  if (t && !running) {
    t.pendingSend = true;
    t.setTurnState("running");
  } else if (t && running) {
    t.addBlock("system", l10n.t("Added to the running turn"));
  }
  // R-CNV-11: images は楽観バブルの表示用で、送信には載せない。添付欄はここで消さない。消すと Host が拒否した送信で添付が失われる。
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

// webview の周期実行はこの単一タイマーだけに置く（verify-webview-wiring#D6-8）。タブごとに持つと閉じたタブで止め漏れる。
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

// 下の init 列がトップレベル副作用の登録順を決める。並べ替えない。import の並びに依存させると、import の自動整列で検査を
// 通ったまま振る舞いが変わる。src/webview/dom.ts の DOM 生成は import 時に走るのでこの列に入れない（check-load-order）。

// 例外通報は init 列より先に登録する。後ろに置くと初期化中の例外で通報も sendReady も失われる（verify-webview-wiring#sol-2）。
window.addEventListener("error", (event) => {
  reportWebviewDiagnostic("error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportWebviewDiagnostic("error", event.reason);
});
// 1 つが投げても残りの初期化と sendReady まで到達させる（verify-webview-wiring#sol-2）。
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
// initMessageBus より後に送る。先に送ると最初の init を取りこぼす。
sendReady();
// sendReady まで到達したので、bundle より前に置いた起動監視を止める。
window.__laisoraBootstrap?.complete();
