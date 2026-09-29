import type { Session } from "./session";
import { normalizeProfileSources, PROFILE_SOURCES, type ProfileSource } from "./protocol";
import { isNonHumanCommandInput } from "./human-input-vocabulary";
import type { ExternalModels } from "./orchestration-executors";
import type { OrchestrationRow } from "./orchestration-roster";
import { listedProfileTargets, modelProfileResearchInstruction, profileTargetKey, type ProfileTarget } from "./orchestration-profiles";

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
  if (session.closed || session.clearing) return false; // R-LRN-18
  const active = runningResearchTargets(session);
  const request = pending.get(session);
  const queued = request?.generation === session.logicalGeneration && !!request.instruction === effort ? request.targets : undefined;
  return targets.every(target => (running.get(session)?.effort === effort && active?.has(profileTargetKey(target))) || queued?.has(profileTargetKey(target)));
}

export function cancelPendingModelProfileResearch(session: Session, generation: number): void {
  // R-LRN-18: a failed startup cannot deliver its request; do not suppress a later press.
  if (pending.get(session)?.generation === generation) pending.delete(session);
}

export function finishModelProfileResearch(session: Session, conversation: Session["conversation"]): void {
  if (running.get(session)?.conversation === conversation) running.delete(session); // R-LRN-18
}

export function queueModelProfileResearch(session: Session, targets: readonly ProfileTarget[], sources: readonly ProfileSource[] = PROFILE_SOURCES, instruction?: InstructionFactory): boolean {
  const active = runningResearchTargets(session);
  // R-LRN-18: running and pending retain target identity until research can be requested again.
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

export function flushModelProfileResearch(session: Session, enabled: boolean, models: ExternalModels, roster: readonly OrchestrationRow[]): void {
  runningResearchTargets(session);
  const request = pending.get(session);
  if (!request) return;
  if (session.closed || session.clearing || session.logicalGeneration !== request.generation) {
    pending.delete(session); // R-LRN-18: never move a request into a replacement conversation.
    return;
  }
  const conversation = session.conversation;
  if (!enabled || !conversation?.learningToolAvailable || conversation.state !== "idle" || conversation.isClosed) return;
  const known = new Set(listedProfileTargets(models, roster).map(profileTargetKey));
  const targets = [...request.targets.values()].filter(target => known.has(profileTargetKey(target)));
  pending.delete(session);
  if (!targets.length) return; // R-LRN-18: validate again immediately before the normal send queue.
  const text = request.instruction ? request.instruction(models, roster, targets) : modelProfileResearchInstruction(targets, request.sources);
  if (!text) return; // R-LRN-19: a refused instruction never enters events or the send queue.
  running.set(session, { generation: session.logicalGeneration, conversation, targets: new Set(targets.map(profileTargetKey)), effort: !!request.instruction });
  if (!request.instruction) conversation.allowResearchModels(targets); // R-LRN-19: proposals do not authorize profile recording.
  if (!isNonHumanCommandInput(text)) {
    session.pushEvent({ kind: "user_message", turnId: null, text, sentAt: Date.now() });
  }
  conversation.send(text, undefined, session.lastRecordedEventTimestamp ?? undefined);
}
