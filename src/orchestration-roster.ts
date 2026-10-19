import { configurationDefault } from "./configuration-defaults";
import { EXECUTORS, EXTERNAL_EXECUTORS, CLAUDE_EFFORTS, CODEX_EFFORTS, canonicalExecutorEfforts, isOrchestrationEffort, claudeAgentName,
  executorModelList, isExecutorId, isExternalExecutorId, isExternalModel, rowComplete,
  type ExecutorId, type ExecutorRow, type ExternalExecutorId, type ExternalModel, type ExternalModels, type ExternalDetection, type OrchestrationEffort } from "./orchestration-executors";
export * from "./orchestration-executors";
export interface OrchestrationRow {
  readonly role: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly cacheTtl?: "5m" | "1h";
  readonly rows: readonly ExecutorRow[];
}
export type OrchestrationSettingRow = OrchestrationRow;
export function emptyOrchestrationRole(role: string): OrchestrationSettingRow {
  return { role, enabled: true, description: "", rows: [] };
}
export const DEFAULT_ORCHESTRATION_ROSTER: readonly OrchestrationRow[] = Object.freeze(
  configurationDefault<OrchestrationRow[]>("orchestration.agents").map(freezeOrchestrationRole));
function rosterObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function rosterEfforts(value: unknown, allowed: readonly string[] = CLAUDE_EFFORTS): boolean {
  return Array.isArray(value) && value.every((entry) => allowed.includes(entry)) && new Set(value).size === value.length;
}
function roleHeader(value: unknown): value is Record<string, unknown> & { role: string; enabled: boolean; description: string; cacheTtl?: "5m" | "1h" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const checks: { [K in keyof OrchestrationRow]-?: () => boolean } = {
    role: () => (typeof row.role === "string") && (/^[a-z][a-z0-9-]*$/.test(row.role)),
    enabled: () => typeof row.enabled === "boolean",
    description: () => typeof row.description === "string",
    cacheTtl: () => row.cacheTtl === undefined || row.cacheTtl === "5m" || row.cacheTtl === "1h",
    rows: () => true,
  };
  return Object.values(checks).every(check => check());
}
function validExecutorRow(value: unknown): value is ExecutorRow {
  if (!rosterObject(value, ["executor", "model", "efforts"])) return false;
  return (
    isExecutorId(value.executor) &&
    isExternalModel(value.model) &&
    rosterEfforts(value.efforts, EXECUTORS[value.executor as ExecutorId].efforts)
  );
}
export function isOrchestrationSettingRoster(raw: unknown): raw is OrchestrationSettingRow[] {
  return Array.isArray(raw) && raw.every(isOrchestrationSettingRow)
    && new Set(raw.map((entry) => entry.role)).size === raw.length;
}
export function orchestrationSettingRows(raw: unknown, log?: (message: string) => void): OrchestrationSettingRow[] {
  if (!Array.isArray(raw)) return [];
  let normalized = false;
  const roles = new Set<string>();
  const result: OrchestrationSettingRow[] = [];
  for (const entry of raw) {
    if (!roleHeader(entry) || roles.has(entry.role)) { normalized = true; continue; }
    roles.add(entry.role);
    const legacy = !Array.isArray(entry.rows);
    normalized ||= legacy;
    const input = legacy ? Object.values(EXECUTORS).flatMap((definition) => definition.legacy(entry)) : entry.rows as unknown[];
    const rows: ExecutorRow[] = [], used = new Set<string>();
    for (const value of input) {
      if (!value || typeof value !== "object") { normalized = true; continue; }
      const candidate = value as ExecutorRow;
      if (!isExecutorId(candidate.executor) || !isExternalModel(candidate.model) || !Array.isArray(candidate.efforts)) { normalized = true; continue; }
      const canonical = { executor: candidate.executor, model: candidate.model, efforts: canonicalExecutorEfforts(candidate.executor, candidate.efforts) };
      const row = EXECUTORS[candidate.executor].normalize(canonical, legacy);
      normalized ||= row.model !== candidate.model || row.efforts.length !== candidate.efforts.length
        || row.efforts.some((effort, index) => effort !== candidate.efforts[index])
        || Object.keys(candidate).some((key) => !["executor", "model", "efforts"].includes(key));
      if (row.model === "") { normalized = true; continue; }
      const key = `${row.executor}/${row.model}`;
      if (used.has(key) || rows.length >= 12) { normalized = true; continue; }
      used.add(key);
      rows.push(row);
    }
    result.push({ role: entry.role, enabled: entry.enabled, description: entry.description, ...(entry.cacheTtl === undefined ? {} : { cacheTtl: entry.cacheTtl }), rows });
  }
  if (normalized) log?.("R-ORC-03 R-ORC-20 R-ORC-12: normalized legacy, duplicate or invalid roster rows");
  return result;
}
export type RecommendedRosterChangeKind = "same" | "add" | "remove" | "change";
export interface RecommendedRosterChange {
  role: string;
  model: string;
  current: string[];
  recommended: string[];
  change: RecommendedRosterChangeKind;
}
function recommendedClaudeEfforts(metadata: ExternalModel | undefined, offsets: readonly number[]): OrchestrationEffort[] {
  const supported = CLAUDE_EFFORTS.filter((effort) => metadata?.supportedEffortLevels === undefined || metadata.supportedEffortLevels.includes(effort));
  const index = CLAUDE_EFFORTS.indexOf(metadata?.defaultEffort ?? "medium");
  return offsets.flatMap((offset) => {
    const target = Math.max(0, Math.min(CLAUDE_EFFORTS.length - 1, index + offset));
    const nearest = supported.reduce<OrchestrationEffort | undefined>((best, effort) => best === undefined
      || Math.abs(CLAUDE_EFFORTS.indexOf(effort) - target) < Math.abs(CLAUDE_EFFORTS.indexOf(best) - target) ? effort : best, undefined);
    return nearest === undefined ? [] : [nearest];
  });
}
export function buildRecommendedClaudeRoster(defaults: readonly OrchestrationRow[], models: readonly ExternalModel[] = []): OrchestrationSettingRow[] {
  const choices: Record<string, { model: string; offsets: number[] }> = {
    worker: { model: "opus", offsets: [-1, 0, 1] },
    reviewer: { model: "opus", offsets: [0, 1] },
    explorer: { model: "sonnet", offsets: [0] },
  };
  return defaults.flatMap((entry) => {
    const choice = choices[entry.role];
    if (!choice) return [];
    const metadata = models.find((model) => model.id === choice.model);
    const efforts = recommendedClaudeEfforts(metadata, choice.offsets);
    return [{ role: entry.role, enabled: entry.enabled, description: entry.description,
      ...(entry.cacheTtl === undefined ? {} : { cacheTtl: entry.cacheTtl }),
      rows: [{ executor: EXECUTORS.claude.id, model: choice.model, efforts: [...new Set(efforts)] }] }];
  });
}
export function recommendedOrchestrationRoster(current: readonly OrchestrationRow[], recommendation: readonly OrchestrationRow[]): OrchestrationSettingRow[] {
  const claudeRows = (entry: OrchestrationRow | undefined) => (entry?.rows ?? []).filter((row) => !isExternalExecutorId(row.executor))
    .map((row) => ({ executor: row.executor, model: row.model, efforts: [...row.efforts] }));
  const kept = current.flatMap((entry) => {
    const recommended = recommendation.find((candidate) => candidate.role === entry.role);
    const external = entry.rows.filter((row) => isExternalExecutorId(row.executor)).map((row) => ({ ...row, efforts: [...row.efforts] }));
    if (!recommended && external.length === 0 && entry.rows.length > 0) return [];
    return [{ role: entry.role, enabled: entry.enabled, description: entry.description, ...(entry.cacheTtl === undefined ? {} : { cacheTtl: entry.cacheTtl }), rows: [...claudeRows(recommended), ...external] }];
  });
  const added = recommendation.filter((candidate) => claudeRows(candidate).length > 0 && !current.some((entry) => entry.role === candidate.role))
    .map((candidate) => ({ role: candidate.role, enabled: candidate.enabled, description: candidate.description, ...(candidate.cacheTtl === undefined ? {} : { cacheTtl: candidate.cacheTtl }), rows: claudeRows(candidate) }));
  return [...kept, ...added];
}
export function recommendedRosterChanges(current: readonly OrchestrationRow[], next: readonly OrchestrationRow[]): RecommendedRosterChange[] {
  const roles = [...new Set([...current.map((entry) => entry.role), ...next.map((entry) => entry.role)])];
  return roles.flatMap((role) => {
    const before = current.find((entry) => entry.role === role)?.rows.filter((row) => !isExternalExecutorId(row.executor)) ?? [];
    const after = next.find((entry) => entry.role === role)?.rows.filter((row) => !isExternalExecutorId(row.executor)) ?? [];
    const models = [...new Set([...before.map((row) => row.model), ...after.map((row) => row.model)])];
    return models.map((model) => {
      const was = before.find((row) => row.model === model), now = after.find((row) => row.model === model);
      const currentEfforts = [...(was?.efforts ?? [])], recommendedEfforts = [...(now?.efforts ?? [])];
      const change: RecommendedRosterChangeKind = !was ? "add" : !now ? "remove"
        : currentEfforts.join("\u0000") === recommendedEfforts.join("\u0000") ? "same" : "change";
      return { role, model, current: currentEfforts, recommended: recommendedEfforts, change };
    });
  });
}
function freezeOrchestrationRole(entry: OrchestrationRow): OrchestrationRow {
  return Object.freeze({ ...entry, rows: Object.freeze(entry.rows.map((row) => Object.freeze({ ...row, efforts: Object.freeze([...row.efforts]) }))) });
}
export function resolveOrchestrationRoster(raw: unknown): { roster: readonly OrchestrationRow[]; droppedRows: readonly string[] } {
  const roster: OrchestrationRow[] = [], droppedRows: string[] = [];
  if (raw === undefined) raw = DEFAULT_ORCHESTRATION_ROSTER;
  if (!Array.isArray(raw)) return { roster: Object.freeze(roster), droppedRows: ["R-ORC-02: agents must be an array"] };
  const roles = new Set<string>();
  for (const [index, value] of raw.entries()) {
    if (!roleHeader(value) || roles.has(value.role)) droppedRows.push(`R-ORC-02: invalid or duplicate role group ${index}`);
    else roles.add(value.role);
  }
  for (const value of orchestrationSettingRows(raw, (message) => droppedRows.push(message))) {
    if (value.enabled !== true) continue;
    const entry = freezeOrchestrationRole(value);
    roster.push(entry);
    if (!orchestrationVariants([entry]).length && !orchestrationExternalTargets([entry]).length) droppedRows.push(`R-ORC-02: role ${entry.role} has no combination selected; nothing injected`);
  }
  return { roster: Object.freeze(roster), droppedRows: Object.freeze(droppedRows) };
}
function selectedEfforts(row: ExecutorRow, models?: ExternalModels): readonly (string | undefined)[] {
  if (!rowComplete(row, models)) return [];
  return row.efforts.length ? canonicalExecutorEfforts(row.executor, row.efforts) : [undefined];
}
export const AGENT_EFFORT_ARGUMENT_CLI_VERSION = "2.1.292";
export function agentEffortArgumentSupported(cliVersion: string | undefined): boolean {
  const version = (value: string | undefined) => /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? "")?.slice(1).map(Number);
  const actual = version(cliVersion), required = version(AGENT_EFFORT_ARGUMENT_CLI_VERSION)!;
  if (!actual) return false;
  const index = actual.findIndex((part, position) => part !== required[position]);
  return index < 0 || actual[index] > required[index];
}
export function defaultAgentEffort(efforts: readonly OrchestrationEffort[], defaultEffort?: OrchestrationEffort): OrchestrationEffort | undefined {
  if (defaultEffort !== undefined && efforts.includes(defaultEffort)) return defaultEffort;
  return efforts.includes("medium") ? "medium" : efforts[0];
}
export function orchestrationVariants(roster: readonly OrchestrationRow[], models?: ExternalModels) {
  return roster.filter((entry) => entry.enabled).flatMap((entry) => entry.rows.flatMap((row) => {
    const definition = EXECUTORS[row.executor];
    const choice = definition.models()?.find((choice) => choice.model === row.model);
    if (definition.kind !== "agent" || !choice) return [];
    const selected = choice.efforts.length ? selectedEfforts(row) : [undefined];
    if (!selected.length) return [];
    const efforts = selected.filter((effort): effort is OrchestrationEffort => effort !== undefined);
    const effort = defaultAgentEffort(efforts, models?.claude.state === "ok" ? models.claude.models.find((model) => model.id === row.model)?.defaultEffort : undefined);
    return [{ role: entry.role, agentKey: definition.targetKey(entry.role, row.model),
      model: row.model as "haiku" | "sonnet" | "opus", ...(effort ? { effort } : {}), efforts, description: entry.description }];
  }));
}
export function delegationEffort(variant: { readonly effort?: OrchestrationEffort }, requested: unknown, perCallEffort: boolean): OrchestrationEffort | undefined {
  return perCallEffort && variant.effort !== undefined && isOrchestrationEffort(requested) ? requested : variant.effort;
}
export function resolveOrchestrationCacheTtl(entry: Pick<OrchestrationRow, "role" | "cacheTtl">): "5m" | "1h" {
  return entry.cacheTtl ?? DEFAULT_ORCHESTRATION_ROSTER.find((candidate) => candidate.role === entry.role)?.cacheTtl ?? "5m";
}
export interface OrchestrationAgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly model: string;
  readonly effort?: OrchestrationEffort;
  readonly experimental?: { readonly cacheTtl: "1h" };
}
export function orchestrationAgents(roster: readonly OrchestrationRow[], models?: ExternalModels): Record<string, OrchestrationAgentDefinition> {
  return Object.fromEntries(orchestrationVariants(roster, models).map((variant) => [variant.agentKey, {
    name: claudeAgentName(variant.role, variant.model),
    description: variant.description, prompt: `You are the ${variant.role} agent. ${variant.description}`, model: variant.model,
    ...(variant.effort === undefined ? {} : { effort: variant.effort }),
    ...(resolveOrchestrationCacheTtl(roster.find((entry) => entry.role === variant.role)!) === "1h" ? { experimental: { cacheTtl: "1h" as const } } : {}),
  }]));
}
export interface ExternalRow {
  readonly target: string;
  readonly role: string;
  readonly enabled: boolean;
  readonly executor: ExternalExecutorId;
  readonly model: string;
  readonly effort?: string;
  readonly description: string;
}
export function externalExecutorName(executor: ExecutorId): string { return EXECUTORS[executor].displayName; }
export function orchestrationExternalTargets(roster: readonly OrchestrationRow[], models?: ExternalModels, log?: (message: string) => void): readonly ExternalRow[] {
  const excluded: string[] = [], nonWritable: string[] = [];
  const targets = roster.filter((entry) => entry.enabled).flatMap((entry) => entry.rows.flatMap((row) => {
    if (!isExternalExecutorId(row.executor)) return [];
    const executor = row.executor, definition = EXECUTORS[executor];
    if (entry.role === "worker" && !definition.writable) { nonWritable.push(`${entry.role}/${executor}@${row.model}`); return []; }
    const supported = definition.models(executorModelList(executor, models))?.find((choice) => choice.model === row.model)?.efforts;
    return selectedEfforts(row, models).flatMap((effort) => {
      const target = definition.targetKey(entry.role, row.model, effort);
      if (effort && supported && !supported.includes(effort)) { excluded.push(target); return []; }
      return [Object.freeze({ target, role: entry.role, enabled: true, executor, model: row.model, description: entry.description, ...(effort ? { effort } : {}) })];
    });
  }));
  if (nonWritable.length) log?.(`R-ORC-26: ${nonWritable.join(", ")} excluded: executor cannot edit files`);
  if (excluded.length) log?.(`R-ORC-12: ${excluded.join(", ")} excluded: effort not supported by model`);
  return Object.freeze(targets);
}
export function externalTargetKey(role: string, executor: ExternalExecutorId, model: string, effort?: string): string {
  return EXECUTORS[executor].targetKey(role, model, effort);
}
export function isExternalRows(raw: unknown): raw is ExternalRow[] {
  return Array.isArray(raw) && raw.every(isExternalRow);
}
export function estimateTokens(text: string): number {
  let asciiChars = 0, nonAsciiChars = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) asciiChars++;
    else nonAsciiChars++;
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}
export const EXTERNAL_CAPABILITIES = "Explorer and reviewer external targets are read-only and return only text. Worker Codex targets may edit files under the chosen working directory, never commit, and cannot run the build; the conductor runs checks and commits.";
export function conductorInstruction(roster: readonly OrchestrationRow[], policy: string, external = orchestrationExternalTargets(roster), deliverySection = "", perCallEffort = true, models: ExternalModels | undefined, placementLine: string): string {
  const variants = orchestrationVariants(roster, models);
  const metadata = models?.claude?.state === "ok" ? models.claude.models.find((model) => model.id === "opus") : undefined;
  const [d = "medium", up = "high"] = recommendedClaudeEfforts(metadata, [0, 1]);
  const renderedPolicy = policy.replace(/\{(d|up)\}/g, (_, key: string) => key === "d" ? d : up);
  const generated = [
    "Act as the conductor. Delegate using the exact agent key or external target. Model and Effort below are requested settings, not observations of applied values.",
    ...(perCallEffort && variants.some((variant) => variant.efforts.length)
      ? ["An agent runs at its effort unless you pass the Agent tool's effort argument; pass only a value from that agent's efforts unless the user explicitly asks for another effort or model. An effort named in the conductor policy is an explicit request to pass that argument."] : []),
    ...roster.map((entry) => JSON.stringify({ role: entry.role, description: entry.description,
      agents: variants.filter((variant) => variant.role === entry.role).map(({ agentKey, model, effort, efforts }) =>
        ({ agentKey, model, ...(effort ? { effort } : {}), ...(perCallEffort && efforts.length ? { efforts } : {}) })),
      external: external.filter((target) => target.role === entry.role).map(({ target, executor, model, effort }) => ({ target, executor: externalExecutorName(executor), model, ...(effort ? { effort } : {}) })) })),
    ...(external.length ? [`External targets (${EXTERNAL_EXECUTORS.map((definition) => definition.displayName).join(" and ")}) cost no Claude usage. ${EXTERNAL_CAPABILITIES} Call the run tool of laisora_external with the exact target key. A background launch acknowledgement means the work is still running; you can respond to new user input, but wait for its completion notification before dependent review or work.`] : []),
  ].join("\n");
  return [
    `<roster>\n${generated}\n</roster>`,
    `<knowledge_placement>\n${placementLine}\n</knowledge_placement>`,
    deliverySection ? `<model_notes>\n${deliverySection}\n</model_notes>` : "",
    policy.trim() ? `<conductor_policy>\n${renderedPolicy}\n</conductor_policy>` : "",
  ].filter(Boolean).join("\n\n");
}
export function isExternalTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 120;
}
export function isExternalModels(value: unknown): value is ExternalModels {
  if (!rosterObject(value, Object.keys(EXECUTORS))) return false;
  return Object.values(value).every(isExternalModelState);
}
export function isExternalDetection(value: unknown): value is Record<ExecutorId, ExternalDetection> {
  if (!rosterObject(value, Object.keys(EXECUTORS))) return false;
  return Object.values(value).every((entry) => {
    if (rosterObject(entry, ["state"])) return entry.state === "checking" || entry.state === "notInstalled";
    const found = entry as Record<string, unknown> | null;
    if (found && typeof found === "object" && found.state === "found") {
      return typeof found.path === "string" && (found.version === undefined || typeof found.version === "string")
        && (found.versionNote === undefined || typeof found.versionNote === "string" && /^(timeout|exit:-?\d+|empty-output)$/.test(found.versionNote))
        && Object.keys(found).every((key) => ["state", "path", "version", "versionNote"].includes(key));
    }
    return rosterObject(entry, ["state", "path", "reason"]) && entry.state === "failed" && typeof entry.path === "string"
      && typeof entry.reason === "string" && /^spawn-error:[A-Z0-9_]+$/.test(entry.reason);
  });
}

function isExternalModelState(entry: unknown): boolean {
  const checking = rosterObject(entry, ["state"]);
  const failed = rosterObject(entry, ["state", "reason"]);
  if (!checking && !failed && !rosterObject(entry, ["state", "models", ...(entry && typeof entry === "object" ? ["fetchedAt", "refresh", "refreshReason"].filter(key => key in entry) : [])])) return false;
  const row = entry as Record<string, unknown>;
  return (
    (checking ? row.state === "checking" : failed ? row.state === "failed" : row.state === "ok") &&
    (!failed || typeof row.reason === "string") &&
    (checking || failed || row.fetchedAt === undefined || typeof row.fetchedAt === "number" && Number.isFinite(row.fetchedAt) && row.fetchedAt > 0) &&
    (checking || failed || row.refresh === undefined || row.refresh === "checking" || row.refresh === "failed") &&
    (checking || failed || row.refreshReason === undefined || row.refresh === "failed" && typeof row.refreshReason === "string") &&
    (checking || failed || Array.isArray(row.models) && row.models.length <= 100 && row.models.every(isExternalModelInfo))
  );
}

function isExternalModelInfo(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return (
    isExternalModel(model.id) &&
    model.id !== "" &&
    typeof model.label === "string" &&
    (model.efforts === undefined || rosterEfforts(model.efforts, CODEX_EFFORTS)) &&
    (model.resolvedModel === undefined || typeof model.resolvedModel === "string") &&
    (model.defaultEffort === undefined || isOrchestrationEffort(model.defaultEffort)) &&
    (model.supportedEffortLevels === undefined || rosterEfforts(model.supportedEffortLevels)) &&
    Object.keys(model).every((key) => ["id", "label", "efforts", "resolvedModel", "defaultEffort", "supportedEffortLevels"].includes(key))
  );
}

function isOrchestrationSettingRow(value: unknown): boolean {
  if (!rosterObject(value, ["role", "enabled", "description", "rows", ...(value && typeof value === "object" && "cacheTtl" in value ? ["cacheTtl"] : [])])) return false;
  const checks: { [K in keyof OrchestrationSettingRow]-?: () => boolean } = {
    rows: () => (Array.isArray(value.rows)) && (value.rows.length <= 12) && (value.rows.every(validExecutorRow)) && (new Set(value.rows.map(row => `${row.executor}/${row.model}`)).size === value.rows.length),
    role: () => typeof value.role === "string" && /^[a-z][a-z0-9-]*$/.test(value.role),
    enabled: () => typeof value.enabled === "boolean",
    description: () => typeof value.description === "string",
    cacheTtl: () => value.cacheTtl === undefined || value.cacheTtl === "5m" || value.cacheTtl === "1h",
  };
  return Object.values(checks).every(check => check());
}

function isExternalRow(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.role === "string" &&
    /^[a-z][a-z0-9-]*$/.test(entry.role) &&
    typeof entry.enabled === "boolean" &&
    isExternalExecutorId(entry.executor) &&
    isExternalModel(entry.model) &&
    entry.model !== "" &&
    typeof entry.description === "string" &&
    (entry.effort === undefined ? EXECUTORS[entry.executor as ExternalExecutorId].fallbackEfforts(entry.model as string).length === 0 : EXECUTORS[entry.executor as ExternalExecutorId].efforts.includes(entry.effort as string)) &&
    entry.target === externalTargetKey(entry.role as string, entry.executor as ExternalExecutorId, entry.model as string, entry.effort as string | undefined) &&
    Object.keys(entry).every((key) => ["target", "role", "enabled", "executor", "model", "effort", "description"].includes(key))
  );
}
