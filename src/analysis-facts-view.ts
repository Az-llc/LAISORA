import type { DivergenceReport } from "./l3-divergence";
import type { SessionFacts } from "./session-facts";
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

export interface AnalysisFactsView {
  llmTargets: { toolCalls: number; label: string };
  coverageNote?: string;
}

const coverageNoteText = () => l10n.t("Not detected within the observed range");

export function projectAnalysisFactsView(facts: SessionFacts, divergences: DivergenceReport): AnalysisFactsView {
  const llmTargets = {
    toolCalls: facts.toolCalls,
    label: l10n.t("Analysis targets: {0} executions / {1} divergences", facts.toolCalls, divergences.recordCount),
  };

  let coverageNote: string | undefined;
  if (facts.coverage.longGapsDropped > 0) {
    coverageNote = l10n.t("{0} ({1} stalled intervals were discarded at the limit)", coverageNoteText(), facts.coverage.longGapsDropped);
  }

  return {
    llmTargets,
    ...(coverageNote !== undefined ? { coverageNote } : {}),
  };
}
