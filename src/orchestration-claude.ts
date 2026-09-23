import { ClaudeConversation, sdkClaudeCodeVersion, type ClaudeHostOptions } from "./claudeHost";
import { resolveClaudeCodeStartup } from "./claudeCliResolver";
import { runFailureReason } from "./orchestration-external";
import type { ExternalModel, ExternalModelsState, ExternalDetection } from "./orchestration-executors";

const CLAUDE_ALIASES = ["haiku", "sonnet", "opus"] as const;

export function claudeAliasModels(rows: readonly { id: string; resolvedModel?: string }[]): ExternalModelsState {
  const models: ExternalModel[] = CLAUDE_ALIASES.map((id) => {
    const row = rows.find((entry) => entry.id.replace(/\[1m\]$/, "") === id);
    if (!row?.resolvedModel) return { id, label: id }; // R-ORC-25: alias without version stays selectable
    const resolvedModel = row.resolvedModel.replace(/\[1m\]$/, "");
    return { id, label: `${id} — ${resolvedModel}`, resolvedModel };
  });
  const uniqueRows = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const id = row.id.replace(/\[1m\]$/, "");
    if (!uniqueRows.has(id) || row.id === id) uniqueRows.set(id, row);
  }
  const additional = [...uniqueRows.values()].map((row) => {
    const id = row.id.replace(/\[1m\]$/, "");
    return { id, label: id, resolvedModel: row.resolvedModel?.replace(/\[1m\]$/, "") };
  }).filter((row) => row.id !== "default" && !CLAUDE_ALIASES.some((alias) => alias === row.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  models.push(...additional);
  return additional.length > 0 || models.some((model) => model.resolvedModel) ? { state: "ok", models } : { state: "failed", reason: "empty-model-list" };
}

type ClaudeListOptions = Pick<ClaudeHostOptions, "apiKeyPolicy" | "claudeCodeExecutablePath">;
export async function listClaudeModels(cwd: string, log: (message: string) => void, options: ClaudeListOptions = {},
  create = (opts: ClaudeHostOptions): Pick<ClaudeConversation, "start" | "supportedModels" | "dispose"> => new ClaudeConversation(opts),
  timeoutMs = 10_000): Promise<ExternalModelsState> {
  const failed = (error: unknown): ExternalModelsState => {
    const reason = runFailureReason("model-list-failed", error);
    log(`R-ORC-25: Claude ${reason}`);
    return { state: "failed", reason };
  };
  let conv: ReturnType<typeof create>;
  try {
    conv = create({ ...options, cwd, settingSources: [], permissionMode: "default", interruptForceKillTimeoutMs: 5000,
      onApprovalRequest: async () => ({ behavior: "deny" }), onEvent: () => {}, log: () => {} });
  } catch (error) { return failed(error); }
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => { // R-ORC-25: timeout and completion both dispose; run it once
    disposing ??= conv.dispose().catch((error: unknown) => { log(`R-ORC-25: Claude dispose ${runFailureReason("dispose-failed", error)}`); });
    return disposing;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<ExternalModelsState> => {
        try {
          await conv.start();
          const result = claudeAliasModels(await conv.supportedModels());
          if (result.state === "failed") log(`R-ORC-25: Claude ${result.reason}`);
          return result;
        } catch (error) { return failed(error); }
        finally { await dispose(); }
      })(),
      new Promise<ExternalModelsState>((resolve) => {
        timer = setTimeout(() => {
          log("R-ORC-25: Claude timeout");
          void dispose();
          resolve({ state: "failed", reason: "timeout" });
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function detectClaudeExecutor(configuredPath?: string): Promise<ExternalDetection> {
  const startup = await resolveClaudeCodeStartup(configuredPath, sdkClaudeCodeVersion());
  return { state: "found", path: startup.executable.path, version: startup.version.cliVersion, ...(startup.version.cliVersion ? {} : { versionNote: "version-unavailable" }) };
}
