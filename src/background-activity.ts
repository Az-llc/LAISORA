import type { NormalizedEvent } from "./protocol";

// R-SES-02: 各配列の上限。protocol.ts#isBackgroundActivitySnapshot が同じ値で拒否するので、fold 側で必ず収める
// （超えた snapshot は init ごと捨てられ、全タブが空になる）
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

// タブの点灯・帯の背景側の材料。webview の Tab と Host の foldEventState が同じ規則でこれを畳む。
// work-model の backgroundTasks 索引・EventFoldDraft.liveDelegationAgentIds とは閉じ方が違う別系統
export interface BackgroundActivityState {
  // 最後の background_tasks（レベル信号）から ambient を除いた集合。差分を取らず丸ごと置き換える（sdk.d.ts）
  tasks: BackgroundTaskEntry[];
  // task_notification を観測した task id。CLI の集合は完了後も残ることがあり、そのまま数えると件数が嘘になる
  finishedTaskIds: Set<string>;
  // 完了か再開を既に観測した task id。遡りの古い完了は、これより新しい観測が無い id にだけ効かせる
  lifecycleSeenIds: Set<string>;
  // key = 委任の toolUseId。ターン境界で消さない: background 委任は turn_completed の後も動き続ける（R-SES-02）。
  // 回収は turn_interrupted / turn_failed / conversation_closed / conversation_opened だけ
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

// snapshot の値は Host がログ全体を畳んだ現在値。置き換えた id を全て観測済みにしないと、
// 後から遡りで届く古い完了が現在の点灯を覆す（R-SES-02。CH-S1c と同じ規則）
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

// 戻り値は点灯・帯の材料が変わったか（background_tasks は常に true）
export function applyActivityEvent(state: BackgroundActivityState, ev: NormalizedEvent): boolean {
  let changed = false;
  switch (ev.kind) {
    case "background_tasks":
      state.tasks = ev.tasks.filter((t) => !t.ambient);
      for (const id of state.finishedTaskIds) if (!ev.tasks.some((t) => t.id === id)) state.finishedTaskIds.delete(id);
      changed = true;
      break;
    case "tool_call_started":
      // 開始点はここだけ。どれが委任かは reducer の判定（ev.work.agents）に従うので、Host は ev.work を載せた後に畳む
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
      // 裁定A2: 起動 ACK は完了ではない。background 委任を閉じるのは task-notification だけ。
      // 裁定A1: SendMessage の resumedAgentId は同じ委任が再び動き出した観測
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
      // query ごと落ちるので委任も残らない
      changed = state.delegations.size > 0;
      state.delegations.clear();
      break;
    case "conversation_closed":
    case "conversation_opened":
      // 信号源のプロセスが消えた／入れ替わった。集合はレベル信号でしか訂正されないので、ここで消さないと固着する。
      // 中断の打ち切り経路は conversation_closed を出さずに次のプロセスを起こすので、conversation_opened でも消す
      changed = clearProcessActivity(state);
      break;
  }
  enforceCaps(state);
  return changed;
}

// chunk は live より古く、chunk 同士は新しい側から届く。chunk 内は時系列順なので末尾から走査し、
// id ごとに最も新しい完了/再開だけを採る
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

// Agent の非同期起動は 🤖、Bash の run_in_background は 🔄。同じ印にすると区別できない
export function isAgentBackgroundTask(t: { type: string }): boolean {
  return /agent/i.test(t.type);
}

export function hasRunningDelegation(state: BackgroundActivityState): boolean {
  for (const d of state.delegations.values()) if (d.running) return true;
  return false;
}

export function hasRunningDelegationFor(state: BackgroundActivityState, agentId: string): boolean {
  for (const d of state.delegations.values()) if (d.running && d.agentId === agentId) return true;
  return false;
}

// 起動が窓の外にある Agent の背景タスクは delegations に無い。種別だけで除くと帯に何も出ない。
// 集合は起動 ACK より先に届き、ACK までは agentId で突き合わせられないので、未解決の背景委任の数だけ新しい側を除く
export function orphanAgentTasks(state: BackgroundActivityState, turnIdle: boolean): BackgroundTaskEntry[] {
  const unmatched = liveBackgroundTasks(state).filter(
    (t) => isAgentBackgroundTask(t) && !hasRunningDelegationFor(state, t.id)
  );
  // ACK は起動と同じターン内に届く。ターン外まで数えると、ACK を失った委任が実在の孤児を隠し続ける
  let pending = 0;
  if (!turnIdle) for (const d of state.delegations.values()) if (d.running && d.background && d.agentId === undefined) pending++;
  return unmatched.slice(0, Math.max(0, unmatched.length - pending));
}
