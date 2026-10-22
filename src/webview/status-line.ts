import * as l10n from "@vscode/l10n";
import { agentElapsedMs, agentRunStart, flattenAgents, type WorkModelPayload } from "../protocol";
import { basename, firstLine, type ToolIntentInput } from "../tool-intent";
import { monthDayClock } from "./format";
import { EXECUTORS, isExternalRunTool, parseExternalTargetKey } from "../orchestration-executors";
import { isDelegationTool } from "../claude-tool-names";

export const TOOL_INTENT_MAX_LENGTH = 80;

function externalTargetLabel(target: string): string {
  const parsed = parseExternalTargetKey(target);
  if (!parsed) return target;
  const { role, executor, model, effort } = parsed;
  const family = executor === "codex" ? /^gpt-\d+(?:\.\d+)?-(astra|sol|luna|terra)$/.exec(model)?.[1] : undefined;
  const label = family ? family[0].toUpperCase() + family.slice(1) : `${EXECUTORS[executor].displayName} ${model}`;
  return l10n.t("{0} ({1})", [label, effort].filter(Boolean).join(" "), role);
}

export function toolIntentLabel(name: string, input: ToolIntentInput = {}): string {
  const description = input.description?.trim();
  if (isExternalRunTool(name)) {
    const task = description || firstLine(input.prompt ?? "");
    if (input.target?.trim() && task) return l10n.t("Delegating to {0}: {1}", externalTargetLabel(input.target.trim()), task);
  }
  if (isDelegationTool(name) && description) {
    const agent = input.subagent_type?.trim() || input.agent_key?.trim();
    return agent ? l10n.t("Delegating to {0}: {1}", agent, description) : l10n.t("Delegating: {0}", description);
  }
  switch (name) {
    case "Bash": case "PowerShell":
      if (description) return description;
      break;
    case "Read": if (input.file_path) return l10n.t("Reading {0}", basename(input.file_path)); break;
    case "Edit": if (input.file_path) return l10n.t("Editing {0}", basename(input.file_path)); break;
    case "Write": if (input.file_path) return l10n.t("Writing {0}", basename(input.file_path)); break;
    case "Grep": if (input.pattern) return l10n.t('Searching for "{0}"', input.pattern); break;
    case "Glob": if (input.pattern) return l10n.t('Searching for "{0}"', basename(input.pattern)); break;
    case "WebSearch": if (input.query) return l10n.t('Searching for "{0}"', input.query); break;
    case "WebFetch":
      try { if (input.url) return l10n.t("Checking {0}", new URL(input.url).host); } catch { }
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
  | { kind: "limit"; at: number }
  | { kind: "delegated"; count: number; since: number | null; declared: string | null }
  | { kind: "waiting"; count: number }
  | { kind: "none" };

export interface StatusLineInput {
  now: number;
  autoResumeAt?: number | null;
  turnState: "idle" | "running" | "interrupting";
  turnStartedAt: number | null;
  runningTool: string | null;
  intentInput?: ToolIntentInput;
  runningDelegations: readonly string[];
  workModel: WorkModelPayload | undefined;
  openYouCount: number;
  viewHasYouCount: boolean;
  declared: string | null;
}

function agentStarts(model: WorkModelPayload | undefined, now: number): Map<string, number> {
  const starts = new Map<string, number>();
  for (const agent of flattenAgents(model?.phases ?? [], model?.unlinkedAgents)) {
    const start = agent.status === "running" && agentRunStart(agent) !== undefined ? now - agentElapsedMs(agent, now) : agent.startedAt;
    if (start !== undefined && start > 0) starts.set(agent.toolUseId, start);
  }
  return starts;
}

export function deriveStatusLine(input: StatusLineInput): StatusLine {
  if (input.turnState !== "idle") {
    return { kind: "conductor", tool: input.runningTool, ...(input.intentInput ? { intentInput: input.intentInput } : {}), since: input.turnStartedAt, declared: input.declared };
  }
  if (input.autoResumeAt != null && input.now < input.autoResumeAt) {
    return { kind: "limit", at: input.autoResumeAt };
  }
  const delegates = new Map(input.runningDelegations.map(id => [id, null as number | null]));
  for (const tool of input.workModel?.planTools ?? []) {
    if (isExternalRunTool(tool.name)) delegates.set(tool.id, tool.startedAt > 0 ? tool.startedAt : null);
  }
  if (delegates.size > 0) {
    const starts = agentStarts(input.workModel, input.now);
    let since: number | null = null;
    for (const [id, toolStart] of delegates) {
      const start = starts.get(id) ?? toolStart;
      if (start !== null && (since === null || start < since)) since = start;
    }
    return { kind: "delegated", count: delegates.size, since, declared: input.declared };
  }
  if (input.openYouCount > 0 && !input.viewHasYouCount) return { kind: "waiting", count: input.openYouCount };
  return { kind: "none" };
}

export function statusLineText(line: StatusLine): string {
  switch (line.kind) {
    case "conductor":
      return line.tool === null ? l10n.t("Generating") : toolIntentLabel(line.tool, line.intentInput);
    case "delegated":
      return line.count === 1 ? l10n.t("1 delegated run in progress") : l10n.t("{0} delegated runs in progress", line.count);
    case "limit":
      return l10n.t("Waiting for usage limit reset · resumes at {0}", monthDayClock(line.at));
    case "waiting":
      return l10n.t("Waiting for your decision: {0}", line.count);
    case "none":
      return "";
  }
}
