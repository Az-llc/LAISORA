import * as l10n from "@vscode/l10n";
import { createHash } from "node:crypto";
import { ACTION_DESTINATION_LABELS, ACTION_DESTINATION_NORMS, ACTION_KIND_LABELS, actionDestinationLabel, type AnalysisSdk } from "./llm-action-policy";
import type { LlmAnalysisOutcome, LlmAnalysisUnavailableReason } from "./llm-analysis-client";
import type { CitationAliasTable } from "./llm-citation-alias";
import type { NumericFactTable } from "./llm-analysis-input";
import type { ActionFinding, ActionFindingImpact } from "./llm-finding-verify";
import type { PersistedActionFinding, PersistedEvidenceChip } from "./analysis-persistence";
import type {
  AttachedEvidenceChip,
  AttachedFindingView,
  LlmFindingDiagnosticsPayload,
  LlmUnavailableReason,
} from "./protocol";

export interface ActionFindingEvidenceChip {
  alias: string;
  kind: "event" | "user" | "metric" | "divergence" | "guardrail" | "file";
  label: string;
  target?: { tab: "detail"; toolUseId: string };
}

export function unavailableCode(reason: LlmAnalysisUnavailableReason): LlmUnavailableReason {
  switch (reason) {
    case "no_client":
      return "not_configured";
    case "client_timeout":
      return "timeout";
    case "client_error":
    case "client_aborted":
      return "client_error";
    case "malformed_response":
      return "parse_failed";
    case "provenance_mismatch":
    case "prompt_render_error":
    case "verification_error":
      return "internal_error";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function formatImpactLabel(impact: ActionFindingImpact): string {
  if (impact.calculation.op === "cardinality" && impact.unit === "count") {
    return l10n.t("Related records: {0}", impact.value);
  }
  if (impact.unit === "count") {
    return l10n.t("{0} times", impact.value);
  }
  const ms = impact.value;
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) {
    return l10n.t("{0}s", (ms / 1000).toFixed(1));
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) {
    return seconds > 0 ? l10n.t("About {0} min", minutes) : l10n.t("{0} min", minutes);
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? l10n.t("About {0} h {1} min", hours, remMinutes) : l10n.t("{0} h", hours);
}

export function formatEvidenceChip(
  evidenceId: string,
  aliases?: CitationAliasTable,
  facts?: NumericFactTable
): ActionFindingEvidenceChip {
  if (evidenceId.startsWith("E")) {
    const canonicalId = aliases?.canonicalOf.get(evidenceId) ?? evidenceId;
    const fact = facts?.get(evidenceId);
    const toolName = fact?.toolName ?? "Tool";
    const status = fact?.isError ? "fail" : "ok";
    return {
      alias: evidenceId,
      kind: "event",
      label: `${evidenceId} ${toolName} ${status}`,
      target: { tab: "detail", toolUseId: canonicalId },
    };
  }
  if (evidenceId.startsWith("U")) {
    const canonicalId = aliases?.canonicalOf.get(evidenceId) ?? evidenceId;
    return {
      alias: evidenceId,
      kind: "user",
      label: `${evidenceId} (${canonicalId})`,
    };
  }
  if (evidenceId.startsWith("M:")) {
    const fact = facts?.get(evidenceId);
    const valStr = fact !== undefined ? ` (${fact.value}${fact.unit === "ms" ? "ms" : ""})` : "";
    return {
      alias: evidenceId,
      kind: "metric",
      label: `${evidenceId}${valStr}`,
    };
  }
  if (evidenceId.startsWith("D")) {
    const canonicalId = aliases?.canonicalOf.get(evidenceId) ?? evidenceId;
    const fact = facts?.get(evidenceId);
    const kindStr = fact?.kind ? ` ${fact.kind}` : "";
    return {
      alias: evidenceId,
      kind: "divergence",
      label: `${evidenceId}${kindStr} (${canonicalId})`,
    };
  }
  if (evidenceId.startsWith("G")) {
    const fact = facts?.get(evidenceId);
    const kindStr = fact?.kind ? ` ${fact.kind}` : "";
    return {
      alias: evidenceId,
      kind: "guardrail",
      label: `${evidenceId}${kindStr}`,
    };
  }
  if (evidenceId.startsWith("F")) {
    const canonicalId = aliases?.canonicalOf.get(evidenceId) ?? evidenceId;
    const fact = facts?.get(evidenceId);
    const path = fact?.path ?? canonicalId;
    return {
      alias: evidenceId,
      kind: "file",
      label: `${evidenceId} ${path}`,
    };
  }
  return {
    alias: evidenceId,
    kind: "event",
    label: evidenceId,
  };
}

const CONFIDENCE_WEIGHT: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function orderFindings(findings: readonly ActionFinding[]): ActionFinding[] {
  if (findings.every(f => f.impact.unit === "count" && f.impact.calculation.op === "cardinality")) return [...findings];
  return [...findings].sort((a, b) => {
    // 1. ms descending
    const aMs = a.impact.unit === "ms" ? a.impact.value : -1;
    const bMs = b.impact.unit === "ms" ? b.impact.value : -1;
    if (aMs !== bMs) return bMs - aMs;

    // 2. count descending
    const aCount = a.impact.unit === "count" ? a.impact.value : -1;
    const bCount = b.impact.unit === "count" ? b.impact.value : -1;
    if (aCount !== bCount) return bCount - aCount;

    // 3. confidence descending
    const aConf = CONFIDENCE_WEIGHT[a.confidence] ?? 0;
    const bConf = CONFIDENCE_WEIGHT[b.confidence] ?? 0;
    return bConf - aConf;
  });
}


export function projectPersistedActionFindings(
  findings: readonly ActionFinding[],
  aliases?: CitationAliasTable,
  facts?: NumericFactTable
): PersistedActionFinding[] {
  const ordered = orderFindings(findings);
  const idCounts = new Map<string, number>();

  return ordered.map((finding, idx) => {
    const baseHash = createHash("sha256")
      .update(finding.title + ":" + finding.evidenceIds.join(","), "utf8")
      .digest("hex")
      .slice(0, 12);
    const count = (idCounts.get(baseHash) ?? 0) + 1;
    idCounts.set(baseHash, count);
    const findingId = count === 1 ? baseHash : `${baseHash}-${count}`;
    const numberLabel = l10n.t("Finding {0}", idx + 1);
    const destinationLabel = ACTION_DESTINATION_LABELS[finding.action.destination] ?? finding.action.destination;
    const actionKindLabel = ACTION_KIND_LABELS[finding.action.kind] ?? finding.action.kind;
    const stepsText = finding.action.steps.map((s, i) => `${i + 1}. ${s}`).join(" ");
    const targetText = finding.action.target ? `   ${l10n.t("Destination: {0}", finding.action.target)}` : "";
    const actionLine = `${l10n.t("Improvement direction: {0}", stepsText)}${targetText}`;

    return {
      findingId,
      numberLabel,
      title: finding.title,
      observed: finding.observed,
      impactLabel: formatImpactLabel(finding.impact),
      destination: finding.action.destination,
      destinationLabel,
      actionKind: finding.action.kind,
      actionKindLabel,
      actionLine,
      steps: [...finding.action.steps],
      target: finding.action.target,
      evidence: finding.evidenceIds.map((id) => {
        const chip = formatEvidenceChip(id, aliases, facts);
        const canonicalId = aliases?.canonicalOf.get(id);
        return {
          alias: chip.alias,
          kind: chip.kind,
          label: chip.label,
          toolUseId: chip.kind === "event" ? (canonicalId ?? id) : undefined,
        };
      }),
      confidence: finding.confidence,
    };
  });
}

export type LlmDiagnosticsAudience = "opt-in-diagnostics" | "off";

export function projectLlmFindingDiagnostics(
  outcome: LlmAnalysisOutcome,
  audience: LlmDiagnosticsAudience
): LlmFindingDiagnosticsPayload | undefined {
  if (audience !== "opt-in-diagnostics") return undefined;
  switch (outcome.state) {
    case "disabled":
      return undefined;
    case "unavailable":
      return { state: "unavailable", reason: outcome.reason };
    case "ready":
      return {
        state: "completed",
        specVersion: outcome.result.specVersion,
        provenance: outcome.result.provenance,
        cacheState: outcome.cacheState,
        rejected: outcome.result.diagnostics.map((r) => ({ ...r })),
        counts: {
          candidate: outcome.schema.candidateCount,
          schemaRejected: outcome.schema.rejectedCount,
          schemaByReason: { ...outcome.schema.byReason } as Record<string, number>,
          verified: outcome.result.counts.total,
          accepted: outcome.result.counts.accepted,
          rejected: outcome.result.counts.rejected,
          byReason: { ...outcome.result.counts.byReason },
        },
      };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export function buildFindingEvidenceLine(evidence: Array<PersistedEvidenceChip | AttachedEvidenceChip>): string {
  return evidence
    .map((e) => {
      const toolUseId =
        "toolUseId" in e
          ? e.toolUseId
          : "navigateToolUseId" in e
          ? (e as AttachedEvidenceChip).navigateToolUseId
          : (e as { target?: { toolUseId?: string } }).target?.toolUseId;
      if (e.kind === "event" && toolUseId) {
        return `${e.alias}: event / ${toolUseId}`;
      }
      let detail = e.label;
      if (detail.startsWith(e.alias)) {
        detail = detail.slice(e.alias.length).trim();
      }
      return `${e.alias}: ${e.kind} / ${detail}`;
    })
    .join(", ");
}

export interface FindingSessionPromptInput {
  analysisSdk?: AnalysisSdk;
  sessionRef: string;
  models: string[] | null;
  isoTime: string;
  finding: PersistedActionFinding | AttachedFindingView;
}

export function buildFindingSessionPrompt(input: FindingSessionPromptInput): string {
  const modelsStr = input.models && input.models.length > 0 ? input.models.join("+") : l10n.t("(no model information)");
  const destinationLabel = "destination" in input.finding
    ? actionDestinationLabel(input.finding.destination, input.analysisSdk)
    : input.finding.destinationLabel;
  const destinationStr = input.finding.target
    ? `${destinationLabel}（${input.finding.target}）`
    : destinationLabel;
  const stepsStr = input.finding.steps.map((step, idx) => `${idx + 1}. ${step}`).join(" ");
  const evidenceStr = buildFindingEvidenceLine(input.finding.evidence);

  return [
    l10n.t("Below is a finding from LAISORA's LLM analysis. Carry out the fix. This is a draft."),
    l10n.t("Source session: {0}", input.sessionRef),
    l10n.t("Analysis model: {0}", modelsStr),
    l10n.t("Analyzed at: {0}", input.isoTime),
    l10n.t("Finding: {0}", input.finding.title),
    l10n.t("What happened: {0}", input.finding.observed),
    l10n.t("Recorded value: {0}", input.finding.impactLabel),
    l10n.t("Improvement direction: {0}", stepsStr),
    l10n.t("Destination: {0}", destinationStr),
    l10n.t("Evidence: {0}", evidenceStr),
    ACTION_DESTINATION_NORMS.text,
    l10n.t("Consult the official documentation and best practices for your model environment, and address the cause using an appropriate approach. Go beyond a one-off workaround and aim to prevent recurrence within an appropriate scope."),
  ].join("\n");
}
