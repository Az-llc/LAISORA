import type { DivergenceReport } from "./l3-divergence";
import type { SessionFacts } from "./session-facts";
import type { LearningFacts } from "./learning";
import * as l10n from "@vscode/l10n";

// Host 射影。整形はすべてここで確定し、webview は文字列を置くだけ
// （閾値・並べ替え・集約を持ち込まない）
export interface AnalysisFactsView {
  // LLM 分析の対象件数（ツール実行数）とその表示文言
  llmTargets: { toolCalls: number; label: string };
  coverageNote?: string;
  learning?: { state: "unobserved" | "observed"; note: string; lines: string[] };
}

const coverageNoteText = () => l10n.t("Not detected within the observed range");

function projectLearningRANL20(learning: LearningFacts | undefined): NonNullable<AnalysisFactsView["learning"]> {
  if (learning === undefined || learning.coverage === "model-unknown") {
    const note = learning === undefined
      ? l10n.t("Learning was not observed for this conversation (disabled or not loaded).")
      : l10n.t("Learning was not observed for this conversation (model unknown).");
    return { state: "unobserved", note, lines: [] };
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

  // LLM 分析の入力被覆は llm-action-view の inputCoverageLabel が担う（R-52）。ここでは出さない
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
