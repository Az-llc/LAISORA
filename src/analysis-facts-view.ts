import type { DivergenceReport } from "./l3-divergence";
import type { SessionFacts } from "./session-facts";
import * as l10n from "@vscode/l10n";

// Host 射影。整形はすべてここで確定し、webview は文字列を置くだけ
// （閾値・並べ替え・集約を持ち込まない）
export interface AnalysisFactsView {
  // LLM 分析の対象件数（ツール実行数）とその表示文言
  llmTargets: { toolCalls: number; label: string };
  coverageNote?: string;
}

const coverageNoteText = () => l10n.t("Not detected within the observed range");

export function projectAnalysisFactsView(facts: SessionFacts, divergences: DivergenceReport): AnalysisFactsView {
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
    ...(coverageNote !== undefined ? { coverageNote } : {}),
  };
}
