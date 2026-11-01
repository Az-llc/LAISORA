import { projectArtifactAccess } from "./artifact-access";
import type { SemanticModel } from "./semantic-model";
import type { SemanticModelPayload } from "./protocol";

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

