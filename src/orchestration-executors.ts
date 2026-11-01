import { redactAbsolutePaths } from "./path-redaction";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type OrchestrationEffort = typeof CLAUDE_EFFORTS[number];
export function isOrchestrationEffort(value: unknown): value is OrchestrationEffort { return (CLAUDE_EFFORTS as readonly unknown[]).includes(value); }
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffort = typeof CODEX_EFFORTS[number];
export interface ExternalModel {
  readonly id: string;
  readonly label: string;
  readonly resolvedModel?: string;
  readonly defaultEffort?: OrchestrationEffort;
  readonly supportedEffortLevels?: readonly OrchestrationEffort[];
  readonly efforts?: readonly string[];
}
export type ExternalModelList = { state: "ok"; models: readonly ExternalModel[] } | { state: "failed"; reason: string };
export type ExternalModelsState = (Extract<ExternalModelList, { state: "ok" }> & { fetchedAt?: number; refresh?: "checking" | "failed"; refreshReason?: string })
  | Extract<ExternalModelList, { state: "failed" }> | { state: "checking" };
export type ExternalModels = Record<ExecutorId, ExternalModelsState>;

export const ORCHESTRATION_PLUGIN_NAME = "laisora";
export function claudeAgentName(role: string, model: string): string {
  return `${role}-${model}`;
}

export function claudeModelIdLabel(model: string): string {
  return model.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
}

export const EXTERNAL_RUN_TOOL_SUFFIX = "__laisora_external__run";
export function isExternalRunTool(toolName: string): boolean {
  return typeof toolName === "string" && toolName.endsWith(EXTERNAL_RUN_TOOL_SUFFIX);
}

export const EXTERNAL_RUN_OUTCOMES = ["ok", "failed", "timeout", "refused", "stopped"] as const;
export type ExternalRunOutcome = typeof EXTERNAL_RUN_OUTCOMES[number];
export function isExternalRunOutcome(value: unknown): value is ExternalRunOutcome {
  return (EXTERNAL_RUN_OUTCOMES as readonly unknown[]).includes(value);
}
export function externalRunStatus(outcome: ExternalRunOutcome): "completed" | "stopped" | "failed" {
  return outcome === "ok" ? "completed" : outcome === "stopped" ? "stopped" : "failed";
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
  parseOutput?: (output: string, exitCode: number | null, stderr?: string) => { outcome: "ok" | "failed" | "refused"; answer: string; reason?: string; usage?: TokenUsage };
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
export const EXTERNAL_TIMEOUT_SETTING_KEY = "orchestration.externalTimeoutMinutes";
export const EXTERNAL_TIMEOUT_SETTING = `laisora.${EXTERNAL_TIMEOUT_SETTING_KEY}`;
export const EXTERNAL_TIMEOUT_DEFAULT_MINUTES = 10;
export const EXTERNAL_FAILURE_DETAIL_MAX = 300;
export const EXTERNAL_STDERR_TAIL_MAX = 8192;
export const CODEX_SANDBOX_SETUP_ERROR = "helper_unknown_error";
export const CODEX_SANDBOX_EXEC_FAILED = "exec_command failed:";
export const CODEX_SANDBOX_PROCESS_REJECTED = "Failed to create unified exec process";
const REDACTED = "[redacted]";
const SECRET_KEY = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|secret|password|passwd|token|authorization|cookie|credentials?|private[_-]?key|access[_-]?key)(?![A-Za-z0-9_-])`;
const SECRET_SCHEME = String.raw`(?:(?:Bearer|Basic|Token|Digest)\s+)?`;
const SECRET_ANY_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"',;]+)`;
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/(?<![\w/@:.-])[A-Za-z0-9._%+-]+:[^\s@/]+@(?=[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|localhost\b)/g, `${REDACTED}@`],
  [new RegExp(String.raw`(--?${SECRET_KEY}(?:\s+|=)${SECRET_SCHEME})${SECRET_ANY_VALUE}`, "gi"), `$1${REDACTED}`],
  [new RegExp(String.raw`((?<![A-Za-z0-9_-])${SECRET_KEY}["']?\s*[=:]\s*${SECRET_SCHEME})${SECRET_ANY_VALUE}`, "gi"), `$1${REDACTED}`],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${REDACTED}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*)/g, REDACTED],
];
export function withoutCredentials(text: string): string {
  return CREDENTIAL_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
export function externalFailureDetail(text: string | undefined, pick: "first" | "last"): string | undefined {
  const lines = (text ?? "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const line = pick === "first" ? lines[0] : lines.at(-1);
  if (!line) return undefined;
  const masked = redactAbsolutePaths(withoutCredentials(line));
  return masked.length > EXTERNAL_FAILURE_DETAIL_MAX ? `${masked.slice(0, EXTERNAL_FAILURE_DETAIL_MAX)}…` : masked;
}
export function externalFailureRecordReason(code: number | null): string {
  return `R-ORC-13: external executor failed (exit code ${code ?? "none"}).`;
}
export const EXTERNAL_REFUSED_REASON = "R-ORC-13: external executor refused the run.";
function withDetails(reason: string, reported: readonly (string | undefined)[], stderr: string | undefined): string {
  const details = [...reported.map((text) => externalFailureDetail(text, "first")),
    ...[externalFailureDetail(stderr, "last")].filter(Boolean).map((line) => `stderr: ${line}`)].filter(Boolean);
  return `${reason}${details.length ? ` ${details.join("; ")}` : ""}`;
}
export function externalFailureReason(code: number | null, reported: readonly (string | undefined)[], stderr: string | undefined): string {
  return withDetails(externalFailureRecordReason(code), reported, stderr);
}
export function externalTimeoutHint(minutes: number): string {
  return `The limit is ${EXTERNAL_TIMEOUT_SETTING} = ${minutes} minutes.`;
}
export function externalUnknownTargetReason(targets: readonly string[]): string {
  return `R-ORC-10: target is not in the conversation snapshot. Accepted targets: ${targets.length ? targets.join(", ") : "none"}.`;
}
type ExecutorRead = { answer: string; completed: boolean; failed: boolean; refused?: boolean; errors?: readonly (string | undefined)[]; usage?: TokenUsage };
function executorResult(output: string, code: number | null, stderr: string | undefined, read: (value: string) => ExecutorRead) {
  let value: ExecutorRead;
  try { value = read(output); }
  catch { value = { answer: "", completed: false, failed: true }; }
  if (value.refused) return { outcome: "refused" as const, answer: withDetails(EXTERNAL_REFUSED_REASON, value.errors ?? [], stderr), reason: EXTERNAL_REFUSED_REASON, usage: value.usage };
  const ok = code === 0 && value.completed && !value.failed && !!value.answer.trim();
  return ok ? { outcome: "ok" as const, answer: value.answer, usage: value.usage }
    : { outcome: "failed" as const, answer: externalFailureReason(code, value.errors ?? [], stderr), reason: externalFailureRecordReason(code), usage: value.usage };
}
type CodexCommandItem = { type?: unknown; status?: unknown; exit_code?: unknown; aggregated_output?: unknown };
export function codexCommandSandboxState(item: CodexCommandItem | undefined): "sandbox-failed" | "ran" | undefined {
  if (item?.type !== "command_execution") return undefined;
  const output = typeof item.aggregated_output === "string" ? item.aggregated_output.trimStart() : "";
  if (output.startsWith(CODEX_SANDBOX_EXEC_FAILED) && (output.includes(CODEX_SANDBOX_SETUP_ERROR) || output.includes(CODEX_SANDBOX_PROCESS_REJECTED))) return "sandbox-failed";
  return typeof item.exit_code === "number" ? "ran" : undefined;
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
    targetKey: (role, model, effort) => `${ORCHESTRATION_PLUGIN_NAME}:${claudeAgentName(role, model)}${effort ? `-${effort}` : ""}`,
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
    parseOutput: (output, code, stderr) => executorResult(output, code, stderr, (text) => {
      const value = JSON.parse(text);
      return { completed: typeof value.status === "string" && value.status.toUpperCase() === "SUCCESS", failed: !!value.error,
        refused: value.status === "refused" || value.status === "permission_denied",
        errors: [typeof value.error === "string" ? value.error : typeof value.error?.message === "string" ? value.error.message : undefined],
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
    parseOutput: (output, code, stderr) => executorResult(output, code, stderr, (text) => {
      let answer = "", completed = false, failed = false, error: string | undefined, sandboxFailed = false, usage: TokenUsage | undefined;
      for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
        const value = JSON.parse(line);
        if (value.type === "turn.completed") { completed = true; usage = tokenUsage(value.usage); }
        if (value.type === "turn.failed") { failed = true; if (typeof value.error?.message === "string") error = value.error.message; }
        if (value.type === "error" && typeof value.message === "string") error = value.message;
        const command = value.type === "item.completed" ? codexCommandSandboxState(value.item) : undefined;
        if (command) sandboxFailed = command === "sandbox-failed";
        if (value.type === "item.completed" && value.item?.type === "agent_message") answer = typeof value.item.text === "string" ? value.item.text : "";
      }
      return { answer, completed, failed: failed || sandboxFailed, usage,
        errors: [error, sandboxFailed ? "Codex could not start commands in its sandbox" : undefined] };
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

export interface ExternalTarget { role: string; executor: ExternalExecutorId; model: string; effort?: string }

export function parseExternalTargetKey(target: string): ExternalTarget | undefined {
  const match = /^([^/]+)\/([^@]+)@(.+)$/.exec(target.trim());
  if (!match || !isExternalExecutorId(match[2])) return undefined;
  const [, role, executor, variant] = match;
  const efforts: readonly string[] = executor === "codex" ? CODEX_EFFORTS : AGY_EFFORTS;
  const suffix = variant.slice(variant.lastIndexOf("-") + 1);
  const effort = efforts.includes(suffix) ? suffix : undefined;
  return { role, executor: executor as ExternalExecutorId, model: effort ? variant.slice(0, -effort.length - 1) : variant, ...(effort ? { effort } : {}) };
}
