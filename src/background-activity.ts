import type { NormalizedEvent } from "./protocol";

export const BACKGROUND_ACTIVITY_LIST_MAX = 256;

export interface BackgroundTaskEntry {
  id: string;
  type: string;
  description: string;
  ambient?: true;
}

export interface DelegationEntry {
  label: string;
  agentId?: string;
  running: boolean;
  background: boolean;
}

export interface BackgroundActivityState {
  tasks: BackgroundTaskEntry[];
  finishedTaskIds: Set<string>;
  lifecycleSeenIds: Set<string>;
  delegations: Map<string, DelegationEntry>;
}

export interface BackgroundActivitySnapshot {
  tasks: BackgroundTaskEntry[];
  finishedTaskIds: string[];
  lifecycleSeenIds: string[];
  delegations: Array<{ toolUseId: string; label: string; agentId?: string; running: boolean; background: boolean }>;
}

export function createBackgroundActivityState(): BackgroundActivityState {
  return { tasks: [], finishedTaskIds: new Set(), lifecycleSeenIds: new Set(), delegations: new Map() };
}

export function emptyBackgroundActivitySnapshot(): BackgroundActivitySnapshot {
  return { tasks: [], finishedTaskIds: [], lifecycleSeenIds: [], delegations: [] };
}

export function backgroundActivitySnapshotOf(state: BackgroundActivityState): BackgroundActivitySnapshot {
  return {
    tasks: state.tasks.map((t) => ({ ...t })),
    finishedTaskIds: [...state.finishedTaskIds],
    lifecycleSeenIds: [...state.lifecycleSeenIds],
    delegations: [...state.delegations.entries()].map(([toolUseId, d]) => ({
      toolUseId,
      label: d.label,
      ...(d.agentId === undefined ? {} : { agentId: d.agentId }),
      running: d.running,
      background: d.background,
    })),
  };
}

export function backgroundActivityFromSnapshot(snap: BackgroundActivitySnapshot): BackgroundActivityState {
  const state = createBackgroundActivityState();
  state.tasks = snap.tasks.map((t) => ({ ...t }));
  for (const id of snap.finishedTaskIds) state.finishedTaskIds.add(id);
  for (const d of snap.delegations) {
    state.delegations.set(d.toolUseId, {
      label: d.label,
      ...(d.agentId === undefined ? {} : { agentId: d.agentId }),
      running: d.running,
      background: d.background,
    });
  }
  const seen = new Set<string>(snap.lifecycleSeenIds);
  for (const t of snap.tasks) seen.add(t.id);
  for (const id of snap.finishedTaskIds) seen.add(id);
  for (const d of snap.delegations) if (d.agentId !== undefined) seen.add(d.agentId);
  state.lifecycleSeenIds = seen;
  enforceCaps(state);
  return state;
}

function clearProcessActivity(state: BackgroundActivityState): boolean {
  const changed = state.delegations.size > 0 || state.tasks.length > 0 || state.finishedTaskIds.size > 0;
  state.delegations.clear();
  state.tasks = [];
  state.finishedTaskIds.clear();
  return changed;
}

function setDelegationRunning(state: BackgroundActivityState, agentId: string, running: boolean): boolean {
  let changed = false;
  for (const d of state.delegations.values()) {
    if (d.agentId === agentId && d.running !== running) {
      d.running = running;
      changed = true;
    }
  }
  return changed;
}

function dropOldest(set: Set<string>): void {
  while (set.size > BACKGROUND_ACTIVITY_LIST_MAX) {
    const first = set.values().next().value as string;
    set.delete(first);
  }
}

function enforceCaps(state: BackgroundActivityState): void {
  if (state.tasks.length > BACKGROUND_ACTIVITY_LIST_MAX) state.tasks = state.tasks.slice(-BACKGROUND_ACTIVITY_LIST_MAX);
  dropOldest(state.finishedTaskIds);
  dropOldest(state.lifecycleSeenIds);
  while (state.delegations.size > BACKGROUND_ACTIVITY_LIST_MAX) {
    let victim: string | undefined;
    for (const [key, d] of state.delegations) {
      if (!d.running) {
        victim = key;
        break;
      }
    }
    state.delegations.delete(victim ?? (state.delegations.keys().next().value as string));
  }
}

export function applyActivityEvent(state: BackgroundActivityState, ev: NormalizedEvent): boolean {
  let changed = false;
  switch (ev.kind) {
    case "background_tasks":
      state.tasks = ev.tasks.filter((t) => !t.ambient);
      for (const id of state.finishedTaskIds) if (!ev.tasks.some((t) => t.id === id)) state.finishedTaskIds.delete(id);
      changed = true;
      break;
    case "tool_call_started":
      if (
        ev.provenance?.path !== "history" &&
        ev.work?.placement !== undefined &&
        ev.work.agents?.some((agent) => agent.toolUseId === ev.toolUseId) === true
      ) {
        state.delegations.set(ev.toolUseId, {
          label: ev.inputSummary ?? ev.toolName,
          running: true,
          background: ev.isBackground === true,
        });
        changed = true;
      }
      break;
    case "tool_call_finished": {
      const d = state.delegations.get(ev.toolUseId);
      if (d !== undefined) {
        if (ev.asyncLaunchedAgentId !== undefined && !ev.isError) {
          d.agentId = ev.asyncLaunchedAgentId;
          changed = true;
        } else {
          changed = d.running;
          d.running = false;
        }
      }
      if (ev.taskNotification !== undefined) {
        const id = ev.taskNotification.agentId;
        changed = setDelegationRunning(state, id, false) || changed;
        if (!state.finishedTaskIds.has(id)) {
          state.finishedTaskIds.add(id);
          changed = true;
        }
        state.lifecycleSeenIds.add(id);
      }
      if (ev.resumedAgentId !== undefined && !ev.isError) {
        changed = setDelegationRunning(state, ev.resumedAgentId, true) || changed;
        if (state.finishedTaskIds.delete(ev.resumedAgentId)) changed = true;
        state.lifecycleSeenIds.add(ev.resumedAgentId);
      }
      break;
    }
    case "turn_interrupted":
    case "turn_failed":
      changed = state.delegations.size > 0;
      state.delegations.clear();
      break;
    case "conversation_closed":
    case "conversation_opened":
      changed = clearProcessActivity(state);
      break;
  }
  for (const toolUseId of ev.work?.staled ?? []) {
    const delegation = state.delegations.get(toolUseId);
    if (delegation?.running) {
      delegation.running = false;
      changed = true;
    }
  }
  enforceCaps(state);
  return changed;
}

export function notePastLifecycle(
  state: BackgroundActivityState,
  events: readonly NormalizedEvent[],
  alreadyRendered: (ev: NormalizedEvent) => boolean
): boolean {
  let changed = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== "tool_call_finished" || alreadyRendered(ev)) continue;
    if (ev.resumedAgentId !== undefined && !ev.isError) state.lifecycleSeenIds.add(ev.resumedAgentId);
    const done = ev.taskNotification?.agentId;
    if (done === undefined || state.lifecycleSeenIds.has(done)) continue;
    state.lifecycleSeenIds.add(done);
    if (!state.finishedTaskIds.has(done)) {
      state.finishedTaskIds.add(done);
      changed = true;
    }
  }
  enforceCaps(state);
  return changed;
}

export function liveBackgroundTasks(state: BackgroundActivityState): BackgroundTaskEntry[] {
  return state.tasks.filter((t) => !t.ambient && !state.finishedTaskIds.has(t.id));
}

export function hasRunningDelegation(state: BackgroundActivityState): boolean {
  for (const d of state.delegations.values()) if (d.running) return true;
  return false;
}

export function runningDelegationIds(state: BackgroundActivityState): string[] {
  const ids: string[] = [];
  for (const [toolUseId, d] of state.delegations) if (d.running) ids.push(toolUseId);
  return ids;
}
