// 経過時間の 4 区分（LLM 生成 / ツール実行 / LLM の確認待ち / 返信待ち）と依頼ブロックの算出。
// 入力は L1.5 の NormalizedEvent 列（history / live 共通）。evidenceHash / semanticHash の入力には
// 入れない（hash 射影は evidence-index.ts の hashProjection と semantic-model.ts の入力列で列挙式）。
import type { NormalizedEvent } from "./protocol";
import { redactAbsolutePaths } from "./path-redaction";
import { isPureCommandWrapper } from "./human-input-vocabulary";
import * as l10n from "@vscode/l10n";

export type TimeBucket = "generate" | "tool" | "confirm" | "reply";
export type TimeLane = "main" | "sub";
export type TimeFidelity = "record" | "inherited";

// 人の入力を待つツール。区間が「ツール実行」ではなく「LLM の確認待ち」になる。
// AskUserQuestion だけにする（ExitPlanMode の待ちは実測で無視できる短さ）。
export const HUMAN_INPUT_WAIT_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion"]);
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);
export const MAX_TIME_TOOL_INTERVALS = 8192;
export const MAX_TIME_BLOCKS = 500;
export const MAX_BLOCK_TEXT = 600;
export const MAX_MODEL_MARKS = 4096;
export const MAIN_MODEL_TOP_COUNT = 3;
const TASK_NOTIFICATION_MARKER = "A task-notification fires each time this agent stops";

export function isRequestMessageText(text: string): boolean {
  return !isPureCommandWrapper(text) && !text.includes(TASK_NOTIFICATION_MARKER);
}

export interface TurnSpan {
  turnId: string;
  start: number;
  end: number;
}

// メインの応答記録 1 件の観測。at はその記録の時刻、model はその応答を出した model
export interface ModelMark {
  at: number;
  model: string;
}

// sameTurn: 直前の地点と同じターン。同じターンで同じ model が続く地点は最後の 1 つだけ残しても割り当ては変わらない。
// ターンをまたいで畳むと前のターンの地点が消えて unknown に落ちる。
// 上限超過は古い側を捨てる。捨てた地点より前のターンは直前の model を持たず unknown に落ちる（R-DSP-01）
export function pushModelMark(marks: ModelMark[], at: number, model: string, sameTurn = false): ModelMark[] {
  const last = marks[marks.length - 1];
  if (sameTurn && last !== undefined && last.model === model && at >= last.at) {
    last.at = at;
    return marks;
  }
  marks.push({ at, model });
  return marks.length > MAX_MODEL_MARKS ? marks.slice(marks.length - MAX_MODEL_MARKS) : marks;
}

export interface ToolInterval {
  toolUseId: string;
  toolName: string;
  start: number;
  end: number;
  isError: boolean;
  turnId: string;
  // lane==="sub" のときの委任 toolUseId（parentToolUseId）
  agentId?: string;
}

export interface DelegationSpan {
  toolUseId: string;
  turnId: string;
  startedAt: number;
  // 親側の tool_call_finished。foreground は子の終了、background は起動 ACK（実測: 親 7 秒 / 子 19〜29 分）
  ackEndedAt?: number;
  // 裁定A2: async（background）委任の完了は task-notification でのみ確定する。起動 ACK・子ツール
  // 終端では閉じない。resume（裁定A1: SendMessage 成功の resumedAgentId）で undefined へ戻り再び open
  notifiedEndedAt?: number;
  isBackground: boolean;
  firstChildAt?: number;
  lastChildAt?: number;
  transcriptAgentId?: string;
  description: string;
  subagentType?: string;
  model?: string;
}

// 背景 Bash（run_in_background）。委任ではないので DelegationSpan と分ける（メイン棒の計算は
// 「委任でないツールの和集合」で、混ぜると過小になる）。開始は tool_call_started、id は ACK、
// 終端は task_notification。ACK までの区間は mainTools 側に同期実行として残る
export interface BackgroundTaskSpan {
  toolUseId: string;
  turnId: string;
  startedAt: number;
  ackAt: number;
  taskId: string;
  description: string;
  notifiedEndedAt?: number;
  // 終端イベント（query の終端で CLI が kill）または pendingStale の確定
  staleAt?: number;
  // background_tasks の集合から消えたが通知は未着。次の turn_started で staleAt になる
  pendingStale?: true;
}

export interface BackgroundTaskSpanView {
  toolUseId: string;
  taskId: string;
  turnId: string;
  blockId?: string;
  description: string;
  start: number;
  end: number;
  open: boolean;
  endSource: "notification" | "stale" | "open";
}

export type RequestBlockKind = "say" | "command" | "interrupt";

export interface RequestBlockRecord {
  blockId: string;
  kind: RequestBlockKind;
  text: string;
  start: number;
  turnId: string | null;
}

export interface TimeBucketState {
  fidelity: TimeFidelity;
  inheritedBoundaryCount: number;
  firstAt?: number;
  lastAt?: number;
  turnSpans: TurnSpan[];
  openTurn?: { turnId: string; startedAt: number };
  openTools: Record<string, { at: number; toolName: string; lane: TimeLane; parentToolUseId: string | null; turnId: string; description?: string }>;
  mainTools: ToolInterval[];
  subTools: ToolInterval[];
  delegations: Record<string, DelegationSpan>;
  delegationOrder: string[];
  backgroundTasks: Record<string, BackgroundTaskSpan>;
  backgroundTaskOrder: string[];
  blocks: RequestBlockRecord[];
  droppedIntervalCount: number;
  droppedBlockCount: number;
}

export function createTimeBucketState(): TimeBucketState {
  return {
    fidelity: "record",
    inheritedBoundaryCount: 0,
    turnSpans: [],
    openTools: {},
    mainTools: [],
    subTools: [],
    delegations: {},
    delegationOrder: [],
    backgroundTasks: {},
    backgroundTaskOrder: [],
    blocks: [],
    droppedIntervalCount: 0,
    droppedBlockCount: 0,
  };
}

function isWindowKind(kind: string): boolean {
  return kind.startsWith("tool_call_") || kind === "user_message" || kind.startsWith("turn_");
}

function pushBounded(list: ToolInterval[], item: ToolInterval, state: { droppedIntervalCount: number }): ToolInterval[] {
  const next = [...list, item];
  if (next.length > MAX_TIME_TOOL_INTERVALS) {
    state.droppedIntervalCount += next.length - MAX_TIME_TOOL_INTERVALS;
    return next.slice(next.length - MAX_TIME_TOOL_INTERVALS);
  }
  return next;
}

function withoutPendingStale(span: BackgroundTaskSpan): BackgroundTaskSpan {
  const { pendingStale: _p, ...rest } = span;
  return rest;
}

// 開いている背景のうち pick が真のものを staleAt で閉じる。n は touch() 済みの次状態
function staleOpenBackground(
  state: TimeBucketState,
  n: TimeBucketState,
  ts: number,
  pick: (span: BackgroundTaskSpan) => boolean
): TimeBucketState {
  let changed = false;
  const next = { ...n.backgroundTasks };
  for (const [toolUseId, span] of Object.entries(state.backgroundTasks)) {
    if (span.notifiedEndedAt !== undefined || span.staleAt !== undefined || !pick(span)) continue;
    next[toolUseId] = { ...withoutPendingStale(span), staleAt: ts };
    changed = true;
  }
  if (changed) n.backgroundTasks = next;
  return n;
}

export function foldTimeBuckets(state: TimeBucketState, event: NormalizedEvent): TimeBucketState {
  const ts = typeof event.timestamp === "number" && event.timestamp > 0 ? event.timestamp : undefined;
  let next: TimeBucketState = state;
  const touch = (): TimeBucketState => (next === state ? (next = { ...state }) : next);
  if (ts !== undefined && isWindowKind(event.kind)) {
    if (state.firstAt === undefined || ts < state.firstAt) touch().firstAt = ts;
    if (state.lastAt === undefined || ts > state.lastAt) touch().lastAt = ts;
  }

  switch (event.kind) {
    case "background_tasks": {
      // REPLACE のレベル信号。追跡中が集合に無ければ pendingStale、戻れば取り消す。
      // 即 stale にしない（CLI は通知の 1ms 前に空集合を送る）
      const alive = new Set(event.tasks.filter((t) => t.ambient !== true).map((t) => t.id));
      let n0: TimeBucketState | undefined;
      for (const [toolUseId, span] of Object.entries(state.backgroundTasks)) {
        if (span.notifiedEndedAt !== undefined || span.staleAt !== undefined) continue;
        const gone = !alive.has(span.taskId);
        if (gone === (span.pendingStale === true)) continue;
        n0 ??= touch();
        n0.backgroundTasks = { ...n0.backgroundTasks, [toolUseId]: gone ? { ...span, pendingStale: true } : withoutPendingStale(span) };
      }
      return n0 ?? next;
    }
    case "turn_started": {
      if (ts !== undefined) {
        // pendingStale の確定。集合から消えたまま通知が来ずにターン境界へ来た
        state = staleOpenBackground(state, touch(), ts, (span) => span.pendingStale === true);
      }
      const n = touch();
      // 境界イベントが継承時刻なら 4 区分の根拠を失う。継承値かどうかの印は NormalizedEvent に無く、
      // live の user_message は provenance を持たないため turn_started の provenance で粗く立てる（R-DSP-15）
      if (event.provenance?.path !== "history") {
        n.inheritedBoundaryCount = state.inheritedBoundaryCount + 1;
        n.fidelity = "inherited";
      }
      if (ts === undefined) return n;
      if (state.openTurn !== undefined) {
        n.turnSpans = [...state.turnSpans, { turnId: state.openTurn.turnId, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, ts) }];
      }
      n.openTurn = { turnId: event.turnId, startedAt: ts };
      return n;
    }
    case "conversation_closed": {
      if (ts === undefined) return next;
      return staleOpenBackground(state, touch(), ts, () => true);
    }
    case "turn_completed":
    case "turn_interrupted":
    case "turn_failed": {
      if (ts !== undefined && event.kind !== "turn_completed") {
        // query の終端。CLI が背景を kill する。turn_completed は継続中なので触らない
        state = staleOpenBackground(state, touch(), ts, () => true);
      }
      if (state.openTurn === undefined || ts === undefined) return next;
      const n = touch();
      n.turnSpans = [...state.turnSpans, { turnId: state.openTurn.turnId, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, ts) }];
      n.openTurn = undefined;
      return n;
    }
    case "user_message": {
      // 引数無しのスラッシュコマンドは往復に数えない。history 経路では同じ入力が user_message を生まないので、
      // live との差はここで吸収する
      // バックグラウンド委任の完了通知を往復にしない。user 記録だが人の発言ではない（R-DSP-10）
      if (!isRequestMessageText(event.text)) return next;
      if (ts === undefined) return next;
      const n = touch();
      const text = redactAbsolutePaths(event.text.trim()).slice(0, MAX_BLOCK_TEXT);
      const block: RequestBlockRecord = {
        blockId: `block:${state.blocks.length + state.droppedBlockCount + 1}`,
        kind: "say",
        text,
        start: ts,
        turnId: event.turnId ?? state.openTurn?.turnId ?? null,
      };
      let blocks = [...state.blocks, block];
      if (blocks.length > MAX_TIME_BLOCKS) {
        n.droppedBlockCount = state.droppedBlockCount + (blocks.length - MAX_TIME_BLOCKS);
        blocks = blocks.slice(blocks.length - MAX_TIME_BLOCKS);
      }
      n.blocks = blocks;
      return n;
    }
    case "tool_call_started": {
      if (ts === undefined) return next;
      const n = touch();
      const lane: TimeLane = event.parentToolUseId === null ? "main" : "sub";
      n.openTools = {
        ...state.openTools,
        [event.toolUseId]: {
          at: ts,
          toolName: event.toolName,
          lane,
          parentToolUseId: event.parentToolUseId,
          turnId: event.turnId,
          ...(event.inputSummary !== undefined ? { description: redactAbsolutePaths(event.inputSummary).slice(0, 200) } : {}),
        },
      };
      if (lane === "main" && DELEGATION_TOOL_NAMES.has(event.toolName) && state.delegations[event.toolUseId] === undefined) {
        n.delegations = {
          ...state.delegations,
          [event.toolUseId]: {
            toolUseId: event.toolUseId,
            turnId: event.turnId,
            startedAt: ts,
            isBackground: event.isBackground === true || event.delegation?.isBackground === true,
            description: redactAbsolutePaths(event.delegation?.description ?? "").slice(0, 200),
            subagentType: event.delegation?.subagentType ?? event.subagentType,
            model: event.delegation?.subagentModel ?? event.subagentModel,
          },
        };
        n.delegationOrder = [...state.delegationOrder, event.toolUseId];
      } else if (lane === "sub" && event.parentToolUseId !== null) {
        const d = state.delegations[event.parentToolUseId];
        if (d !== undefined) {
          n.delegations = {
            ...state.delegations,
            [d.toolUseId]: {
              ...d,
              firstChildAt: d.firstChildAt === undefined ? ts : Math.min(d.firstChildAt, ts),
              lastChildAt: d.lastChildAt === undefined ? ts : Math.max(d.lastChildAt, ts),
            },
          };
        }
      }
      return n;
    }
    case "tool_call_finished": {
      // 裁定A2/A1 の観測は openTools と独立に届く（taskNotification の toolUseId は合成 ID で、
      // 対応する tool_call_started が無い）ため、openTools の guard より前に処理する
      if (ts !== undefined && event.taskNotification !== undefined) {
        const agentId = event.taskNotification.agentId;
        const n0 = touch();
        // 同一 agentId は複数回通知されうるため、開いている（未通知の）委任だけを閉じる
        const hit = Object.values(n0.delegations).find(
          (d) => d.transcriptAgentId === agentId && d.notifiedEndedAt === undefined
        );
        if (hit !== undefined) {
          n0.delegations = { ...n0.delegations, [hit.toolUseId]: { ...hit, notifiedEndedAt: ts } };
        }
      }
      if (ts !== undefined && event.taskNotification !== undefined) {
        const agentId = event.taskNotification.agentId;
        const n0 = touch();
        const bg = Object.values(n0.backgroundTasks).find(
          (b) => b.taskId === agentId && b.notifiedEndedAt === undefined && b.staleAt === undefined
        );
        if (bg !== undefined) {
          n0.backgroundTasks = { ...n0.backgroundTasks, [bg.toolUseId]: { ...withoutPendingStale(bg), notifiedEndedAt: ts } };
        }
      }
      if (ts !== undefined && event.resumedAgentId !== undefined && event.isError !== true) {
        const n0 = touch();
        const hit = Object.values(n0.delegations).find(
          (d) => d.transcriptAgentId === event.resumedAgentId && d.notifiedEndedAt !== undefined
        );
        if (hit !== undefined) {
          n0.delegations = { ...n0.delegations, [hit.toolUseId]: { ...hit, notifiedEndedAt: undefined } };
        }
      }
      const open = state.openTools[event.toolUseId];
      if (open === undefined || ts === undefined) return next;
      const n = touch();
      const { [event.toolUseId]: _, ...rest } = state.openTools;
      n.openTools = rest;
      // 背景 Bash の起動 ACK。ACK までは同期区間として mainTools に残し、ここから先は別配列で追う
      if (open.lane === "main" && event.backgroundTaskId !== undefined && event.isError !== true && n.backgroundTasks[event.toolUseId] === undefined) {
        n.backgroundTasks = {
          ...n.backgroundTasks,
          [event.toolUseId]: {
            toolUseId: event.toolUseId,
            turnId: open.turnId,
            startedAt: open.at,
            ackAt: ts,
            taskId: event.backgroundTaskId,
            description: open.description ?? open.toolName,
          },
        };
        n.backgroundTaskOrder = [...n.backgroundTaskOrder, event.toolUseId];
      }
      const interval: ToolInterval = {
        toolUseId: event.toolUseId,
        toolName: open.toolName,
        start: open.at,
        end: Math.max(open.at, ts),
        isError: event.isError === true,
        turnId: open.turnId,
        ...(open.parentToolUseId !== null ? { agentId: open.parentToolUseId } : {}),
      };
      if (open.lane === "main") n.mainTools = pushBounded(state.mainTools, interval, n);
      else n.subTools = pushBounded(state.subTools, interval, n);
      const parentKey = open.lane === "main" ? event.toolUseId : open.parentToolUseId;
      const d = parentKey !== null ? (n.delegations[parentKey] ?? state.delegations[parentKey]) : undefined;
      if (d !== undefined) {
        const updated: DelegationSpan = { ...d };
        if (open.lane === "main") {
          updated.ackEndedAt = interval.end;
          if (event.asyncLaunchedAgentId !== undefined) {
            updated.transcriptAgentId = event.asyncLaunchedAgentId;
            // run_in_background が入力に無い background 委任（ハーネス既定が background の版。
            // 実測: 会話 e0fff61a の 34 委任すべてで入力にフラグ無し）は起動入力から判定できない。
            // ACK が async 起動を告げた事実（asyncLaunchedAgentId）で background と確定する。
            // これが無いと ACK（数秒）で閉じて並列数と棒が壊れる（TB-21）
            updated.isBackground = true;
          }
        } else {
          updated.lastChildAt = d.lastChildAt === undefined ? interval.end : Math.max(d.lastChildAt, interval.end);
        }
        n.delegations = { ...(n.delegations === state.delegations ? state.delegations : n.delegations), [d.toolUseId]: updated };
      }
      return n;
    }
    case "subagent_info": {
      const d = state.delegations[event.toolUseId];
      if (d === undefined || (event.model === undefined || d.model === event.model) &&
        (event.agentId === undefined || d.transcriptAgentId === event.agentId)) return next;
      const n = touch();
      n.delegations = { ...state.delegations, [event.toolUseId]: { ...d,
        model: event.model ?? d.model, transcriptAgentId: event.agentId ?? d.transcriptAgentId } };
      return n;
    }
    default:
      return next;
  }
}

// ---------- 区間集合の演算（閉区間の配列。結果は昇順・非重複） ----------

export type Span = [number, number];

export function unionSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s[1] > s[0]).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s[0] <= last[1]) {
      if (s[1] > last[1]) last[1] = s[1];
    } else {
      out.push([s[0], s[1]]);
    }
  }
  return out;
}

export function intersectSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (end > start) out.push([start, end]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

export function subtractSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  const bs = unionSpans(b);
  for (const [s0, s1] of unionSpans(a)) {
    let cursor = s0;
    for (const [b0, b1] of bs) {
      if (b1 <= cursor) continue;
      if (b0 >= s1) break;
      if (b0 > cursor) out.push([cursor, Math.min(b0, s1)]);
      cursor = Math.max(cursor, b1);
      if (cursor >= s1) break;
    }
    if (cursor < s1) out.push([cursor, s1]);
  }
  return out;
}

export function measureSpans(spans: readonly Span[]): number {
  let total = 0;
  for (const [s0, s1] of spans) total += Math.max(0, s1 - s0);
  return total;
}

// ---------- 導出 ----------

export interface TimeBucketTotals {
  // null = 実測できていない区分。0 と書くと「無かった」を主張する（R-DSP-01）
  generateMs: number | null;
  toolMs: number;
  confirmMs: number;
  replyMs: number | null;
  // サブエージェントだけが稼働していた時間（メインのターン・ツール外で、返信待ちではない）。
  // generate + tool + confirm + reply + subOnly = span
  subOnlyMs: number | null;
  // null = 最初の境界が継承時刻で、経過の起点が測れていない（R-DSP-11）
  spanMs: number | null;
}

export interface TimeBucketInterval {
  bucket: TimeBucket;
  lane: TimeLane;
  start: number;
  end: number;
  turnId?: string;
  agentId?: string;
  backgroundOverlapMs?: number;
}

export interface AgentSpanView {
  toolUseId: string;
  turnId: string;
  blockId?: string;
  start: number;
  end: number;
  // 終了が観測されていない（実行中または記録が途切れている）。end は lastAt
  open: boolean;
  isBackground: boolean;
  description: string;
  subagentType?: string;
  model?: string;
  transcriptAgentId?: string;
  toolCount: number;
  failCount: number;
  toolMs: number;
  generateMs: number;
  // 端点の出どころ。"child-transcript" は host が子 transcript の先頭/末尾で上書きしたもの。
  // "notification" は task-notification（裁定A2: async 委任の完了信号）
  endSource: "child-transcript" | "child-tools" | "ack" | "open" | "notification";
}

export interface RequestBlockView {
  blockId: string;
  kind: RequestBlockKind;
  text: string;
  start: number;
  end: number;
  // fidelity=inherited のとき start は継承値なので、ブロック内で最初に実時刻を持つイベントの時刻
  anchorAt: number;
  // null = start が継承値（fidelity=inherited）。数字にすると継承した時刻からの差を経過として出す（R-DSP-11）
  durationMs: number | null;
  turnIds: string[];
  toolCount: number;
  failCount: number;
  agentCount: number;
  generateMs: number | null;
  toolMs: number;
  confirmMs: number;
  replyMs: number | null;
  running: boolean;
}

export interface MainModelTimeEntry {
  // unknown = model を観測する前のターン（R-DSP-01）。other = 上位 MAIN_MODEL_TOP_COUNT 以外を畳んだもの
  kind: "model" | "other" | "unknown";
  label: string;
  model: string | null;
  foldedModelCount: number | null;
  generateMs: number;
  // totalMs に対する比（0..1）と整数の百分率。totalMs が 0 なら null
  share: number | null;
  percent: number | null;
}

// 本体の処理時間 = LLM 生成 + 委任でないツール（R-DSP-17 のメイン棒と同じ母数）
export interface MainTimeByModelView {
  totalMs: number;
  generateMs: number;
  models: MainModelTimeEntry[];
  toolMs: number;
  toolShare: number | null;
  toolPercent: number | null;
}

export interface TimeBucketView {
  fidelity: TimeFidelity;
  inheritedBoundaryCount: number;
  firstAt: number | null;
  lastAt: number | null;
  // null = 継承時刻を含む（経過を測っていない）。firstAt / lastAt は実時刻を持つイベントの端で、軸の位置には使える
  spanMs: number | null;
  main: TimeBucketTotals;
  sub: { generateMs: number; toolMs: number; spanMs: number };
  // R-DSP-17 の 3 本。返信待ちと確認待ちは入れない
  bars: { totalMs: number | null; mainMs: number | null; subMs: number };
  // null = model の地点を渡されていない（live の fold）か、継承時刻で生成時間を測っていない（R-DSP-11）
  mainByModel: MainTimeByModelView | null;
  agentCount: number;
  maxParallelAgents: number;
  currentParallel: number;
  maxConcurrency: number;
  turnOpen: boolean;
  tail: {
    main: "generate" | "tool" | "confirm" | null;
    anyOpen: boolean;
  };
  intervals: TimeBucketInterval[];
  agents: AgentSpanView[];
  backgroundTasks: BackgroundTaskSpanView[];
  blocks: RequestBlockView[];
  droppedIntervalCount: number;
  droppedBlockCount: number;
}

export interface ChildTranscriptSpan {
  toolUseId: string;
  startedAt?: number;
  endedAt?: number;
}

function sweepMax(spans: readonly Span[]): number {
  const points: { at: number; delta: number }[] = [];
  for (const [s0, s1] of spans) {
    if (s1 <= s0) continue;
    points.push({ at: s0, delta: 1 }, { at: s1, delta: -1 });
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let cur = 0;
  let max = 0;
  for (const p of points) {
    cur += p.delta;
    if (cur > max) max = cur;
  }
  return max;
}

// ターンごとに生成時間を model へ割り当てる。地点はメインの応答記録ごとの観測（その応答を出した model）。
// ターン内の地点 m は前の地点（またはターン開始）から m までの生成を持ち、最後の地点の後はターン終端まで同じ model。
// ターン内に地点が無ければ直前の地点の model が続いている。直前の地点が無いターンは unknown（R-DSP-01）
export function deriveMainByModel(
  turns: readonly TurnSpan[],
  generate: readonly Span[],
  toolMs: number,
  marks: readonly ModelMark[]
): MainTimeByModelView {
  const sortedMarks = [...marks].sort((a, b) => a.at - b.at);
  const byModel = new Map<string, number>();
  let unknownMs = 0;
  let covered = -Infinity;
  // 割り当てる窓は時刻の昇順にしか進まないので、生成区間の走査位置を持ち越す（窓ごとに先頭から走査すると O(N²)）
  let gi = 0;
  const credit = (model: string | undefined, s0: number, s1: number): void => {
    const start = Math.max(s0, covered);
    if (s1 <= start) return;
    covered = s1;
    while (gi < generate.length && generate[gi][1] <= start) gi++;
    let ms = 0;
    for (let j = gi; j < generate.length && generate[j][0] < s1; j++) {
      ms += Math.max(0, Math.min(s1, generate[j][1]) - Math.max(start, generate[j][0]));
    }
    if (ms <= 0) return;
    if (model === undefined) unknownMs += ms;
    else byModel.set(model, (byModel.get(model) ?? 0) + ms);
  };
  let mi = 0;
  let current: string | undefined;
  for (const t of [...turns].sort((a, b) => a.start - b.start)) {
    while (mi < sortedMarks.length && sortedMarks[mi].at <= t.start) current = sortedMarks[mi++].model;
    let cursor = t.start;
    while (mi < sortedMarks.length && sortedMarks[mi].at <= t.end) {
      const mark = sortedMarks[mi++];
      credit(mark.model, cursor, mark.at);
      cursor = mark.at;
      current = mark.model;
    }
    credit(current, cursor, t.end);
  }
  const generateMs = measureSpans(generate);
  const totalMs = generateMs + toolMs;
  const ranked = [...byModel].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const models: MainModelTimeEntry[] = ranked.slice(0, MAIN_MODEL_TOP_COUNT).map(([model, ms]) => ({
    kind: "model",
    label: model.replace(/^claude-/, ""),
    model,
    foldedModelCount: null,
    generateMs: ms,
    share: null,
    percent: null,
  }));
  const folded = ranked.slice(MAIN_MODEL_TOP_COUNT);
  if (folded.length > 0) {
    models.push({
      kind: "other",
      label: l10n.t("Other {0} models", folded.length),
      model: null,
      foldedModelCount: folded.length,
      generateMs: folded.reduce((acc, [, v]) => acc + v, 0),
      share: null,
      percent: null,
    });
  }
  if (unknownMs > 0) {
    models.push({
      kind: "unknown",
      label: l10n.t("Model not observed"),
      model: null,
      foldedModelCount: null,
      generateMs: unknownMs,
      share: null,
      percent: null,
    });
  }
  if (totalMs <= 0) return { totalMs, generateMs, models, toolMs, toolShare: null, toolPercent: null };
  // 同じ輪に並ぶ百分率は最大剰余で丸め、和を 100 に揃える
  const parts = [...models.map((m) => m.generateMs), toolMs];
  const percents = largestRemainderPercents(parts, totalMs);
  models.forEach((m, i) => {
    m.share = m.generateMs / totalMs;
    m.percent = percents[i];
  });
  return { totalMs, generateMs, models, toolMs, toolShare: toolMs / totalMs, toolPercent: percents[parts.length - 1] };
}

function largestRemainderPercents(parts: readonly number[], total: number): number[] {
  const raw = parts.map((p) => (p / total) * 100);
  const floors = raw.map((r) => Math.floor(r));
  let rest = 100 - floors.reduce((acc, v) => acc + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]++;
    rest--;
  }
  return floors;
}

export function deriveTimeBuckets(
  state: TimeBucketState,
  options?: {
    childSpans?: readonly ChildTranscriptSpan[];
    // MED-1 / 裁定H-1 と同じゲート（semantic-model.ts openAsyncStatusOf の鏡像）。
    // 通知の無い background 委任を「実行中（open）」と主張できるのは、ストリーム継続中に
    // 現プロセスで ACK/再開を観測した委任だけ。省略時（fold 単体・transcript 再読込）は
    // ゲート無し = 裁定A2 のみで決める（resume 復元の旧委任を open のまま出すと、
    // 終了済みセッションの並列数が残る）
    streamOpen?: boolean;
    liveDelegationAgentIds?: ReadonlySet<string>;
    modelMarks?: readonly ModelMark[];
  }
): TimeBucketView {
  const firstAt = state.firstAt ?? null;
  const lastAt = state.lastAt ?? null;
  const spanMs = firstAt !== null && lastAt !== null ? Math.max(0, lastAt - firstAt) : 0;
  const end = lastAt ?? 0;
  const inherited = state.inheritedBoundaryCount > 0;

  const turnSpansAll: TurnSpan[] = [...state.turnSpans];
  if (state.openTurn !== undefined && lastAt !== null) {
    turnSpansAll.push({ turnId: state.openTurn.turnId, start: state.openTurn.startedAt, end: Math.max(state.openTurn.startedAt, end) });
  }
  const turnUnion = unionSpans(turnSpansAll.map((t) => [t.start, t.end] as Span));

  const confirmSpans = state.mainTools.filter((t) => HUMAN_INPUT_WAIT_TOOLS.has(t.toolName)).map((t) => [t.start, t.end] as Span);
  const allMainToolSpans = state.mainTools.map((t) => [t.start, t.end] as Span);
  // 未終了のメインツールは lastAt まで実行中として数える
  for (const open of Object.values(state.openTools)) {
    if (open.lane !== "main" || lastAt === null) continue;
    const span: Span = [open.at, Math.max(open.at, end)];
    allMainToolSpans.push(span);
    if (HUMAN_INPUT_WAIT_TOOLS.has(open.toolName)) confirmSpans.push(span);
  }
  const confirmUnion = unionSpans(confirmSpans);
  // 確認待ちを返信待ちへ畳まない。畳むと「LLM からの確認を減らす」が改善方向として見えなくなる（R-DSP-16）
  const toolUnion = subtractSpans(unionSpans(allMainToolSpans), confirmUnion);
  // メイン棒のツール分は「委任でないツールの和集合」。toolUnion から Agent 区間を引く形だと、
  // Agent と重なって走った Read 等の時間まで消えて過小になる（R-DSP-17）
  const nonDelegationToolSpans = state.mainTools
    .filter((t) => !DELEGATION_TOOL_NAMES.has(t.toolName))
    .map((t) => [t.start, t.end] as Span);
  for (const open of Object.values(state.openTools)) {
    if (open.lane !== "main" || lastAt === null || DELEGATION_TOOL_NAMES.has(open.toolName)) continue;
    nonDelegationToolSpans.push([open.at, Math.max(open.at, end)]);
  }
  const nonDelegationToolUnion = subtractSpans(unionSpans(nonDelegationToolSpans), confirmUnion);

  // 子 transcript の端点で上書きする。DelegationRecord.endedAt（起動 ACK）から作ってはいけない
  const childByToolUseId = new Map<string, ChildTranscriptSpan>();
  for (const c of options?.childSpans ?? []) childByToolUseId.set(c.toolUseId, c);
  const subToolsByAgent = new Map<string, ToolInterval[]>();
  for (const t of state.subTools) {
    if (t.agentId === undefined) continue;
    const list = subToolsByAgent.get(t.agentId) ?? [];
    list.push(t);
    subToolsByAgent.set(t.agentId, list);
  }
  const agents: AgentSpanView[] = [];
  for (const toolUseId of state.delegationOrder) {
    const d = state.delegations[toolUseId];
    if (d === undefined) continue;
    const child = childByToolUseId.get(toolUseId);
    let start = d.startedAt;
    let spanEnd: number | undefined;
    let endSource: AgentSpanView["endSource"];
    const liveGateIds = options?.liveDelegationAgentIds;
    const claimableRunning =
      options?.streamOpen !== false &&
      (liveGateIds === undefined || (d.transcriptAgentId !== undefined && liveGateIds.has(d.transcriptAgentId)));
    if (d.isBackground && d.notifiedEndedAt === undefined && claimableRunning) {
      // 裁定A2: background 委任の完了は task-notification でのみ確定する。子 transcript の
      // 末尾レコード時刻は「そこまで書けている」事実であって完了ではなく、実行中の子にも
      // 常に存在する（使うと resume タブで実行中の委任が閉じて見える。TB-20/21）。
      // resume（裁定A1）で notifiedEndedAt が消えると再び open になる
      if (child?.startedAt !== undefined) start = child.startedAt;
      spanEnd = undefined;
      endSource = "open";
    } else if (child?.endedAt !== undefined) {
      if (child.startedAt !== undefined) start = child.startedAt;
      spanEnd = child.endedAt;
      endSource = "child-transcript";
    } else if (d.isBackground && d.notifiedEndedAt !== undefined) {
      // notified かつ子 transcript 端点なし。通知時刻で閉じる
      spanEnd = d.lastChildAt !== undefined ? Math.max(d.notifiedEndedAt, d.lastChildAt) : d.notifiedEndedAt;
      endSource = "notification";
    } else if (d.ackEndedAt !== undefined) {
      spanEnd = d.lastChildAt !== undefined ? Math.max(d.ackEndedAt, d.lastChildAt) : d.ackEndedAt;
      endSource = "ack";
    } else {
      spanEnd = d.lastChildAt;
      endSource = spanEnd !== undefined ? "child-tools" : "open";
    }
    const open = spanEnd === undefined;
    const resolvedEnd = Math.max(start, spanEnd ?? end);
    const tools = subToolsByAgent.get(toolUseId) ?? [];
    const toolMs = measureSpans(intersectSpans(unionSpans(tools.map((t) => [t.start, t.end] as Span)), [[start, resolvedEnd]]));
    agents.push({
      toolUseId,
      turnId: d.turnId,
      start,
      end: resolvedEnd,
      open,
      isBackground: d.isBackground,
      description: d.description,
      ...(d.subagentType !== undefined ? { subagentType: d.subagentType } : {}),
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(d.transcriptAgentId !== undefined ? { transcriptAgentId: d.transcriptAgentId } : {}),
      toolCount: tools.length,
      failCount: tools.filter((t) => t.isError).length,
      toolMs,
      generateMs: Math.max(0, resolvedEnd - start - toolMs),
      endSource: open ? "open" : endSource,
    });
  }
  // 背景 Bash。通知・終端・pendingStale 確定のどれかで閉じ、それ以外は H-1 ゲートを通るときだけ open
  const backgroundTasks: BackgroundTaskSpanView[] = [];
  for (const toolUseId of state.backgroundTaskOrder) {
    const b = state.backgroundTasks[toolUseId];
    if (b === undefined) continue;
    const liveGateIds = options?.liveDelegationAgentIds;
    const claimableRunning =
      options?.streamOpen !== false && (liveGateIds === undefined || liveGateIds.has(b.taskId));
    let bgEnd: number | undefined;
    let endSource: BackgroundTaskSpanView["endSource"];
    if (b.notifiedEndedAt !== undefined) {
      bgEnd = b.notifiedEndedAt;
      endSource = "notification";
    } else if (b.staleAt !== undefined || !claimableRunning) {
      bgEnd = b.staleAt ?? end;
      endSource = "stale";
    } else {
      bgEnd = undefined;
      endSource = "open";
    }
    backgroundTasks.push({
      toolUseId,
      taskId: b.taskId,
      turnId: b.turnId,
      description: b.description,
      start: b.startedAt,
      end: Math.max(b.startedAt, bgEnd ?? end),
      open: bgEnd === undefined,
      endSource,
    });
  }
  const agentSpans = agents.map((a) => [a.start, a.end] as Span);
  const bgSpans = backgroundTasks.map((t) => [t.start, t.end] as Span);
  const subActiveUnion = unionSpans(agentSpans);

  const whole: Span[] = firstAt !== null && lastAt !== null ? [[firstAt, lastAt]] : [];
  const generateSpans = subtractSpans(turnUnion, unionSpans([...toolUnion, ...confirmUnion]));
  // ターン境界の無い記録（人間発話レコードを持たない transcript）でもツール区間は稼働なので、
  // 稼働 = ターン ∪ ツール ∪ 確認待ち ∪ サブエージェント。これで恒等式が全記録で成立する
  const mainActiveUnion = unionSpans([...turnUnion, ...toolUnion, ...confirmUnion]);
  const activeUnion = unionSpans([...mainActiveUnion, ...subActiveUnion]);
  // 返信待ち = 経過 − 稼働。ターンをまたぐ空白だけを数え、サブエージェントの作業時間を
  // 返信待ちに数えない（R-DSP-15）
  const replySpans = subtractSpans(whole, activeUnion);
  // 経過窓へ切る。子 transcript の終端が親の lastAt より後だと、切らない限り 5 項の合計が経過を超える
  const subOnlySpans = intersectSpans(subtractSpans(subActiveUnion, mainActiveUnion), whole);

  const toolMs = measureSpans(intersectSpans(toolUnion, whole));
  const confirmMs = measureSpans(intersectSpans(confirmUnion, whole));
  const generateMs = measureSpans(intersectSpans(generateSpans, whole));
  const replyMs = measureSpans(replySpans);
  const subOnlyMs = measureSpans(subOnlySpans);
  const mainBarMs = generateMs + measureSpans(intersectSpans(nonDelegationToolUnion, whole));
  const mainByModel =
    inherited || options?.modelMarks === undefined
      ? null
      : deriveMainByModel(turnSpansAll, intersectSpans(generateSpans, whole), mainBarMs - generateMs, options.modelMarks);
  const subGenerate = agents.reduce((acc, a) => acc + a.generateMs, 0);
  const subTool = agents.reduce((acc, a) => acc + a.toolMs, 0);
  const subSpan = agents.reduce((acc, a) => acc + Math.max(0, a.end - a.start), 0);

  const intervals: TimeBucketInterval[] = [];
  if (!inherited) {
    for (const [s0, s1] of generateSpans) intervals.push({ bucket: "generate", lane: "main", start: s0, end: s1 });
  }
  for (const [s0, s1] of toolUnion) intervals.push({ bucket: "tool", lane: "main", start: s0, end: s1 });
  const bgUnion = unionSpans(bgSpans);
  const withBgOverlap = (interval: TimeBucketInterval): TimeBucketInterval => {
    const overlap = measureSpans(intersectSpans([[interval.start, interval.end]], bgUnion));
    if (overlap > 0) interval.backgroundOverlapMs = overlap;
    return interval;
  };
  for (const [s0, s1] of confirmUnion) intervals.push(withBgOverlap({ bucket: "confirm", lane: "main", start: s0, end: s1 }));
  if (!inherited) {
    for (const [s0, s1] of replySpans) intervals.push(withBgOverlap({ bucket: "reply", lane: "main", start: s0, end: s1 }));
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);

  const blocks: RequestBlockView[] = [];
  for (let i = 0; i < state.blocks.length; i++) {
    const b = state.blocks[i];
    const nextStart = i + 1 < state.blocks.length ? state.blocks[i + 1].start : end;
    const bEnd = Math.max(b.start, nextStart);
    const bspan: Span[] = [[b.start, bEnd]];
    const turnIds = turnSpansAll.filter((t) => t.start >= b.start && t.start < bEnd).map((t) => t.turnId);
    if (b.turnId !== null && !turnIds.includes(b.turnId)) turnIds.unshift(b.turnId);
    const tools = state.mainTools.filter((t) => t.start >= b.start && t.start < bEnd);
    const blockAgents = agents.filter((a) => a.start >= b.start && a.start < bEnd);
    for (const a of blockAgents) a.blockId = b.blockId;
    for (const t of backgroundTasks) if (t.start >= b.start && t.start < bEnd) t.blockId = b.blockId;
    const firstReal = tools.length > 0 ? Math.min(...tools.map((t) => t.start)) : undefined;
    const running = state.openTurn !== undefined && i === state.blocks.length - 1;
    blocks.push({
      blockId: b.blockId,
      kind: b.kind,
      text: b.text,
      start: b.start,
      end: bEnd,
      anchorAt: inherited ? (firstReal ?? b.start) : b.start,
      durationMs: inherited ? null : bEnd - b.start,
      turnIds,
      toolCount: tools.length,
      failCount: tools.filter((t) => t.isError).length,
      agentCount: blockAgents.length,
      generateMs: inherited ? null : measureSpans(intersectSpans(generateSpans, bspan)),
      toolMs: measureSpans(intersectSpans(toolUnion, bspan)),
      confirmMs: measureSpans(intersectSpans(confirmUnion, bspan)),
      replyMs: inherited ? null : measureSpans(intersectSpans(replySpans, bspan)),
      running,
    });
  }

  const maxParallelAgents = sweepMax(agentSpans);
  const openMainTools = Object.values(state.openTools).filter((o) => o.lane === "main");
  const confirmOpen = openMainTools.some((o) => HUMAN_INPUT_WAIT_TOOLS.has(o.toolName));
  // 現在値と最大値は同じ母集団（確認待ちを除いたメインの往復 + 委任 + 背景タスク）。片方だけ数えると、
  // 動作中のメインの往復が並列数に出ない・現在値が最大値を超える、のどちらかになる
  const turnParallel = state.openTurn !== undefined && !confirmOpen ? 1 : 0;
  const currentParallel = turnParallel + agents.filter((a) => a.open).length + backgroundTasks.filter((t) => t.open).length;
  // 現在値は到達済みの同時実行数なので、最大値がそれを下回る画面を作らない
  const maxConcurrency = Math.max(sweepMax([...subtractSpans(turnUnion, confirmUnion), ...agentSpans, ...bgSpans]), currentParallel);

  // tail は Host 事実で view は intervals から判定しない（R-DSP-15）
  const tailMain: "generate" | "tool" | "confirm" | null =
    confirmOpen
      ? "confirm"
      : openMainTools.length > 0
        ? "tool"
        : state.openTurn !== undefined
          ? "generate"
          : null;
  const tailAnyOpen = tailMain !== null || agents.some((a) => a.open) || backgroundTasks.some((t) => t.open);
  const tail = { main: tailMain, anyOpen: tailAnyOpen };

  return {
    fidelity: state.fidelity,
    inheritedBoundaryCount: state.inheritedBoundaryCount,
    firstAt,
    lastAt,
    spanMs: inherited ? null : spanMs,
    main: {
      // 実測できていない区分を 0 と書かない。0 は「無かった」を主張する（R-DSP-01）
      generateMs: inherited ? null : generateMs,
      toolMs,
      confirmMs,
      replyMs: inherited ? null : replyMs,
      subOnlyMs: inherited ? null : subOnlyMs,
      spanMs: inherited ? null : spanMs,
    },
    sub: { generateMs: subGenerate, toolMs: subTool, spanMs: subSpan },
    // 返信待ちは棒に入れない。改善できない時間で、入れると処理側が読めなくなる（R-DSP-17）
    bars: {
      mainMs: inherited ? null : mainBarMs,
      subMs: subSpan,
      totalMs: inherited ? null : mainBarMs + subSpan,
    },
    mainByModel,
    agentCount: agents.length,
    maxParallelAgents,
    currentParallel,
    maxConcurrency,
    turnOpen: state.openTurn !== undefined,
    tail,
    intervals,
    agents,
    backgroundTasks,
    blocks,
    droppedIntervalCount: state.droppedIntervalCount,
    droppedBlockCount: state.droppedBlockCount,
  };
}

// JSONL の読み直し（measured）で数値を差し替えるとき、live の fold（live）が持つ「今」の状態は残す。
// readSessionHistory は末尾で turn_completed を合成し、子 transcript の末尾レコードで endedAt を立てるので、
// 読み直しの値だけだと開いているターンも動作中のサブエージェントも全て閉じた形になる
// （概要の「現在」・実行中の往復・並列数・グラフの伸びる帯が出なくなる — R-DSP-20 / R-DSP-06 / R-TAB-09）。
// 数値（4 区分・棒・経過・区間）は measured、状態（turnOpen / blocks[].running / agents[].open /
// backgroundTasks[].open / currentParallel / 開いている区間の終端）は live から取る。live の fold は async 委任を
// task-notification で閉じ resume で開き直す（裁定A2/A1）ので、開閉どちらの向きも live を正とする
// （measured は末尾合成で常に閉じた形になるため、開く向きだけでなく閉じる向きも live に任せる）
export function overlayLiveTimeBucketState(measured: TimeBucketView, live: TimeBucketView): TimeBucketView {
  const liveAgents = new Map(live.agents.map((a) => [a.toolUseId, a]));
  const agents: AgentSpanView[] = measured.agents.map((a) => {
    const l = liveAgents.get(a.toolUseId);
    if (l === undefined || l.open === a.open) return a;
    if (l.open) return { ...a, open: true, end: Math.max(a.end, l.end), endSource: "open" };
    return { ...a, open: false, end: l.end, endSource: l.endSource };
  });
  // live で観測済みだが読み直しにまだ無いサブエージェント（読み直しは境界イベントから 1.5 秒遅れる）
  for (const l of live.agents) {
    if (measured.agents.some((a) => a.toolUseId === l.toolUseId)) continue;
    agents.push(l);
  }
  const liveBg = new Map(live.backgroundTasks.map((t) => [t.toolUseId, t]));
  const backgroundTasks: BackgroundTaskSpanView[] = measured.backgroundTasks.map((t) => {
    const l = liveBg.get(t.toolUseId);
    if (l === undefined || l.open === t.open) return t;
    if (l.open) return { ...t, open: true, end: Math.max(t.end, l.end), endSource: "open" };
    return { ...t, open: false, end: l.end, endSource: l.endSource };
  });
  for (const l of live.backgroundTasks) {
    if (measured.backgroundTasks.some((t) => t.toolUseId === l.toolUseId)) continue;
    backgroundTasks.push(l);
  }
  const mergedSpans: Span[] = [
    ...agents.map((a) => [a.start, a.end] as Span),
    ...backgroundTasks.map((t) => [t.start, t.end] as Span),
  ];
  // 確認待ちの判定は live の tail（Host 事実）。overlay は区間を持たないので confirmUnion を作り直さない
  const turnParallel = live.turnOpen && live.tail.main !== "confirm" ? 1 : 0;
  const mergedParallel = turnParallel + agents.filter((a) => a.open).length + backgroundTasks.filter((t) => t.open).length;
  const blocks: RequestBlockView[] = measured.blocks.map((b) => ({ ...b, running: false }));
  const liveLast = live.blocks[live.blocks.length - 1];
  if (live.turnOpen && liveLast !== undefined && liveLast.running) {
    // 往復の対応は順序（blockId は fold が付ける通し番号）。本文で取ると、直前と同じ本文の依頼が
    // 読み直しにまだ無いとき、直前の往復が「現在」になり新しい往復が消える（R-DSP-20 / R-TAB-09）。
    // 読み直しは live の接頭辞なので、対応するのは読み直しの末尾に限る
    const at = blocks.findIndex((b) => b.blockId === liveLast.blockId);
    if (at >= 0 && at === blocks.length - 1) {
      blocks[at] = { ...blocks[at], running: true, end: Math.max(blocks[at].end, liveLast.end) };
    } else {
      // live の最後の往復が読み直しにまだ無い。数値は継承時刻由来なので出さない（R-DSP-11）
      blocks.push({ ...liveLast, durationMs: null, generateMs: null, replyMs: null, running: true });
    }
  }
  return {
    ...measured,
    agents,
    backgroundTasks,
    blocks,
    agentCount: agents.length,
    currentParallel: mergedParallel,
    // 読み直しは live より遅れるので、merged にしか無い区間の分だけ measured の最大値が足りない。
    // measured 側はターン区間を含むため捨てられず、下界の最大を取る（過大申告はしない）
    maxConcurrency: Math.max(measured.maxConcurrency, sweepMax(mergedSpans), mergedParallel),
    turnOpen: live.turnOpen,
    tail: live.tail,
  };
}
