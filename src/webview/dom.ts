import * as l10n from "@vscode/l10n";
import type { WebviewToHost } from "../protocol";

type VsCodeWebviewApi = {
  postMessage(msg: WebviewToHost): void;
  getState():
    | { activeTabId: string | null; drafts?: Record<string, string>; askChecks?: Record<string, Record<string, boolean[]>>; askDismissed?: Record<string, string[]>; askDismissedMessages?: string[]; askResolved?: Record<string, string[]>; askResolvedMessages?: string[]; askCheckedMessages?: Record<string, boolean[]>; views?: Record<string, "conv" | "work">; analysisViews?: Record<string, "script" | "ai">; workViews?: Record<string, "summary" | "graph" | "analysis" | "log"> }
    | undefined;
  setState(s: {
    activeTabId: string | null;
    drafts?: Record<string, string>; askChecks?: Record<string, Record<string, boolean[]>>; askDismissed?: Record<string, string[]>; askDismissedMessages?: string[]; askResolved?: Record<string, string[]>; askResolvedMessages?: string[]; askCheckedMessages?: Record<string, boolean[]>;
    views?: Record<string, "conv" | "work">;
    analysisViews?: Record<string, "script" | "ai">;
    workViews?: Record<string, "summary" | "graph" | "analysis" | "log">;
  }): void;
};

declare function acquireVsCodeApi(): VsCodeWebviewApi;

declare global {
  interface Window {
    __laisoraVscodeApi?: VsCodeWebviewApi;
    __laisoraBootstrap?: { complete(): void };
  }
}

export const vscode = acquireVsCodeApi();
window.__laisoraVscodeApi = vscode;

const app = document.getElementById("app")!;
app.innerHTML = `
  <header id="topbar">
    <nav id="tabbar" role="tablist" aria-label="${l10n.t("Conversation tabs")}"></nav>
    <button hidden id="exportbtn" title="${l10n.t("Export conversation to Markdown")}" aria-label="${l10n.t("Export conversation to Markdown")}">↧</button>
    <button id="histbtn" type="button" title="${l10n.t("Resume from history")}" aria-label="${l10n.t("Resume from history")}" aria-haspopup="dialog" aria-expanded="false" aria-controls="histpanel"><span class="l-icon l-icon-history" aria-hidden="true"></span></button>
    <button hidden id="handoffbtn" title="${l10n.t("Hand off to a new conversation (keeps the original conversation and copies the summary and messages)")}" aria-label="${l10n.t("Hand off to a new conversation")}">⇉</button>
    <button id="newtab" title="${l10n.t("New conversation")}" aria-label="${l10n.t("New conversation")}">＋</button>
    <div id="session-actions-slot"></div>
    <div id="histpanel" class="hist-panel hidden" role="dialog" aria-label="${l10n.t("Resume from history")}">
      <header class="hist-head">
        <div class="hist-head-line">
          <span class="hist-code"><b>HISTORY</b><span>${l10n.t("Resume from history")}</span></span>
          <span id="histcount" class="hist-count" aria-live="polite"></span>
        </div>
        <div id="histtools" class="hist-tools">
          <div class="hist-search">
            <span class="l-icon l-icon-search" aria-hidden="true"></span>
            <input id="histsearch" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="histlist" autocomplete="off" spellcheck="false" placeholder="${l10n.t("Search by title")}" aria-label="${l10n.t("Search by title")}" />
            <button id="histclear" class="hist-clear" type="button" title="${l10n.t("Clear search")}" aria-label="${l10n.t("Clear search")}" hidden>×</button>
          </div>
        </div>
      </header>
      <div id="histnote"></div>
      <div id="histlist" class="hist-list" role="listbox" aria-label="${l10n.t("Sessions")}" tabindex="0"></div>
      <div id="histnotice" class="hist-notice" role="status" hidden></div>
      <footer id="histfoot" class="hist-foot">
        <span id="histprogress" class="hist-progress" role="status"></span>
        <span class="hist-keys" aria-hidden="true"><span><kbd>↑↓</kbd>${l10n.t("Select")}</span><span><kbd>Enter</kbd>${l10n.t("Open")}</span><span><kbd>F2</kbd>${l10n.t("Rename session")}</span><span><kbd>Del</kbd>${l10n.t("Remove from the list")}</span><span><kbd>Esc</kbd>${l10n.t("Close")}</span></span>
      </footer>
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
export const histCountEl = document.getElementById("histcount") as HTMLSpanElement;
export const histToolsEl = document.getElementById("histtools") as HTMLDivElement;
export const histClearBtn = document.getElementById("histclear") as HTMLButtonElement;
export const histNoteEl = document.getElementById("histnote") as HTMLDivElement;
export const histNoticeEl = document.getElementById("histnotice") as HTMLDivElement;
export const histFootEl = document.getElementById("histfoot") as HTMLElement;
export const histProgressEl = document.getElementById("histprogress") as HTMLSpanElement;
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

export const sessionActionsEl = document.getElementById("session-actions-slot") as HTMLElement;
