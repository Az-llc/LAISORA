import { createLoader } from "./loader";
import { createSessionHeader } from "./session-header";
import { PlanPanel } from "./plan-panel";
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
import { clock, formatDuration, formatTokenCount, monthDayClock, toolSummary, uiLocale } from "./format";
import { createCopyButton, renderMarkdownInto } from "./markdown";
import { askHeading, askOptionContent, updateAskCounters } from "./ask-view";
import { createYouItems, youAnchor, type YouItemsReader } from "./you-items";
import { findCommitBoundary, joinRecordTexts, recordSeparator } from "./commit-boundary";
import { isPureCommandWrapper } from "../human-input-vocabulary";
import { isConvRenderableEvent } from "../conv-renderable";
import {
  applyActivityEvent,
  backgroundActivityFromSnapshot,
  createBackgroundActivityState,
  hasRunningDelegation,
  liveBackgroundTasks,
  notePastLifecycle,
  type BackgroundActivitySnapshot,
  type BackgroundActivityState,
} from "../background-activity";
import type { HandoffFailReason } from "../handoff-runner";
import type { WorkViewMode } from "./work-overview";
import type { GraphScrollPort } from "./work-graph";
import { refreshFind, refreshFindCount } from "./find-bar";
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

type HandoffStatusMessage = Extract<HostToWebview, { type: "handoffStatus" }>;
type HandoffDetailMessage = Extract<HostToWebview, { type: "handoffDetail" }>;

// 折り畳みは既定で閉じ、本文は空で作る（開くまで取りに行かない）。
// 本文は textContent で入れる（Markdown 解釈も HTML 挿入もしない）
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

// 転記した決定行の件数・警報（R-HND-11 / R-HND-12）。live は handoffStatus が、復元は
// handoffDetail の part 0 が同じ数を運ぶので、描き手は 1 つにして経路で文面が割れないようにする
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
  // DOM へ入れる前に復号を終わらせる。未復号のまま差し替えると差し替え時と復号完了時で
  // レイアウトが 2 回動き、2 回目は補正の外に出る。width / height 属性で寸法を与える手は使えない
  // （.block.user .user-image は max-width / max-height しか持たないので、両軸が独立に
  //   切り詰められて縦横比が壊れる）
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

// 失敗表示は次の操作まで残す（数分の compact の後に出た失敗は見逃されやすい。M-16 の「読み終わったら消す」は
// 進行表示の規則で、失敗理由は読む前に消えてはいけない）
const HANDOFF_FAILURE_VISIBLE_MS = 120_000;
const HANDOFF_RUN_MEMORY = 1_000;
const HANDOFF_DETAIL_UNAVAILABLE = l10n.t("Could not read the details");

// 失敗文面。理由コードをそのまま画面へ出さない
const HANDOFF_FAILURE_MESSAGES = {
  compact_rejected_analysis: l10n.t("The AI model refused to generate the summary, or the summary was incomplete"),
  compact_rejected_structure: l10n.t("The AI model refused to generate the summary, or the summary was incomplete"),
  compact_rejected_length: l10n.t("The AI model refused to generate the summary, or the summary was incomplete"),
  compact_timeout: l10n.t("The summary was not generated in time"),
  cancelled: l10n.t("Cancelled"),
  source_busy: l10n.t("Cannot hand off while a turn is running (wait for it to finish or interrupt it)"),
  already_running: l10n.t("A handoff is already running"),
  tab_failed: l10n.t("The handoff was created. You can open it from history"),
  // 文面は理由コードごとに 1 つで、原因を断定しない。compact_failed / hook_not_fired は
  // 生産者が複数あり（CLI の拒否・通信断・result 先行）、断定すると誤った操作へ誘導する。
  // 具体的な理由は detail 行が運ぶ。
  // 「元の会話は変更されていません」は setHandoffStatus が後置するのでここに書かない。
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

// 段階ごとの進行文言。compacting は心拍が届くまで「要約しています」と言わない（R-DSP-01。
// CLI は /compact の応答を要約開始前に返すことがあり、心拍だけが進行の観測点）
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

// 装飾の行（R-67）。事実の行と分け、compacting の心拍が届いている間だけ出す。
// 進行が HANDOFF_QUIET_MS 途絶えたら真顔の 1 本へ替える。Host の 120 秒アイドル猶予とは
// 別物で、protocol には載せない（webview のローカルタイマーだけで閉じる）
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
  // Compact summaries use Markdown headings or numbered section headings.
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

// 詳細カード1枚分。集計は持たない。数値は WorkModel（イベントに載る WorkEventInfo）から来る。
// カードの同定は reducer が開始時に固定した segmentId で行う。「その時点のカレント」で同定すると、
// カードが切り替わったあとに前カードのツールが終了したとき集計が次のカードへ混入し、
// 実行中のツールが残っているのにスピナーが止まる（敵対レビュー R1-F2）。
interface SegmentCard {
  segmentId: string;
  el: HTMLDetailsElement;
  summaryEl: HTMLElement;
  // 直近に置いたツールの表示名。集計ではなく最後の1件の見出し
  lastLabel: string;
}

interface AgentCardEntry {
  card: HTMLDetailsElement;
  statusEl: HTMLElement;
  metaEl: HTMLElement;
  // モデル・effort等のチップ置き場。モデルは起動時は宣言値（frontmatter/入力）しか無く、
  // 実測値が subagent_info で後着するため、チップは kind 単位で差し替えられる形にしている
  chipsEl: HTMLElement;
  childrenEl: HTMLElement;
}

// 行1件の中身。行の材料をイベント由来の値として保持する。
// 集計（件数・失敗数・時間・状態語）はここに入れない。それらは WorkModel 側の値を使う
interface WorkRowData {
  toolUseId: string;
  kind: "tool" | "agent";
  toolName: string;
  summaryText: string;
  inputPreview: string;
  status: "running" | "done" | "failed" | "stale";
  // 開始時刻（provider 時刻）。0 = 未観測で、そのときは時刻列を空にする
  startedAt: number;
  resultPreview?: string;
  elapsedLabel?: string;
  statusGlyph?: string;
  metaText?: string;
  chips?: { kind: string; text: string }[];
  // agent 配下に置いた行（順序を保つ）
  childIds?: string[];
}

// agent の状態語。値は WorkModel の status をそのまま写す（DOMのクラスから逆算しない）
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

// サブエージェントカードのチップ。同 kind があれば置き換える（subagent_info の実測モデルが
// 宣言値チップを上書きする経路）。表示順は AGENT_CHIP_ORDER で固定する
// （model は後着するため、到着順に並べると起動ごとに並びが変わる）。
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

// モデルIDのチップ表示。"claude-" 接頭辞は全モデル共通で情報量が無いため落とす
function shortModelLabel(model: string): string {
  return model.replace(/^claude-/, "");
}

// 進行中は activeForm（「〜を実行中」）で出す。両方 WorkModel が持つ値で、選ぶだけ
function taskLabel(item: WorkTaskItemView): string {
  return item.status === "in_progress" && item.activeForm ? item.activeForm : item.description;
}

// 表示に影響する全項目を見る。taskKey だけの比較にすると、状態やラベルだけが変わった更新で
// TODOカードが描き直されず、完了・進行中の表示が古いまま残る
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

// 過去 chunk 再生中の挿入位置を持ち回す。anchor は容器ごとに「その容器へ最初に入れた時点の
// firstChild」で、固定した anchor の直前へ入れ続けることで chunk 内の順序を保ったまま
// live の内容より上に積む（毎回 firstChild を取り直すと chunk 内が逆順になる — 契約 C1）。
// createdNow はこの再生で作った容器で、空から作るので append でよい。
// live 再生で既に作られていた segment カードへ入れる場合は anchor 機構のほうを通る
// （anchor が summary になりうるが、Chromium は最初の summary 子をスロットへ割り当てるので
// 表示順は逆転しない）
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

// prepend 1回ぶんの突合材料（契約 C4b）。2本の等式を呼び出し側が検査する:
//   rendered + skipped + duplicates + failed == total   … 取りこぼしたイベントが無い
//   connected == expectedConnected             … 作った行が接続済み DOM に居る
// 後者が要るのは、未接続コンテナへ appendChild しても例外が出ないため。
// created（新しく行要素を作った件数）と rendered（何らかの効果があった件数）は別物で、
// subagent_info / approval_resolved は既存要素を書き換えるだけなので created に入らない
export interface PastPrependResult {
  total: number;
  rendered: number;
  skipped: number;
  duplicates: number;
  // 描画中に例外が出た件数。識別子を登録しないので取り直せば再挑戦できる
  failed: number;
  connected: number;
  expectedConnected: number;
  failures: string[];
}

type PastRenderOutcome = "created" | "applied" | "skipped";

// 会話の過去 chunk 1回ぶんの突合材料（契約 P7）
export interface ConvPrependResult {
  total: number;
  rendered: number;
  duplicates: number;
  failed: number;
  failures: string[];
  connected: number;
  expectedConnected: number;
}

// EventLog 由来（原因A）の chunk だけが持つ内訳。transcript 由来（原因B）には
// 白リストも turn 継続も無いので基底のままにする。
// duplicates へ畳むと「185件が重複だった」と誤読される（post-close audit 原因A M-5）
export interface ConvEventPrependResult extends ConvPrependResult {
  // 会話面の白リスト外（isConvRenderableEvent が false）
  skipped: number;
  // 既存の assistant ブロックへ本文を足しただけで、新しい行は作っていない件。
  // rendered へ入れてはならない（connected は data-conv-past の実数と突合する）
  continued: number;
}

// ---------- タブ ----------

// セッション内の表示モード。conv=会話（本文と判断）/ work=作業ログ（内部進行と監査）
export type ViewMode = "conv" | "work";

// 作り直しをまたぐ位置は行の同一性と表示位置で持つ。画素位置は、末尾送りから全件への作り直しで
// 上に中身が増えると別の行を指す。offset は #logs 上端から（ヘッダは帯の有無で高さが変わる）
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

// 開始行を持たない tool_call_finished の退避上限。窓境界を跨ぐツールは高々1ターンぶんなので
// これを超えるのは想定外の並び。溢れたぶんは退避しない（running 表示が残るが、無制限に
// 溜めて解放されないほうが害が大きい）
const ORPHAN_FINISH_MAX = 512;

// 裏読みの進行表示の状態。会話面・状況面で同じ形を使う
export type LoadProgressState =
  | { phase: "preparing" }
  | { phase: "loading"; remaining: number; ratio: number }
  | { phase: "failed"; reason: string; detail?: string; onRetry: () => void };

function clockLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(uiLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// assistant セグメントの中身を「確定領域 / 未確定の末尾」の 2 枠に作り直す（増分描画）。
// 新規作成と撤回後の描き直しで同じ形にする（片方だけ形が変わると増分描画の前提が崩れる）
function buildSegParts(seg: HTMLElement): { committed: HTMLElement; tail: HTMLElement } {
  seg.textContent = "";
  const committed = document.createElement("div");
  committed.className = "seg-committed";
  const tail = document.createElement("div");
  tail.className = "seg-tail";
  seg.append(committed, tail);
  return { committed, tail };
}

// 実行ログの状態列は色だけでなく文字を持つ（R-TAB-06）。stale は ⏸
const TOOL_STATUS_GLYPH: Record<WorkRowData["status"], string> = { running: "", done: "✓", failed: "✕", stale: "⏸" };
// 状況の 4 タブの張り付きの初期値。初回は先頭から。張り付きを初期値にすると、結果が縦に長い分析タブは初回に
// 末尾へ飛びボタンが画面から消える（R-ANL-11 / R-ANL-12）。実行ログだけは追記に追従するので張り付き
const WORK_VIEW_AT_BOTTOM_INITIAL: Record<WorkViewMode, boolean> = { summary: false, graph: false, analysis: false, log: true };

// タブのドットと同じ述語（isTabActive）の変化。概要の「実行中」はこちらを見る（R-SES-02 / R-DSP-20）
export let onTabActivity: ((tabId: string, active: boolean) => void) | undefined;
export function setOnTabActivity(fn: typeof onTabActivity): void {
  onTabActivity = fn;
}

// 会話面が表示になったことの通知口。main.ts が過去ログの裏読みを継ぐために使う。
// tab.ts から main.ts を import すると循環するので、setter で注入する
export let onConvViewShown: ((tabId: string) => void) | undefined;
export function setOnConvViewShown(fn: typeof onConvViewShown): void {
  onConvViewShown = fn;
}

export class Tab {
  private youStoreValue?: ReturnType<typeof createYouItems>;
  private get youStore(): ReturnType<typeof createYouItems> {
    return this.youStoreValue ??= createYouItems(this.tabId);
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
      choose: (value) => {
        setActiveTab(this.tabId);
        inputEl.value = value;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.focus();
        persistState();
      },
      checked: (id, step) => vscode.getState()?.askChecks?.[this.tabId]?.[id]?.[step] === true,
      check: (id, step, checked) => {
        const state = vscode.getState() ?? { activeTabId: null };
        const askChecks = { ...state.askChecks };
        const tabChecks = { ...askChecks[this.tabId] };
        const values = [...(tabChecks[id] ?? [])];
        values[step] = checked;
        tabChecks[id] = values;
        askChecks[this.tabId] = tabChecks;
        vscode.setState({ ...state, askChecks });
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
  // logEl はタブの表示領域全体（#logs の子）。中身は [headEl, convEl, workEl]。
  readonly logEl: HTMLElement;
  // 会話パネル: ユーザー/LLM本文・承認カード・判断に必要な通知だけを置く
  readonly convEl: HTMLElement;
  // 作業ログパネル: ツール・TODO・サブエージェント・リトライ・診断を置く
  readonly workEl: HTMLElement;
  // Sticky session heading, progress row and running-status strip in the content column.
  private headEl!: HTMLElement;
  private viewTabs = {} as Record<"chat" | WorkViewMode, HTMLButtonElement>;
  private viewNav!: HTMLElement;
  private viewNavObserver?: ResizeObserver;
  private turnRailResizeObserver?: ResizeObserver;
  private turnRailMutationObserver?: MutationObserver;
  private changingView = false;
  setWorkViewMode?: (mode: WorkViewMode) => void;
  // 過去ログの裏読みの進行表示（タイトル・日付の右側）。要素は会話面と状況面で 1 つを共有し、
  // 見ている面の状態だけを描く（クラス名は conv-load だが状況面もこの要素に描く）
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
  // 山から順に消費する。心拍ごとに独立抽選へ変えると同じ 1 本が続けて出る（W-HND-11 は
  // 2 回続けてしか見ないので、抽選へ退化しても大半の回は緑になる）
  private handoffPlayfulDeck: string[] = [];
  private handoffPlayfulLast: string | null = null;
  private handoffQuietTimer: ReturnType<typeof setTimeout> | null = null;
  // いま右端スロットに出している引き継ぎの runId。null = 所有者なし（終端を出した後も外す）
  private handoffRunId: string | null = null;
  private readonly handoffEndedRunIds = new Set<string>();
  private readonly handoffCardRunIds = new Set<string>();
  private restoredHandoffCard: HTMLElement | undefined;
  handoffSource?: NonNullable<ConversationSnapshot["handoffSource"]>;
  private readonly handoffCardEls = new Map<string, HTMLElement>();
  // 次に受け取るべき part。重複・逆順の応答を捨て、次の要求を二重に出さない
  private readonly handoffExpectedPart = new Map<string, number>();
  // part 0 を要求済みの実行 ID。取得に失敗した（total===0）ら外し、開き直しで再要求させる
  private readonly handoffDetailRequested = new Set<string>();
  private handoffClearTimer: ReturnType<typeof setTimeout> | null = null;
  // 会話面の遡り位置。null = 最新（張り付き）
  private convCursorEl: HTMLElement | null = null;
  // 表示モードはセッション（タブ）ごとに保持する
  viewMode: ViewMode = "conv";
  // パネルごとのスクロール位置。切替・タブ切替で不必要に失わないため退避する
  private scrollPos: Record<ViewMode, number> = { conv: 0, work: 0 };
  // 状況の 4 タブごとのスクロール位置と張り付き。実行ログ→分析→実行ログの往復で位置を失わない（R-TAB-06）
  private workViewScrollPos: Record<WorkViewMode, number> = { summary: 0, graph: 0, analysis: 0, log: 0 };
  private workViewAtBottom: Record<WorkViewMode, boolean> = { ...WORK_VIEW_AT_BOTTOM_INITIAL };
  // いま選ばれている状況のサブタブ。WorkOverview の既定（summary）と同じ値から始め、切替のたびに追随する
  private workView: WorkViewMode = "summary";
  get workViewMode(): WorkViewMode { return this.workView; }
  // 実行ログを離れたとき最上部に見えていた行。戻ったとき 1.4 秒光らせる
  private workViewReturnRow: HTMLElement | null = null;
  // 直前の人の発言（1 行目）。次のターン区切りの見出しに使う。live は user_message → turn_started の順で届く
  private lastHumanHeadline: string | null = null;
  // 見出しが未確定のターン区切り。history は turn_started → user_message の順なので後から埋める。
  // live の区切りだけを指す。裏読みで積む過去の区切りは別に持つ（下）。共有すると、後から届く live の
  // user_message（turnId 無し）が過去の区切りへ入り、以後の見出しが 1 つずつずれ続ける（R-TAB-09）
  private pendingHeadlineAnchor: HTMLElement | null = null;
  // 過去 chunk 側の見出しの受け渡し。chunk は新しい順に届き、chunk 内は時系列順なので、
  // 区切りと発言の並びは [turn_started | user_message]（history）と [user_message | turn_started]（live 由来）の
  // どちらも chunk 境界で割れうる。区切りは chunk をまたいで待ち（pastPendingAnchor）、turnId を持つ発言は
  // chunk をまたいで待つ（pastHeadline.chunk = null）。turnId の無い発言は直後に始まったターンにだけ付く:
  // 同じ chunk の次の区切りが引き取り、chunk 末尾に残ったものは直前に積んだ（新しい側の）chunk の先頭の区切りが
  // 見出し待ちなら引き取る（takePastChunkTail）。見出し待ちの区切りへ即座に入れると、発言なしで始まったターン
  // （自動投入による非人間発話）の区切りが次の発言を引き取り、以後の見出しが 1 つずつずれる（R-TAB-09）
  private pastPendingAnchor: HTMLElement | null = null;
  private pastPendingChunk = 0;
  private pastPendingFirst = false;
  private pastChunkTurnSeen = false;
  private pastHeadline: { text: string; turnId: string | null; chunk: number | null } | null = null;
  private pastChunkSerial = 0;
  // 同じコマンドの連続を 1 つの区切りに畳む
  private lastCommandRun: { text: string; anchor: HTMLElement; count: number } | null = null;
  // パネルごとの「最下部に張り付いているか」。初期は張り付き（＝新着に追従する）
  private atBottom: Record<ViewMode, boolean> = { conv: true, work: true };
  // グラフが窓（画面に収まる行数分）を開いている間、作業ログ追記の末尾追従と張り付き記録を止める。
  // 書き手は WorkGraph（GraphScrollPort.setHold）だけ
  private graphHold = false;
  // 作り直しで受け取った位置。restoreScroll が当てるまでは退避の答えもこれ（新しい DOM の scrollTop はまだ当てていない値）
  private unappliedCarry: ScrollCarry | undefined;
  // 活性化してから restoreScroll が位置を当てたか。当てる前の #logs.scrollTop は前のタブの値
  private scrollRestored = false;
  // 面ごとに、最初に表示したとき一度だけ当てる行
  private carryAnchor: Partial<Record<ViewMode, RowAnchor>> = {};
  private carryAwaitsConvBackfill = false;
  // 最後に測った（または当てた）面ごとの行。測るのはスクロールの遅延保存・面やタブを離れるとき・作り直しの退避と、
  // 位置が動いた後の最初の persistState だけ（入力欄の打鍵ごとに呼ばれるので、動いていなければ elementsFromPoint を回さない）
  private knownAnchor: Partial<Record<ViewMode, RowAnchor>> = {};
  // 表示中の面の行を最後に測ったときの #logs.scrollTop。今の scrollTop と違えば knownAnchor は古い位置の行で、
  // 新しい scrollPos と組にして書くと復元が別の行へ合う。scroll イベントや scrollPos では判定しない
  // （移動系は scroll イベントより先に scrollPos を書き、イベントは次のフレームまで届かない）
  private anchorMeasuredTop: number | undefined;
  // 末尾送りで窓に無い行を、会話の遡りが積むたびに探し直す。諦めるのは利用者の操作（main.ts abandonAwaitedScrollAnchor）・
  // pager の終端・タブ切替。scrollTop の変化では判定しない（画像差し替えなどの補正も scroll を起こす）
  private awaitedConvAnchor: RowAnchor | undefined;
  // 同一ターンのassistant本文をまとめるコンテナ。ツールを挟んでも別回答に見せない
  // （断片は連結せず、セグメント要素として連続配置する）
  private currentAssistantTurn: HTMLElement | null = null;
  readonly tabBtn: HTMLElement;
  labelEl!: HTMLElement;
  private sessionHeader!: ReturnType<typeof createSessionHeader>;
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

  // 引き継ぎの進行・失敗を右端スロットへ出す。done はスロットからは消すだけで、
  // 引き継ぎ先タブの状態カードが結果を担う。表示文面はこのファイルの表が正本で、
  // Host が送る message は読まない
  showHandoffStatus(msg: HandoffStatusMessage): void {
    // カードは引き継ぎ先タブで runId ごとに 1 回だけ。done の再送で複製しない
    if (msg.state === "done" && msg.fork?.tabId === this.tabId && !this.handoffCardRunIds.has(msg.runId)) {
      this.handoffCardRunIds.add(msg.runId);
      this.restoredHandoffCard?.remove();
      this.restoredHandoffCard = undefined;
      this.handoffCardEls.set(msg.runId, this.renderHandoffCard({ ...msg, runId: msg.runId }));
    }
    // R-HND-08: 終端を出し終えた実行と、いま表示している実行以外の通知は表示を触らない。
    // failed / done を出したら所有権を手放す（次の実行の running を捨てないため）
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

  // 展開部の 1 便。届いた分だけ描き、続きがあれば次の part を要求する。
  // 全文を 1 つの文字列へ組み立てない（967k セッションでは逐語が MB 級になる）
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

  // 追い出しはしない。カード DOM を残したまま重複排除情報だけ消すと、
  // 追い出された done の再送でカードが複製される
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

  // 引き継ぎ先タブの会話面の先頭に置く状態カード。本文は handoffDetail が後から足す
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
    // 会話面の先頭に置く（R-HND-09）。前世代を描かないので、この世代はカードから始まる。
    // live と復元で同じ位置にする。履歴 head が既にあっても、その前へ置く。
    this.convEl.insertBefore(card, this.convEl.firstChild);
    this.convEl.scrollTop = this.convEl.scrollHeight;
    return card;
  }

  auth: AuthStatus | null = null;
  // resume 元のセッションID（snapshot 由来）。analysis メッセージの行き先解決に使う
  resumeSessionId: string | undefined;
  configModel: string | undefined;
  configEffort: string | undefined;
  defaultEffort: string | undefined;
  appliedEffort: string | null | undefined;
  appliedModel: string | undefined;
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
  // このタブが turn_started・終端（完了/中断/失敗）・撤回のどれかで観測した turnId と、
  // turn_started が届かないまま本文デルタで開いた turnId。孤児デルタの採用は
  // onAssistantTextDelta の門（provenance が history でない・turnId が currentTurnId と違う）を
  // 通った先で、この 2 つを見て決める。既知の turnId を採用すると、次のターンが始まった後に
  // 届く遅延 final が終わったターンを開き直す
  private readonly knownTurnIds = new Set<string>();
  private readonly adoptedTurnIds = new Set<string>();
  // snapshot 再生が終わったか。main.ts は再生ループの直後に installHistoryHead() を呼び、
  // 再生しない経路（hydration loading）でも必ず呼ぶので、これが再生中かどうかの唯一の目印になる。
  // 再生窓が turn_started を切り落としただけの採用を live の異常として診断に出さない（OA-8）
  private replayDone = false;
  // 楽観的 running 中（turn_started 未着）フラグ。error 到着で idle へ戻す（codexレビューC2-6）
  pendingSend = false;
  private currentAssistantBlock: HTMLElement | null = null;
  private assistantBuffer = "";
  // api_retry の更新先ブロック（ターン毎にリセット）
  private retryBlock: HTMLElement | null = null;

  // ターン終端でリトライ表示をDOMごと撤去する（レビューAR1-3: 回復後・replay後に
  // 「再試行中」の警告が恒久残留する）
  private clearRetryBlock(): void {
    this.retryBlock?.remove();
    this.retryBlock = null;
  }
  // delta batch（rAF でまとめて描画）
  private pendingDeltaText = "";
  private rafScheduled = false;
  // 保留中デルタの turnId。currentTurnId は次の turn_started で先に進むので、
  // セグメントの帰属はデルタ受理時の値で決める
  private pendingDeltaTurnId: string | null = null;
  private currentSegTurnId: string | null = null;
  // 会話面の最上部にある確定済みセグメントの turnId と原文。裏読みが同じ turnId のデルタを
  // 積むとき、原文を連結して描き直すために 1 つだけ持つ（R-CNV-09）。上に別の発言が
  // 乗った時点でそのセグメントは伸びないので、保持はこの 1 件で足りる
  private topConvSeg: { turnId: string; el: HTMLElement; text: string } | null = null;
  private toolCards = new Map<string, HTMLElement>();
  // 作業カード(toolgroup)。key = reducer の segmentId。過去カードのツールが遅れて終了しても、
  // イベントに載った配置がそのカードを指すので混入しない。
  private segmentCards = new Map<string, SegmentCard>();
  // 最初の replayed_message の前に一度だけ復元マーカーを出すためのフラグ
  private replayMarkerShown = false;
  private lastObservedModel: string | null = null;
  // 復元マーカーの実体。会話の過去 chunk はこれより上へ入れる
  // （マーカーは「ここから下が復元分」の意味なので、より古い復元分を下へ入れると意味が逆になる）
  private replayMarkerEl: HTMLElement | null = null;
  private convHistoryEl: HTMLElement | null = null;
  private convHistoryBodyEl: HTMLElement | null = null;
  // 会話メッセージの同一性（transcript の uuid）。live の復元ブロックも登録するので、
  // 取り寄せた過去 chunk と重複しない
  private convMessageUuids = new Set<string>();
  private convPrependedTotal = 0;
  // 会話面へ描いたイベントの識別子。作業ログ側の renderedEventKeys とは**別に持つ**。
  // 共有すると、同じイベントを作業ログ側が先に描いた時点で会話側が「描画済み」と判断して
  // 二度と描かれない（同じ chunk が両面へ別々に流れる設計のため）
  private renderedConvEventKeys = new Set<string>();
  // 遡りで作った過去ターンの本文。chunk を跨いだ同一 turnId を1ブロックへ統合するために持つ。
  // Tab インスタンスと寿命を共にするので clearTab / 再 resume では作り直される
  private pastConvTurns = new Map<string, { el: HTMLElement; text: string }>();
  // 遡りで作った過去ターンの返信フッターと、その日時の出所。EventLog 位相の chunk では
  // 本文（assistant_text_delta）と完了時刻（turn_completed）が別の chunk に割れうるので、
  // 両方を turnId で持ち越して後から突き合わせる
  private pastConvFooters = new Map<string, HTMLElement>();
  private pastTurnCompletedAt = new Map<string, number>();
  private lastPastModel: string | null = null;
  // 作業ログ側の復元マーカー（会話側とは独立に1回だけ出す）
  private workReplayMarkerShown = false;
  // TodoWrite 専用カード（Tabごとに1枚。更新のたびにログ末尾へ移動）
  private todoCardEl: HTMLDetailsElement | null = null;
  private todoSummaryEl: HTMLElement | null = null;
  private todoListEl: HTMLElement | null = null;
  // task（TODO行）ごとの作業コンテナ。key = reducer の taskKey。
  private todoWork = new Map<string, HTMLElement>();
  // todo行の展開状態。展開はユーザー操作のみで変わる（再描画・status変化で自動開閉しない）
  private todoRowOpen = new Map<string, boolean>();
  // 記帳系（reducer が配置を作らなかった tool_call_started）の toolUseId。
  // finished 側でツール行として扱わないためのガード。
  private nonWorkToolUseIds = new Set<string>();
  // 実行時間計測: tool_call_started 時の envelope timestamp を保持し、finished で差分を取る。
  // これはツール行1件の表示で、カードの集計ではない（カードの経過時間は WorkModel 側の値）。
  private toolStartTimes = new Map<string, number>();
  // サブエージェント（Agent/Task ツール起動）のカード。toolUseId をキーに DOM 参照だけを持つ。
  private agentCards = new Map<string, AgentCardEntry>();
  // 行の中身。agent 配下の並びは WorkRowData.childIds が持つ
  private rowData = new Map<string, WorkRowData>();
  private bgTaskIdToToolUseId = new Map<string, string>();
  // ---------- WorkModel から受け取った値（このタブが描く数値の正本） ----------
  // 直近に受け取った WorkModel の revision（DOM検証の同定に使う）
  private workRevision = 0;
  private segmentTotals = new Map<string, WorkSegmentView>();
  // 過去 chunk 由来の集計と agent 状態。過去カードの描画にだけ使い、segmentTotals / agentStates
  // へ混ぜない（R-TAB-09）。chunk は新しい側から届くので、revision が新しいものだけを残す
  private pastSegmentTotals = new Map<string, WorkSegmentView>();
  private pastAgentStates = new Map<string, WorkAgentStateView>();
  private taskTotals = new Map<string, WorkTaskTotalsView>();
  private agentStates = new Map<string, WorkAgentStateView>();
  private taskItems: WorkTaskItemView[] = [];
  // 未解決の承認要求数。DOM を数え直さない（承認カードは会話パネル・作業ログ・ミラーに現れうる）
  private pendingApprovalCount = 0;
  private approvalCards = new Map<string, HTMLElement>();
  private approvalRefs = new Map<string, HTMLElement>();
  // 配置情報の無いイベントを受けたことを1度だけ報告する（毎イベント送ると診断が溢れる）
  private missingWorkInfoReported = false;
  // 過去 chunk 再生中だけ非 null
  private pastRender: PastRenderContext | null = null;
  // 作業ログの履歴挿入点。chrome（overview の 4 要素）の下・ログ本体の上に居る
  private historyHeadEl: HTMLElement | null = null;
  private historyMoreEl: HTMLElement | null = null;
  private historyBodyEl: HTMLElement | null = null;
  // 描画済みイベントの識別子（generation:seq）。cursor は消費されない設計なので同じ chunk が
  // 何度でも返る。要求単位ではなくイベント単位で弾く必要がある（契約 C4）
  private renderedEventKeys = new Set<string>();
  // 反映先がまだ無い更新イベントの保留。窓境界や chunk 境界を跨ぐと、更新のほうが先に
  // 処理され対象の行が後から作られる並びが実際に起きる。保留しないと
  // 「永久 running」「モデルチップが宣言値のまま」「解決済み承認が未解決に見える」になる（契約 C5）。
  // 対象が作られた時点で当て直し、当てたら消す
  private orphanFinishes = new Map<string, Extract<NormalizedEvent, { kind: "tool_call_finished" }>>();
  private orphanSubagentInfo = new Map<string, Extract<NormalizedEvent, { kind: "subagent_info" }>>();
  private orphanApprovalResolved = new Map<
    string,
    Extract<NormalizedEvent, { kind: "approval_resolved" }>
  >();
  // reducer が stale へ移したが行がまだ無かった toolUseId（orphanFinishes とは別に数える）
  private orphanStaled = new Set<string>();
  // 突合用の累計。workEl 配下の .hll-past の実数と一致していなければ、作った行が
  // 未接続コンテナへ落ちている（契約 C1b / C4b）。
  // これらの履歴状態に明示的な破棄経路は無い。tabCleared / init / tabClosed は
  // いずれも Tab インスタンスごと作り直すので、寿命はインスタンスと同一（契約 C9）
  private pastRenderedTotal = 0;

  // ---------- タイトル右の状態行 ----------
  // サブエージェント配下で実行中の子ツール（key=子のtoolUseId）。親の委任を観測できない間もタブを点灯させる（isTabActive）。
  // 所有権（H-3）: turn_started・終端イベント（turn_completed/turn_interrupted/turn_failed/conversation_closed）でクリア。
  private runningChildTools = new Map<string, { name: string; parentId: string }>();
  // 点灯・帯の背景側（委任の生存・背景タスク集合）。規則は background-activity.ts だけが持ち、Host も同じ fold を回す。
  // snapshot が運ぶ Host の現在値で置き換える（replaceBackgroundActivity）。再生したイベントだけから作ると、
  // 窓から起動と集合信号が落ちた背景だけのタブが消灯する（R-SES-02）
  private activity: BackgroundActivityState = createBackgroundActivityState();
  // 新規セッションの 1 ターン目は provider 時刻が未観測で turn_started.timestamp が 0（Host は実時計で埋めない）。
  // 0 を起点にすると経過表示が 1970 年起点（約 56 年）になるため、表示用の起点は webview の壁時計で補う
  private stripStartedAt: number | null = null;
  private stripWrapEl!: HTMLElement;
  private stripEl!: HTMLElement;
  private stripTextEl!: HTMLElement;
  private stripTimeEl!: HTMLElement;

  constructor(readonly tabId: string, public title: string) {
    this.logEl = document.createElement("div");
    this.logEl.className = "log";
    // パネルより前に置くことで #logs に対する position:sticky が効き、
    // どちらのパネルを見ていても常に見える
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
    // 裏読みの帯・状態行・PLAN の帯は syncHeadLayout を通らない契機でも高さが変わる。高さの変化を全て拾って .wg-head の貼り付き位置へ渡す
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.syncLogHeadHeight()).observe(this.headEl);

    this.convEl = document.createElement("div");
    this.convEl.className = "panel panel-conv active";
    this.convEl.id = `panel-conv-${this.tabId}`;
    this.convEl.setAttribute("role", "tabpanel");
    // タブと相互参照させ、パネル自体もキーボードで到達できるようにする（AR5-L6）
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
    this.chatYou = new YouList(this.youItems, item => this.navigateToYou(item), (count, total) => this.planPanel.setWaiting(count, total), false);
    this.summaryYou = new YouList(this.youItems, item => this.navigateToYou(item));
    this.planPanel.you.append(this.chatYou.element);
    this.logEl.appendChild(content);
    logsEl.appendChild(this.logEl);
    this.observeTurnRails();

    // button 入れ子は HTML/ARIA 違反のため div[role=tab] にする（レビューP2R2-6a）
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
    // タブの表示幅は CSS で切れるので、ツールチップが唯一の識別手段になる。
    // rename() だけでなく生成時にも設定する（無いと履歴から開いたタブで似た名前のセッションを取り違える）
    label.title = title;
    this.labelEl = label;
    const dot = document.createElement("span");
    dot.className = "tab-dot";
    // 閉じるはキーボード到達可能な button にする（レビューP2-6）
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

  // グラフの .wg-head（zoom bar・ミニマップ・時間軸）は .log-head の直下に貼り付く（main.css .wg-head の top）
  private syncLogHeadHeight(): number {
    const headH = this.headEl.getBoundingClientRect().height;
    if (headH > 0) this.logEl.style.setProperty("--log-head-h", `${headH}px`);
    return headH;
  }

  // The per-session navigation is separate from the top-level session tabbar.
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

  // 引き継ぎの進行はタイトル・日付の右側へ置き、会話本文の領域を食わない。
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

  // 過去ログの裏読みもヘッダー右列へ置き、独立した進行行で高さを増やさない。
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

  // 会話の裏読み進行の唯一の表示口。数字は Host が申告した残件をそのまま出す。
  // 単位語を付けない: events phase は NormalizedEvent 件数、transcript phase はメッセージ件数で、
  // 同じ数字の実体が phase で変わる
  setConvLoadProgress(state: LoadProgressState | { phase: "done" }): void {
    // 読み終わったら消す。完了状態は出さない（R-CNV-02）
    this.convLoadState = state.phase === "done" ? null : state;
    this.renderLoadSlot();
    // 検索の件数注記は読み込み状態に連動する。ここで描き直さないと終端後も「読み込み中」が残る（R-26）
    if (this.tabId === activeTabId) refreshFindCount();
  }

  // 検索バーの件数注記が読む。loading = 遡りが進行中で件数は途中、failed = 途中で止まった
  convHistoryLoadState(): "loading" | "failed" | null {
    const state = this.convLoadState;
    if (state === null) return null;
    return state.phase === "failed" ? "failed" : "loading";
  }

  // 状況面（作業ログ）の裏読み進行の唯一の表示口。残件は Host が申告した NormalizedEvent 件数
  setWorkLoadProgress(state: LoadProgressState | { phase: "done" }): void {
    // 読み終わったら消す。完了状態は出さない（R-TAB-08）
    this.workLoadState = state.phase === "done" ? null : state;
    this.renderLoadSlot();
  }

  // 会話面と状況面の進行を混同させない。見ている面の進行だけを出し、
  // もう一方の面の進行は裏で続いていても描かない（R-CNV-02 / R-TAB-08）
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
      // 一過性の失敗が続いて止まったことは本文に出す。title だけだと「行き止まり」に読まれる（R-14）
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

  // 表示モードを切り替える。スクロール位置はモードごとに退避・復元する。
  // moveFocus=true はキーボード操作時（ロービングtabindexの移動先へフォーカスを送る）。
  // persist=false は復元中に使う。復元ループの途中で persistState() を走らせると、
  // まだ tabs へ登録されていないタブの views が欠落し、未入力の inputEl で下書きを
  // 空に上書きしてしまう（レビューAR5-C1/C2）。
  setViewMode(mode: ViewMode, moveFocus = false, persist = true): void {
    if (mode !== this.viewMode && activeTabId === this.tabId) noteSurfaceChange();
    if (mode !== this.viewMode) {
      // 現在のパネルのスクロール位置を退避してから切り替える
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
    let details = target.closest("details");
    while (details instanceof HTMLDetailsElement) {
      details.open = true;
      details = details.parentElement?.closest("details") ?? null;
    }
    const stickyHeight = this.headEl.getBoundingClientRect().height;
    target.style.scrollMarginTop = `${Math.ceil(stickyHeight) + 8}px`;
    target.scrollIntoView({ block: "start" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
    target.querySelector<HTMLElement>("summary")?.focus();
    this.atBottom.work = false;
    this.scrollPos.work = logsEl.scrollTop;
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

  // 会話面に該当ターンの塊があるか。概要の「会話」ボタンは飛び先が無ければ出さない（AR5-L3 と同じ規律）
  hasConversationTurn(turnId: string): boolean {
    return this.convEl.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`) !== null;
  }

  // 概要の往復の行から会話面の該当ターンへ飛ぶ（R-CNV-03 の data-turn-id）
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

  // 状況のサブタブ切替。WorkOverview.setMode の先頭で呼ばれ、離れる側の位置を退避する。
  // 返す関数は applyMode（hidden の付け替え）の後に呼ばれ、入る側の位置を当て直す。
  // 隠れたパネルの scrollTop は内容高が縮んで clamp されるので、退避は隠す前でなければならない
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
        // 次に状況を開いたとき（setViewMode）が、入る側のサブタブの位置へ当たるようにしておく
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

  // グラフの窓が可視帯を測る口。top は topVisibleToolRow と同じ量（.log-head の下端）。
  // 状況面が表示中でなければ矩形が 0 になるので測らせない
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

  // 1 つ前の自分の発言へ移動する。押すたびに 1 つずつ古い方へ進む（R-CNV-03）。
  // 走査対象は会話面の `.block.user` を document 順に並べたもので、ライブ・復元・
  // 取り寄せた過去を区別しない（利用者から見ればどれも「自分の発言」）。
  // 飛び先が無いときは何もしない（戻り値は持たない: 呼び出し側に分岐は無い）
  scrollToPreviousUserBlock(): void {
    // 起点の計算は会話面の実測寸法に依存し、非表示パネル（display:none）では矩形が
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

  // いま見ている面の最新位置へ戻る。
  scrollToLatest(): void {
    this.convCursorEl = null;
    // 明示操作なので遡り中の張り付き抑止を解除する。順序を入れ替えると ↓ が効かない（R-CNV-04）
    this.atBottom[this.viewMode] = true;
    this.scrollToBottom(this.viewMode, true);
  }

  // 会話側に「応答が要る／致命的な問題が出た」ことを、作業ログ表示中でも見落とさせない。
  // 自動で画面は切り替えない（要件8）ため、切替タブ側で注意を促すに留める。
  private flagConvAttention(): void {
    if (this.viewMode === "conv") return;
    this.viewTabs.chat?.classList.add("needs-attention");
  }

  private clearConvAttention(): void {
    this.viewTabs.chat?.classList.remove("needs-attention");
  }

  // 復元後に注意表示を貼り直す。再生中は viewMode がまだ "conv" なので flagConvAttention は何もせず、
  // 作業ログ表示で復元したタブに未応答の承認が残っていても赤字が出ない
  // （レビューAR6-M1）。過去の失敗は復元しない（応答待ちではないため）。
  syncConvAttention(): void {
    if (this.hasPendingApproval()) this.flagConvAttention();
  }

  // 未解決の承認があるか。件数は WorkModel が持つ。DOM を走査して数えない（ヘッダのミラーまで拾って誤検知する — レビューAR6-M1）。
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
    this.stripEl.append(spinner, this.stripTextEl, this.stripTimeEl);

    wrap.append(this.stripEl);
    progress.appendChild(wrap);
  }

  // タイトル右の状態行。turnState/taskItems が変わる箇所（setTurnState・applyWork・renderTaskCard 等）から呼ぶ。
  // 背景作業・エージェントの一覧はここへ出さない（PLAN の NOW と狭幅の引き出しが持つ）
  updateStrip(): void {
    this.syncTabDot();
    const visible = this.turnState !== "idle";
    this.stripWrapEl.classList.toggle("hidden", !visible);
    if (visible) {
      const inProgress = this.taskItems.find(item => item.status === "in_progress");
      this.stripTextEl.textContent = inProgress?.activeForm ?? l10n.t("Generating response…");
      this.updateStripElapsed();
    }
    this.syncHeadLayout();
  }

  // このタブが「動いている」かの唯一の述語。サブエージェント・バックグラウンドだけが
  // 動いている間も点ける。turnState 単独で判定しない（R-SES-02）。
  // 委任の項が「サブエージェントだけが動いている」場合の本体で、この項を外すと
  // その場合に turn_completed の時点で必ず偽になる（背景タスクが別に立っていない限り）
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

  // 経過時間表示のみの軽量更新（1秒毎のグローバルタイマーから呼ぶ）。
  private updateStripElapsed(): void {
    if (this.stripStartedAt === null) {
      this.stripTimeEl.textContent = "";
      return;
    }
    const sec = Math.max(0, Math.floor((Date.now() - this.stripStartedAt) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    this.stripTimeEl.textContent = `${mm}:${ss}`;
  }

  // グローバル1秒タイマーからの呼び出し口（アクティブタブのみ・かつ実行中の間だけ意味がある）。
  // タブ毎の setInterval は持たない＝タブ閉鎖時のタイマーリークが構造的に起きない（要件4）。
  tickStrip(): void {
    if (this.turnState !== "idle") this.updateStripElapsed();
  }

  private notifiedActive: boolean | undefined;

  setTurnState(state: "idle" | "running" | "interrupting"): void {
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

  // target で表示先パネルを選ぶ。既定は会話（ユーザーの判断・読解に関わるもの）。
  // 内部進行ログ（リトライ・診断など）は "work" を明示する。
  addBlock(cls: string, text: string, markdown = false, target: ViewMode = "conv", model: string | null = null): HTMLElement {
    // 会話へブロックを差し込むときは、進行中のassistantコンテナを必ず閉じる。
    // 閉じないと、このブロックの後に再開した本文が「このブロックより上のコンテナ」へ
    // 追加され、時系列が逆転する。クラス名の前方一致で除外しない（"assistant replayed" も startsWith("assistant") に一致する — レビューAR5-M2）。
    // ライブ本文は appendAssistantSegment 経由で addBlock を通らないため影響しない。
    if (target === "conv") this.endAssistantTurn();
    const div = document.createElement("div");
    div.className = `block ${cls}`;
    if (markdown) renderMarkdownInto(div, text, this.tabId);
    else div.textContent = text;
    if (target === "conv") {
      if (div.classList.contains("user")) this.prependTurnLabel(div, "user");
      else if (div.classList.contains("assistant")) this.prependTurnLabel(div, "assistant", model);
    }
    (target === "work" ? this.workEl : this.convEl).appendChild(div);
    // 新しい発言が末尾へ増えたら「↑」の起点を最新へ戻す。上へ prepend されたときは
    // 起点が指す要素は変わらないので落とさない
    if (target === "conv" && cls.startsWith("user")) this.convCursorEl = null;
    this.scrollToBottom(target);
    if (target === "conv" && this.tabId === activeTabId) refreshFind();
    return div;
  }

  // 表示中のパネルへ追記したときだけ追従する。裏のパネルへの追記でスクロールを動かさない。
  // 裏のパネルは「最下部に張り付いていたか」を保持し、張り付いていたときだけ末尾へ更新する
  // （途中まで読んで別パネルへ移ったユーザーの位置を奪わない）。
  // explicit は利用者の「最新へ」。グラフの窓（graphHold）は、見ている区間を Host 起因の追記で動かさない
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
    if (!this.atBottom[target]) return; // 上へ遡って読んでいる最中は引き戻さない
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  // 追記の末尾追従（scrollToBottom）・張り付き記録（noteScroll）・サブタブ往復の退避と復元
  // （switchWorkViewScroll）の 3 つがこれ 1 つを見る。1 つでも外すと、復元経路が末尾へ飛ぶ材料
  // （atBottom.work / workViewAtBottom.graph）が残る
  private holdsWorkScroll(): boolean {
    return this.workView === "graph" && this.graphHold;
  }

  // 面ごとの張り付き状態の読み取り口。main.ts は書き換えない
  isAtBottom(mode: ViewMode): boolean {
    return this.atBottom[mode];
  }

  // #logs のスクロールに追従して「最下部に張り付いているか」を記録する（表示中パネル分）。
  noteScroll(): void {
    const gap = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight;
    // hold 中は張り付きを記録しない。復元経路（setViewMode / restoreScroll / switchWorkViewScroll）が末尾へ飛ぶ材料になる
    this.atBottom[this.viewMode] = gap <= SCROLL_BOTTOM_GAP_PX && !(this.viewMode === "work" && this.holdsWorkScroll());
    this.scrollPos[this.viewMode] = logsEl.scrollTop;
  }

  // このタブがアクティブになったときのスクロール復元。
  restoreScroll(): void {
    this.syncHeadLayout();
    this.placeSurface(this.viewMode);
    this.unappliedCarry = undefined;
    this.scrollRestored = true;
  }

  // 張り付きなら末尾、持ち越した行があれば一度だけその行、どちらでもなければ退避した位置
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

  // 行が窓に無い実行ログは末尾へ置く。末尾でないと裏読み（mayRequestBackfill は実行ログの張り付きを見る）が止まり、
  // 状況の数字が読み終わらない（R-TAB-07）
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

  // 可視帯の先頭の行。表示中の面でだけ測れる
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

  // 作り直しの前に今の位置を行で退避する。当てる前（unappliedCarry）は受け取った値をそのまま返す。
  // measure=false は #logs.scrollTop が最後に測ったときと同じなら行を測らず、記録済みの張り付き・位置と最後に測った行から組む（persistState 用）
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

  // addTab の最後（状況のサブタブを戻した後）に呼ぶ。サブタブの復元（switchWorkViewScroll）は面の値を
  // 書き換えるので、先に入れると上書きされる。位置を当てるのは restoreScroll / setViewMode
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

  // スクロールが落ち着いたとき（main.ts の遅延保存）に、表示中の面の行を測り直す
  noteScrollAnchor(): void {
    if (this.unappliedCarry === undefined && activeTabId === this.tabId && this.scrollRestored) this.captureScrollCarry();
  }

  // タブを離れるとき。表示していない間は矩形が測れないので、ここで行を控える。遡り待ちはここで諦める
  noteLeavingScroll(): void {
    this.awaitedConvAnchor = undefined;
    this.knownAnchor[this.viewMode] = this.atBottom[this.viewMode] ? undefined : this.measureAnchor(this.viewMode);
    this.anchorMeasuredTop = undefined;
    this.scrollRestored = false;
  }

  // 会話の遡りが先頭へ積んだ後。待っている行が届いていれば合わせる
  realignScrollAnchor(): void {
    const anchor = this.awaitedConvAnchor;
    if (anchor === undefined || activeTabId !== this.tabId || this.viewMode !== "conv") return;
    if (this.alignToAnchor("conv", anchor)) this.awaitedConvAnchor = undefined;
  }

  stopAwaitingScrollAnchor(): void {
    this.awaitedConvAnchor = undefined;
  }

  // snapshot再生の直後に呼ぶ。旧 DOM への参照は、位置を持ち越す作り直しでも消す
  resetReplayArtifacts(): void {
    this.convCursorEl = null;
  }

  // 持ち越す位置が無いときだけ呼ぶ。会話面を「最新に追従」、状況の 4 タブを初期状態（実行ログだけ追従・他は先頭）へ戻す
  resetScrollPosition(): void {
    this.workViewScrollPos = { summary: 0, graph: 0, analysis: 0, log: 0 };
    this.workViewAtBottom = { ...WORK_VIEW_AT_BOTTOM_INITIAL };
    this.atBottom = { conv: true, work: this.workViewAtBottom[this.workView] };
    this.scrollPos = { conv: 0, work: 0 };
    if (activeTabId === this.tabId) logsEl.scrollTop = this.atBottom[this.viewMode] ? logsEl.scrollHeight : 0;
  }

  // 実行ログが最下部に張り付いているか。裏読みを止める／再開する判断（main.ts mayRequestBackfill）はこれを見る。
  // 他のサブタブを見ている間は、実行ログ側に退避してある張り付きが答え（概要のままでも裏読みは進む — R-TAB-07）
  isWorklogAtBottom(): boolean {
    return this.workView === "log" ? this.atBottom.work : this.workViewAtBottom.log;
  }

  // 実行ログを最下部へ張り付け直す。裏読みの「再開」が、上へ遡って止めた状態からでも
  // 進めるようにするための明示操作の入口（R-TAB-08）。他のサブタブを見ている間はその位置を動かさない
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

  // 再生終了時に、開いたままの assistant セグメント/コンテナを確定する。
  // 実行中のターンを復元した場合は閉じない（続きのdeltaが別回答として分かれてしまうため）。
  finalizeReplay(stillRunning: boolean): void {
    if (!stillRunning) this.endAssistantTurn();
  }

  // WorkModel が running から stale へ移したツール・エージェントの表示を止める。
  // 判断は reducer 側（ターン終端・ターン開始・会話終了）で、ここは指名された toolUseId の
  // 表示だけを変える。DOM を走査して「実行中に見えるもの」を探さない（完了済みまで巻き込む。敵対レビュー R1-F1）。
  private applyStaled(toolUseIds: readonly string[]): void {
    for (const toolUseId of toolUseIds) {
      const data = this.rowData.get(toolUseId);
      // 行がまだ無い＝開始が窓の外。裏読みが行を作った時点で当て直さないと、
      // 中断済みの過去のツールが「実行中」として壁時計で育つ（R-TAB-09）
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

  // 失敗の出し方は概要側と同じ規則にそろえる（直下の失敗と agent 子ツールの失敗を足す）
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

  // reducer が開始時に固定した配置へ el を置く。ここでは「今どこか」を一切見ない
  // （見た瞬間に、カード切替後の遅延完了が次のカードへ入る経路が戻る = R1-F2）。
  private placeWork(el: HTMLElement, placement: WorkPlacementView, lastLabel: string): void {
    const toolUseId = el.dataset.toolUseId ?? "";
    if (placement.ownerToolUseId !== undefined) {
      const owner = this.agentCards.get(placement.ownerToolUseId);
      const ownerData = this.rowData.get(placement.ownerToolUseId);
      // 親カードが無いのは、その開始イベントが再生範囲の外にある場合。行を捨てるより
      // 通常の配置先へ出す（件数は WorkModel 側の値なので、ここで増減はしない）
      if (owner && ownerData) {
        this.insertWork(owner.childrenEl, el);
        (ownerData.childIds ?? (ownerData.childIds = [])).push(toolUseId);
        return;
      }
    }
    if (placement.taskKey !== undefined) {
      const container = this.ensureTodoWorkContainer(placement.taskKey);
      // 未接続コンテナは live なら次のタスク一覧再構築で接続されるが、過去 chunk の taskKey は
      // 現在の WorkModel から既に消えていることがあり、その場合は永久に未接続のまま
      // ＝行が例外も出さずに画面から消える。過去再生では履歴ブロック直下へ落とす（契約 C1b）
      if (this.pastRender === null || container.isConnected) {
        this.insertWork(container, el);
        return;
      }
      this.insertWork(this.pastRender.frag, el);
      return;
    }
    const card = this.ensureSegmentCard(placement);
    if (!card) {
      // live は segmentId 無しの行を捨てる（従来どおり）。過去再生で捨てると突合が合わない
      if (this.pastRender !== null) this.insertWork(this.pastRender.frag, el);
      return;
    }
    this.insertWork(card.el, el);
    card.lastLabel = lastLabel;
    this.renderSegmentCard(card);
  }

  // live は末尾へ足すだけ。過去再生は「その容器へ最初に入れた時点の firstChild」を容器ごとに
  // 固定し、その直前へ入れ続ける。固定するから chunk 内の順序が保たれる（契約 C1）。
  // 履歴ブロック（frag）だけは常に append: frag は空から始まり chunk 順に積むだけなので
  // anchor 機構が要らず、かつ ensureSegmentCard が先に append していると
  // anchor がそのカードに固定されて以後の平文行がカードの上へ潜り込む
  private insertWork(container: Node, el: Node): void {
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

  // Agent/Task（サブエージェント起動）の行データを作る。DOM は buildAgentCardDom が組む
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
    // 起動時点は宣言値（明示input.model / frontmatter）。実測モデルは subagent_info で差し替わる
    if (ev.subagentModel) setRowChip(data, "model", shortModelLabel(ev.subagentModel));
    if (ev.subagentEffort) setRowChip(data, "effort", `effort: ${ev.subagentEffort}`);
    this.rowData.set(ev.toolUseId, data);
    const entry = this.buildAgentCardDom(data);
    this.agentCards.set(ev.toolUseId, entry);
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
    nameEl.textContent = `🤖 ${data.summaryText}`;
    const chipsEl = document.createElement("span");
    chipsEl.className = "agent-chips";
    const meta = document.createElement("span");
    meta.className = "agent-meta";
    summary.append(status, nameEl, chipsEl, meta);
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

  // エージェントカードのメタ表示を「⚙N [✗M] · 経過時間 · tok · 状態」の順で統一する。
  // 値はすべて WorkModel のもの。DOM の子要素数で数えると入れ子のエージェント（別カード）が入らずモデルと食い違う。
  // 経過時間・tok は未確定（実行中）の間は出さない
  private paintAgent(entry: AgentCardEntry, data: WorkRowData): void {
    const state = this.agentStates.get(data.toolUseId) ?? this.pastAgentStates.get(data.toolUseId);
    if (!state) return;
    entry.card.dataset.workRevision = String(state.revision);
    entry.statusEl.className = `tool-status ${
      state.status === "completed" ? "done" : state.status === "unknown" ? "stale" : state.status
    }`;
    entry.statusEl.replaceChildren(...(state.status === "running" ? [createLoader(12)] : []));
    let text = `⚙${state.childCount}`;
    if (state.failCount > 0) text += ` ✗${state.failCount}`;
    if (state.elapsedMs > 0) text += ` · ${formatDuration(state.elapsedMs)}`;
    if (state.tokens !== undefined) text += ` · ${formatTokenCount(state.tokens)}`;
    text += ` · ${AGENT_STATUS_WORD[state.status]}`;
    entry.metaEl.textContent = text;
    entry.metaEl.classList.toggle("has-fail", state.failCount > 0);
    if (state.modelMeasured) {
      setRowChip(data, "model", shortModelLabel(state.modelMeasured));
      fillChips(entry.chipsEl, data);
    }
  }

  private renderAgentMeta(toolUseId: string): void {
    const entry = this.agentCards.get(toolUseId);
    const data = this.rowData.get(toolUseId);
    if (entry && data) this.paintAgent(entry, data);
  }

  // 通常のツール行（agent-card の子ツールも含め共通）。tool_call_finished 側で
  // toolCards から引き当てて状態ドット・結果・経過時間を反映する。
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
    return row;
  }

  private buildToolRowDom(data: WorkRowData): HTMLDetailsElement {
    const row = document.createElement("details");
    row.className = data.status === "stale" ? "tool-row" : `tool-row ${data.status}`;
    row.dataset.toolUseId = data.toolUseId;
    const rowSummary = document.createElement("summary");
    // 5 列: 時刻 / 状態（文字）/ ツール名 / プレビュー / 所要時間（R-TAB-06）
    const at = document.createElement("span");
    at.className = "tool-at";
    at.textContent = data.startedAt > 0 ? clockLabel(data.startedAt) : "";
    const status = document.createElement("span");
    status.className = `tool-status ${data.status}${data.statusGlyph === "🔄" ? " bg-running" : ""}`;
    status.replaceChildren(data.status === "running" && data.statusGlyph === undefined ? createLoader(12) : document.createTextNode(data.statusGlyph ?? TOOL_STATUS_GLYPH[data.status]));
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = data.toolName;
    const preview = document.createElement("span");
    preview.className = "tool-preview";
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

  // 行データから組み直す。本体のDOMは読まない（読むと順序制約が戻る = AR-M1）
  private buildRowDom(toolUseId: string): HTMLElement | null {
    const data = this.rowData.get(toolUseId);
    if (!data) return null;
    return data.kind === "agent" ? this.buildAgentCardDom(data).card : this.buildToolRowDom(data);
  }

  // segmentId ごとに1枚。カードはツールが最初に置かれた位置に留め、ログ末尾へは移動しない
  // （レビューAR4-M1/M2）。移動案は
  // (1) DOMの再挿入になるためカード内のテキスト選択とフォーカスが毎ツール破壊される
  //     （全再構築と同じく、テキスト選択が消える）
  // (2) TODOカードも末尾へ移動するため両者が末尾を奪い合い、TODO完了後に
  //     古いカードが新しいTODO内容の下へ潜り込む＝防ぎたかった逆転が別経路で起きる
  // ため採らない。TODO期間の前後で同じカードが使い回されないことは segmentId が保証する
  // （タスクの出入りで reducer が segment を切るため、前後で別IDになる）。
  private ensureSegmentCard(placement: WorkPlacementView): SegmentCard | undefined {
    const segmentId = placement.segmentId;
    if (segmentId === undefined) return undefined;
    const existing = this.segmentCards.get(segmentId);
    // 既存カードがあればそこへ入れる。単一巨大ターン分岐では live 窓がターンの途中から
    // 始まるため、同一 segmentId が過去 chunk と live の双方に出る（契約 C2）
    if (existing) return existing;
    const details = document.createElement("details");
    details.className = "block toolgroup";
    details.dataset.segmentId = segmentId;
    details.dataset.phaseId = placement.phaseId;
    const summary = document.createElement("summary");
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

  // ストリーミング整形の増分描画用。
  // segCommittedEl: 確定した段落を描き終えた領域。以後この中のDOMには触れない（選択が壊れない）。
  // segTailEl: 未確定の末尾。デルタ到着のたびにここだけ描き直す。1回の描き直し量は「最後の確定境界から
  //   末尾まで」。確定境界はフェンス外の空行でしか進まないので、それが現れない間は末尾が伸び続け、
  //   その伸びた範囲を毎デルタ丸ごと描き直す。コードフェンスが開いている間はその一例で、空行を挟まない長い
  //   箇条書き・表・一段落の長文でも同じことが起きる（R1-F4。振る舞いは未修正）。
  // committedLen: assistantBuffer のうち確定済みの文字数。
  private segCommittedEl: HTMLElement | null = null;
  private segTailEl: HTMLElement | null = null;
  private committedLen = 0;

  // R-DSP-26。撤回は wire uuid で来るが、本文はストリームで uuid より先に届くので、
  // 出した本文を run として持ち、assistant_message_uuid で後から名前を付ける。
  // 捨てるのは turn_started だけ。endAssistantTurn で捨てると、拒否の通知ブロックが
  // セグメントを閉じた直後に届く撤回指示が対象を見つけられなくなる
  private assistantRuns: { uuid: string | null; text: string; seg: HTMLElement }[] = [];

  // 直近に組んだ返信フッターのコピー元（R-CNV-15）。closure がこの入れ物を読むので、
  // 完了後に届いた本文・撤回が text の書き換えだけでコピーへ反映される
  private liveReplyText: { turnId: string; text: string } | null = null;

  // いま「最新」の印を持つ返信フッター（R-CNV-15）。印の付け外しはここと
  // refreshLatestReplyFooter だけが行う（他所で data-latest を書くと両者がずれる）
  private latestReplyFooter: HTMLElement | null = null;

  // 楽観バブルのフッター（R-CNV-16）。吹き出しを取り消すときに実体で消す
  private readonly optimisticFoots = new Map<string, HTMLElement>();

  // 現在ターンのassistantコンテナへ新しいセグメントを足して返す。コンテナが無ければ作る。
  private appendAssistantSegment(): HTMLElement {
    if (!this.currentAssistantTurn || !this.currentAssistantTurn.isConnected) {
      const turn = document.createElement("div");
      turn.className = "block assistant-turn";
      this.prependTurnLabel(turn, "assistant", this.lastObservedModel);
      if (this.currentTurnId !== null) turn.dataset.turnId = this.currentTurnId;
      this.convEl.appendChild(turn);
      this.currentAssistantTurn = turn;
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

  // 完了済みターンのフッターが持つコピー元を、そのターンへ後から届いた本文・撤回で更新する。
  // 対象は直近の 1 ターンだけ（本文 gate も撤回の探索も currentTurnId を見るので、
  // 次の turn_started 以降は古いターンへ届かない）
  private refreshLiveReplyText(): void {
    const holder = this.liveReplyText;
    if (holder === null || holder.turnId !== this.currentTurnId) return;
    holder.text = this.assistantRunsText();
  }

  private onAssistantMessageUuid(ev: Extract<NormalizedEvent, { kind: "assistant_message_uuid" }>): void {
    // R-DSP-26: history の本文は run を作らない（onAssistantTextDelta）。history のラベルを通すと、
    // 未ラベルの live run が記録側の uuid で名付けられ、live の撤回がそれを見つけられなくなる
    if (ev.provenance?.path === "history") return;
    this.flushDelta();
    for (let i = this.assistantRuns.length - 1; i >= 0; i--) {
      if (this.assistantRuns[i].uuid !== null) break;
      this.assistantRuns[i].uuid = ev.uuid;
    }
  }

  // 撤回は冪等（未知・撤回済みの uuid は no-op）。turnId では絞らない——通知は
  // currentTurnId が無い状態でも届き、対象は uuid だけで決まる
  private onAssistantRetracted(ev: Extract<NormalizedEvent, { kind: "assistant_retracted" }>): void {
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
    this.assistantRuns = kept;
    this.refreshLiveReplyText();
    for (const seg of touched) this.rebuildAssistantSegment(seg);
    if (this.tabId === activeTabId) refreshFind();
  }

  // 撤回後の残りで 1 セグメントを描き直す。残りが無ければセグメントごと取り除く
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
      // ここでカードを区切らない。テキストを挟むたびに作業カードが分割されると、
      // 一言書くごとに1〜2件だけのカードが並ぶ（ユーザー要望: ターン内は1枚）。
      // 区切りは reducer が user_message とターン境界で segment を閉じることだけが担う。
      //
      // ツールを挟む本文も同じセグメントへ連結し、Markdown構造を保つ。
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
    // 増分描画: 確定した段落は seg-committed へ一度だけ描いて以後触らず、未確定の末尾だけを
    // seg-tail に描き直す。
    // 減るのはDOM再構築量だけで、直下の findCommitBoundary はバッファ全長を毎回走査するため
    // 境界探索は常に Θ(n)。さらに確定境界はフェンス外の空行でしか進まないので、それが現れない間
    // （開いたコードフェンス、空行なしの長い箇条書きなど）はDOM再構築量も減らず O(n²) のまま
    // （R1-F4。振る舞いは未修正）。
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

  // タスク一覧の描画。項目・状態・件数はすべて WorkModel の値（イベントに載る tasks / taskTotals）で、
  // ここで inputPreview を解釈しない。記帳系ツールの結果が失敗なら reducer は状態を更新しないので、
  // 失敗した更新が「成立した」ようには見えない。
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
    // 末尾へ移動（既にログ内にあれば付け直すことで最下部になる）
    this.workEl.appendChild(this.todoCardEl);
    this.scrollToBottom("work");
    // タイトル右の状態行を最新タスクで更新する
    this.updateStrip();
  }

  // タスクカードのsummary行（☰ タスク (N/M) · 合計時間 · ✗合計失敗 · 🤖 合計tok）。
  // 合計は WorkModel が task ごとに出した値の足し合わせで、DOM からは数え直さない
  private fillTaskSummary(summaryEl: HTMLElement): void {
    const items = this.taskItems;
    const done = items.filter((it) => it.status === "completed").length;
    let totalElapsedMs = 0;
    let totalFails = 0;
    let totalAgentTokens = 0;
    for (const item of items) {
      const totals = this.taskTotals.get(item.taskKey);
      if (!totals) continue;
      totalElapsedMs += totals.elapsedMs;
      totalFails += totals.failCount + totals.childFailCount;
      totalAgentTokens += totals.agentTokens;
    }

    summaryEl.textContent = "";
    const label = document.createElement("span");
    label.className = "todocard-summary-label";
    label.textContent = l10n.t("☰ Tasks ({0}/{1})", done, items.length);
    summaryEl.appendChild(label);
    if (totalElapsedMs > 0) {
      const dur = document.createElement("span");
      dur.className = "todocard-summary-stats";
      dur.textContent = ` · ${formatDuration(totalElapsedMs)}`;
      summaryEl.appendChild(dur);
    }
    if (totalFails > 0) {
      const fail = document.createElement("span");
      fail.className = "todocard-summary-stats has-fail";
      fail.textContent = ` · ✗${totalFails}`;
      summaryEl.appendChild(fail);
    }
    if (totalAgentTokens > 0) {
      const tok = document.createElement("span");
      tok.className = "todocard-summary-stats";
      tok.title = l10n.t("Total consumed by subagents (see the turn usage chip below for the main tokens)");
      tok.textContent = ` · 🤖 ${formatTokenCount(totalAgentTokens)}`;
      summaryEl.appendChild(tok);
    }
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
      icon.textContent = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○";
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

  // todo行summary内の「⚙N ✗M · 経過」バッジ。件数は WorkModel の toolCount
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

  // taskKey に対応する作業コンテナを取得（無ければ作成）し、現在DOM上に描画されている
  // todo行（data-todo-key一致）の中に配置する。todo行がまだ無い場合はコンテナを未接続のまま
  // 返し、次にタスク一覧が届いたときの再構築で接続される。
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

  // 現在のassistantセグメントを確定する（markdown整形）。ターンのコンテナは閉じない
  // ＝ツール実行後に本文が再開したら同じコンテナへ次のセグメントが足され、連続して読める。
  // 呼び出し元は endAssistantTurn の 1 箇所だけ＝確定が起きるのはターン境界のみ。
  // ツール開始でここを呼ぶ経路を戻すと、表・箇条書き・単語がツール呼び出しをまたいで
  // 途中で切れる（R-DSP-24）。
  // 短い・単一段落のテキストを進行メモと推測して作業ログへ移さない。進行メモか回答かは後に何が来るかで決まり、
  // テキストからは判別できないので、回答本文を誤って隠す。
  private endAssistantBlock(): void {
    this.flushDelta();
    if (this.currentAssistantBlock) {
      const text = this.assistantBuffer.trim();
      if (!text) {
        // 中身が空のセグメントは残さない（ツール連打で空セグメントが増えるのを防ぐ）
        this.currentAssistantBlock.remove();
      } else {
        this.currentAssistantBlock.classList.remove("streaming");
        if (this.topConvSeg === null && this.currentSegTurnId !== null) {
          this.topConvSeg = {
            turnId: this.currentSegTurnId,
            el: this.currentAssistantBlock,
            text: this.assistantBuffer,
          };
        }
        // 未確定の末尾だけを確定させる。確定済みDOMは触らない（選択を壊さない）
        if (this.segTailEl && this.segCommittedEl) {
          const rest = this.assistantBuffer.slice(this.committedLen);
          if (rest.trim()) {
            const block = document.createElement("div");
            this.renderReplyMarkdown(block, rest, undefined, this.committedLen);
            this.segCommittedEl.appendChild(block);
          }
          this.segTailEl.remove();
        } else {
          // 増分描画の状態が無い経路（想定外）では従来どおり全体を整形する
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

  // ターン境界: assistantコンテナを閉じ、次の本文は新しい回答として始める。
  private endAssistantTurn(): void {
    this.endAssistantBlock();
    if (this.currentAssistantTurn && !this.currentAssistantTurn.querySelector(".assistant-seg")) {
      this.currentAssistantTurn.remove();
    }
    this.currentAssistantTurn = null;
    if (this.tabId === activeTabId) refreshFind();
  }

  // 作業ログ側にターンの区切りを打つ。
  // 見出しは直前の人の発言 1 行目。同じコマンドの連続は新しい区切りを作らず件数だけ進める
  private appendTurnAnchor(
    turnId: string,
    timestamp: number,
    headline: string | null,
    cliInserted = false
  ): HTMLElement {
    const prev = this.lastCommandRun;
    if (
      headline !== null &&
      prev !== null &&
      prev.text === headline &&
      isPureCommandWrapper(headline) &&
      prev.anchor.isConnected
    ) {
      prev.count += 1;
      let rep = prev.anchor.querySelector<HTMLElement>(".wl-rep");
      if (rep === null) {
        rep = document.createElement("span");
        rep.className = "wl-rep";
        prev.anchor.appendChild(rep);
      }
      rep.textContent = l10n.t("Same command {0} times", prev.count);
      return prev.anchor;
    }
    const anchor = this.buildTurnAnchor(turnId, timestamp, headline, false, cliInserted);
    this.workEl.appendChild(anchor);
    // 見出しの引き取り先は live の区切りだけ（過去の区切りは pastPendingAnchor が持つ）。
    // CLI が開いた区切りは引き取り先にならず、先行する引き取り待ちも潰さない——null で上書きすると、
    // まだ発言が届いていない直前のターンが永久に見出しを埋められなくなる
    if (!cliInserted) this.pendingHeadlineAnchor = headline === null ? anchor : null;
    this.lastCommandRun = headline !== null && isPureCommandWrapper(headline) ? { text: headline, anchor, count: 1 } : null;
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
    const b = document.createElement("b");
    // CLI が開いたターンは見出しを持たない（本文を発言として出さない）。空の区切りと同じ
    // 「ターン開始」で出すと、利用者が打っていない行がある事実まで消える
    b.dataset.emptyLabel = cliInserted
      ? l10n.t("Started by Claude Code (not your message)")
      : l10n.t("Turn started");
    if (headline !== null) b.textContent = headline;
    const time = document.createElement("span");
    // timestamp 0 は provider 時刻未観測。live（新規セッション 1 ターン目）は stripStartedAt と同じく壁時計で補い、
    // 再生では壁時計で補えない（過去の時刻）ので未観測と明示する。
    // 0 のまま整形すると 1970-01-01 の現地時刻（JST なら 09:00:00）が出る
    time.textContent = timestamp > 0 ? clockLabel(timestamp) : past ? l10n.t("Time not observed") : clockLabel(Date.now());
    anchor.append(b, time);
    return anchor;
  }

  private static headlineOf(text: string): string {
    return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  }

  private static fillHeadline(anchor: HTMLElement, headline: string): void {
    const b = anchor.querySelector("b");
    if (b !== null && b.textContent === "") b.textContent = headline;
  }

  // 人の発言 1 行目をターン区切りの見出しへ。turnId を持つ発言（history の順）は同じ turnId の見出し待ちの区切りへ
  // 埋める。turnId の無い発言（live の順）は直後に始まるターンにだけ付く（次の turn_started が引き取る）。
  // 見出し待ちの区切りへ入れてはいけない: 発言なしで始まったターン（自動投入による非人間発話）の区切りが後から届く発言を
  // 引き取り、以後の見出しが 1 つずつずれる（R-TAB-09）。対象は live の区切りだけ
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

  // 過去 chunk の人の発言。turnId を持つ発言は同じ turnId の見出し待ちの区切りへ埋め、無ければ chunk をまたいで
  // 持ち越す。turnId の無い発言は持ち越すだけで、同じ chunk の次の区切りか chunk 末尾の処理（takePastChunkTail）が
  // 引き取る（fields の注記を見る。R-TAB-09）
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

  // chunk の末尾に残った turnId 無しの発言。[user_message | turn_started] が chunk 境界で割れた形で、相手は直前に
  // 積んだ（新しい側の）chunk の先頭の区切りに限る。それ以外の見出し待ちの区切りへは渡さず、発言は捨てる
  private takePastChunkTail(): void {
    const stash = this.pastHeadline;
    if (stash === null || stash.turnId !== null || stash.chunk !== this.pastChunkSerial) return;
    this.pastHeadline = null;
    const pending = this.pastPendingAnchor;
    if (pending === null || !this.pastPendingFirst || this.pastPendingChunk !== this.pastChunkSerial - 1) return;
    Tab.fillHeadline(pending, stash.text);
    this.pastPendingAnchor = null;
  }

  // フッターの日時（R-CNV-15 / R-CNV-16）。時刻を観測していないレコードでは時刻を出さない。
  // 0 のまま整形すると 1970-01-01 の現地時刻が出る（buildTurnAnchor と同じ理由）
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
    const { button, status } = createCopyButton("msg-copy-button", l10n.t("Copy reply"), source);
    footer.appendChild(button);
    const time = Tab.footerTime(at);
    if (time !== null) {
      time.className = "reply-footer-time";
      footer.appendChild(time);
    }
    footer.appendChild(status);
    return footer;
  }

  // 日時が本文より後の chunk で分かる経路（EventLog 位相）用。既に入っていれば触らない
  private static applyFooterTime(footer: HTMLElement, at: number | undefined): void {
    if (footer.querySelector(".reply-footer-time") !== null) return;
    const time = Tab.footerTime(at);
    if (time === null) return;
    time.className = "reply-footer-time";
    footer.insertBefore(time, footer.querySelector(".code-copy-status"));
  }

  // live / 復元の追記は必ず会話面の末尾なので、「最新の返信」の印（R-CNV-15）は控えた要素から
  // 付け替える。追記のたびに全走査すると、会話が伸びるほど 1 ターンの後始末が重くなる
  private appendReplyFooter(at: number | undefined, source: () => string): void {
    const footer = this.buildReplyFooter(at, source);
    this.convEl.appendChild(footer);
    this.latestReplyFooter?.removeAttribute("data-latest");
    footer.dataset.latest = "1";
    this.latestReplyFooter = footer;
  }

  // 印の持ち主が追記以外で変わる経路（前へ積む・ターンごと取り除く）用。DOM 順の最後で決め直す
  private refreshLatestReplyFooter(): void {
    const footers = this.convEl.querySelectorAll<HTMLElement>(".reply-footer");
    const latest = footers.length > 0 ? footers[footers.length - 1] : null;
    footers.forEach((footer) => {
      if (footer === latest) footer.dataset.latest = "1";
      else footer.removeAttribute("data-latest");
    });
    this.latestReplyFooter = latest;
  }

  // 発言フッター（R-CNV-16）。`.block.user` の中ではなく直後の兄弟として常に置き、
  // hover / focus-within で opacity と pointer-events だけを切り替える。中へ入れると
  // 吹き出しの枠がフッターのぶん広がる。要素の出し入れで行の高さを変えない。
  // コピー元は DOM ではなく渡された原文（`.block.user` の textContent は画像スロットの
  // 読み込み文言を含む）。
  // 本文の無い発言（画像だけ）にはコピーボタンを出さない——押しても空文字を配るだけになる
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

  // block は呼び出し時点で親（convEl か prepend 用の fragment）に入っていること。
  // 親が無いと after() は何もせず、フッターが無言で消える
  private appendUserFoot(block: HTMLElement, at: number | undefined, text: string): HTMLElement {
    const foot = this.buildUserFoot(at, text);
    block.after(foot);
    return foot;
  }

  handleEvent(ev: NormalizedEvent): void {
    this.observeYouEvent(ev);
    // 描画より前に畳む。完了の記録が applyWork・帯の再描画より後になると、以後の再描画契機が無いまま
    // 帯の鏡に終わったタスクが残る（CH-S1b）
    const activityChanged = applyActivityEvent(this.activity, ev);
    switch (ev.kind) {
      case "conversation_opened":
        this.onConversationOpened(ev);
        if (activityChanged) this.updateStrip();
        break;
      case "conversation_closed":
        this.onConversationClosed(ev);
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
      case "rate_limit":
        this.onRateLimit(ev);
        break;
      case "error":
        this.onError(ev);
        break;
    }
  }

  private onConversationOpened(_ev: Extract<NormalizedEvent, { kind: "conversation_opened" }>): void {
    this.contextUsage = null;
    if (activeTabId === this.tabId) refreshChrome();
    // 会話開始自体は本文へ表示しない（cwd は必要ならチップ/ツールチップで足す）。
  }

  private onConversationClosed(ev: Extract<NormalizedEvent, { kind: "conversation_closed" }>): void {
    // turn_failed を経ない突然死でも streaming ブロックを終端する（レビューP2R2-3a）
    this.endAssistantTurn();
    // 実行中表示の終端は WorkModel の遷移に従う（どの toolUseId を畳むかは reducer が決める）。
    // H-3: runningChildTools のライフサイクルは終端イベントに一元化
    this.applyWork(ev.work);
    this.runningChildTools.clear();
    this.stripStartedAt = null;
    this.addBlock("system", l10n.t("Conversation ended: {0}", ev.reason));
    this.setTurnState("idle");
    this.updateStrip();
  }

  private onAuthStatus(ev: Extract<NormalizedEvent, { kind: "auth_status" }>): void {
    this.auth = ev.auth;
    if (activeTabId === this.tabId) refreshChrome();
  }

  // ターン開始の状態リセット。turn_started と孤児ターンの採用（adoptOrphanTurn）の両方がここを通る。
  // assistantRuns のクリアはここだけに置く。他所へ移すと、採用したターンが 2 回続いたとき
  // 2 枚目のフッターが前ターンの本文をコピーする（OA-3）
  private beginTurn(
    turnId: string,
    timestamp: number,
    cliInserted: boolean,
    work: WorkEventInfo | undefined
  ): void {
    this.pendingSend = false;
    this.currentTurnId = turnId;
    this.knownTurnIds.add(turnId);
    // 前ターンのassistantコンテナを閉じる（次の本文は別回答として始める）
    this.endAssistantTurn();
    this.assistantRuns = [];
    // 作業ログ側にターンの区切りを打つ
    // CLI が開いたターンは見出しを取らない。持ち越しの消費もしない——消すと、その発言を待っている
    // 次の人間のターンが見出しを失う（復元タブは hydration 済み履歴をこの経路へ流すので実際に起こる）
    const headline = cliInserted ? null : this.lastHumanHeadline;
    if (!cliInserted) this.lastHumanHeadline = null;
    this.appendTurnAnchor(turnId, timestamp, headline, cliInserted);
    // 前ターンのカードへ追記させないのは segmentId の切替が担う（reducer が turn_started で
    // segment を閉じるので、次のツールは別カードになる）。終端イベントを取りこぼしたときに
    // 「実行中」が残り続けるのを回収するのも reducer 側で、ここは指名された分の表示を止める
    // だけにする（レビューAR4-M3 / 完了済みまで走査しない = R1-F1）。
    this.applyWork(work);
    this.clearRetryBlock();
    // H-3: 新ターン開始時に前ターンの残留を確実にクリアする。
    // 委任（activity）は含めない。前ターンで起動した background 委任は今も動いており、
    // ここで消すと次の turn_completed で消灯する（R-SES-02）
    this.runningChildTools.clear();
    // ストリップ: 経過時間の起点をリセットし、前ターンからの背景タスクカウンタを
    // クリアする（機能仕様: 次の turn_started が来たら0にリセットする簡易方式）。
    // M-1: Date.now()ではなくev.timestamp（envelopeの実時刻）を使う。replay再生時も
    // 実際の開始時刻からの経過が出る（Date.now()だと再生時刻起点になり巻き戻って見える）。
    this.stripStartedAt = timestamp > 0 ? timestamp : Date.now();
    this.setTurnState("running");
  }

  private onTurnStarted(ev: Extract<NormalizedEvent, { kind: "turn_started" }>): void {
    // 本文デルタで既に開いたターンの turn_started。開き直すと本文ブロックが閉じて
    // 同じターンが 2 つの回答として描かれる（OA-5）
    if (this.adoptedTurnIds.has(ev.turnId)) {
      this.applyWork(ev.work);
      return;
    }
    this.beginTurn(ev.turnId, ev.timestamp, ev.cliInserted === true, ev.work);
  }

  private onTurnCompleted(ev: Extract<NormalizedEvent, { kind: "turn_completed" }>): void {
    this.knownTurnIds.add(ev.turnId);
    this.endAssistantTurn();
    this.applyWork(ev.work);
    this.runningChildTools.clear();
    // 委任（activity）はここでは触らない。background 委任はメインのターンが終わった後も
    // 動き続けるので、消すと「サブエージェントだけが動いている間」に消灯する（R-SES-02）
    this.clearRetryBlock();
    this.stripStartedAt = null;
    this.setTurnState("idle");
    // 返信フッター（R-CNV-15）。コピー元は文字列ではなく入れ物で持つ: turn_completed の時点で
    // 確定させると、完了後に届く遅延 final（本文 gate は currentTurnId のままなので描画はされる）と
    // 完了後の撤回がコピーに入らない／残る。更新は noteAssistantRun と onAssistantRetracted。
    // 履歴由来のターンの会話は replayed_message が後からまとめて描くので、ここでは積まない
    if (ev.provenance?.path !== "history") {
      const holder = { turnId: ev.turnId, text: this.assistantRunsText() };
      if (holder.text.trim().length > 0) {
        this.liveReplyText = holder;
        this.appendReplyFooter(ev.timestamp > 0 ? ev.timestamp : undefined, () => holder.text);
        this.scrollToBottom("conv");
      }
    }
    if (ev.usage) {
      this.usage = ev.usage;
      if (activeTabId === this.tabId) refreshChrome();
    }
  }

  private onTurnInterrupted(ev: Extract<NormalizedEvent, { kind: "turn_interrupted" }>): void {
    this.knownTurnIds.add(ev.turnId);
    this.endAssistantTurn();
    this.applyWork(ev.work);
    this.runningChildTools.clear();
    this.clearRetryBlock();
    this.stripStartedAt = null;
    this.addBlock("system warn", l10n.t("Turn interrupted"));
    this.setTurnState("idle");
  }

  private onTurnFailed(ev: Extract<NormalizedEvent, { kind: "turn_failed" }>): void {
    this.knownTurnIds.add(ev.turnId);
    this.flagConvAttention();
    this.endAssistantTurn();
    this.applyWork(ev.work);
    this.runningChildTools.clear();
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
    // 同一ターン内は1ブロックを更新（リトライは最大10回程度連続しうる）
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
    if (ev.turnId !== this.currentTurnId && !this.adoptOrphanTurn(ev)) return;
    this.pendingDeltaText += ev.text;
    this.pendingDeltaTurnId = ev.turnId;
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      requestAnimationFrame(() => this.flushDelta());
    }
  }

  // Host の gate が turn_started を落としたターンの本文を無言で捨てない（OA-1〜OA-7）。
  // 採用してよいのは「このタブが開始も終端も撤回も観測していない turnId」だけで、
  // 既知の turnId のデルタは従来どおり捨てる（遅延 final が終わったターンを開き直す）。
  // 本文を持つのは webview 側だけなので Host へ取り寄せに行かない
  private adoptOrphanTurn(ev: Extract<NormalizedEvent, { kind: "assistant_text_delta" }>): boolean {
    if (this.knownTurnIds.has(ev.turnId)) return false;
    this.adoptedTurnIds.add(ev.turnId);
    this.beginTurn(ev.turnId, ev.timestamp, false, ev.work);
    // 再生中の採用は上流の欠落ではなく再生窓が turn_started を切り落としただけなので診断に出さない。
    // 本文は載せない（Output は利用者の目に触れる恒久ログ）
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
    this.endAssistantTurn();
    // プロンプト追加でカードを分けるのは reducer 側（user_message で segment を閉じる）
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
    // フッターは addBlock の末尾追従より後に行を伸ばす。ここで追い直さないと、発言のたびに
    // フッター 1 行ぶんの隙間が下に残り、張り付き判定（gap <= 24）も折れる
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
      this.renderReplyMarkdown(block, ev.text, ev.uuid ?? `replay:${ev.generation}:${ev.seq}`, 0, ev.recordedAt ?? 0, ev.seq, ev.generation);
      this.prependTurnLabel(block, "assistant", ev.model ?? null);
      // addBlock が素の本文で検索した後に本文を描き直すので、ここで検索し直さないと印が外れたまま件数だけ残る（CH-U32b）
      if (this.tabId === activeTabId) refreshFind();
    }
    // uuid は会話の遡りとの重複判定にだけ使う（表示専用）
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

  // 詳細ログの数値の唯一の入口。DOM を数えない
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
        // 会話タブ側の注意表示も同条件で解除する（解除しないと応答不要になっても赤字＋●が残る。AR5-L2）
        this.clearConvAttention();
      }
    }
    this.updateStrip();
  }

  // snapshot（と間引かれた live 更新）が運ぶ WorkModel から Task の現在状態を取り込む。
  // 再生窓から Task更新イベントが落ちていると、これが無ければTODO行が作られず、
  // 窓内にあるTask配下のツール行まで未接続DOMへ入って画面から消える。
  // 集計だけの更新で行を作り直さないのは、作り直すと配下のツール行が再挿入され、
  // 読んでいる最中のテキスト選択とフォーカスが飛ぶため
  applyWorkModel(model: WorkModelPayload | undefined): void {
    this.planPanel.setModel(model);
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

  // 配置情報の無いイベント。Host と webview の版が食い違ったときにしか起きない。
  // ここで「その時点のカレントカード」へ落とすと、詳細ログが WorkModel と別の帰属規則を持つ（二重正本）。
  // 落として報告する。
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
    if (isHistory && !this.workReplayMarkerShown) {
      this.workReplayMarkerShown = true;
      this.addBlock("system", l10n.t("── Restored previous session ──"), false, "work");
    }
    if (!isHistory) {
      this.toolStartTimes.set(ev.toolUseId, ev.timestamp);
    }
    this.applyWork(ev.work);
    if (!ev.work) {
      this.nonWorkToolUseIds.add(ev.toolUseId);
      this.dropUnplacedEvent(ev.kind);
      return;
    }
    const placement = ev.work.placement;
    // 配置が無い＝reducer が記帳系（TodoWrite/TaskCreate/TaskUpdate）として扱った。
    // 「実行中の作業」ではないので帯にも件数にも出さない（L-1）。どのツール名がそれに当たるかは
    // reducer だけが決める（ここに名前の表を置くと分類が2箇所になる）
    if (!placement) {
      this.nonWorkToolUseIds.add(ev.toolUseId);
      return;
    }

    if (!isHistory) {
      // 入れ子エージェント（子がAgent/Task）も数える。下の agent 分岐がそこで return するため、その前に登録する（レビューAR3-L1）
      if (placement.ownerToolUseId !== undefined) {
        this.runningChildTools.set(ev.toolUseId, {
          name: ev.inputSummary ?? ev.toolName,
          parentId: placement.ownerToolUseId,
        });
      }
    }

    // サブエージェント起動: 通常のツール行ではなくエージェントカードを作る。
    // どれがサブエージェント起動かは reducer の判定（agents に載るか）に従う
    if (ev.work.agents?.some((agent) => agent.toolUseId === ev.toolUseId)) {
      this.flushDelta();
      const card = this.createAgentCard(ev);
      if (isHistory) card.classList.add("replayed");
      this.placeWork(card, placement, `🤖 ${toolSummary(ev)}`);
      this.renderAgentMeta(ev.toolUseId);
      // 帯とパネルは配置が決まってから描く（現在のカードを映すため）
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
    // tool_call_finished は work を伴わないことがあり、その経路では applyWork 経由の
    // 再描画が起きない。委任が閉じた（開いた）ならここで引き直す（R-SES-02）
    if (activityChanged) this.updateStrip();
    // 集計・タスク状態はここで取り込む。記帳系の更新が成立するのは成功終了のときだけで、
    // 失敗していれば reducer が tasks を送ってこない＝表示も変わらない
    this.applyWork(ev.work);
    if (this.nonWorkToolUseIds.has(ev.toolUseId)) {
      this.nonWorkToolUseIds.delete(ev.toolUseId);
      this.toolStartTimes.delete(ev.toolUseId);
      return;
    }

    // 終端の DOM 反映は live / 過去 chunk の共通経路。行が無かった（＝開始が窓の外）ときは
    // 退避して、後から過去 chunk が同じ行を作ったときに当て直す（契約 C5）
    if (!this.applyToolFinishDom(ev)) this.rememberOrphanFinish(ev);
  }

  // 既存の行 / agent カードへ終端状態を反映する。反映先が無ければ false。
  private applyToolFinishDom(ev: Extract<NormalizedEvent, { kind: "tool_call_finished" }>): boolean {
    if (ev.backgroundTaskId !== undefined && !ev.isError) {
      this.bgTaskIdToToolUseId.set(ev.backgroundTaskId, ev.toolUseId);
    }
    if (ev.asyncLaunchedAgentId !== undefined && !ev.isError) {
      this.bgTaskIdToToolUseId.set(ev.asyncLaunchedAgentId, ev.toolUseId);
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
        agentEntry.statusEl.textContent = "";
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
      // ここで false を返すと ACK が退避されるので、退避済みの完了を上書きしない側は rememberOrphanFinish が持つ
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
          status.textContent = "🔄";
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
        agentEntry.statusEl.textContent = "🔄";
        return true;
      }
      return false;
    }

    const startedAt = this.toolStartTimes.get(ev.toolUseId);
    this.toolStartTimes.delete(ev.toolUseId);
    // ツール行1件の所要時間。カードやTODO行の合計は WorkModel 側の値を使う
    const elapsedMs = startedAt !== undefined ? ev.timestamp - startedAt : 0;

    // 行データも更新する
    const data = this.rowData.get(ev.toolUseId);
    if (data) {
      data.status = ev.isError ? "failed" : "done";
      data.statusGlyph = ev.isError ? TOOL_STATUS_GLYPH.failed : TOOL_STATUS_GLYPH.done;
      data.metaText = undefined;
      data.resultPreview = ev.resultPreview;
      if (data.kind === "tool" && startedAt !== undefined) data.elapsedLabel = formatDuration(elapsedMs);
    }

    // エージェントカード自身の確定: 報告ブロックだけを足す（状態・経過時間・tok・子件数は
    // applyWork / 過去 chunk は notePastWork が WorkModel の値で描く）
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
        const elapsedEl = document.createElement("span");
        elapsedEl.className = "tool-elapsed";
        elapsedEl.textContent = formatDuration(elapsedMs);
        rowSummary.appendChild(elapsedEl);
      }
    }
    // ツール失敗の独立赤ブロックは出さない（ツール行自体が赤くなり結果も行内に出るため冗長。
    // モデルの試行錯誤による失敗はClaude Code本体同様に控えめ表示とする）
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

  // 行が出来た直後に、保留していた更新を当て直す
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

  // サブエージェントの実測モデル（最初の sidechain assistant メッセージ由来）。
  // 宣言値チップ（frontmatter/入力）があっても実測値で置き換える（inherit や既定変更を正しく映す）
  private onSubagentInfo(ev: Extract<NormalizedEvent, { kind: "subagent_info" }>): void {
    // 実測モデルは reducer が agent へ持たせるので applyWork がチップを差し替える。
    // agent 記録が上限で退避されているとモデル側に無いため、その場合だけイベントから直接出す
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
      // addBlock は endAssistantTurn でコンテナを閉じるのでここでは使わない
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
    // バックグラウンドタブでも承認待ちが判別できるようタブ上に明示（レビューP2-9）
    this.tabBtn.classList.add("needs-approval");
    // 作業ログを見ている最中でも気づけるように、会話タブ側にも注意表示を出す
    this.flagConvAttention();
  }

  private onApprovalResolved(ev: Extract<NormalizedEvent, { kind: "approval_resolved" }>): void {
    // 未解決件数は WorkModel から来る（末尾の hasPendingApproval）。
    // カード本体は作った時に控えた参照で引く（DOM 検索は範囲を誤るとヘッダのミラーを掴む — レビューAR6-M1 / R1-F8）。
    this.applyWork(ev.work);
    const el = this.approvalCards.get(ev.requestId);
    if (el) {
      el.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
      // L-2: 自由入力欄（.askq-other）も操作不能にする
      el.querySelectorAll("input").forEach((i) => ((i as HTMLInputElement).disabled = true));
      el.classList.add(ev.behavior === "allow" ? "approved" : "denied");
      // 決着したカードは畳む。タイトル行に結果を出し、詳細は開けば読める状態で残す。
      const det = el.querySelector<HTMLDetailsElement>("details.approval-det");
      const titleEl = det?.querySelector<HTMLElement>("summary.approval-title");
      if (titleEl && !titleEl.querySelector(".approval-verdict")) {
        const verdict = document.createElement("span");
        verdict.className = `approval-verdict ${ev.behavior}`;
        verdict.textContent = ev.behavior === "allow" ? l10n.t("✔ Allowed") : l10n.t("✕ Denied");
        titleEl.appendChild(verdict);
      }
      if (det) det.open = false;
      // 作業ログ側の参照行にも結果を反映する（監査で会話へ戻らずに済む）
      const refRow = this.approvalRefs.get(ev.requestId);
      if (refRow && !refRow.classList.contains("resolved")) {
        refRow.classList.add("resolved", ev.behavior);
        refRow.textContent =
          (refRow.textContent?.replace(APPROVAL_REF_SUFFIX, "") ?? "") +
          (ev.behavior === "allow" ? l10n.t(" (Allowed)") : l10n.t(" (Denied)"));
      }
      // M-7: 回答の監査性。カード内に「回答: 質問→値」を textContent で追記する（replay でも再現）。
      // details の外に置くので、畳んだ状態でも何を答えたかが見える。
      // 判定チップ側と同条件の二重付与ガード（レビューAR3-L5: 再生で2回処理されうる）
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
      // 会話タブ側の注意表示も同条件で解除する（解除しないと応答不要になっても赤字＋●が残る。AR5-L2）
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
    // 送信の楽観的 running 中にエラーが返ったら idle へ復帰させる（codexレビューC2-6:
    // ensureConversation 失敗・連投ガード時に UI が running のまま固まる）。
    // ただし起動時の APIキー除去警告は送信失敗ではないので復帰させない（codexレビューC3-4）
    if (this.pendingSend && !ev.message.includes("ANTHROPIC_API_KEY")) {
      this.pendingSend = false;
      this.setTurnState("idle");
    }
  }

  private renderApproval(ev: Extract<NormalizedEvent, { kind: "approval_request" }>): void {
    const { requestId, toolName, rawInputJson, questions } = ev;
    this.endAssistantTurn();
    const div = document.createElement("div");
    div.className = "block approval";
    div.dataset.approval = requestId;
    div.id = youAnchor(this.tabId, `approval:${requestId}`);
    this.approvalCards.set(requestId, div);
    // カード全体を details にし、未解決の間は開いておく。解決したら閉じてタイトル行と
    // 回答要約だけを残す（回答済みカードがログを占有し続けないように）。
    const det = document.createElement("details");
    det.className = "approval-det";
    det.open = true;
    const title = document.createElement("summary");
    title.className = "approval-title";
    title.textContent = questions ? l10n.t("Question: {0}", toolName) : l10n.t("Approval request: {0}", toolName);

    const denyBtn = document.createElement("button");
    denyBtn.className = "danger";
    // L-7: 質問カード時のみ「回答しない」。通常の承認カードは従来通り「拒否」
    denyBtn.textContent = questions ? l10n.t("Don't answer") : l10n.t("Deny");
    denyBtn.onclick = () =>
      vscode.postMessage({ type: "approvalDecision", tabId: this.tabId, requestId, behavior: "deny" });

    if (questions && questions.questions.length > 0) {
      // AskUserQuestion（機能B）: 質問カードを描画する。生JSONは出さず質問文・選択肢のみ表示。
      // question文字列 -> 回答（選択labelまたは自由入力。multiSelectはカンマ区切り）
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
        // 解除は3箇所あるので、classList と aria-pressed の乖離を防ぐため必ずこの2関数を通す
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
        // N-4: ホスト側検証（isWebviewToHost）の値上限(10000文字)と整合させる
        otherInput.maxLength = 10_000;

        const commit = () => {
          // M-5: 単一選択（multiSelect=false）は選択肢と自由入力を排他にする。
          // answersには片方のみ入れる（両立させたい場合のannotations対応は今回スコープ外）。
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
              // M-5: 選択肢を選んだら自由入力を排他的にクリアする
              if (otherInput.value) otherInput.value = "";
            }
            commit();
          };
          optsEl.appendChild(btn);
        }
        card.appendChild(optsEl);
        otherInput.oninput = () => {
          // M-5: 単一選択で自由入力に文字があれば選択肢の選択を解除する（排他）
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
        // N-4: ホスト側検証（isWebviewToHost: キー数≤8・キー長≤2000・値長≤10000・空文字キー拒否）
        // と整合する事前整形を行い、不一致による approvalDecision の無言破棄を防ぐ。
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
      // 何を求められているかを人が読める形で先に示す（生JSONだけでは判断できない）。
      const body = buildApprovalBody(toolName, ev.inputJson, ev.inputSummary);
      // 原データ全文は残す（要約だけで許可させない）。textContent なので XSS 安全。
      // 既定は閉じておき、必要な時だけ開く（タイトル/説明/ボタンは常時見える）。
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
    // 会話側に操作可能な本体を置く（見落とさないため）。作業ログ側には監査用の参照行だけを
    // 置き、ボタンは複製しない（同じ承認が2箇所から解決できると二重送信になるため）。
    this.convEl.appendChild(div);
    this.workEl.appendChild(this.buildApprovalRefRow(ev));
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

  // ---------- 会話の過去 chunk（History Lazy Loading Phase 2） ----------

  // 会話面の履歴挿入点。引き継ぎカードの後、復元マーカーと会話本文の前。
  // 取り寄せた chunk は body の先頭へ積む
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

  // 会話に出せなかった件数の注記。body（取り寄せた chunk）より上に 1 つだけ置き、届くたびに文言を差し替える
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

  // いま会話面に出ている最古のメッセージの uuid。遡りの起点はこれで決める。
  // Host が resume 時点で控えた uuid を使うと、再接続で窓が切られて古い復元ブロックが
  // 落ちた分（原因A）が起点より新しくなり、**通知も出ずに欠落する**
  oldestConversationUuid(): string | undefined {
    const el = this.convEl.querySelector<HTMLElement>("[data-msg-uuid]");
    return el?.dataset.msgUuid;
  }

  // 作業ログの窓（REPLAY_MAX）で落ちた会話イベントを会話面へ prepend する（原因A）。
  // 供給元は Phase 1 と同じ Host の EventLog chunk で、**描く面だけが違う**。
  // transcript 由来の過去メッセージ（原因B）とは uuid 空間を共有するので重複しない。
  //
  // 復元マーカーより上へ入れてよい理由: 1スコープ＝1論理セッションで、その中の並びは
  // [history events][replayed_message×N][live events]。窓は先頭から落ちるので、
  // マーカーが DOM に在る＝窓に replayed_message が残っている＝落ちた前半に
  // ライブ会話は含まれない。よって復元分だけが上へ積まれる（すべて過去セッションの内容）。
  // addBlock を通さないのは Phase 2 と同じ理由（endAssistantTurn が走る）
  prependPastConvEvents(events: readonly NormalizedEvent[]): ConvEventPrependResult {
    const frag = document.createDocumentFragment();
    let rendered = 0;
    let duplicates = 0;
    let skipped = 0;
    let continued = 0;
    let failed = 0;
    const failures: string[] = [];
    // 本文デルタは turnId ごとに連結して1ブロックにする。chunk 境界を跨いだターンも
    // pastConvTurns で引き継いで1枚に統合する。統合しないと、物理 chunk 境界が行の途中に
    // 落ちたとき markdown の意味境界として現れる（見出しが「## 併せて見」と
    // 「つかった検査の盲点」へ割れる）
    const turns = new Map<string, { el: HTMLElement; text: string }>();
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
    for (const [turnId, turn] of turns) {
      // 初回の統合先は窓の先頭で描いた live セグメント（topConvSeg）。統合後は pastConvTurns が
      // 同じ el と全文を持つので、以後はそちらから引く
      const top = this.topConvSeg;
      const carried =
        this.pastConvTurns.get(turnId) ??
        (top !== null && top.turnId === turnId && top.el === turn.el ? top : undefined);
      const merged = carried !== undefined && carried.el === turn.el ? turn.text + carried.text : turn.text;
      this.youStore.retain(turnId, 0, Infinity, new Set());
      this.renderReplyMarkdown(turn.el, merged, turnId);
      this.pastConvTurns.set(turnId, { el: turn.el, text: merged });
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

  // 会話面に出る kind だけを描く。作業ログ側の白リスト（契約 C3）と鏡像の関係で、
  // どちらにも属さない kind はどちらの面にも出ない
  private renderPastConvEvent(
    ev: NormalizedEvent,
    frag: DocumentFragment,
    turns: Map<string, { el: HTMLElement; text: string }>
  ): "created" | "duplicate" | "continued" | "skipped" {
    this.observeYouEvent(ev);
    if (!isConvRenderableEvent(ev)) return "skipped";
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
      if (ev.role === "assistant") this.renderReplyMarkdown(div, ev.text, ev.uuid ?? `replay:${ev.generation}:${ev.seq}`, 0, ev.recordedAt ?? 0, ev.seq, ev.generation);
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
        existing.text += ev.text;
        // 2件目以降は同じブロックへ足すだけなので新しい行は作っていない
        return "continued";
      }
      // 前の chunk で作ったブロックが生きていれば、そこへ統合する（新しい行は作らない）。
      // el が外れているのは clearTab 後などで、その場合は作り直す
      const carried = this.pastConvTurns.get(ev.turnId);
      if (carried !== undefined && carried.el.isConnected) {
        turns.set(ev.turnId, { el: carried.el, text: ev.text });
        return "continued";
      }
      // 再生窓の切れ目で割れたターン。窓の先頭で描いた最上部のセグメントが同じ turnId なら、
      // 別ブロックを作らずそこへ統合する（R-CNV-09）。
      // 候補は確定済みのセグメントだけ（topConvSeg は endAssistantBlock でしか設定しない）。
      // 進行中のセグメントを候補にすると、増分描画の途中で描き直して進行中の応答が壊れる（R-CNV-08）
      const top = this.topConvSeg;
      if (top !== null && top.turnId === ev.turnId && top.el.isConnected) {
        turns.set(ev.turnId, { el: top.el, text: ev.text });
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
      turns.set(ev.turnId, { el: seg, text: ev.text });
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

  // 会話の過去 chunk を prepend する。**addBlock を通さない**: addBlock は target が conv の
  // とき endAssistantTurn() を呼ぶので、進行中の assistant ストリーミングが強制確定される
  // （契約 P4・ユーザー裁定）。streaming state・EventLog・semantic ingestion には触れない
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
        if (m.role === "assistant") this.renderReplyMarkdown(div, m.text, m.uuid, 0, m.timestamp ?? 0);
        else {
          div.textContent = m.text;
          this.youStore.reply(m.uuid, m.timestamp ?? 0);
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

  // ---------- 過去 chunk の再生（History Lazy Loading Phase 1） ----------

  // 履歴挿入点を置く。main.ts が再生ループの直後・overview.mount() より前に呼ぶことで、
  // 以後 workEl 先頭へ差し込まれる overview 4要素は必ずこれより上に入る（契約 C7）
  installHistoryHead(): HTMLElement {
    // 再生ループより後に呼ばれる契約（上のコメント）を、孤児採用の診断の live 判定にも使う
    this.replayDone = true;
    if (this.historyHeadEl !== null && this.historyHeadEl.isConnected) return this.historyHeadEl;
    // [head[more][body]] ...ログ本体... の順。取り寄せた chunk は body の先頭へ入れる。
    // 後から来る chunk ほど古いので、毎回 body の先頭へ入れれば時系列順に積み上がる。
    // more は遡りの失敗通知（addHistoryNotice）の置き場で、body より上に固定する
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

  // 履歴ブロックが実際に見えているか。作業ビューは既定が「概要」で、WorkOverview.applyMode が
  // workEl 直下の子を hidden にするため、詳細サブタブでないとボタンごと見えない。
  // 見えていないところへ prepend すると scrollHeight が動かず視界維持が成立しない（契約 C8）
  historyPaneUsable(): boolean {
    return this.historyHeadEl !== null && this.historyHeadEl.isConnected && !this.historyHeadEl.hidden;
  }

  // 遡りの失敗理由を1行だけ出す
  addHistoryNotice(text: string): HTMLElement {
    this.installHistoryHead();
    const div = document.createElement("div");
    div.className = "block system warn";
    div.textContent = text;
    this.historyMoreEl!.appendChild(div);
    return div;
  }

  // 再生済みイベントの識別子を登録する。addTab の窓ぶんもここを通す（契約 C4）
  noteRenderedEvents(events: readonly NormalizedEvent[]): void {
    for (const ev of events) this.renderedEventKeys.add(`${ev.generation}:${ev.seq}`);
  }

  // 過去 chunk を作業ログへ prepend する。会話面へは何も出さない（会話の過去は別経路）。
  // 戻り値は突合材料。破れていたら行がどこかで消えている（契約 C4b）:
  //   rendered + skipped + duplicates + failed == total
  //   connected == expectedConnected（= 累計 created。rendered ではない）
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
          outcome = this.renderPastEvent(ev);
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
    }
    this.installHistoryHead();
    const body = this.historyBodyEl!;
    body.insertBefore(ctx.frag, body.firstChild);
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

  // 白リスト（契約 C3）。created = 新しい行要素を作った / applied = 既存要素へ反映した /
  // skipped = 何もしなかった。created だけが接続済み DOM との突合対象になる
  private renderPastEvent(ev: NormalizedEvent): PastRenderOutcome {
    this.youStore.observe(ev);
    this.notePastWork(ev.work);
    switch (ev.kind) {
      case "turn_started":
        return this.renderPastTurnStart(ev);
      case "user_message":
        // 会話面へは描かない（会話の過去は別経路）。作業ログ側では区切りの見出しにだけ使う
        return this.notePastHumanHeadline(ev.text, ev.turnId) ? "applied" : "skipped";
      case "tool_call_started":
        return this.renderPastToolStarted(ev);
      case "tool_call_finished": {
        if (this.applyToolFinishDom(ev)) return "applied";
        // 開始行がまだ無い（この chunk より古い側にある）。退避して当て直せるようにする
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
    // anchor と chunk / first は 1 組なので、更新するときは 3 つとも同時に動かす
    if (!cliInserted) {
      this.pastPendingAnchor = headline === null ? anchor : null;
      this.pastPendingChunk = this.pastChunkSerial;
      this.pastPendingFirst = !this.pastChunkTurnSeen;
    }
    this.pastChunkTurnSeen = true;
    this.insertWork(this.pastRender!.frag, anchor);
    return "created";
  }

  // 配置情報を持たないイベント（契約 C6）。live が作業ログ末尾へ出すのと同じ見た目の行を
  // 履歴ブロック側へ置く。スクロール追従は動かさない
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
    // live 側に既にある行は作り直さない（契約 C4）
    if (this.rowData.has(ev.toolUseId)) return "skipped";
    const placement = ev.work?.placement;
    // 配置が無い＝reducer が記帳系として扱った。live も行を作らないので過去でも作らない
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
    // 窓の外で開始し窓の中で終わったツールは、live が finish を空振り消費している。
    // 行ができた今その終端を当て直さないと永久 running で固着する（契約 C5）
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

  // Token-based optimistic user bubble during hydration
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

  // rejected / accepted-nonhuman による楽観バブルの撤去
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

  // accepted-human による楽観バブルの確定標識
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
