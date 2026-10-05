import { PLACEMENT_LINE } from "./placement-line";
import { EXECUTORS, EXTERNAL_EXECUTORS, DEFAULT_EXECUTOR, CLAUDE_EFFORTS, CODEX_EFFORTS, canonicalExecutorEfforts,
  executorModelList, isExecutorId, isExternalExecutorId, isExternalModel, rowComplete,
  type ExecutorId, type ExecutorRow, type ExternalExecutorId, type ExternalModels, type ExternalDetection, type OrchestrationEffort } from "./orchestration-executors";
export * from "./orchestration-executors";
export interface OrchestrationRow {
  readonly role: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly rows: readonly ExecutorRow[];
}
export type OrchestrationSettingRow = OrchestrationRow;
export function emptyOrchestrationRole(role: string): OrchestrationSettingRow {
  return { role, enabled: true, description: "", rows: [] };
}
export const DEFAULT_ORCHESTRATION_ROSTER: readonly OrchestrationRow[] = Object.freeze([
  { ...emptyOrchestrationRole("worker"), description: "Implementation and mechanical edits", rows: [
    { executor: DEFAULT_EXECUTOR, model: "haiku", efforts: [] }, { executor: DEFAULT_EXECUTOR, model: "sonnet", efforts: ["low", "high"] }, { executor: DEFAULT_EXECUTOR, model: "opus", efforts: ["high"] }] },
  { ...emptyOrchestrationRole("explorer"), description: "Read-only search and fact finding", rows: [
    { executor: DEFAULT_EXECUTOR, model: "haiku", efforts: [] }, { executor: DEFAULT_EXECUTOR, model: "sonnet", efforts: ["low"] }] },
  { ...emptyOrchestrationRole("reviewer"), description: "Independent review of a finished change; reports findings, does not edit", rows: [
    { executor: DEFAULT_EXECUTOR, model: "opus", efforts: ["high"] }] },
].map(freezeOrchestrationRole));
function rosterObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function rosterEfforts(value: unknown, allowed: readonly string[] = CLAUDE_EFFORTS): boolean {
  return Array.isArray(value) && value.every((entry) => allowed.includes(entry)) && new Set(value).size === value.length;
}
function roleHeader(value: unknown): value is Record<string, unknown> & { role: string; enabled: boolean; description: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as OrchestrationRow).role === "string" && /^[a-z][a-z0-9-]*$/.test((value as OrchestrationRow).role)
    && typeof (value as OrchestrationRow).enabled === "boolean" && typeof (value as OrchestrationRow).description === "string";
}
function validExecutorRow(value: unknown): value is ExecutorRow {
  return rosterObject(value, ["executor", "model", "efforts"]) && isExecutorId(value.executor) && isExternalModel(value.model)
    && rosterEfforts(value.efforts, EXECUTORS[value.executor].efforts);
}
export function isOrchestrationSettingRoster(raw: unknown): raw is OrchestrationSettingRow[] {
  return Array.isArray(raw) && raw.every((entry) => rosterObject(entry, ["role", "enabled", "description", "rows"])
    && roleHeader(entry) && Array.isArray(entry.rows) && entry.rows.length <= 12 && entry.rows.every(validExecutorRow)
    && new Set(entry.rows.map((row) => `${row.executor}/${row.model}`)).size === entry.rows.length)
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
    result.push({ role: entry.role, enabled: entry.enabled, description: entry.description, rows });
  }
  if (normalized) log?.("R-ORC-03 R-ORC-20 R-ORC-12: normalized legacy, duplicate or invalid roster rows");
  return result;
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
export function orchestrationVariants(roster: readonly OrchestrationRow[]) {
  return roster.filter((entry) => entry.enabled).flatMap((entry) => entry.rows.flatMap((row) => {
    const definition = EXECUTORS[row.executor];
    const choice = definition.models()?.find((choice) => choice.model === row.model);
    if (definition.kind !== "agent" || !choice) return [];
    const efforts = choice.efforts.length ? selectedEfforts(row) : [undefined];
    return efforts.map((effort) => ({ role: entry.role, agentKey: definition.targetKey(entry.role, row.model, effort),
      model: row.model as "haiku" | "sonnet" | "opus", ...(effort ? { effort: effort as OrchestrationEffort } : {}), description: entry.description }));
  }));
}
export function orchestrationAgents(roster: readonly OrchestrationRow[]) {
  return Object.fromEntries(orchestrationVariants(roster).map((variant) => [variant.agentKey, {
    description: variant.description, prompt: `You are the ${variant.role} agent. ${variant.description}`, model: variant.model,
    ...(variant.effort === undefined ? {} : { effort: variant.effort }),
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
  return Array.isArray(raw) && raw.every((entry) => entry && typeof entry === "object"
    && Object.keys(entry).every((key) => ["target", "role", "enabled", "executor", "model", "effort", "description"].includes(key))
    && typeof entry.role === "string" && /^[a-z][a-z0-9-]*$/.test(entry.role) && typeof entry.enabled === "boolean"
    && isExternalExecutorId(entry.executor) && isExternalModel(entry.model) && entry.model !== "" && typeof entry.description === "string"
    && (entry.effort === undefined ? EXECUTORS[entry.executor as ExternalExecutorId].fallbackEfforts(entry.model).length === 0 : EXECUTORS[entry.executor as ExternalExecutorId].efforts.includes(entry.effort))
    && entry.target === externalTargetKey(entry.role, entry.executor, entry.model, entry.effort));
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
export function conductorInstruction(roster: readonly OrchestrationRow[], policy: string, external = orchestrationExternalTargets(roster), deliverySection = ""): string {
  const variants = orchestrationVariants(roster);
  const generated = [
    "Act as the conductor. Delegate using the exact agent key or external target. Model and Effort below are requested settings, not observations of applied values.",
    ...roster.map((entry) => JSON.stringify({ role: entry.role, description: entry.description,
      agents: variants.filter((variant) => variant.role === entry.role).map(({ agentKey, model, effort }) => ({ agentKey, model, ...(effort ? { effort } : {}) })),
      external: external.filter((target) => target.role === entry.role).map(({ target, executor, model, effort }) => ({ target, executor: externalExecutorName(executor), model, ...(effort ? { effort } : {}) })) })),
    ...(external.length ? [`External targets (${EXTERNAL_EXECUTORS.map((definition) => definition.displayName).join(" and ")}) cost no Claude usage. ${EXTERNAL_CAPABILITIES} Call the run tool of laisora_external with the exact target key. A background launch acknowledgement means the work is still running; you can respond to new user input, but wait for its completion notification before dependent review or work.`] : []),
  ].join("\n");
  const instruction = [generated, PLACEMENT_LINE, deliverySection].filter(Boolean).join("\n\n");
  return policy.trim() ? `${instruction}\n\nUser conductor policy:\n${policy}` : instruction;
}
export function isExternalTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 120;
}
export function isExternalModels(value: unknown): value is ExternalModels {
  if (!rosterObject(value, Object.keys(EXECUTORS))) return false;
  return Object.values(value).every((entry) => {
    if (rosterObject(entry, ["state"])) return entry.state === "checking";
    if (rosterObject(entry, ["state", "reason"])) return entry.state === "failed" && typeof entry.reason === "string";
    return rosterObject(entry, ["state", "models", ...(entry && typeof entry === "object" ? ["fetchedAt", "refresh", "refreshReason"].filter(key => key in entry) : [])]) && entry.state === "ok"
      && (entry.fetchedAt === undefined || typeof entry.fetchedAt === "number" && Number.isFinite(entry.fetchedAt) && entry.fetchedAt > 0)
      && (entry.refresh === undefined || entry.refresh === "checking" || entry.refresh === "failed")
      && (entry.refreshReason === undefined || entry.refresh === "failed" && typeof entry.refreshReason === "string")
      && Array.isArray(entry.models) && entry.models.length <= 100
      && entry.models.every((model) => model && typeof model === "object" && isExternalModel(model.id) && model.id !== ""
        && typeof model.label === "string" && (model.efforts === undefined || rosterEfforts(model.efforts, CODEX_EFFORTS))
        && Object.keys(model).every((key) => ["id", "label", "efforts", "resolvedModel"].includes(key))
        && (model.resolvedModel === undefined || typeof model.resolvedModel === "string"));
  });
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
