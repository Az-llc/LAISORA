import type { SessionFacts } from "./session-facts";
import type { ExecLogFindingView } from "./exec-log-marks";
import * as l10n from "@vscode/l10n";

export interface SummaryAnalysisView {
  scriptFindingCount: number | null;
  scriptCandidateCount: number | null;
  scriptCandidatePercent: number | null;
}

export function projectSummaryAnalysis(findings: readonly ExecLogFindingView[] | undefined): SummaryAnalysisView {
  const scriptFindingCount = findings?.length ?? null;
  const scriptCandidateCount = findings?.filter(f => !!f.fixCandidate).length ?? null;
  return {
    scriptFindingCount,
    scriptCandidateCount,
    scriptCandidatePercent: scriptCandidateCount === null || scriptFindingCount === null ? null : scriptCandidateCount / Math.max(1, scriptFindingCount) * 100,
  };
}

export interface AnalysisFactsView {
  coverageNote?: string;
}

const coverageNoteText = () => l10n.t("Not detected within the observed range");

export function projectAnalysisFactsView(facts: SessionFacts): AnalysisFactsView {
  let coverageNote: string | undefined;
  if (facts.coverage.longGapsDropped > 0) {
    coverageNote = l10n.t("{0} ({1} stalled intervals were discarded at the limit)", coverageNoteText(), facts.coverage.longGapsDropped);
  }

  return coverageNote !== undefined ? { coverageNote } : {};
}
