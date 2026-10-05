import * as l10n from "@vscode/l10n";
import { redactAbsolutePaths } from "./path-redaction";
import { ASK_DECIDE_FORMAT } from "./claudeHost";
import { normalizeProfileSources, PROFILE_SOURCES, type ProfileSource } from "./protocol";
import { EXECUTORS, claudeModelIdLabel, type ExecutorId, type ExternalModels } from "./orchestration-executors";
import { orchestrationExternalTargets, orchestrationVariants, type OrchestrationRow } from "./orchestration-roster";

export type ProfileTarget = { executor: ExecutorId; model: string };
export const profileTargetKey = (target: ProfileTarget): string => `${target.executor}/${target.model}`;

export function resolveClaudeProfileModel(value: string | undefined, models?: ExternalModels, fallback?: string): string | undefined {
  const clean = (model: string) => model.trim().toLowerCase().replace(/\[1m\]$/, "");
  const list = models?.claude;
  const resolve = (model: string | undefined): string | undefined => {
    const known = model ? clean(model) : undefined;
    const resolved = list?.state === "ok" ? list.models.find(row => clean(row.id) === known && row.resolvedModel)?.resolvedModel : undefined;
    const normalized = resolved ? clean(resolved) : known;
    return normalized && !/^(default|haiku|sonnet|opus)$/.test(normalized) ? normalized : undefined;
  };
  return resolve(value) ?? resolve(fallback);
}

export function selectedProfileRows(roster: readonly OrchestrationRow[], models?: ExternalModels) {
  const agents = orchestrationVariants(roster), external = orchestrationExternalTargets(roster, models);
  return roster.flatMap(role => [...role.rows.filter(row => row.executor === "claude"), ...role.rows.filter(row => row.executor !== "claude")]
    .filter(row => role.enabled && (row.executor === "claude"
      ? agents.some(agent => agent.role === role.role && agent.model === row.model)
      : external.some(target => target.role === role.role && target.executor === row.executor && target.model === row.model))));
}

export function listedProfileTargets(models: ExternalModels, roster: readonly OrchestrationRow[]): ProfileTarget[] {
  const targets = selectedProfileRows(roster, models).flatMap(row => {
    const target = resolveProfileTarget(row.executor, row.model, models);
    return target ? [target] : [];
  });
  return [...new Map(targets.map(target => [profileTargetKey(target), target])).values()];
}

export function resolveProfileTarget(executor: ExecutorId, model: string, models: ExternalModels): ProfileTarget | undefined {
  const resolved = executor === "claude" ? resolveClaudeProfileModel(model, models) : model;
  const list = models[executor];
  if (!resolved || list.state !== "ok") return undefined;
  const known = EXECUTORS[executor].models(list)?.some(choice =>
    (executor === "claude" ? resolveClaudeProfileModel(choice.model, models) : choice.model) === resolved);
  return known ? { executor, model: resolved } : undefined;
}

export function modelProfileResearchInstruction(targets: readonly ProfileTarget[], sources: readonly ProfileSource[] = PROFILE_SOURCES, research = "unavailable"): string {
  const enabled = normalizeProfileSources(sources);
  const materials = enabled.map(source => source === "official"
    ? l10n.t("the provider's official announcements and documentation")
    : l10n.t("Artificial Analysis (artificialanalysis.ai) model pages, including per-effort results"));
  return [
    l10n.t("The target models have the following executors and resolved IDs: {0}. For each public claim, use exactly the executor and model values in this list: {1}",
      targets.map(profileTargetKey).join(", "), JSON.stringify(targets.map(target => ({ executor: target.executor,
        model: target.executor === "claude" ? claudeModelIdLabel(target.model) : target.model })))),
    l10n.t("Research using only these sources: {0}.", materials.join(l10n.t("; "))),
    l10n.t("Do not use individual people's posts as sources. For benchmark numbers, include the benchmark name, version and effort."),
    l10n.t("Briefly summarize only documented effort behavior (default, supported values, and how quality, latency and token use change across efforts) and caveats that change how the model should be prompted, timed out or verified."),
    l10n.t("Provide source URLs and record when you checked the material in ISO UTC. Do not infer publication dates."),
    l10n.t("Record the whole verified set using mcp__laisora_learning__public with research ID {0}. Each claim requires executor, model, effort, role, text and one to three sources with url and checkedAt. Write one English claim per line within 300 code points, without numbers. Put numbers and benchmark conditions in the separate figures field. LAISORA validates the whole set before saving it.", research),
    l10n.t("Omit items you cannot find. If you find none of the items, report that nothing was found and do not record claims."),
    l10n.t("Do not research prices or infer characteristics from model names or other models. Report the recording result and sources."),
  ].join("\n");
}

export interface EffortSettingsLocation {
  path: string;
  pathBase: "workingFolder" | "home";
  scope: "workspaceFolder" | "workspace" | "user";
  isDefault: boolean;
  inWorkspaceFile: boolean;
}

export function rosterEffortInstruction(location: EffortSettingsLocation, roster: readonly OrchestrationRow[], models: ExternalModels, targets: readonly ProfileTarget[], evidence = "No evidence"): string {
  const selected = new Set(selectedProfileRows(roster, models));
  const keys = new Set(targets.map(profileTargetKey));
  const rows = roster.flatMap(role => role.rows.filter(row => {
    const target = resolveProfileTarget(row.executor, row.model, models);
    return selected.has(row) && target && keys.has(profileTargetKey(target));
  }).map(row => ({ role: redactAbsolutePaths(role.role), description: redactAbsolutePaths(role.description), executor: row.executor, model: redactAbsolutePaths(row.model), efforts: row.efforts,
    resolvedModel: redactAbsolutePaths(resolveProfileTarget(row.executor, row.model, models)!.model) })));
  return [
    l10n.t("I want to review the efforts in LAISORA's roster. Follow these steps."),
    l10n.t("Settings file: {0} ({1})", JSON.stringify(location.path), location.scope),
    location.pathBase === "workingFolder" ? l10n.t("The settings path is relative to the current working folder.") : l10n.t("The settings path uses ~/ relative to your home directory."),
    location.inWorkspaceFile ? l10n.t("Setting key: \"laisora.orchestration.agents\" inside settings.") : l10n.t("Setting key: \"laisora.orchestration.agents\"."),
    location.isDefault ? l10n.t("This setting is not defined in any scope and currently uses the default. Write approved changes to the user settings above. When creating the key, preserve the entire default roster and change only the approved rows' efforts.") : l10n.t("The file above defines the current effective value. Do not write to another scope."),
    l10n.t("1. Read the settings file above and list only the enabled, complete rows confirmed by the Host below, grouped by role (role and description). model is the saved value; resolvedModel is the resolved ID for matching the supplied material. If the file and this list disagree, ask without making changes."),
    JSON.stringify(rows, null, 2),
    l10n.t("2. Propose an effort appropriate to each row's role. Use only the Host-built proposal evidence below and the role description as evidence. Explain which evidence supports each effort change and its limits. Normal completion does not prove answer quality; unrelated benchmarks do not support a role recommendation. For a model without numbers, write \"No evidence\"; do not invent numbers. Describe increases in time and tokens at higher effort only where documented."),
    l10n.t("3. Present a table (role, model, current efforts, proposal, evidence, cost change). Do not change settings yet. If the material has no cost numbers, write \"No evidence\" for those too."),
    l10n.t("Proposal evidence (built by LAISORA):"),
    evidence,
    ASK_DECIDE_FORMAT(),
    l10n.t("4. Present one separate laisora-ask fence (kind: decide) per proposed row. Give each card a unique row-specific title identifying role / executor / model and the row position. Each card must have exactly two options: the proposed change (label: yes: role / executor / model) and No changes. Include the old and new efforts in effect, benefits in pros, drawbacks in cons, and title, why and default. Set default to Without an answer, I will not change settings."),
    l10n.t("5. Answer my questions."),
    l10n.t("Make no changes without an answer."),
    l10n.t("Make no changes for a No changes answer."),
    l10n.t("Change only rows I explicitly approve with yes, including replies from each row's decision card."),
    l10n.t("In only the settings file and scope specified above, change only the efforts of those approved rows. Preserve all other rows, keys, comments and formatting."),
    l10n.t("Re-read the settings immediately before writing; if they differ from what I approved, stop and ask without making changes."),
    l10n.t("After writing, show the diff."),
  ].join("\n");
}
