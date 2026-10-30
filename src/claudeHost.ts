import { UsageLimitResume, SDK_AUTO_CONTINUE_SETTINGS } from "./usage-limit-resume";
import { readClaudeCodeSettings, onAutoContinueSettingChange } from "./claude-code-settings";
import type { TranscriptRetentionSettings } from "./transcript-retention";
import { modelLabelWithVersion } from "./model-display-name";
export { modelLabelWithVersion } from "./model-display-name";
import { appendRunRecord, externalDescription, isExternalTimeout, observeAgentRun, runExternal, runFailureReason, type ExternalRow, type OrchestrationRunRecord, type AgentRunRecord } from "./orchestration-external";

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { prepareOrchestrationPlugin } from "./orchestration-plugin";
import * as l10n from "@vscode/l10n";

declare const __LAISORA_SDK_CLAUDE_CODE_VERSION__: string | undefined;

export function sdkClaudeCodeVersion(): string | undefined {
  return typeof __LAISORA_SDK_CLAUDE_CODE_VERSION__ === "string"
    ? __LAISORA_SDK_CLAUDE_CODE_VERSION__
    : undefined;
}
import type {
  Options as ClaudeCodeOptions,
  PermissionResult as ClaudeCodePermissionResult,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import type { HandoffContextMeasurement } from "./handoff-envelope";
import type {
  AskUserQuestionSpec,
  EventProvenance,
  ImageAttachment,
  NormalizedEventBody,
  UsageSnapshot,
} from "./protocol";
import { summarizeToolInput, type ApiKeyPolicy, type BridgeConnection } from "./protocol";
import { bridgeStateOf, enableRemoteControl, type RemoteControlSession } from "./remote-control";
import { resolveClaudeCodeExecutable } from "./claudeCliResolver";
import {
  buildClaudeEnv,
  claudeConfigDir,
  envNameKey,
} from "./claude-env";
import { PROGRESS_PROTOCOL_SPEC_PP1 } from "./progress-protocol";
import { checkEnvelopeRedaction } from "./send-boundary";
import { admitHandoffNoticeSend, admitReportSend, admitSteeringSend, handoffNoticeCardText, type HandoffNoticeFacts, type SteeringAdmission } from "./steering-envelope";

export type SteeringSendResult = SteeringAdmission;
import type { ProgressTrackingMode } from "./progress-protocol";
import { PROGRESS_WIRE_TOOL_NAME } from "./artifact-access";
import { FILE_WRITING_TOOLS } from "./file-writing-tools";
import { z } from "zod";
import { ClaudeLiveNormalizer, parseAliases, type RawToolResult } from "./claude-normalizer";
import { conductorInstruction, handbackGateVerdict, SUBAGENT_HANDBACK_TOOL, orchestrationExternalTargets, orchestrationVariants, resolveOrchestrationRoster, type OrchestrationRow, type ExternalModels } from "./orchestration-roster";
import { attributeSubagent, injectionOf, MAX_AGENT_STARTS, readRosterEvidence, type AgentStartObservation, type InjectedAgentDefinition, type RosterEvidence, type RosterInjection } from "./roster-evidence";
import { placementOf, DELEGATE_PLACEMENT_NOTICE, type Placement } from "./placement-line";
import { laisoraDenialMessage } from "./tool-result-signals";
import { failClosedGuard } from "./guard-evaluation";
import { isShellTool } from "./shell-tools";
import { compileVocabulary, PLACEMENT_EFFORT_WORDS, placementPath, protectedDestination, isControlFile, DELEGATE_CONTROL_REFUSAL, judgeFileWrite, judgeMemoryWrite, memoryGuardReason, type MemoryDecision, judgeShellWrite, PLACEMENT_GUARD_REFUSAL, PLACEMENT_UNREADABLE_REFUSAL } from "./placement-guard";
import { RootGate } from "./root-gate";
import { laisoraInputLine, markLaisoraInput, type LaisoraInput } from "./laisora-input";
import { createTodoMcpServer, TODO_ROOT_SCOPE, TODO_SERVER_NAME, TODO_TOOL_NAMES, todoLinkedInstruction, todoWorkspaceRoots, type TodoLinkedItem } from "./todo-mcp";
import type { TodoStore } from "./todo-store";
import { claudeModelIdLabel, isExternalRunTool } from "./orchestration-executors";
import { isDelegationLaunchTool, isDelegationTool } from "./claude-tool-names";
import type { CompletionVerdict, NumberedLaunchVerdict, ResumeVerdict } from "./time-buckets";
import { planItemLabel, type PlanStepUpdate } from "./plan-steps";
import { AgentAttribution } from "./orchestration-attribution";
import type { NormalizedOutMeta } from "./claude-normalizer";
import { askQualityDenial, rejectedAskTitles } from "./markdown-ast";

type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type SDKUserMessage = {
  type: "user";
  message: { role: "user"; content: UserContentBlock[] };
  parent_tool_use_id: string | null;
  session_id: string;
  shouldQuery?: boolean;
  isMeta?: boolean;
  uuid: string;
};

type PermissionResult = ClaudeCodePermissionResult;

type InterruptReceipt = { still_queued?: string[]; cancelled?: string[] };

const CAP_INTERRUPT_CANCEL_QUEUED = "interrupt_cancel_queued_v1";
const TODO_RECENT_FILES = 20;
export const REPLAY_USER_MESSAGES_ARG = "replay-user-messages";

export const FILE_LINK_INSTRUCTION = (cwd = ""): string => {
  const base = cwd
    ? `Relative targets resolve against the conversation folder ${JSON.stringify(cwd.replace(/\\/g, "/"))}, fixed at conversation start, not against the shell's current directory. Use absolute paths for files outside this folder.`
    : "The conversation working directory is unknown; use absolute paths.";
  return `When you mention a local file or folder, write it as a Markdown link. The link target is the absolute path or the path relative to the ${cwd ? "conversation folder" : "working directory"}, with forward slashes, optionally followed by #L<line> or #L<line>C<column>. ${base} Use the path and line as the link text, for example [src/app.ts:42](src/app.ts#L42) or [app.ts](C:/work/src/app.ts). Folders end with a slash: [artifacts/](artifacts/). Files such as spreadsheets, documents and PDFs are linked the same way and open in their default app. If the path contains spaces, wrap the target in angle brackets: [notes.md](<docs/my notes.md>). Write web URLs with the https:// scheme.`;
};

export const ASK_DECIDE_FORMAT = () => [
  l10n.t("Use a fenced code block whose language is exactly laisora-ask. Use the user's language for values. This is a strict YAML-like subset: one nonempty scalar key: value per line; no comments, multiline scalars, nesting, aliases or flow collections. Plain text and JSON double-quoted strings are supported; a plain value must not start with |, >, &, * or ! (use a JSON double-quoted string instead). Keys are unique. List entries use exactly two spaces before '- ' and four spaces before subsequent keys."),
  l10n.t("A decision requires kind, title, why, options and default. Every option requires label, effect, pros and cons; mark your recommended option with recommended: true and cite in its effect the fact it rests on. Other options omit recommended."),
  l10n.t("```laisora-ask\nkind: decide\ntitle: What should we choose?\nwhy: Observed: 3 of 5 runs failed (run.log). Question: retry or skip? You decide because it changes your workflow.\noptions:\n  - label: First choice\n    effect: What changes on your screen or in your work; the fact behind the recommendation.\n    pros: Benefit versus the others, including other features.\n    cons: Drawback versus the others, including other features.\n    recommended: true\n  - label: Second choice\n    effect: What changes for you.\n    pros: Benefit versus the first.\n    cons: Drawback versus the first.\ndefault: Without an answer, I will continue with A.\n```"),
].join("\n");

const PLAN_IN_PROGRESS_FIRST = "mark the step in_progress with TaskUpdate first, either in an earlier message or earlier in the same message";
const PLAN_RESUMED_AGENT_PLACE = "A resumed agent stays on the step it started on";
const PLAN_COMPLETION_WAIT = "wait for them to finish or stop them with TaskStop";

export const PLAN_INSTRUCTION = [
  "Only for a clear work instruction (the user asks you to change, build, investigate or produce something), write a laisora-plan block with the goal as you understand it before your first tool call, then the TaskCreate steps; do not restate the user's words.",
  "For such work, use TaskCreate before starting: one task per step, subject as the step title, and activeForm set. Mark the first task in_progress before the first other tool call. A question, a conversation, a confirmation or feedback on earlier work is not a work instruction: answer it without a laisora-plan block or new tasks.",
  "Use TaskUpdate to mark each step in_progress when starting and completed when done. Add new steps at the end with TaskCreate.",
  `Do not mark a step completed while an agent or external run placed on it is still running: first ${PLAN_COMPLETION_WAIT}; otherwise the update is rejected before it runs.`,
  "Put an action that waits for the user's approval (such as merging or publishing) in its own step, separate from work you can finish yourself, and do not mark it in_progress until the user answers.",
  `While TaskCreate steps exist, start the description of every Agent call and external run with the number of the step it serves exactly as the PLAN panel shows it (the task id, zero-padded to at least two digits) followed by a space, as in "03 Remove model research". A delegation without a valid step number, or for a step that is not in progress, is rejected before it runs: before the delegation, ${PLAN_IN_PROGRESS_FIRST}.`,
  `${PLAN_RESUMED_AGENT_PLACE}: before resuming with SendMessage an agent placed on a completed step, ${PLAN_IN_PROGRESS_FIRST}; otherwise the SendMessage is rejected before it runs.`,
  "When you need the user's decision or a real-machine check, do not bury it in prose. Write a ```laisora-ask block (format below) at the point you ask.",
  "Before asking, check earlier decisions (ledger, contracts, earlier answers here) instead of re-asking, and investigate first if the current state is unknown.",
  "In every decision (laisora-ask or AskUserQuestion): why = what you observed (facts, numbers, sources) + the exact question + why the user, not you, must decide; never restate the title. effect = the concrete change to the user's screen, operation or work; never restate the label. pros/cons = compared with the other options, including effects on other features and operations. Give technical reasons, not history; explain terms the user may not share. For LAISORA's own behaviour, state the current behaviour and its technical reason from contracts or facts, or 理由の記録なし.",
  "Keep why short. Put material the user may need but not always (current behaviour and its technical reason, numbers, sources, terms explained) in the optional details key after why, so the user rarely has to ask back; the card shows it folded. details is a JSON double-quoted string; write \\n for a line break.",
  "Use AskUserQuestion only when you cannot continue without the answer; otherwise use a laisora-ask block and continue with the stated default.",
  "<format>",
  "A laisora-plan fence contains only goal: followed by one nonempty line in the user's language, using the same scalar rules below: ```laisora-plan\ngoal: Make progress visible throughout the work\n```.",
  ASK_DECIDE_FORMAT(),
  "A real-machine check requires kind, title, why, steps and default. Every step requires do (the action) and look (what to observe). Do not mix options and steps.",
  "```laisora-ask\nkind: check\ntitle: Check the result on your machine\nwhy: What I cannot verify here, and why.\nsteps:\n  - do: Open the changed screen.\n    look: Confirm the labels fit without clipping.\n  - do: Resize the window.\n    look: Confirm every action remains reachable.\ndefault: While awaiting the result, I will continue with the independent work.\n```",
  "</format>",
].join("\n");

export function interruptDiscardNotice(count: number): string {
  return l10n.t("Discarded {0} unprocessed messages due to the interrupt", count);
}

const planStepList = (numbers: readonly number[]): string => `current steps: ${numbers.map(planItemLabel).join(", ")}`;

export function planItemDenial(numbers: readonly number[]): string {
  return `Rejected before running: start the description with the number of the PLAN step this delegation serves as shown in the PLAN panel and a space (${planStepList(numbers)}), as in "03 Remove model research", then send the same call again.`;
}

export function planUnknownItemDenial(number: number, numbers: readonly number[], todoNextNumber?: number): string {
  const added = todoNextNumber === undefined ? "" : ` (a new TodoWrite item becomes step ${planItemLabel(todoNextNumber)})`;
  return `Rejected before running: ${planItemLabel(number)} is not a step of the current PLAN (${planStepList(numbers)}). Use the number of the step this delegation serves; if no step fits, add the step${added}, mark it in_progress, then use its number.`;
}

function planStepInProgressFix(step: PlanStepUpdate): string {
  const update = step.tool === "TaskUpdate" ? `TaskUpdate ${JSON.stringify({ taskId: step.taskId, status: "in_progress" })}`
    : `a TodoWrite that sets the item ${JSON.stringify(step.title)} (step ${planItemLabel(step.number)}) to in_progress and keeps the other items`;
  return `In one message, send ${update} first and then this same call; the call then runs.`;
}

export function planItemNotInProgressDenial(step: PlanStepUpdate): string {
  return `Rejected before running: PLAN step ${planItemLabel(step.number)} is not in progress. ${planStepInProgressFix(step)}`;
}

export function planLaunchDenial(verdict: NumberedLaunchVerdict): string | undefined {
  return verdict.kind === "allow" ? undefined : verdict.kind === "unnumbered" ? planItemDenial(verdict.numbers)
    : verdict.kind === "unknown-step" ? planUnknownItemDenial(verdict.number, verdict.numbers, verdict.todoNextNumber) : planItemNotInProgressDenial(verdict);
}

export function planResumeDenial(verdict: ResumeVerdict): string | undefined {
  if (verdict.kind === "allow") return undefined;
  return `Rejected before running: this message would resume an agent placed on PLAN step ${planItemLabel(verdict.number)}, which is completed. ${PLAN_RESUMED_AGENT_PLACE}. ${planStepInProgressFix(verdict)}`;
}

export function planCompletionDenial(verdict: CompletionVerdict): string | undefined {
  if (verdict.kind === "allow") return undefined;
  const steps = verdict.steps.map(entry => `${planItemLabel(entry.number)} (${entry.lanes.join("; ")})`).join(", ");
  return `Rejected before running: agents placed on PLAN step ${steps} are still running. First ${PLAN_COMPLETION_WAIT}, then send the same call again.`;
}

export const ASK_QUALITY_REWRITE_LIMIT = 2;
export const RENAME_SESSION_TIMEOUT_MS = 5000;

export function conversationSystemPrompt(fileLinkInstruction: boolean, planInstruction = true, cwd = "", placementLine: string): NonNullable<ClaudeCodeOptions["systemPrompt"]> {
  return { type: "custom", prompt: [fileLinkInstruction ? FILE_LINK_INSTRUCTION(cwd) : "", planInstruction ? PLAN_INSTRUCTION : "", placementLine].filter(Boolean).join("\n\n"), snapshot: false };
}

interface QueryHandle extends AsyncIterable<any> {
  interrupt(options?: { cancelQueued?: boolean }): Promise<InterruptReceipt | undefined>;
  setPermissionMode(mode: string): Promise<void>;
  supportedCommands(): Promise<Array<{ name: string; description?: string; aliases?: string[] }>>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null }): Promise<void>;
  getSettings?(): Promise<unknown>;
  renameSession?(title: string, sessionId?: string): Promise<void>;
  supportedModels(): Promise<Array<{ model?: string; id?: string; value?: string; resolvedModel?: string; displayName?: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>>;
  initializationResult(): Promise<{ claude_code_version?: string; remote_control_auto_enable?: boolean } | undefined>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
  getContextUsage(): Promise<{
    percentage: number;
    totalTokens: number;
    maxTokens: number;
    autoCompactThreshold?: number;
    isAutoCompactEnabled: boolean;
  }>;
}

export interface ClaudeHostOptions {
  cwd: string;
  knownBackgroundTask?: (taskId: string) => "agent" | "tool" | "unconfirmed" | undefined;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  resumeSessionId?: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk";
  settingSources: Array<"user" | "project" | "local">;
  transcriptRetention?: TranscriptRetentionSettings;
  remoteControlAtStartup?: boolean;
  claudeCodeExecutablePath?: string;
  apiKeyPolicy?: ApiKeyPolicy;
  fileLinkInstruction?: boolean;
  planInstruction?: boolean;
  askQualityCheck?: boolean;
  todoStore?: TodoStore;
  todoLinkedItem?: TodoLinkedItem;
  planLaunchVerdict?: (description: string | undefined) => NumberedLaunchVerdict;
  planResumeVerdict?: (to: string, namedToolUseId: string | undefined, toolUseId: string) => ResumeVerdict;
  planCompletionVerdict?: (toolName: string, input: Record<string, unknown> | undefined, toolUseId: string, admittedLaunches: ReadonlySet<string>) => CompletionVerdict;
  orchestrationEnabled?: boolean;
  orchestrationAgents?: unknown;
  externalModels?: ExternalModels;
  externalTimeoutMinutes?: number;
  orchestrationRunsDirectory?: string;
  orchestrationPluginDirectory?: string;
  rosterEvidenceDirectory?: string;
  guardEnabled?: boolean;
  memoryBlockProjectType?: boolean;
  conductorPolicy?: string;
  onOrchestrationChanged?: () => void;
  onCliVersion?: (version: string) => void;
  onBridgeState?: (connection: BridgeConnection) => void;
  interruptForceKillTimeoutMs: number;
  testInterruptHang?: boolean;
  progressTracking?: ProgressTrackingMode;
  onEvent: (
    ev: NormalizedEventBody & { provenance?: EventProvenance },
    conversationId: string,
    meta?: NormalizedOutMeta
  ) => void;
  onApprovalRequest: (req: {
    requestId: string;
    toolName: string;
    toolUseId?: string;
    rawInputJson: string;
  }) => Promise<ApprovalDecision>;
  log: (msg: string) => void;
}

export interface ApprovalDecision {
  behavior: "allow" | "deny" | "withdrawn";
  answers?: Record<string, string>;
  resolvedBy?: string;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  toolUseId?: string;
  resolve: (r: ApprovalDecision) => void;
}

function parseAskUserQuestionInput(input: Record<string, unknown>): AskUserQuestionSpec | undefined {
  try {
    const raw = input.questions;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const questions = raw.slice(0, 4).map((q) => {
      if (typeof q !== "object" || q === null) throw new Error("invalid question");
      const item = q as Record<string, unknown>;
      if (typeof item.question !== "string" || !Array.isArray(item.options)) {
        throw new Error("invalid question shape");
      }
      const options = item.options.slice(0, 4).map((o) => {
        if (typeof o !== "object" || o === null) throw new Error("invalid option");
        const opt = o as Record<string, unknown>;
        if (typeof opt.label !== "string") throw new Error("invalid option label");
        return {
          label: opt.label,
          description: typeof opt.description === "string" ? opt.description : undefined,
        };
      });
      if (options.length === 0) throw new Error("no options");
      return {
        question: item.question,
        header: typeof item.header === "string" ? item.header : undefined,
        multiSelect: item.multiSelect === true,
        options,
      };
    });
    return { questions };
  } catch {
    return undefined;
  }
}

interface AgentDefInfo {
  model?: string;
  effort?: string;
}

function parseAgentFrontmatter(text: string): { name?: string } & AgentDefInfo {
  const out: { name?: string; model?: string; effort?: string } = {};
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = /^(name|model|effort):\s*(.+?)\s*$/.exec(lines[i]);
    if (m) out[m[1] as "name" | "model" | "effort"] = m[2];
  }
  return out;
}

function loadAgentDefs(cwd: string, log: (msg: string) => void): Map<string, AgentDefInfo> {
  const defs = new Map<string, AgentDefInfo>();
  for (const root of [join(claudeConfigDir(), "agents"), join(cwd, ".claude", "agents")]) {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) files.push(join(root, entry.name));
        else if (entry.isDirectory()) {
          try {
            for (const sub of readdirSync(join(root, entry.name), { withFileTypes: true })) {
              if (sub.isFile() && sub.name.endsWith(".md")) files.push(join(root, entry.name, sub.name));
            }
          } catch {
          }
        }
      }
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const fm = parseAgentFrontmatter(readFileSync(file, "utf8"));
        const name = fm.name ?? file.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
        defs.set(name, { model: fm.model, effort: fm.effort });
      } catch (e) {
        log(`agent def read error: ${file}: ${String(e)}`);
      }
    }
  }
  return defs;
}

export async function resolveHandoffRuntime(
  configuredExecutablePath: string | undefined,
  apiKeyPolicy?: ApiKeyPolicy
): Promise<{
  sdk: Pick<typeof ClaudeCodeSdk, "forkSession" | "query">;
  claudeExecutablePath: string;
  env: NodeJS.ProcessEnv;
}> {
  const sdk = require("@anthropic-ai/claude-agent-sdk") as Pick<
    typeof ClaudeCodeSdk,
    "forkSession" | "query"
  >;
  const executable = await resolveClaudeCodeExecutable(configuredExecutablePath);
  const { env } = buildClaudeEnv(process.env, apiKeyPolicy);
  return { sdk, claudeExecutablePath: executable.path, env };
}

export class ClaudeConversation {
  private attribution: AgentAttribution;
  private readonly externalToolUses: Array<{ id: string; input: Record<string, unknown> }> = [];
  private observeToolResult(result: RawToolResult): void {
    if (isDelegationTool(result.tool)) void this.attribution.result(result.toolUseId, result.text, result.isError);
  }
  private readonly externalRows: readonly ExternalRow[];
  private readonly activeExternalRuns = new Set<Promise<unknown>>();
  private readonly externalTimeoutMinutes: number;
  private readonly runs: OrchestrationRunRecord[] = [];
  private readonly agentRuns = new Map<string, AgentRunRecord>();
  get orchestrationRuns(): readonly OrchestrationRunRecord[] { return Object.freeze([...this.runs]); }
  get observedAgentRuns(): ReadonlyMap<string, AgentRunRecord> { return new Map(this.agentRuns); }
  private async recordRun(unstamped: OrchestrationRunRecord): Promise<OrchestrationRunRecord> {
    const sessionId = this.recordSessionId;
    const runId = unstamped.runId ?? randomUUID();
    const dispatchId = unstamped.dispatchId ?? randomUUID();
    let record: OrchestrationRunRecord = Object.freeze({ ...unstamped, runId, dispatchId,
      recipient: unstamped.recipient ?? `external:${runId}`, ...(sessionId ? { sessionId } : {}) });
    const index = this.runs.length;
    this.runs.push(record);
    if (this.opts.orchestrationRunsDirectory) {
      try { await appendRunRecord(this.opts.orchestrationRunsDirectory, record); }
      catch (error) {
        const reason = [record.reason, runFailureReason("R-ORC-14: could not append orchestration run record", error)].filter(Boolean).join("; ");
        record = record.kind === "external" ? Object.freeze({ ...record, outcome: "failed", reason }) : Object.freeze({ ...record, reason });
        this.runs[index] = record;
      }
    }
    if (record.reason) this.opts.log(record.reason);
    this.opts.onOrchestrationChanged?.();
    return record;
  }
  private readonly roster: readonly OrchestrationRow[];
  private readonly orchestrationEnabled: boolean;
  private readonly conductorPolicy: string;
  private readonly placement: Placement;
  private readonly initialOrchestrationSettings: { settings: unknown };
  private authSessionId?: string;
  private todoGate?: RootGate;
  private todoFiles: readonly string[] = [];
  private readonly observedAgents = new Map<string, Readonly<{ agentType?: string; model?: string; effort?: string }>>();

  get orchestrationRoster(): readonly OrchestrationRow[] { return this.roster; }
  get orchestrationActive(): boolean { return this.orchestrationEnabled; }
  get orchestrationAgentVariants() { return orchestrationVariants(this.roster, this.opts.externalModels); }

  get orchestrationExternalRoster(): readonly ExternalRow[] { return this.externalRows; }

  private orchestrationSettings(options: Partial<ClaudeHostOptions>): unknown {
    return { enabled: options.orchestrationEnabled === true, agents: options.orchestrationAgents ?? [],
      guardEnabled: options.guardEnabled !== false,
      memoryBlockProjectType: options.memoryBlockProjectType === true,
      timeout: options.externalTimeoutMinutes ?? 10,
      policy: options.conductorPolicy ?? "" };
  }

  orchestrationSettingsChanged(options: Partial<ClaudeHostOptions>): boolean {
    return !isDeepStrictEqual(this.initialOrchestrationSettings, { settings: this.orchestrationSettings(options) });
  }

  get observedAgentSettings(): ReadonlyMap<string, Readonly<{ agentType?: string; model?: string; effort?: string }>> {
    return new Map(this.observedAgents);
  }

  private readonly recordedAgents = new Map<string, InjectedAgentDefinition>();
  private readonly rosterInjections: RosterInjection[] = [];
  private readonly agentStarts = new Map<string, AgentStartObservation>();
  get rosterEvidence(): RosterEvidence {
    return { injections: [...this.rosterInjections], starts: [...this.agentStarts.values()] };
  }
  attributedRole(agent: { agentType?: string; transcriptAgentId?: string; startedAt?: number }, evidence: RosterEvidence = this.rosterEvidence): string | null {
    return attributeSubagent(evidence, agent)?.definition.role ?? null;
  }

  private observeAgentStart(input: unknown): void {
    if (!input || typeof input !== "object") return;
    const agentId = (input as Record<string, unknown>).agent_id;
    if (typeof agentId !== "string" || !agentId) return;
    const observed = this.observedAgents.get(agentId);
    const agentKey = observed?.agentType;
    const injected = this.rosterInjections[this.rosterInjections.length - 1];
    if (agentKey === undefined || injected?.agents.some((agent) => agent.agentKey === agentKey) !== true) return;
    const previous = this.agentStarts.get(agentId);
    if (previous === undefined && this.agentStarts.size >= MAX_AGENT_STARTS) return;
    this.agentStarts.set(agentId, {
      agentId, agentKey, at: previous?.at ?? Date.now(),
      ...(observed?.model !== undefined ? { model: observed.model } : {}),
      ...(observed?.effort !== undefined ? { effort: observed.effort } : {}),
    });
  }

  private observeAgentSettings(input: unknown): void {
    if (!input || typeof input !== "object") return;
    const value = input as Record<string, unknown>;
    if (typeof value.agent_id !== "string" || !value.agent_id) return;
    const previous = this.observedAgents.get(value.agent_id);
    const effort = value.effort as { level?: unknown } | undefined;
    this.observedAgents.set(value.agent_id, Object.freeze({
      agentType: typeof value.agent_type === "string" ? value.agent_type : previous?.agentType,
      model: typeof value.model === "string" ? value.model : previous?.model,
      effort: typeof effort?.level === "string" ? effort.level : previous?.effort,
    }));
  }

  readonly conversationId = randomUUID();
  lastRecordReceivedAt: number | undefined;
  private turnAssistantText: string[] = [];
  private normalizer: ClaudeLiveNormalizer;
  private readonly usageLimitResume: UsageLimitResume;
  private readonly unsubscribeAutoContinue: () => void;
  private inputQueue: SDKUserMessage[] = [];
  private inputWaiter: (() => void) | null = null;
  private closed = false;
  private q: QueryHandle | null = null;
  private contextUsageInFlight: Promise<HandoffContextMeasurement | null> | null = null;
  private contextUsagePending = false;
  private contextUsageGeneration = 0;
  turnsEnded = 0;
  contextUsageTurnsEnded = 0;
  lastRootMessageStartedAt: number | undefined;
  private resolveInitialContextUsage!: (value: HandoffContextMeasurement | null) => void;
  readonly initialContextUsage = new Promise<HandoffContextMeasurement | null>((resolve) => {
    this.resolveInitialContextUsage = resolve;
  });

  private invalidateHandoffContextUsage(): void {
    this.contextUsageGeneration++;
  }
  private abortController = new AbortController();
  private pendingApprovals = new Map<string, PendingApproval>();
  private runLoopDone: Promise<void> | null = null;
  private inputGen: AsyncGenerator<SDKUserMessage> | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private agentDefs: Map<string, AgentDefInfo> | null = null;
  private cliCapabilities: string[] | null = null;
  private startMarks: { begin: number; sdkLoaded: number; resolved: number; optionsBuilt: number; queried: number } | null = null;
  private firstMessageLogged = false;

  constructor(private readonly opts: ClaudeHostOptions) {
    this.usageLimitResume = new UsageLimitResume({
      now: Date.now,
      random: Math.random,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      enabled: () => readClaudeCodeSettings(true).autoContinueAtUsageLimit !== false,
      connected: () => this.q !== null && !this.closed,
      live: () => this.q !== null && !this.closed && this.state === "idle" && this.inputQueue.length === 0,
      send: (text) => this.send(text, undefined, undefined, { kind: "resume" }),
      notify: (event) => this.emit(event),
    });
    this.unsubscribeAutoContinue = onAutoContinueSettingChange(() => {
      if (readClaudeCodeSettings(true).autoContinueAtUsageLimit === false) this.cancelAutoResume();
    });
    this.initialOrchestrationSettings = { settings: structuredClone(this.orchestrationSettings(opts)) };
    this.orchestrationEnabled = opts.orchestrationEnabled === true;
    const resolved = resolveOrchestrationRoster(this.orchestrationEnabled ? opts.orchestrationAgents : []);
    this.roster = resolved.roster;
    this.externalRows = orchestrationExternalTargets(this.roster, opts.externalModels, opts.log);
    this.externalTimeoutMinutes = isExternalTimeout(opts.externalTimeoutMinutes) ? opts.externalTimeoutMinutes : 10;
    this.conductorPolicy = opts.conductorPolicy ?? "";
    this.placement = placementOf({ guardEnabled: opts.guardEnabled !== false, blockProjectType: opts.memoryBlockProjectType === true });
    for (const dropped of resolved.droppedRows) opts.log(dropped);
    if (opts.rosterEvidenceDirectory && opts.resumeSessionId) {
      for (const injection of readRosterEvidence(opts.rosterEvidenceDirectory, opts.resumeSessionId, opts.log).injections)
        for (const agent of injection.agents) this.recordedAgents.set(agent.agentKey, agent);
    }
    this.attribution = new AgentAttribution(() => this.rosterEvidence, record => this.recordRun(record),
      opts.log, agentKey => agentKey === undefined ? undefined : this.recordedAgents.get(agentKey));
    this.normalizer = new ClaudeLiveNormalizer({
      cwd: this.opts.cwd,
      knownBackgroundTask: this.opts.knownBackgroundTask,
      log: this.opts.log,
      loadAgentDef: (subagentType: string) => this.loadAgentDef(subagentType),
      emit: (body, meta) => this.emit(body, meta),
      onRawToolUse: (id, tool, input) => {
        if (isDelegationTool(tool)) this.attribution.dispatch(id, input);
        if (isExternalRunTool(tool)) this.externalToolUses.push({ id, input });
      },
      onRawToolResult: result => this.observeToolResult(result),
      onTurnEnd: () => {
        if (this.interruptTimer) {
          clearTimeout(this.interruptTimer);
          this.interruptTimer = null;
        }
        for (const requestId of this.pendingApprovals.keys()) this.resolveApproval(requestId, "deny", undefined, "turn-end");
        this.turnsEnded += 1;
        void this.requestContextUsage();
      },
      isClosed: () => this.closed,
      onDelegateUsageLimitStop: (agentId) => this.usageLimitResume.delegateStopped(agentId),
    });
  }

  get initSlashCommands(): string[] | null {
    return this.normalizer.initSlashCommands;
  }

  get state(): "idle" | "running" | "interrupting" {
    return this.normalizer.turnState;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get recordSessionId(): string | undefined {
    return this.authSessionId ?? this.opts.resumeSessionId;
  }

  get hasTodoTools(): boolean {
    return this.opts.todoStore !== undefined;
  }

  private loadAgentDef(subagentType: string): AgentDefInfo | undefined {
    this.agentDefs ??= loadAgentDefs(this.opts.cwd, this.opts.log);
    return this.agentDefs.get(subagentType);
  }

  startBreakdown(): string | undefined {
    const m = this.startMarks;
    if (m === null) return undefined;
    return `sdk ${m.sdkLoaded - m.begin}ms / resolve ${m.resolved - m.sdkLoaded}ms / options ${m.optionsBuilt - m.resolved}ms / query ${m.queried - m.optionsBuilt}ms`;
  }

  async start(): Promise<void> {
    const begin = Date.now();
    const sdk = require("@anthropic-ai/claude-agent-sdk") as Pick<
      typeof ClaudeCodeSdk,
      "query" | "USAGE_LIMIT_ERROR_PREFIXES" | "createSdkMcpServer" | "tool"
    >;
    const sdkLoaded = Date.now();
    const resolvedExecutable = await resolveClaudeCodeExecutable(this.opts.claudeCodeExecutablePath);
    const resolved = Date.now();
    this.opts.log(`Claude Code executable resolved from ${resolvedExecutable.source}: ${resolvedExecutable.path}` + (resolvedExecutable.shimPath ? ` (npm shim: ${resolvedExecutable.shimPath})` : ""));
    this.normalizer.setUsageLimitPrefixes([...sdk.USAGE_LIMIT_ERROR_PREFIXES]);

    const { env, removed } = buildClaudeEnv(process.env, this.opts.apiKeyPolicy,
      this.orchestrationEnabled && this.externalRows.length > 0);
    if (Object.entries(env).some(([key, value]) => envNameKey(key) === "ANTHROPIC_API_KEY" && typeof value === "string" && value.length > 0)) {
      this.opts.log("ANTHROPIC_API_KEY inherited by the child process (apiKeyPolicy=inherit)");
    }
    if (removed.length > 0) {
      this.opts.log(`env sanitized (removed: ${removed.join(", ")})`);
      if (removed.includes("ANTHROPIC_API_KEY")) {
        this.emit({
          kind: "error",
          message: l10n.t(
            "ANTHROPIC_API_KEY was present in the environment and was removed from the child process (subscription auth takes precedence)"
          ),
          fatal: false,
        });
      }
    }

    const self = this;
    const canUseTool: NonNullable<ClaudeCodeOptions["canUseTool"]> = async (
      toolName: string,
      input: Record<string, unknown>,
      ctx
    ): Promise<PermissionResult | null> => {
      const ctxJson = (() => {
        try {
          return JSON.stringify(
            ctx,
            (_k, v) => (typeof v === "function" || v instanceof AbortSignal ? undefined : v),
            2
          );
        } catch {
          return undefined;
        }
      })();
      const requestId = randomUUID();
      const rawInputJson = ctxJson
        ? `${JSON.stringify(input, null, 2)}
--- context ---
${ctxJson}`
        : JSON.stringify(input, null, 2);
      const questions = toolName === "AskUserQuestion" ? parseAskUserQuestionInput(input) : undefined;
      self.emit({
        kind: "approval_request",
        turnId: self.normalizer.currentTurnId,
        requestId,
        toolName,
        rawInputJson,
        inputJson: (() => {
          try {
            const s = JSON.stringify(input);
            return s.length <= 64_000 ? s : undefined;
          } catch {
            return undefined;
          }
        })(),
        inputSummary: summarizeToolInput(toolName, input) ?? undefined,
        expiresAt: null,
        questions,
      });
      const rootGate = self.todoGate?.scope.tools.includes(toolName) ? self.todoGate : undefined;
      const rootCall = ctx.toolUseID;
      rootGate?.hold(rootCall);
      const pendingDecision = self.opts.onApprovalRequest({ requestId, toolName, toolUseId: ctx.toolUseID, rawInputJson });
      const onAbort = (): void => {
        rootGate?.revoke(rootCall);
        self.resolveApproval(requestId, "withdrawn", undefined, "withdrawn");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();
      let decision: ApprovalDecision;
      try {
        decision = await pendingDecision;
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      if (ctx.signal.aborted || decision.behavior === "withdrawn") {
        rootGate?.revoke(rootCall);
        self.emit({ kind: "approval_resolved", requestId, behavior: "withdrawn", resolvedBy: "withdrawn" });
        return null;
      }
      if (decision.behavior === "deny") rootGate?.revoke(rootCall);
      else rootGate?.release(rootCall);
      self.emit({ kind: "approval_resolved", requestId, behavior: decision.behavior, resolvedBy: decision.resolvedBy ?? "user", answers: decision.answers });
      if (decision.behavior === "deny") {
        return { behavior: "deny", message: laisoraDenialMessage() };
      }
      return decision.answers
        ? { behavior: "allow", updatedInput: { ...input, answers: decision.answers } }
        : { behavior: "allow", updatedInput: input };
    };

    const options: ClaudeCodeOptions = {
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
      settingSources: this.opts.settingSources,
      settings: { remoteControlAtStartup: this.opts.remoteControlAtStartup === true, ...SDK_AUTO_CONTINUE_SETTINGS, ultracode: false, ...this.opts.transcriptRetention },
      extraArgs: { [REPLAY_USER_MESSAGES_ARG]: null },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: resolvedExecutable.path,
      canUseTool,
      abortController: this.abortController,
      env,
      stderr: (data: string) => this.opts.log(`[claude stderr] ${data}`),
    };
    if (this.opts.progressTracking === "instrument") {
      options.mcpServers = {
        ...(options.mcpServers ?? {}),
        laisora_progress: sdk.createSdkMcpServer({
          name: "laisora_progress",
          tools: [
            sdk.tool(
              "progress",
              "Report task progress (no-op recorder)",
              {
                pp: z.string(),
                task_id: z.string().optional(),
                state: z.string(),
                activity: z.string().optional(),
                blocker: z.string().optional(),
                evidence: z.array(z.string()).optional(),
                next: z.string().optional(),
              },
              async () => ({ content: [{ type: "text" as const, text: "ok" }] })
            ),
          ],
        }),
      };
      options.allowedTools = [...(options.allowedTools ?? []), PROGRESS_WIRE_TOOL_NAME];
      options.hooks = {
        ...(options.hooks ?? {}),
        SubagentStart: [
          ...((options.hooks?.SubagentStart as unknown[] | undefined) ?? []),
          {
            hooks: [
              async () => ({
                hookSpecificOutput: {
                  hookEventName: "SubagentStart" as const,
                  additionalContext: PROGRESS_PROTOCOL_SPEC_PP1,
                },
              }),
            ],
          },
        ],
      } as ClaudeCodeOptions["hooks"];
    }
    if (this.opts.planInstruction !== false) {
      options.allowedTools = [...(options.allowedTools ?? []), "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"];
    }
    options.systemPrompt = conversationSystemPrompt(this.opts.fileLinkInstruction === true, this.opts.planInstruction !== false, this.opts.cwd, this.placement.line);
    this.rosterInjections.push(injectionOf(this.orchestrationEnabled ? orchestrationVariants(this.roster, this.opts.externalModels) : [], Date.now(), true));
    if (this.orchestrationEnabled) {
      options.plugins = [...(options.plugins ?? []), { type: "local",
        path: await prepareOrchestrationPlugin(this.opts.orchestrationPluginDirectory ?? join(tmpdir(), "laisora-agent-plugin"), this.roster, this.opts.externalModels) }];
      const base = this.opts.fileLinkInstruction === true ? FILE_LINK_INSTRUCTION(this.opts.cwd) : "";
      options.systemPrompt = { type: "custom", snapshot: false,
        prompt: [base, this.opts.planInstruction !== false ? PLAN_INSTRUCTION : "", conductorInstruction(this.roster, this.conductorPolicy, this.externalRows, this.opts.externalModels, this.placement.line)].filter(Boolean).join("\n\n") };
    }
    if (this.orchestrationEnabled) {
      const observe: ClaudeCodeSdk.HookCallback = async (input) => {
        this.observeAgentSettings(input);
        this.observeAgentStart(input);
        const record = observeAgentRun(this.agentRuns.get((input as { agent_id?: string }).agent_id ?? ""), input);
        if (record) {
          this.agentRuns.set(record.agent_id, record);
          const observed = this.observedAgents.get(record.agent_id);
          const enriched = { ...record, model: observed?.model, effort: observed?.effort };
          this.agentRuns.set(record.agent_id, enriched);
          if (input.hook_event_name === "SubagentStop") await this.attribution.stop(enriched, input as unknown as Record<string, unknown>);
        }
        this.opts.onOrchestrationChanged?.();
        return {};
      };
      options.hooks = {
        ...(options.hooks ?? {}),
        SubagentStart: [...(options.hooks?.SubagentStart ?? []), { hooks: [observe] }],
        PreToolUse: [...(options.hooks?.PreToolUse ?? []), { hooks: [observe] }],
        SubagentStop: [...(options.hooks?.SubagentStop ?? []), { hooks: [observe] }],
      };
    }
    if (this.orchestrationEnabled && this.externalRows.length > 0) {
      options.mcpServers = { ...(options.mcpServers ?? {}), laisora_external: sdk.createSdkMcpServer({
        name: "laisora_external", timeout: this.externalTimeoutMinutes * 60_000 + 10_000,
        tools: [sdk.tool("run", externalDescription(this.externalRows), {
          target: z.string(), prompt: z.string(), description: z.string().optional(), files: z.array(z.string()).optional().describe("Files must be absolute paths."), diff: z.string().optional(), cwd: z.string().optional(),
        }, async (input, extra) => {
          const row = this.externalRows.find((entry) => entry.target === input.target);
          if (!row) return { isError: true, content: [{ type: "text" as const, text: "R-ORC-10: target is not in the conversation snapshot." }] };
          const controller = new AbortController();
          const requestSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
          const conversationSignal = this.abortController.signal;
          const abort = () => controller.abort();
          requestSignal?.addEventListener("abort", abort, { once: true });
          conversationSignal.addEventListener("abort", abort, { once: true });
          if (requestSignal?.aborted || conversationSignal.aborted) abort();
          const pending = (async () => {
            const suppliedId = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["claudecode/toolUseId"];
            const toolUse = this.externalToolUses.find(entry => typeof suppliedId === "string" ? entry.id === suppliedId : isDeepStrictEqual(entry.input, input));
            if (toolUse) this.externalToolUses.splice(this.externalToolUses.indexOf(toolUse), 1);
            const runId = randomUUID(), dispatchId = randomUUID(), recipient = `external:${runId}`;
            const run = await runExternal(row, input, { cwd: this.opts.cwd, configDir: claudeConfigDir(), timeoutMinutes: this.externalTimeoutMinutes, apiKeyPolicy: this.opts.apiKeyPolicy }, {
              signal: controller.signal,
            });
            const record = await this.recordRun({ ...run.record, runId, dispatchId, recipient,
              ...(toolUse ? { toolUseId: toolUse.id } : typeof suppliedId === "string" ? { toolUseId: suppliedId } : {}) });
            const result = record.outcome !== "ok" && record.reason !== run.record.reason
              ? { isError: true, content: [{ type: "text" as const, text: record.reason! }] } : run.result;
            return { ...result, content: [...result.content, { type: "text" as const, text: `Run: ${record.runId}` }] };
          })();
          this.activeExternalRuns.add(pending);
          try { return await pending; }
          finally {
            this.activeExternalRuns.delete(pending);
            requestSignal?.removeEventListener("abort", abort);
            conversationSignal.removeEventListener("abort", abort);
          }
        })],
      }) };
    }
    const addRootGate = (gate: RootGate) => {
      const gated = { matcher: gate.scope.tools.join("|"), hooks: [gate.hook] };
      options.hooks = { ...(options.hooks ?? {}),
        PreToolUse: [...(options.hooks?.PreToolUse ?? []), gated],
        PermissionDenied: [...(options.hooks?.PermissionDenied ?? []), gated],
        PostToolUseFailure: [...(options.hooks?.PostToolUseFailure ?? []), gated] };
    };
    if (this.opts.todoStore) {
      const gate = this.todoGate = new RootGate(undefined, this.opts.log, TODO_ROOT_SCOPE);
      options.mcpServers = { ...(options.mcpServers ?? {}), [TODO_SERVER_NAME]: createTodoMcpServer(sdk, this.opts.todoStore, gate, this.opts.log, () => this.recordSessionId,
        () => ({ cwd: this.opts.cwd, files: this.todoFiles, roots: todoWorkspaceRoots(), home: homedir() })) };
      options.allowedTools = [...(options.allowedTools ?? []), ...TODO_TOOL_NAMES];
      addRootGate(gate);
      const noteFile: ClaudeCodeSdk.HookCallback = async input => {
        const value = input.hook_event_name === "PreToolUse" ? input.tool_input as Record<string, unknown> | undefined : undefined;
        const path = value?.file_path ?? value?.notebook_path;
        if (typeof path === "string" && isAbsolute(path)) this.todoFiles = [...this.todoFiles.filter(entry => entry !== path), path].slice(-TODO_RECENT_FILES);
        return {};
      };
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [...(options.hooks?.PreToolUse ?? []), { matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [noteFile] }] };
      if (this.opts.todoLinkedItem) {
        const prompt = options.systemPrompt as { type: "custom"; snapshot: false; prompt: string };
        options.systemPrompt = { ...prompt, prompt: [prompt.prompt, todoLinkedInstruction(this.opts.todoLinkedItem)].filter(Boolean).join("\n\n") };
      }
    }
    if (this.placement.guardEnabled) {
      const guard: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const delegate = typeof input.agent_id === "string" && input.agent_id.length > 0;
        if (!([...FILE_WRITING_TOOLS, ...(delegate ? ["NotebookEdit"] : [])] as string[]).includes(input.tool_name) && !isShellTool(input.tool_name)) return {};
        return failClosedGuard(async () => {
          const value = input.tool_input as Record<string, unknown>;
          const guardRoster = resolveOrchestrationRoster(this.opts.orchestrationAgents).roster;
          const names = ["claude", "Claude", "codex", "Codex", "agy", "Antigravity", ...orchestrationVariants(guardRoster).map(variant => variant.agentKey),
            ...guardRoster.flatMap(row => row.rows.map(entry => entry.model)), ...this.orchestrationRuns.flatMap(run => [run.requestedModel, run.kind === "external" ? run.observedModel : run.model].filter((name): name is string => !!name)),
            ...[...this.observedAgents.values()].flatMap(agent => [agent.agentType, agent.model].filter((name): name is string => !!name))];
          const models = Object.values(this.opts.externalModels ?? {}).flatMap(list => list.state === "ok" ? list.models : []);
          const listed = models.flatMap(model => [model.id, ...(model.resolvedModel ? [model.resolvedModel] : [])]);
          const vocabulary = compileVocabulary({ names: [...names, ...listed, ...models.map(model => model.label), ...listed.map(model => claudeModelIdLabel(model))], effortWords: PLACEMENT_EFFORT_WORDS,
            listedModelIds: listed });
          const cwd = input.cwd || this.opts.cwd;
          let decision = judgeShellWrite(input.tool_name, value, claudeConfigDir(), process.platform, cwd, delegate);
          let unreadable = false;
          let memoryDecision: MemoryDecision | undefined = delegate && decision.destination === "memory"
            ? { destination: "memory", blocked: true, reasons: ["delegate"], blockedLines: [] } : undefined;
          const filePath = input.tool_name === "NotebookEdit" ? value.notebook_path : value.file_path;
          if (([...FILE_WRITING_TOOLS, "NotebookEdit"] as string[]).includes(input.tool_name) && typeof filePath === "string") {
            const path = placementPath(filePath, cwd, false);
            let current: string | undefined;
            if (path) {
              try { current = readFileSync(path, "utf8"); }
              catch (error) { unreadable = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
            }
            const target = path ?? filePath;
            decision = delegate && isControlFile(target, claudeConfigDir())
              ? { destination: protectedDestination(target, claudeConfigDir()) ?? "control", blocked: true, reasons: [], examinedLines: 0, blockedLines: [] }
              : judgeFileWrite(input.tool_name, { ...value, file_path: target }, current, vocabulary, claudeConfigDir());
            memoryDecision = judgeMemoryWrite(input.tool_name, { ...value, file_path: target }, current,
              delegate ? "delegate" : "conductor", this.placement.memoryTypes, claudeConfigDir());
          }
          const unchecked = unreadable && decision.skipped === "edit-does-not-apply";
          const destination = memoryDecision?.blocked ? "memory" : decision.destination;
          if ((!memoryDecision?.blocked && !decision.blocked && !unchecked) || !destination) return {};
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
            permissionDecisionReason: memoryDecision?.blocked ? memoryGuardReason(memoryDecision, this.placement) : delegate ? DELEGATE_CONTROL_REFUSAL : unchecked ? PLACEMENT_UNREADABLE_REFUSAL : PLACEMENT_GUARD_REFUSAL } };
        }, this.opts.log);
      };
      const delegateNotice: ClaudeCodeSdk.HookCallback = async input => input.hook_event_name === "SubagentStart"
        ? { hookSpecificOutput: { hookEventName: "SubagentStart" as const, additionalContext: DELEGATE_PLACEMENT_NOTICE } } : {};
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [{ hooks: [guard] }, ...(options.hooks?.PreToolUse ?? [])],
        SubagentStart: [...(options.hooks?.SubagentStart ?? []), { hooks: [delegateNotice] }] };
    }
    const planInstruction = this.opts.planInstruction !== false;
    const planLaunchVerdict = planInstruction ? this.opts.planLaunchVerdict : undefined;
    const planResumeVerdict = planInstruction ? this.opts.planResumeVerdict : undefined;
    const planCompletionVerdict = planInstruction ? this.opts.planCompletionVerdict : undefined;
    if (planLaunchVerdict || planResumeVerdict || planCompletionVerdict) {
      const launchByName = new Map<string, string>();
      const admittedLaunches = new Set<string>();
      const planItemGuard: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name !== "PreToolUse" || input.agent_id) return {};
        const value = input.tool_input as Record<string, unknown> | undefined;
        const launch = isDelegationLaunchTool(input.tool_name);
        const to = input.tool_name === "SendMessage" && typeof value?.to === "string" ? value.to : undefined;
        const completion = input.tool_name === "TaskUpdate" || input.tool_name === "TodoWrite";
        if (!launch && to === undefined && !completion) return {};
        return failClosedGuard(() => {
          const reason = launch ? planLaunchVerdict && planLaunchDenial(planLaunchVerdict(typeof value?.description === "string" ? value.description : undefined))
            : to !== undefined ? planResumeVerdict && planResumeDenial(planResumeVerdict(to, launchByName.get(to), input.tool_use_id))
            : planCompletionVerdict && planCompletionDenial(planCompletionVerdict(input.tool_name, value, input.tool_use_id, admittedLaunches));
          if (reason) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
          if (launch) admittedLaunches.add(input.tool_use_id);
          if (launch && typeof value?.name === "string") launchByName.set(value.name, input.tool_use_id);
          return {};
        }, this.opts.log);
      };
      const placed = options.hooks?.PreToolUse ?? [];
      const afterGuard = this.placement.guardEnabled ? 1 : 0;
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [...placed.slice(0, afterGuard), { hooks: [planItemGuard] }, ...placed.slice(afterGuard)] };
    }
    if (planInstruction && this.opts.askQualityCheck === true) {
      let rewrites = 0;
      const askQualityGate: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name !== "Stop") return {};
        if (!input.stop_hook_active) rewrites = 0;
        try {
          const text = [...this.turnAssistantText, input.last_assistant_message ?? ""].join("\n\n");
          const reason = askQualityDenial(text);
          if (!reason || rewrites >= ASK_QUALITY_REWRITE_LIMIT) return {};
          rewrites++;
          this.turnAssistantText = [];
          const turnId = this.normalizer.currentTurnId;
          if (turnId !== null) this.emit({ kind: "ask_rejected", turnId, titles: rejectedAskTitles(text) });
          return { decision: "block", reason };
        } catch (error) {
          this.opts.log?.(`ask quality gate failed: ${String(error)}`);
          return {};
        }
      };
      options.hooks = { ...(options.hooks ?? {}), Stop: [...(options.hooks?.Stop ?? []), { hooks: [askQualityGate] }] };
    }
    if (this.orchestrationEnabled) {
      const observeDispatch: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name !== "PreToolUse") return {};
        if (isDelegationTool(input.tool_name)) this.attribution.dispatch(input.tool_use_id, input.tool_input as Record<string, unknown>);
        if (isExternalRunTool(input.tool_name) && !this.externalToolUses.some(entry => entry.id === input.tool_use_id)) this.externalToolUses.push({ id: input.tool_use_id, input: input.tool_input as Record<string, unknown> });
        return {};
      };
      const handbackDenials = new Map<string, number>();
      const handbackGate: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const agent = input.agent_id ?? "";
        const denials = handbackDenials.get(agent) ?? 0;
        const reason = handbackGateVerdict((input.tool_input as Record<string, unknown> | undefined)?.message, denials);
        if (!reason) {
          handbackDenials.delete(agent);
          return {};
        }
        handbackDenials.set(agent, denials + 1);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
      };
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [...(options.hooks?.PreToolUse ?? []), { hooks: [observeDispatch] },
        { matcher: `^${SUBAGENT_HANDBACK_TOOL}$`, hooks: [handbackGate] }] };
    }
    const preToolUse = options.hooks?.PreToolUse ?? [];
    if (preToolUse.length) {
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [{ hooks: [async (input, id, context) => {
        type PreToolUseSpecific = Extract<NonNullable<ClaudeCodeSdk.SyncHookJSONOutput["hookSpecificOutput"]>, { hookEventName: "PreToolUse" }>;
        let rest: ClaudeCodeSdk.SyncHookJSONOutput = {};
        let specific: PreToolUseSpecific | undefined;
        for (const matcher of preToolUse) {
          if (matcher.matcher && !new RegExp(matcher.matcher).test((input as { tool_name?: string }).tool_name ?? "")) continue;
          for (const hook of matcher.hooks) {
            const output = await hook(input, id, context);
            if ("async" in output) continue;
            const { hookSpecificOutput, ...fields } = output;
            const next = hookSpecificOutput?.hookEventName === "PreToolUse" ? hookSpecificOutput : undefined;
            if (next?.permissionDecision === "deny") return output;
            rest = { ...rest, ...fields };
            if (next) {
              const updatedInput = next.updatedInput ?? specific?.updatedInput;
              specific = { ...specific, ...next, ...(updatedInput ? { updatedInput } : {}) };
              if (next.updatedInput) input = { ...input, tool_input: next.updatedInput } as typeof input;
            }
          }
        }
        return specific ? { ...rest, hookSpecificOutput: specific } : rest;
      }] }] };
    }
    if (this.opts.model) options.model = this.opts.model;
    if (this.opts.effort) options.effort = this.opts.effort;
    if (this.opts.resumeSessionId) options.resume = this.opts.resumeSessionId;
    if (this.opts.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    this.inputGen = this.inputGenerator();
    const optionsBuilt = Date.now();
    this.q = sdk.query({
      prompt: this.inputGen as unknown as AsyncIterable<Parameters<typeof sdk.query>[0]["prompt"] extends AsyncIterable<infer Message> ? Message : never>,
      options,
    }) as QueryHandle;
    const queried = Date.now();
    this.startMarks = { begin, sdkLoaded, resolved, optionsBuilt, queried };
    if (typeof this.q.initializationResult === "function") {
      Promise.resolve(this.q.initializationResult()).then(
        (init) => {
          const cliVersion = init?.claude_code_version;
          this.opts.log(`CLI init response: ${Date.now() - queried}ms after query(); Claude Code CLI version: ${cliVersion ?? "unavailable"}; SDK expected: ${sdkClaudeCodeVersion() ?? "unknown"}`);
          if (cliVersion) this.opts.onCliVersion?.(cliVersion);
        },
        () => undefined
      );
    }

    this.emit({ kind: "conversation_opened", cwd: this.opts.cwd, model: this.opts.model });
    void this.requestContextUsage(true);
    this.runLoopDone = this.runLoop();
  }

  private async *inputGenerator(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.inputQueue.length > 0) {
        const next = this.inputQueue.shift()!;
        const head = next.message.content.find((b) => b.type === "text");
        this.opts.log(
          `input yield: state=${this.normalizer.turnState} text="${(head && "text" in head ? head.text : "").slice(0, 40)}"`
        );
        yield next;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.inputWaiter = resolve;
      });
    }
  }

  sendSteeringEnvelope(envelopeText: string): SteeringSendResult {
    const admission = admitSteeringSend(
      { closed: this.closed, turnState: this.normalizer.turnState },
      envelopeText,
      checkEnvelopeRedaction
    );
    if (!admission.ok) return admission;
    this.queueUserInput([{ type: "text", text: envelopeText }], { uuid: randomUUID() });
    return { ok: true };
  }

  sendReportEnvelope(envelopeText: string): SteeringSendResult {
    const admission = admitReportSend(
      { closed: this.closed, turnState: this.normalizer.turnState },
      envelopeText,
      checkEnvelopeRedaction
    );
    if (!admission.ok) return admission;
    this.queueUserInput([{ type: "text", text: envelopeText }], { uuid: randomUUID() });
    return { ok: true };
  }

  sendHandoffNotice(envelopeText: string, notice: HandoffNoticeFacts): SteeringSendResult {
    const admission = admitHandoffNoticeSend(
      { closed: this.closed, turnState: this.normalizer.turnState },
      envelopeText,
      checkEnvelopeRedaction
    );
    if (!admission.ok) return admission;
    const uuid = randomUUID();
    this.normalizer.startTurn(undefined, { timestamp: Date.now() }, true);
    this.emit({ kind: "local_command_output", text: handoffNoticeCardText(notice), uuid, handoffNotice: notice });
    this.queueUserInput([{ type: "text", text: envelopeText }], { uuid });
    return { ok: true };
  }

  private queueUserInput(content: UserContentBlock[], extra: { isMeta?: true; uuid: `${string}-${string}-${string}-${string}-${string}` }): void {
    this.invalidateHandoffContextUsage();
    this.normalizer.noteOwnInput(extra.uuid);
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content },
      ...extra,
      parent_tool_use_id: null,
      session_id: "",
    });
    this.inputWaiter?.();
    this.inputWaiter = null;
  }

  cancelAutoResume(): void { this.usageLimitResume.cancel(); }

  get pendingAutoResumeAt(): number | null { return this.usageLimitResume.pendingResumeAt; }

  get queuedInputCount(): number { return this.inputQueue.length; }

  get runningExternalRunCount(): number { return this.activeExternalRuns.size; }

  get pendingApprovalToolUseIds(): readonly string[] {
    return [...this.pendingApprovals.values()].flatMap(p => p.toolUseId === undefined ? [] : [p.toolUseId]);
  }

  send(text: string, images?: ImageAttachment[], sentAt = Date.now(), automatic: LaisoraInput | false = false, uuid?: `${string}-${string}-${string}-${string}-${string}`): boolean {
    if (!automatic) this.usageLimitResume.manualSend();
    if (this.closed) {
      this.emit({
        kind: "error",
        message: l10n.t("The conversation has ended. Resend your message (a new connection will be started)"),
        fatal: false,
      });
      return false;
    }
    if (this.normalizer.turnState === "interrupting") {
      this.emit({
        kind: "error",
        message: l10n.t("Interrupt in progress. Stop first, then send again."),
        fatal: false,
      });
      return false;
    }
    const runningAlready = this.normalizer.turnState !== "idle";
    if (!runningAlready) {
      this.normalizer.startTurn(undefined, { timestamp: sentAt }, automatic !== false);
    }
    if (automatic) {
      uuid ??= randomUUID();
      const line = laisoraInputLine(automatic);
      if (line !== undefined) this.emit({ kind: "local_command_output", text: line, uuid });
      text = markLaisoraInput(automatic, text);
    }
    const content: UserContentBlock[] = [
      ...(images ?? []).map(
        (im): UserContentBlock => ({
          type: "image",
          source: { type: "base64", media_type: im.mediaType, data: im.data },
        })
      ),
      { type: "text", text },
    ];
    this.queueUserInput(content, { ...(automatic ? { isMeta: true as const } : {}), uuid: uuid ?? randomUUID() });
    return true;
  }

  async interrupt(): Promise<void> {
    this.cancelAutoResume();
    if (!this.q || this.normalizer.turnState !== "running") return;
    this.attribution.interrupt();
    this.normalizer.turnState = "interrupting";
    const turnId = this.normalizer.currentTurnId;
    const drained = this.inputQueue.length;
    for (const input of this.inputQueue) this.normalizer.forgetOwnInput(input.uuid);
    this.inputQueue = [];
    if (drained > 0) {
      this.emit({
        kind: "error",
        message: interruptDiscardNotice(drained),
        fatal: false,
      });
    }
    for (const requestId of this.pendingApprovals.keys()) this.resolveApproval(requestId, "deny", undefined, "interrupt");
    const timeoutMs = this.opts.interruptForceKillTimeoutMs;
    this.interruptTimer = setTimeout(() => {
      if (this.normalizer.turnState === "interrupting" && this.normalizer.currentTurnId === turnId) {
        this.opts.log(`interrupt timeout (${timeoutMs}ms) → abort (force-kill fallback)`);
        this.abortController.abort();
        this.endTurn("turn_interrupted");
        this.closed = true;
      }
    }, timeoutMs);
    if (this.opts.testInterruptHang) {
      this.opts.log("testInterruptHang: skipping provider interrupt (waiting for the timeout)");
      return;
    }
    try {
      const receipt = await this.q.interrupt({ cancelQueued: true });
      const honorsCancelQueued = this.cliCapabilities?.includes(CAP_INTERRUPT_CANCEL_QUEUED) === true;
      const survivors = receipt?.still_queued?.length ?? 0;
      if (!this.closed && (!honorsCancelQueued || survivors > 0)) {
        this.opts.log(
          `interrupt: queued input may survive (${CAP_INTERRUPT_CANCEL_QUEUED}=${honorsCancelQueued}, still_queued=${survivors}) → abort (force-kill)`
        );
        this.abortController.abort();
        if (this.normalizer.turnState === "interrupting" && this.normalizer.currentTurnId === turnId) {
          this.endTurn("turn_interrupted");
        }
        this.closed = true;
      }
    } catch (e) {
      this.opts.log(`interrupt() error: ${String(e)} → abort fallback`);
      this.abortController.abort();
      if (this.normalizer.turnState === "interrupting" && this.normalizer.currentTurnId === turnId) {
        this.endTurn("turn_interrupted");
        this.closed = true;
      }
    }
  }

  async setPermissionMode(
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk"
  ): Promise<void> {
    if (!this.q || this.closed) return;
    await this.q.setPermissionMode(mode);
  }

  async supportedCommands(): Promise<Array<{ name: string; description: string; aliases?: string[] }>> {
    if (!this.q || this.closed) return [];
    try {
      const cmds = await this.q.supportedCommands();
      return cmds.map((c) => ({
        name: c.name,
        description: c.description ?? "",
        aliases: parseAliases(c.aliases),
      }));
    } catch (e) {
      this.opts.log(`supportedCommands() error: ${String(e)}`);
      return [];
    }
  }

  private endTurn(
    kind: "turn_completed" | "turn_interrupted" | "turn_failed",
    extra?: {
      usage?: UsageSnapshot;
      reason?: string;
      errorKind?: "usage_limit";
      resetsAt?: number | null;
      detail?: string;
    }
  ): void {
    this.normalizer.endTurn(kind, extra);
  }

  private async runLoop(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const msg of this.q) {
        if (!this.firstMessageLogged && this.startMarks !== null) {
          this.firstMessageLogged = true;
          this.opts.log(`CLI first message: ${Date.now() - this.startMarks.queried}ms after query() (${(msg as { type?: string }).type ?? "?"})`);
        }
        this.handleMessage(msg);
      }
      if (this.normalizer.turnState !== "idle") {
        this.endTurn(
          this.normalizer.turnState === "interrupting" ? "turn_interrupted" : "turn_failed",
          { reason: "backend_lost" }
        );
      }
      if (!this.closed) {
        this.closed = true;
        this.emit({ kind: "conversation_closed", reason: "backend_exited" });
      }
    } catch (e) {
      const aborted = this.abortController.signal.aborted;
      if (this.normalizer.turnState !== "idle") {
        this.endTurn(aborted ? "turn_interrupted" : "turn_failed", {
          reason: aborted ? undefined : String(e),
        });
      }
      if (!this.closed) {
        this.closed = true;
        this.emit({
          kind: "conversation_closed",
          reason: aborted ? "aborted" : `error: ${String(e)}`,
        });
      }
    } finally {
      await Promise.allSettled([...this.activeExternalRuns]);
      await this.attribution.close();
    }
  }

  private handleMessage(msg: any): void {
    if (msg?.type === "system" && msg?.subtype === "task_started" && msg.task_type === "local_agent"
      && typeof msg.tool_use_id === "string" && typeof msg.task_id === "string") this.attribution.started(msg.tool_use_id, msg.task_id, msg.is_backgrounded);
    if (msg?.type === "system" && msg?.subtype === "task_updated" && typeof msg.task_id === "string") void this.attribution.updated(msg.task_id, msg.patch?.is_backgrounded);
    if (msg?.type === "system" && msg?.subtype === "task_notification") {
      const parent = typeof msg.tool_use_id === "string" ? msg.tool_use_id
        : typeof msg.task_id === "string" ? this.attribution.parentOfTask(msg.task_id) : undefined;
      if (parent) void this.attribution.notification(parent, msg.status, msg.task_id, msg.uuid);
    }
    if (msg?.type === "assistant" && typeof msg.parent_tool_use_id === "string" && typeof msg.message?.model === "string") {
      this.attribution.model(msg.parent_tool_use_id, msg.message.model);
    }
    if (msg?.type === "assistant" && msg.parent_tool_use_id == null && Array.isArray(msg.message?.content)) {
      const text = msg.message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("");
      if (text) this.turnAssistantText.push(text);
    }
    if (msg?.type !== "tool_progress") this.lastRecordReceivedAt = Date.now();
    if (msg?.type === "stream_event" && msg.parent_tool_use_id == null && msg.event?.type === "message_start") this.lastRootMessageStartedAt = Date.now();
    const bridge = bridgeStateOf(msg);
    if (bridge !== undefined) this.opts.onBridgeState?.(bridge);
    if (msg?.type === "system" && msg?.subtype === "init" && Array.isArray(msg.capabilities)) {
      this.cliCapabilities = msg.capabilities.filter((c: unknown): c is string => typeof c === "string");
    }
    this.normalizer.handleMessage(msg);
  }

  private emit(
    ev: NormalizedEventBody & { provenance?: EventProvenance },
    meta?: NormalizedOutMeta
  ): void {
    if (ev.kind === "turn_started" || ev.kind === "compact_boundary" || ev.kind === "tool_call_finished") {
      this.invalidateHandoffContextUsage();
    }
    if (ev.kind === "turn_started") this.turnAssistantText = [];
    if (ev.kind === "auth_status" && ev.auth?.sessionId) this.authSessionId = ev.auth.sessionId;
    this.opts.onEvent(ev, this.conversationId, meta);
    this.usageLimitResume.observe(ev);
    if (ev.kind === "conversation_closed") {
      this.resolveInitialContextUsage(null);
      this.unsubscribeAutoContinue();
    }
  }

  async dispose(): Promise<void> {
    this.cancelAutoResume();
    this.unsubscribeAutoContinue();
    if (this.inputQueue.length > 0) {
      this.opts.log(`dispose: ${this.inputQueue.length} unsent inputs remain`);
    }
    this.closed = true;
    this.resolveInitialContextUsage(null);
    this.todoGate?.clear();
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    for (const requestId of this.pendingApprovals.keys()) this.resolveApproval(requestId, "deny", undefined, "dispose");
    this.inputWaiter?.();
    this.inputWaiter = null;
    try {
      if (this.normalizer.turnState === "running") await this.interrupt();
    } finally {
      this.abortController.abort();
    }
    try {
      await this.inputGen?.return(undefined as never);
    } catch {
    }
    if (this.runLoopDone) {
      await Promise.race([
        this.runLoopDone,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    await Promise.allSettled([...this.activeExternalRuns]);
    await this.attribution.close();
  }

  rearmRootModelObservation(): void {
    this.normalizer.rearmRootModelObservation();
  }

  async setModel(model?: string): Promise<void> {
    if (!this.q || this.closed) return;
    this.invalidateHandoffContextUsage();
    try {
      await this.q.setModel(model);
    } finally {
      void this.requestContextUsage();
    }
  }

  async setEffort(effort: "low" | "medium" | "high" | "xhigh" | "max" | null): Promise<void> {
    if (!this.q || this.closed) throw new Error("Claude conversation is not connected");
    this.invalidateHandoffContextUsage();
    await this.q.applyFlagSettings({ effortLevel: effort });
  }

  async setRemoteControl(enabled: boolean, reattachSessionId?: string): Promise<RemoteControlSession | null> {
    if (!this.q || this.closed) throw new Error("Claude conversation is not connected");
    return enableRemoteControl(this.q, enabled, reattachSessionId);
  }

  async remoteControlAutoEnable(): Promise<boolean> {
    const q = this.q;
    if (!q || this.closed) return false;
    try {
      const init = await q.initializationResult();
      return init?.remote_control_auto_enable === true;
    } catch {
      return false;
    }
  }

  async captureHandoffContextUsage(): Promise<HandoffContextMeasurement | null> {
    if (this.closed || this.state !== "idle") return null;
    return this.contextUsageInFlight ?? this.requestContextUsage();
  }

  async appliedSettings(): Promise<
    { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" | null } | undefined
  > {
    if (!this.q || this.closed || typeof this.q.getSettings !== "function") return undefined;
    try {
      const settings = await this.q.getSettings();
      const applied = typeof settings === "object" && settings !== null ? (settings as { applied?: unknown }).applied : undefined;
      if (typeof applied !== "object" || applied === null) return undefined;
      const { model, effort } = applied as { model?: unknown; effort?: unknown };
      return {
        ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
        ...(effort === null || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max"
          ? { effort }
          : {}),
      };
    } catch (error) {
      this.opts.log(`getSettings failed: ${String(error)}`);
      return undefined;
    }
  }

  async renameSession(title: string, sessionId?: string): Promise<boolean> {
    const q = this.q;
    if (!q || this.closed || typeof q.renameSession !== "function") return false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        q.renameSession(title, sessionId),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("rename_session timeout")), RENAME_SESSION_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch (error) {
      this.opts.log(`renameSession failed: ${String(error)}`);
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async supportedModels(): Promise<Array<{ id: string; label: string; description: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>> {
    if (!this.q || this.closed) return [];
    try {
      const models = await this.q.supportedModels();
      return models
        .map((m) => {
          const id = m.model ?? m.id ?? m.value ?? "";
          return { id, label: modelLabelWithVersion(m.displayName, id, m.resolvedModel), description: m.description ?? "",
            resolvedModel: m.resolvedModel, supportsEffort: m.supportsEffort, supportedEffortLevels: m.supportedEffortLevels };
        })
        .filter((m) => m.id.length > 0);
    } catch (e) {
      this.opts.log(`supportedModels() error: ${String(e)}`);
      return [];
    }
  }

  async planUsageRateLimits(timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const q = this.q;
    if (!q || signal?.aborted || this.closed || this.state !== "idle" || typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return null;
    const deadline = Date.now() + timeoutMs;
    const usable = (): boolean => !signal?.aborted && !this.closed && this.q === q && this.state === "idle" && Date.now() < deadline;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = await Promise.race([
        (async () => {
          await q.initializationResult();
          if (!usable()) return null;
          return q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!({ skipBehaviors: true });
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("usage timeout")), timeoutMs);
        }),
      ]);
      if (!usable()) return null;
      return typeof response === "object" && response !== null ? (response as { rate_limits?: unknown }).rate_limits ?? null : null;
    } catch (e) {
      this.opts.log(`usage() failed (${e instanceof Error ? e.name : typeof e})`);
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  resolveApproval(requestId: string, behavior: ApprovalDecision["behavior"], answers?: Record<string, string>, resolvedBy = "user"): void {
    const p = this.pendingApprovals.get(requestId);
    if (p) {
      this.pendingApprovals.delete(requestId);
      const useAnswers = behavior === "allow" && p.toolName === "AskUserQuestion" ? answers : undefined;
      p.resolve({ behavior, resolvedBy, ...(useAnswers ? { answers: useAnswers } : {}) });
    }
  }

  registerPendingApproval(requestId: string, toolName: string, resolve: (r: ApprovalDecision) => void, toolUseId?: string): void {
    this.pendingApprovals.set(requestId, { requestId, toolName, resolve, toolUseId });
  }

  private requestContextUsage(initial = false): Promise<HandoffContextMeasurement | null> {
    if (!this.q || this.closed) return Promise.resolve(null);
    if (this.contextUsageInFlight) {
      this.contextUsagePending = true;
      return Promise.resolve(null);
    }
    const request = this.measureContextUsage(this.q, initial);
    this.contextUsageInFlight = request;
    return request;
  }

  private async measureContextUsage(q: QueryHandle, initial: boolean): Promise<HandoffContextMeasurement | null> {
    const generation = this.contextUsageGeneration;
    const turnsEnded = this.turnsEnded;
    let measurement: HandoffContextMeasurement | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    try {
      const usage = await Promise.race([
        (async () => {
          await q.initializationResult();
          if (settled || this.closed || this.q !== q || this.contextUsageGeneration !== generation) return null;
          return q.getContextUsage();
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("getContextUsage timeout")), 10_000);
        }),
      ]);
      if (this.closed || this.q !== q || this.contextUsageGeneration !== generation) return null;
      if (
        !usage ||
        !Number.isFinite(usage.percentage) ||
        usage.percentage < 0 ||
        usage.percentage > 100 ||
        !Number.isFinite(usage.totalTokens) ||
        usage.totalTokens < 0 ||
        !Number.isFinite(usage.maxTokens) ||
        usage.maxTokens <= 0 ||
        (usage.autoCompactThreshold !== undefined &&
          (!Number.isFinite(usage.autoCompactThreshold) || usage.autoCompactThreshold < 0)) ||
        typeof usage.isAutoCompactEnabled !== "boolean"
      ) {
        this.opts.log("getContextUsage() returned invalid fields");
        return null;
      }
      if (this.state === "idle") measurement = { totalTokens: usage.totalTokens, measuredAt: new Date().toISOString() };
      this.contextUsageTurnsEnded = turnsEnded;
      this.emit({
        kind: "context_usage",
        percentage: usage.percentage,
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        autoCompactThreshold: usage.autoCompactThreshold,
        isAutoCompactEnabled: usage.isAutoCompactEnabled,
      });
      return measurement;
    } catch (e) {
      this.opts.log(`getContextUsage() error: ${String(e)}`);
      return null;
    } finally {
      settled = true;
      if (initial) this.resolveInitialContextUsage(measurement);
      if (timeout) clearTimeout(timeout);
      const shouldRetry = this.contextUsagePending && !this.closed && this.q === q;
      this.contextUsagePending = false;
      this.contextUsageInFlight = null;
      if (shouldRetry) void this.requestContextUsage();
    }
  }
}
