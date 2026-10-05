import type { AgentInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools" with { "resolution-mode": "import" };
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EpisodeTracker, episodeOpId, ruleIdOf, type EpisodeRecord, type RuleKey } from "./learning-episodes";
import { callKey, toolHead, failureSig, SIG_VERSION } from "./learning-signature";
import { gitCommonDirState, projectIdOf, projectLiteralJudgment } from "./learning-project";
import { realPathOrNearestSync } from "./path-containment";
import { installKeyOf, LearningConversationKey, LearningLedger, opaqueLearningRef } from "./learning-ledger";
import { claudeModelIdLabel } from "./orchestration-executors";
import { LearningDetector } from "./learning-detector";

export interface LearningToolResult {
  toolUseId: string;
  parentToolUseId?: string;
  dispatchId?: string;
  tool: string;
  input: unknown;
  text: string;
  isError: boolean;
  at?: string;
  hookDenied?: boolean;
  boundaryCode?: "delegation_invalid" | "target_unavailable";
  fields?: readonly string[];
  executorFailure?: boolean;
  executorOutcome?: "failed" | "timeout" | "refused" | "stopped";
  subject?: LearningSubject;
  observedModel?: string;
}

export interface LearningSubject { recipient: string; run: string; dispatchId: string; executor?: "claude" | "codex" | "agy"; model?: string; effort?: string; role?: string }

export const DELEGATION_SCHEMA_VERSION = 2;
export const DELEGATION_SDK_VERSION = "0.3.289";
const agentString = (value: unknown) => typeof value === "string";
const agentSchema = {
  description: agentString, prompt: agentString, subagent_type: agentString, name: agentString, team_name: agentString,
  run_in_background: (value: unknown) => typeof value === "boolean",
  model: (value: unknown) => ["sonnet", "opus", "haiku", "fable"].includes(value as string),
  mode: (value: unknown) => ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"].includes(value as string),
  isolation: (value: unknown) => ["worktree", "remote"].includes(value as string),
} satisfies Record<keyof Required<AgentInput>, (value: unknown) => boolean>;
const agentRequired = ["description", "prompt"] as const satisfies readonly { [K in keyof AgentInput]-?: undefined extends AgentInput[K] ? never : K }[keyof AgentInput][];
export function delegationInvalidFields(tool: string, input: unknown): string[] {
  if (!["Agent", "Task", "mcp__laisora_external__run"].includes(tool)) return [];
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (tool !== "mcp__laisora_external__run") return Object.entries(agentSchema)
    .filter(([field, valid]) => ((agentRequired as readonly string[]).includes(field) || value[field] !== undefined) && !valid(value[field]))
    .map(([field]) => field);
  const fields = ["target", "prompt"].filter(field => typeof value[field] !== "string");
  for (const field of ["description", "diff", "cwd"]) if (value[field] !== undefined && typeof value[field] !== "string") fields.push(field);
  if (value.files !== undefined && (!Array.isArray(value.files) || !value.files.every(file => typeof file === "string"))) fields.push("files");
  return fields;
}

export class LearningIngestion {
  readonly detector = new LearningDetector();
  readonly ledger: LearningLedger;
  private key?: Buffer;
  private identity?: LearningConversationKey;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tracker = new EpisodeTracker();
  private readonly seen = new Set<string>();
  private stateReady = false;
  private pendingEpisode?: EpisodeRecord;
  private session = "unknown";
  private project = "unknown";
  private readonly run = randomUUID();
  private readonly dispatchId = randomUUID();
  constructor(directory: string, private readonly cwd: string, private readonly log: (message: string) => void,
    private readonly model: () => string | undefined, private readonly target: (parent: string) => LearningSubject | undefined,
    private readonly resume?: string) { this.ledger = new LearningLedger(directory, log); }
  get conversation(): string | undefined { return this.identity?.conversation; }
  get ready(): boolean { return this.stateReady; }
  get projectRef(): string { return this.project; }
  get sessionRef(): string { return this.session; }
  get conductorSubject(): LearningSubject { return { recipient: "conductor", run: this.run, dispatchId: this.dispatchId }; }
  ref(domain: string, value: string): string { return this.key ? opaqueLearningRef(this.key, domain, value) : /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : "unknown"; }
  private seenKey(conversation: string, recipient: string, run: string, toolUse: string): string {
    return `${conversation}:${recipient}:${recipient === this.ref("recipient", "conductor") ? "" : run}:${toolUse}`;
  }
  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(action).catch(error => {
      this.stateReady = false;
      this.log(error instanceof Error && error.message === "invalid learning install-key length"
        ? "R-LRN-07: [learning-v2] invalid install-key length; recording stopped; key preserved"
        : `R-LRN-07: [learning-v2] recording unavailable${typeof (error as NodeJS.ErrnoException)?.code === "string" ? ` (${(error as NodeJS.ErrnoException).code})` : ""}`);
    });
    this.queue = next;
    return next;
  }
  async start(): Promise<void> {
    return this.serial(async () => {
      const key = await installKeyOf(this.ledger.directory);
      this.key = key;
      this.identity = new LearningConversationKey(this.ledger.directory, this.key, this.resume);
      if (!await this.identity.restore()) this.log("[learning-v2] state-unavailable: conversation mapping");
      else if (this.identity.startedWithoutPriorState) this.log("[learning-v2] conversation started without prior v2 state");
      if (this.resume) this.session = this.ref("session", this.resume);
      const state = await gitCommonDirState(this.cwd);
      this.project = projectIdOf(this.key, state, realPathOrNearestSync(this.cwd) ?? undefined,
        state.kind === "git" ? realPathOrNearestSync(state.commonDir) ?? undefined : undefined);
      await this.restoreState();
    });
  }
  bind(session: string): Promise<void> {
    return this.serial(async () => {
      this.session = this.ref("session", session);
      if (this.identity && !await this.identity.bind(session)) {
        this.stateReady = false;
        this.log("[learning-v2] state-unavailable: conversation mapping");
      }
      if (!this.stateReady) await this.restoreState();
    });
  }
  result(input: LearningToolResult): Promise<void> {
    const result = structuredClone(input);
    const conductorModel = result.observedModel ?? this.model();
    const delegation = ["Agent", "Task", "mcp__laisora_external__run"].includes(result.tool);
    const parent = result.boundaryCode ? undefined : result.parentToolUseId ?? (delegation && !result.subject ? result.toolUseId : undefined);
    const capturedSubject = result.boundaryCode ? undefined : result.subject ?? (parent ? structuredClone(this.target(parent)) : undefined);
    const targetModel = result.observedModel ?? capturedSubject?.model ?? "unknown";
    return this.serial(async () => {
      if (!this.key) return;
      await this.persistPending();
      if (!this.stateReady) await this.restoreState();
      const subject = result.boundaryCode ? undefined : capturedSubject ?? (parent ? this.target(parent) : undefined);
      const recipient = this.ref("recipient", subject?.recipient ?? (parent ? `agent:${parent}` : "conductor"));
      const run = this.ref("run", subject?.run ?? (parent ?? this.run));
      const dispatchId = this.ref("dispatch", result.dispatchId ?? subject?.dispatchId ?? (parent ?? this.dispatchId));
      const conversation = this.conversation ?? "unknown";
      const toolUse = this.ref("tool-use", result.toolUseId);
      const resultId = this.ref("tool-result", `${conversation}:${toolUse}`);
      const observedResult = async () => {
        if (!this.ledger.state.records.has(resultId)) await this.ledger.append({ kind: "measurement", v: 2,
          at: result.at ?? new Date().toISOString(), opId: resultId, conversation, run, counts: { toolResults: 1 }, tags: { toolUse } });
      };
      const seenKey = this.seenKey(conversation, recipient, run, toolUse);
      if (this.seen.has(seenKey)) { await observedResult(); return; }
      if (result.executorOutcome === "stopped") {
        this.seen.add(seenKey);
        await observedResult();
        return;
      }
      const argumentsObject = result.input && typeof result.input === "object" ? result.input as Record<string, unknown> : {};
      const targetArgument = argumentsObject[result.tool === "mcp__laisora_external__run" ? "target" : "subagent_type"];
      const operationValue = delegation ? `${result.tool}:${this.ref("boundary-target", typeof targetArgument === "string" ? targetArgument : "unknown")}`
        : callKey(result.tool, result.input, result.text);
      const operation = this.ref("operation", operationValue);
      const state = async (action: "failure" | "success", sig?: string, stateRecipient = recipient, episode?: EpisodeRecord) => this.ledger.append({ kind: "episode-state", v: 2,
        at: result.at ?? new Date().toISOString(), opId: this.ref("episode-state", `${stateRecipient}:${run}:${toolUse}`),
        conversation, recipient: stateRecipient, run, toolUse, operation, action, tool: result.tool, head: toolHead(result.tool, result.input, result.text), ...(sig ? { sig } : {}),
        ...(episode ? { episode, at: episode.at } : {}), ...(!this.stateReady ? { status: "state-unavailable" as const } : {}) });
      if (!result.isError && !result.boundaryCode && !result.executorFailure && !result.hookDenied) {
        await state("success");
        if (this.stateReady) this.tracker.success(recipient, operation);
        if (delegation && result.subject) {
          const conductor = this.ref("recipient", "conductor");
          await state("success", undefined, conductor);
          if (this.stateReady) this.tracker.success(conductor, operation);
        }
        this.seen.add(seenKey);
        await observedResult();
        return;
      }
      const fields = result.fields ?? [];
      const metadata = (value: string | undefined) => value && /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : "unknown";
      const boundaryCode = result.boundaryCode;
      const classified = this.detector.classify(result.tool, result.text, result.input);
      const external = result.executorFailure && !["transient", "human"].includes(classified.group)
        ? { cls: result.executorOutcome === "timeout" ? "tool_timeout" : "external_failure", group: "counted" as const, head: "", messageHead: result.executorOutcome ?? "failed" }
        : classified;
      const signature = result.hookDenied ? { cls: "hook_block", group: "hook" as const, head: "", messageHead: "" }
        : boundaryCode ? { cls: boundaryCode, group: "counted" as const, head: "", messageHead: `${boundaryCode}:${[...(result.fields ?? fields)].sort().join(",")}` }
        : external;
      const sig = failureSig(this.key, result.tool, signature);
      await this.ledger.append({ kind: "measurement", v: 2, at: result.at ?? new Date().toISOString(), opId: this.ref("classification", `${recipient}:${run}:${toolUse}`),
        conversation, run, counts: { failureResults: 1, classified: signature.group === "unclassified" ? 0 : 1, excluded: signature.group === "counted" ? 0 : 1 },
        tags: { detector: String(this.detector.version), tool: result.tool, cls: signature.cls, exclusion: signature.group, signature: sig,
          model: metadata(parent || result.subject ? targetModel : conductorModel), role: metadata(subject?.role ?? "conductor"), executor: subject?.executor ?? "claude", project: this.project } });
      if (this.stateReady && this.tracker.has(recipient, sig)) {
        const previous = [...this.ledger.state.records.values()].filter(record => record.kind === "episode").find(record => record.recipient === recipient && record.sig === sig);
        if (signature.group === "counted" && previous && previous.status !== "counted") await this.ledger.append({ kind: "measurement", v: 2, at: result.at ?? new Date().toISOString(),
          opId: this.ref("exclusion", `${recipient}:${run}:${toolUse}`), conversation, run, counts: { excluded: 1 },
          tags: { detector: String(this.detector.version), tool: result.tool, cls: signature.cls, exclusion: previous.status, model: previous.key.model,
            role: metadata(subject?.role ?? "conductor"), executor: subject?.executor ?? "claude", project: this.project } });
        await state("failure", sig);
        this.seen.add(seenKey);
        await observedResult();
        return;
      }
      const target = !boundaryCode && (result.subject !== undefined || parent !== undefined);
      const observed = target ? targetModel : conductorModel;
      const observedModel = observed ? (subject?.executor && subject.executor !== "claude" ? observed : claudeModelIdLabel(observed)) : "unknown";
      const model = metadata(observedModel), effort = metadata(subject?.effort), role = metadata(subject?.role);
      const key: RuleKey = target ? { sig, bind: "target", executor: subject?.executor ?? "claude", model,
        effort, role } : { sig, bind: "conductor", model };
      let status: EpisodeRecord["status"] = signature.group === "counted" ? "counted" : signature.group;
      if (status === "counted") {
        const judgment = projectLiteralJudgment({ tool: result.tool, input: result.input, text: result.text, cls: signature.cls }, this.cwd, homedir());
        status = judgment === "unknown" || this.project === "unknown" ? "unknown-project" : judgment === "project" ? "project" : "counted";
        if (!this.conversation || model === "unknown" || target && (effort === "unknown" || role === "unknown")) status = "unknown-model";
      }
      if (!this.stateReady) status = "state-unavailable";
      if (signature.group === "counted" && status !== "counted") await this.ledger.append({ kind: "measurement", v: 2, at: result.at ?? new Date().toISOString(),
        opId: this.ref("exclusion", `${recipient}:${run}:${toolUse}`), conversation, run, counts: { excluded: 1 },
        tags: { detector: String(this.detector.version), tool: result.tool, cls: signature.cls, exclusion: status, model, role, executor: subject?.executor ?? "claude", project: this.project } });
      const episode: EpisodeRecord = { kind: "episode", v: 2, at: result.at ?? new Date().toISOString(),
        opId: episodeOpId(conversation, toolUse, recipient, run), sig, sigV: SIG_VERSION, tool: result.tool, cls: signature.cls,
        head: signature.head, ...(signature.label !== undefined ? { label: signature.label } : {}),
        ...(boundaryCode ? { labelFacts: { code: boundaryCode, fields: result.fields ?? fields, ...(boundaryCode === "delegation_invalid" ? { schemaV: DELEGATION_SCHEMA_VERSION } : {}) } } : {}),
        key, ruleId: ruleIdOf(key), conversation, recipient, run, dispatchId, session: this.session, toolUse, project: this.project, status };
      await state("failure", sig, recipient, episode);
      this.pendingEpisode = episode;
      if (this.stateReady) this.tracker.failure(recipient, sig, operation);
      this.seen.add(seenKey);
      await this.persistPending();
      await observedResult();
    });
  }
  private async restoreState(): Promise<void> {
    if (this.resume) await this.identity?.restore();
    await this.ledger.refresh();
    const records = [...this.ledger.state.records.values()].filter(record => record.conversation === (this.conversation ?? "unknown"));
    const states = records.filter(record => record.kind === "episode-state");
    for (const state of states) if (state.episode && !(this.ledger.consistent && isDeepStrictEqual(this.ledger.state.records.get(state.episode.opId), state.episode))) {
      await this.ledger.append(state.episode);
    }
    const ready = !!this.conversation && !this.ledger.skipped && !this.ledger.incompleteTail
      && !this.ledger.state.conflicts.size && records.every(record => record.kind !== "episode" || record.status === "state-unavailable"
        || states.some(state => state.status !== "state-unavailable" && state.toolUse === record.toolUse
          && state.recipient === record.recipient && state.run === record.run && state.sig === record.sig));
    for (const state of states) this.seen.add(this.seenKey(state.conversation, state.recipient, state.run, state.toolUse));
    if (ready && !this.stateReady) {
      this.tracker.end();
      for (const state of states) {
        if (state.status === "state-unavailable") continue;
        if (state.action === "failure") this.tracker.failure(state.recipient, state.sig!, state.operation);
        else this.tracker.success(state.recipient, state.operation);
      }
    }
    if (!ready) this.log("[learning-v2] state-unavailable: unresolved episodes; counting withheld");
    this.stateReady = ready;
  }
  private async persistPending(): Promise<void> {
    if (!this.pendingEpisode) return;
    await this.ledger.append(this.pendingEpisode);
    this.pendingEpisode = undefined;
  }
  end(): Promise<void> { return this.serial(async () => { await this.persistPending(); this.tracker.end(); }); }
  flush(): Promise<void> { return this.serial(() => this.persistPending()); }
}
