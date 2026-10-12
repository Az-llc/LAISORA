import { EXECUTORS, type ExecutorId, type ExternalModels } from "./orchestration-executors";
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
