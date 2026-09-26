import * as l10n from "@vscode/l10n";
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
  if (!resolved || list.state !== "ok") return undefined; // R-LRN-13: research requires a successful list and a concrete version.
  const known = EXECUTORS[executor].models(list)?.some(choice =>
    (executor === "claude" ? resolveClaudeProfileModel(choice.model, models) : choice.model) === resolved);
  return known ? { executor, model: resolved } : undefined;
}

function profileParts(profile: ModelProfile): string[] {
  return [profile.strengths && `Strengths: ${profile.strengths}`, profile.effort && `Effort: ${profile.effort}`,
    profile.caveats && `Caveats: ${profile.caveats}`,
    ...profile.sources.map(source => `${source.url} (checked ${source.checkedAt})`)].filter((part): part is string => !!part);
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
    const line = `${key}: ${profileParts(profile).join("; ")}`;
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
    l10n.t("Briefly summarize only documented strengths, effort behavior, and caveats."),
    l10n.t("Provide source URLs and record when you checked the material in ISO UTC. Do not infer publication dates."),
    l10n.t("Record verified information as modelProfile using mcp__laisora_learning__record, writing strengths, effort and caveats in English."),
    l10n.t("Omit items you cannot find. If you find none of the items, report that nothing was found and do not record a profile."),
    l10n.t("Do not research prices or infer characteristics from model names or other models. Report the recording result and sources."),
  ].join("\n");
}
