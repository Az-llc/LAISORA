import { UsageLimitResume, SDK_AUTO_CONTINUE_SETTINGS } from "./usage-limit-resume";
import { readClaudeCodeSettings, onAutoContinueSettingChange } from "./claude-code-settings";
import { modelLabelWithVersion } from "./model-display-name";
export { modelLabelWithVersion } from "./model-display-name";
import { appendRunRecord, DISPATCH_BUDGET_EXCEEDED, DISPATCH_INTERNAL_ERROR, externalDescription, isExternalTimeout, observeAgentRun, runExternal, runFailureReason, type ExternalRow, type OrchestrationRunRecord, type AgentRunRecord } from "./orchestration-external";

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { summarizeToolInput, type ApiKeyPolicy } from "./protocol";
import { resolveClaudeCodeStartup } from "./claudeCliResolver";
import {
  buildClaudeEnv,
  claudeConfigDir,
  envNameKey,
} from "./claude-env";
import { PROGRESS_PROTOCOL_SPEC_PP1 } from "./progress-protocol";
import { checkEnvelopeRedaction } from "./send-boundary";
import { admitReportSend, admitSteeringSend, type SteeringAdmission } from "./steering-envelope";

export type SteeringSendResult = SteeringAdmission;
import type { ProgressTrackingMode } from "./progress-protocol";
import { PROGRESS_WIRE_TOOL_NAME } from "./artifact-access";
import { z } from "zod";
import { ClaudeLiveNormalizer, parseAliases } from "./claude-normalizer";
import { conductorInstruction, orchestrationExternalTargets, orchestrationAgents, orchestrationVariants, resolveOrchestrationRoster, type OrchestrationRow, type ExternalModels } from "./orchestration-roster";
import { injectionOf, MAX_AGENT_STARTS, type AgentStartObservation, type RosterEvidence, type RosterInjection } from "./roster-evidence";
import { type LearningFacts } from "./learning";
import { PLACEMENT_LINE } from "./placement-line";
import { compileVocabulary, PLACEMENT_EFFORT_WORDS, DEFAULT_ROLE_NAMES, placementPath, judgeFileWrite, judgeShellWrite, placementGuardReason, PLACEMENT_UNREADABLE_REFUSAL } from "./placement-guard";
import { assignLearningExperiment, EXPERIMENT_HOLDOUT_PERCENT } from "./learning-experiment";
import { LearningMeasurement, learningCandidateMatches } from "./learning-measurement";
import { qualifyClaims } from "./learning-episodes";
import type { Detector } from "./learning-detector";
import { LearningDelivery, sectionFromLedger, readMeasuredRuns, DEFAULT_LEARNING_SWITCHES, type LearningSwitches, type PromptBudget } from "./learning-delivery";
import type { SectionResult } from "./learning-section";
import { resolveClaudeProfileModel, type ProfileTarget } from "./orchestration-profiles";
import { LearningRecorder, type LearningRecordResult as LearningResult, type LearningToolKind } from "./learning-recording";
import { createLearningMcpServer, LearningRootGate, LEARNING_INSTRUCTION, LEARNING_TOOL_NAMES } from "./learning-mcp";
import { claudeModelIdLabel } from "./orchestration-executors";
import { LearningIngestion, delegationInvalidFields, type LearningToolResult, type LearningSubject } from "./learning-ingestion";
import { AgentAttribution } from "./orchestration-attribution";
import type { NormalizedOutMeta } from "./claude-normalizer";

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
};

type PermissionResult = ClaudeCodePermissionResult;

type InterruptReceipt = { still_queued?: string[]; cancelled?: string[] };

const CAP_INTERRUPT_CANCEL_QUEUED = "interrupt_cancel_queued_v1";

export const FILE_LINK_INSTRUCTION = (cwd = ""): string => {
  const base = cwd
    ? `Relative targets resolve against the conversation folder ${JSON.stringify(cwd.replace(/\\/g, "/"))}, fixed at conversation start, not against the shell's current directory. Use absolute paths for files outside this folder.`
    : "The conversation working directory is unknown; use absolute paths.";
  return `When you mention a local file or folder, write it as a Markdown link. The link target is the absolute path or the path relative to the ${cwd ? "conversation folder" : "working directory"}, with forward slashes, optionally followed by #L<line> or #L<line>C<column>. ${base} Use the path and line as the link text, for example [src/app.ts:42](src/app.ts#L42) or [app.ts](C:/work/src/app.ts). Folders end with a slash: [artifacts/](artifacts/). Files such as spreadsheets, documents and PDFs are linked the same way and open in their default app. If the path contains spaces, wrap the target in angle brackets: [notes.md](<docs/my notes.md>). Write web URLs with the https:// scheme.`;
};

export const ASK_DECIDE_FORMAT = () => [
  l10n.t("Use a fenced code block whose language is exactly laisora-ask. Use the user's language for values. This is a strict YAML-like subset: one nonempty scalar key: value per line; no comments, multiline scalars, nesting, aliases or flow collections. Plain text and JSON double-quoted strings are supported; a plain value must not start with |, >, &, * or ! (use a JSON double-quoted string instead). Keys are unique. List entries use exactly two spaces before '- ' and four spaces before subsequent keys."),
  l10n.t("A decision requires kind, title, why, options and default. Every option requires label, effect, pros and cons; mark your recommended option with recommended: true and explain why in its effect. Other options omit recommended."),
  l10n.t("```laisora-ask\nkind: decide\ntitle: What should we choose?\nwhy: Why this decision matters now.\noptions:\n  - label: First choice\n    effect: What happens next and why I recommend it.\n    pros: Its benefit in plain words.\n    cons: Its drawback in plain words.\n    recommended: true\n  - label: Second choice\n    effect: What happens next.\n    pros: Its benefit.\n    cons: Its drawback.\ndefault: Without an answer, I will continue with A.\n```"),
].join("\n");

export const PLAN_INSTRUCTION = [
  "When starting multi-step work, first write a laisora-plan block with the goal as you understand it, then the TaskCreate steps; do not restate the user's words.",
  "For requests with more than one step, use TaskCreate before starting: one task per step, subject as the step title, and activeForm set.",
  "Use TaskUpdate to mark each step in_progress when starting and completed when done. Add new steps at the end with TaskCreate.",
  "When you need the user's decision or a real-machine check, do not bury it in prose. Write a ```laisora-ask block (format below) at the point you ask.",
  "In every decision, whether in a laisora-ask block or AskUserQuestion, state: what is being decided and why now; for each option, what happens after choosing it, with its merits and drawbacks in plain words rather than technical terms; your recommendation and why; and what you will do if there is no answer.",
  "Use AskUserQuestion only when you cannot continue without the answer; otherwise use a laisora-ask block and continue with the stated default.",
  "<format>",
  "A laisora-plan fence contains only goal: followed by one nonempty line in the user's language, using the same scalar rules below: ```laisora-plan\ngoal: Make progress visible throughout the work\n```.",
  ASK_DECIDE_FORMAT(),
  "A real-machine check requires kind, title, why, steps and default. Every step requires do (the action) and look (what to observe). Do not mix options and steps.",
  "```laisora-ask\nkind: check\ntitle: Check the result on your machine\nwhy: What I cannot verify here.\nsteps:\n  - do: Open the changed screen.\n    look: Confirm the labels fit without clipping.\n  - do: Resize the window.\n    look: Confirm every action remains reachable.\ndefault: While awaiting the result, I will continue with the independent work.\n```",
  "</format>",
].join("\n");

export function conversationSystemPrompt(fileLinkInstruction: boolean, planInstruction = true, cwd = ""): NonNullable<ClaudeCodeOptions["systemPrompt"]> {
  return { type: "custom", prompt: [fileLinkInstruction ? FILE_LINK_INSTRUCTION(cwd) : "", planInstruction ? PLAN_INSTRUCTION : "", PLACEMENT_LINE].filter(Boolean).join("\n\n"), snapshot: false };
}

interface QueryHandle extends AsyncIterable<any> {
  interrupt(options?: { cancelQueued?: boolean }): Promise<InterruptReceipt | undefined>;
  setPermissionMode(mode: string): Promise<void>;
  supportedCommands(): Promise<Array<{ name: string; description?: string; aliases?: string[] }>>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null }): Promise<void>;
  getSettings?(): Promise<unknown>;
  supportedModels(): Promise<Array<{ model?: string; id?: string; value?: string; resolvedModel?: string; displayName?: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>>;
  initializationResult(): Promise<unknown>;
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
  initialObservedTimestamp?: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  resumeSessionId?: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk";
  settingSources: Array<"user" | "project" | "local">;
  remoteControlAtStartup?: boolean;
  claudeCodeExecutablePath?: string;
  apiKeyPolicy?: ApiKeyPolicy;
  fileLinkInstruction?: boolean;
  planInstruction?: boolean;
  orchestrationEnabled?: boolean;
  orchestrationAgents?: unknown;
  externalModels?: ExternalModels;
  externalTimeoutMinutes?: number;
  orchestrationRunsDirectory?: string;
  learningEnabled?: boolean;
  learningSwitches?: () => Partial<LearningSwitches>;
  learningHoldoutPercent?: () => number;
  learningDedicated?: boolean;
  learningDetectorCandidate?: { version: number; detect: Detector };
  learningPromptBudget?: (executor: string, model: string) => PromptBudget;
  learningDirectory?: string;
  learningEvidenceSource?: string;
  configuredResolvedModel?: string;
  conductorPolicy?: string;
  onOrchestrationChanged?: () => void;
  onLearningRecorded?: () => void;
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
  const startup = await resolveClaudeCodeStartup(configuredExecutablePath, sdkClaudeCodeVersion());
  const { env } = buildClaudeEnv(process.env, apiKeyPolicy);
  return { sdk, claudeExecutablePath: startup.executable.path, env };
}

export class ClaudeConversation {
  private ingestion?: LearningIngestion;
  private recordingModel?: string;
  private attribution: AgentAttribution;
  private readonly pendingTargetResults = new Map<string, LearningToolResult[]>();
  private readonly targetFailures = new Set<string>();
  private readonly externalToolUses: Array<{ id: string; input: Record<string, unknown> }> = [];
  private readonly handledExternalCalls = new Set<string>();
  private readonly hookTools = new Map<string, { tool: string; input: unknown; parent?: string; model?: string }>();
  get durableConversationKey(): string | undefined { return this.ingestion?.conversation; }
  private ingestResult(result: LearningToolResult): void {
    if (this.handledExternalCalls.has(result.toolUseId)) return;
    if (result.parentToolUseId && !result.observedModel) result = { ...result,
      observedModel: this.hookTools.get(result.toolUseId)?.model ?? this.attribution.observedModel(result.parentToolUseId) ?? "unknown" };
    if (["Agent", "Task", "mcp__laisora_external__run"].includes(result.tool)) {
      const fields = delegationInvalidFields(result.tool, result.input);
      const rejected = result.isError && !this.attribution.hasRuntime(result.toolUseId)
        && /(?:input validation failed|invalid (?:input|arguments|parameters)|validation error|InputValidationError)/i.test(result.text) && fields.length > 0;
      if (rejected) {
        void this.ingestion?.result({ ...result, parentToolUseId: undefined, observedModel: this.recordingModel ?? "unknown", boundaryCode: "delegation_invalid", fields,
          dispatchId: this.attribution.dispatchRef(result.toolUseId) });
        return;
      }
    }
    if (["Agent", "Task"].includes(result.tool)) {
      if (!result.executorFailure) void this.attribution.result(result.toolUseId, result.text, result.isError);
      if (!result.isError && !result.executorFailure || result.hookDenied) {
        if (result.hookDenied) void this.ingestion?.result(result);
        return;
      }
      if (this.targetFailures.has(result.toolUseId)) return;
      result = { ...result, parentToolUseId: result.toolUseId, observedModel: this.attribution.observedModel(result.toolUseId),
        dispatchId: this.attribution.dispatchRef(result.toolUseId) };
    } else if (result.parentToolUseId && result.isError) this.targetFailures.add(result.parentToolUseId);
    if (result.parentToolUseId && !this.attribution.subject(result.parentToolUseId)) {
      const list = this.pendingTargetResults.get(result.parentToolUseId) ?? [];
      list.push(result);
      this.pendingTargetResults.set(result.parentToolUseId, list);
    } else void this.ingestion?.result(result);
  }

  private async settleTargetResults(parent: string, agentId?: string, subject?: LearningSubject): Promise<void> {
    if (agentId) {
      const placeholder = `agent:${agentId}`;
      const results = this.pendingTargetResults.get(placeholder) ?? [];
      this.pendingTargetResults.delete(placeholder);
      const list = this.pendingTargetResults.get(parent) ?? [];
      list.push(...results.map(result => ({ ...result, parentToolUseId: parent })));
      this.pendingTargetResults.set(parent, list);
    }
    const results = this.pendingTargetResults.get(parent) ?? [];
    this.pendingTargetResults.delete(parent);
    if (results.some(result => result.isError && !["Agent", "Task"].includes(result.tool))) this.targetFailures.add(parent);
    for (const result of results) {
      if (["Agent", "Task"].includes(result.tool) && this.targetFailures.has(parent)) continue;
      await this.ingestion?.result(subject && !result.subject ? { ...result, subject } : result);
    }
  }
  private readonly externalRows: readonly ExternalRow[];
  private readonly activeExternalRuns = new Set<Promise<unknown>>();
  private readonly externalTimeoutMinutes: number;
  private readonly runs: OrchestrationRunRecord[] = [];
  private readonly agentRuns = new Map<string, AgentRunRecord>();
  get orchestrationRuns(): readonly OrchestrationRunRecord[] { return Object.freeze([...this.runs]); }
  get observedAgentRuns(): ReadonlyMap<string, AgentRunRecord> { return new Map(this.agentRuns); }
  private async recordRun(unstamped: OrchestrationRunRecord): Promise<OrchestrationRunRecord> {
    let learningFailure: string | undefined;
    try { await this.delivery?.run(unstamped); }
    catch (error) { learningFailure = runFailureReason("R-LRN-07: could not record the run in the learning ledger", error); }
    if (learningFailure) unstamped = { ...unstamped, reason: [unstamped.reason, learningFailure].filter(Boolean).join("; ") } as OrchestrationRunRecord;
    const sessionId = this.learningSessionRef ?? this.opts.resumeSessionId;
    const runId = unstamped.runId ?? randomUUID();
    const dispatchId = unstamped.dispatchId ?? randomUUID();
    let record: OrchestrationRunRecord = Object.freeze({ ...unstamped,
      runId: this.ingestion?.ref("run", runId) ?? runId,
      dispatchId: this.ingestion?.ref("dispatch", dispatchId) ?? dispatchId,
      recipient: this.ingestion?.ref("recipient", unstamped.recipient ?? `external:${runId}`) ?? unstamped.recipient ?? `external:${runId}`,
      conversation: this.durableConversationKey ?? "unknown", ...(sessionId ? { sessionId } : {}) });
    const index = this.runs.length;
    this.runs.push(record);
    if (record.kind === "external") {
      const external = record;
      await this.queueLearningR33(async () => {
        const usage = external.usage;
        const input = usage?.input_tokens;
        const promptTokens = typeof input !== "number" ? null : external.executor === "codex" ? input
          : typeof usage?.cache_read_input_tokens === "number" && typeof usage?.cache_creation_input_tokens === "number"
            ? input + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : null;
        await this.measurement?.record({ externalRuns: 1, promptTokens, externalInputTokens: input ?? null,
          ...(this.opts.learningDedicated ? { researchTokens: promptTokens, researchCost: null } : {}) },
          { executor: external.executor, model: external.observedModel ?? "unknown", role: external.role }, `external-usage:${runId}`);
      });
    }
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
  private readonly initialOrchestrationSettings: { settings: unknown; deliveredSetHash?: string };
  private delivery?: LearningDelivery;
  private deliverySnapshot?: SectionResult;
  private readonly researchModels: ProfileTarget[] = [];
  get learningToolAvailable(): boolean { return !!this.learningGate && !this.closed; }
  private researchId?: string;
  private recorder?: LearningRecorder;
  allowResearchModels(targets: readonly ProfileTarget[]): string {
    this.researchModels.push(...targets);
    return this.researchId ??= randomUUID();
  }
  private learningSessionRef?: string;
  private learningGate?: LearningRootGate;
  private measurement?: LearningMeasurement;
  private handlingResult = false;
  private learningObservation: Promise<void> = Promise.resolve();
  private readonly observedAgents = new Map<string, Readonly<{ agentType?: string; model?: string; effort?: string }>>();

  get orchestrationRoster(): readonly OrchestrationRow[] { return this.roster; }
  get orchestrationActive(): boolean { return this.orchestrationEnabled; }
  get orchestrationExternalRoster(): readonly ExternalRow[] { return this.externalRows; }

  get learningFacts(): LearningFacts | undefined {
    if (!this.ingestion?.ready) return undefined;
    const state = this.ingestion.ledger.state, records = [...state.records.values()];
    const model = this.recordingModel ?? resolveClaudeProfileModel(this.opts.model, this.opts.externalModels, this.opts.configuredResolvedModel);
    const qualifications = { active: 0, quarantined: 0, reviewDue: 0, retiredHuman: 0, retiredConductor: 0, candidate: 0, rejected: 0, imported: 0 };
    for (const rule of state.rules.values()) if (rule.key.bind === "conductor" && rule.key.model === (model && claudeModelIdLabel(model))) {
      if (rule.active) qualifications.active++; else qualifications.candidate++;
    }
    const current = records.filter(record => record.conversation === this.ingestion!.conversation);
    const mismatch = current.some(record => record.kind === "exposure" && record.route === "conductor" && record.outcome === "model-mismatch");
    const delivery = current.find(record => record.kind === "delivery");
    const claims = current.filter(record => record.kind === "claim" && record.source === "observation");
    return { ledgerVersion: 2, coverage: !model ? "model-unknown" : !this.learningSessionRef ? "session-unknown" : "observed",
      delivered: { count: delivery?.kind === "delivery" ? delivery.items.filter(item => item.type === "rule").length : 0,
        setHash: delivery?.kind === "delivery" ? delivery.setHash : "", outcome: mismatch ? "model-mismatch" : delivery?.kind === "delivery" ? delivery.outcome : "none" },
      observations: claims.length, evidenced: claims.filter(record => record.kind === "claim" && record.evidence.creditedRunIds.length).length,
      recurrences: current.filter(record => record.kind === "episode" && record.status === "counted").length,
      qualifications, generalQualifications: { ...qualifications, active: 0, candidate: 0 } };
  }
  private effectiveLearningSwitches(): LearningSwitches {
    const switches = { ...DEFAULT_LEARNING_SWITCHES, enabled: this.opts.learningEnabled === true, ...this.opts.learningSwitches?.() };
    if (this.opts.learningHoldoutPercent?.() === 0) switches.experiment = false;
    return switches;
  }
  private orchestrationSettings(options: Partial<ClaudeHostOptions>): unknown {
    return { enabled: options.orchestrationEnabled === true, agents: options.orchestrationAgents ?? [],
      learningEnabled: options.learningEnabled === true,
      timeout: options.externalTimeoutMinutes ?? 10,
      policy: options.conductorPolicy ?? "" };
  }

  orchestrationSettingsChanged(options: Partial<ClaudeHostOptions>): boolean {
    return !isDeepStrictEqual(this.initialOrchestrationSettings, {
      settings: this.orchestrationSettings(options), deliveredSetHash: this.initialOrchestrationSettings.deliveredSetHash,
    });
  }

  private async prepareLearningDeliveryR31(): Promise<string> {
    this.opts.log(`R-LRN-42: learning components ${JSON.stringify(this.effectiveLearningSwitches())}`);
    const ingestion = this.ingestion;
    if (!ingestion) return "";
    this.delivery = new LearningDelivery(ingestion, () => this.effectiveLearningSwitches(), this.opts.log);
    if (!ingestion.ready || !this.durableConversationKey) return "";
    try {
      const candidate = this.opts.learningDetectorCandidate;
      if (candidate) ingestion.detector.adopt(candidate.version, candidate.detect);
      this.measurement = new LearningMeasurement(ingestion);
      await this.measurement.control(this.effectiveLearningSwitches());
      if (this.opts.learningEvidenceSource) {
        const state = ingestion.ledger.state;
        if (this.opts.learningEvidenceSource === "unknown" || state.unavailableConversations.has(this.opts.learningEvidenceSource)) return "";
        const source = state.assignments.get(this.opts.learningEvidenceSource);
        if (source && !state.assignments.has(this.durableConversationKey)) await ingestion.ledger.append({ ...source,
          conversation: this.durableConversationKey, eligible: false, reason: "effort-inherited", opId: ingestion.ref("effort-assignment", this.durableConversationKey), at: new Date().toISOString() });
      }
      const model = resolveClaudeProfileModel(this.opts.model, this.opts.externalModels, this.opts.configuredResolvedModel);
      const runs = await readMeasuredRuns(this.opts.orchestrationRunsDirectory, this.opts.log);
      const state = ingestion.ledger.state;
      const candidates = sectionFromLedger(state.records.values(), state.rules.values(), this.roster, this.opts.externalModels,
        model ? claudeModelIdLabel(model) : "unknown", ingestion.projectRef, this.durableConversationKey, new Date().toISOString(), runs, this.effectiveLearningSwitches());
      const assignment = await assignLearningExperiment(ingestion.ledger, this.durableConversationKey, this.effectiveLearningSwitches(), candidates.items.map(item => item.id),
        ingestion.detector.version, !!this.opts.learningDedicated || !!this.researchId || !!this.opts.learningEvidenceSource, this.opts.learningHoldoutPercent?.() ?? EXPERIMENT_HOLDOUT_PERCENT);
      if (!assignment) return "";
      await this.measurement.record({ relevantOpportunities: 0, candidateOpportunities: 0, toolCalls: 0, toolResults: 0, turns: 0, turnStarts: 0, usageResults: 0,
        promptTokens: 0, researchTokens: 0, researchCost: 0 }, {}, `start:${ingestion.conductorSubject.run}`);
      const assignedState = ingestion.ledger.state;
      this.deliverySnapshot = sectionFromLedger(assignedState.records.values(), assignedState.rules.values(), this.roster, this.opts.externalModels,
        model ? claudeModelIdLabel(model) : "unknown", ingestion.projectRef, this.durableConversationKey, new Date().toISOString(), runs, this.effectiveLearningSwitches());
      this.initialOrchestrationSettings.deliveredSetHash = this.deliverySnapshot.setHash;
      if (this.deliverySnapshot.dropped) this.opts.log(`R-LRN-05: learning section budget withheld ${this.deliverySnapshot.dropped} items`);
      return this.deliverySnapshot.text;
    } catch (error) {
      this.opts.log(runFailureReason("R-LRN-07: could not prepare learning delivery", error));
      return "";
    }
  }
  private async recordLearningR12(input: unknown, rootVerified: boolean, kind: LearningToolKind): Promise<LearningResult> {
    if (!rootVerified) return { ok: false, code: "caller-unverified", requirement: "R-LRN-12" };
    if (!this.ingestion) return { ok: false, code: rootVerified ? "state-unavailable" : "caller-unverified", requirement: "R-LRN-12" };
    await this.ingestion.flush();
    this.recorder ??= new LearningRecorder(this.ingestion.ledger);
    return this.recorder.record(kind, input, { rootVerified, ready: this.ingestion.ready, conversation: this.ingestion.conversation,
      session: this.ingestion.sessionRef, project: this.ingestion.projectRef, conductorModel: this.recordingModel ?? "unknown", cwd: this.opts.cwd,
      models: this.opts.externalModels, roles: new Set(this.roster.filter(row => row.enabled).map(row => row.role)), runs: this.orchestrationRuns,
      research: this.researchId ? { id: this.researchId, targets: this.researchModels.map(target => ({ ...target,
        model: target.executor === "claude" ? claudeModelIdLabel(target.model) : target.model })) } : undefined,
      ref: (domain, value) => this.ingestion!.ref(domain, value) });
  }
  private readonly learningGapScope = randomUUID();
  private learningGaps = 0;
  private learningGapsRecorded = 0;
  private queueLearningR33(action: () => Promise<void>): Promise<void> {
    this.learningObservation = this.learningObservation.then(() => this.recordLearningGaps()).then(action).catch(error => {
      this.learningGaps++;
      this.opts.log(runFailureReason("R-LRN-07: could not append learning receipt", error));
    });
    return this.learningObservation;
  }
  private async recordLearningGaps(): Promise<void> {
    if (this.learningGaps === this.learningGapsRecorded || !this.ingestion || !this.measurement) return;
    if (!this.ingestion.ledger.consistent) await this.ingestion.ledger.reload();
    if (!this.ingestion.ledger.consistent) return;
    const gaps = this.learningGaps;
    await this.measurement.record({ measurementGap: gaps - this.learningGapsRecorded }, {},
      `measurement-gap:${this.ingestion.conversation}:${this.learningGapScope}:${gaps}`);
    this.learningGapsRecorded = gaps;
  }
  private observeLearningModelR30(model: string): Promise<void> {
    this.recordingModel = model;
    return this.queueLearningR33(async () => {
      const observed = claudeModelIdLabel(model);
      await this.delivery?.observed(this.ingestion!.conductorSubject.dispatchId, observed, "unknown", ["conductor:model_observed"]);
    });
  }
  get observedAgentSettings(): ReadonlyMap<string, Readonly<{ agentType?: string; model?: string; effort?: string }>> {
    return new Map(this.observedAgents);
  }

  private readonly rosterInjections: RosterInjection[] = [];
  private readonly agentStarts = new Map<string, AgentStartObservation>();
  get rosterEvidence(): RosterEvidence {
    return { injections: [...this.rosterInjections], starts: [...this.agentStarts.values()] };
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

  constructor(private readonly opts: ClaudeHostOptions) {
    this.usageLimitResume = new UsageLimitResume({
      now: Date.now,
      random: Math.random,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      enabled: () => readClaudeCodeSettings(true).autoContinueAtUsageLimit !== false,
      connected: () => this.q !== null && !this.closed,
      live: () => this.q !== null && !this.closed && this.state === "idle" && this.inputQueue.length === 0,
      send: (text) => this.send(text, undefined, undefined, true),
      notify: (event) => this.emit(event),
    });
    this.unsubscribeAutoContinue = onAutoContinueSettingChange(() => {
      if (readClaudeCodeSettings(true).autoContinueAtUsageLimit === false) this.cancelAutoResume();
    });
    this.initialOrchestrationSettings = { settings: structuredClone(this.orchestrationSettings(opts)), deliveredSetHash: undefined };
    this.orchestrationEnabled = opts.orchestrationEnabled === true;
    const resolved = resolveOrchestrationRoster(this.orchestrationEnabled ? opts.orchestrationAgents : []);
    this.roster = resolved.roster;
    this.externalRows = orchestrationExternalTargets(this.roster, opts.externalModels, opts.log);
    this.externalTimeoutMinutes = isExternalTimeout(opts.externalTimeoutMinutes) ? opts.externalTimeoutMinutes : 10;
    this.conductorPolicy = opts.conductorPolicy ?? "";
    for (const dropped of resolved.droppedRows) opts.log(dropped);
    this.attribution = new AgentAttribution(() => this.rosterEvidence, record => this.recordRun(record),
      async (parent, agentId, record, subject) => {
        await this.settleTargetResults(parent, agentId, subject);
        const tool = this.hookTools.get(parent);
        if (record.outcome === "normal" && tool) await this.ingestion?.result({ toolUseId: parent, tool: tool.tool, input: tool.input,
          text: "", isError: false, subject, at: record.confirmedAt });
      }, opts.log);
    if (opts.learningDirectory) this.ingestion = new LearningIngestion(opts.learningDirectory, opts.cwd, opts.log,
      () => this.recordingModel,
      parent => this.attribution.subject(parent), opts.resumeSessionId);
    this.normalizer = new ClaudeLiveNormalizer({
      cwd: this.opts.cwd,
      initialObservedTimestamp: this.opts.initialObservedTimestamp,
      log: this.opts.log,
      loadAgentDef: (subagentType: string) => this.loadAgentDef(subagentType),
      emit: (body, meta) => this.emit(body, meta),
      onRawToolUse: (id, tool, input, parent) => {
        this.hookTools.set(id, { tool, input, parent, model: parent ? this.attribution.observedModel(parent) : this.recordingModel });
        if (tool === "Agent" || tool === "Task") this.attribution.dispatch(id, input);
        if (tool === "mcp__laisora_external__run") this.externalToolUses.push({ id, input });
      },
      onRawToolResult: result => this.ingestResult(result),
      onTurnEnd: () => {
        if (this.interruptTimer) {
          clearTimeout(this.interruptTimer);
          this.interruptTimer = null;
        }
        for (const requestId of this.pendingApprovals.keys()) this.resolveApproval(requestId, "deny", undefined, "turn-end");
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

  private loadAgentDef(subagentType: string): AgentDefInfo | undefined {
    this.agentDefs ??= loadAgentDefs(this.opts.cwd, this.opts.log);
    return this.agentDefs.get(subagentType);
  }

  async start(): Promise<void> {
    const sdk = require("@anthropic-ai/claude-agent-sdk") as Pick<
      typeof ClaudeCodeSdk,
      "query" | "USAGE_LIMIT_ERROR_PREFIXES" | "createSdkMcpServer" | "tool"
    >;
    const startup = await resolveClaudeCodeStartup(this.opts.claudeCodeExecutablePath, __LAISORA_SDK_CLAUDE_CODE_VERSION__);
    const resolvedExecutable = startup.executable;
    this.opts.log(`Claude Code executable resolved from ${resolvedExecutable.source}: ${resolvedExecutable.path}` + (resolvedExecutable.shimPath ? ` (npm shim: ${resolvedExecutable.shimPath})` : ""));
    const version = startup.version;
    this.opts.log(`Claude Code CLI version: ${version.cliVersion ?? "unavailable"}; SDK expected: ${__LAISORA_SDK_CLAUDE_CODE_VERSION__ ?? "unknown"}`);
    if (version.warning) this.opts.log(`[warning] ${version.warning}`);
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
      const learningCall = LEARNING_TOOL_NAMES.includes(toolName) ? ctx.toolUseID : undefined;
      self.learningGate?.hold(learningCall);
      const pendingDecision = self.opts.onApprovalRequest({ requestId, toolName, toolUseId: ctx.toolUseID, rawInputJson });
      const onAbort = (): void => {
        self.learningGate?.revoke(learningCall);
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
        self.learningGate?.revoke(learningCall);
        self.emit({ kind: "approval_resolved", requestId, behavior: "withdrawn", resolvedBy: "withdrawn" });
        return null;
      }
      if (decision.behavior === "deny") self.learningGate?.revoke(learningCall);
      else self.learningGate?.release(learningCall);
      self.emit({ kind: "approval_resolved", requestId, behavior: decision.behavior, resolvedBy: decision.resolvedBy ?? "user", answers: decision.answers });
      if (decision.behavior === "deny") {
        return { behavior: "deny", message: l10n.t("Denied by the LAISORA user") };
      }
      return decision.answers
        ? { behavior: "allow", updatedInput: { ...input, answers: decision.answers } }
        : { behavior: "allow", updatedInput: input };
    };

    const options: ClaudeCodeOptions = {
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
      settingSources: this.opts.settingSources,
      settings: { remoteControlAtStartup: this.opts.remoteControlAtStartup === true, ...SDK_AUTO_CONTINUE_SETTINGS, ultracode: false },
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
    options.systemPrompt = conversationSystemPrompt(this.opts.fileLinkInstruction === true, this.opts.planInstruction !== false, this.opts.cwd);
    const learningT0 = Date.now();
    await this.ingestion?.start();
    const deliveryT0 = Date.now();
    const deliverySection = await this.prepareLearningDeliveryR31();
    if (this.ingestion) {
      this.opts.log(`learning 準備: ${Date.now() - learningT0}ms（restore ${deliveryT0 - learningT0}ms / delivery ${Date.now() - deliveryT0}ms）`);
    }
    this.rosterInjections.push(injectionOf(this.orchestrationEnabled ? orchestrationVariants(this.roster) : [], Date.now()));
    if (this.orchestrationEnabled) {
      options.agents = orchestrationAgents(this.roster);
      const base = this.opts.fileLinkInstruction === true ? FILE_LINK_INSTRUCTION(this.opts.cwd) : "";
      options.systemPrompt = { type: "custom", snapshot: false,
        prompt: [base, this.opts.planInstruction !== false ? PLAN_INSTRUCTION : "", conductorInstruction(this.roster, this.conductorPolicy, this.externalRows, deliverySection)].filter(Boolean).join("\n\n") };
    }
    if (this.orchestrationEnabled || this.ingestion) {
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
            if (toolUse) this.handledExternalCalls.add(toolUse.id);
            const runId = randomUUID(), dispatchId = randomUUID(), recipient = `external:${runId}`;
            const subject = { recipient, run: runId, dispatchId, executor: row.executor, model: row.model, effort: row.effort ?? "none", role: row.role };
            const run = await runExternal(row, input, { cwd: this.opts.cwd, timeoutMinutes: this.externalTimeoutMinutes, apiKeyPolicy: this.opts.apiKeyPolicy }, {
              signal: controller.signal,
              preparePrompt: (prompt, packaging, budget) => this.delivery?.target(subject, prompt, packaging, this.opts.learningPromptBudget?.(row.executor, row.model) ?? budget) ?? prompt,
              onAccepted: () => this.delivery?.accept(dispatchId),
            });
            if (!("accepted" in run) || !run.accepted) await this.delivery?.observed(dispatchId, "unknown", "unknown", [], true);
            const boundaryCode = "boundaryCode" in run ? run.boundaryCode : undefined;
            await this.ingestion?.result({ toolUseId: toolUse?.id ?? dispatchId, dispatchId,
              tool: "mcp__laisora_external__run", input, text: run.record.reason ?? "", isError: false,
              executorFailure: run.record.outcome !== "ok", ...(run.record.outcome !== "ok" ? { executorOutcome: run.record.outcome } : {}),
              ...(boundaryCode ? { boundaryCode } : { subject: { recipient, run: runId, dispatchId, executor: row.executor,
                model: run.record.observedModel, effort: run.record.observedEffort, role: row.role } }) });
            const record = await this.recordRun({ ...run.record, runId, dispatchId, recipient });
            if (record.reason !== run.record.reason) return { isError: true, content: [{ type: "text" as const, text: record.reason! }] };
            return run.result;
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
    if (this.opts.learningEnabled === true) {
      const prompt = options.systemPrompt as { type: "custom"; snapshot: false; prompt: string };
      options.systemPrompt = { ...prompt, prompt: [prompt.prompt, !this.orchestrationEnabled ? deliverySection : "", LEARNING_INSTRUCTION].filter(Boolean).join("\n\n") };
    }
    if (this.ingestion || this.opts.learningEnabled === true) {
      const gate = this.learningGate = new LearningRootGate();
      options.mcpServers = { ...(options.mcpServers ?? {}), laisora_learning: createLearningMcpServer(sdk, gate, (input, root, kind) => this.recordLearningR12(input, root, kind)) };
      const gated = { matcher: LEARNING_TOOL_NAMES.join("|"), hooks: [gate.hook] };
      options.hooks = { ...(options.hooks ?? {}),
        PreToolUse: [...(options.hooks?.PreToolUse ?? []), gated],
        PermissionDenied: [...(options.hooks?.PermissionDenied ?? []), gated],
        PostToolUseFailure: [...(options.hooks?.PostToolUseFailure ?? []), gated] };
    }
    {
      const guard: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const settings = this.effectiveLearningSwitches();
        await this.queueLearningR33(async () => {
          await this.measurement?.control(settings);
          const variants = orchestrationVariants(this.roster), value = input.tool_input as Record<string, unknown>;
          const agent = input.agent_id ? this.observedAgents.get(input.agent_id) : undefined;
          const variant = variants.find(entry => entry.agentKey === agent?.agentType);
          const model = input.agent_id ? agent?.model ?? variant?.model : this.recordingModel ?? this.opts.model;
          const resolved = resolveClaudeProfileModel(model, this.opts.externalModels, input.agent_id ? undefined : this.opts.configuredResolvedModel);
          const subject = { recipient: input.agent_id ?? "conductor", run: "unknown", dispatchId: input.tool_use_id, executor: "claude" as const,
            model: resolved ? claudeModelIdLabel(resolved) : "unknown", effort: agent?.effort ?? variant?.effort ?? "none", role: input.agent_id ? variant?.role ?? "unknown" : "conductor" };
          const targetVariant = ["Agent", "Task"].includes(input.tool_name) ? variants.find(entry => entry.agentKey === value.subagent_type) : undefined;
          const external = input.tool_name === "mcp__laisora_external__run" ? this.externalRows.find(entry => entry.target === value.target) : undefined;
          const targetModel = targetVariant ? resolveClaudeProfileModel(targetVariant.model, this.opts.externalModels) : undefined;
          const target = external ? { ...subject, executor: external.executor, model: external.model, effort: external.effort ?? "none", role: external.role }
            : targetVariant ? { ...subject, model: targetModel ? claudeModelIdLabel(targetModel) : "unknown", effort: targetVariant.effort ?? "none", role: targetVariant.role } : undefined;
          const state = this.ingestion?.ledger.state;
          const claims = state && target ? qualifyClaims([...state.records.values()], new Date().toISOString(), (executor, model) => executor === target.executor && model === target.model,
            new Set([target.role])) : [];
          const matches = learningCandidateMatches(state?.rules.values() ?? [], claims, input.tool_name, input.tool_input, subject, target);
          await this.measurement?.record({ toolCalls: 1, relevantOpportunities: matches.length ? 1 : 0, candidateOpportunities: matches.length },
            { tool: input.tool_name, role: input.agent_id ? "target" : "conductor", toolUse: this.ingestion?.ref("tool-use", input.tool_use_id) ?? "unknown",
              ...Object.fromEntries(matches.map((id, index) => [`candidate${index}`, id])) }, `tool:${input.tool_use_id}`);
          if (input.tool_name === "mcp__laisora_external__run") await this.measurement?.record({ externalDispatches: 1 }, { executor: "unknown", role: "target" }, `external-tokens:${input.tool_use_id}`);
        });
        if (!settings.guard) return {};
        const value = input.tool_input as Record<string, unknown>;
        const guardRoster = resolveOrchestrationRoster(this.opts.orchestrationAgents).roster;
        const names = ["claude", "Claude", "codex", "Codex", "agy", "Antigravity", ...orchestrationVariants(guardRoster).map(variant => variant.agentKey),
          ...guardRoster.flatMap(row => row.rows.map(entry => entry.model)), ...this.orchestrationRuns.flatMap(run => [run.requestedModel, run.kind === "external" ? run.observedModel : run.model].filter((name): name is string => !!name)),
          ...[...this.observedAgents.values()].flatMap(agent => [agent.agentType, agent.model].filter((name): name is string => !!name))];
        const models = Object.values(this.opts.externalModels ?? {}).flatMap(list => list.state === "ok" ? list.models : []);
        const listed = models.flatMap(model => [model.id, ...(model.resolvedModel ? [model.resolvedModel] : [])]);
        const vocabulary = compileVocabulary({ names: [...names, ...listed, ...models.map(model => model.label), ...listed.map(model => claudeModelIdLabel(model))], effortWords: PLACEMENT_EFFORT_WORDS,
          roleNames: [...DEFAULT_ROLE_NAMES, ...guardRoster.map(row => row.role)], listedModelIds: listed });
        const cwd = input.cwd || this.opts.cwd;
        let decision = judgeShellWrite(input.tool_name, value, claudeConfigDir(), process.platform, cwd);
        let unreadable = false;
        if (["Write", "Edit", "MultiEdit"].includes(input.tool_name) && typeof value.file_path === "string") {
          const path = placementPath(value.file_path, cwd, false);
          let current: string | undefined;
          if (path) {
            try { current = readFileSync(path, "utf8"); }
            catch (error) { unreadable = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
          }
          decision = judgeFileWrite(input.tool_name, { ...value, file_path: path ?? value.file_path }, current, vocabulary, claudeConfigDir());
        }
        const unchecked = unreadable && decision.skipped === "edit-does-not-apply";
        if ((!decision.blocked && !unchecked) || !decision.destination) return {};
        const destination = decision.destination;
        await this.queueLearningR33(() => this.measurement?.record({ guardBlocks: 1 }, { tool: input.tool_name, destination: destination === "CLAUDE.md" ? "claude-md" : destination === "AGENTS.md" ? "agents-md" : destination }) ?? Promise.resolve());
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: unchecked ? PLACEMENT_UNREADABLE_REFUSAL : placementGuardReason(destination, settings.enabled) } };
      };
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [{ hooks: [guard] }, ...(options.hooks?.PreToolUse ?? [])] };
    }
    if (this.ingestion) {
      const observeFailure: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name === "PreToolUse") {
          const previous = this.hookTools.get(input.tool_use_id);
          const parent = previous?.parent ?? (input.agent_id ? `agent:${input.agent_id}` : undefined);
          this.hookTools.set(input.tool_use_id, { tool: input.tool_name, input: input.tool_input, parent,
            model: previous?.model ?? (input.agent_id ? this.observedAgents.get(input.agent_id)?.model : undefined)
              ?? (parent ? this.attribution.observedModel(parent) : undefined) });
          if (input.tool_name === "Agent" || input.tool_name === "Task") this.attribution.dispatch(input.tool_use_id, input.tool_input as Record<string, unknown>);
          if (input.tool_name === "mcp__laisora_external__run" && !this.externalToolUses.some(entry => entry.id === input.tool_use_id)) this.externalToolUses.push({ id: input.tool_use_id, input: input.tool_input as Record<string, unknown> });
        } else if (input.hook_event_name === "PostToolUseFailure") {
          const previous = this.hookTools.get(input.tool_use_id);
          this.ingestResult({ toolUseId: input.tool_use_id, tool: input.tool_name, input: input.tool_input,
            parentToolUseId: previous?.parent ?? (input.agent_id ? `agent:${input.agent_id}` : undefined), observedModel: previous?.model
              ?? (input.agent_id ? this.observedAgents.get(input.agent_id)?.model : undefined),
            text: input.is_interrupt ? "[Request interrupted by user]" : input.error, isError: true });
        }
        return {};
      };
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [...(options.hooks?.PreToolUse ?? []), { hooks: [observeFailure] }],
        PostToolUseFailure: [...(options.hooks?.PostToolUseFailure ?? []), { hooks: [observeFailure] }] };
      for (const matcher of options.hooks.PreToolUse ?? []) matcher.hooks = matcher.hooks.map(hook => async (input, id, context) => {
        const output = await hook(input, id, context);
        if (input.hook_event_name === "PreToolUse" && "hookSpecificOutput" in output
          && output.hookSpecificOutput?.hookEventName === "PreToolUse" && output.hookSpecificOutput.permissionDecision === "deny") {
          const previous = this.hookTools.get(input.tool_use_id);
          this.ingestResult({ toolUseId: input.tool_use_id, tool: input.tool_name, input: input.tool_input,
            parentToolUseId: previous?.parent ?? (input.agent_id ? `agent:${input.agent_id}` : undefined), text: "", isError: false, hookDenied: true });
        }
        return output;
      });
    }
    if (this.delivery) {
      const inject: ClaudeCodeSdk.HookCallback = async input => {
        if (input.hook_event_name !== "PreToolUse" || !["Agent", "Task"].includes(input.tool_name)) return {};
        const value = input.tool_input as Record<string, unknown>;
        if (typeof value.prompt !== "string") return {};
        this.attribution.dispatch(input.tool_use_id, value);
        const identity = this.attribution.dispatchSubject(input.tool_use_id);
        const variant = orchestrationVariants(this.roster).find(entry => entry.agentKey === value.subagent_type);
        if (!identity || !variant) return {};
        const model = resolveClaudeProfileModel(variant.model, this.opts.externalModels);
        if (!model) return {};
        const subject = { ...identity, executor: "claude" as const, model: claudeModelIdLabel(model), effort: variant.effort ?? "none", role: variant.role };
        const packaging = JSON.stringify({ ...value, prompt: "", system: options.systemPrompt, agent: options.agents?.[variant.agentKey] });
        try {
          const prompt = this.delivery!.target(subject, value.prompt, packaging, this.opts.learningPromptBudget?.("claude", subject.model));
          return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...value, prompt } } };
        } catch (error) {
          const reason = error instanceof Error && error.message === DISPATCH_BUDGET_EXCEEDED ? DISPATCH_BUDGET_EXCEEDED : runFailureReason(DISPATCH_INTERNAL_ERROR, error);
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
        }
      };
      const previous = options.hooks?.PreToolUse ?? [];
      options.hooks = { ...(options.hooks ?? {}), PreToolUse: [{ hooks: [async (input, id, context) => {
        let result: Awaited<ReturnType<ClaudeCodeSdk.HookCallback>> = {};
        for (const matcher of previous) {
          if (matcher.matcher && !new RegExp(matcher.matcher).test((input as { tool_name?: string }).tool_name ?? "")) continue;
          for (const hook of matcher.hooks) {
            const output = await hook(input, id, context);
            if ("hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse") {
              result = output;
              if (output.hookSpecificOutput.permissionDecision === "deny") return output;
              if (output.hookSpecificOutput.updatedInput) input = { ...input, tool_input: output.hookSpecificOutput.updatedInput } as typeof input;
            }
          }
        }
        const injected = await inject(input, id, context);
        return Object.keys(injected).length ? injected : result;
      }] }] };
    }
    if (this.opts.model) options.model = this.opts.model;
    if (this.opts.effort) options.effort = this.opts.effort;
    if (this.opts.resumeSessionId) options.resume = this.opts.resumeSessionId;
    if (this.opts.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    this.inputGen = this.inputGenerator();
    this.q = sdk.query({
      prompt: this.inputGen as unknown as AsyncIterable<Parameters<typeof sdk.query>[0]["prompt"] extends AsyncIterable<infer Message> ? Message : never>,
      options,
    }) as QueryHandle;

    if (this.deliverySnapshot?.text && this.delivery) {
      const model = resolveClaudeProfileModel(this.opts.model, this.opts.externalModels, this.opts.configuredResolvedModel);
      await this.queueLearningR33(() => this.delivery!.conductor(this.deliverySnapshot!, (options.systemPrompt as { prompt: string }).prompt, model ? claudeModelIdLabel(model) : "unknown"));
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
    this.invalidateHandoffContextUsage();
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: envelopeText }] },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.inputWaiter?.();
    this.inputWaiter = null;
    return { ok: true };
  }

  sendReportEnvelope(envelopeText: string): SteeringSendResult {
    const admission = admitReportSend(
      { closed: this.closed, turnState: this.normalizer.turnState },
      envelopeText,
      checkEnvelopeRedaction
    );
    if (!admission.ok) return admission;
    this.invalidateHandoffContextUsage();
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: envelopeText }] },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.inputWaiter?.();
    this.inputWaiter = null;
    return { ok: true };
  }

  cancelAutoResume(): void { this.usageLimitResume.cancel(); }

  get pendingAutoResumeAt(): number | null { return this.usageLimitResume.pendingResumeAt; }

  get pendingApprovalToolUseIds(): readonly string[] {
    return [...this.pendingApprovals.values()].flatMap(p => p.toolUseId === undefined ? [] : [p.toolUseId]);
  }

  send(text: string, images?: ImageAttachment[], observedTimestampSeed?: number, automatic = false): void {
    if (!automatic) this.usageLimitResume.manualSend();
    if (this.closed) {
      this.emit({
        kind: "error",
        message: l10n.t("The conversation has ended. Resend your message (a new connection will be started)"),
        fatal: false,
      });
      return;
    }
    if (this.normalizer.turnState === "interrupting") {
      this.emit({
        kind: "error",
        message: l10n.t("Interrupt in progress. Stop first, then send again."),
        fatal: false,
      });
      return;
    }
    const runningAlready = this.normalizer.turnState !== "idle";
    if (!runningAlready) {
      this.normalizer.seedObservedTimestamp(observedTimestampSeed);
      this.normalizer.startTurn(undefined, undefined, automatic);
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
    this.invalidateHandoffContextUsage();
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content },
      ...(automatic ? { isMeta: true } : {}),
      parent_tool_use_id: null,
      session_id: "",
    });
    this.inputWaiter?.();
    this.inputWaiter = null;
  }

  async interrupt(): Promise<void> {
    this.cancelAutoResume();
    if (!this.q || this.normalizer.turnState !== "running") return;
    this.attribution.interrupt();
    this.normalizer.turnState = "interrupting";
    const turnId = this.normalizer.currentTurnId;
    const drained = this.inputQueue.length;
    this.inputQueue = [];
    if (drained > 0) {
      this.emit({
        kind: "error",
        message: l10n.t("Discarded {0} unprocessed messages due to the interrupt", drained),
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
      for (const parent of this.pendingTargetResults.keys()) await this.settleTargetResults(parent);
      await this.ingestion?.flush();
      await this.queueLearningR33(async () => {});
      await this.delivery?.end();
      await this.ingestion?.end();
    }
  }

  private handleMessage(msg: any): void {
    if (msg?.type === "result") {
      const session = msg.session_id ?? this.learningSessionRef ?? this.opts.resumeSessionId ?? this.conversationId;
      const identity = msg.uuid ?? this.normalizer.currentTurnId ?? randomUUID();
      const completesTurn = this.normalizer.currentTurnId !== null;
      void this.queueLearningR33(() => this.measurement?.cumulativeUsage(msg, session, session === this.opts.resumeSessionId, !!this.opts.learningDedicated, identity, completesTurn) ?? Promise.resolve());
    }
    if (msg?.type === "system" && msg?.subtype === "task_started" && msg.task_type === "local_agent"
      && typeof msg.tool_use_id === "string" && typeof msg.task_id === "string"
      && this.attribution.started(msg.tool_use_id, msg.task_id, msg.is_backgrounded)) this.targetFailures.delete(msg.tool_use_id);
    if (msg?.type === "system" && msg?.subtype === "task_updated" && typeof msg.task_id === "string") void this.attribution.updated(msg.task_id, msg.patch?.is_backgrounded);
    if (msg?.type === "system" && msg?.subtype === "task_notification") {
      const parent = typeof msg.tool_use_id === "string" ? msg.tool_use_id
        : typeof msg.task_id === "string" ? this.attribution.parentOfTask(msg.task_id) : undefined;
      if (parent) void this.attribution.notification(parent, msg.status, msg.task_id, msg.uuid, () => {
        const tool = this.hookTools.get(parent);
        if (msg.status === "failed" && tool && ["Agent", "Task"].includes(tool.tool)) this.ingestResult({
          toolUseId: parent, tool: tool.tool, input: tool.input, text: typeof msg.summary === "string" ? msg.summary : "",
          isError: false, executorFailure: true, executorOutcome: "failed" });
      });
    }
    if (msg?.type === "assistant" && typeof msg.parent_tool_use_id === "string" && typeof msg.message?.model === "string") {
      this.attribution.model(msg.parent_tool_use_id, msg.message.model);
      const dispatch = this.attribution.dispatchRef(msg.parent_tool_use_id);
      if (dispatch) void this.queueLearningR33(() => this.delivery?.observed(dispatch, claudeModelIdLabel(msg.message.model), "unknown", ["claude:assistant:model"]) ?? Promise.resolve());
    }
    if (msg?.type !== "tool_progress") this.lastRecordReceivedAt = Date.now();
    if (msg?.type === "system" && msg?.subtype === "init" && Array.isArray(msg.capabilities)) {
      this.cliCapabilities = msg.capabilities.filter((c: unknown): c is string => typeof c === "string");
    }
    this.handlingResult = msg?.type === "result";
    try { this.normalizer.handleMessage(msg); }
    finally { this.handlingResult = false; }
  }

  private emit(
    ev: NormalizedEventBody & { provenance?: EventProvenance },
    meta?: NormalizedOutMeta
  ): void {
    if (ev.kind === "turn_started" || ev.kind === "compact_boundary" || ev.kind === "tool_call_finished") {
      this.invalidateHandoffContextUsage();
    }
    if (ev.kind === "turn_started") void this.queueLearningR33(() => this.measurement?.record({ turnStarts: 1 }, {}, `turn-start:${ev.turnId}`) ?? Promise.resolve());
    if (ev.kind === "turn_completed" || ev.kind === "turn_failed" || ev.kind === "turn_interrupted") {
      const missingUsage = !this.handlingResult;
      void this.queueLearningR33(async () => {
        await this.measurement?.control(this.effectiveLearningSwitches());
        await this.measurement?.record({ turns: 1, ...(missingUsage ? { promptTokens: null, ...(this.opts.learningDedicated ? { researchTokens: null, researchCost: null } : {}) } : {}) },
          { model: this.recordingModel ? claudeModelIdLabel(this.recordingModel) : "unknown", role: "conductor", executor: "claude" }, `turn:${ev.turnId}`);
      });
    }
    if (ev.kind === "model_observed") { this.recordingModel = ev.model; void this.observeLearningModelR30(ev.model); }
    if (ev.kind === "auth_status" && ev.auth?.sessionId) {
      this.learningSessionRef = ev.auth.sessionId;
      if (ev.auth.model) this.recordingModel = ev.auth.model;
      const session = ev.auth.sessionId;
      void this.queueLearningR33(async () => {
        await this.ingestion?.bind(session);
        if (this.recordingModel) await this.delivery?.observed(this.ingestion!.conductorSubject.dispatchId,
          claudeModelIdLabel(this.recordingModel), "unknown", ["conductor:model_observed"]);
      });
    }
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
    this.learningGate?.clear();
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
    await this.learningObservation;
    await this.attribution.close();
    for (const parent of this.pendingTargetResults.keys()) await this.settleTargetResults(parent);
    await this.ingestion?.flush();
    await this.queueLearningR33(async () => {});
    await this.delivery?.end();
    await this.ingestion?.end();
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
      if (typeof model === "string" && model.trim()) await this.observeLearningModelR30(model.trim());
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
