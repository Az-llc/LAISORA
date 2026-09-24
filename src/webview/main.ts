import { installAccent } from "./accent";
import { prependPreservingView } from "./history-scroll";
import * as l10n from "@vscode/l10n";

const applyAccent = installAccent();

// LAISORA Webview のエントリ（表示専用・プレーンTS。Conversation の実体は Node 側）
// ここに残るのはタブ管理・chrome描画・usageパネル・composer・分析レポートの sessionId キー保持と
// コンポーザ無効化・メッセージ受信の配線、そして末尾の init 呼び出し列。
// セキュリティ規約（全モジュール共通）: モデル/ユーザー由来テキストは必ず textContent 経由で
// DOM 化する（innerHTML に流さない）。

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
import { IMAGE_MAX_COUNT, PROTOCOL_VERSION, RENAME_TITLE_MAX, isHostToWebview, withLocalEventDrop } from "../protocol";
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
  finishAnalysisRequest,
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

// menu.ts と共有する定数。専用の const.ts は作らず
// ここに置く。menu→main の値辺は既にあるので、この共有で新しい依存辺は増えない。
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
// 作業ログ内の概要ビュー。Tab と同じ寿命だが tab.ts へは持たせない（概要は phase 単位、
// 詳細カードは segment 単位で、同じ WorkModel を別の粒度で描く別ビューのため）
const overviews = new Map<string, WorkOverview>();
setOnTabActivity((tabId, active) => overviews.get(tabId)?.setActive(active));
setOnConvViewShown((tabId) => resumeConversationChase(tabId));
// 同期再生上限でこの画面が落とした詳細イベント数。Host の coverage は Host 側の切り詰めしか
// 知らないので、以後の workModel 更新にもこの分を合流させ続ける
const localEventDrops = new Map<string, number>();
// タブを組んだ時点で Host が既に落としていた件数。この画面に一度も描かれていない行はこれだけで、
// 以後 live で増える切り詰めは画面に描き終えている。タブを作り直すたびに取り直す
const hostDroppedAtInstall = new Map<string, number>();
export let activeTabId: string | null = vscode.getState()?.activeTabId ?? null;
// init が選んだ活性タブ。tabCreated が init 済みのタブを作り直すとき、利用者がその後に別タブへ移っていなければ activate を当てる
let activeTabAfterInit: string | null = null;
// タブ毎の下書き退避（レビューP2-3: 共有textareaのままだと誤タブ送信が起きる）。
// Webviewコンテキスト破棄でも消えないよう vscode state に永続化（codexレビューC1-7）
const drafts = new Map<string, string>(Object.entries(vscode.getState()?.drafts ?? {}));
// 閉じたタブのID。views はマージ保存なので、明示的に落とさないとエントリが永久に残る。
const forgottenTabIds = new Set<string>();

// tabIdごとの読取・裏読み統括
export type ResumeHostState = ResumeHydrationPhase;
export type ResumePagerState = "not-installed" | "running" | "exhausted" | "failed";

export interface ResumeLoadCoordinator {
  host: ResumeHostState;
  workPager: ResumePagerState;
  convPager: ResumePagerState;
  journalEventIds: Set<string>;
  // FP-1: Phase 1 の描画から追送 preview が届くまでの間に会話面へ何か出たか。
  // renderResumePreview は末尾へ足すだけなので、出ていたら過去の会話がそれより後ろに並ぶ
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

// 前の document が残した位置は、この document でそのタブを初めて作るときだけ使う。
// 以後は同じ document の退避（init の destroy 前）が新しい
const tabsAddedInDocument = new Set<string>();

function savedScrollCarry(tabId: string): ScrollCarry | undefined {
  if (tabsAddedInDocument.has(tabId)) return undefined;
  const carry = savedScrollAnchors()[tabId];
  return isScrollCarry(carry) ? carry : undefined;
}

export function persistState(): void {
  if (activeTabId) drafts.set(activeTabId, inputEl.value);
  // 表示モードはWebviewコンテキスト破棄後も維持する（下書きと同じ扱い）。
  // 保存済みの値へ現在のタブ分を上書きマージする。全置換にすると、復元途中など
  // tabs が揃っていない時点の呼び出しで未登録タブの設定が消える（レビューAR5-C2）。
  const views: Record<string, ViewMode> = { ...(vscode.getState()?.views ?? {}) };
  const workViews: Record<string, WorkViewMode> = { ...(vscode.getState()?.workViews ?? {}) };
  const analysisViews: Record<string, "script" | "ai"> = { ...(vscode.getState()?.analysisViews ?? {}) };
  const scrollAnchors = { ...savedScrollAnchors() };
  const askChecks = { ...(vscode.getState()?.askChecks ?? {}) };
  const out = Object.fromEntries(drafts);
  // 閉じたタブは views / drafts の両方から落とす（AR6-L1）
  for (const id of forgottenTabIds) {
    delete views[id];
    delete workViews[id];
    delete analysisViews[id];
    delete askChecks[id];
    delete scrollAnchors[id];
    delete out[id];
  }
  for (const [id, t] of tabs) views[id] = t.viewMode;
  for (const [id, t] of tabs) workViews[id] = t.workViewMode;
  for (const [id, overview] of overviews) analysisViews[id] = overview.analysisSubtab;
  for (const [id, t] of tabs) scrollAnchors[id] = t.captureScrollCarry(false);
  const next: PersistedState = { activeTabId, drafts: out, views, workViews, analysisViews, scrollAnchors, askChecks };
  vscode.setState(next);
}

// 非表示で document ごと破棄される（retainContextWhenHidden: false）。破棄の直前に届くイベントは
// 未測定なので、位置はスクロールのたびに遅延で書いておく
const SCROLL_PERSIST_DELAY_MS = 250;
let scrollPersistTimer: ReturnType<typeof setTimeout> | undefined;

// スクロール追従状態の記録（アクティブタブの表示中パネル分）。
function initLogsScroll(): void {
  logsEl.addEventListener("scroll", () => {
    if (!activeTabId) return;
    // グラフが溜めた補正を先に当てる。逆順だと補正前の scrollTop が張り付き状態として記録される
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
  // 中身（コピー・開閉・選択）への pointerdown では諦めない。スクロールバーの操作は #logs 自身が target になる
  logsEl.addEventListener("pointerdown", (e) => {
    if (e.target === logsEl) abandonAwaitedScrollAnchor();
  }, { passive: true });
  logsEl.addEventListener("keydown", (e) => {
    if (SCROLL_KEYS.has(e.key)) abandonAwaitedScrollAnchor();
  }, { passive: true });
  // 検索は #logs に触れずに一致箇所へスクロールする（入力のたびの再検索・Enter・前後ボタン）
  findBarEl.addEventListener("input", abandonAwaitedScrollAnchor);
  findBarEl.addEventListener("click", abandonAwaitedScrollAnchor);
  findBarEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") abandonAwaitedScrollAnchor();
  });
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

// 作り直しで窓に無かった行の遡り待ちを、利用者が自分で位置を動かしたら諦める
function abandonAwaitedScrollAnchor(): void {
  if (activeTabId) tabs.get(activeTabId)?.stopAwaitingScrollAnchor();
}

// ---------- 分析（作業ログ内 work-view-switch の第3タブ。裁定A1） ----------

// 保持キーは sessionId（裁定A2）。タブや Webview の init を跨いで残し、resume で同じ
// セッションを開いたタブへ引き継ぐ。描画は各タブの WorkOverview が行う
const analysisReports = new Map<string, { filePath: string; report: AnalysisReport }>();
// ANALYSIS は自前の入力を持たないので、表示中もコンポーザは会話へ送る（SUMMARY・GRAPH・LOG と同じ）
export function refreshComposer(): void {
  inputEl.placeholder = composerPlaceholder();
  refreshChrome();
}

// 切替の最中は #logs の位置がまだ復元前（離れるタブのもの）なので、reflowComposer に
// 張り付きとして記録させない。記録すると restoreScroll が新しいタブを末尾へ飛ばす。
// 世代は、タブ・表示面の切替をまたいで遅れて走る張り付け直し（遅延・画像の読み込み完了）が
// 復元済みの位置を上書きしないために見る
let tabActivationDepth = 0;
let surfaceGeneration = 0;

// 表示面の切替（Tab.setViewMode）からも呼ぶ。切替より前に積まれた張り付け直しを無効にする
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
    // 離れるタブのスクロール位置を、そのタブの現在の表示モードに紐づけて退避する
    const leaving = tabs.get(activeTabId)!;
    leaving.noteScroll();
    leaving.noteLeavingScroll();
  }
  if (activeTabId !== tabId) inputEl.value = drafts.get(tabId) ?? "";
  activeTabId = tabId;
  tabActivationDepth += 1;
  noteSurfaceChange();
  try {
    // 下書きと同じく添付欄も切り替える。ここを落とすと前のタブのサムネイルが残り、
    // 「どのタブに添付したか」が画面から読めなくなる（R-CNV-11）
    renderAttachments();
    persistState();
    // 復帰の init で見ているタブを先に積ませる。Host は可視化の時点で init を送るので、
    // document が作り直されてから伝えても間に合わない
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
    // restoreScroll は scrollHeight / clientHeight から scrollTop を決めるので、
    // コンポーザの高さ確定を先に済ませる（後にすると古い #logs 高さで復元される）
    autosizeComposer();
    // タブごとの表示モードとスクロール位置を復元する（混線させない）
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

// analysis メッセージの行き先。セッションを表示しているタブを優先し、無ければ
// アクティブタブ（履歴パネルから未表示セッションを分析した場合）へ出す
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

// 分析の失敗理由は、結果が出るはずだった分析画面（要求したタブ）へ出す。script は成功時と同じく
// そのタブの分析画面へ切り替える。action は所見の操作元なので表示先だけ描く（R-ANL-11）
function showAnalysisFailure(msg: Extract<HostToWebview, { type: "analysisFailed" }>): void {
  if (msg.reason === undefined) return;
  const tabId = msg.tabId ?? (msg.sessionId !== undefined ? analysisTargetTab(msg.sessionId) : null) ?? activeTabId;
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

// ナビの高さと --log-head-h は #logs の実高から決まる（tab.ts の syncHeadLayout）。DOM が変わらず
// ポート高だけが変わる経路（ウィンドウ/パネル境界のドラッグ・コンポーザの伸長）は Tab 側の
// イベントに現れないので、ここで拾わないとナビがポートより高いまま陳腐化する
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

// コンポーザの高さを現在の内容から導出し直す（1〜8行）。
// height="auto" を挟まないと scrollHeight が伸びた側に張り付いて縮まない。
// textarea はタブ間で共有なので、value を差し替える経路すべてから呼ばないと
// 離れたタブの高さを継承する。
// コンポーザが伸びると #logs が縮む。ナビの高さは #logs の実高から出しているのでここで測り直す
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

// 入力を空にすると高さが戻る＝ #logs の容器高が変わる。生の style.height で戻すと
// 張り付け直しとパネル上限の測り直しを飛ばす
function clearComposerInput(): void {
  inputEl.value = "";
  autosizeComposer();
}

// ステータスバー・ボタン類をアクティブタブの状態で更新
export function refreshChrome(): void {
  const t = activeTab();
  const state = t?.turnState ?? "idle";
  // 実行状態のチップを composer に置かない。実行中かどうかは上部のステータス帯と送信/停止ボタンで示し、
  // composer の横幅を優先する。
  // 送信/中断は1ボタン統合: 実行中は停止ボタンに変化（Copilot Chat 方式）
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
  // 会話面の移動操作。どちらの面を見ていても押せる。「1 つ前の自分の発言」は
  // 会話面へ切り替えてから遡る（scrollToPreviousUserBlock 側）ので飛び先は常にある。
  // 「最新の位置へ」は見ている面の最新へ飛ぶ
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

// 表示するモデル名の出所は CLI が返した行のラベルだけ。行が引けない値は組み立てず、そのまま出す（R-CMD-02）。
// `applied.model` は解決後の id（`claude-opus-5[1m]`）で届くのに対し、一覧の行の id は選択用の綴り
// （`opus[1m]`）なので、id だけで引くと必ず外れて 1M の別名が画面から落ちる。
// `default` の行は同じ resolvedModel を名乗るが「既定」という指し先であってモデル名ではないため、
// resolvedModel での照合からは外す（外すのをやめると実モデル名の代わりに「既定 — …」が出る）
function findModelRow(t: Tab | null, value: string): ModelInfo | undefined {
  const rows = t?.models ?? [];
  return (
    rows.find((m) => m.id === value) ??
    rows.find((m) => m.id !== "default" && m.resolvedModel === value)
  );
}

// setModel の応答(modelChanged)はホストが auth_status を再送しないため、表示は
// modelOverride を最優先し、無ければ auth.model → appliedModel → recordedModel → configModel の順。
export function displayModelName(t: Tab | null): string | undefined {
  const override = t?.modelOverride;
  if (override) {
    const label = findModelRow(t, override)?.label;
    return label && label !== override ? label : t?.modelDisplayName(override) ?? override;
  }
  // 空白だけの値（settings.json の `"model": "   "`）は未設定として扱う。trim しないと truthy のまま
  // 通り、行にも当たらず空文字がそのまま出てチップが無言で空になる。照合も trim 後の値で行う
  const raw = override === null ? "default" : (t?.auth?.model ?? t?.appliedModel ?? t?.recordedModel ?? t?.configModel)?.trim();
  if (!raw) return undefined;
  const info = findModelRow(t, raw);
  // "default" は指し先であって表示できる名前ではない。行が無ければ何も出さない（文字列 "default" を出さない）
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

  if (!auth) {
    const model = modelName || l10n.t("Model unconfirmed");
    authEl.textContent = `${model} / effort: ${effort}`;
    authEl.className = "chip";
    authEl.setAttribute("title", `${model} / effort: ${effort}`);
    return;
  }

  // 課金区分はサブスクなら出さない（他のチップと同じ地色）。それ以外は区分名を前置し、warn 色で従量課金を見落とさせない。詳細は tooltip。
  const model = modelName ?? auth.model ?? "?";
  authEl.textContent =
    auth.billingRealm === "subscription"
      ? `${model} / effort: ${effort}`
      : `${auth.billingRealm} ${model} / effort: ${effort}`;
  authEl.className = auth.billingRealm === "subscription" ? "chip" : "chip warn";
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
  // 常時出す消費情報はコンテキスト利用率のみ。入力・出力・キャッシュ・金額はチップ本文へ
  // 入れず tooltip へ回す（R-CNV-06）
  const chipText = contextUsage ? `ctx ${contextUsage.percentage}%` : CONTEXT_CHIP_EMPTY;
  if (!u) {
    usageEl.textContent = chipText;
    if (contextTitle) usageEl.title = contextTitle;
    else usageEl.removeAttribute("title");
    return;
  }
  // 取れない値は 0 ではなく未取得。cost は total_cost_usd 実額（キャッシュ分含む）。
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

// ---------- usage ポップアップ（Account & Usage 相当。rate_limit_event 由来） ----------
// CLIキャッシュの取得時刻（表示に「いつ時点か」を出すため）。0=キャッシュ未使用
let cachedUsageFetchedAt = 0;
// 利用率の枠。utilization の単位は **0-100 のパーセント** に統一する。
// 生産者が2つ（ライブの rate_limit_event と ~/.claude.json のキャッシュ）あり、どちらも 0-100 で格納する。
// 片方だけ /100 すると同じ Map に2つのスケールが混在し、表示側の `* 100` で100倍ずれる（敵対レビュー R2）。
// SDK型定義は同じ枠(five_hour/seven_day)の兄弟構造に "Percentage of the window used, 0-100"
// と明記しており、実データ(~/.claude.json)も 0-100。よって 0-100 を正とする。
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
  // 未計測のときも行を出す。空欄だと「壊れている」のか「まだ無い」のか区別できない
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
  // ターン未実行でも利用率を出す。CLIが残したキャッシュをホスト経由で読む
  vscode.postMessage({ type: "requestCachedUsage" });
  // usageパネルは他メニューと同時に開けてはならない。呼び出し元によっては外側クリック判定が
  // 走らない（クリック経路は stopPropagation する）ため、開く側で明示的に閉じる
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

// LLM finding の診断面。作業ログの4タブの外へ出す（概要・分析のどちらにも差し込まない）。
// Host はオプトイン時しか llmFindingDiagnostics を送らないので、既定ではこの要素は生成されない
let llmDiagnosticsEl: HTMLElement | undefined;
// snapshot が運ぶ3値の最後の観測値（true=on / false=明示off / undefined=未着）
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

// 明示off で hidden にするだけでは棄却 finding の本文が DOM に残る（裁定A: 棄却は本文も
// 内訳も通常 UI へ持ち込まない）。on になっただけでは作らない — パネルが現れるのは
// payload 受信時だけで、空枠は「未実行」を 0 件と描く形になる
function applyLlmDiagnosticsMode(mode: boolean | undefined): void {
  llmDiagnosticsAllowed = mode;
  if (mode !== false) return;
  if (llmDiagnosticsEl !== undefined) {
    llmDiagnosticsEl.remove();
    llmDiagnosticsEl = undefined;
  }
}

const REPLAY_MAX = 1500; // 再接続時の同期再生上限（レビューP2-2実害分: 巨大ログでのフリーズ防止）
// 応答が来ないままボタンが永久 disabled にならないための保険。Host 側の例外や postMessage の
// 取りこぼしで inflight が固着する経路が塞げない以上、時間で降ろすしかない
const HISTORY_REQUEST_TIMEOUT_MS = 30_000;
// 会話側の最初の transcript 要求（cursor 無し）だけ長く待つ。Host はこの要求で
// セッション JSONL を全読みするので、再読込直後（全タブの snapshot・warmup・裏読みが
// 同時に走る）の大きなセッションでは 30 秒を超えることがある。30 秒で「再開」へ
// 落とすと、Host の応答は届いても捨てられ、押し直せば通る行き止まりだけが残る
const CONV_FIRST_TRANSCRIPT_TIMEOUT_MS = 120_000;
// 1 chunk も受け取る前の一過性失敗は、行き止まりにせず間を置いて取り直す（上限あり）。
// 上限後は従来どおり「再開」を出す（本物の行き止まりは隠さない）
const CONV_FIRST_CHUNK_RETRY_MAX = 3;
const CONV_FIRST_CHUNK_RETRY_DELAY_MS = 2_000;

interface HistoryPager {
  // 会話側だけが使う。描画済みの最古メッセージの uuid（Host 発行の識別子の往復）
  anchorUuid?: string;
  // 会話側だけが使う。遡りの供給元。
  //   "events"     … Host の EventLog（原因A: REPLAY_MAX の窓で落ちた分）
  //   "transcript" … transcript の読み直し（原因B: REPLAY_MESSAGE_MAX で Host にも無い分）
  // events を先に尽くしてから transcript へ移る。events のほうが新しいので、
  // 常に「上へ積む」だけで時系列順になる
  phase?: "events" | "transcript";
  // phase === "events" のときの anchor / cursor（作業ログ側とは独立に進む）
  eventAnchor?: { generation: number; seq: number };
  status: "idle" | "inflight" | "exhausted" | "error";
  // 初回は anchor、2回目以降は cursor。両方載せた要求は Host が拒否する（protocol.ts のガード）
  anchor?: { generation: number; seq: number };
  cursor?: string;
  requestId?: string;
  // 再 anchor による復帰は1回だけ（契約 C11）
  retried: boolean;
  // 自動追走中だけ数える（undefined = 追走していない）。上限と進捗検査で無限追走を作らない
  autoSteps?: number;
  // 会話側だけが使う。追走の歩数上限。応答ごとに残件数から引き直す（固定値を持たない）
  chaseBudget?: number;
  // 会話側だけが使う。会話面が見えなくなった時点で追走を退避した印。可視化で再開する
  chasePaused?: boolean;
  // 会話側だけが使う。進行バーの分母。phase ごとに取り直す（events と transcript で単位が違う）
  phaseInitialRemaining?: number;
  // 直前の応答が申告した残件数。減らない応答が来たら追走を止める根拠にする
  lastRemainingOlder?: number;
  // transcript の chunk を 1 つでも受け取ったか。会話側は受け取る前の一過性失敗だけ
  // 遅延つきの取り直し（firstChunkRetries）を許し、作業ログ側は初回の 0 件終端を矛盾として止める
  receivedTranscriptChunk?: boolean;
  // 会話側だけが使う。1 chunk も受け取る前の遅延取り直しの消費数
  firstChunkRetries?: number;
  // 作業ログ側だけが使う。残り往復の上限。初回応答の coverage から導く（固定値を持たない）
  backfillBudget?: number;
  // 作業ログ側だけが使う。進行バーの分母（開始時点の省略件数）
  backfillTotal?: number;
  // 作業ログ側だけが使う。transcript 位相で記録側に残っている件数（Host 申告の remainingOlderCount）。
  // 読了の判定はこの値で行う（位相に入った事実で判定すると、渡されなかった分が「すべて表示」になる）。
  // Host の切り詰め件数との引き算で代用しない: 記録の fold と live の fold は件数が一致しない
  transcriptRemaining?: number;
  // 作業ログ側だけが使う。直前に観測した作業ログ面の張り付き状態。false→true の遷移で再開する
  wasAtBottom?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  noteEl?: HTMLElement;
  // prepend 中に描画例外で落とした件数の累計。診断だけに書くと進行表示が「読み終わった」として消え、
  // 描けなかった発言・イベントが黙って欠ける（E-36）
  renderFailedTotal?: number;
  // 作業ログ側だけが使う。描画失敗の注記行（件数が増えたら同じ行を書き換える）
  renderFailNoteEl?: HTMLElement;
}

// prepend の間だけ scroll anchoring を止める。
// 自前補正と併用すると二重補正で表示位置がずれる。ただし #logs へ恒久的に overflow-anchor: none を置かない:
// 画面外の上にあるツール行へ結果が届いて行が伸びる（ライブ作業中に普通に起きる）場面で、
// ブラウザの補正分がそのまま表示ジャンプになる（約 260px）。
// 挿入と補正を同一同期ブロックで行い、終わったら必ず元へ戻す
function withoutScrollAnchoring<T>(fn: () => T): T {
  const previous = logsEl.style.overflowAnchor;
  logsEl.style.overflowAnchor = "none";
  try {
    return fn();
  } finally {
    logsEl.style.overflowAnchor = previous;
  }
}

// 会話面の節点を、視界を保ったまま差し替える（画像スロット → 実画像）。
// 見えていない面では scrollHeight が動かず計算が成立しないので補正だけ落とす（契約 C8 / R-TAB-07）。
// 補正を「差し替える節点が視界の上端より上」に限るのは prepend との違い: prepend は必ず先頭へ挿す
// ので全量が視界より上だが、画像スロットは視界より下でも差し替わる（drainImageLoadQueue は末尾の
// スロットから解決する）。下で伸びた分まで足すと、遡って読んでいる利用者の視界がその分だけ飛ぶ。
export function swapPreservingConvView(tabId: string, target: Element, replacement: Node): void {
  if (!convPaneVisible(tabId)) {
    target.replaceWith(replacement);
    return;
  }
  withoutScrollAnchoring(() => {
    const portTop = logsEl.getBoundingClientRect().top;
    const nodeTop = target.getBoundingClientRect().top;
    // noteScroll と同じ式・同じ閾値で測り直す。Tab.atBottom は scroll イベントでしか更新されず、
    // 直前の追記で末尾へ張り付いた状態がまだ入っていないことがある
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
  // 遅れて走る分（cap の反映後・画像の読み込み完了）だけの条件。容器の縮小では scrollTop は
  // 下がらないが、上にある .log-head が縮むと scroll anchoring が同じだけ下げる。縮んだ分で
  // 説明できない下げ幅があるときだけ「利用者が遡った」とみなして諦める
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
  // syncActiveHeadLayout は setTimeout(0) でヘッダ寸法を測り直し、scrollHeight がこの同期の張り付けより
  // 後に動きうる。FIFO なのでここで積む分はその後に走り、末尾へ戻し直せる
  setTimeout(settleLater, 0);
}

const historyPagers = new Map<string, HistoryPager>();
// 概要へ入れ直すための素の WorkModel（localEventDrops 適用前）。prepend で省略件数が
// 変わったときに、最後に届いたモデルへ新しい件数を当て直すために持つ
const lastWorkModels = new Map<string, Parameters<typeof withLocalEventDrop>[0]>();
// 同じ理由で素の SemanticModel も持つ。概要とグラフは semantic があるとき coverage を
// semantic.coverage.base（Host の切り詰めしか知らない）から読むので、こちらへも当て直す
const lastSemanticModels = new Map<string, { model: SemanticModelPayload | undefined; view: boolean | undefined }>();
let historyRequestSeq = 0;

// 会話側の遡り。要求ライフサイクルの規約は作業ログ側と同じで、source と描画先だけが違う
// （契約 P6: 共有するのは pagination primitive まで。reader は共有しない）
const convPagers = new Map<string, HistoryPager>();
let convRequestSeq = 0;

// 自動追走。タブを開いた時点で始まり、終端まで止まらない（R-CNV-01）。
// 「画面に何か出た」ことでは止めない。止めるのは、進捗が確認できない応答
// （同じ cursor・残件数が減らない・0件で hasMore）・取り直せないエラー・時間切れ・
// 終端に達したとき。
// 一過性のエラー（再 anchor で取り直せるもの）では止めない — 止めると要求だけ再開して
// 追走が死に、読み切れないまま進行表示も消えない行き止まりになる
function stopConvChase(pager: HistoryPager): void {
  pager.autoSteps = undefined;
  pager.lastRemainingOlder = undefined;
  pager.chaseBudget = undefined;
}

// 追走を続けてよいか。続けるときだけ true を返し、止める理由があれば診断を出す。
// 呼び出し側は true のときだけ次の1本を出す（同時に2本は出さない）
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
  // 追走の歩数上限。**直前の応答が申告した残件から引き直した値**と比べる。固定値へ戻すと、
  // 1 chunk = 1 件まで落ちた長い会話が終端へ着く前に止まる（R-CNV-01）
  if (pager.chaseBudget !== undefined && pager.autoSteps >= pager.chaseBudget) {
    stopConvChase(pager);
    reportWebviewDiagnostic(
      "error",
      `conv auto-chase stopped: 追走上限 ${pager.chaseBudget} に達した (tab=${tabId})`
    );
    return false;
  }
  // 残件が 1 件ずつしか返らなくても届く歩数。残件は直前の検査で必ず減っているので、
  // ここに余裕を足すと上限そのものが到達不能になる
  pager.chaseBudget = pager.autoSteps + remaining;
  pager.autoSteps++;
  return true;
}

function dropConvPager(tabId: string): void {
  const pager = convPagers.get(tabId);
  if (pager?.timer !== undefined) clearTimeout(pager.timer);
  convPagers.delete(tabId);
}

// 会話面が実際に見えているときだけ扱う。作業ログ側と同じ理由（#logs はタブ横断の単一容器で、
// 非表示パネルは display:none なので scrollHeight が動かず視界維持が成立しない）
function convPaneVisible(tabId: string): boolean {
  const t = tabs.get(tabId);
  return t !== undefined && activeTabId === tabId && t.viewMode === "conv";
}

// R-CNV-02 の帯へ「まだ追いついていない」ことを出す。分母は phase 内で最初に受け取った
// 残件数（events と transcript で数える単位が違うので phase をまたいで通した比は作れない）
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

// 登録した transcript 全体で会話に出せなかった件数の注記。件数を畳まない（どの扉から欠けたかを残す）
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

// 描画例外で落とした発言の注記。診断（Output）だけだと進行表示が消えて「全部出た」に読まれる（E-36）
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

// 先頭へ積んだ分で検索の件数を数え直す。末尾追記（addBlock）だけで数えると過去の一致が出ない（R-26）
function refreshFindAfterPrepend(tabId: string): void {
  if (tabId === activeTabId) refreshFind("end");
}

function finishConvChaseProgress(tabId: string): void {
  tabs.get(tabId)?.stopAwaitingScrollAnchor();
  const coord = resumeCoordinators.get(tabId);
  if (coord) {
    coord.convPager = "exhausted";
    // FP-4 / R-CNV-02: 消す条件は Host=complete AND 対応pager=exhausted のみ
    if (coord.host === "complete") {
      tabs.get(tabId)?.setConvLoadProgress({ phase: "done" });
    }
  } else {
    tabs.get(tabId)?.setConvLoadProgress({ phase: "done" });
  }
}

function failConvChaseProgress(tabId: string, reason: string, detail?: string): void {
  // どの理由が「再開」に至ったかを Output へ残す（理由は banner の title にも出るが、再読込で消える）
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
  // 窓から落ちた区間に会話面へ描ける kind が1件以上あるか。落ちた**全**イベント数
  // （droppedCount）で判定すると、ツール中心の作業では全件 skipped になる区間のために
  // 追走を起こす（原因A M-4）。保証するのは「遡る先が存在する」までで、
  // 途中の chunk で何も描かれないことは残る
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
  // 起点は「いま画面に出ている最古」。Host が持つ resume 時点の値に任せない（原因A で
  // 古い復元ブロックが窓から落ちていると、その差が通知も出ずに欠落する）
  const pager: HistoryPager = {
    status: "idle",
    retried: false,
    anchorUuid: t.oldestConversationUuid(),
    phase: eventAnchor !== undefined ? "events" : "transcript",
    eventAnchor,
  };
  convPagers.set(tabId, pager);
  if (coord) coord.convPager = "running";
  // 過去ログは開いた時点で全件を裏で読む。押させるボタンは置かない（R-CNV-01）
  startConversationChase(tabId);
}

// 追走の入口。ここでだけ追走を開始する（応答経路からは開始しない）
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

// 会話面が見えるようになったときに、退避していた追走を継ぐ。退避していなければ無音
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
  // 非表示パネルへ prepend すると視界維持が成立しない（#logs はタブ横断の単一容器）。
  // 止めずに退避し、会話面が戻ったところで継ぐ（R-CNV-01）
  if (!convPaneVisible(tabId)) {
    pager.chasePaused = true;
    return;
  }
  const requestId = `conv-${++convRequestSeq}`;
  pager.requestId = requestId;
  pager.status = "inflight";
  if (pager.timer !== undefined) clearTimeout(pager.timer);
  // cursor 無しの transcript 要求は Host が JSONL を全読みする（extension.ts の
  // conversationHistoryRequest）。この 1 種だけ長く待つ
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
    // 供給元は Phase 1 と同じ EventLog chunk。作業ログ側とは cursor を共有しないので
    // 会話面の追走と作業ログの遡りは独立に進む（Host 側の切り出しはメモリ上の slice で、
    // 同じ chunk を両面が取っても読み直しは起きない）
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

// 会話面の原因A（EventLog 由来）の応答。作業ログ側と同じ chunk 形だが描く面が違う
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
  // 見えていない面へは描かない。cursor を進めないまま退避するので、戻ったら同じ chunk から
  // 読み直せる（R-CNV-01）
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
  // 内訳は畳まない。skipped（白リスト外）と continued（同 turn の継続）を duplicates へ
  // 混ぜると、事故解析で「その件数が重複だった」と読まれる（原因A M-5）
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
  // 描けなかった件数は進行表示が消える前に会話面へ出す（E-36）。検索の件数も先頭へ積んだ分で数え直す（R-26）
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
    // 次の1本は応答を受け取ってから出す。並列 fetch にはしない。
    // 続けられないのに残件がある＝停止条件が立った状態。読み終わっていないので消さない
    if (chase) requestConversationChunk(tabId);
    else failConvChaseProgress(tabId, "stalled");
    return;
  }
  // 原因A を尽くした。transcript（原因B）へ切り替える。起点は「いま画面に出ている最古」で、
  // ここには今 prepend した復元ブロックも入っている
  pager.cursor = undefined;
  pager.eventAnchor = undefined;
  pager.anchorUuid = t.oldestConversationUuid();
  if (t.hasReplayedConversation() && pager.anchorUuid !== undefined) {
    pager.phase = "transcript";
    pager.status = "idle";
    // EventLog が全件 skipped/duplicate で終端まで来たときは、そのまま原因B へ入る。
    // ここで止めると「17〜18回が2回になっただけ」で、遡る先へ着かない
    if (pager.autoSteps !== undefined) {
      // 数える単位が変わる。残件の比較も進行バーの分母も phase ごとに取り直す
      pager.lastRemainingOlder = undefined;
      pager.phaseInitialRemaining = undefined;
      pager.chaseBudget = pager.autoSteps + 1;
      requestConversationChunk(tabId);
    } else {
      // 現行の停止経路はどれも events の応答を待たずに抜けるので、ここは到達しない想定。
      // 保険として残す: 追走が止まった状態で phase だけ移ると、進行表示が「読み込み中」の
      // まま残り、再開の手段も出ない行き止まりになる（R-CNV-02）
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
  // 見えていない面へは描かない。cursor を進めないまま退避するので、戻ったら同じ chunk から
  // 読み直せる（R-CNV-01）
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
    // 測定 → 挿入 → 再測定 → 補正を同一同期ブロックで（作業ログ側と同じ）
    result = prependPreservingView(logsEl, t.convEl, () => t.prependPastMessages(page.items));
  } catch (error) {
    pager.status = "error";
    stopConvChase(pager);
    failConvChaseProgress(tabId, "prepend-failed");
    reportWebviewDiagnostic("error", `conversation prepend failed: ${String(error)} (tab=${tabId})`);
    return;
  }
  // 突合（契約 P7）。破れたらメッセージがどこかで消えている
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
  // 読めなかった行の申告は終端（進行表示が消える）より前に出す。消えてからでは
  // 「読み終わった」が「全部出た」に読まれる（R-32）
  const gapNote = conversationHistoryGapNote(page.coverage);
  // 描画例外で落とした分も同じ注記に並べる（E-36）。events 位相で落ちた分も pager が累計している
  if (result.failed > 0) pager.renderFailedTotal = (pager.renderFailedTotal ?? 0) + result.failed;
  const renderNote = conversationRenderFailureNote(pager.renderFailedTotal ?? 0);
  const historyNote = [gapNote, renderNote].filter((n): n is string => n !== undefined).join(" ");
  if (historyNote.length > 0) t.setConvHistoryNote(historyNote);
  // 先頭へ積んだ分で検索の件数を数え直す。末尾追記だけで数えると過去の一致が出ない（R-26）
  refreshFindAfterPrepend(tabId);
  t.realignScrollAnchor();
  // 描画済みの最古を控える。cursor が無効になったときはここから取り直すので、
  // 起点が最初の位置へ巻き戻らない
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
  // 一過性の3種は「いま画面に出ている最古のイベント」からやり直す。作業ログ側と同じ規則。
  // **追走の状態（autoSteps / chaseBudget / lastRemainingOlder）は落とさない**（R-CNV-01）。
  // 落とすと取り直しの1本だけが飛んでその先が続かず、復帰した応答が最終ページだった場合は
  // transcript へも移れないまま進行表示が残る。終端は次の2つで担保される:
  // 再 anchor は応答が1回成功するまで1回だけ（pager.retried）/ 前進の検査は応答側に残る
  const transient =
    reason === "invalid-cursor" || reason === "unknown-anchor" || reason === "stale-request";
  if (transient && !pager.retried && pager.eventAnchor !== undefined) {
    pager.retried = true;
    pager.cursor = undefined;
    pager.status = "idle";
    requestConversationChunk(tabId);
    return;
  }
  // 取り直さない経路は追走を止める（応答を待ち続ける状態を残さない）
  stopConvChase(pager);
  // 原因A が読めなくても原因B が残っているなら、そちらへ移って行き止まりにしない
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
  // cursor が落ちる経路（Host の LRU 退避・世代更新）は cursor を捨て、
  // 「画面に出ている最古の uuid」を起点にして取り直す（anchorUuid を載せる）。
  // これが無いと Host は resume 時点の起点から返し直すので、遡った位置が黙って巻き戻る。
  // events 側（onConvEventChunkError）と同じく追走の状態は落とさない（R-CNV-01）
  // session-scan-failed は「有無を確かめられなかった」。同期ロックや競合は解けるので
  // 取り直す。終端（exhausted）にすると進行表示が「読み終わった」として消える（R-17）
  const transient =
    reason === "invalid-cursor" ||
    reason === "history-unavailable" ||
    reason === "stale-request" ||
    reason === "session-scan-failed";
  if (transient && pager.receivedTranscriptChunk !== true) {
    // 1 chunk も受け取る前（再読込直後の最初の要求）の一過性失敗は、間を置いて取り直す
    // （上限 CONV_FIRST_CHUNK_RETRY_MAX）。再読込直後は Host 側で世代更新・登録し直しが重なり、
    // 一過性失敗が連続して「再開」へ落ちる。
    // 0ms の取り直し（下の retried 経路）を先に撃たない: 初回 chunk 前に失う cursor は無く、
    // 同期ロックが原因なら 0ms 後もロックは解けていないので、その 1 本は必ず無駄になる（R-38）
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
    // chunk を受け取った後の一過性失敗は cursor を捨て、画面の最古から 1 回だけ取り直す
    pager.retried = true;
    pager.cursor = undefined;
    pager.status = "idle";
    requestConversationChunk(tabId);
    return;
  }
  // 取り直さない経路は追走を止める（応答を待ち続ける状態を残さない）
  stopConvChase(pager);
  // 取り直しを使い切った一過性の理由（session-scan-failed 等）はこの分岐へ入れない（下の
  // error 側で失敗として出す）。終端にしてよいのは「遡る対象が無い」ことが確定した理由だけ
  if (reason === "session-unavailable" || reason === "unknown-anchor") {
    // 遡る対象が無い / 画面と transcript の集合がずれていて起点が解決できない。
    // どちらも同じ結果になるので行き止まりにする（繰り返すたび Host が 14MB を読み直す）
    pager.status = "exhausted";
    finishConvChaseProgress(tabId);
    return;
  }
  pager.status = "error";
  // 一過性の理由で取り直しを使い切ったことを本文に出す。理由だけだと行き止まりに見える（R-14）
  const attempts = pager.receivedTranscriptChunk !== true ? (pager.firstChunkRetries ?? 0) : 1;
  const label = CONV_HISTORY_ERROR_LABELS[reason as ConversationHistoryErrorReason] ?? l10n.t("a failure whose reason could not be determined");
  failConvChaseProgress(
    tabId,
    reason,
    transient ? l10n.t("Transient failures persisted ({0} · retried {1} times)", label, attempts) : undefined
  );
}

// lastWorkModels はここで消さない。addTab は installHistoryPager（→ ここ）より前に控えるので、
// 消すと resume タブの概要へ省略件数を入れ直す経路（reduceLocalEventDrops）が最初から死ぬ。
// 寿命はタブと同じ（discardTab / tabClosed / init）
function dropHistoryPager(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager?.timer !== undefined) clearTimeout(pager.timer);
  historyPagers.delete(tabId);
}

// 作業ログの履歴ブロックが実際に見えているか。#logs はタブ横断の単一コンテナで、
// 非表示パネルは display:none なので、見えていないところへ prepend しても
// scrollHeight が動かず視界維持の計算が成立しない（契約 C8）。視界補正の可否にだけ使い、
// 要求の発行条件にはしない（見えていなくても裏で読み進める）
function historyPaneVisible(tabId: string): boolean {
  const t = tabs.get(tabId);
  return (
    t !== undefined && activeTabId === tabId && t.viewMode === "work" && t.historyPaneUsable()
  );
}

// 裏読みの発行可否。表示モード・サブタブは見ない（見えていなくても読み進める）
function mayRequestBackfill(tabId: string): boolean {
  const t = tabs.get(tabId);
  const pager = historyPagers.get(tabId);
  if (t === undefined || pager === undefined) return false;
  if (pager.status === "exhausted") return false;
  // 利用者が実行ログを上へ遡っている間は裏読みを止める（守る要件 ID は無い）。
  // 止めたままにすると読み終わらないので、最下部へ戻った遷移
  // （syncWorklogBackfillScroll）と「再開」（retryWorklogBackfill）で再開する。
  // 見るのは実行ログの張り付きで、面（work）の張り付きではない。面の値は概要・分析などいま見ているサブタブの位置なので、
  // それを見ると概要のまま開いたタブで裏読みが始まらない（R-TAB-07）
  if (!t.isWorklogAtBottom()) return false;
  return true;
}

// 視界補正の可否。見えていないパネルでは scrollHeight が動かず補正の計算が成立しない（契約 C8）
function mayCorrectScroll(tabId: string): boolean {
  return historyPaneVisible(tabId);
}

// 裏読みの進行表示。分母は開始時点の省略件数（残件は Host の申告値をそのまま出す）
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

// 「再開」。利用者の明示操作なので、上へ遡って止めた状態（mayRequestBackfill が偽）からでも進める。
// 最下部へ戻さずに startWorklogBackfill を呼ぶと、読み込み中の表示だけ出て要求が出ず、
// status が error のままなのでスクロールの再開路も効かない行き止まりになる（R-TAB-08）
function retryWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  const t = tabs.get(tabId);
  if (pager === undefined || t === undefined) return;
  if (pager.status === "inflight" || pager.status === "exhausted") return;
  t.stickWorkToBottom();
  pager.wasAtBottom = true;
  startWorklogBackfill(tabId);
}

// 消す条件は exhausted ただ 1 つ。呼び出し元は onHistoryChunkResult の終端分岐だけ（R-TAB-08）
function finishWorklogBackfill(tabId: string): void {
  const coord = resumeCoordinators.get(tabId);
  if (coord) {
    coord.workPager = "exhausted";
    // FP-4 / R-TAB-08: 消す条件は Host=complete AND 対応pager=exhausted のみ
    if (coord.host === "complete") {
      tabs.get(tabId)?.setWorkLoadProgress({ phase: "done" });
    }
  } else {
    tabs.get(tabId)?.setWorkLoadProgress({ phase: "done" });
  }
}

// 裏読みの入口。アクティブ化と「再開」からだけ呼ぶ（応答経路からは呼ばない）
function startWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager === undefined) return;
  if (pager.status === "inflight" || pager.status === "exhausted") return;
  showWorklogBackfillProgress(tabId, pager, localEventDrops.get(tabId) ?? 0);
  requestHistoryChunk(tabId);
  refreshLocalDropViews(tabId);
}

// アクティブになったタブの裏読みを始める／退避していた裏読みを継ぐ。
// 失敗で止まったもの（error）は勝手に再開しない — 再開手段は表示の「再開」だけ
function resumeWorklogBackfill(tabId: string): void {
  const pager = historyPagers.get(tabId);
  if (pager === undefined) return;
  if (pager.status !== "idle") return;
  startWorklogBackfill(tabId);
}

// 上へ遡って止まった裏読みは、作業ログ面が最下部へ戻った遷移でだけ再開する。
// 毎スクロールで要求しない: 前回値との比較で遷移を検出する
function syncWorklogBackfillScroll(tabId: string): void {
  const pager = historyPagers.get(tabId);
  const t = tabs.get(tabId);
  if (pager === undefined || t === undefined) return;
  const now = t.isWorklogAtBottom();
  const was = pager.wasAtBottom ?? true;
  pager.wasAtBottom = now;
  if (now && !was && pager.status === "idle") requestHistoryChunk(tabId);
}

// 裏読みを続けてよいか。会話側 convChaseContinues と同じ 3 つの無限ループ検出 ＋ 予算。
// 続けるときだけ true を返し、止める理由があれば診断を出す
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
  // 予算は初回応答の coverage から導く。1 chunk は最低 1 件を返す
  // （HISTORY_CHUNK_MIN_ITEMS_LADDER の末尾が 1）ので、この値を超える往復は構造上ありえない。
  // 超えたら cursor か索引が壊れている。会話側の固定上限を流用しない: はしごが
  // 1 件/chunk まで落ちた状況側では足りない（R-TAB-07）
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

// 作業ログの pager は「窓から落ちた全件を裏で読む」だけ。手動の「さらに読み込む」は置かない
// （R-TAB-07。押されるまで N 件が出ず、被覆行が部分被覆を主張し続ける — R-TAB-08）。
// タブの種別（履歴から開いた・復帰の headOmitted・このセッションで作った）で分けない。
// armed にするだけで要求は出さない（起動はアクティブ化のとき。init が開いている全タブぶん
// addTab を呼ぶので、ここで出すと対象タブの数だけ連鎖が同時に走る）。
// 窓落ちが無いタブは遡る先が存在しないので早期に exhausted
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
  // anchor が取れないのは窓が1件だけで、しかもその1件が戻した turn_started の場合。
  // 誤った anchor を送ると欠落区間を silent に落とすので、遡り不可のまま置く（契約 C10）
  if (anchor === undefined) {
    if (coord) coord.workPager = "exhausted";
    return;
  }
  historyPagers.set(tabId, { phase: "events", status: "idle", anchor, retried: false, noteEl });
  if (coord) coord.workPager = "running";
}

// 概要・グラフへ渡す coverage の付記。この画面に出ていない件数を、裏読みで戻る分と
// 記録からも戻らない分に分けて添える
// Host が最後に送った素の coverage（localEventDrops 合流前）。窓落ちを足した表示用の値と混ぜない
function hostCoverage(tabId: string): WorkModelPayload["coverage"] | undefined {
  return lastWorkModels.get(tabId)?.coverage ?? lastSemanticModels.get(tabId)?.model?.coverage.base;
}

// この画面を組んだ時点で Host が既に落としていた件数。**現在値（coverage.droppedEventCount）を
// 使ってはならない**: 再生より後に落ちた分は live で描き終えており、画面には出ている。
// 現在値で数えると「出していません」が出ている行について出る（R-DSP-01）
function coverageUnreachableBase(tabId: string): number {
  return hostDroppedAtInstall.get(tabId) ?? 0;
}

function coverageBackfillHint(tabId: string): CoverageBackfillHint {
  const pending = localEventDrops.get(tabId) ?? 0;
  const pager = historyPagers.get(tabId);
  const base = coverageUnreachableBase(tabId);
  // pager が無いのは (a) 窓落ちが無く遡る先が無い (b) hydration がまだ終わっていない・失敗した、の 2 つ。
  // (a) は読了と同じ（これを読了にしないと、live の切り詰めで「詳細: 直近のみ」が永久に残る）。
  // (b) は coordinator の状態で見分ける
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
  // 裏読みが一度も走っていないタブ（pager 不在）では、復元時の上限で初期表示から外した件数
  // （omitted*）は解消していない。ここで complete を名乗ると、その申告ごと画面から消える（R-DSP-03）
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

// semantic の coverage.base にも同じ合流を当てる（protocol.ts withLocalEventDrop と同じ規則。
// 変えるときは両方）。当てないと semanticView=on（既定）の概要・グラフは窓落ちを一度も申告しない
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
  // 窓落ちが無くても付記は載せる。載せないと、記録から読めなかった欠落が semanticView=on の
  // 画面にだけ出ない（申告の有無が表示モードで変わる。R-DSP-03）
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

// 概要・グラフの coverage を、いまの窓落ち件数と裏読みの状態で描き直す。
// withLocalEventDrop が再適用されるのは workModel / semanticModel 受信時だけなので、
// idle 中に最後まで遡ると次のターンまで「詳細は前方切り詰め」と嘘をつき続ける（契約 C12）
function refreshLocalDropViews(tabId: string): void {
  const overview = overviews.get(tabId);
  if (overview === undefined) return;
  const model = lastWorkModels.get(tabId);
  if (model !== undefined) overview.update(displayWorkModel(tabId, model));
  const semantic = lastSemanticModels.get(tabId);
  if (semantic !== undefined) overview.updateSemantic(displaySemanticModel(tabId, semantic.model), semantic.view);
}

// prepend したぶん「省略しました」の件数を減らす。減らさないと全件出した後も概要が
// 「詳細は前方切り詰め」と嘘をつき続ける
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

// 応答の受理判定。generation は破棄条件に使わない（CLI 再起動で世代だけ進んでも登録は
// 生きているため、使うと正当な応答を捨てる — protocol.ts の historyChunkResult 注記）
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
  // 成功した要求が再試行の予算を食い潰さないように戻す
  pager.retried = false;
  const usedCursor = pager.cursor;
  // 見えていない面へも描く（概要サブタブ・会話面の間も読み進める）。
  // 見えていないパネルでは scrollHeight が動かず視界維持の計算が成立しないので、
  // 描画は行い補正だけを落とす（契約 C8 / R-TAB-07）
  const correct = mayCorrectScroll(tabId);
  let result;
  try {
    // 高さ測定 → 挿入 → 再測定 → 補正を同一同期ブロックで行う。間に await / rAF を挟むと
    // ユーザーに1フレームぶんの跳ねが見える
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
    // ここで抜けると status が inflight のまま、タイマーは受理時に消えているので
    // 時間切れで降りる経路も無く、進行表示が永久に「読み込み中」で固着する
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
    // 描けなかった件数は実行ログの先頭に残す。診断だけだと進行表示が消えて「全部出た」に読まれる（E-36）
    pager.renderFailedTotal = (pager.renderFailedTotal ?? 0) + result.failed;
    const text = worklogRenderFailureNote(pager.renderFailedTotal);
    if (pager.renderFailNoteEl === undefined || !pager.renderFailNoteEl.isConnected) {
      pager.renderFailNoteEl = t.addHistoryNotice(text);
    } else {
      pager.renderFailNoteEl.textContent = text;
    }
  }
  reduceLocalEventDrops(tabId, result.rendered + result.skipped);
  // 突合（契約 C4b）。破れたら行がどこかで消えているので黙って進めない。
  // 2本目（connected）は未接続コンテナへ appendChild しても例外が出ないことへの対策で、
  // これが無いと gap / duplicate / scroll のどの検査も素通りする
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
  // anchor は「描画済みの連続した並びの最古」を指し続ける。
  pager.anchor = resolveContiguousHistoryAnchor(pager.anchor, page.items);
  if (page.hasMore && page.nextCursor !== undefined) {
    const chase = worklogBackfillContinues(tabId, pager, usedCursor, page, page.items.length);
    pager.cursor = page.nextCursor;
    pager.status = "idle";
    showWorklogBackfillProgress(tabId, pager, page.coverage.remainingOlderCount);
    // 次の1本は応答を受け取ってから出す。並列 fetch にはしない。
    // 続けられないのに残件がある＝停止条件が立った状態。読み終わっていないので消さない（R-TAB-08）
    if (chase) {
      requestHistoryChunk(tabId);
      return;
    }
    // idle のまま置くとアクティブ化やスクロールの再開路が勝手に走らせる。再開は「再開」だけ
    pager.status = "error";
    failWorklogBackfill(tabId, "stalled");
    return;
  }
  const host = hostCoverage(tabId);
  // 遡る先はこの画面を組んだ時点の切り詰めだけ。現在値を使うと、遡っている間に live で増えた分
  // （画面には描き終えている）まで読みに行き、scope に無いので終端が矛盾して止まる（R-TAB-08）
  const hostDropped = coverageUnreachableBase(tabId);
  // transcript 位相へ入るのは hydration で JSONL を fold したタブ（resumeSessionId を持つ）だけ。
  // live で作ったタブは記録の fold と generation:seq の対応が無く、Host も history-unavailable で拒む。
  // 入れない場合は記録から読めなかった件数として残る（HP-R48-3）
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
  // 消す条件は exhausted ただ 1 つ。進捗や残件数からは消さない（R-TAB-08）
  finishWorklogBackfill(tabId);
  refreshLocalDropViews(tabId);
}

function onHistoryChunkError(tabId: string, requestId: string, reason: string): void {
  const pager = acceptHistoryResponse(tabId, requestId);
  if (pager === undefined) return;
  const t = tabs.get(tabId);
  // 一過性の3種だけ、描画済み最古から anchor 方式で1回だけやり直す（契約 C11）。
  // stale-request は CLI 再起動の世代更新で出るので、止めると行き止まりに見える
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
  // 初回応答が 0 件の終端なら、Host が持つ記録の fold に anchor より古いものが無い。
  // Host の切り詰め分（backfillTotal > 0）を読みに来ているので矛盾で、終端扱いにすると
  // 何も積まないまま「詳細: すべて表示」になる
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
  // anchor は「描画済みの連続した並びの最古」を指し続ける。
  pager.anchor = resolveContiguousHistoryAnchor(pager.anchor, page.items);
  // 記録側の残件は Host の申告をそのまま持つ。終端まで来なかったときはこの値が欠落の件数になる
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
  // 非アクティブなタブは要求を出さず idle のまま置き、アクティブ化（resumeWorklogBackfill）で継ぐ。
  // 同時に走る連鎖をアクティブタブの 1 本に抑える（運用規則 HP-C25。守る要件 ID は無い）
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

// 窓が非連続なら（単一巨大ターン分岐）、窓の先頭ではなく2件目を anchor にする。
// 先頭を anchor にすると Host は hasMore:false を返し、窓外の区間が silent に落ちる（契約 C10）
function initialHistoryAnchor(
  windowed: { events: NormalizedEvent[]; backfilledHead: boolean }
): { generation: number; seq: number } | undefined {
  const at = windowed.backfilledHead ? 1 : 0;
  const ev = windowed.events[at];
  if (ev === undefined) return undefined;
  return { generation: ev.generation, seq: ev.seq };
}

// 描画済みイベントの連続した並びの最古を anchor として解決する。
// 単一巨大ターンで先頭に戻された turn_started（飛び地）で anchor を上書きすると、
// 後続の transcript 要求や再 anchor 時に Host が hasMore:false を返し、
// 窓外の区間が silent に落ちる（契約 C10 / R-TAB-07）。
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
    // docAge は performance.now()＝この document の生存時間。Host のログ行と突き合わせると
    // 「1つの document が再送した」のか「別 document が新たに立った」のかが分かれる。
    // 現在時刻（Date.now）は使わない — 表示側へ現在時刻を持ち込まない固定（TB-7）
    reportWebviewDiagnostic(
      "ready-retry",
      `init not received; retry ${readyRetries}; docAge=${Math.round(performance.now())}ms; sinceReady=${Math.round(performance.now() - readySentAt)}ms`
    );
    sendReady();
  }, INIT_RETRY_DELAY_MS);
}

// 復帰の init が先頭側を落として運んだぶんを、この画面の同期再生上限で落ちたぶんと
// 同じ「窓落ち」として数える。落とした先頭側は Host の履歴窓に残っているので、遡りの起点も
// 省略件数の表示も coverage の申告もこの合流後の値で決まる。合流しないと droppedCount が 0 に
// 見えて「遡る先が無い」と誤判定し、復帰のたびに古い区間が通知も出ずに消える
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
  // 診断パネルは Webview に1つだが、明示off を運ぶ経路は snapshot しかない
  // （設定変更で Host が init を送り直す）。再生で投げる前に処置する
  applyLlmDiagnosticsMode(snap.state.llmDiagnostics);
  // タブは作り直される（/clear の tabCleared・復帰の tabRestored）。前の中身で作った状態を
  // 持ち越すと、新しいセッションの被覆をひとつ前のセッションの数字で判定する（R-DSP-01）
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

  // plain / failed / complete の 3 経路が共有する再生手順。経路ごとに複製すると
  // 片方だけ手順が欠けても検査の変異注入が一意に的を取れなくなる
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
    // 再生より先に Task の現在状態を入れる。再生窓から Task更新イベントが落ちていると
    // TODO行が作られず、窓内にあるTask配下のツール行まで未接続DOMへ入って画面から消える
    t.applyWorkModel(model);
    const events = windowed.events;
    for (const ev of events) t.handleEvent(ev);
    t.replaceBackgroundActivity(snap.state.backgroundActivity);
    // Historical init events precede later model/effort changes; the snapshot owns current state.
    t.auth = snap.state.auth;
    // 再生で開いたままの assistant コンテナを閉じる（末尾が streaming 表示で残らないように）
    t.finalizeReplay(snap.state.turnState !== "idle");
    // 再生した範囲を同一性レジストリへ入れ、履歴挿入点をここで置く。
    // overview 4要素はこの後に workEl 先頭へ入るので、必ずこれより上になる（契約 C7）
    t.noteRenderedEvents(events);
    t.installHistoryHead();
    return { windowed, droppedNoticeEl };
  };

  // 遡り要求が届く先（history-window の scope）は registerHistoryWindow へ渡した
  // Session.events そのもので、snapshot の events と同一。よって「窓に残らなかった＝遡って
  // 初めて出てくる」で、この差分だけを見れば遡る先の有無を判定できる
  const installPagers = (windowed: ReturnType<typeof windowEvents>, droppedNoticeEl: HTMLElement | undefined): void => {
    // 窓落ちはタブの種別（resume / headOmitted / このセッションで作った）を見ずに裏読みで埋める。
    // 種別で分けると、このセッションで作ったタブが再読み込みで窓に落ちたとき「N 件は実行ログに
    // 出していません」が消えなくなる（R-TAB-07 / R-TAB-08）
    installHistoryPager(snap.tabId, windowed, droppedNoticeEl);
    const keptKeys = new Set(windowed.events.map((e) => `${e.generation}:${e.seq}`));
    // 復帰で Host が落とした先頭側は snap.state.events に入っていないので、この面では
    // 判定できない。Host が同じ白リスト（conv-renderable.ts）で数えた結果を合流させる
    const hasDroppedConvEvent =
      snap.state.headOmitted?.hasConvEvent === true ||
      snap.state.events.some(
        (e) => !keptKeys.has(`${e.generation}:${e.seq}`) && isConvRenderableEvent(e)
      );
    installConvPager(t, snap.tabId, windowed, hasDroppedConvEvent);
  };

  if (hydration === undefined) {
    // resumeHydration が無い snapshot は coordinator を破棄して通常経路で再生する
    resumeCoordinators.delete(snap.tabId);
    const { windowed, droppedNoticeEl } = replaySnapshot();
    installPagers(windowed, droppedNoticeEl);
  } else if (hydration.phase === "loading") {
    // loading snapshot
    const coord = getOrCreateCoordinator(snap.tabId, "loading");
    coord.workPager = "not-installed";
    coord.convPager = "not-installed";
    coord.convTouched = false;
    // 両 pager を drop して install を抑止（FP-3 / HW-22 / CH-C1 / CH-C7）
    dropHistoryPager(snap.tabId);
    dropConvPager(snap.tabId);
    // preview を表示専用 DOM として描画（[data-msg-uuid] を持たせない）
    t.renderResumePreview(hydration.previewMessages ?? []);
    // 両インジケータを preparing に設定（FP-4 / R-TAB-08 / R-CNV-02）
    t.setConvLoadProgress({ phase: "preparing" });
    t.setWorkLoadProgress({ phase: "preparing" });
    localEventDrops.set(snap.tabId, 0);
    if (snap.state.workModel !== undefined) lastWorkModels.set(snap.tabId, snap.state.workModel);
    model = snap.state.workModel;
    t.applyWorkModel(model);
    t.installHistoryHead();
  } else if (hydration.phase === "failed") {
    // failed snapshot (FP-5)
    const coord = getOrCreateCoordinator(snap.tabId, "failed");
    coord.workPager = "failed";
    coord.convPager = "failed";
    dropHistoryPager(snap.tabId);
    dropConvPager(snap.tabId);
    t.renderResumePreview(hydration.previewMessages ?? []);
    // commit 済み live events は failed でも再生する（reload で送信済み発言を失わない）。
    // pager は drop したままにする
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
    // complete snapshot
    const coord = getOrCreateCoordinator(snap.tabId, "complete");
    const { windowed, droppedNoticeEl } = replaySnapshot();
    installPagers(windowed, droppedNoticeEl);
    // tabCleared は Tab を作り直すため Phase 1 の進行表示は DOM ごと消えている。裏読みの最初の
    // 応答を待って出し直すと表示が途切れて点滅する。遡る対象が残っている面は応答を待たず出し直す
    // （FP-4 / R-TAB-08 / R-CNV-02）
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
  // analysis メッセージの行き先解決（analysisTargetTab）に使う
  if (snap.state.resumeSessionId) t.resumeSessionId = snap.state.resumeSessionId;
  // イベント再生が turnState を上書きするため、snapshot の状態を最後に再適用
  // （レビューP2-5: interrupting が running に退行して二度目の中断が効かなくなる）
  t.setTurnState(snap.state.turnState);
  // 表示モードを復元する（Webview再読み込みでも会話/作業ログの選択を維持する）。
  // persist=false: 復元途中の setState は下書き・他タブの設定を壊す（レビューAR5-C1/C2）
  const savedView = vscode.getState()?.views?.[snap.tabId];
  if (savedView === "work") t.setViewMode("work", false, false);
  // 再生中は viewMode が "conv" のため注意表示が付かない。復元後に貼り直す（AR6-M1）
  t.syncConvAttention();
  // 旧 DOM 参照は作り直しでも消す。位置を初期値（会話は最新 — レビューAR5-M1）へ戻すのは
  // 持ち越す位置が無いときだけ。持ち越す位置は applyScrollCarry が入れ、活性化の restoreScroll が最後に当てる
  // （上の setViewMode が途中で #logs を動かしても最終位置にはならない）
  t.resetReplayArtifacts();
  if (scrollCarry === undefined) t.resetScrollPosition();
  // 概要の 4 要素は再生と installHistoryHead の後に workEl 先頭へ入れる。先に入れると
  // 履歴挿入点が概要より上に置かれ、取り寄せた過去 chunk が概要の上に積まれる（契約 C7）
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
  overview.setYou(t.summaryYou.element);
  overview.setPlanUsage(snap.state.planUsage);
  overview.mount();
  overview.update(displayWorkModel(snap.tabId, snap.state.workModel));
  // semanticView=false（明示off）もそのまま渡す（3値契約。「未着」と同一視しない — 裁定A3）
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
  // 復帰の init が中身抜きで運んだタブ。空の log を「何も無い」と見せないため、
  // 両面へ裏読み中のインジケーターを出す（R-CNV-02 / R-TAB-08）。
  // tabRestored で作り直されると deferred が無い snapshot になるので自然に消える
  if (snap.deferred) {
    // hydration の loading 側と同じ形をバンドルへ出さない（verify-history-prepend HPmut-29 /
    // verify-conversation-history CHmut-C1c の変異の的が 2 件になり、向こうの検査が空振りする）
    const preparing = { phase: "preparing" } as const;
    t.setConvLoadProgress(preparing);
    t.setWorkLoadProgress(preparing);
  }
  return t;
}

// 同じ tabId のまま Tab インスタンスを作り直す（描画状態を確実に初期化）。
// addTab は末尾に append するため、旧タブの位置に挿し直して並び順を保つ
// preserveScroll は中身が同じ会話のまま増える作り直し（tabRestored）だけ。tabCleared / tabCreated は別の中身なので末尾から
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
  // 保存済みの位置は前の中身の行を指す。非表示で document が作り直される前に書き換える
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

// setActiveTab 自体が投げても空白画面で終わらせない。壊れたタブは候補から外して次を試す
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
    // Host からのメッセージも runtime 検証する。isWebviewToHost 側は extension.ts の handleWebviewMessage が
    // 拒否時に output へ [drop] ログを出すので、ここも同じ扱いにする（無言で捨てない。レビューR2-10）。
    if (!isHostToWebview(raw)) {
      console.warn("[drop] invalid host message", (raw as { type?: unknown })?.type);
      return;
    }
    const msg = raw;
    switch (msg.type) {
      case "init": {
        const initAt = performance.now();
        // destroy の後では DOM が外れて行も scrollTop も測れない
        const scrollCarries = new Map([...tabs].map(([tabId, t]) => [tabId, t.captureScrollCarry()]));
        for (const t of tabs.values()) t.destroy();
        tabs.clear();
        overviews.clear();
        // cursor・描画済み同一性・退避中の finish はタブの DOM と同じ寿命。
        // 残すと作り直したタブへ旧世代の応答と終端が当たる（契約 C9）
        for (const tabId of [...historyPagers.keys()]) dropHistoryPager(tabId);
        for (const tabId of [...convPagers.keys()]) dropConvPager(tabId);
        lastWorkModels.clear();
        lastSemanticModels.clear();
        localEventDrops.clear();
        hostDroppedAtInstall.clear();
        initReceived = true;
        if (initRetryTimer) clearTimeout(initRetryTimer);
        // 版が食い違う Host からのイベントには配置情報が無く、詳細ログが黙って空になる。
        // 落とすより「なぜ出ないか」を出す（再読み込みで直る種類の食い違いのため継続はする）
        const versionMismatch = msg.protocolVersion !== PROTOCOL_VERSION;
        // タブを描く前に入れる。後から入れると描画済みの本文が Windows 前提の拒否のまま残る（R-CNV-12）
        setFileLinkHostPlatform(msg.hostWindows ?? true);
        setFileLinkSystemAppExtensions(msg.systemAppExtensions);
        for (const snap of msg.tabs) {
          try {
            addTab(snap, scrollCarries.get(snap.tabId) ?? savedScrollCarry(snap.tabId));
          } catch (error) {
            reportWebviewDiagnostic("error", `init tab failed: ${String(error)}`);
            // addTab は再生より先に tabs.set するので、外さないと壊れたタブが
            // activate 候補として残り、正常タブの代わりに選ばれる
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
        // 再接続時、アクティブタブの下書きを復元してから activate する（codexレビューC2-7:
        // setActiveTab は同一タブへの切替では textarea を書き換えないため、ここで直接復元する）
        if (chosen) {
          inputEl.value = drafts.get(chosen) ?? "";
          autosizeComposer();
          activateFirstUsableTab(chosen);
        }
        activeTabAfterInit = activeTabId;
        // 復帰が軽くなったかを実機の切替で読むための実測。時刻は document age だけを使う（TB-7）。
        // 数えるのは「init 受信から活性タブが画面に載るまで」で、Host 側の
        // `init posted (cause=restore …)` と対で見ると搬送と再生のどちらが重いかが分かれる
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
        // tab.ts が workEl へ追加した行に表示切替を反映する（概要表示中に新着だけが見えないように）
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
        // FP-1: Phase 1 の追送 preview。tabCreated/tabCleared 時点では空なので、
        // ここで描き直さないと tail の内容が Phase 2 完了まで出ない。
        // renderResumePreview は末尾へ足すだけなので、描画から追送までの間に live の表示が
        // 入っていたら過去の会話がそれより後ろに並ぶ。その場合は描かず Phase 3 の確定
        // snapshot（全量を正しい順で載せ直す）へ委ねる
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
        // 詳細ログ側は Task の現在状態だけを取り込む（イベントの取りこぼしからの復帰経路）
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
        // Host は semanticView=on のときだけこのメッセージを送る（extension.ts の設定ガード）
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
        // 明示off を最後に観測している間に届いた payload は描かない。描くと設定 off の
        // 保証が「消える」から「次の payload まで消えている」へ落ちる。
        // undefined（未着）の間は描く
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
        // 同じ chunk 形を作業ログ側と会話側（原因A）の両方が使う。requestId で振り分ける
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
        // Host は resume のタブを tabCreated より前に sessions へ載せるので、その間に送った init が
        // 同じ tabId を先に運ぶ。重ねて addTab すると tabs が新しい方だけを指し、閉じても古い DOM が残る
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
              // 開いたままの再構築。openだとカーソルとフォーカスが飛ぶ（AR: 再構築を跨いだ保持）
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
          if (t.auth) t.auth = { ...t.auth, effort: undefined };
          if (activeTabId === msg.tabId) {
            renderAuth(t);
            if (!authPickerEl.classList.contains("hidden")) {
              // 開いたままの再構築。openだとカーソルとフォーカスが飛ぶ（AR: 再構築を跨いだ保持）
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
              // 開いたままの再構築。openだとカーソルとフォーカスが飛ぶ（AR: 再構築を跨いだ保持）
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
        // 全量の置き換え。差分を当てる形にすると、送信で空になった応答と
        // 追加の応答が入れ違ったときに消えたはずのサムネイルが戻る
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
        if (msg.kind === "script") finishAnalysisRequest();
        showAnalysisFailure(msg);
        break;
      }
      case "analysis": {
        finishAnalysisRequest();
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
        // ライブの rate_limit が来るまでの繋ぎ。ライブ値が既にある枠は上書きしない
        cachedUsageFetchedAt = msg.fetchedAtMs;
        for (const l of msg.limits) {
          if (rateLimits.has(l.type)) continue;
          // ~/.claude.json の値は既に 0-100。rateLimits の単位に合わせるので変換しない。
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
      // 復帰の init が deferred で積んだタブの中身。tabCleared と同じ作り直し手順で、
      // preparing のインジケーターは deferred の無い snapshot に置き換わることで消える
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
          // 閉じたタブがアクティブのままだと、persistState 冒頭の
          // drafts.set(activeTabId, inputEl.value) が直前の delete を打ち消して
          // ゾンビの下書きを永続化する（レビューAR6-L1）。先に参照を切る。
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

// 添付の実体は Host が tabId ごとに持つ（R-CNV-11）。ここにあるのは描画用の写しで、
// 正本ではない。この Map から送信の積荷を作らないこと——iframe の破棄で消えるうえ、
// 送信時の activeTabId を信用する形へ戻ると添付が別の会話へ入る
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
      // 折り返しは実寸の幅が決まるまで起きない。読み込み完了の時点ではまだ折り返し後の
      // レイアウトが読めないので、次のタスクまで待ってから測る
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

// File → base64 抽出して Host へ預ける共通経路（貼り付け／＋ボタン添付で共用）
function addImageFile(file: File, mediaType: string): void {
  if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) return;
  // 読み取りは非同期。宛先は「読み終わった時点の activeTabId」ではなく「添付した時点のタブ」。
  // onload で引き直すと、読んでいる間にタブが動いたぶんが別の会話の添付欄へ入る
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

// ファイル選択ダイアログの応答の連番。古い応答で入力欄と添付欄を書き換えないための照合用。
// reqId と tabId は必ず同時に更新する。片方だけ残すと、受理される応答（最新 reqId）の宛先が
// 別の要求のタブになり、添付が別の会話へ入る（R-CNV-11）
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

// ダイアログで選ばれたものの行き先。画像は添付、それ以外はパスとして入力欄へ入る
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
      // 楽観的に interrupting へ（codexレビューC1-3: ホストは interrupting 遷移をイベントで通知しない）
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
    // 既に最下部なら scroll イベントが出ず、張り付き復帰が購読側へ届かない
    if (activeTabId) syncWorklogBackfillScroll(activeTabId);
  };

  attachBtn.onclick = () => openFilePicker();

  // 入力量に応じて高さを自動調整（1〜8行）+ 下書きの永続化（codexレビューC1-7）
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

// ---------- グローバルショートカット ----------
// Webviewにフォーカスがある間はVS Code本体より先にここで受けられる。
// - Ctrl+W（mac: Cmd+W）: アクティブなタブを閉じる
// - Ctrl+T（mac: Cmd+T）: 新しい会話タブ
// - Ctrl+Tab / Ctrl+Shift+Tab: 会話タブの巡回切替

function cycleTab(direction: 1 | -1): void {
  const ids = [...tabs.keys()];
  if (ids.length < 2) return;
  const idx = activeTabId ? ids.indexOf(activeTabId) : -1;
  // current不明時は方向に応じて先頭/末尾へ（レビューAR-L4: -1のままだと-1方向で非対称になる）
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
      // 開くときの先入れ検索が一致箇所へスクロールする
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

// 矢印キーでのタブ切替（レビューP2-6: tablist セマンティクス）
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

// ---------- エディタコンテキストチップ ----------

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

// 実測で応答0文字だった端末TUI系コマンド（/doctor は応答があるため対象外）。
// コマンドごとに代替手段が異なるため文言を分けて持つ。
// 実測（probe-commands）で応答0文字＝無反応だったコマンド。素通しすると打っても
// 何も起きないので、理由と代替手段を会話へ出す。
// 文言はテンプレート1本＋例外だけ個別にする（5箇所へ同文を複製すると、直すとき片方だけ
// 直る事故が起きる）。
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
  // 実行中の Enter は steering（実行中ターンへの追加入力として即時投入。新ターンにはしない）
  const running = activeTab()?.turnState !== "idle";
  // M-3: 中断中は投入しない（中断で終端しようとしているターンへ入力を混ぜない）。
  // 入力欄のテキストは消さずユーザーが再送できるようにする。
  if (activeTab()?.turnState === "interrupting") {
    activeTab()?.addBlock("system warn", l10n.t("Cannot send while interrupting."));
    return;
  }
  const text = inputEl.value.trim();
  if (text === "/clear") {
    // /clear はモデルへ送らずローカル処理（CLI組み込みコマンド相当。ホストがセッションを作り直す）
    // 実行中はローカルで先に拒否し、入力欄は消さない（レビューAR-L3）
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
  // /color は VS Code の配色テーマ選択を開く。素通しすると CLI 側のセッション色
  // （~/.claude.json の color。複数セッションの見分け用）が変わるだけで、拡張の見た目には
  // 何も起きない。VS Code 拡張なのだから配色は VS Code のテーマ選択へ繋ぐ。
  if (text === "/color" || text === "/theme") {
    clearComposerInput();
    persistState();
    vscode.postMessage({ type: "openThemePicker" });
    return;
  }
  // /resume は LAISORA の履歴パネルを開く。素通しすると CLI 側が端末用の対話ピッカーを
  // 出そうとして何も起きないため（LAISORA では 🕘 の履歴一覧が同じ役割を担う）。
  if (text === "/resume" || text === "/history") {
    clearComposerInput();
    persistState();
    queueMicrotask(openHistPanel); // ▶クリックの気泡で即閉じされるのを避ける（M-1と同じ理由）
    return;
  }
  // /effort もローカル処理する。素通しすると CLI が「このセッションのみ」で適用してしまい、
  // LAISORA 側の状態・チップ・settings.json のいずれも更新されず食い違う。
  if (text === "/effort" || text.startsWith("/effort ")) {
    clearComposerInput();
    persistState();
    const arg = text.slice("/effort".length).trim();
    const t = activeTab();
    if (!arg) {
      // 引数なしはピッカーを effort 欄で開く（/model と同じ操作感）
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
  // 以下は実測で応答0文字（端末TUIを開くタイプで LAISORA には出せない）だったコマンド。
  // 素通しすると何も起きたように見えないため、理由と代替手段を会話へ出す。
  // 引数付き（例 "/mcp list"）でも拾う。完全一致だと素通しして無反応に戻る
  const unsupportedTerminalCommand = UNSUPPORTED_TERMINAL_COMMANDS.get(text.split(/\s+/)[0]);
  if (unsupportedTerminalCommand !== undefined) {
    // 出力先が無いまま入力だけ消さない（タブ全閉・snapshot未着でも起こりうる）
    const t = activeTab();
    if (!t) return;
    clearComposerInput();
    persistState();
    t.addBlock("system warn", unsupportedTerminalCommand);
    return;
  }
  if ((!text && attachmentsOf(activeTabId).length === 0) || !activeTabId) return;
  // ローカル描画はしない。host が user_message イベントとしてログに記録し再送してくる
  // （snapshot 復元でユーザー発言が消えないように — レビューR1-5）
  clearComposerInput();
  persistState();
  // turn_started 往復までの間に2通目が受理されたように見えて消える穴を塞ぐ（codexレビューC1-6）。
  // 実行中の追加送信では state を触らない（既に running。楽観 running 上書きで interrupting が消える）
  const t = activeTab();
  if (t && !running) {
    t.pendingSend = true;
    t.setTurnState("running");
  } else if (t && running) {
    // user_message バブル自体は extension が送信受理時に記録・再送する（二重表示させない）。
    // ここでは「新ターンではなく実行中のターンへ追加した」ことだけを軽く注記する（steering仕様）
    t.addBlock("system", l10n.t("Added to the running turn"));
  }
  // 楽観バブルの表示にだけ使う写し。積荷ではない（Host が自分のスロットから取り出す）。
  // 添付欄の消去も Host の attachments 応答で行う——ここで消すと、Host が拒否した送信で
  // 添付だけが失われる
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

// 稼働中ステータスストリップの経過時間を1秒ごとに更新する。タブ毎にsetIntervalを持たせると
// タブ閉鎖時にクリア漏れでリークしうるため、グローバル単一タイマーがアクティブタブのみを
// 都度参照する方式にしている（要件4: 閉鎖済みタブはtabsから除去済みなので自然に対象外になる）。
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

// ---------- 起動 ----------
// トップレベル副作用の登録順を決める唯一の権威。**並べ替え禁止**。
// 登録順を import 文の並びへ依存させると、
// IDEの import 自動整列や eslint import/order が並べ替えた瞬間に typecheck も build も verify も
// 通ったまま振る舞いが変わる。そこで副作用を init へ包み、順序の決定をこの配列に集約している。
//
// dom.ts の app.innerHTML はここに含めない。値 import された時点で必ず走るので、
// 「呼び忘れたら dom.ts の要素取得が全て null」という失敗モードを作らずに済む。

// 例外通報は初期化より先に登録する。後ろに置くと初期化中の例外で通報も sendReady() も失われ、
// ホストからは「ready が来ない」以外に何も観測できなくなる。
window.addEventListener("error", (event) => {
  reportWebviewDiagnostic("error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportWebviewDiagnostic("error", event.reason);
});
// 1つが投げても残りの初期化と sendReady() まで到達させる
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
// ホストに状態送出を開始させるトリガ。initMessageBus() より後でないと初回メッセージを取りこぼす。
sendReady();
// ready の postMessage まで到達した時点で、bundle 前に置いた bootstrap watchdog を止める。
window.__laisoraBootstrap?.complete();
