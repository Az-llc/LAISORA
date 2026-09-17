import type { AnalysisConclusion, AnalysisEvidence, AnalysisFinding, AnalysisReport, SpanStat, ToolStat } from "../analysis";
import { vscode } from "./dom";
import { formatDateTime, formatDuration, formatTokenCount } from "./format";
import { termSpan } from "./term";
import * as l10n from "@vscode/l10n";

function table(headers: string[], rows: Array<Array<{ text: string; className?: string }>>, bars?: number[]): HTMLTableElement {
  const result = document.createElement("table"); const head = document.createElement("tr");
  for (const header of headers) { const cell = document.createElement("th"); cell.textContent = header; head.appendChild(cell); }
  result.appendChild(head); const max = Math.max(1, ...(bars ?? [1]));
  rows.forEach((cells, rowIndex) => { const row = document.createElement("tr"); cells.forEach((value, cellIndex) => {
    const cell = document.createElement("td"); cell.className = value.className ?? ""; cell.textContent = value.text;
    if (bars && cellIndex === cells.length - 1) { const bar = document.createElement("span"); bar.className = "bar"; bar.style.width = `${Math.max(2, Math.round((bars[rowIndex] / max) * 140))}px`; cell.textContent = ""; cell.appendChild(bar); }
    row.appendChild(cell);
  }); result.appendChild(row); }); return result;
}

function toolTable(tools: ToolStat[]): HTMLTableElement {
  return table([l10n.t("Tool"), l10n.t("Count"), l10n.t("Failures"), l10n.t("Total Time"), ""], tools.map((tool) => [
    { text: tool.tool }, { text: String(tool.count), className: "num" }, { text: String(tool.fails), className: tool.fails ? "num fail" : "num" }, { text: formatDuration(tool.elapsedMs), className: "num" }, { text: "" },
  ]), tools.map((tool) => tool.elapsedMs));
}

// 未計測だけ「—」、測れた 0 は 0（R-25 / R-DSP-11）
function spanAgentTokensText(span: SpanStat): string {
  if (span.agentTokensUnmeasured === "all") return "—";
  return span.agentTokensUnmeasured === "partial" ? l10n.t("{0} (partially not measured)", formatTokenCount(span.agentTokens)) : formatTokenCount(span.agentTokens);
}

function spanTable(spans: SpanStat[]): HTMLTableElement {
  return table([l10n.t("Name"), l10n.t("Duration"), l10n.t("Tool Count"), l10n.t("Failures"), l10n.t("Subagent Tokens")], spans.map((span) => [
    { text: span.name }, { text: formatDuration(span.elapsedMs), className: "num" }, { text: String(span.count), className: "num" }, { text: String(span.fails), className: span.fails ? "num fail" : "num" }, { text: spanAgentTokensText(span), className: "num" },
  ]));
}

function section(container: HTMLElement, text: string): void { const title = document.createElement("h2"); title.textContent = text; container.appendChild(title); }

function findingBlock(finding: AnalysisFinding): HTMLElement {
  const block = document.createElement("div"); block.className = finding.severity === "notice" ? "finding notice" : "finding";
  const title = document.createElement("b"); title.textContent = finding.title; const detail = document.createElement("div"); detail.textContent = finding.detail; block.append(title, detail);
  if (finding.at) { const at = document.createElement("div"); at.className = "act"; at.textContent = finding.at; block.appendChild(at); } return block;
}

// スクリプト側の証跡行。LLM への導線（LLMで深掘り）は置かない（R-ANL-14）
function evidenceItem(evidence: AnalysisEvidence, sessionId: string, filePath: string): HTMLElement {
  const item = document.createElement("li"); item.className = "analysis-evidence";
  const title = document.createElement("b"); title.textContent = evidence.title;
  const detail = document.createElement("div"); detail.textContent = evidence.detail;
  const location = document.createElement("div"); location.className = "analysis-location"; location.textContent = evidence.turn === undefined ? l10n.t("Entire session") : l10n.t("Turn {0} · {1}", evidence.turn, evidence.at ?? l10n.t("Time not observed"));
  const actions = document.createElement("div"); actions.className = "analysis-evidence-actions";
  const open = document.createElement("button"); open.type = "button"; open.className = "analysis-log-link"; open.textContent = l10n.t("Open session in log");
  open.onclick = () => vscode.postMessage({ type: "resumeSession", sessionId, filePath });
  actions.append(open); item.append(title, detail, location, actions); return item;
}

function conclusion(container: HTMLElement, data: AnalysisConclusion, sessionId: string, filePath: string, noneText: string): void {
  // 「要確認」のバッジと適用規則は出さない。母集団のせいでほぼ全セッションに点く（ツール 50 件以上で 99.5%）ため
  // 情報量が無い（R-DSP-10 / R-ANL-10）。「停止推奨」だけは連続失敗の実観測なので残す
  if (data.status === "stop") {
    section(container, l10n.t("Conclusion")); const summary = document.createElement("div"); summary.className = "analysis-conclusion";
    const badge = document.createElement("span"); badge.className = `analysis-badge ${data.status}`; badge.textContent = l10n.t("Stop Recommended");
    const rule = document.createElement("div"); rule.className = "analysis-applied-rule"; rule.textContent = data.appliedRule; summary.append(badge, rule); container.appendChild(summary);
    const criteria = document.createElement("details"); criteria.className = "analysis-criteria"; const criteriaSummary = document.createElement("summary"); criteriaSummary.textContent = l10n.t("Show criteria"); const criteriaList = document.createElement("ul");
    data.criteria.forEach((text) => { const item = document.createElement("li"); item.textContent = text; criteriaList.appendChild(item); }); criteria.append(criteriaSummary, criteriaList); container.appendChild(criteria);
  }
  section(container, l10n.t("Reasons and Evidence"));
  if (data.evidence.length) { const list = document.createElement("ol"); list.className = "analysis-evidence-list"; data.evidence.forEach((evidence) => list.appendChild(evidenceItem(evidence, sessionId, filePath))); container.appendChild(list); }
  else { const none = document.createElement("div"); none.className = "analysis-note"; none.textContent = noneText; container.appendChild(none); }
  section(container, l10n.t("Next Steps")); const actions = document.createElement("ol"); actions.className = "analysis-actions";
  data.actions.forEach((action) => { const item = document.createElement("li"); const evidence = action.evidenceId ? data.evidence.find((entry) => entry.id === action.evidenceId) : undefined;
    if (evidence) { const source = document.createElement("span"); source.className = "analysis-action-source"; source.textContent = l10n.t("Evidence: {0}", evidence.title); item.appendChild(source); }
    const text = document.createElement("div"); text.textContent = action.text; item.appendChild(text); actions.appendChild(item); }); container.appendChild(actions);
}

// {n} の穴に用語ノード（termSpan）を差し込む。文を丸ごと 1 キーにしたまま破線下線の注記を保つ（R-DSP-12）
function fillSlots(template: string, slots: Node[]): Node[] {
  const out: Node[] = [];
  template.split(/(\{\d+\})/).forEach((part) => {
    const slot = /^\{(\d+)\}$/.exec(part);
    if (slot) out.push(slots[Number(slot[1])]);
    else if (part) out.push(document.createTextNode(part));
  });
  return out;
}

function baselineLegend(report: AnalysisReport): HTMLElement | null {
  if (!report.baseline) return null;
  const labels: Array<[keyof typeof report.baseline.metricSampleCounts, string]> = [
    ["toolFailureRate", l10n.t("Failure rate (tool executions)")], ["failureLoopFrequency", l10n.t("Failure loop (3+ tools)")],
    ["agentTokenRatio", l10n.t("Subagent ratio")], ["turnDurationMs", l10n.t("Turn duration")], ["outputTokens", l10n.t("Output tokens")],
  ];
  const legend = document.createElement("div"); legend.className = "analysis-note";
  legend.append(...fillSlots(l10n.t("{0} legend: "), [termSpan("Baseline")]));
  labels.forEach(([key, label], i) => {
    if (i > 0) legend.appendChild(document.createTextNode(" / "));
    legend.append(...fillSlots(l10n.t("{0} {1}={2} · {3}={4}"), [
      document.createTextNode(label), termSpan("exposure n"), document.createTextNode(String(report.baseline!.metricSampleCounts[key] ?? 0)),
      termSpan("nonzero n"), document.createTextNode(String(report.baseline!.metricNonzeroSampleCounts[key] ?? 0)),
    ]));
  });
  legend.append(...fillSlots(l10n.t(". Per metric, if {0} or {1} is below 5, absolute thresholds are used."), [termSpan("exposure n"), termSpan("nonzero n")]));
  return legend;
}
// 読めなかった行があることを、判定と同じ画面に出す。判定そのものは格上げしない
// （観測していないシグナルを主張しないため）。注記が無いと、破損した記録が
// 「通常どおり」という肯定的な安全宣言になる（R-29。R-DSP-01 / R-DSP-03）
function appendCoverageNote(container: HTMLElement, report: AnalysisReport): void {
  const text = report.coverage?.note;
  if (!text) return;
  const note = document.createElement("div");
  note.className = "analysis-note analysis-coverage-warn";
  note.textContent = text;
  container.appendChild(note);
}

// 欠落があるときは「無い」と言い切らない。読めた範囲についてだけ述べる
function scopedNoneText(report: AnalysisReport, whole: string, scoped: string): string {
  return report.coverage?.note ? scoped : whole;
}

// 走査の失敗を「比較できるベースラインがない」と言い換えない（R-34）。文言は Host が
// baselineNote に組み立てて渡す。ここで baselineMode を見て分岐すると、読めなかった件数を
// 知らないまま否定を断言することになる
function appendBaselineNote(container: HTMLElement, report: AnalysisReport): void {
  const note = report.baselineNote;
  if (!note) return;
  const el = document.createElement("div"); el.className = "analysis-note analysis-baseline-note";
  el.textContent = note;
  container.appendChild(el);
}
export function renderAnalysisView(container: HTMLElement, sessionId: string, filePath: string, report: AnalysisReport): void {
  container.textContent = "";
  if (report.conclusion.status === "complete") {
    const quiet = document.createElement("div"); quiet.className = "analysis-quiet-complete";
    // 全量を読めていないときに「通常どおり」と名乗らない。読めた範囲の話だと明示する
    quiet.textContent = scopedNoneText(report, l10n.t("Completed — normal session"), l10n.t("Completed — normal in the part that could be read"));
    container.appendChild(quiet);
    appendCoverageNote(container, report);
    const completeLegend = baselineLegend(report); if (completeLegend) container.appendChild(completeLegend);
    appendBaselineNote(container, report);
    return;
  }
  const title = document.createElement("h1"); title.className = "analysis-h1"; title.textContent = l10n.t("Session Analysis");
  const sub = document.createElement("div"); sub.className = "analysis-sub"; sub.textContent = `${report.title} · ${formatDateTime(report.startedAt)} · ${report.model || "?"}`; container.append(title, sub);
  // 注記は結論より前。後ろに置くと、証拠と行動の一覧の下（多くの場合スクロールしないと
  // 見えない位置）へ押し出され、利用者は判定だけを見て信用する
  appendCoverageNote(container, report);
  conclusion(container, report.conclusion, sessionId, filePath, scopedNoneText(report, l10n.t("No review-required or stop-recommended signals."), l10n.t("No review-required or stop-recommended signals in the part that could be read.")));
  const legend = baselineLegend(report); if (legend) container.appendChild(legend);
  appendBaselineNote(container, report);
  const details = document.createElement("details"); details.className = "analysis-details"; const detailsSummary = document.createElement("summary"); detailsSummary.textContent = l10n.t("Details (stats, tool breakdown, findings)"); details.appendChild(detailsSummary);
  const statrow = document.createElement("div"); statrow.className = "statrow"; const addStat = (value: string, label: string, warn = false) => { const stat = document.createElement("div"); stat.className = warn ? "stat warn" : "stat"; const v = document.createElement("div"); v.className = "v"; v.textContent = value; const l = document.createElement("div"); l.className = "l"; l.textContent = label; stat.append(v, l); statrow.appendChild(stat); };
  addStat(formatDuration(report.totalElapsedMs), l10n.t("Total time (wall clock)")); addStat(formatDuration(report.activeMs), l10n.t("Active")); addStat(l10n.t("{0} times / {1}", report.idleGapCount, formatDuration(report.idleMs)), l10n.t("Idle")); addStat(String(report.toolCalls), l10n.t("Tool Executions")); addStat(String(report.toolFails), l10n.t("Failures"), report.toolFails > 0); addStat(formatTokenCount(report.outputTokens), l10n.t("Output tokens")); addStat(`🤖 ${report.agentCount} / ${report.agentTokensUnmeasured === "all" ? "—" : formatTokenCount(report.agentTokens)}`, report.agentTokensNote ? l10n.t("Subagents / tokens ({0})", report.agentTokensNote) : l10n.t("Subagents / tokens")); details.appendChild(statrow);
  section(details, l10n.t("Findings")); if (!report.findings.length) { const none = document.createElement("div"); none.className = "analysis-note"; none.textContent = scopedNoneText(report, l10n.t("No findings."), l10n.t("No findings in the part that could be read.")); details.appendChild(none); } else report.findings.forEach((finding) => details.appendChild(findingBlock(finding)));
  section(details, l10n.t("Tool Breakdown")); details.appendChild(toolTable(report.tools)); if (report.skills.length) { section(details, l10n.t("Skill Breakdown")); details.appendChild(spanTable(report.skills)); }
  container.appendChild(details);
}
