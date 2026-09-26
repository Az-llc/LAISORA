// 履歴から再開: 🕘 の履歴パネル（一覧・検索・分析導線）。
import * as l10n from "@vscode/l10n";
import type { SessionListItem, SessionScanDegradation } from "../protocol";
import { sessionScanNote } from "../session-list";
import { histBtn, histListEl, histPanelEl, histSearchEl, isAnalysisPending, requestAnalysis, vscode } from "./dom";
import { activeTabId } from "./main";

let historySource: "laisora" | "claude" = "laisora";
let nextCursor: string | undefined;
let moreButton: HTMLButtonElement;
const sourceButtons = new Map<string, HTMLButtonElement>();
function requestHistory(append = false): void {
  sessionsPhase = "partial";
  vscode.postMessage({ type: "listSessions", source: historySource, cursor: append ? nextCursor : undefined });
  if (!append) { latestSessions = []; nextCursor = undefined; latestDegraded = undefined; }
  renderHistList(latestSessions);
}

let latestSessions: SessionListItem[] = [];
// 一覧は確定した行から逐次届くので、件数が未知（idle）／確認中（partial）／確定（complete）
// の 3 状態を区別する。partial を「答え」として扱うと、まだ届いていないだけの一覧を
// 0 件と断定してしまう（表示は導出根拠より強い主張をしない）。
// 応答は listSessions -> sessions（requestId + complete 付き）で届く
let sessionsPhase: "idle" | "partial" | "complete" = "idle";
// 受け取った中で最大の requestId。パネル再オープンでホストが新しい実行を始めるので、
// これより小さい requestId の行は古い実行のものとして捨てる
let sessionsRequestId = -1;
// 走査で読めなかったものがあるか。complete と別に持つのは、complete=false へ逃がすと
// 「読み込んでいます…」が消えず永久スピナーになるため（断言が別の嘘へ変わるだけ）
let latestDegraded: SessionScanDegradation | undefined;

function relativeTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return l10n.t("Just now");
  if (minutes < 60) return l10n.t("{0}m ago", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return l10n.t("{0}h ago", hours);
  const days = Math.floor(hours / 24);
  return l10n.t("{0}d ago", days);
}

function cwdTail(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

function closeHistPanel(): void {
  histPanelEl.classList.add("hidden");
  histBtn.setAttribute("aria-expanded", "false");
}

export function openHistPanel(): void {
  histSearchEl.value = "";
  // #topbar の overflow クリップを回避するため fixed でボタン直下に配置
  const r = histBtn.getBoundingClientRect();
  histPanelEl.style.top = `${r.bottom + 4}px`;
  histPanelEl.classList.remove("hidden");
  histBtn.setAttribute("aria-expanded", "true");
  historySource = "laisora";
  for (const [source, button] of sourceButtons) button.setAttribute("aria-pressed", String(source === historySource));
  requestHistory();
  histSearchEl.focus();
}

export function applySessionChunk(
  requestId: number,
  sessions: SessionListItem[],
  complete: boolean,
  degraded?: SessionScanDegradation,
  source?: "laisora" | "claude", cursor?: string, append = false
): void {
  if (source !== undefined && source !== historySource) return;
  if (requestId < sessionsRequestId) return;
  if (requestId > sessionsRequestId) {
    sessionsRequestId = requestId;
    if (!append) latestSessions = [];
    latestDegraded = undefined;
  }
  sessionsPhase = complete ? "complete" : "partial";
  latestDegraded = degraded;
  if (complete) nextCursor = cursor;
  renderHistList([...new Map(latestSessions.concat(sessions).map(row => [row.sessionId, row])).values()]);
}

export function renderHistList(sessions: SessionListItem[]): void {
  latestSessions = sessions;
  if (moreButton) {
    moreButton.hidden = nextCursor === undefined;
    moreButton.disabled = sessionsPhase !== "complete";
  }
  const query = histSearchEl.value.trim();
  const filtered = query ? sessions.filter((s) => s.title.includes(query)) : sessions;
  histListEl.textContent = "";
  // 注記は空分岐の外に置く。行があっても欠落は起こる（プロジェクト 1 個が読めない側の方が
  // 踏みやすい）ので、空のときだけ出すと踏みやすい方が素通りする（R-DSP-03）
  const note = sessionsPhase === "complete" ? sessionScanNote(latestDegraded) : undefined;
  if (note !== undefined) {
    const noteEl = document.createElement("div");
    noteEl.className = "hist-note";
    noteEl.setAttribute("role", "status");
    noteEl.textContent = `⚠ ${note}`;
    histListEl.appendChild(noteEl);
  }
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hist-empty";
    // 確認が終わるまでは 0 件も「一致なし」も名乗らない。まだ届いていない行が
    // 検索に一致するかは分からない。
    // 読めなかったものがあるときは「無い」と断言しない。読めなかったことと存在しないことは
    // 別で、走査が知っているのは前者だけ（R-DSP-01）
    empty.textContent =
      sessionsPhase !== "complete"
        ? l10n.t("Loading…")
        : note !== undefined
          ? sessions.length === 0
            ? l10n.t("No history could be read")
            : l10n.t("No matching sessions in the readable range")
          : sessions.length === 0
            ? l10n.t("No sessions found")
            : nextCursor ? l10n.t("No matching sessions in loaded history") : l10n.t("No matching sessions");
    histListEl.appendChild(empty);
    return;
  }
  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "hist-row";
    row.setAttribute("role", "menuitem");
    const title = document.createElement("div");
    title.className = "hist-title";
    title.textContent = s.title;
    const meta = document.createElement("div");
    meta.className = "hist-meta";
    meta.textContent = `${relativeTime(s.mtime)} · ${cwdTail(s.cwd)}`;
    const analyzeBtn = document.createElement("button");
    analyzeBtn.className = "hist-analyze";
    analyzeBtn.textContent = "📊";
    analyzeBtn.title = l10n.t("Analyze this session");
    analyzeBtn.setAttribute("aria-label", l10n.t("Analyze this session"));
    analyzeBtn.dataset.analysisTrigger = "true";
    analyzeBtn.disabled = isAnalysisPending();
    analyzeBtn.onclick = (e) => {
      e.stopPropagation();
      requestAnalysis(analyzeBtn, { type: "analyzeSession", sessionId: s.sessionId, filePath: s.filePath });
      closeHistPanel();
    };
    if (s.originUnverified) {
      const origin = document.createElement("div");
      origin.className = "hist-meta";
      origin.textContent = l10n.t("Earlier history (app not recorded)");
      row.append(title, meta, origin, analyzeBtn);
    } else row.append(title, meta, analyzeBtn);

    row.onclick = () => {
      // 表示中のタブが未使用なら、そこへ復元してタブを増やさない（判定はホスト側）
      vscode.postMessage({
        type: "resumeSession",
        sessionId: s.sessionId,
        filePath: s.filePath,
        intoTabId: activeTabId ?? undefined,
      });
      closeHistPanel();
    };
    histListEl.appendChild(row);
  }
  // 出ている行が全部だと誤読させない。確認が終わるまで印を残す
  if (sessionsPhase !== "complete") {
    const pending = document.createElement("div");
    pending.className = "hist-empty";
    pending.textContent = l10n.t("Checking the rest…");
    histListEl.appendChild(pending);
  }
}

// リスナ登録は main.ts 末尾の init 呼び出し列からのみ行う（登録順の権威はそこ1箇所）。
// この本体に「呼び出し時にモジュールレベルの let を読む文」を足さないこと（TDZ）。
export function initHistory(): void {
  const sources = document.createElement("div");
  sources.className = "hist-sources";
  for (const [source, label] of [["laisora", "LAISORA"], ["claude", "Claude Code"]] as const) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label;
    button.setAttribute("aria-pressed", String(source === historySource));
    button.onclick = () => {
      if (historySource === source) return;
      historySource = source;
      for (const [key, btn] of sourceButtons) btn.setAttribute("aria-pressed", String(key === source));
      requestHistory();
    };
    sourceButtons.set(source, button); sources.appendChild(button);
  }
  histPanelEl.insertBefore(sources, histSearchEl);
  moreButton = document.createElement("button");
  moreButton.type = "button"; moreButton.className = "hist-more";
  moreButton.textContent = l10n.t("Load more sessions"); moreButton.hidden = true;
  moreButton.onclick = () => requestHistory(true);
  histPanelEl.appendChild(moreButton);
  histBtn.onclick = (e) => {
    e.stopPropagation();
    if (histPanelEl.classList.contains("hidden")) openHistPanel();
    else closeHistPanel();
  };
  histSearchEl.addEventListener("input", () => renderHistList(latestSessions));
  histSearchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeHistPanel();
    }
  });
  document.addEventListener("click", (e) => {
    if (
      !histPanelEl.classList.contains("hidden") &&
      e.target !== histBtn &&
      !histPanelEl.contains(e.target as Node)
    ) {
      closeHistPanel();
    }
  });
}
