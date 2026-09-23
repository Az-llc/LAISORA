// 既存要素の取得（getElementById）と VS Code API ハンドルの唯一の入口。
// createElement / addEventListener 等は各モジュールに残る。この入口が守るのは取得の評価順だけ。
// テンプレート書き込みは init 関数に包まない: 値 import された時点で必ず走ることが、
// 「要素取得はテンプレートより後」を規律ではなくモジュールグラフで保証する仕組みそのもの。
// この保証は本モジュールの値 import が、import もトップレベルの DOM 参照も持たない葉（@vscode/l10n・./loader）
// だけであることに依存する（それ以外の import を足すな）。
import * as l10n from "@vscode/l10n";
import { createLoader } from "./loader";
import type { WebviewToHost } from "../protocol";

type VsCodeWebviewApi = {
  postMessage(msg: WebviewToHost): void;
  getState():
    | { activeTabId: string | null; drafts?: Record<string, string>; askChecks?: Record<string, Record<string, boolean[]>>; views?: Record<string, "conv" | "work">; analysisViews?: Record<string, "script" | "ai">; workViews?: Record<string, "summary" | "graph" | "analysis" | "log"> }
    | undefined;
  setState(s: {
    activeTabId: string | null;
    drafts?: Record<string, string>; askChecks?: Record<string, Record<string, boolean[]>>;
    views?: Record<string, "conv" | "work">;
    analysisViews?: Record<string, "script" | "ai">;
    workViews?: Record<string, "summary" | "graph" | "analysis" | "log">;
  }): void;
};

declare function acquireVsCodeApi(): VsCodeWebviewApi;

declare global {
  interface Window {
    // dom.ts が acquireVsCodeApi() を唯一1度だけ呼ぶ。先行 bootstrap は取得済みの場合だけ参照する。
    __laisoraVscodeApi?: VsCodeWebviewApi;
    __laisoraBootstrap?: { complete(): void };
  }
}

export const vscode = acquireVsCodeApi();
window.__laisoraVscodeApi = vscode;

const app = document.getElementById("app")!;
// 静的な骨組みのみ。${} に入れてよいのは l10n.t(リテラル) だけ — 翻訳バンドルは拡張同梱で信頼境界内。
// 実行時の動的値（セッション名・出力・設定値）を混ぜた瞬間に XSS になる（動的テキストは textContent 経由）。
app.innerHTML = `
  <header id="topbar">
    <nav id="tabbar" role="tablist" aria-label="${l10n.t("Conversation tabs")}"></nav>
    <button hidden id="exportbtn" title="${l10n.t("Export conversation to Markdown")}" aria-label="${l10n.t("Export conversation to Markdown")}">↧</button>
    <button id="histbtn" title="${l10n.t("Resume from history")}" aria-label="${l10n.t("Resume from history")}" aria-haspopup="menu" aria-expanded="false">🕘</button>
    <button hidden id="handoffbtn" title="${l10n.t("Hand off to a new conversation (keeps the original conversation and copies the summary and messages)")}" aria-label="${l10n.t("Hand off to a new conversation")}">⇉</button>
    <button id="newtab" title="${l10n.t("New conversation")}" aria-label="${l10n.t("New conversation")}">＋</button>
    <div id="session-actions-slot"></div>
    <div id="histpanel" class="hist-panel hidden" role="menu">
      <input id="histsearch" type="text" placeholder="${l10n.t("Search by title")}" />
      <div id="histlist"></div>
    </div>
  </header>
  <div id="findbar" class="find-bar hidden" role="search">
    <input id="findinput" type="text" placeholder="${l10n.t("Search")}" />
    <span id="findcount" class="find-count">0 / 0</span>
    <button id="findprev" class="find-btn" type="button" title="${l10n.t("Previous (Shift+F3)")}" aria-label="${l10n.t("Previous (Shift+F3)")}">↑</button>
    <button id="findnext" class="find-btn" type="button" title="${l10n.t("Next (F3 / Enter)")}" aria-label="${l10n.t("Next (F3 / Enter)")}">↓</button>
    <button id="findclose" class="find-btn" type="button" title="${l10n.t("Close (Esc)")}" aria-label="${l10n.t("Close (Esc)")}">×</button>
  </div>
  <main id="logs" aria-live="polite"></main>
  <footer id="composer">
    <div id="composer-top">
      <div id="attachments"></div>
      <div id="ctxchip" class="ctx-chip hidden"></div>
    </div>
    <div id="inputwrap">
      <textarea id="input" rows="1"></textarea>
      <div id="composer-actions">
        <div id="composer-actions-left">
          <button id="attach" class="icon ghost" title="${l10n.t("Choose a file")}" aria-label="${l10n.t("Choose a file")}">＋</button>
          <button id="auth" class="chip" type="button" aria-haspopup="menu" aria-expanded="false">${l10n.t("Auth: unverified")}</button>
          <button id="usage" class="chip" type="button" aria-haspopup="menu" aria-expanded="false"></button>
        </div>
        <div id="composer-actions-right">
          <button id="convprev" class="headbtn" type="button" title="${l10n.t("Go to your previous message")}" aria-label="${l10n.t("Go to your previous message")}">↑</button>
          <button id="convnext" class="headbtn" type="button" title="${l10n.t("Jump to latest")}" aria-label="${l10n.t("Jump to latest")}">↓</button>
          <button id="modebtn" class="mode-chip" title="${l10n.t("Permission mode")}" aria-label="${l10n.t("Permission mode")}" aria-haspopup="menu" aria-expanded="false">default</button>
          <button id="action" class="icon" title="${l10n.t("Send (Enter)")}" aria-label="${l10n.t("Send")}">➤</button>
        </div>
      </div>
      <div id="suggest" class="suggest-menu hidden" role="listbox"></div>
      <div id="modemenu" class="mode-menu hidden" role="menu" tabindex="-1" aria-label="${l10n.t("Permission mode")}"></div>
      <div id="authpicker" class="auth-picker hidden" role="menu" tabindex="-1" aria-label="${l10n.t("Model and effort")}"></div>
      <div id="authsubmenu" class="auth-picker auth-submenu hidden" role="menu" tabindex="-1" aria-label="${l10n.t("Model list")}"></div>
      <div id="usagepanel" class="auth-picker hidden" role="menu"></div>
    </div>
  </footer>
`;

export const tabbarEl = document.getElementById("tabbar")!;
export const logsEl = document.getElementById("logs")!;
export const inputEl = document.getElementById("input") as HTMLTextAreaElement;
export const actionBtn = document.getElementById("action") as HTMLButtonElement;
export const authEl = document.getElementById("auth") as HTMLButtonElement;
export const authPickerEl = document.getElementById("authpicker") as HTMLDivElement;
export const authSubmenuEl = document.getElementById("authsubmenu") as HTMLDivElement;
export const usageEl = document.getElementById("usage")!;
export const INPUT_PLACEHOLDER = l10n.t("Type a message (Enter to send / Shift+Enter for a new line)");
export const FIND_PLACEHOLDER = l10n.t("Search");
export const CONTEXT_CHIP_EMPTY = l10n.t("ctx not fetched");
inputEl.placeholder = INPUT_PLACEHOLDER;
usageEl.textContent = CONTEXT_CHIP_EMPTY;
export const newTabBtn = document.getElementById("newtab") as HTMLButtonElement;
export const exportBtn = document.getElementById("exportbtn") as HTMLButtonElement;
export const attachBtn = document.getElementById("attach") as HTMLButtonElement;
export const convPrevBtn = document.getElementById("convprev") as HTMLButtonElement;
export const convNextBtn = document.getElementById("convnext") as HTMLButtonElement;
export const modeBtn = document.getElementById("modebtn") as HTMLButtonElement;
export const modeMenuEl = document.getElementById("modemenu") as HTMLDivElement;
export const suggestEl = document.getElementById("suggest") as HTMLDivElement;
export const histBtn = document.getElementById("histbtn") as HTMLButtonElement;
export const handoffBtn = document.getElementById("handoffbtn") as HTMLButtonElement;
export const histPanelEl = document.getElementById("histpanel") as HTMLDivElement;
export const histSearchEl = document.getElementById("histsearch") as HTMLInputElement;
export const histListEl = document.getElementById("histlist") as HTMLDivElement;
export const ctxChipEl = document.getElementById("ctxchip") as HTMLDivElement;
export const usagePanelEl = document.getElementById("usagepanel") as HTMLDivElement;
export const attachmentsEl = document.getElementById("attachments")!;
export const findBarEl = document.getElementById("findbar") as HTMLDivElement;
export const findInputEl = document.getElementById("findinput") as HTMLInputElement;
export const findCountEl = document.getElementById("findcount") as HTMLSpanElement;
export const findPrevBtn = document.getElementById("findprev") as HTMLButtonElement;
export const findNextBtn = document.getElementById("findnext") as HTMLButtonElement;
export const findCloseBtn = document.getElementById("findclose") as HTMLButtonElement;
findInputEl.placeholder = FIND_PLACEHOLDER;

// テンプレートに置かず生成するのは、dom.ts が値 import を持たない葉であることで保証している
// 「要素取得はテンプレートより後」の規律に、新しい getElementById を足さないため
const analysisBusyEl = document.createElement("div");
analysisBusyEl.id = "analysis-busy";
analysisBusyEl.setAttribute("role", "status");
const analysisBusySpinner = document.createElement("span");
analysisBusySpinner.className = "analysis-busy-spinner";
analysisBusySpinner.append(createLoader());
const analysisBusyLabel = document.createElement("span");
analysisBusyLabel.textContent = l10n.t("Analyzing…");
analysisBusyEl.append(analysisBusySpinner, analysisBusyLabel);
app.appendChild(analysisBusyEl);

type AnalysisRequest = Extract<WebviewToHost, { type: "analyzeSession" | "analyzeCurrent" }>;

// analysisFailed が届かない経路が残っても永久に無効化されないための保険
const ANALYSIS_PENDING_TIMEOUT_MS = 30_000;
let analysisPendingTimer: ReturnType<typeof setTimeout> | undefined;
let analysisPendingButton: HTMLButtonElement | null = null;

function setAnalysisPending(pending: boolean, button: HTMLButtonElement | null): void {
  if (analysisPendingTimer !== undefined) { clearTimeout(analysisPendingTimer); analysisPendingTimer = undefined; }
  analysisPendingButton?.classList.remove("is-analysis-pending");
  analysisPendingButton?.querySelector(".loader")?.remove();
  analysisPendingButton?.removeAttribute("aria-busy");
  analysisPendingButton = button;
  analysisBusyEl.classList.toggle("on", pending);
  document.querySelectorAll<HTMLButtonElement>("[data-analysis-trigger]").forEach((el) => { el.disabled = pending; });
  if (!pending) return;
  button?.classList.add("is-analysis-pending");
  button?.append(createLoader(12));
  button?.setAttribute("aria-busy", "true");
  analysisPendingTimer = setTimeout(() => setAnalysisPending(false, null), ANALYSIS_PENDING_TIMEOUT_MS);
}

export function requestAnalysis(button: HTMLButtonElement, message: AnalysisRequest): void {
  if (analysisPendingButton !== null) return;
  setAnalysisPending(true, button);
  vscode.postMessage(message);
}

export function isAnalysisPending(): boolean {
  return analysisPendingButton !== null;
}

export function finishAnalysisRequest(): void {
  setAnalysisPending(false, null);
}

export const sessionActionsEl = document.getElementById("session-actions-slot") as HTMLElement;
