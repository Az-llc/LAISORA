export const MEMORY_BLOCK_PROJECT_TYPE_SETTING = "memory.blockProjectType";
export const GUARD_ENABLED_SETTING = "guard.enabled";
export const MODEL_NOTES_RULE = "Notes about specific models (a model or executor name with an effort level or a claim about what it is good or bad at, or a model name or version) are refused in instruction files and memory because they go stale with model generations";
export const DELEGATE_CONTROL_RULE = "only the conductor changes instruction, settings and hook files";
export const DELEGATE_MEMORY_RULE = "only the conductor writes memory";
export const DELEGATE_PROPOSAL = "return a proposed change in the reply instead";
const DELEGATE_RULES = `In this conversation ${DELEGATE_CONTROL_RULE}, and ${DELEGATE_MEMORY_RULE}`;
export const DELEGATE_PLACEMENT_NOTICE = `${DELEGATE_RULES}. As a delegate, your writes to them are refused, and git or shell commands that could rewrite them, including deleting a folder that contains them, are stopped before they run; ${DELEGATE_PROPOSAL}.`;
export const CONDUCTOR_CONTROL_LINE = `${DELEGATE_RULES}: make those changes yourself and do not delegate them.`;

export interface PlacementSettings {
  readonly guardEnabled: boolean;
  readonly blockProjectType: boolean;
}

export function placementSettingsOf(cfg: { get<T>(key: string): T | undefined }): PlacementSettings {
  return { guardEnabled: cfg.get<boolean>(GUARD_ENABLED_SETTING) !== false, blockProjectType: cfg.get<boolean>(MEMORY_BLOCK_PROJECT_TYPE_SETTING) === true };
}

export interface Placement {
  readonly guardEnabled: boolean;
  readonly memoryTypes: readonly string[];
  readonly memoryDestination: string;
  readonly line: string;
}

export function placementOf(settings: PlacementSettings): Placement {
  const memoryTypes: readonly string[] = Object.freeze(settings.blockProjectType ? ["reference", "user"] : ["project", "reference", "user"]);
  const ongoingWork = settings.blockProjectType ? "ongoing work state → the project's own work-state document, not auto memory; " : "";
  const memoryDestination = `observed facts${settings.blockProjectType ? "" : ", ongoing work state"} and situational user preferences → Claude Code auto memory with frontmatter type in [${memoryTypes.join(", ")}]; ${ongoingWork}preferences that always apply, corrections, rulings → user-level CLAUDE.md or rules`;
  const line = settings.guardEnabled ? `Decide where knowledge belongs yourself and do not ask the user: permanent project controls → the project's .claude/rules; cross-project controls → user-level rules; CLAUDE.md/AGENTS.md → purpose, overview, how to proceed, pointers; ${memoryDestination}. ${MODEL_NOTES_RULE}.` : "";
  return Object.freeze({ guardEnabled: settings.guardEnabled, memoryTypes, memoryDestination, line });
}
