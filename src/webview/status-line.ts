import * as l10n from "@vscode/l10n";
import type { WorkAgentNode, WorkModelPayload } from "../protocol";
import { redactAbsolutePaths } from "../path-redaction";
import { CODEX_EFFORTS, AGY_EFFORTS, EXECUTORS } from "../orchestration-executors";

export const TOOL_INTENT_MAX_LENGTH = 80;
export const EXTERNAL_RUN_TOOL_SUFFIX = "__laisora_external__run";
const INTENT_FIELDS = ["description", "subagent_type", "agent_key", "target", "prompt", "file_path", "pattern", "url", "query"] as const;
export type ToolIntentInput = Partial<Record<typeof INTENT_FIELDS[number], string>>;

export function isToolIntentInput(value: unknown): value is ToolIntentInput {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([key, field]) => (INTENT_FIELDS as readonly string[]).includes(key) && typeof field === "string");
}

const basename = (value: string): string => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
const firstLine = (value: string): string => value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";

// R-SES-12: captureToolIntentInput reads the original input before preview truncation.
export function captureToolIntentInput(name: string, input: unknown): ToolIntentInput | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const fields: readonly (typeof INTENT_FIELDS[number])[] = name.endsWith(EXTERNAL_RUN_TOOL_SUFFIX)
    ? ["target", "description", "prompt"]
    : name === "Agent" || name === "Task" ? ["description", "subagent_type", "agent_key"]
    : name === "Bash" || name === "PowerShell" ? ["description"]
    : name === "Read" || name === "Edit" || name === "Write" ? ["file_path"]
    : name === "Grep" || name === "Glob" ? ["pattern"]
    : name === "WebFetch" ? ["url"] : name === "WebSearch" ? ["query"] : [];
  const result: ToolIntentInput = {};
  for (const key of fields) {
    const value = source[key];
    if (typeof value !== "string" || !value.trim()) continue;
    result[key] = redactAbsolutePaths(key === "prompt" ? firstLine(value)
      : key === "file_path" || name === "Glob" && key === "pattern" ? basename(value) : value.trim());
  }
  return Object.keys(result).length ? result : undefined;
}

function externalTargetLabel(target: string): string {
  const match = /^([^/]+)\/([^@]+)@(.+)$/.exec(target);
  if (!match) return target;
  const [, role, executor, variant] = match;
  const efforts: readonly string[] = executor === "codex" ? CODEX_EFFORTS : executor === "agy" ? AGY_EFFORTS : [];
  const suffix = variant.slice(variant.lastIndexOf("-") + 1);
  const effort = efforts.includes(suffix) ? suffix : "";
  const model = effort ? variant.slice(0, -effort.length - 1) : variant;
  const family = executor === "codex" ? /^gpt-\d+(?:\.\d+)?-(astra|sol|luna|terra)$/.exec(model)?.[1] : undefined;
  const label = family ? family[0].toUpperCase() + family.slice(1)
    : `${executor === "codex" || executor === "agy" ? EXECUTORS[executor].displayName : executor} ${model}`;
  return l10n.t("{0} ({1})", [label, effort].filter(Boolean).join(" "), role);
}

export function toolIntentLabel(name: string, input: ToolIntentInput = {}): string {
  const description = input.description?.trim();
  if (name.endsWith(EXTERNAL_RUN_TOOL_SUFFIX)) {
    const task = description || firstLine(input.prompt ?? "");
    if (input.target?.trim() && task) return l10n.t("Delegating to {0}: {1}", externalTargetLabel(input.target.trim()), task);
  }
  switch (name) {
    case "Bash": case "PowerShell":
      if (description) return description;
      break;
    case "Agent": case "Task": {
      const agent = input.subagent_type?.trim() || input.agent_key?.trim();
      if (description) return agent ? l10n.t("Delegating to {0}: {1}", agent, description) : l10n.t("Delegating: {0}", description);
      break;
    }
    case "Read": if (input.file_path) return l10n.t("Reading {0}", basename(input.file_path)); break;
    case "Edit": if (input.file_path) return l10n.t("Editing {0}", basename(input.file_path)); break;
    case "Write": if (input.file_path) return l10n.t("Writing {0}", basename(input.file_path)); break;
    case "Grep": if (input.pattern) return l10n.t('Searching for "{0}"', input.pattern); break;
    case "Glob": if (input.pattern) return l10n.t('Searching for "{0}"', basename(input.pattern)); break;
    case "WebSearch": if (input.query) return l10n.t('Searching for "{0}"', input.query); break;
    case "WebFetch":
      try { if (input.url) return l10n.t("Checking {0}", new URL(input.url).host); } catch { /* R-SES-12: toolIntentLabel retains the generic fallback. */ }
      break;
  }
  return l10n.t("Running {0}", name);
}

export function truncateToolIntent(label: string): string {
  const characters = Array.from(label.replace(/\s+/g, " ").trim());
  return characters.length > TOOL_INTENT_MAX_LENGTH ? characters.slice(0, TOOL_INTENT_MAX_LENGTH - 1).join("") + "…" : characters.join("");
}

export type StatusLine =
  | { kind: "conductor"; tool: string | null; intentInput?: ToolIntentInput; since: number | null; declared: string | null }
  | { kind: "delegated"; count: number; since: number | null; declared: string | null }
  | { kind: "waiting"; count: number }
  | { kind: "none" };

export interface StatusLineInput {
  turnState: "idle" | "running" | "interrupting";
  turnStartedAt: number | null;
  runningTool: string | null;
  intentInput?: ToolIntentInput;
  // src/background-activity.ts#runningDelegationIds（タブの点灯と同じ材料。R-SES-02）
  runningDelegations: readonly string[];
  workModel: WorkModelPayload | undefined;
  openYouCount: number;
  declared: string | null;
}

function agentStarts(model: WorkModelPayload | undefined): Map<string, number> {
  const starts = new Map<string, number>();
  const resumes = new Map<string, number>();
  for (const entry of model?.planHistory ?? []) {
    if (entry.kind === "resume") resumes.set(entry.agentId, Math.max(resumes.get(entry.agentId) ?? 0, entry.at));
  }
  const visit = (agent: WorkAgentNode): void => {
    const start = resumes.get(agent.agentId) ?? agent.startedAt;
    if (start !== undefined && start > 0) starts.set(agent.toolUseId, start);
    agent.children.forEach(visit);
  };
  for (const phase of model?.phases ?? []) phase.agents.forEach(visit);
  (model?.unlinkedAgents ?? []).forEach(visit);
  return starts;
}

// R-SES-11: deriveStatusLine keeps declared separate from statusLineText.
export function deriveStatusLine(input: StatusLineInput): StatusLine {
  if (input.turnState !== "idle") {
    return { kind: "conductor", tool: input.runningTool, ...(input.intentInput ? { intentInput: input.intentInput } : {}), since: input.turnStartedAt, declared: input.declared };
  }
  const delegates = new Map(input.runningDelegations.map(id => [id, null as number | null]));
  for (const tool of input.workModel?.planTools ?? []) {
    if (tool.name.endsWith(EXTERNAL_RUN_TOOL_SUFFIX)) delegates.set(tool.id, tool.startedAt > 0 ? tool.startedAt : null);
  }
  if (delegates.size > 0) {
    const starts = agentStarts(input.workModel);
    let since: number | null = null;
    for (const [id, toolStart] of delegates) {
      const start = starts.get(id) ?? toolStart;
      if (start !== null && (since === null || start < since)) since = start;
    }
    return { kind: "delegated", count: delegates.size, since, declared: input.declared };
  }
  if (input.openYouCount > 0) return { kind: "waiting", count: input.openYouCount };
  return { kind: "none" };
}

export function statusLineText(line: StatusLine): string {
  switch (line.kind) {
    case "conductor":
      return line.tool === null ? l10n.t("Generating") : toolIntentLabel(line.tool, line.intentInput);
    case "delegated":
      return line.count === 1 ? l10n.t("1 delegated run in progress") : l10n.t("{0} delegated runs in progress", line.count);
    case "waiting":
      return l10n.t("Waiting for your decision: {0}", line.count);
    case "none":
      return "";
  }
}
