import type { AnalysisFactsView } from "../analysis-facts-view";
import type { L3ReportPayload, LlmFindingReportView } from "../protocol";
import { renderLlmActionView } from "./llm-action-view";
import { vscode } from "./dom";
import * as l10n from "@vscode/l10n";

function makeEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function llmRunControl(
  tabId: string,
  view: LlmFindingReportView | undefined,
  llmAnalysisEnabled: boolean | undefined,
  turnRunning: boolean,
  llmRunning: boolean,
  // undefined = facts 未生成の状態（実行入口は残し、押せない理由を注記する — R-ANL-11）
  llmTargets: AnalysisFactsView["llmTargets"] | undefined
): HTMLElement {
  const box = makeEl("div", "llm-run");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "llm-run-btn";
  btn.textContent = l10n.t("Run LLM Analysis");
  // 注記は tooltip だけにしない（disabled なボタンの title はキーボード利用者へ届かない）
  let note = l10n.t("Running consumes tokens");
  if (llmRunning) {
    box.dataset.runState = "in-flight";
    btn.disabled = true;
    btn.textContent = l10n.t("Analyzing…");
    btn.title = l10n.t("Running LLM analysis");
  } else if (llmAnalysisEnabled === false || view?.state === "disabled") {
    box.dataset.runState = "disabled";
    btn.disabled = true;
    btn.title = l10n.t("The setting laisora.workLog.llmAnalysis is disabled");
  } else if (llmTargets === undefined) {
    box.dataset.runState = "no-facts";
    btn.disabled = true;
    btn.title = l10n.t("Cannot run yet because facts have not been generated");
    note = l10n.t("Cannot run yet because facts have not been generated (available once the record is derived)");
  } else if (view?.state === "attached" && view.attached.freshness === "current") {
    box.dataset.runState = "completed";
    btn.disabled = true;
    btn.title = l10n.t("Already run for this record (can run again as work progresses)");
    note = l10n.t("Already run for this record (can run again as work progresses)");
  } else if (turnRunning) {
    box.dataset.runState = "running";
    btn.disabled = true;
    btn.title = l10n.t("Cannot start while a turn is running (available after the turn completes)");
  } else {
    box.dataset.runState = "ready";
  }
  btn.onclick = () => {
    vscode.postMessage({ type: "llmAnalysisRequest", tabId });
    // 押した瞬間に実行中表現へ切り替える（Host の llmAnalysisRunState を待つと、届くまで
    // 押せたのか分からない）。復帰は Host の状態通知（実行 finally / 拒否時の running:false）による再描画
    box.dataset.runState = "in-flight";
    btn.disabled = true;
    btn.textContent = l10n.t("Analyzing…");
    btn.title = l10n.t("Running LLM analysis");
  };
  box.appendChild(btn);
  box.appendChild(makeEl("span", "llm-run-note", note));
  return box;
}

export function renderAnalysisFactsView(
  container: HTMLElement,
  payload: L3ReportPayload | undefined,
  tabId: string,
  llmAnalysisEnabled?: boolean,
  turnRunning = false,
  llmRunning = false,
  evidenceNavigation?: { has(toolUseId: string): boolean; navigate(toolUseId: string): void },
  llmContainer: HTMLElement = container
): void {
  container.textContent = "";
  if (llmContainer !== container) llmContainer.textContent = "";
  if (payload === undefined || payload.facts === undefined) {
    container.dataset.facts = "absent";
    // facts が無い状態（分析設定の明示off・初回導出前・facts 導出失敗）でも「LLM 分析を実行」の
    // 入口は消さない（R-ANL-11: 実行入口は全状態で 1 つ存在する）。押せない理由は注記で出す。
    // view は渡さない（LLM 面の読み出しは 1 箇所の規律 — check-protocol-guards S5-T2-D4）
    const llmSection = makeEl("div", "af-llm-section");
    const entry = makeEl("div", "llm-entry");
    entry.appendChild(
      llmRunControl(tabId, undefined, llmAnalysisEnabled, turnRunning, llmRunning, undefined)
    );
    llmSection.appendChild(entry);
    llmContainer.appendChild(llmSection);
    return;
  }

  container.dataset.facts = "present";
  const facts = payload.facts;
  const llm = payload.llm;

  if (facts.coverageNote) {
    const covEl = makeEl("div", "af-coverage-note", facts.coverageNote);
    container.appendChild(covEl);
  }

  if (facts.learning) {
    const learning = makeEl("section", "af-learning wa-fsec");
    learning.dataset.state = facts.learning.state;
    if (facts.learning.empty === true) learning.dataset.empty = "true";
    const head = makeEl("div", "wa-code");
    head.id = `af-learning-h-${tabId}`;
    head.append(makeEl("b", undefined, "LEARN"), makeEl("span", "wa-code-s", l10n.t("Learning record")));
    learning.setAttribute("aria-labelledby", head.id);
    learning.appendChild(head);
    if (facts.learning.note) learning.appendChild(makeEl("div", "af-learning-note", facts.learning.note));
    for (const line of facts.learning.lines) learning.appendChild(makeEl("div", "af-learning-line", line));
    container.appendChild(learning);
  }

  // LLM 分析への導線（実行ボタン・所見）は LLM 側の区画にまとめる。スクリプト由来の値と同じ平坦な親に置かない（R-ANL-14）
  const llmSection = makeEl("div", "af-llm-section");
  const entry = makeEl("div", "llm-entry");
  entry.appendChild(
    llmRunControl(
      tabId,
      llm,
      llmAnalysisEnabled,
      turnRunning,
      llmRunning,
      facts.llmTargets
    )
  );
  llmSection.appendChild(entry);
  const llmBox = makeEl("div", "llm-findings");
  llmSection.appendChild(llmBox);
  llmContainer.appendChild(llmSection);
  renderLlmActionView(llmBox, llm, llmAnalysisEnabled, tabId, payload.analysis.semanticHash, evidenceNavigation, {
    row: entry,
    targets: facts.llmTargets,
  });
}
