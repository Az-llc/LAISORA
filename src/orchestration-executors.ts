export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type OrchestrationEffort = typeof CLAUDE_EFFORTS[number];
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffort = typeof CODEX_EFFORTS[number];
export interface ExternalModel {
  readonly id: string;
  readonly label: string;
  readonly resolvedModel?: string;
  readonly efforts?: readonly string[];
}
export type ExternalModelList = { state: "ok"; models: readonly ExternalModel[] } | { state: "failed"; reason: string };
export type ExternalModelsState = (Extract<ExternalModelList, { state: "ok" }> & { fetchedAt?: number; refresh?: "checking" | "failed"; refreshReason?: string })
  | Extract<ExternalModelList, { state: "failed" }> | { state: "checking" };
export type ExternalModels = Record<ExecutorId, ExternalModelsState>;

export function claudeModelIdLabel(model: string): string {
  return model.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
}

export const EXTERNAL_RUN_TOOL_SUFFIX = "__laisora_external__run";
export function isExternalRunTool(toolName: string): boolean {
  return toolName.endsWith(EXTERNAL_RUN_TOOL_SUFFIX);
}

export const AGY_EFFORTS = ["low", "medium", "high"] as const;
export function splitAgyModel(id: string): { model: string; effort: string } {
  const at = id.lastIndexOf("-");
  const effort = id.slice(at + 1);
  return at > 0 && (AGY_EFFORTS as readonly string[]).includes(effort)
    ? { model: id.slice(0, at), effort } : { model: id, effort: "" };
}
export function agyModelChoices(list?: ExternalModelsState): Array<{ model: string; efforts: string[] }> {
  if (list?.state !== "ok") return [];
  const choices = new Map<string, Set<string>>();
  for (const entry of list.models) {
    const { model, effort } = splitAgyModel(entry.id);
    const efforts = choices.get(model) ?? new Set<string>();
    efforts.add(effort);
    choices.set(model, efforts);
  }
  return Array.from(choices, ([model, efforts]) => ({ model, efforts: AGY_EFFORTS.filter((effort) => efforts.has(effort)) }));
}

export type ExecutorId = "claude" | "agy" | "codex";
export type ExternalExecutorId = Exclude<ExecutorId, "claude">;
export type TokenUsage = Readonly<Record<string, number>>;
export interface ExecutorModelChoice { model: string; label?: string; efforts: readonly string[] }
export interface ExecutorRow { readonly executor: ExecutorId; readonly model: string; readonly efforts: readonly string[] }
export interface ExecutorCapture { output: string; code: number | null; timeout: boolean; reason?: string; spawnCode?: string }
export interface ExecutorProbe {
  path: string;
  capture(args: string[]): Promise<ExecutorCapture>;
  rpc(args: string[], initialize: object, initialized: object, method: string,
    parse: (value: unknown) => ExternalModelList & { nextCursor?: string | null }): Promise<ExternalModelList>;
  version: string;
}
export type ExternalDetection = { state: "checking" } | { state: "notInstalled" }
  | { state: "failed"; path: string; reason: string } | { state: "found"; path: string; version?: string; versionNote?: string };
export interface ExecutorDefinition {
  id: ExecutorId;
  displayName: string;
  kind: "agent" | "external";
  writable: boolean;
  efforts: readonly string[];
  models(list?: ExternalModelsState): ExecutorModelChoice[] | undefined;
  fallbackEfforts(model: string): readonly string[];
  normalize(row: ExecutorRow, legacy: boolean): ExecutorRow;
  legacy(entry: Record<string, unknown>): ExecutorRow[];
  targetKey(role: string, model: string, effort?: string): string;
  localPath?: readonly string[];
  preamble?: string;
  argv?: (model: string, effort: string | undefined, cwd: string, minutes: number, prompt: string, role: string) => string[];
  parseOutput?: (output: string, exitCode: number | null) => { outcome: "ok" | "failed" | "refused"; answer: string; usage?: TokenUsage };
  detect?: (probe: ExecutorProbe) => Promise<ExternalDetection>;
  listModels?: (probe: ExecutorProbe) => Promise<ExternalModelList>;
}
export function isExecutorId(value: unknown): value is ExecutorId {
  return typeof value === "string" && Object.hasOwn(EXECUTORS, value);
}
export function isExternalExecutorId(value: unknown): value is ExternalExecutorId {
  return isExecutorId(value) && EXECUTORS[value].kind === "external";
}
export function isExternalModel(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value));
}
function legacyEntries(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : value ? [value] : []).filter((row) => row && typeof row === "object");
}
function legacyEfforts(value: unknown): string[] { return Array.isArray(value) ? value.filter((effort): effort is string => typeof effort === "string") : []; }
async function detectVersion(probe: ExecutorProbe): Promise<ExternalDetection> {
  const result = await probe.capture(["--version"]);
  const reason = result.timeout ? "timeout" : result.spawnCode ? `spawn-error:${result.spawnCode}`
    : result.code !== 0 ? `exit:${result.code ?? -1}` : !result.output.trim() ? "empty-output" : undefined;
  if (result.spawnCode) return { state: "failed", path: probe.path, reason: `spawn-error:${result.spawnCode}` };
  return reason ? { state: "found", path: probe.path, versionNote: reason } : { state: "found", path: probe.path, version: result.output.trim() };
}
function executorResult(output: string, code: number | null, read: (value: string) => { answer: string; completed: boolean; failed: boolean; refused?: boolean; usage?: TokenUsage }) {
  let value: ReturnType<typeof read>;
  try { value = read(output); }
  catch { value = { answer: "", completed: false, failed: true }; }
  const ok = code === 0 && value.completed && !value.failed && !!value.answer.trim();
  return { outcome: value.refused ? "refused" as const : ok ? "ok" as const : "failed" as const,
    answer: ok ? value.answer : "External executor failed.", usage: value.usage };
}
export function tokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entries = Object.entries(raw).filter(([key, value]) =>
    ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "total_tokens", "thinking_tokens", "cache_read_tokens"].includes(key)
    && typeof value === "number" && Number.isFinite(value) && value >= 0);
  return entries.length ? Object.freeze(Object.fromEntries(entries)) as TokenUsage : undefined;
}

export function parseAgyModels(output: string): ExternalModelList {
  const models: ExternalModel[] = [];
  for (const line of output.split(/\r?\n/).filter((entry) => entry.includes("\t"))) {
    const id = line.split("\t")[0];
    if (!id || !isExternalModel(id) || models.some((model) => model.id === id)) continue;
    models.push({ id, label: id });
    if (models.length === 100) break;
  }
  return models.length ? { state: "ok", models } : { state: "failed", reason: "empty-model-list" };
}

export function parseCodexModels(result: unknown): (ExternalModelList & { nextCursor?: string | null }) {
  if (!result || typeof result !== "object") return { state: "failed", reason: "invalid-model-list" };
  const page = result as Record<string, unknown>;
  if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
    return { state: "failed", reason: "invalid-model-list" };
  }
  const models: ExternalModel[] = [];
  for (const item of page.data) {
    if (!item || !item.id || !isExternalModel(item.id) || models.some((model) => model.id === item.id)) continue;
    if (!Array.isArray(item.supportedReasoningEfforts) || !item.supportedReasoningEfforts.every((effort: unknown) =>
      effort && typeof effort === "object" && typeof (effort as Record<string, unknown>).reasoningEffort === "string")) {
      return { state: "failed", reason: "invalid-model-efforts" };
    }
    models.push({ id: item.id, label: typeof item.displayName === "string" ? item.displayName : item.id,
      efforts: CODEX_EFFORTS.filter((effort) => item.supportedReasoningEfforts.some((value: { reasoningEffort: string }) => value.reasoningEffort === effort)) });
    if (models.length === 100) break;
  }
  return { state: "ok", models, nextCursor: page.nextCursor };
}


export const EXECUTORS: Record<ExecutorId, ExecutorDefinition> = {
  claude: {
    id: "claude", writable: true, displayName: "Claude", kind: "agent", efforts: CLAUDE_EFFORTS,
    models: (list) => list?.state === "ok"
      ? list.models.map(({ id, label }) => ({ model: id, label, efforts: id === "haiku" ? [] : CLAUDE_EFFORTS }))
      : ["haiku", "sonnet", "opus"].map((model) => ({ model, efforts: model === "haiku" ? [] : CLAUDE_EFFORTS })),
    fallbackEfforts: (model) => model === "haiku" ? [] : CLAUDE_EFFORTS,
    normalize: (row) => ({ ...row, efforts: row.model === "haiku" ? [] : row.efforts }),
    legacy: (entry) => [
      ...(entry.haiku === true ? [{ executor: "claude" as const, model: "haiku", efforts: [] }] : []),
      ...["sonnet", "opus"].filter((model) => legacyEfforts(entry[model]).length).map((model) => ({ executor: "claude" as const, model, efforts: legacyEfforts(entry[model]) })),
      ...(typeof entry.model === "string" && ["haiku", "sonnet", "opus"].includes(entry.model)
        ? [{ executor: "claude" as const, model: entry.model, efforts: entry.model === "haiku" ? [] : typeof entry.effort === "string" ? [entry.effort] : [] }] : []),
    ],
    targetKey: (role, model, effort) => `laisora-${role}-${model}${effort ? `-${effort}` : ""}`,
  },
  agy: {
    id: "agy", writable: false, displayName: "Antigravity", kind: "external", efforts: AGY_EFFORTS,
    models: (list) => list?.state === "ok" ? agyModelChoices(list) : undefined,
    fallbackEfforts: () => [],
    normalize: (row, legacy) => { if (!legacy) return row; const split = splitAgyModel(row.model); return { ...row, model: split.model, efforts: split.effort ? [split.effort] : row.efforts }; },
    legacy: (entry) => legacyEntries(entry.agy).filter((row) => row.use !== false).map((row) => ({ executor: "agy", model: typeof row.model === "string" ? row.model : "", efforts: typeof row.effort === "string" && row.effort ? [row.effort] : [] })),
    targetKey: (role, model, effort) => `${role}/agy@${model}${effort ? `-${effort}` : ""}`,
    localPath: ["agy", "bin"], detect: detectVersion,
    preamble: "You are a read-only reviewer. The command tool is unavailable and fails immediately. Do not list or search directories. Read only the absolute file paths listed below.",
    argv: (model, effort, cwd, minutes, prompt) => ["--add-dir", cwd, "--print-timeout", `${minutes}m`, "--output-format", "json", "--model", `${model}${effort ? `-${effort}` : ""}`, `--print=${prompt}`],
    parseOutput: (output, code) => executorResult(output, code, (text) => {
      const value = JSON.parse(text);
      return { completed: typeof value.status === "string" && value.status.toUpperCase() === "SUCCESS", failed: !!value.error,
        refused: value.status === "refused" || value.status === "permission_denied",
        answer: [value.result, value.response, value.answer, value.text, value.output].find((entry) => typeof entry === "string") ?? "", usage: tokenUsage(value.usage) };
    }),
    listModels: async (probe) => {
      const result = await probe.capture(["models"]);
      if (result.timeout || result.code !== 0 || result.reason || result.output.length > 1_000_000) return { state: "failed", reason: result.timeout ? "timeout" : result.spawnCode === "ENOENT" ? "not-installed" : "model-list-failed" };
      return parseAgyModels(result.output);
    },
  },
  codex: {
    id: "codex", writable: true, displayName: "Codex", kind: "external", efforts: CODEX_EFFORTS,
    models: (list) => list?.state === "ok" ? list.models.map((model) => ({ model: model.id, efforts: model.efforts ?? CODEX_EFFORTS })) : undefined,
    fallbackEfforts: () => CODEX_EFFORTS, normalize: (row) => row,
    legacy: (entry) => legacyEntries(entry.codex).map((row) => ({ executor: "codex", model: typeof row.model === "string" ? row.model : "", efforts: legacyEfforts(row.efforts) })),
    targetKey: (role, model, effort) => `${role}/codex@${model}-${effort}`,
    localPath: ["Programs", "OpenAI", "Codex", "bin"], detect: detectVersion,
    preamble: "You are a read-only reviewer. Review the supplied task and files without modifying files.",
    argv: (model, effort, _cwd, _minutes, prompt, role) => ["exec", "--skip-git-repo-check", "-s", role === "worker" ? "workspace-write" : "read-only", "-m", model, "-c", `model_reasoning_effort=${effort}`, "--json", prompt],
    parseOutput: (output, code) => executorResult(output, code, (text) => {
      let answer = "", completed = false, failed = false, usage: TokenUsage | undefined;
      for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
        const value = JSON.parse(line);
        if (value.type === "turn.completed") { completed = true; usage = tokenUsage(value.usage); }
        if (value.type === "turn.failed") failed = true;
        if (value.type === "item.completed" && value.item?.type === "agent_message") answer = typeof value.item.text === "string" ? value.item.text : "";
      }
      return { answer, completed, failed, usage };
    }),
    listModels: (probe) => probe.rpc(["app-server"], { method: "initialize", params: { clientInfo: { name: "laisora", title: "LAISORA", version: probe.version } } }, { method: "initialized" }, "model/list", parseCodexModels),
  },
};
export const EXTERNAL_EXECUTORS = Object.values(EXECUTORS).filter((definition): definition is ExecutorDefinition & { id: ExternalExecutorId } => definition.kind === "external");
export const DEFAULT_EXECUTOR = Object.values(EXECUTORS).find((definition) => definition.kind === "agent")!.id;
export function executorModelList(executor: ExecutorId, lists?: ExternalModels): ExternalModelsState | undefined {
  return lists?.[executor];
}
export function modelSelectionState(executor: ExecutorId, list: ExternalModelsState | undefined, detection: ExternalDetection) {
  const missing = detection.state === "notInstalled";
  return {
    choices: EXECUTORS[executor].models(list),
    checking: executor !== "claude" && list?.state !== "ok" && (detection.state === "checking" || list?.state === "checking"),
    manual: executor !== "claude" && (missing || list?.state !== "ok"),
    refreshFailed: !missing && (list?.state === "failed" || list?.state === "ok" && list.refresh === "failed"),
  };
}
export function rowEfforts(row: ExecutorRow, lists?: ExternalModels): readonly string[] {
  const definition = EXECUTORS[row.executor];
  return definition.models(executorModelList(row.executor, lists))?.find((choice) => choice.model === row.model)?.efforts ?? (row.efforts.length ? definition.efforts : definition.fallbackEfforts(row.model));
}
export function rowComplete(row: ExecutorRow, lists?: ExternalModels): boolean {
  return !!row.model && (row.efforts.length > 0
    || rowEfforts(row, lists).length === 0 && EXECUTORS[row.executor].fallbackEfforts(row.model).length === 0);
}
export function canonicalExecutorEfforts(executor: ExecutorId, efforts: readonly string[]): string[] {
  return EXECUTORS[executor].efforts.filter((effort) => efforts.includes(effort));
}

export function externalExecutorMap<T>(value: (executor: ExternalExecutorId) => T): Record<ExternalExecutorId, T> {
  return Object.fromEntries(EXTERNAL_EXECUTORS.map(({ id }) => [id, value(id)])) as Record<ExternalExecutorId, T>;
}

export function executorMap<T>(value: (executor: ExecutorId) => T): Record<ExecutorId, T> {
  return Object.fromEntries(Object.values(EXECUTORS).map(({ id }) => [id, value(id)])) as Record<ExecutorId, T>;
}
