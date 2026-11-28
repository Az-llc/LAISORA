import type { WorkStageMountCast } from "../work-stage-cast";

export type StageActorStatusPort = "running" | "completed" | "failed" | "stopped" | "lost";
export type StageWaitKindPort = "approve" | "decide" | "check";

export interface StageActorFactPort {
  id: string;
  run: number;
  kind: "agent" | "external" | "command";
  role?: string;
  castKey?: string;
  label: string;
  parentId?: string;
  status: StageActorStatusPort;
  activity?: "thinking" | "tool";
  ageMs?: number;
}

export interface StageStepPort {
  number: string;
  title: string;
  index: number;
  total: number;
  done: number;
}

export interface StageFactsPort {
  sourceId: string;
  revision: number;
  turnActive: boolean;
  mainTool?: { label: string };
  step?: StageStepPort;
  actors: StageActorFactPort[];
  waits: { id: string; kind: StageWaitKindPort; blocking: boolean }[];
}

export interface StageTextPort {
  wait: Record<StageWaitKindPort, string>;
  workerName: string;
  conductorName: string;
  conductorRole: string;
  placeholderMark: string;
  failed: string;
  overflowTitle: string;
  running: (n: number) => string;
  noneRunning: string;
  waitingYou: string;
  stepDone: (n: number) => string;
  you: string;
  stage: string;
}

export interface StageOptionsPort extends Partial<WorkStageMountCast> {
  manifest: unknown;
  assetsBase: string;
  locale?: string;
  text: StageTextPort;
}

export interface StageHandlePort {
  setFacts(facts: StageFactsPort): void;
  dispose(): void;
}

export interface StageModulePort {
  mountStage(container: HTMLElement, options: StageOptionsPort): StageHandlePort;
}
