import * as l10n from "@vscode/l10n";

export type ActionDestination =
  | "mechanism"
  | "runtime_rule"
  | "memory"
  | "skill"
  | "rules"
  | "claude_md";

export type ActionKind =
  | "add_script_or_harness"
  | "add_template_field"
  | "change_tool_usage"
  | "add_persistent_constraint"
  | "add_temporary_model_rule"
  | "record_fact"
  | "audit_skill"
  | "add_onboarding_context"
  | "add_workflow_or_command_doc";

export const ACTION_DESTINATIONS: readonly ActionDestination[] = [
  "mechanism",
  "runtime_rule",
  "memory",
  "skill",
  "rules",
  "claude_md",
];

export const ACTION_KINDS: readonly ActionKind[] = [
  "add_script_or_harness",
  "add_template_field",
  "change_tool_usage",
  "add_persistent_constraint",
  "add_temporary_model_rule",
  "record_fact",
  "audit_skill",
  "add_onboarding_context",
  "add_workflow_or_command_doc",
];

export const DESTINATION_ACTION_KINDS: Record<ActionDestination, readonly ActionKind[]> = {
  mechanism: ["add_script_or_harness", "add_template_field", "change_tool_usage"],
  runtime_rule: ["add_temporary_model_rule"],
  memory: ["record_fact"],
  skill: ["audit_skill"],
  rules: ["add_persistent_constraint"],
  claude_md: ["add_onboarding_context", "add_workflow_or_command_doc"],
};

export function isActionKindCompatible(destination: ActionDestination, kind: ActionKind): boolean {
  const allowed = DESTINATION_ACTION_KINDS[destination];
  return allowed !== undefined && allowed.includes(kind);
}

export function analysisActionDestinations(learningEnabled: boolean): readonly ActionDestination[] {
  return learningEnabled ? ACTION_DESTINATIONS : ACTION_DESTINATIONS.filter(destination => destination !== "runtime_rule");
}

export function renderAnalysisDestinationPrompt(prompt: string, learningEnabled: boolean): string {
  if (learningEnabled) return prompt;
  return prompt.split("\n").filter(line => !line.startsWith("- runtime_rule"))
    .join("\n");
}

export function renderDestinationActionKindsSection(learningEnabled = true): string {
  return analysisActionDestinations(learningEnabled).map(
    (dest) => `- ${dest}: ${DESTINATION_ACTION_KINDS[dest].join(", ")}`
  ).join("\n");
}


export type AnalysisSdk = "claude" | "codex";

export function actionDestinationLabel(destination: ActionDestination | "project_guidance", sdk?: AnalysisSdk): string {
  switch (destination) {
    case "mechanism": return l10n.t("Code, settings, and automated checks (hooks, etc.)");
    case "runtime_rule": return l10n.t("Temporary workaround for a specific model");
    case "memory": return l10n.t("Project facts and memory");
    case "skill": return l10n.t("Skill instructions and workflows");
    case "rules": return l10n.t("Ongoing behavioral rules");
    case "claude_md":
    case "project_guidance":
      if (sdk === "claude") return l10n.t("Project instructions (CLAUDE.md)");
      if (sdk === "codex") return l10n.t("Project instructions (AGENTS.md)");
      return l10n.t("Project instructions for AI agents");
  }
}

export const ACTION_DESTINATION_LABELS: Record<ActionDestination, string> = {
  get mechanism() { return actionDestinationLabel("mechanism"); },
  get runtime_rule() { return actionDestinationLabel("runtime_rule"); },
  get memory() { return actionDestinationLabel("memory"); },
  get skill() { return actionDestinationLabel("skill"); },
  get rules() { return actionDestinationLabel("rules"); },
  get claude_md() { return actionDestinationLabel("project_guidance"); },
};

export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  get add_script_or_harness() { return l10n.t("Add script/harness"); },
  get add_template_field() { return l10n.t("Add template field"); },
  get change_tool_usage() { return l10n.t("Change tool usage"); },
  get add_persistent_constraint() { return l10n.t("Add persistent constraint"); },
  get add_temporary_model_rule() { return l10n.t("Add temporary model rule"); },
  get record_fact() { return l10n.t("Record project fact"); },
  get audit_skill() { return l10n.t("Audit skill"); },
  get add_onboarding_context() { return l10n.t("Add onboarding context"); },
  get add_workflow_or_command_doc() { return l10n.t("Add workflow/command description"); },
};

export const ACTION_DESTINATION_NORMS = {
  forLearning(learningEnabled: boolean): string {
    return learningEnabled ? this.text : l10n.t("Choose the improvement destination by its purpose: mechanism changes tools, infrastructure, or automated checks; memory records project facts; skill changes skill instructions or workflows; rules defines durable behavioral constraints; claude_md supplies project entry information, basic commands, and links to authoritative sources. File placement is decided during improvement. Resolved cases remain useful material, not instructions to repeat completed fixes.");
  },
  get text(): string {
    return l10n.t("Choose the improvement destination by its purpose: mechanism changes tools, infrastructure, or automated checks; runtime_rule records evidenced model-specific usage only in LAISORA's learning ledger through observe; memory records project facts; skill changes skill instructions or workflows; rules defines durable behavioral constraints; claude_md supplies project entry information, basic commands, and links to authoritative sources. File placement is decided during improvement. Resolved cases remain useful material, not instructions to repeat completed fixes.");
  },
};
