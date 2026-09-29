import type { DivergenceReport } from "./l3-divergence";
import type { SessionFacts } from "./session-facts";
import type { LearningFacts } from "./learning";
import type { ExecLogFindingView } from "./exec-log-marks";
import type { LlmFindingReportView } from "./protocol";
import * as l10n from "@vscode/l10n";

export interface SummaryAnalysisView {
  improvableCount: number | null;
  scriptFindingCount: number | null;
  scriptCandidateCount: number | null;
  scriptCandidatePercent: number | null;
  llmState: "current" | "not-run" | "stale";
  llmExecutionState: "idle" | "running" | "attemptFailed" | "disabled" | "attached";
  llmFindingCount: number | null;
  rejectedCount: number | null;
  generatedAtLabel?: string;
  llmAreas: { label: string; count: number; percent: number }[];
}

// R-DSP-50: projectSummaryAnalysis; src/session-semantic.ts#semanticModelPayload
export function projectSummaryAnalysis(
  findings: readonly ExecLogFindingView[] | undefined,
  report: LlmFindingReportView | undefined,
): SummaryAnalysisView {
  const attached = report && "attached" in report ? report.attached : undefined;
  const current = attached?.freshness === "current" ? attached : undefined;
  const scriptFindingCount = findings?.length ?? null;
  const scriptCandidateCount = findings?.filter(f => !!f.fixCandidate).length ?? null;
  const llmFindingCount = current?.findings.length ?? null;
  const counts = new Map<string, number>();
  for (const finding of current?.findings ?? []) {
    counts.set(finding.destinationLabel, (counts.get(finding.destinationLabel) ?? 0) + 1);
  }
  const max = Math.max(1, scriptCandidateCount ?? 0, ...counts.values());
  return {
    improvableCount: scriptCandidateCount === null ? null : scriptCandidateCount + (llmFindingCount ?? 0),
    scriptFindingCount,
    scriptCandidateCount,
    scriptCandidatePercent: scriptCandidateCount === null ? null : scriptCandidateCount / max * 100,
    llmExecutionState: report?.state ?? "idle",
    llmState: current ? "current" : attached ? "stale" : "not-run",
    llmFindingCount,
    rejectedCount: current?.rejectedCount ?? null,
    ...(current ? { generatedAtLabel: current.generatedAtLabel } : {}),
    llmAreas: [...counts].map(([label, count]) => ({ label, count, percent: count / max * 100 })),
  };
}

// Host 射影。整形はすべてここで確定し、webview は文字列を置くだけ
// （閾値・並べ替え・集約を持ち込まない）
export interface AnalysisFactsView {
  // LLM 分析の対象件数（ツール実行数）とその表示文言
  llmTargets: { toolCalls: number; label: string };
  coverageNote?: string;
  // empty: 全量を観測して件数がすべて 0。lines は「該当なし」の 1 行
  learning?: { state: "unobserved" | "observed"; note: string; lines: string[]; empty?: true };
}

const coverageNoteText = () => l10n.t("Not detected within the observed range");

function learningIsEmpty(learning: LearningFacts): boolean {
  return learning.delivered.outcome === "none" && learning.delivered.count === 0
    && learning.observations === 0 && learning.evidenced === 0 && learning.recurrences === 0
    && Object.values(learning.qualifications).every((n) => n === 0)
    && Object.values(learning.generalQualifications).every((n) => n === 0);
}

function projectLearningRANL20(learning: LearningFacts | undefined): NonNullable<AnalysisFactsView["learning"]> {
  if (learning === undefined || learning.coverage === "model-unknown") {
    const note = learning === undefined
      ? l10n.t("Disabled (the learning record is not loaded)")
      : l10n.t("Not matched yet (matched once this conversation's model is known)");
    return { state: "unobserved", note, lines: [] };
  }
  // R-LRN-09: 「該当なし」は全量を照合できたときだけ。セッション未確定は観測を結合していないので件数を並べる
  if (learning.coverage !== "session-unknown" && learningIsEmpty(learning)) {
    return { state: "observed", note: "", lines: [l10n.t("No matching records")], empty: true };
  }
  const delivered = learning.delivered;
  const hash = /^[a-f0-9]{64}$/.test(delivered.setHash) ? delivered.setHash.slice(0, 12) : l10n.t("None");
  const outcome = delivered.outcome === "sent" ? l10n.t("Sent")
    : delivered.outcome === "model-mismatch" ? l10n.t("Model mismatch")
      : delivered.outcome === "failed" ? l10n.t("Failed")
        : delivered.outcome === "withheld" ? l10n.t("Withheld") : l10n.t("None");
  const q = learning.qualifications;
  const general = learning.generalQualifications;
  const note = learning.coverage === "session-unknown"
    ? l10n.t("Observations and recurrences are not joined until the session ID is known.") : "";
  return { state: "observed", note, lines: [
    l10n.t("Delivered rules: {0} (set {1}) — {2}", delivered.count, hash, outcome),
    ...(learning.coverage === "observed" ? [l10n.t("Observations: {0} ({1} with evidence); recurrences: {2}", learning.observations, learning.evidenced, learning.recurrences)] : []),
    l10n.t("Qualifications for this model: active {0}, quarantined {1}, review due {2}, retired by human {3}, retired by conductor {4}, imported {5}, candidate {6}, rejected {7}",
      q.active, q.quarantined, q.reviewDue, q.retiredHuman, q.retiredConductor, q.imported, q.candidate, q.rejected),
    l10n.t("General qualifications: active {0}, retired by human {1}, candidate {2}, rejected {3}",
      general.active, general.retiredHuman, general.candidate, general.rejected),
  ] };
}

export function projectAnalysisFactsView(facts: SessionFacts, divergences: DivergenceReport, learning?: LearningFacts): AnalysisFactsView {
  const llmTargets = {
    toolCalls: facts.toolCalls,
    label: l10n.t("Analysis targets: {0} executions / {1} divergences", facts.toolCalls, divergences.recordCount),
  };

  // LLM 分析の入力被覆は llm-action-view の inputCoverageLabel が担う。ここでは出さない
  let coverageNote: string | undefined;
  if (facts.coverage.longGapsDropped > 0) {
    coverageNote = l10n.t("{0} ({1} stalled intervals were discarded at the limit)", coverageNoteText(), facts.coverage.longGapsDropped);
  }

  return {
    llmTargets,
    learning: projectLearningRANL20(learning),
    ...(coverageNote !== undefined ? { coverageNote } : {}),
  };
}
