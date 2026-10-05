import { projectArtifactAccess } from "./artifact-access";
import type { DivergenceKind, DivergenceKindReport, DivergenceReport } from "./l3-divergence";
import type { SemanticModel } from "./semantic-model";
import type { DivergenceKindReportView, DivergenceReportView, SemanticModelPayload } from "./protocol";

export function projectSemanticModel(model: SemanticModel): SemanticModelPayload {
  const { progress: _hostOnlyProgress, ...publicModel } = model;
  return {
    ...publicModel,
    nodes: publicModel.nodes.map((node) =>
      node.kind === "attempt"
        ? { ...node, artifacts: node.artifacts.map(projectArtifactAccess) }
        : node
    ),
  };
}

export function projectDivergences(report: DivergenceReport): DivergenceReportView {
  const kinds = {} as Record<DivergenceKind, DivergenceKindReportView>;
  for (const [kind, k] of Object.entries(report.kinds) as [DivergenceKind, DivergenceKindReport][]) {
    kinds[kind] = {
      ...k,
      records: k.records.map(({ coverage, ...rest }) => ({
        ...rest,
        detectionInputCoverage: coverage,
      })),
    };
  }
  return { ...report, kinds };
}
