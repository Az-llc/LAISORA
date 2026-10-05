import { randomUUID } from "node:crypto";
import type { LearningIngestion, LearningSubject } from "./learning-ingestion";
import type { LedgerV2Record, ExperimentAssignmentRecord, LearningControlRecord, RuleState, ClaimItem } from "./learning-episodes";
import { toolHead } from "./learning-signature";
import type { LearningSwitches } from "./learning-delivery";
import { validExposures, exposureUsage } from "./learning-exposure";
import { EXPERIMENT_WINDOW_MS, EXPERIMENT_MIN_ELIGIBLE_CONVERSATIONS_PER_ARM, EXPERIMENT_MIN_RELEVANT_OPPORTUNITIES_PER_ARM,
  EXPERIMENT_BOOTSTRAP_SAMPLES, EXPERIMENT_CONFIDENCE_LEVEL } from "./learning-experiment";

export class LearningMeasurement {
  private switches?: string;
  private detector?: string;
  constructor(private readonly ingestion: LearningIngestion) {
    const last = [...ingestion.ledger.state.records.values()].filter(record => record.conversation === ingestion.conversation
      && (record.kind === "switch-change" || record.kind === "detector-regression")).at(-1);
    if (last?.kind === "switch-change" || last?.kind === "detector-regression") this.switches = JSON.stringify(last.switches);
  }
  async control(settings: LearningSwitches): Promise<void> {
    if (!this.ingestion.conversation) return;
    const fingerprint = JSON.stringify(settings);
    const detector = `${this.ingestion.detector.version}:${this.ingestion.detector.rejected ?? ""}`;
    const base = { v: 2 as const, at: new Date().toISOString(), conversation: this.ingestion.conversation, detectorVersion: this.ingestion.detector.version,
      ...(this.ingestion.detector.rejected === undefined ? {} : { rejectedVersion: this.ingestion.detector.rejected }), switches: { ...settings } };
    if (this.switches !== undefined && this.switches !== fingerprint) await this.ingestion.ledger.append({ ...base, kind: "switch-change", opId: randomUUID() });
    if (this.detector !== detector) await this.ingestion.ledger.append({ ...base, kind: "detector-regression", opId: randomUUID() });
    this.switches = fingerprint;
    this.detector = detector;
  }
  async record(counts: Record<string, number | null>, tags: Record<string, string> = {}, identity: string = randomUUID()): Promise<void> {
    if (!this.ingestion.conversation) return;
    const opId = this.ingestion.ref("measurement", identity);
    if (this.ingestion.ledger.state.records.has(opId)) return;
    const subject = this.ingestion.conductorSubject;
    await this.ingestion.ledger.append({ kind: "measurement", v: 2, at: new Date().toISOString(), opId,
      conversation: this.ingestion.conversation, run: this.ingestion.ref("run", subject.run), counts,
      tags: Object.fromEntries(Object.entries({ detector: String(this.ingestion.detector.version), project: this.ingestion.projectRef, ...tags })
        .map(([key, value]) => [key, /^[\p{L}\p{N} ._:-]{1,200}$/u.test(value) ? value : this.ingestion.ref("tag", value)])) });
  }
  async cumulativeUsage(message: { modelUsage?: unknown; total_cost_usd?: unknown; is_error?: boolean }, session: string, resumed: boolean,
    research: boolean, identity: string, completesTurn: boolean): Promise<void> {
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const models = message.modelUsage && typeof message.modelUsage === "object" && !Array.isArray(message.modelUsage)
      ? Object.values(message.modelUsage) : undefined;
    const inputs = models?.map(model => model && typeof model === "object"
      ? [model.inputTokens, model.cacheReadInputTokens, model.cacheCreationInputTokens] : [undefined]);
    let tokens = inputs?.every(values => values.every(valid)) ? inputs.flat().reduce<number>((sum, value) => sum + value, 0) : null;
    let cost = valid(message.total_cost_usd) ? message.total_cost_usd : null;
    if (message.is_error && (tokens === null || tokens === 0) && (cost === null || cost === 0)) { tokens = null; cost = null; }
    const sessionRef = this.ingestion.ref("session", session);
    const snapshots = [...this.ingestion.ledger.state.records.values()].filter((record): record is Extract<LedgerV2Record, { kind: "measurement" }> =>
      record.kind === "measurement" && record.tags?.usageSession === sessionRef);
    const delta = (key: string, current: number | null): number | null => {
      if (current === null) return null;
      const prior = [...snapshots].reverse().find(record => valid(record.counts[key]))?.counts[key];
      return typeof prior === "number" ? current >= prior ? current - prior : current : resumed ? null : current;
    };
    const promptTokens = delta("claudeCumulativePromptTokens", tokens), researchCost = delta("claudeCumulativeCost", cost);
    await this.record({ claudeCumulativePromptTokens: tokens, claudeCumulativeCost: cost,
      ...(completesTurn ? { usageResults: 1, promptTokens, ...(research ? { researchTokens: promptTokens, researchCost } : {}) } : {}) },
      { executor: "claude", usageSession: sessionRef }, `usage:${sessionRef}:${identity}`);
  }
}

export function learningCandidateMatches(rules: Iterable<RuleState>, claims: readonly ClaimItem[], tool: string, input: unknown,
  subject: LearningSubject, target?: LearningSubject): string[] {
  const matches = [...rules].filter(rule => rule.active && rule.tool === tool && rule.head === toolHead(tool, input)
    && (rule.key.bind === "conductor" ? subject.role === "conductor" && rule.key.model === subject.model
      : subject.role !== "conductor" && rule.key.executor === subject.executor && rule.key.model === subject.model
        && rule.key.effort === subject.effort && rule.key.role === subject.role)).map(rule => rule.ruleId);
  if (target) matches.push(...claims.filter(claim => claim.source === "observation" && claim.executor === target.executor && claim.model === target.model
    && (claim.effort === "any" || claim.effort === target.effort) && (claim.role === "general" || claim.role === target.role)).map(claim => claim.itemId));
  return [...new Set(matches)].sort();
}

export function unionDuration(intervals: readonly (readonly [number, number])[]): number {
  let total = 0, end = -Infinity;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop);
  }
  return total;
}

export function conversationMeasurement(records: readonly LedgerV2Record[], assignment: ExperimentAssignmentRecord, now: number) {
  const start = Date.parse(assignment.at), stop = Math.min(now, start + EXPERIMENT_WINDOW_MS);
  const current = records.filter(record => record.conversation === assignment.conversation && Date.parse(record.at) >= start && Date.parse(record.at) <= stop);
  const measurements = current.filter(record => record.kind === "measurement");
  const actual = validExposures(records).filter(exposure => exposure.conversation === assignment.conversation && Date.parse(exposure.at) >= start && Date.parse(exposure.at) <= stop);
  const usage = exposureUsage(records.filter(record => Date.parse(record.at) <= stop));
  const claimSources = new Map(records.filter(record => record.kind === "claim").map(record => [record.itemId, record.source]));
  const sourceOf = (item: { type: string; id: string }) => item.type === "claim" ? claimSources.get(item.id) ?? "unknown" : item.type;
  const sum = (key: string): number | null => {
    const values = measurements.filter(record => Object.hasOwn(record.counts, key)).map(record => record.counts[key]);
    return !values.length || values.includes(null) ? null : values.reduce<number>((a, b) => a + b!, 0);
  };
  const recordingGap = records.some(record => record.kind === "measurement" && record.conversation === assignment.conversation
    && (record.counts.measurementGap ?? 0) > 0);
  const externalIncomplete = recordingGap || (sum("externalDispatches") ?? 0) > (sum("externalRuns") ?? 0);
  const toolCalls = sum("toolCalls"), toolResults = sum("toolResults");
  const legacyOpportunities = measurements.some(record => Object.hasOwn(record.counts, "opportunities") && !Object.hasOwn(record.counts, "relevantOpportunities"));
  const dispatched = measurements.filter(record => (record.counts.toolCalls ?? 0) > 0).map(record => record.tags?.toolUse).filter(Boolean);
  const completed = new Set(measurements.filter(record => (record.counts.toolResults ?? 0) > 0).map(record => record.tags?.toolUse));
  const turnStarts = sum("turnStarts"), completedTurns = sum("turns");
  const observationComplete = !recordingGap && !legacyOpportunities && toolCalls !== null && toolResults !== null && toolCalls === toolResults
    && dispatched.every(tool => completed.has(tool)) && (turnStarts === null || turnStarts === completedTurns)
    && !current.some(record => record.kind === "episode-state" && record.status === "state-unavailable");
  const relevantOpportunities = legacyOpportunities || recordingGap ? null : sum("relevantOpportunities");
  const outcomesKnown = observationComplete && relevantOpportunities !== null;
  const expectedUsage = turnStarts ?? completedTurns;
  const usageIncomplete = expectedUsage !== null && expectedUsage !== sum("usageResults");
  const states = current.filter(record => record.kind === "episode-state").sort((a, b) => a.at.localeCompare(b.at) || a.opId.localeCompare(b.opId));
  const open = new Map<string, { at: number; turns: number; unknown: boolean }>();
  const intervals: [number, number][] = [];
  const turns = measurements.filter(record => record.counts.turns === 1).map(record => Date.parse(record.at));
  let repairTurns = 0, unknownRepairs = 0;
  for (const state of states) {
    if (state.action === "failure" && !current.some(record => record.kind === "episode" && record.status === "counted" && record.sig === state.sig && record.recipient === state.recipient)) continue;
    const key = `${state.recipient}:${state.operation}`, at = Date.parse(state.at);
    if (state.action === "failure" && !open.has(key)) open.set(key, { at, turns: turns.filter(turn => turn <= at).length, unknown: state.head === "other" || state.status === "state-unavailable" });
    if (state.action === "success" && open.has(key)) {
      const failure = open.get(key)!;
      if (failure.unknown) continue;
      intervals.push([failure.at, at]); repairTurns += turns.filter(turn => turn > failure.at && turn <= at).length; open.delete(key);
    }
  }
  for (const failure of open.values()) {
    intervals.push([failure.at, stop]); repairTurns += turns.filter(turn => turn > failure.at && turn <= stop).length;
    if (failure.unknown) unknownRepairs++;
  }
  return { conversation: assignment.conversation, arm: assignment.arm, windowComplete: now >= start + EXPERIMENT_WINDOW_MS, observationComplete,
    opportunities: relevantOpportunities, recurrences: outcomesKnown ? current.filter(record => record.kind === "episode" && record.status === "counted").length : null,
    repairTurns: outcomesKnown ? Math.min(repairTurns, turns.filter(turn => intervals.some(([begin, end]) => turn > begin && turn <= end)).length) : null,
    unresolved: outcomesKnown ? open.size : null, repairMs: !outcomesKnown || unknownRepairs ? null : unionDuration(intervals), censoredRepairMs: unionDuration(intervals), unknownRepairs,
    promptTokens: externalIncomplete || usageIncomplete ? null : sum("promptTokens"), researchTokens: externalIncomplete || usageIncomplete ? null : sum("researchTokens"),
    researchCost: externalIncomplete || usageIncomplete ? null : sum("researchCost"), externalInputTokens: recordingGap ? null : sum("externalInputTokens"), verifiedOutcomes: outcomesKnown ? sum("verifiedOutcomes") : null,
    denominators: recordingGap ? { conversations: 1, toolCalls: null, toolResults: null, failureResults: null, classified: null, excluded: null }
      : { conversations: 1, toolCalls, toolResults, failureResults: sum("failureResults"), classified: sum("classified"), excluded: sum("excluded") },
    exposure: current.filter(record => record.kind === "exposure").reduce<Record<string, number>>((counts, record) => {
      counts[`${record.route ?? "unknown"}:${record.outcome}`] = (counts[`${record.route ?? "unknown"}:${record.outcome}`] ?? 0) + 1; return counts;
    }, {}),
    sources: current.filter(record => record.kind === "exposure").flatMap(record => record.items.map(item => ({ type: item.type, route: record.route, outcome: record.outcome }))),
    actualExposure: actual.flatMap(exposure => exposure.items.map(item => ({ source: sourceOf(item), route: exposure.route, executor: exposure.executor,
      model: exposure.observedModel, role: exposure.role, item: item.id, deliveredConversations: usage.delivered.get(item.id) ?? 0,
      usedConversations: usage.used.get(item.id) ?? 0, ineffective: usage.ineffective.get(item.id) ?? 0 }))),
    strata: measurements.map(record => ({ tags: record.tags, counts: record.counts })) };
}

function bootstrapDifference(delivery: number[], holdout: number[]): [number, number] | null {
  if (!delivery.length || !holdout.length) return null;
  let seed = 0x1a150a;
  const random = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const differences = Array.from({ length: EXPERIMENT_BOOTSTRAP_SAMPLES }, () => {
    const mean = (values: number[]) => values.reduce(sum => sum + values[random(values.length)], 0) / values.length;
    return mean(delivery) - mean(holdout);
  }).sort((a, b) => a - b);
  const tail = (1 - EXPERIMENT_CONFIDENCE_LEVEL) / 2;
  return [differences[Math.floor(tail * differences.length)], differences[Math.floor((1 - tail) * differences.length)]];
}

export function learningExperimentReport(records: readonly LedgerV2Record[], now = Date.now()) {
  const assignments = records.filter(record => record.kind === "experiment-assignment").filter(record => record.eligible);
  const groups = new Map<string, ExperimentAssignmentRecord[]>();
  for (const assignment of assignments) {
    const changes = records.filter((record): record is LearningControlRecord => record.kind === "switch-change" || record.kind === "detector-regression")
      .filter(record => record.conversation === assignment.conversation && (record.kind === "switch-change" || record.detectorVersion !== assignment.detectorVersion)
        && Date.parse(record.at) >= Date.parse(assignment.at) && Date.parse(record.at) <= Date.parse(assignment.at) + EXPERIMENT_WINDOW_MS)
      .sort((a, b) => a.at.localeCompare(b.at)).map(record => ({ elapsed: Date.parse(record.at) - Date.parse(assignment.at), version: record.detectorVersion, switches: record.switches }));
    const key = JSON.stringify({ version: assignment.experimentVersion, probability: assignment.probability, detector: assignment.detectorVersion,
      switches: Object.entries(assignment.switches).sort(), changes });
    groups.set(key, [...groups.get(key) ?? [], assignment]);
  }
  return { analysis: "intent-to-treat", status: assignments.length ? "see-stratum-status" : "insufficient evidence", confidenceLevel: EXPERIMENT_CONFIDENCE_LEVEL,
    missingPolicy: "report unknown per arm; complete-case intervals are secondary; no imputation as zero",
    dedicated: records.filter(record => record.kind === "experiment-assignment").filter(record => !record.eligible && ["dedicated", "effort-inherited"].includes(record.reason))
      .map(assignment => conversationMeasurement(records, assignment, now)),
    strata: [...groups].map(([configuration, entries]) => {
      const results = entries.map(assignment => conversationMeasurement(records, assignment, now));
      const arms = (['delivery', 'holdout'] as const).map(arm => {
        const conversations = results.filter(result => result.arm === arm);
        return { arm, assigned: conversations.length, changed: entries.filter(entry => entry.arm === arm && records.some(record => record.kind === "switch-change" && record.conversation === entry.conversation)).length,
          opportunities: conversations.reduce((sum, result) => sum + (result.opportunities ?? 0), 0), unknownOpportunities: conversations.filter(result => result.opportunities === null).length,
          unknownTokens: conversations.filter(result => result.promptTokens === null).length, conversations };
      });
      const sufficient = arms.every(arm => arm.assigned >= EXPERIMENT_MIN_ELIGIBLE_CONVERSATIONS_PER_ARM && arm.opportunities >= EXPERIMENT_MIN_RELEVANT_OPPORTUNITIES_PER_ARM
        && arm.conversations.every(result => result.windowComplete));
      const comparisons = ["recurrences", "repairTurns", "unresolved", "repairMs", "promptTokens"].map(metric => {
        const values = arms.map(arm => arm.conversations.map(result => result[metric as "promptTokens"]).filter((value): value is number => value !== null));
        const missing = arms.map((arm, index) => arm.assigned - values[index].length);
        return { metric, missing, missingRates: missing.map((n, i) => arms[i].assigned ? n / arms[i].assigned : null),
          secondaryCompleteCaseInterval: sufficient ? bootstrapDifference(values[0], values[1]) : null,
          sensitivity: missing.some(n => n > 0) ? "unbounded-without-outcome-assumptions" : "complete" };
      });
      return { configuration, status: sufficient ? "sample-conditions-met" : "insufficient evidence", arms, comparisons };
    }) };
}
