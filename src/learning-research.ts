import type { Session } from "./session";
import { normalizeProfileSources, PROFILE_SOURCES, type ProfileSource } from "./protocol";
import { isNonHumanCommandInput } from "./human-input-vocabulary";
import type { ExternalModels } from "./orchestration-executors";
import type { OrchestrationRow } from "./orchestration-roster";
import { listedProfileTargets, modelProfileResearchInstruction, profileTargetKey, type ProfileTarget } from "./orchestration-profiles";
import { completedPublicClaims, qualifyClaims, type LedgerV2Record } from "./learning-episodes";
import { measuredLines, SECTION_CHAR_BUDGET, type MeasuredRun } from "./learning-section";
import type { LearningSwitches } from "./learning-delivery";
import { claudeModelIdLabel } from "./orchestration-executors";
import { privateTextR06 } from "./learning";

export function buildEffortEvidence(records: readonly LedgerV2Record[], runs: readonly MeasuredRun[], targets: readonly ProfileTarget[],
  roles: ReadonlySet<string>, conversation: string | undefined, now: string, switches: LearningSwitches, ready: boolean,
  selectedRows?: readonly { executor: string; model: string; role: string }[]): string {
  if (!ready || !switches.enabled) return "No evidence";
  const normalized = targets.map(t => ({ ...t, model: t.executor === "claude" ? claudeModelIdLabel(t.model) : t.model }));
  const claims = qualifyClaims(records, now, (executor, model) => normalized.some(t => t.executor === executor && t.model === model), roles);
  const complete = completedPublicClaims(records);
  const assignment = records.find(r => r.kind === "experiment-assignment" && r.conversation === conversation);
  const common: string[] = [], experimental: string[] = [];
  for (const target of normalized) for (const role of roles) {
    if (role === "unknown" || role === "child" || /[:/]/.test(role)) continue;
    if (selectedRows && !selectedRows.some(row => row.executor === target.executor && row.model === target.model && row.role === role)) continue;
    const rows: string[] = [];
    for (const claim of claims.filter(c => c.executor === target.executor && c.model === target.model && (c.role === "general" || c.role === role))) {
      if (claim.source === "public" && switches.publicDelivery) {
        const raw = records.filter(r => r.kind === "claim" && r.itemId === claim.itemId && complete.has(r.opId))
          .sort((a, b) => a.at.localeCompare(b.at) || a.opId.localeCompare(b.opId)).at(-1);
        if (raw?.kind === "claim" && !raw.sources!.some(s => privateTextR06(s.url))) rows.push(`[public] ${claim.effort}: ${claim.text}${raw.figures ? `; figures: ${raw.figures}` : ""}; ${raw.sources!.map(s => `${s.url} checkedAt ${s.checkedAt}`).join("; ")}`);
      } else if (claim.source === "observation" && switches.observationDelivery) {
        const evidence = new Set(records.flatMap(r => r.kind === "claim" && r.itemId === claim.itemId ? r.evidence.creditedRunIds : []));
        experimental.push(`${profileTargetKey(target)} ${role}: [provisional${evidence.size ? "" : ", uncorroborated"}] ${claim.effort}: ${claim.text}; freshAt ${claim.freshAt}; ${evidence.size} credited runs; answer quality unverified`);
      }
    }
    const own = runs.filter(r => r.role === role && r.executor === target.executor && r.model === target.model);
    const efforts = [...new Set(own.map(r => r.actualEffort ?? "unknown"))].sort();
    const measured = efforts.flatMap(effort => measuredLines(own.filter(r => (r.actualEffort ?? "unknown") === effort), [target], now)
      .map(line => `| ${effort} | ${line.full.replace(/^- \[measured[^\]]*\] /, "")} |`));
    if (measured.length) rows.push("| Effort | Delegation records; answer quality not measured |", "| --- | --- |", ...measured);
    common.push(`${profileTargetKey(target)} ${role}:\n${rows.length ? rows.join("\n") : "No evidence"}`);
  }
  const selected: string[] = [];
  const fits = (line: string) => [...[...selected, line].join("\n")].length <= SECTION_CHAR_BUDGET;
  for (const line of common) if (fits(line)) selected.push(line);
  if (!switches.experiment || assignment?.kind !== "experiment-assignment" || assignment.arm !== "holdout") for (const line of experimental) if (fits(line)) selected.push(line);
  return selected.join("\n") || "No evidence";
}

type InstructionFactory = (models: ExternalModels, roster: readonly OrchestrationRow[], targets: readonly ProfileTarget[]) => string | undefined;
const pending = new WeakMap<Session, { generation: number; targets: Map<string, ProfileTarget>; sources: ProfileSource[]; instruction?: InstructionFactory }>();
const running = new WeakMap<Session, { generation: number; conversation: Session["conversation"]; targets: Set<string>; effort: boolean }>();

function runningResearchTargets(session: Session): Set<string> | undefined {
  const active = running.get(session);
  if (active && (active.generation !== session.logicalGeneration || active.conversation !== session.conversation
    || !session.conversation || session.conversation.isClosed || session.conversation.state === "idle")) running.delete(session);
  return running.get(session)?.targets;
}

export function hasModelProfileResearch(session: Session, targets: readonly ProfileTarget[], effort = false): boolean {
  if (session.closed || session.clearing) return false;
  const active = runningResearchTargets(session);
  const request = pending.get(session);
  const queued = request?.generation === session.logicalGeneration && !!request.instruction === effort ? request.targets : undefined;
  return targets.every(target => (running.get(session)?.effort === effort && active?.has(profileTargetKey(target))) || queued?.has(profileTargetKey(target)));
}

export function cancelPendingModelProfileResearch(session: Session, generation: number): void {
  if (pending.get(session)?.generation === generation) pending.delete(session);
}

export function finishModelProfileResearch(session: Session, conversation: Session["conversation"]): void {
  if (running.get(session)?.conversation === conversation) running.delete(session);
}

export function queueModelProfileResearch(session: Session, targets: readonly ProfileTarget[], sources: readonly ProfileSource[] = PROFILE_SOURCES, instruction?: InstructionFactory): boolean {
  const active = runningResearchTargets(session);
  const available = targets.filter(target => !active?.has(profileTargetKey(target)));
  if (!available.length) return false;
  const previous = pending.get(session);
  const request = previous?.generation === session.logicalGeneration ? previous
    : { generation: session.logicalGeneration, targets: new Map<string, ProfileTarget>(), sources: [], instruction };
  request.sources = normalizeProfileSources(sources);
  for (const target of available) request.targets.set(profileTargetKey(target), target);
  pending.set(session, request);
  return true;
}

export function flushModelProfileResearch(session: Session, _enabled: boolean, models: ExternalModels, roster: readonly OrchestrationRow[]): void {
  runningResearchTargets(session);
  const request = pending.get(session);
  if (!request) return;
  if (session.closed || session.clearing || session.logicalGeneration !== request.generation) {
    pending.delete(session);
    return;
  }
  const conversation = session.conversation;
  if (!conversation?.learningToolAvailable || conversation.state !== "idle" || conversation.isClosed) return;
  const known = new Set(listedProfileTargets(models, roster).map(profileTargetKey));
  const targets = [...request.targets.values()].filter(target => known.has(profileTargetKey(target)));
  pending.delete(session);
  if (!targets.length) return;
  const research = !request.instruction ? conversation.allowResearchModels(targets) : undefined;
  const text = request.instruction ? request.instruction(models, roster, targets) : modelProfileResearchInstruction(targets, request.sources, research);
  if (!text) return;
  running.set(session, { generation: session.logicalGeneration, conversation, targets: new Set(targets.map(profileTargetKey)), effort: !!request.instruction });
  if (!isNonHumanCommandInput(text)) {
    session.pushEvent({ kind: "user_message", turnId: null, text, sentAt: Date.now() });
  }
  conversation.send(text, undefined, session.lastRecordedEventTimestamp ?? undefined);
}
