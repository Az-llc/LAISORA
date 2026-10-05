import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { attributeSubagent, type RosterEvidence } from "./roster-evidence";
import { claudeModelIdLabel } from "./orchestration-executors";
import { HUMAN_REJECTED_TOOL_RESULT_RE } from "./guardrail";
import type { AgentRunRecord } from "./orchestration-external";
import type { LearningSubject } from "./learning-ingestion";

interface Dispatch { run: string; dispatchId: string; parent: string; key?: string; model?: string; outcome?: "normal" | "stopped"; evidence?: string; background?: boolean; runtime: boolean; segment: number; terminalSegment?: number; taskId?: string }
interface Pending { record: AgentRunRecord; parent?: string; stopped: boolean }

export class AgentAttribution {
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly pending = new Map<string, Pending>();
  private readonly segments = new Map<string, number>();
  private readonly tasks = new Map<string, string>();
  private readonly consumed = new Set<string>();
  private readonly finished = new Map<string, LearningSubject>();
  private readonly unrecorded: { record: AgentRunRecord; parent?: string; subject?: LearningSubject }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly roster: () => RosterEvidence, private readonly append: (record: AgentRunRecord) => Promise<unknown>,
    private readonly settled: (parent: string, agentId: string, record: AgentRunRecord, subject: LearningSubject) => Promise<void>, private readonly log: (message: string) => void) {}
  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(action).catch(() => this.log("[learning-v2] agent attribution unavailable"));
    this.queue = next;
    return next;
  }
  dispatch(parent: string, input: Record<string, unknown>): void {
    if (this.dispatches.has(parent)) return;
    this.dispatches.set(parent, { parent, run: randomUUID(), dispatchId: randomUUID(),
      key: typeof input.subagent_type === "string" ? input.subagent_type : undefined, runtime: false, segment: 1 });
  }
  model(parent: string, value: string): void {
    const dispatch = this.dispatches.get(parent);
    if (dispatch && value !== "<synthetic>") { dispatch.model = claudeModelIdLabel(value); dispatch.runtime = true; }
  }
  hasRuntime(parent: string): boolean { return this.dispatches.get(parent)?.runtime === true; }
  observedModel(parent: string): string | undefined { return this.dispatches.get(parent)?.model; }
  parentOfTask(taskId: string): string | undefined { return this.tasks.get(taskId); }
  started(parent: string, taskId: string, background: unknown): boolean {
    const dispatch = this.dispatches.get(parent);
    if (!dispatch || !taskId || typeof background !== "boolean") return false;
    const fresh = dispatch.taskId !== taskId || this.finished.has(parent);
    if (fresh) {
      dispatch.taskId = taskId;
      dispatch.outcome = undefined;
      dispatch.evidence = undefined;
      dispatch.terminalSegment = undefined;
      this.finished.delete(parent);
    }
    dispatch.runtime = true;
    dispatch.background = background;
    this.tasks.set(taskId, parent);
    return fresh;
  }
  updated(taskId: string, background: unknown): void {
    const parent = this.tasks.get(taskId);
    const dispatch = parent ? this.dispatches.get(parent) : undefined;
    if (dispatch && dispatch.taskId === taskId && typeof background === "boolean") dispatch.background = background;
  }
  subject(parent: string): LearningSubject | undefined { return this.finished.get(parent); }
  dispatchRef(parent: string): string | undefined { return this.dispatches.get(parent)?.dispatchId; }
  dispatchSubject(parent: string): LearningSubject | undefined {
    const dispatch = this.dispatches.get(parent);
    return dispatch ? { recipient: `agent:${parent}`, run: dispatch.run, dispatchId: dispatch.dispatchId } : undefined;
  }
  result(parent: string, text: string, isError: boolean): Promise<void> {
    return this.serial(async () => {
      const dispatch = this.dispatches.get(parent);
      if (!dispatch || dispatch.background !== false || !dispatch.runtime || this.consumed.has(`result:${parent}`)) return;
      dispatch.outcome = isError || HUMAN_REJECTED_TOOL_RESULT_RE.test(text) ? "stopped" : "normal";
      dispatch.evidence = "parent-tool-result";
      dispatch.terminalSegment = dispatch.segment;
      this.consumed.add(`result:${parent}`);
      await this.confirm(parent);
    });
  }
  notification(parent: string, status: unknown, taskId: string, evidenceId: unknown, accepted?: () => void): Promise<void> {
    return this.serial(async () => {
      const dispatch = this.dispatches.get(parent);
      if (!dispatch || typeof taskId !== "string" || !taskId || typeof status !== "string" || !["completed", "failed", "stopped"].includes(status)
        || typeof evidenceId !== "string" || !evidenceId || dispatch.taskId !== undefined && dispatch.taskId !== taskId
        || this.consumed.has(`notification:${taskId}:${evidenceId}`)
        || this.finished.has(parent) && ![...this.pending.values()].some(pending => pending.parent === parent)) return;
      dispatch.runtime = true;
      dispatch.background = true;
      dispatch.taskId = taskId;
      dispatch.terminalSegment = dispatch.segment;
      this.consumed.add(`notification:${taskId}:${evidenceId}`);
      dispatch.outcome = status === "completed" ? "normal" : "stopped";
      dispatch.evidence = `task-notification:${status}`;
      accepted?.();
      await this.confirm(parent);
    });
  }
  stop(record: AgentRunRecord, input: Record<string, unknown>): Promise<void> {
    return this.serial(async () => {
      let parent: string | undefined;
      let stopped = false;
      let model: string | undefined;
      const transcript = typeof input.agent_transcript_path === "string" ? input.agent_transcript_path : undefined;
      if (transcript) {
        try {
          const meta = JSON.parse(await readFile(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
          if (typeof meta.toolUseId === "string") parent = meta.toolUseId;
          stopped = meta.stoppedByUser === true;
        } catch { this.log("[learning-v2] agent metadata unavailable"); }
        try {
          for (const line of (await readFile(transcript, "utf8")).split("\n")) {
            try {
              const value = JSON.parse(line);
              if (value.type === "assistant" && typeof value.message?.model === "string" && value.message.model !== "<synthetic>") model = claudeModelIdLabel(value.message.model);
            } catch {}
          }
        } catch { this.log("[learning-v2] agent transcript unavailable"); }
      }
      const dispatch = parent ? this.dispatches.get(parent) : undefined;
      if (dispatch) dispatch.runtime = true;
      const agentKey = typeof input.agent_type === "string" ? input.agent_type : dispatch?.key;
      const attributed = attributeSubagent(this.roster(), { agentType: agentKey, transcriptAgentId: record.agent_id, startedAt: Date.parse(record.firstSeenAt) });
      const effort = (input.effort as { level?: unknown } | undefined)?.level;
      const segment = (this.segments.get(record.agent_id) ?? 0) + 1;
      this.segments.set(record.agent_id, segment);
      const enriched: AgentRunRecord = { ...record, agentKey, role: attributed?.definition.role ?? "unknown",
        requestedModel: attributed?.definition.model ?? "unknown", requestedEffort: attributed?.definition.effort ?? "unknown",
        model: model ?? dispatch?.model ?? (typeof input.model === "string" ? claudeModelIdLabel(input.model) : record.model ?? "unknown"),
        effort: typeof effort === "string" ? effort : record.effort ?? "unknown", segment,
        runId: segment === 1 ? dispatch?.run ?? randomUUID() : randomUUID(), dispatchId: dispatch?.dispatchId ?? randomUUID(), recipient: parent ? `agent:${parent}` : `agent:${record.agent_id}` };
      this.pending.set(`${record.agent_id}:${segment}`, { record: enriched, parent, stopped });
      if (parent) await this.confirm(parent);
    });
  }
  private async confirm(parent?: string, closing = false): Promise<void> {
    for (const [id, pending] of this.pending) {
      if (!closing && pending.parent !== parent) continue;
      const dispatch = pending.parent ? this.dispatches.get(pending.parent) : undefined;
      const terminal = dispatch && dispatch.terminalSegment === pending.record.segment ? dispatch.outcome : undefined;
      if (!closing && !pending.stopped && terminal === undefined) continue;
      const outcome = pending.stopped ? "stopped" : terminal ?? "unknown";
      const record: AgentRunRecord = { ...pending.record, outcome, confirmedAt: new Date().toISOString(),
        outcomeEvidence: ["subagent-stop", ...(pending.stopped ? ["meta:stoppedByUser"] : []), ...(terminal && dispatch?.evidence ? [dispatch.evidence] : [])] };
      this.pending.delete(id);
      if (dispatch) {
        dispatch.segment = pending.record.segment! + 1;
        dispatch.outcome = undefined;
        dispatch.evidence = undefined;
        dispatch.terminalSegment = undefined;
      }
      const subject: LearningSubject = { recipient: record.recipient!, run: record.runId!, dispatchId: record.dispatchId!,
        executor: "claude", model: record.model, effort: record.effort, role: record.role };
      if (pending.parent) this.finished.set(pending.parent, subject);
      this.unrecorded.push({ record: Object.freeze(record), parent: pending.parent, subject: Object.freeze({ ...subject }) });
      await this.recordConfirmed();
    }
    await this.recordConfirmed();
  }
  private async recordConfirmed(): Promise<void> {
    while (this.unrecorded.length) {
      const { record, parent, subject } = this.unrecorded[0];
      await this.append(record);
      this.unrecorded.shift();
      if (parent && subject) await this.settled(parent, record.agent_id, record, subject);
    }
  }
  interrupt(): void {
    for (const [parent, dispatch] of this.dispatches) if (dispatch.outcome === undefined && ![...this.pending.values()].some(pending => pending.parent === parent)) {
      dispatch.outcome = "stopped";
      dispatch.evidence = "host-interrupt";
      dispatch.terminalSegment = dispatch.segment;
    }
  }
  close(): Promise<void> { return this.serial(() => this.confirm(undefined, true)); }
  flush(): Promise<void> { return this.serial(async () => {}); }
}
