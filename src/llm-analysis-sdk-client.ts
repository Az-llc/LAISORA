import type { Options as ClaudeCodeOptions } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type { LlmAnalysisClient, LlmAnalysisGenerateResult, LlmAnalysisRequest } from "./llm-analysis-client";
import { llmFindingsJsonSchema } from "./llm-analysis-client";
import { llmAnalysisSystemPrompt } from "./llm-analysis-prompt";
import { resolveClaudeCodeStartup } from "./claudeCliResolver";
import { buildClaudeEnv, describeSdkErrorResult } from "./claude-env";
import type { ApiKeyPolicy } from "./protocol";

export interface SdkLlmAnalysisClientDeps {
  loadSdk: () => Pick<typeof ClaudeCodeSdk, "query">;
  resolveExecutablePath: () => Promise<string | undefined>;
}

export interface SdkLlmAnalysisClientOptions {
  modelId: string;
  effort?: string;
  cwd: string;
  claudeCodeExecutablePath?: string;
  sdkClaudeCodeVersion?: string;
  // 省略時は buildClaudeEnv の既定（subscriptionOnly）に倒れる（R-GW-05）
  apiKeyPolicy?: ApiKeyPolicy;
  deps?: Partial<SdkLlmAnalysisClientDeps>;
}

function defaultLoadSdk(): Pick<typeof ClaudeCodeSdk, "query"> {
  return require("@anthropic-ai/claude-agent-sdk") as Pick<typeof ClaudeCodeSdk, "query">;
}

async function defaultResolveExecutablePath(
  configuredPath: string | undefined,
  sdkVersion: string | undefined
): Promise<string | undefined> {
  const startup = await resolveClaudeCodeStartup(configuredPath, sdkVersion);
  return startup.executable.path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class SdkLlmAnalysisClient implements LlmAnalysisClient {
  readonly modelId: string;
  readonly effort: string | undefined;
  private readonly cwd: string;
  private readonly claudeCodeExecutablePath: string | undefined;
  private readonly sdkClaudeCodeVersion: string | undefined;
  private readonly apiKeyPolicy: ApiKeyPolicy | undefined;
  private readonly deps: Partial<SdkLlmAnalysisClientDeps> | undefined;

  constructor(options: SdkLlmAnalysisClientOptions) {
    if (options.modelId.trim() === "") {
      throw new Error("SdkLlmAnalysisClient: modelId must not be blank");
    }
    if (options.cwd.trim() === "") {
      throw new Error("SdkLlmAnalysisClient: cwd must not be blank");
    }
    this.modelId = options.modelId.trim();
    this.effort = options.effort;
    this.cwd = options.cwd;
    this.claudeCodeExecutablePath = options.claudeCodeExecutablePath;
    this.sdkClaudeCodeVersion = options.sdkClaudeCodeVersion;
    this.apiKeyPolicy = options.apiKeyPolicy;
    this.deps = options.deps;
  }

  async generate(request: LlmAnalysisRequest): Promise<LlmAnalysisGenerateResult> {
    if (request.signal.aborted) return { output: undefined };

    const loadSdk = this.deps?.loadSdk ?? defaultLoadSdk;
    const resolveExecutablePath =
      this.deps?.resolveExecutablePath ??
      ((): Promise<string | undefined> =>
        defaultResolveExecutablePath(this.claudeCodeExecutablePath, this.sdkClaudeCodeVersion));

    const abortController = new AbortController();
    const onAbort = (): void => {
      abortController.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    let structuredOutput: unknown = undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined = undefined;
    let models: string[] | undefined = undefined;
    let stream: ReturnType<typeof ClaudeCodeSdk.query> | undefined;

    try {
      const sdk = loadSdk();
      const pathToClaudeCodeExecutable = await resolveExecutablePath();
      if (request.signal.aborted) return { output: undefined };

      const options: ClaudeCodeOptions = {
        tools: [],
        allowedTools: [],
        maxTurns: 2,
        permissionMode: "default",
        persistSession: false,
        includePartialMessages: true,
        cwd: this.cwd,
        env: buildClaudeEnv(process.env, this.apiKeyPolicy).env, // R-GW-05
        outputFormat: {
          type: "json_schema",
          schema: llmFindingsJsonSchema(),
        },
        abortController,
        settingSources: [],
        // R-ANL-02: 分析対象外の coding preset・作業環境を分析指示へ混ぜない。
        systemPrompt: llmAnalysisSystemPrompt(request.outputLanguage),
      };
      if (this.modelId.length > 0) {
        options.model = this.modelId;
      }
      if (this.effort !== undefined) {
        options.effort = this.effort as ClaudeCodeOptions["effort"];
      }
      if (pathToClaudeCodeExecutable !== undefined) {
        options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
      }

      stream = sdk.query({
        prompt: request.prompt,
        options,
      });

      for await (const message of stream) {
        if (request.signal.aborted) break;
        // SDK の管理通知や接続維持だけでは、LLM が生成を進めた証拠にならない。
        if (
          message.type === "assistant" ||
          (message.type === "stream_event" &&
            ["message_start", "content_block_start", "content_block_delta",
              "content_block_stop", "message_delta", "message_stop"].includes(message.event.type))
        ) {
          request.onActivity?.();
        }
        if (message.type !== "result") continue;
        if (message.is_error === true) {
          throw new Error(describeSdkErrorResult("SdkLlmAnalysisClient", message));
        }
        structuredOutput = (message as { structured_output?: unknown }).structured_output;
        if (message.usage) {
          const inTok =
            (message.usage.input_tokens ?? 0) +
            (message.usage.cache_read_input_tokens ?? 0) +
            (message.usage.cache_creation_input_tokens ?? 0);
          const outTok = message.usage.output_tokens ?? 0;
          usage = { inputTokens: inTok, outputTokens: outTok };
        }
        if (message.modelUsage && isRecord(message.modelUsage)) {
          models = Object.keys(message.modelUsage);
        }
        // result がターンの完了通知。後続の管理通知やプロセス終端を待たない。
        break;
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      stream?.close?.();
    }

    if (!isRecord(structuredOutput) || !("findings" in structuredOutput)) {
      return { output: undefined, usage, models };
    }
    return { output: structuredOutput.findings, usage, models };
  }
}

export function createSdkLlmAnalysisClient(options: SdkLlmAnalysisClientOptions): LlmAnalysisClient {
  return new SdkLlmAnalysisClient(options);
}
