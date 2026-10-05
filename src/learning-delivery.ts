import { validExposures, exposureUsage } from "./learning-exposure";
export { validExposures, exposureUsage } from "./learning-exposure";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSection, measuredLines, ruleLine, NEW_ITEM_GRACE_DELIVERIES, type SectionResult, type MeasuredRun } from "./learning-section";
import { qualifyClaims, deliverableRules, projectNotices, type RosterTarget, type RuleState, type ExposureRecord, type LedgerV2Record } from "./learning-episodes";
import { LearningIngestion, type LearningSubject } from "./learning-ingestion";
import { privateTextR06, textHash } from "./learning";
import { listedProfileTargets, resolveClaudeProfileModel } from "./orchestration-profiles";
import { orchestrationVariants, orchestrationExternalTargets, type OrchestrationRow, type ExternalModels } from "./orchestration-roster";
import { claudeModelIdLabel } from "./orchestration-executors";
import { decodeExternalRunRecord, DISPATCH_BUDGET_EXCEEDED, LEARNING_ADDITION_CODE_POINT_CAP, WINDOWS_COMMAND_LINE_UTF16_LIMIT, type OrchestrationRunRecord } from "./orchestration-external";
export { LEARNING_ADDITION_CODE_POINT_CAP, WINDOWS_COMMAND_LINE_UTF16_LIMIT } from "./orchestration-external";
export const CLAUDE_TARGET_INJECTION_MAX_TASK_CODEPOINTS = 200000;

export interface LearningSwitches {
  enabled: boolean;
  automaticAdoption: boolean;
  targetInjection: boolean;
  observationDelivery: boolean;
  publicDelivery: boolean;
  experiment: boolean;
  guard: boolean;
}
export const DEFAULT_LEARNING_SWITCHES: LearningSwitches = { enabled: true, automaticAdoption: true, targetInjection: true, observationDelivery: true, publicDelivery: true, experiment: true, guard: true };

export interface PromptBudget {
  readonly adapter: string;
  readonly learningAdditionCap: number;
  readonly taskCodePointLimit?: number;
  readonly commandLineLimit?: number;
  readonly commandLineUsage?: (prompt: string) => number;
}
export function executorPromptBudget(executor: string, _model: string): PromptBudget {
  return { adapter: executor === "claude" ? "claude-addition-code-points-v1" : `${executor}-argv-utf16-v1`,
    learningAdditionCap: LEARNING_ADDITION_CODE_POINT_CAP,
    ...(executor === "claude" ? { taskCodePointLimit: CLAUDE_TARGET_INJECTION_MAX_TASK_CODEPOINTS } : { commandLineLimit: WINDOWS_COMMAND_LINE_UTF16_LIMIT }) };
}
export function promptUsage(prompt: string, packaging: string, budget: PromptBudget, task = prompt) {
  return { adapter: budget.adapter, learningAdditionCap: budget.learningAdditionCap,
    taskCodePointLimit: budget.taskCodePointLimit ?? 0, taskCodePoints: [...task].length + [...packaging].length,
    learningAdditionPoints: [...prompt.slice(task.length)].length, commandLineLimit: budget.commandLineLimit ?? 0,
    commandLineUnits: budget.commandLineLimit === undefined ? 0 : budget.commandLineUsage?.(prompt) ?? 2 * (prompt.length + packaging.length) + 3 };
}

export function learningRoster(roster: readonly OrchestrationRow[], models?: ExternalModels): RosterTarget[] {
  return [...orchestrationVariants(roster).flatMap(variant => {
    const model = resolveClaudeProfileModel(variant.model, models);
    return model ? [{ executor: "claude", model: claudeModelIdLabel(model), effort: variant.effort ?? "none", role: variant.role }] : [];
  }), ...orchestrationExternalTargets(roster, models).map(row => ({ executor: row.executor, model: row.model, effort: row.effort ?? "none", role: row.role }))];
}

export function sectionFromLedger(records: Iterable<LedgerV2Record>, rules: Iterable<RuleState>, roster: readonly OrchestrationRow[], models: ExternalModels | undefined,
  conductorModel: string, project: string, conversation: string, now: string, runs: readonly MeasuredRun[], switches: LearningSwitches = DEFAULT_LEARNING_SWITCHES): SectionResult {
  const all = [...records], targets = (models ? listedProfileTargets(models, roster) : learningRoster(roster, models))
    .map(target => ({ executor: target.executor, model: target.executor === "claude" ? claudeModelIdLabel(target.model) : target.model }))
    .filter((target, index, list) => list.findIndex(other => other.executor === target.executor && other.model === target.model) === index);
  const roles = new Set(roster.filter(row => row.enabled).map(row => row.role));
  const usage = exposureUsage(all);
  const assignment = all.find(record => record.kind === "experiment-assignment" && record.conversation === conversation);
  const noticesSeen = new Set(validExposures(all.filter(record => record.kind === "exposure" && record.conversation === conversation)).flatMap(exposure => exposure.items.filter(item => item.type === "notice").map(item => item.id)));
  return buildSection({ conductorModel, targets, roles, rules: switches.enabled && switches.automaticAdoption
    ? deliverableRules(rules, conductorModel, learningRoster(roster, models)).map(rule => ({ ...rule, ineffective: usage.ineffective.get(rule.ruleId) ?? 0 })) : [],
    claims: switches.enabled ? qualifyClaims(all.filter(record => record.kind !== "claim" || !privateTextR06(record.text)), now, (executor, model) => targets.some(target => target.executor === executor && target.model === model), roles)
      .filter(claim => claim.source === "public" ? switches.publicDelivery : switches.observationDelivery) : [],
    measured: switches.enabled ? measuredLines(runs, targets, now) : [], notices: switches.enabled ? projectNotices(all, project, noticesSeen) : [],
    currentProject: project, deliveredConversations: usage.delivered, usedConversations: usage.used,
    arm: switches.experiment && assignment?.kind === "experiment-assignment" ? assignment.arm : "delivery" });
}

export async function readMeasuredRuns(directory: string | undefined, log: (message: string) => void): Promise<MeasuredRun[]> {
  if (!directory) return [];
  let text: string;
  try { text = await readFile(join(directory, "runs.jsonl"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("R-LRN-26: runs unavailable"); return []; }
  const external = new Map<string, MeasuredRun>(), agents = new Map<string, { run: MeasuredRun; segment: number }>();
  let skipped = 0;
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      const raw = JSON.parse(line);
      if (raw.kind === "external") {
        const record = decodeExternalRunRecord(raw);
        if (!record) { skipped++; continue; }
        const runId = record.runId ?? textHash(line);
        external.set(runId, { runId, executor: record.executor, model: record.requestedModel ?? "unknown", actualModel: record.observedModel,
          actualEffort: record.observedEffort, effort: record.requestedEffort ?? "unknown", role: record.role, outcome: record.outcome === "ok" ? "normal" : record.outcome,
          endAt: record.endedAt, durationMs: record.durationMs, session: record.conversation ?? "unknown" });
      } else if (raw.kind === "agent" && typeof raw.agent_id === "string" && Number.isFinite(Date.parse(raw.lastActivityAt))) {
        if (typeof raw.firstSeenAt !== "string" || !Number.isFinite(Date.parse(raw.firstSeenAt))
          || Date.parse(raw.firstSeenAt) > Date.parse(raw.lastActivityAt)
          || [raw.role, raw.effort, raw.requestedModel, raw.requestedEffort, raw.model].some(value => value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)))
          || raw.outcome !== undefined && !["normal", "stopped", "timeout", "unknown"].includes(raw.outcome)
          || raw.confirmedAt !== undefined && !Number.isFinite(Date.parse(raw.confirmedAt))
          || raw.outcomeEvidence !== undefined && (!Array.isArray(raw.outcomeEvidence) || !raw.outcomeEvidence.every((value: unknown) => typeof value === "string"))) { skipped++; continue; }
        const owner = raw.conversation ?? raw.sessionId ?? "unknown", key = JSON.stringify([owner, raw.agent_id]);
        const previous = agents.get(key);
        const segment = raw.segment ?? 0;
        if (previous && (previous.segment > segment || previous.segment === segment && previous.run.endAt > raw.lastActivityAt)) continue;
        agents.set(key, { segment, run: { runId: raw.runId ?? textHash(`${owner}:${raw.agent_id}`), executor: "claude", model: claudeModelIdLabel(raw.requestedModel ?? "unknown"),
          actualModel: raw.confirmedAt && raw.outcomeEvidence?.length ? raw.model ?? "unknown" : "unknown", actualEffort: raw.confirmedAt ? raw.effort ?? "unknown" : "unknown",
          effort: raw.requestedEffort ?? "unknown", role: raw.role ?? "unknown", outcome: raw.outcome ?? "unknown", endAt: raw.lastActivityAt,
          durationMs: Date.parse(raw.lastActivityAt) - Date.parse(raw.firstSeenAt), session: raw.conversation ?? "unknown" } });
      } else skipped++;
    } catch { skipped++; }
  }
  if (skipped) log(`R-LRN-26: skipped ${skipped} invalid run lines`);
  return [...external.values(), ...[...agents.values()].map(entry => entry.run)];
}

interface PendingExposure { record: ExposureRecord; withheld: readonly { item: { type: "rule" | "claim" | "measured" | "notice"; id: string }; reason: string }[]; transportAccepted: boolean; receiptPersisted: boolean; boundModel?: string }
export class LearningDelivery {
  private readonly pending = new Map<string, PendingExposure>();
  private readonly mismatched = new Set<string>();
  private readonly stopped = new Set<keyof LearningSwitches>();
  private readonly observedRuns = new Map<string, OrchestrationRunRecord>();
  constructor(private readonly ingestion: LearningIngestion, private readonly switches: () => LearningSwitches, private readonly log: (message: string) => void) {
    this.effectiveSettings();
  }
  private effectiveSettings(): LearningSwitches {
    const current = this.switches();
    for (const key of Object.keys(current) as (keyof LearningSwitches)[]) if (!current[key]) this.stopped.add(key);
    return Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value && !this.stopped.has(key as keyof LearningSwitches)])) as unknown as LearningSwitches;
  }
  private receipt(subject: LearningSubject, prompt: string, model: string, effort: string, route: "conductor" | "target", items: ExposureRecord["items"]): ExposureRecord {
    return { kind: "exposure", v: 2, at: new Date().toISOString(), opId: randomUUID(), exposureId: randomUUID(), conversation: this.ingestion.conversation ?? "unknown",
      session: this.ingestion.sessionRef, recipient: this.ingestion.ref("recipient", subject.recipient), run: this.ingestion.ref("run", subject.run),
      dispatchId: this.ingestion.ref("dispatch", subject.dispatchId), items, promptHash: textHash(prompt), requestedModel: model, requestedEffort: effort,
      observedModel: "unknown", observedEffort: "unknown", route, ...(subject.executor ? { executor: subject.executor } : {}), ...(subject.role ? { role: subject.role } : {}), outcome: "sent" };
  }
  async conductor(section: SectionResult, prompt: string, model: string): Promise<void> {
    const record = { ...this.receipt(this.ingestion.conductorSubject, prompt, model, "none", "conductor", section.items), common: section.common };
    this.pending.set(record.dispatchId, { record, withheld: section.withheld, transportAccepted: false, receiptPersisted: false });
    await this.accept(record.dispatchId);
    await this.ingestion.ledger.append({ kind: "delivery", v: 2, at: record.at, opId: randomUUID(), conversation: record.conversation, session: record.session,
      conductorModel: model, project: this.ingestion.projectRef, items: section.items, setHash: section.setHash, chars: section.chars, dropped: section.dropped, outcome: "sent", exposureId: record.exposureId });
  }
  target(subject: LearningSubject, prompt: string, packaging = "", budget = executorPromptBudget(subject.executor ?? "claude", subject.model ?? "unknown")): string {
    const all = [...this.ingestion.ledger.state.records.values()], usage = exposureUsage(all), settings = this.effectiveSettings();
    const arm = this.ingestion.ledger.state.assignments.get(this.ingestion.conversation ?? "unknown")?.arm;
    const rules = [...this.ingestion.ledger.state.rules.values()].filter(rule => rule.active && rule.key.bind === "target"
      && rule.key.executor === subject.executor && rule.key.model === subject.model && rule.key.effort === subject.effort && rule.key.role === subject.role)
      .sort((a, b) => {
        const current = Number(b.projects.has(this.ingestion.projectRef)) - Number(a.projects.has(this.ingestion.projectRef));
        const grace = (rule: RuleState) => (usage.delivered.get(rule.ruleId) ?? 0) < NEW_ITEM_GRACE_DELIVERIES;
        return current || Number(grace(b)) - Number(grace(a)) || (!grace(a) ? (usage.used.get(b.ruleId) ?? 0) - (usage.used.get(a.ruleId) ?? 0) : 0)
          || b.lastAt.localeCompare(a.lastAt) || a.ruleId.localeCompare(b.ruleId);
      });
    const baseUsage = promptUsage(prompt, packaging, budget);
    if (budget.commandLineLimit !== undefined && baseUsage.commandLineUnits > budget.commandLineLimit) throw new Error(DISPATCH_BUDGET_EXCEEDED);
    const record = this.receipt(subject, prompt, subject.model ?? "unknown", subject.effort ?? "unknown", "target", []);
    const reason = !this.ingestion.ready || !this.ingestion.ledger.consistent ? "state-unavailable" : !settings.enabled || !settings.targetInjection || !settings.automaticAdoption ? "disabled"
      : this.mismatched.has(JSON.stringify([subject.executor, subject.model, subject.effort])) ? "model-mismatch" : settings.experiment && arm === "holdout" ? "holdout"
      : budget.taskCodePointLimit !== undefined && baseUsage.taskCodePoints > budget.taskCodePointLimit ? "task-size-withheld" : undefined;
    const kept = reason ? [] : [...rules];
    const withheld = reason ? rules.map(rule => ({ item: { type: "rule" as const, id: rule.ruleId }, reason })) : [];
    const render = () => kept.length ? `${prompt}\n\nModel usage knowledge for ${subject.executor}/${subject.model}:\n${kept.map(ruleLine).join("\n")}` : prompt;
    while (kept.length) {
      const usageNow = promptUsage(render(), packaging, budget, prompt);
      if (usageNow.learningAdditionPoints <= budget.learningAdditionCap
        && (budget.commandLineLimit === undefined || usageNow.commandLineUnits <= budget.commandLineLimit)) break;
      const drop = [...kept].reverse().find(rule => (usage.delivered.get(rule.ruleId) ?? 0) >= NEW_ITEM_GRACE_DELIVERIES)
        ?? [...kept].sort((a, b) => Number(a.projects.has(this.ingestion.projectRef)) - Number(b.projects.has(this.ingestion.projectRef)) || a.lastAt.localeCompare(b.lastAt))[0];
      kept.splice(kept.indexOf(drop), 1); withheld.push({ item: { type: "rule", id: drop.ruleId }, reason: "budget-withheld" });
    }
    const actual = render();
    this.pending.set(record.dispatchId, { record: { ...record, promptHash: textHash(actual), items: kept.map(rule => ({ type: "rule", id: rule.ruleId })),
      budget: promptUsage(actual, packaging, budget, prompt) }, withheld, transportAccepted: false, receiptPersisted: false });
    return actual;
  }
  async accept(dispatchId: string): Promise<void> {
    const ref = this.ingestion.ref("dispatch", dispatchId);
    const pending = this.pending.get(ref) ?? this.pending.get(dispatchId);
    if (!pending) return;
    if (!pending.transportAccepted) pending.record = { ...pending.record, at: new Date().toISOString(), session: this.ingestion.sessionRef };
    pending.transportAccepted = true;
    if (pending.receiptPersisted) return;
    await this.ingestion.ledger.append(pending.record);
    pending.receiptPersisted = true;
    for (const withheld of pending.withheld) await this.ingestion.ledger.append({ ...pending.record, opId: randomUUID(), exposureId: randomUUID(), items: [withheld.item],
      outcome: withheld.reason === "holdout" ? "withheld" : ["disabled", "state-unavailable", "model-mismatch"].includes(withheld.reason)
        ? withheld.reason as "disabled" | "state-unavailable" | "model-mismatch" : "budget-withheld", reason: withheld.reason });
    if (pending.withheld.some(item => !["holdout", "disabled"].includes(item.reason))) this.log(`R-LRN-05 R-LRN-35: ${pending.withheld.length} items withheld`);
  }
  async observed(dispatchId: string, model: string, effort: string, evidence: readonly string[], failed = false, metadataMismatch = false): Promise<void> {
    const pending = this.pending.get(this.ingestion.ref("dispatch", dispatchId)) ?? this.pending.get(dispatchId);
    if (!pending) return;
    if (!failed) await this.accept(dispatchId);
    const record = pending.record;
    const unresolvedConductor = record.route === "conductor" && record.requestedModel === "unknown";
    if (unresolvedConductor && model !== "unknown") pending.boundModel ??= model;
    const requestedModel = unresolvedConductor ? pending.boundModel ?? "unknown" : record.requestedModel;
    const mismatch = metadataMismatch || model !== "unknown" && model !== requestedModel || record.route === "target" && effort !== "unknown" && effort !== record.requestedEffort;
    if (mismatch) this.mismatched.add(JSON.stringify([record.executor, record.requestedModel, record.requestedEffort]));
    await this.ingestion.ledger.append({ ...record, session: this.ingestion.sessionRef, opId: randomUUID(), at: new Date().toISOString(), observedModel: model, observedEffort: effort,
      attestation: evidence.map(value => this.ingestion.ref("attestation", value)), outcome: failed ? "dispatch-failed" : mismatch ? "model-mismatch" : "sent" });
  }
  async run(record: OrchestrationRunRecord): Promise<void> {
    if (record.runId) this.observedRuns.set(record.kind === "agent" ? `agent:${record.agent_id}` : record.runId, record);
    if (!record.dispatchId) return;
    const pending = this.pending.get(this.ingestion.ref("dispatch", record.dispatchId)) ?? this.pending.get(record.dispatchId);
    if (!pending || !record.runId || !record.recipient || this.ingestion.ref("run", record.runId) !== pending.record.run
      || this.ingestion.ref("recipient", record.recipient) !== pending.record.recipient) return;
    const executor = record.kind === "agent" ? "claude" : record.executor;
    const matches = executor === pending.record.executor && record.role === pending.record.role;
    const mismatch = executor !== pending.record.executor || record.role !== undefined && record.role !== "unknown" && record.role !== pending.record.role;
    await this.observed(record.dispatchId, record.kind === "agent" ? record.model ?? "unknown" : record.observedModel ?? "unknown",
      record.kind === "agent" ? record.effort ?? "unknown" : record.observedEffort ?? "unknown",
      record.kind === "agent" && record.confirmedAt && record.outcomeEvidence?.length && matches ? [`${record.runId}:runtime:${record.confirmedAt}`]
        : record.kind === "external" && record.attestation && matches ? [`${record.runId}:${record.attestation.source}:${record.attestation.sessionId}`] : [], false, mismatch);
  }
  async end(): Promise<void> {
    const all = [...this.ingestion.ledger.state.records.values()];
    for (const exposure of validExposures(all).filter(record => record.conversation === this.ingestion.conversation)) for (const item of exposure.items) {
      if (item.type === "claim") {
        const claim = all.find(record => record.kind === "claim" && record.itemId === item.id);
        if (claim?.kind !== "claim") continue;
        const runs = [...this.observedRuns.values()].filter(run => {
          const executor = run.kind === "agent" ? "claude" : run.executor;
          const model = run.kind === "agent" ? run.model : run.observedModel;
          const effort = run.kind === "agent" ? run.effort : run.observedEffort;
          const started = run.kind === "agent" ? run.firstSeenAt : run.startedAt;
          const ended = run.kind === "agent" ? run.lastActivityAt : run.endedAt;
          const attested = run.kind === "agent" ? run.confirmedAt && run.outcomeEvidence?.length && run.confirmedAt >= ended
            : run.attestation && run.attestation.model === model && run.attestation.effort === effort;
          return run.runId && attested && Number.isFinite(Date.parse(started)) && Number.isFinite(Date.parse(ended))
            && started >= exposure.at && ended >= started && executor === claim.executor && model === claim.model
            && effort !== undefined && effort !== "unknown" && (claim.effort === "any" || effort === claim.effort)
            && (claim.role === "general" || run.role === claim.role);
        });
        if (!runs.length) continue;
        const opId = textHash(`use:${item.id}:${exposure.conversation}:${exposure.recipient}:${exposure.run}`);
        if (!this.ingestion.ledger.state.records.has(opId)) await this.ingestion.ledger.append({ kind: "use", v: 2, at: new Date().toISOString(), opId,
          item: { type: "claim", itemId: item.id }, conversation: exposure.conversation, recipient: exposure.recipient, run: exposure.run, dispatchId: exposure.dispatchId,
          runs: runs.map(run => this.ingestion.ref("run", run.runId!)) });
        continue;
      }
      if (item.type !== "rule") continue;
      const rule = this.ingestion.ledger.state.rules.get(item.id);
      if (!rule || exposure.route !== (rule.key.bind === "target" ? "target" : "conductor")) continue;
      if (all.some(record => record.kind === "episode" && record.status === "counted" && record.ruleId === rule.ruleId && record.conversation === exposure.conversation
        && record.recipient === exposure.recipient && record.run === exposure.run)) continue;
      if (!all.some(record => record.kind === "episode-state" && record.action === "success" && record.status === undefined && record.conversation === exposure.conversation
        && record.recipient === exposure.recipient && record.run === exposure.run && record.tool === rule.tool && record.head === rule.head && record.at >= exposure.at)) continue;
      const opId = textHash(`use:${item.id}:${exposure.conversation}:${exposure.recipient}:${exposure.run}`);
      if (this.ingestion.ledger.state.records.has(opId)) continue;
      await this.ingestion.ledger.append({ kind: "use", v: 2, at: new Date().toISOString(), opId,
        item: { type: "rule", ruleId: item.id }, conversation: exposure.conversation, recipient: exposure.recipient, run: exposure.run, dispatchId: exposure.dispatchId });
    }
    for (const pending of this.pending.values()) if (!pending.transportAccepted) await this.observed(pending.record.dispatchId, "unknown", "unknown", [], true);
  }
}
