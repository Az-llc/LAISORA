import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { attributeSubagent, type InjectedAgentDefinition, type RosterEvidence } from "./roster-evidence";
import { CLAUDE_EFFORTS, claudeModelIdLabel } from "./orchestration-executors";
import { HUMAN_REJECTED_TOOL_RESULT_RE } from "./tool-result-signals";
import type { AgentRunRecord } from "./orchestration-external";
import { isSyntheticModel } from "./protocol";
export const agentRecipient = (id: string): string => `agent:${id}`;

interface Dispatch { run: string; dispatchId: string; parent: string; key?: string; effort?: string; model?: string; outcome?: "normal" | "stopped"; evidence?: string; background?: boolean; runtime: boolean; segment: number; terminalSegment?: number; taskId?: string }
interface Pending { record: AgentRunRecord; parent?: string; stopped: boolean }

export class AgentAttribution {
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly pending = new Map<string, Pending>();
  private readonly segments = new Map<string, number>();
  private readonly tasks = new Map<string, string>();
  private readonly consumed = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly unrecorded: AgentRunRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly roster: () => RosterEvidence, private readonly append: (record: AgentRunRecord) => Promise<unknown>,
    private readonly log: (message: string) => void,
    private readonly recorded: (agentKey: string | undefined) => InjectedAgentDefinition | undefined = () => undefined) {}
  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(action).catch(() => this.log("agent attribution unavailable"));
    this.queue = next;
    return next;
  }
  dispatch(parent: string, input: Record<string, unknown>): void {
    if (this.dispatches.has(parent)) return;
    this.dispatches.set(parent, { parent, run: randomUUID(), dispatchId: randomUUID(),
      key: typeof input.subagent_type === "string" ? input.subagent_type : undefined,
      effort: (CLAUDE_EFFORTS as readonly unknown[]).includes(input.effort) ? input.effort as string : undefined, runtime: false, segment: 1 });
  }
  model(parent: string, value: string): void {
    const dispatch = this.dispatches.get(parent);
    if (dispatch && !isSyntheticModel(value)) { dispatch.model = claudeModelIdLabel(value); dispatch.runtime = true; }
  }
  parentOfTask(taskId: string): string | undefined { return this.tasks.get(taskId); }
  started(parent: string, taskId: string, background: unknown): void {
    const dispatch = this.dispatches.get(parent);
    if (!dispatch || !taskId || typeof background !== "boolean") return;
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
  }
  updated(taskId: string, background: unknown): void {
    const parent = this.tasks.get(taskId);
    const dispatch = parent ? this.dispatches.get(parent) : undefined;
    if (dispatch && dispatch.taskId === taskId && typeof background === "boolean") dispatch.background = background;
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
  notification(parent: string, status: unknown, taskId: string, evidenceId: unknown): Promise<void> {
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
        } catch { this.log("agent metadata unavailable"); }
        try {
          for (const line of (await readFile(transcript, "utf8")).split("\n")) {
            try {
              const value = JSON.parse(line);
              if (value.type === "assistant" && typeof value.message?.model === "string" && !isSyntheticModel(value.message.model)) model = claudeModelIdLabel(value.message.model);
            } catch {}
          }
        } catch { this.log("agent transcript unavailable"); }
      }
      const dispatch = parent ? this.dispatches.get(parent) : undefined;
      if (dispatch) dispatch.runtime = true;
      const agentKey = typeof input.agent_type === "string" ? input.agent_type : dispatch?.key;
      const attributed = attributeSubagent(this.roster(), { agentType: agentKey, transcriptAgentId: record.agent_id, startedAt: Date.parse(record.firstSeenAt) });
      const definition = attributed?.definition ?? this.recorded(agentKey);
      const effort = (input.effort as { level?: unknown } | undefined)?.level;
      const segment = (this.segments.get(record.agent_id) ?? 0) + 1;
      this.segments.set(record.agent_id, segment);
      const enriched: AgentRunRecord = { ...record, agentKey, role: definition?.role ?? "unknown",
        requestedModel: definition?.model ?? "unknown", requestedEffort: (attributed?.perCallEffort && attributed.definition.effort ? dispatch?.effort : undefined) ?? definition?.effort ?? "unknown",
        model: model ?? dispatch?.model ?? (typeof input.model === "string" ? claudeModelIdLabel(input.model) : record.model ?? "unknown"),
        effort: typeof effort === "string" ? effort : record.effort ?? "unknown", segment,
        runId: segment === 1 ? dispatch?.run ?? randomUUID() : randomUUID(), dispatchId: dispatch?.dispatchId ?? randomUUID(), recipient: agentRecipient(parent ?? record.agent_id) };
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
      if (pending.parent) this.finished.add(pending.parent);
      this.unrecorded.push(Object.freeze(record));
      await this.recordConfirmed();
    }
    await this.recordConfirmed();
  }
  private async recordConfirmed(): Promise<void> {
    while (this.unrecorded.length) {
      await this.append(this.unrecorded[0]);
      this.unrecorded.shift();
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
