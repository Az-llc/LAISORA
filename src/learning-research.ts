import type { Session } from "./session";
import { normalizeProfileSources, PROFILE_SOURCES, type ProfileSource } from "./protocol";
import { isNonHumanCommandInput } from "./human-input-vocabulary";
import type { ExternalModels } from "./orchestration-executors";
import type { OrchestrationRow } from "./orchestration-roster";
import { listedProfileTargets, modelProfileResearchInstruction, profileTargetKey, type ProfileTarget } from "./orchestration-profiles";

const pending = new WeakMap<Session, { generation: number; targets: Map<string, ProfileTarget>; sources: ProfileSource[] }>();

export function queueModelProfileResearch(session: Session, targets: readonly ProfileTarget[], sources: readonly ProfileSource[] = PROFILE_SOURCES): void {
  const previous = pending.get(session);
  const request = previous?.generation === session.logicalGeneration ? previous
    : { generation: session.logicalGeneration, targets: new Map<string, ProfileTarget>(), sources: [] };
  request.sources = normalizeProfileSources(sources);
  for (const target of targets) request.targets.set(profileTargetKey(target), target);
  pending.set(session, request);
}

export function flushModelProfileResearch(session: Session, enabled: boolean, models: ExternalModels, roster: readonly OrchestrationRow[]): void {
  const request = pending.get(session);
  if (!request) return;
  if (session.closed || session.clearing || session.logicalGeneration !== request.generation) {
    pending.delete(session); // R-LRN-13: never move a request into a replacement conversation.
    return;
  }
  const conversation = session.conversation;
  if (!enabled || !conversation?.learningToolAvailable || conversation.state !== "idle" || conversation.isClosed) return;
  // R-ORC-39: keep queued research until an in-flight refresh can revalidate its resolved IDs.
  if (Object.values(models).some(list => list.state === "checking" || list.state === "ok" && list.refresh === "checking")) return;
  const known = new Set(listedProfileTargets(models, roster).map(profileTargetKey));
  const targets = [...request.targets.values()].filter(target => known.has(profileTargetKey(target)));
  pending.delete(session);
  if (!targets.length) return; // R-LRN-13: validate again immediately before the normal send queue.
  const text = modelProfileResearchInstruction(targets, request.sources);
  conversation.allowResearchModels(targets);
  if (!isNonHumanCommandInput(text)) {
    session.pushEvent({ kind: "user_message", turnId: null, text, sentAt: Date.now() });
  }
  conversation.send(text, undefined, session.lastRecordedEventTimestamp ?? undefined);
}
