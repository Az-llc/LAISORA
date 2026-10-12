export const MEMORY_ALLOWED_TYPES: readonly string[] = Object.freeze(["reference", "user"]);
export const MEMORY_DESTINATION = `observed facts and situational user preferences → Claude Code auto memory with frontmatter type in [${MEMORY_ALLOWED_TYPES.join(", ")}]; preferences that always apply, corrections, rulings → user-level CLAUDE.md or rules`;

export const PLACEMENT_LINE = `Decide where knowledge belongs yourself and do not ask the user: permanent project controls → the project's .claude/rules; cross-project controls → user-level rules; CLAUDE.md/AGENTS.md → purpose, overview, how to proceed, pointers; ${MEMORY_DESTINATION}; model-specific usage → LAISORA's learning ledger only.`;
