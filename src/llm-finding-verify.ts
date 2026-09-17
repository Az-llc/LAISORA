import type { ActionDestination, ActionKind } from "./llm-action-policy";
import { isActionKindCompatible } from "./llm-action-policy";
import type { CitationAliasTable } from "./llm-citation-alias";
import type { NumericFactTable } from "./llm-analysis-input";
import type { SemanticModelPayload } from "./protocol";

export const LLM_FINDING_VERIFY_SPEC_VERSION = 2;

export interface ActionFindingCalculation {
  op: "identity" | "sum" | "cardinality";
  factIds: string[];
}

export interface ActionFindingImpact {
  unit: "ms" | "count";
  value: number;
  calculation: ActionFindingCalculation;
}

export interface ActionFindingAction {
  kind: ActionKind;
  steps: string[];
  destination: ActionDestination;
  target?: string;
}

export interface ActionFinding {
  title: string;
  observed: string;
  impact: ActionFindingImpact;
  action: ActionFindingAction;
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
}

export interface LlmAnalysisProvenance {
  semanticRevision: number;
  semanticHash: string;
  analysisGeneratedAt: number;
  modelId: string;
  promptVersion: string;
}

export interface FindingVerificationModel {
  revision: number;
  semanticHash: string;
}

export function asFindingVerificationModelFromPayload(
  payload: SemanticModelPayload
): FindingVerificationModel {
  return payload;
}

export type FindingCheckId =
  | "provenance_consistency"
  | "evidence_missing"
  | "evidence_not_primary"
  | "impact_mismatch"
  | "action_missing"
  | "destination_kind_incompatible"
  | "unit_mismatch";

export type FindingRejectionReason =
  | "provenance_mismatch"
  | "evidence_missing"
  | "evidence_not_primary"
  | "impact_mismatch"
  | "action_missing"
  | "destination_kind_incompatible"
  | "unit_mismatch";

export interface FindingRejection {
  stage: "verify";
  check: FindingCheckId;
  reason: FindingRejectionReason;
  subjectIds: string[];
  detail?: Record<string, string | number>;
}

export interface AcceptedFinding {
  verdict: "accepted";
  finding: ActionFinding;
}

export interface RejectedFinding {
  verdict: "rejected";
  finding: ActionFinding;
  rejections: FindingRejection[];
}

export type FindingVerdict = AcceptedFinding | RejectedFinding;

export interface ActionFindingVerificationResult {
  specVersion: number;
  provenance: LlmAnalysisProvenance;
  accepted: ActionFinding[];
  diagnostics: RejectedFinding[];
  counts: {
    total: number;
    accepted: number;
    rejected: number;
    byReason: Record<string, number>;
  };
}

export interface ActionFindingVerificationInput {
  model: FindingVerificationModel;
  analysis: { semanticHash: string };
  provenance: LlmAnalysisProvenance;
  aliases: CitationAliasTable;
  facts: NumericFactTable;
  findings: readonly ActionFinding[];
}

function isPrimaryEvidence(alias: string): boolean {
  return (
    alias.startsWith("E") ||
    alias.startsWith("U") ||
    alias.startsWith("M:") ||
    alias.startsWith("D") ||
    alias.startsWith("G")
  );
}

export function verifyActionFindings(
  input: ActionFindingVerificationInput
): ActionFindingVerificationResult {
  const accepted: ActionFinding[] = [];
  const diagnostics: RejectedFinding[] = [];
  const byReason: Record<string, number> = {};

  const provenanceMismatch =
    input.provenance.semanticHash !== input.analysis.semanticHash ||
    input.provenance.semanticHash !== input.model.semanticHash;

  for (const finding of input.findings) {
    const rejections: FindingRejection[] = [];

    if (provenanceMismatch) {
      rejections.push({
        stage: "verify",
        check: "provenance_consistency",
        reason: "provenance_mismatch",
        subjectIds: [],
        detail: {
          provenanceSemanticHash: input.provenance.semanticHash,
          analysisSemanticHash: input.analysis.semanticHash,
          modelSemanticHash: input.model.semanticHash,
        },
      });
    }

    // 1. evidence_missing: Check if all evidenceIds and calculation factIds exist in alias / facts table
    const allEvidenceIds = [...finding.evidenceIds, ...finding.impact.calculation.factIds];
    const missingIds = allEvidenceIds.filter(
      (id) => !input.aliases.canonicalOf.has(id) && !input.facts.has(id)
    );
    if (missingIds.length > 0) {
      rejections.push({
        stage: "verify",
        check: "evidence_missing",
        reason: "evidence_missing",
        subjectIds: missingIds,
      });
    }

    // 2. evidence_not_primary: Must contain at least one primary evidence (E/U/M/D/G)
    const hasPrimary = finding.evidenceIds.some((id) => isPrimaryEvidence(id));
    if (!hasPrimary) {
      rejections.push({
        stage: "verify",
        check: "evidence_not_primary",
        reason: "evidence_not_primary",
        subjectIds: [...finding.evidenceIds],
      });
    }

    // 3 & 6. impact calculation & unit match
    const calc = finding.impact.calculation;
    const impact = finding.impact;

    // M-4: calculation.factIds must require facts.has(id) for all ops (identity, sum, cardinality)
    const missingFactIds = calc.factIds.filter((fid) => !input.facts.has(fid));
    if (missingFactIds.length > 0) {
      rejections.push({
        stage: "verify",
        check: "impact_mismatch",
        reason: "impact_mismatch",
        subjectIds: [...missingFactIds],
        detail: { missingFactIds: missingFactIds.join(",") },
      });
    } else if (calc.op === "identity") {
      if (calc.factIds.length !== 1) {
        rejections.push({
          stage: "verify",
          check: "impact_mismatch",
          reason: "impact_mismatch",
          subjectIds: [...calc.factIds],
          detail: { op: "identity", expectedFactCount: 1, actualFactCount: calc.factIds.length },
        });
      } else {
        const fact = input.facts.get(calc.factIds[0])!;
        if (fact.unit !== impact.unit) {
          rejections.push({
            stage: "verify",
            check: "unit_mismatch",
            reason: "unit_mismatch",
            subjectIds: [calc.factIds[0]],
            detail: { factUnit: fact.unit, impactUnit: impact.unit },
          });
        } else if (fact.value !== impact.value) {
          rejections.push({
            stage: "verify",
            check: "impact_mismatch",
            reason: "impact_mismatch",
            subjectIds: [calc.factIds[0]],
            detail: { claimed: impact.value, observed: fact.value },
          });
        }
      }
    } else if (calc.op === "sum") {
      if (calc.factIds.length === 0) {
        rejections.push({
          stage: "verify",
          check: "impact_mismatch",
          reason: "impact_mismatch",
          subjectIds: [],
          detail: { op: "sum", factCount: 0 },
        });
      } else {
        let sum = 0;
        let unitMismatch = false;
        for (const fid of calc.factIds) {
          const fact = input.facts.get(fid)!;
          if (fact.unit !== impact.unit) {
            unitMismatch = true;
          }
          sum += fact.value;
        }
        if (unitMismatch) {
          rejections.push({
            stage: "verify",
            check: "unit_mismatch",
            reason: "unit_mismatch",
            subjectIds: [...calc.factIds],
          });
        } else if (sum !== impact.value) {
          rejections.push({
            stage: "verify",
            check: "impact_mismatch",
            reason: "impact_mismatch",
            subjectIds: [...calc.factIds],
            detail: { claimed: impact.value, calculated: sum },
          });
        }
      }
    } else if (calc.op === "cardinality") {
      if (impact.unit !== "count") {
        rejections.push({
          stage: "verify",
          check: "unit_mismatch",
          reason: "unit_mismatch",
          subjectIds: [...calc.factIds],
          detail: { requiredUnit: "count", actualUnit: impact.unit },
        });
      } else if (calc.factIds.length !== impact.value) {
        rejections.push({
          stage: "verify",
          check: "impact_mismatch",
          reason: "impact_mismatch",
          subjectIds: [...calc.factIds],
          detail: { claimed: impact.value, calculated: calc.factIds.length },
        });
      }
    }


    // 4. action_missing: steps must be non-empty and have non-whitespace strings
    if (
      !Array.isArray(finding.action.steps) ||
      finding.action.steps.length === 0 ||
      finding.action.steps.every((s) => typeof s !== "string" || s.trim().length === 0)
    ) {
      rejections.push({
        stage: "verify",
        check: "action_missing",
        reason: "action_missing",
        subjectIds: [],
      });
    }

    // 5. destination_kind_incompatible
    if (!isActionKindCompatible(finding.action.destination, finding.action.kind)) {
      rejections.push({
        stage: "verify",
        check: "destination_kind_incompatible",
        reason: "destination_kind_incompatible",
        subjectIds: [],
        detail: {
          destination: finding.action.destination,
          kind: finding.action.kind,
        },
      });
    }

    if (rejections.length === 0) {
      accepted.push(finding);
    } else {
      for (const r of rejections) {
        byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
      }
      diagnostics.push({ verdict: "rejected", finding, rejections });
    }
  }

  return {
    specVersion: LLM_FINDING_VERIFY_SPEC_VERSION,
    provenance: input.provenance,
    accepted,
    diagnostics,
    counts: {
      total: input.findings.length,
      accepted: accepted.length,
      rejected: diagnostics.length,
      byReason,
    },
  };
}
