import * as l10n from "@vscode/l10n";
import { redactAbsolutePaths } from "./path-redaction";
import { ASK_DECIDE_FORMAT } from "./claudeHost";
import { normalizeProfileSources, PROFILE_SOURCES, type ProfileSource } from "./protocol";
import { latestModelProfile, type LearningState, type ModelProfile } from "./learning";
import { EXECUTORS, type ExecutorId, type ExternalModels } from "./orchestration-executors";
import { orchestrationExternalTargets, orchestrationVariants, type OrchestrationRow } from "./orchestration-roster";

export type ProfileTarget = Pick<ModelProfile, "executor" | "model">;
export const profileTargetKey = (target: ProfileTarget): string => `${target.executor}/${target.model}`;

export function resolveClaudeProfileModel(value: string | undefined, models?: ExternalModels, fallback?: string): string | undefined {
  const clean = (model: string) => model.trim().toLowerCase().replace(/\[1m\]$/, "");
  const known = value ? clean(value) : undefined;
  const list = models?.claude;
  const resolved = list?.state === "ok" ? list.models.find(row => clean(row.id) === known && row.resolvedModel)?.resolvedModel : undefined;
  const model = resolved ?? (known && !/^(default|haiku|sonnet|opus)$/.test(known) ? known : fallback);
  const normalized = model ? clean(model) : undefined;
  return normalized && !/^(default|haiku|sonnet|opus)$/.test(normalized) ? normalized : undefined;
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
  if (!resolved || list.state !== "ok") return undefined; // R-LRN-18: research requires a successful list and a concrete version.
  const known = EXECUTORS[executor].models(list)?.some(choice =>
    (executor === "claude" ? resolveClaudeProfileModel(choice.model, models) : choice.model) === resolved);
  return known ? { executor, model: resolved } : undefined;
}

function profileParts(profile: ModelProfile): string[] {
  return [profile.effort && `Effort: ${profile.effort}`,
    profile.caveats && `Caveats: ${profile.caveats}`].filter((part): part is string => !!part);
}

export function profileAutoApply(state: LearningState | undefined): boolean {
  return !!state && [...state.records.values()].filter(record => record.kind === "control").at(-1)?.autoApply !== false;
}

export function renderModelProfileSection(state: LearningState | undefined, roster: readonly OrchestrationRow[], models?: ExternalModels): { text: string; omitted: number } {
  const heading = "Model characteristics:";
  const lines: string[] = [], seen = new Set<string>();
  let size = Array.from(heading).length, omitted = 0;
  for (const row of selectedProfileRows(roster, models)) {
    if (!state) continue;
    const model = row.executor === "claude" ? resolveClaudeProfileModel(row.model, models) : row.model;
    if (!model) continue;
    const target = { executor: row.executor, model }, key = profileTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    const profile = latestModelProfile(state, target);
    if (!profile) continue;
    const parts = profileParts(profile);
    if (!parts.length) continue;
    const line = `${key}: ${parts.join("; ")}`;
    const length = Array.from(line).length + 1;
    if (lines.length === 8 || size + length > 6000) { omitted++; continue; } // R-LRN-11: preserve whole lines.
    lines.push(line);
    size += length;
  }
  return { text: lines.length ? [heading, ...lines].join("\n") : "", omitted };
}

export function modelProfileResearchInstruction(targets: readonly ProfileTarget[], sources: readonly ProfileSource[] = PROFILE_SOURCES): string {
  const enabled = normalizeProfileSources(sources);
  const materials = enabled.map(source => source === "official"
    ? l10n.t("the provider's official announcements and documentation")
    : l10n.t("Artificial Analysis (artificialanalysis.ai) model pages, including per-effort results"));
  return [
    l10n.t("The target models have the following executors and resolved IDs: {0}", targets.map(profileTargetKey).join(", ")),
    l10n.t("Research using only these sources: {0}.", materials.join(l10n.t("; "))),
    l10n.t("Do not use individual people's posts as sources. For benchmark numbers, include the benchmark name, version and effort."),
    l10n.t("Briefly summarize only documented effort behavior (default, supported values, and how quality, latency and token use change across efforts) and caveats that change how the model should be prompted, timed out or verified."),
    l10n.t("Provide source URLs and record when you checked the material in ISO UTC. Do not infer publication dates."),
    l10n.t("Record verified information as modelProfile using mcp__laisora_learning__record, writing effort and caveats in English. Do not record general strengths."),
    l10n.t("Omit items you cannot find. If you find none of the items, report that nothing was found and do not record a profile."),
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

export function rosterEffortInstruction(location: EffortSettingsLocation, roster: readonly OrchestrationRow[], models: ExternalModels, targets: readonly ProfileTarget[]): string {
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
    l10n.t("2. Propose an effort appropriate to each row's role. Use only the \"Model characteristics\" supplied to this conversation (official material and Artificial Analysis numbers) and the role description as evidence. For a model without numbers, write \"No evidence\"; do not invent numbers. Describe increases in time and tokens at higher effort only where documented."),
    l10n.t("3. Present a table (role, model, current efforts, proposal, evidence, cost change). Do not change settings yet. If the material has no cost numbers, write \"No evidence\" for those too."),
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
