import { agentRunStart, externalRunEndStatus, workEndStatus, type OrchestrationView, type PlanContext, type WorkAgentNode, type WorkEndStatus, type WorkModelPayload } from "../protocol";
import { isExternalRunTool } from "../orchestration-executors";
import { isSubagentWaitTool } from "../time-buckets";
import { deriveEarlierPlanViews, derivePlanView, planBarFacts } from "./plan-view";
import { toolIntentLabel } from "./status-line";
import { isDeclaredAsk, openYouItems, type YouItem } from "./you-items";
import type { StageActorFactPort, StageActorStatusPort, StageFactsPort } from "./work-stage-port";
import { stageRole } from "./work-stage-strings";

export const STAGE_COMMAND_MIN_MS = 10_000;

const COMMAND_KIND = "command";

export interface StageSource {
  readonly model: WorkModelPayload | undefined;
  readonly orchestration: OrchestrationView | undefined;
  readonly youItems: readonly YouItem[];
  readonly turnActive: boolean;
}

export interface StageFactsInput extends StageSource {
  readonly tabId: string;
  readonly revision: number;
  readonly nowMs: number;
  readonly shownCommandIds: ReadonlySet<string>;
}

const ACTOR_STATUS: Readonly<Record<WorkEndStatus, StageActorStatusPort>> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  stale: "lost",
  unknown: "lost",
};

function lowerRole(role: string | undefined): { role?: string } {
  return role === undefined ? {} : { role: stageRole(role) };
}

function ageOf(nowMs: number, at: number | undefined): { ageMs?: number } {
  return at === undefined ? {} : { ageMs: nowMs - at };
}

function mainToolOf(model: WorkModelPayload | undefined): StageFactsPort["mainTool"] {
  let last: NonNullable<WorkModelPayload["runningMainTools"]>[number] | undefined;
  for (const tool of model?.runningMainTools ?? []) {
    if (isSubagentWaitTool(tool.name) || isExternalRunTool(tool.name)) continue;
    if (last === undefined || tool.startedAt >= last.startedAt) last = tool;
  }
  return last === undefined ? undefined : { label: toolIntentLabel(last.name, last.intentInput) };
}

function agentActors(model: WorkModelPayload | undefined, nowMs: number, actors: StageActorFactPort[], seen: Set<string>): void {
  const idOf = (node: WorkAgentNode): string => node.toolUseId !== "" ? node.toolUseId : node.agentId;
  const visit = (node: WorkAgentNode, parentId: string | undefined): void => {
    const id = idOf(node);
    if (!seen.has(id)) {
      seen.add(id);
      const status = workEndStatus(node);
      actors.push({
        id, run: node.earlierRuns?.length ?? 0, kind: "agent", ...lowerRole(node.role ?? node.agentType), label: node.description,
        ...(parentId === undefined ? {} : { parentId }), status: ACTOR_STATUS[status],
        ...ageOf(nowMs, status === "running" ? agentRunStart(node) : node.endedAt),
      });
    }
    for (const child of node.children) visit(child, id);
  };
  for (const phase of model?.phases ?? []) for (const agent of phase.agents) visit(agent, undefined);
  for (const agent of model?.unlinkedAgents ?? []) visit(agent, undefined);
}

function externalActors(model: WorkModelPayload | undefined, nowMs: number, actors: StageActorFactPort[], seen: Set<string>): void {
  const contexts: PlanContext[] = [...model?.planContext ? [model.planContext] : [], ...model?.earlierPlans ?? []];
  const push = (id: string, role: string, label: string, run: { running: boolean; outcome: Parameters<typeof externalRunEndStatus>[0]["outcome"]; startedAt: number | null; durationMs: number | null }): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const status = externalRunEndStatus(run);
    const endedAt = run.startedAt !== null && run.durationMs !== null ? run.startedAt + run.durationMs : undefined;
    actors.push({
      id, run: 0, kind: "external", ...lowerRole(role), label, status: ACTOR_STATUS[status],
      ...ageOf(nowMs, status === "running" ? run.startedAt ?? undefined : endedAt),
    });
  };
  for (const context of contexts) {
    for (const [index, run] of (context.externalRuns ?? []).entries()) {
      push(run.toolUseId ?? `external:${context.blockId}:${index}`, run.role, run.title, run);
    }
  }
  for (const entry of model?.externalRuns ?? []) {
    if (entry.run.toolUseId === undefined) continue;
    push(entry.run.toolUseId, entry.label, entry.label, entry.run);
  }
}

function commandActors(model: WorkModelPayload | undefined, nowMs: number, shown: ReadonlySet<string>, actors: StageActorFactPort[], seen: Set<string>): void {
  for (const command of model?.backgroundCommands ?? []) {
    if (seen.has(command.id)) continue;
    if (!shown.has(command.id) && (command.endedAt ?? nowMs) - command.startedAt < STAGE_COMMAND_MIN_MS) continue;
    seen.add(command.id);
    actors.push({
      id: command.id, run: 0, kind: COMMAND_KIND, ...lowerRole(COMMAND_KIND), label: command.description, status: ACTOR_STATUS[command.status],
      ageMs: nowMs - (command.endedAt ?? command.startedAt + STAGE_COMMAND_MIN_MS),
    });
  }
}

export function sentCommandIds(facts: StageFactsPort | null, sourceId: string): Set<string> {
  if (facts?.sourceId !== sourceId) return new Set();
  return new Set(facts.actors.filter(actor => actor.kind === COMMAND_KIND).map(actor => actor.id));
}

export function stageFactsOf(input: StageFactsInput): StageFactsPort {
  const { model, orchestration, nowMs } = input;
  const bar = planBarFacts(derivePlanView(model, orchestration, nowMs), deriveEarlierPlanViews(model, orchestration, nowMs));
  const actors: StageActorFactPort[] = [];
  const seen = new Set<string>();
  agentActors(model, nowMs, actors, seen);
  externalActors(model, nowMs, actors, seen);
  commandActors(model, nowMs, input.shownCommandIds, actors, seen);
  const mainTool = mainToolOf(model);
  return {
    sourceId: input.tabId,
    revision: input.revision,
    turnActive: input.turnActive,
    ...(mainTool === undefined ? {} : { mainTool }),
    ...(bar.current !== undefined && bar.count !== undefined
      ? { step: { number: bar.number, title: bar.title, index: bar.count.position, total: bar.count.total, done: bar.count.done } }
      : {}),
    actors,
    waits: openYouItems(input.youItems, nowMs).map(item => ({ id: item.id, kind: item.kind, blocking: !isDeclaredAsk(item) })),
  };
}

export function sameStageFacts(a: StageFactsPort, b: StageFactsPort): boolean {
  const comparable = (facts: StageFactsPort): string =>
    JSON.stringify({ ...facts, revision: 0, actors: facts.actors.map(actor => ({ ...actor, ageMs: undefined })) });
  return comparable(a) === comparable(b);
}
