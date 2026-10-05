import type { Options as ClaudeCodeOptions } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { buildClaudeEnv, describeSdkErrorResult } from "./claude-env";
import { RENAME_TITLE_MAX, type ApiKeyPolicy } from "./protocol";
import { resolveClaudeCodeStartup } from "./claudeCliResolver";
import * as l10n from "@vscode/l10n";

export function buildSummaryPrompt(digest: string): string {
  return [
    l10n.t("Below is an excerpt from one session's record. Summarize what this session did in 1–2 sentences (under 120 characters)."),
    l10n.t("Do not add anything that is not in the record."),
    "",
    l10n.t("--- Record excerpt ---"),
    digest,
  ].join("\n");
}

export function buildSessionNamePrompt(digest: string): string {
  return [
    l10n.t("Suggest a short session name for this conversation in its own language. Return only the name in the summary field."),
    l10n.t("Use one line, at most {0} characters, preferably under 60. Do not use quotes, explanations, or handoff arrow chains (→).", RENAME_TITLE_MAX),
    l10n.t("Do not add anything that is not in the record."),
    "",
    l10n.t("--- Record excerpt ---"),
    digest,
  ].join("\n");
}

export function sanitizeSessionName(value: string): string {
  const line = value.trim().split(/[\r\n]/, 1)[0].split("→", 1)[0].trim();
  const unquoted = line.replace(/^["'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]+|["'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]+$/gu, "").trim();
  return unquoted.slice(0, RENAME_TITLE_MAX).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}

export function buildSessionDigest(userTexts: readonly string[], toolCallCount: number, agentCount: number): string {
  const clip = (t: string): string => (t.length > 400 ? `${t.slice(0, 399)}…` : t);
  const head = userTexts.slice(0, 4).map(clip);
  const tail = userTexts.length > 8 ? userTexts.slice(-4).map(clip) : userTexts.slice(4).map(clip);
  const lines: string[] = [];
  lines.push(l10n.t("User messages: {0} / Tool executions: {1} / Subagents: {2}", userTexts.length, toolCallCount, agentCount));
  lines.push("", l10n.t("[First messages]"));
  lines.push(...head.map((t, i) => `${i + 1}. ${t}`));
  if (userTexts.length > 8) lines.push("", l10n.t("(omitted)"));
  if (tail.length > 0 && userTexts.length > 4) {
    lines.push("", l10n.t("[Recent messages]"));
    lines.push(...tail.map((t) => `- ${t}`));
  }
  return lines.join("\n");
}

export interface GenerateSessionSummaryOptions {
  modelId?: string;
  apiKeyPolicy?: ApiKeyPolicy;
  effort?: string;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  pathToClaudeCodeExecutable?: string;
  sdkClaudeCodeVersion?: string;
  resolveExecutablePath?: () => Promise<string | undefined>;
  loadSdk?: () => Pick<typeof ClaudeCodeSdk, "query">;
}

function defaultLoadSdk(): Pick<typeof ClaudeCodeSdk, "query"> {
  return require("@anthropic-ai/claude-agent-sdk") as typeof ClaudeCodeSdk;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function generateSessionSummaryViaSdk(
  opts: GenerateSessionSummaryOptions
): Promise<{ summary?: string; model?: string }> {
  if (opts.signal.aborted) return {};
  const sdk = (opts.loadSdk ?? defaultLoadSdk)();
  const resolveExecutablePath =
    opts.resolveExecutablePath ??
    (async (): Promise<string | undefined> =>
      (await resolveClaudeCodeStartup(opts.pathToClaudeCodeExecutable, opts.sdkClaudeCodeVersion)).executable.path);
  const pathToClaudeCodeExecutable = await resolveExecutablePath();
  if (opts.signal.aborted) return {};
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  let structured: unknown;
  let executedModels: string[] | undefined;
  try {
    const options: ClaudeCodeOptions = {
      tools: [],
      allowedTools: [],
      maxTurns: 2,
      permissionMode: "default",
      persistSession: false,
      cwd: opts.cwd,
      env: buildClaudeEnv(process.env, opts.apiKeyPolicy).env,
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
      abortController,
      settingSources: [],
    };
    if (opts.modelId !== undefined && opts.modelId.length > 0) {
      options.model = opts.modelId;
    }
    if (opts.effort !== undefined) {
      options.effort = opts.effort as ClaudeCodeOptions["effort"];
    }
    if (pathToClaudeCodeExecutable !== undefined) {
      options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    }
    const stream = sdk.query({ prompt: opts.prompt, options });
    for await (const message of stream) {
      if (message.type !== "result") continue;
      if (message.is_error === true) throw new Error(describeSdkErrorResult("session-summary", message));
      structured = (message as { structured_output?: unknown }).structured_output;
      const usage = (message as { modelUsage?: unknown }).modelUsage;
      if (isRecord(usage)) executedModels = Object.keys(usage);
    }
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
  }
  if (!isRecord(structured) || typeof structured.summary !== "string" || structured.summary.trim().length === 0) {
    return {};
  }
  return { summary: structured.summary.trim(), model: executedModels?.[0] ?? opts.modelId };
}
