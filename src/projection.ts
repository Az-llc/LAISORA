// webview へ渡す公開面の射影。Host-only 値（canonicalPath / baseDir / progress）は
// ここで物理的に落とす。extension.ts に置いたままだと vscode 依存で検証ハーネスから
// 実装を直接呼べず、テスト側が規則を再実装して漏れを見逃す
import { projectArtifactAccess } from "./artifact-access";
import type { DivergenceKind, DivergenceKindReport, DivergenceReport } from "./l3-divergence";
import type { SemanticModel } from "./semantic-model";
import type { DivergenceKindReportView, DivergenceReportView, SemanticModelPayload } from "./protocol";

// attempt の artifacts を ProjectedArtifactAccess へ射影する。canonicalPath は Host-only
// で、SemanticModel をそのまま post すると再流出する。
// progress も baseDir と writes[].canonicalPath を持つため落とす
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

// 裁定Q8: 乖離 record の coverage は「検出入力の観測状況」で、record の存在の確からしさでは
// ない。表示側が Coverage で record を畳む実装を書けないよう、公開面では名前を変えて運ぶ
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
