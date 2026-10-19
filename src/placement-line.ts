export const MEMORY_BLOCK_PROJECT_TYPE_SETTING = "memory.blockProjectType";

export interface PlacementSettings {
  readonly learningEnabled: boolean;
  readonly blockProjectType: boolean;
}

export function placementSettingsOf(cfg: { get<T>(key: string): T | undefined }): PlacementSettings {
  return { learningEnabled: cfg.get<boolean>("learning.enabled") === true, blockProjectType: cfg.get<boolean>(MEMORY_BLOCK_PROJECT_TYPE_SETTING) === true };
}

export interface Placement {
  readonly memoryTypes: readonly string[];
  readonly memoryDestination: string;
  readonly line: string;
  readonly learningEnabled: boolean;
}

export function placementOf(settings: PlacementSettings): Placement {
  const memoryTypes: readonly string[] = Object.freeze(settings.blockProjectType ? ["reference", "user"] : ["project", "reference", "user"]);
  const ongoingWork = settings.blockProjectType ? "ongoing work state → the project's own work-state document, not auto memory; " : "";
  const memoryDestination = `observed facts${settings.blockProjectType ? "" : ", ongoing work state"} and situational user preferences → Claude Code auto memory with frontmatter type in [${memoryTypes.join(", ")}]; ${ongoingWork}preferences that always apply, corrections, rulings → user-level CLAUDE.md or rules`;
  const line = `Decide where knowledge belongs yourself and do not ask the user: permanent project controls → the project's .claude/rules; cross-project controls → user-level rules; CLAUDE.md/AGENTS.md → purpose, overview, how to proceed, pointers; ${memoryDestination}${settings.learningEnabled ? "; model-specific usage → LAISORA's learning ledger only" : ""}.`;
  return Object.freeze({ memoryTypes, memoryDestination, line, learningEnabled: settings.learningEnabled });
}

export const PLACEMENT_RULE_POINTER = "auto memory and other knowledge → the always-on placement rule";
