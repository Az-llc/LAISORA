import { ClaudeConversation, sdkClaudeCodeVersion, type ClaudeHostOptions } from "./claudeHost";
import { resolveClaudeCodeStartup } from "./claudeCliResolver";
import { runFailureReason } from "./orchestration-external";
import { resolveModelDisplayName } from "./model-display-name";
import { claudeModelIdLabel, type ExternalModel, type ExternalModelsState, type ExternalDetection } from "./orchestration-executors";

const CLAUDE_ALIASES = ["haiku", "sonnet", "opus"] as const;

export function claudeAliasModels(rows: readonly { id: string; label?: string; resolvedModel?: string }[]): ExternalModelsState {
  const rank = (row: (typeof rows)[number]) => (row.resolvedModel ? 2 : 0) + (row.id === row.id.replace(/\[1m\]$/, "") ? 1 : 0);
  const uniqueRows = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const id = row.id.replace(/\[1m\]$/, "");
    const previous = uniqueRows.get(id);
    if (!previous || rank(row) > rank(previous)) uniqueRows.set(id, row);
  }
  const listed = [...uniqueRows.entries()].map(([id, row]): ExternalModel => {
    const resolvedModel = row.resolvedModel?.replace(/\[1m\]$/, "");
    if (!resolvedModel && CLAUDE_ALIASES.some((alias) => alias === id)) return { id, label: id };
    return { id, label: resolveModelDisplayName(rows, resolvedModel ?? id) ?? id, resolvedModel };
  });
  const models = listed.filter((model) => model.id !== "default"
    || !listed.some((other) => other.id !== "default" && other.resolvedModel === model.resolvedModel));
  for (const alias of CLAUDE_ALIASES) {
    if (!models.some((model) => model.id === alias)) models.push({ id: alias, label: alias });
  }
  return models.some((model) => model.resolvedModel) || listed.some((model) => !CLAUDE_ALIASES.some((alias) => alias === model.id))
    ? { state: "ok", models } : { state: "failed", reason: "empty-model-list" };
}

export function relabelRememberedClaudeModels(models: readonly ExternalModel[]): ExternalModel[] {
  return models.map((model) => {
    const value = model.resolvedModel ?? model.id;
    return model.label === claudeModelIdLabel(value) ? { ...model, label: resolveModelDisplayName([], value) ?? model.label } : model;
  });
}

type ClaudeListOptions = Pick<ClaudeHostOptions, "apiKeyPolicy" | "claudeCodeExecutablePath">;
export async function listClaudeModels(cwd: string, log: (message: string) => void, options: ClaudeListOptions = {},
  create = (opts: ClaudeHostOptions): Pick<ClaudeConversation, "start" | "supportedModels" | "dispose"> => new ClaudeConversation(opts),
  timeoutMs = 10_000): Promise<ExternalModelsState> {
  let failureReason: string | undefined;
  const failed = (error: unknown): ExternalModelsState => {
    const code = (error as { code?: unknown } | undefined)?.code;
    const reason = failureReason ?? (code === "ENOENT" || code === "CLAUDE_CLI_NOT_FOUND" ? "not-installed" : runFailureReason("model-list-failed", error));
    log(`R-ORC-25: Claude ${reason}`);
    return { state: "failed", reason };
  };
  let stopForFailure: (result: ExternalModelsState) => void;
  const terminalFailure = new Promise<ExternalModelsState>(resolve => { stopForFailure = resolve; });
  let conv: ReturnType<typeof create>;
  try {
    conv = create({ ...options, cwd, model: "opus[1m]", settingSources: [], permissionMode: "default", interruptForceKillTimeoutMs: 5000,
      onApprovalRequest: async () => ({ behavior: "deny" }), onEvent: event => {
        if (event.kind !== "api_retry") return;
        const reason = event.errorType === "authentication_failed" ? "authentication-required"
          : event.errorType === "oauth_org_not_allowed" ? "organization-not-allowed"
          : event.errorType === "account_on_hold" ? "account-on-hold"
          : event.errorType === "verification_required" ? "verification-required"
          : event.errorType === "billing_error" ? "billing-error" : undefined;
        if (reason && !failureReason) {
          failureReason = reason;
          log(`R-ORC-39: Claude ${reason}`);
          stopForFailure({ state: "failed", reason });
        }
      }, log: () => {} });
  } catch (error) { return failed(error); }
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposing ??= conv.dispose().catch((error: unknown) => { log(`R-ORC-25: Claude dispose ${runFailureReason("dispose-failed", error)}`); });
    return disposing;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      terminalFailure.then(async result => { await dispose(); return result; }),
      (async (): Promise<ExternalModelsState> => {
        try {
          await conv.start();
          if (failureReason) return { state: "failed", reason: failureReason };
          const result = claudeAliasModels(await conv.supportedModels());
          if (failureReason) return { state: "failed", reason: failureReason };
          if (result.state === "failed") log(`R-ORC-25: Claude ${result.reason}`);
          return result;
        } catch (error) { return failed(error); }
        finally { await dispose(); }
      })(),
      new Promise<ExternalModelsState>((resolve) => {
        timer = setTimeout(() => {
          log("R-ORC-25: Claude timeout");
          void dispose().then(() => resolve({ state: "failed", reason: "timeout" }));
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function detectClaudeExecutor(configuredPath?: string): Promise<ExternalDetection> {
  try {
    const startup = await resolveClaudeCodeStartup(configuredPath, sdkClaudeCodeVersion());
    return { state: "found", path: startup.executable.path, version: startup.version.cliVersion, ...(startup.version.cliVersion ? {} : { versionNote: "version-unavailable" }) };
  } catch (error) {
    if ((error as { code?: unknown })?.code === "CLAUDE_CLI_NOT_FOUND") return { state: "notInstalled" };
    throw error;
  }
}
