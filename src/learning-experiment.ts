import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { textHash } from "./learning";
import type { LearningLedger } from "./learning-ledger";
import type { LearningSwitches } from "./learning-delivery";
import type { ExperimentAssignmentRecord } from "./learning-episodes";

export const EXPERIMENT_VERSION = 1;
export const EXPERIMENT_HOLDOUT_PERCENT = 20;
export const EXPERIMENT_MIN_ELIGIBLE_CONVERSATIONS_PER_ARM = 100;
export const EXPERIMENT_MIN_RELEVANT_OPPORTUNITIES_PER_ARM = 200;
export const EXPERIMENT_CONFIDENCE_LEVEL = 0.95;
export const EXPERIMENT_MIN_DAYS = 14;
export const EXPERIMENT_WINDOW_MS = EXPERIMENT_MIN_DAYS * 86400000;
export const EXPERIMENT_BOOTSTRAP_SAMPLES = 2000;
const queues = new Map<string, Promise<unknown>>();

export function assignLearningExperiment(ledger: LearningLedger, conversation: string, switches: LearningSwitches, candidates: readonly string[],
  detectorVersion: number, dedicated = false, holdout = EXPERIMENT_HOLDOUT_PERCENT, draw = () => randomInt(1000000) / 1000000): Promise<ExperimentAssignmentRecord | undefined> {
  const key = resolve(ledger.directory).toLowerCase();
  const action = (queues.get(key) ?? Promise.resolve()).then(async () => {
    if (!Number.isFinite(holdout) || holdout < 0 || holdout >= 100) throw new Error("invalid learning holdout percentage");
    await ledger.reload();
    const state = ledger.state;
    if (!ledger.consistent || ledger.skipped || state.unavailableConversations.has(conversation)) return undefined;
    const prior = state.assignments.get(conversation);
    if (prior) return prior;
    const reason = dedicated ? "dedicated" : !switches.enabled ? "learning-off" : !switches.experiment || holdout === 0 ? "experiment-off"
      : !switches.automaticAdoption && !switches.observationDelivery ? "paths-off" : "eligible";
    const eligible = reason === "eligible", probability = eligible ? holdout / 100 : 0;
    const record: ExperimentAssignmentRecord = { kind: "experiment-assignment", v: 2, at: new Date().toISOString(),
      opId: textHash(`assignment:${conversation}`), conversation, eligible, reason, candidates: [...new Set(candidates)].sort(),
      experimentVersion: EXPERIMENT_VERSION, detectorVersion, probability, switches: { ...switches }, arm: eligible && draw() < probability ? "holdout" : "delivery" };
    await ledger.append(record);
    return ledger.state.assignments.get(conversation);
  });
  queues.set(key, action.catch(() => undefined));
  return action;
}
