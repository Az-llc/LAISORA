import { createHash } from "node:crypto";
import type { NormalizedEvent, ProgressState } from "./protocol";
import { progressSubjectKey } from "./progress-protocol";
import type { HostArtifactAccess } from "./artifact-access";
import { PROGRESS_WIRE_TOOL_NAME } from "./artifact-access";
import type { TaskIntent, TaskStatus } from "./work-model";
import { CLAUDE_VOCABULARY, taskCreateKeyFromResult } from "./work-model";
import { isPureCommandWrapper } from "./human-input-vocabulary";
import { redactAbsolutePaths } from "./path-redaction";
import { createTimeBucketState, foldTimeBuckets, type TimeBucketState } from "./time-buckets";
import { createExecLogMarkState, foldExecLogMarks, type ExecLogMarkState } from "./exec-log-marks";

export const MAX_TODO_TRANSITIONS = 2000;
export const MAX_PROGRESS_TRANSITIONS = 2000;
export const MAX_DELEGATIONS = 500;
export const MAX_ARTIFACT_ACCESSES = 5000;
export const MAX_EFFECT_GAPS = 5000;
export const MAX_PENDING_INTENTS = 256;
export const MAX_HUMAN_MESSAGE_TIMES = 500;
// longGap の閾値の単一出所（fold 側でのみ判定する。裁定M6）。この値を変えても既存
// index は作り直されないため、反映には EvidenceIndex の再 fold（history 再読込 / 再生）が要る。
// analysis.ts はここから import する（同名の別定義を再導入しないこと）
export const IDLE_GAP_MS = 5 * 60_000;
export const MAX_LONG_GAPS = 500;
// 未終了の sidechain tool 呼び出しを覚えておく上限。終了時に消すので通常は同時実行数程度
const MAX_OPEN_SIDECHAIN_TOOLS = 1000;

export type IdentityStability = "stable" | "content-derived" | "heuristic" | "unknown";

export interface EvidenceRef {
  toolUseId?: string;
  agentId?: string;
  seq?: number;
}

export interface TaskIdentityBinding {
  semanticTaskId: string; // L2b が使う正本 ID
  taskKeys: string[]; // 記帳系の key（複数ありうる）
  stability: IdentityStability;
  evidence: EvidenceRef[];
}

export interface TodoTransition {
  taskKey: string;
  from: TaskStatus;
  to: TaskStatus;
  at: number;
  evidence: EvidenceRef;
}

export interface DelegationRecord {
  agentId: string;
  toolUseId: string;
  parentToolUseId: string | null;
  agentType?: string;
  // Task/Agent tool input の description（200 字・redact 済み。Attempt title の観測入力）
  description?: string;
  activeTaskKeyAtStart?: string; // 起動時点の activeTaskKey（R4.2 の入力）
  activeAmbiguousAtStart: boolean;
  startedAt: number;
  endedAt?: number;
  // async 起動ACKで観測した transcript の実 agentId。resume（resumedAgentId）と
  // task-notification（task-id）はこの値でしか dispatch と結合できない
  transcriptAgentId?: string;
  // 裁定⑧: resume（SendMessage 成功）ごとに1件。空なら undefined
  // （空配列を持たせると canonicalizeForHash が落とさず既存セッションの hash が変わる）
  reopens?: { at: number }[];
  // run_in_background===true 宣言（A-4: hashProjection に含めてはならない）
  isBackground?: true;
  evidence: EvidenceRef;
}

// pp1 progress emission の蓄積。ownershipVerified は emitter 帰属の
// 確認であり宣言内容の真偽ではない（attributed の門。真偽照合は L3 divergence 側のみ）
export interface ProgressTransitionRecord {
  state: ProgressState;
  at: number;
  toolUseId: string;
  // emitter（agent:${parentToolUseId}）。root 発は導出不能で undefined（常に ownershipVerified=false）
  agentId?: string;
  ownershipVerified: boolean;
  // emission 時点を包含する当該 Task の Assignment が1件ならその参照（agentId@startedAt）。0件・複数・reopen 後は undefined
  resolvedAssignmentRef?: string;
  activity?: string;
  blocker?: string;
  evidenceDecl?: string[];
  next?: string;
}

export interface ArtifactAccessRecord extends HostArtifactAccess {
  toolUseId: string;
  ownerAgentId?: string;
  at: number;
}

// resource effect を確定できなかった呼び出しの記録。
// artifact record が1件も無い Bash 呼び出しも「不明があった」事実として残す。
// これが無いと footprint.unknownEffects を導出できず「観測なし=競合なし」に化ける
export interface EffectGapRecord {
  toolUseId: string;
  ownerAgentId?: string;
  at: number;
  coverage: "partial" | "unavailable";
}

// 上限に当たっても捨ててはいけない要約（P1-F / 要求18）。
// raw の TodoTransition 配列を単純に cap すると reworkCount・Attempt 境界・Q4 が壊れる
export interface TaskTransitionSummary {
  taskKey: string;
  reopenCount: number;
  completedCount: number;
  lastTransition?: TodoTransition;
  firstStartedAt?: number;
}

export interface EvidenceCoverage {
  todoTransitions: number;
  delegations: number;
  artifactAccesses: number;
  effectGaps: number;
  longGaps: number;
}

// longGap の入力: 同一ターン内の隣接イベント間隔（at = 間隔開始時刻）
export interface LongGapRecord {
  at: number;
  durationMs: number;
}

// gap 走査の実装状態（pendingIntents と同じ扱い）
export interface GapScanState {
  lastAt?: number;
  lastTurnId?: string | null;
  lastCanStart: boolean;
  // 開始済みで未終了の sidechain（parentToolUseId 付き）tool_call の id。
  // tool_call_finished は parentToolUseId を持たないため、started 側で覚えないと
  // 子由来の結果を親の走査から外せない
  openSidechainToolUseIds: readonly string[];
}

export interface SemanticEvidenceIndex {
  bindings: TaskIdentityBinding[];
  todoTransitions: TodoTransition[]; // raw。上限あり
  transitionSummaries: TaskTransitionSummary[]; // **上限で raw を捨てても必ず保持**
  delegations: DelegationRecord[];
  artifactAccesses: ArtifactAccessRecord[];
  effectGaps: EffectGapRecord[]; // unknownEffects の観測根拠
  coverage: EvidenceCoverage; // 種別ごとに捨てた件数
  hash: string;
  // R6b cause="user-change"の入力: 人間発言の時刻列（昇順・上限あり）。
  // hash 非入力（live/history で時刻の同値保証が無い補助入力）
  humanMessageTimes: number[];
  // R1 Goal title の素材（最初の人間発言1行目）。hash 非入力（同上）
  firstHumanMessageLine?: string;
  // 「1 つ目のプロンプト」の本文（redact 済み・2000 字上限）。hash 非入力（同上）
  firstHumanMessageText?: string;
  // 経過時間の 4 区分と依頼ブロック（time-buckets.ts）。hash 非入力・semanticHash 非入力
  timeBuckets: TimeBucketState;
  // 実行ログの印（exec-log-marks.ts）。hash 非入力・semanticHash 非入力
  execLogMarks: ExecLogMarkState;
  // longGap 入力（裁定A3）。同一ターン内の隣接イベント間隔が IDLE_GAP_MS 以上の記録列。
  // 間隔を切る 3 分岐: tool_result 隣接は L1.5 の tool_call_finished が、注入タグ / 純コマンド（INJECTED_TAG_RE / PURE_COMMAND_WRAPPER_RE）は
  // foldEvidence の gapBoundaries（側チャネル。裁定C2）が担う。ただし isNonHumanCommandName に載るコマンド（/rename）は境界にもしない
  // （境界も longGaps 経由で semanticHash の入力になるため）。sidechain 由来イベントは走査対象外。
  // hash 非入力（humanMessageTimes と同扱い: live/history で時刻の同値保証が無い補助入力）
  longGaps: LongGapRecord[];
  // MAX_LONG_GAPS 超過で捨てた記録の合計時間。件数は coverage.longGaps 側
  droppedLongGapMs: number;
  gapScan: GapScanState;
  // pp1 progress。hash 非入力（hashProjection に含めない。semanticHash 側の入力にはする — longGaps と同扱い）
  progressTransitions: ProgressTransitionRecord[];
  // 形式不正で破棄した wire 呼び出し件数（縮退の可視化。hash 非入力）
  invalidProgressCount: number;
  // reducer と同じ「finished かつ非エラー時のみ記帳を適用する」規律のための待機領域
  // （実装状態。hash には含めない）
  pendingIntents: Record<string, { intent: TaskIntent }>;
}

export interface RawRefLocation {
  file: string;
  line: number;
}

export type RawRefIndex = Map<string, RawRefLocation>;

export function createEvidenceIndex(): SemanticEvidenceIndex {
  return {
    bindings: [],
    todoTransitions: [],
    transitionSummaries: [],
    delegations: [],
    artifactAccesses: [],
    effectGaps: [],
    coverage: {
      todoTransitions: 0,
      delegations: 0,
      artifactAccesses: 0,
      effectGaps: 0,
      longGaps: 0,
    },
    hash: "",
    humanMessageTimes: [],
    longGaps: [],
    droppedLongGapMs: 0,
    gapScan: { lastCanStart: false, openSidechainToolUseIds: [] },
    progressTransitions: [],
    invalidProgressCount: 0,
    pendingIntents: {},
    timeBuckets: createTimeBucketState(),
    execLogMarks: createExecLogMarkState(),
  };
}

function cloneSummaries(index: SemanticEvidenceIndex): Map<string, TaskTransitionSummary> {
  const summaryMap = new Map<string, TaskTransitionSummary>();
  for (const s of index.transitionSummaries) {
    summaryMap.set(s.taskKey, { ...s });
  }
  return summaryMap;
}

function makeTransitionRecorder(
  summaryMap: Map<string, TaskTransitionSummary>,
  newTransitions: TodoTransition[],
  timestamp: number,
  evidenceRef: EvidenceRef
) {
  return function recordTransition(taskKey: string, toStatus: TaskStatus): void {
    const existingSummary = summaryMap.get(taskKey);
    const prevStatus: TaskStatus = existingSummary?.lastTransition?.to ?? "unknown";
    if (prevStatus === toStatus) {
      return;
    }

    const transition: TodoTransition = {
      taskKey,
      from: prevStatus,
      to: toStatus,
      at: timestamp,
      evidence: evidenceRef,
    };
    newTransitions.push(transition);

    const isReopen = prevStatus === "completed" && toStatus === "in_progress";
    // 消失（unknown）からの再完了は同一 content の再掲であり完了の二重計上にしない
    const isCompleted =
      toStatus === "completed" &&
      prevStatus !== "completed" &&
      !(prevStatus === "unknown" && (existingSummary?.completedCount ?? 0) > 0);

    if (existingSummary) {
      existingSummary.lastTransition = transition;
      if (isReopen) {
        existingSummary.reopenCount += 1;
      }
      if (isCompleted) {
        existingSummary.completedCount += 1;
      }
      if (toStatus === "in_progress" && existingSummary.firstStartedAt === undefined) {
        existingSummary.firstStartedAt = timestamp;
      }
    } else {
      summaryMap.set(taskKey, {
        taskKey,
        reopenCount: 0,
        completedCount: isCompleted ? 1 : 0,
        lastTransition: transition,
        firstStartedAt: toStatus === "in_progress" ? timestamp : undefined,
      });
    }
  };
}

// in_progress が1件のときだけ activeTaskKey を確定し、複数のときは推測で埋めない
// （R3.1「推測での結合はしない」。値を入れると ambiguity を見ない消費者が通る）。
// reducer の recomputeActiveTask は task 上限退避（omittedActiveTaskCount）も判定に含むが、
// EvidenceIndex の summaries は上限で捨てないためここに退避の概念は無い —
// reducer が MAX_TASKS へ達したセッションでは両者の ambiguity 判定が乖離しうる
function activeTaskState(summaryMap: Map<string, TaskTransitionSummary>): {
  activeTaskKeyAtStart?: string;
  activeAmbiguousAtStart: boolean;
} {
  const inProgress: string[] = [];
  for (const s of summaryMap.values()) {
    if (s.lastTransition?.to === "in_progress") inProgress.push(s.taskKey);
  }
  return {
    activeTaskKeyAtStart: inProgress.length === 1 ? inProgress[0] : undefined,
    activeAmbiguousAtStart: inProgress.length > 1,
  };
}

// 記帳キーの stability は R3.1: task: 系 = stable / todo: 系 = content-derived
function bookkeepingStability(taskKey: string): IdentityStability {
  if (taskKey.startsWith("task:pending:")) return "heuristic";
  return taskKey.startsWith("task:") ? "stable" : "content-derived";
}

// tool_call_finished（非エラー）で記帳を適用する。reducer と同じ規律
// （work-model.ts: `if (!e.isError) applyTaskIntent(...)`）。開始時点適用にすると
// 失敗・未完了の記帳が EvidenceIndex にだけ残り、live↔history の遷移集合が割れる
function applyIntentAtFinish(
  index: SemanticEvidenceIndex,
  event: Extract<NormalizedEvent, { kind: "tool_call_finished" }>,
  intent: TaskIntent
): SemanticEvidenceIndex {
  const toolUseId = event.toolUseId;
  const timestamp = event.timestamp;
  const evidenceRef: EvidenceRef = { toolUseId, seq: event.seq };
  const summaryMap = cloneSummaries(index);
  const newTransitions: TodoTransition[] = [];
  const recordTransition = makeTransitionRecorder(summaryMap, newTransitions, timestamp, evidenceRef);

  const taskKeysFromIntent: string[] = [];
  if (intent.kind === "todo") {
    const currentKeys = new Set(intent.items.map((i) => i.taskKey));
    // TodoWrite はレベル信号: 配列から消えた todo を失効させないと in_progress が
    // 滞留し、activeAmbiguous が立ちっぱなしになる（reducer applyTodoIntent と同じ規律）
    for (const s of summaryMap.values()) {
      if (
        s.taskKey.startsWith("todo:") &&
        !currentKeys.has(s.taskKey) &&
        s.lastTransition !== undefined &&
        s.lastTransition.to !== "unknown"
      ) {
        recordTransition(s.taskKey, "unknown");
      }
    }
    for (const item of intent.items) {
      taskKeysFromIntent.push(item.taskKey);
      recordTransition(item.taskKey, item.status);
    }
  } else if (intent.kind === "create") {
    const taskKey = taskCreateKeyFromResult(intent.toolUseId, event.resultPreview ?? "");
    taskKeysFromIntent.push(taskKey);
    recordTransition(taskKey, intent.status);
  } else if (intent.kind === "update") {
    taskKeysFromIntent.push(intent.taskKey);
    if (intent.deleted) {
      recordTransition(intent.taskKey, "unknown");
    } else if (intent.status !== undefined) {
      recordTransition(intent.taskKey, intent.status);
    }
  }

  // 記帳キーの binding 集約
  const updatedBindings: TaskIdentityBinding[] = index.bindings.map((b) => ({
    ...b,
    taskKeys: [...b.taskKeys],
    evidence: [...b.evidence],
  }));
  for (const k of taskKeysFromIntent) {
    const binding = updatedBindings.find((b) => b.taskKeys.includes(k));
    if (binding) {
      if (!binding.evidence.some((e) => e.toolUseId === toolUseId)) {
        binding.evidence.push(evidenceRef);
      }
    } else {
      updatedBindings.push({
        semanticTaskId: k,
        taskKeys: [k],
        stability: bookkeepingStability(k),
        evidence: [evidenceRef],
      });
    }
  }

  let todoTransitions = [...index.todoTransitions, ...newTransitions];
  let droppedTodo = 0;
  if (todoTransitions.length > MAX_TODO_TRANSITIONS) {
    droppedTodo = todoTransitions.length - MAX_TODO_TRANSITIONS;
    todoTransitions = todoTransitions.slice(droppedTodo);
  }
  const pendingIntents = { ...index.pendingIntents };
  delete pendingIntents[toolUseId];

  return {
    ...index,
    bindings: updatedBindings,
    todoTransitions,
    transitionSummaries: Array.from(summaryMap.values()),
    coverage: { ...index.coverage, todoTransitions: index.coverage.todoTransitions + droppedTodo },
    hash: "",
    pendingIntents,
  };
}

// gap の端点分類（裁定A3）:
// - canEnd=false: この時点で終わる間隔を longGap にしない。tool_call_finished（tool_result 隣接は model gap ではない）と、
//   承認・質問の人間応答区間（AskUserQuestion/ExitPlanMode/権限承認。その tool_result が canEnd=false）を除外する
// - canStart=false: この時点から始まる間隔を longGap にしない
// - null: 走査に関与しない。取得経路の片方にしか現れない kind（api_retry /
//   permission_denied / subagent_info / turn_interrupted / turn_failed は live のみ）を
//   混ぜると走査対象の集合が経路依存になるため。sidechain 由来の
//   tool_call も同じ理由と analysis.ts sessionAnalyzer の isSidechain 除外に合わせて外す
//
// approval_request / approval_resolved は live にしか無いが走査へ残す（裁定 r1 M2）:
// どちらも canEnd=false・canStart=false であり、観測される順序は tool_call_started →
// approval_request → approval_resolved → tool_call_finished。この順序である限り
// history 側の同区間（started…finished）の判定と結果が一致する。tool_call_finished を
// 伴わずに承認が終わる経路があれば live 側だけ gap を抑止する（未確認の残余）
function classifyGapEvent(
  event: NormalizedEvent,
  openSidechainToolUseIds: readonly string[]
): { canEnd: boolean; canStart: boolean; turnId: string | null } | null {
  switch (event.kind) {
    case "assistant_text_delta":
      return { canEnd: true, canStart: true, turnId: event.turnId ?? null };
    case "tool_call_started":
      if (event.parentToolUseId != null) return null;
      return { canEnd: true, canStart: true, turnId: event.turnId ?? null };
    case "turn_completed":
      return { canEnd: true, canStart: false, turnId: event.turnId ?? null };
    case "turn_started":
    case "user_message":
      return { canEnd: false, canStart: true, turnId: event.turnId ?? null };
    case "tool_call_finished":
      if (openSidechainToolUseIds.includes(event.toolUseId)) return null;
      return { canEnd: false, canStart: false, turnId: event.turnId ?? null };
    case "approval_request":
      return { canEnd: false, canStart: false, turnId: event.turnId ?? null };
    case "approval_resolved":
      return { canEnd: false, canStart: false, turnId: null };
    default:
      return null;
  }
}

function nextOpenSidechain(
  open: readonly string[],
  event: NormalizedEvent
): readonly string[] {
  if (event.kind === "tool_call_started") {
    if (event.parentToolUseId == null || open.includes(event.toolUseId)) return open;
    const added = [...open, event.toolUseId];
    return added.length > MAX_OPEN_SIDECHAIN_TOOLS
      ? added.slice(added.length - MAX_OPEN_SIDECHAIN_TOOLS)
      : added;
  }
  if (event.kind === "tool_call_finished") {
    const i = open.indexOf(event.toolUseId);
    if (i < 0) return open;
    return [...open.slice(0, i), ...open.slice(i + 1)];
  }
  return open;
}

// 側チャネルで届いた境界（イベントを生まないレコード）を走査へ適用する。
// canEnd=false / canStart=false 相当 — そこで終わる間隔も始まる間隔も gap にしない。
//
// 時刻が巻き戻る境界を捨ててはいけない（r2 M-1）: live の境界時刻は
// task_updated.patch.end_time（委任先の完了時刻）、history は注入レコードの到着時刻で、
// 遅延配送では lastAt より前になりうる。捨てると live だけ longGap が出る。
// lastAt は max でクランプして単調性を保ち、抑止だけは必ず適用する
function applyGapBoundaries(scan: GapScanState, boundaries: readonly number[]): GapScanState {
  let next = scan;
  for (const at of boundaries) {
    // 走査開始前の境界だけは効果が無い（閉じる相手の間隔が存在しない）
    if (next.lastAt === undefined) continue;
    next = { ...next, lastAt: Math.max(next.lastAt, at), lastCanStart: false };
  }
  return next;
}

function foldGapScan(
  index: SemanticEvidenceIndex,
  event: NormalizedEvent,
  gapBoundaries?: readonly number[]
): SemanticEvidenceIndex {
  let scan =
    gapBoundaries !== undefined && gapBoundaries.length > 0
      ? applyGapBoundaries(index.gapScan, gapBoundaries)
      : index.gapScan;

  // 引数なしコマンドラッパ（/model 等）は live にだけ user_message として届き、history は
  // 同じレコードから境界時刻しか出さない（裁定C2）。イベントとして分類せず境界へ落とすことで、
  // live の turnId=null による走査リセットを起こさず history と同一の状態遷移にする
  if (event.kind === "user_message" && isPureCommandWrapper(event.text)) {
    scan = applyGapBoundaries(scan, [event.timestamp]);
    const open = nextOpenSidechain(scan.openSidechainToolUseIds, event);
    if (scan === index.gapScan && open === scan.openSidechainToolUseIds) return index;
    return { ...index, gapScan: { ...scan, openSidechainToolUseIds: open } };
  }

  const cls = classifyGapEvent(event, scan.openSidechainToolUseIds);
  const openSidechainToolUseIds = nextOpenSidechain(scan.openSidechainToolUseIds, event);
  if (cls === null) {
    if (openSidechainToolUseIds === scan.openSidechainToolUseIds && scan === index.gapScan) {
      return index;
    }
    return { ...index, gapScan: { ...scan, openSidechainToolUseIds } };
  }

  const ts = event.timestamp;
  let recorded: LongGapRecord | undefined;
  let nextScan: GapScanState;

  const sameTurn =
    cls.turnId !== null && scan.lastTurnId === cls.turnId && scan.lastAt !== undefined;
  if (sameTurn) {
    if (cls.canEnd && scan.lastCanStart && ts - scan.lastAt! >= IDLE_GAP_MS) {
      recorded = { at: scan.lastAt!, durationMs: ts - scan.lastAt! };
    }
    nextScan = {
      lastAt: ts,
      lastTurnId: scan.lastTurnId,
      lastCanStart: cls.canStart,
      openSidechainToolUseIds,
    };
  } else if (cls.turnId === null && event.kind !== "user_message" && scan.lastAt !== undefined) {
    // turn 帰属を持たない補助イベント（approval_resolved・turnId 欠落の入力）:
    // 進行中ターンの時刻だけ進め、そこから始まる間隔は gap にしない
    nextScan = {
      lastAt: ts,
      lastTurnId: scan.lastTurnId,
      lastCanStart: false,
      openSidechainToolUseIds,
    };
  } else {
    nextScan = {
      lastAt: ts,
      lastTurnId: cls.turnId,
      lastCanStart: cls.canStart,
      openSidechainToolUseIds,
    };
  }

  // 境界とイベントが同一 ms のとき（corpus に実在）、境界を先に適用しただけでは
  // 直後にイベントが lastCanStart を上書きして抑止が消える。注入レコードと同時刻の境界は、以後の間隔も止める（r2 L-1）
  if (gapBoundaries !== undefined && gapBoundaries.some((at) => at >= ts)) {
    nextScan = { ...nextScan, lastCanStart: false };
  }

  if (recorded === undefined) return { ...index, gapScan: nextScan };
  let longGaps = [...index.longGaps, recorded];
  let droppedMs = 0;
  let droppedCount = 0;
  if (longGaps.length > MAX_LONG_GAPS) {
    droppedCount = longGaps.length - MAX_LONG_GAPS;
    for (let i = 0; i < droppedCount; i++) droppedMs += longGaps[i].durationMs;
    longGaps = longGaps.slice(droppedCount);
  }
  // hash は据え置く: longGaps も coverage も hashProjection 外なので、既に算出済みの
  // 値（history 復元時に extension.ts が入れる）は gap 記録では無効化されない
  return {
    ...index,
    longGaps,
    droppedLongGapMs: index.droppedLongGapMs + droppedMs,
    coverage: { ...index.coverage, longGaps: index.coverage.longGaps + droppedCount },
    gapScan: nextScan,
  };
}

// gap 走査は本体の後に置く: foldEvidenceBody が throw したときに、記録済み gap を
// 失ったまま lastAt だけ進んだ index を残さない
export function foldEvidence(
  index: SemanticEvidenceIndex,
  event: NormalizedEvent,
  hostArtifacts?: HostArtifactAccess[],
  gapBoundaries?: readonly number[]
): SemanticEvidenceIndex {
  const folded = foldGapScan(foldEvidenceBody(index, event, hostArtifacts), event, gapBoundaries);
  const timeBuckets = foldTimeBuckets(index.timeBuckets, event);
  const execLogMarks = foldExecLogMarks(index.execLogMarks, event);
  if (timeBuckets === index.timeBuckets && execLogMarks === index.execLogMarks) return folded;
  return { ...folded, timeBuckets, execLogMarks };
}

function foldEvidenceBody(
  index: SemanticEvidenceIndex,
  event: NormalizedEvent,
  hostArtifacts?: HostArtifactAccess[]
): SemanticEvidenceIndex {
  if (event.kind === "tool_call_finished") {
    let next = index;
    const pending = index.pendingIntents[event.toolUseId];
    if (pending) {
      if (event.isError) {
        const pendingIntents = { ...index.pendingIntents };
        delete pendingIntents[event.toolUseId];
        next = { ...index, pendingIntents };
      } else {
        next = applyIntentAtFinish(index, event, pending.intent);
      }
    }
    const di = next.delegations.findIndex((d) => d.toolUseId === event.toolUseId);
    if (di >= 0) {
      if (event.asyncLaunchedAgentId !== undefined && !event.isError) {
        // 裁定A2: async 起動ACKは完了ではない。endedAt は task-notification でのみ確定する
        if (next.delegations[di].transcriptAgentId !== event.asyncLaunchedAgentId) {
          const delegations = [...next.delegations];
          delegations[di] = { ...delegations[di], transcriptAgentId: event.asyncLaunchedAgentId };
          next = { ...next, delegations, hash: "" };
        }
      } else if (
        next.delegations[di].endedAt === undefined &&
        (next.delegations[di].isBackground !== true || event.isError === true)
      ) {
        const delegations = [...next.delegations];
        delegations[di] = { ...delegations[di], endedAt: event.timestamp };
        next = { ...next, delegations, hash: "" };
      }
    }
    // reopen（裁定⑧/A1: SendMessage の成功結果でのみ確定）
    if (event.resumedAgentId !== undefined && !event.isError) {
      const ri = next.delegations.findIndex((d) => d.transcriptAgentId === event.resumedAgentId);
      if (ri >= 0) {
        const delegations = [...next.delegations];
        const d = delegations[ri];
        delegations[ri] = {
          ...d,
          endedAt: undefined,
          reopens: [...(d.reopens ?? []), { at: event.timestamp }],
        };
        next = { ...next, delegations, hash: "" };
      }
    }
    // re-close（裁定A2: task-notification が async 委任の完了信号。同一 task-id は複数回通知
    // されうるため、開いているときだけ閉じる）
    if (event.taskNotification !== undefined) {
      const ni = next.delegations.findIndex(
        (d) => d.transcriptAgentId === event.taskNotification!.agentId
      );
      if (ni >= 0 && next.delegations[ni].endedAt === undefined) {
        const delegations = [...next.delegations];
        delegations[ni] = { ...delegations[ni], endedAt: event.timestamp };
        next = { ...next, delegations, hash: "" };
      }
    }
    return next;
  }

  if (event.kind === "user_message") {
    // 引数なしコマンドラッパは history 側では user_message を生まない。live だけが
    // R6b cause の「直前の人間発言」と Goal title を得るのは経路差なので揃える（裁定C6）
    if (isPureCommandWrapper(event.text)) {
      return index;
    }
    let humanMessageTimes = [...index.humanMessageTimes, event.timestamp];
    if (humanMessageTimes.length > MAX_HUMAN_MESSAGE_TIMES) {
      humanMessageTimes = humanMessageTimes.slice(humanMessageTimes.length - MAX_HUMAN_MESSAGE_TIMES);
    }
    // R1: Goal title = 最初の人間発言の1行目。humanMessageTimes と同じく hash 射影外
    let firstHumanMessageLine = index.firstHumanMessageLine;
    let firstHumanMessageText = index.firstHumanMessageText;
    if (firstHumanMessageLine === undefined && typeof event.text === "string" && event.text.trim() !== "") {
      firstHumanMessageText = redactAbsolutePaths(event.text.trim()).slice(0, 2000);
      firstHumanMessageLine = event.text.trim().split(/\r?\n/, 1)[0].slice(0, 200);
    }
    return { ...index, humanMessageTimes, firstHumanMessageLine, firstHumanMessageText, hash: "" };
  }

  if (event.kind !== "tool_call_started") {
    return index;
  }

  const toolUseId = event.toolUseId;
  const parentToolUseId = event.parentToolUseId ?? null;
  const timestamp = event.timestamp;
  const seq = event.seq;

  const summaryMap = cloneSummaries(index);
  const { activeTaskKeyAtStart, activeAmbiguousAtStart } = activeTaskState(summaryMap);

  // 記帳 intent は finished（非エラー）まで待機
  let pendingIntents = index.pendingIntents;
  if (event.taskIntentStructured) {
    pendingIntents = { ...pendingIntents, [toolUseId]: { intent: event.taskIntentStructured } };
    const keys = Object.keys(pendingIntents);
    if (keys.length > MAX_PENDING_INTENTS) {
      const trimmed = { ...pendingIntents };
      for (const k of keys.slice(0, keys.length - MAX_PENDING_INTENTS)) delete trimmed[k];
      pendingIntents = trimmed;
    }
  }

  // 委任判定（delegation フィールド・vocab.delegate をフラットに OR。
  // 開始時点判定のため構造判定は使えない）
  const isDelegation =
    event.delegation !== undefined ||
    event.subagentType !== undefined ||
    CLAUDE_VOCABULARY.delegate.has(event.toolName);

  let newDelegation: DelegationRecord | undefined;
  if (isDelegation) {
    newDelegation = {
      agentId: `agent:${toolUseId}`,
      toolUseId,
      parentToolUseId,
      agentType: event.delegation?.subagentType ?? event.subagentType,
      ...(event.delegation?.description !== undefined ? { description: event.delegation.description } : {}),
      activeTaskKeyAtStart,
      activeAmbiguousAtStart,
      startedAt: timestamp,
      ...(event.delegation?.isBackground === true ? { isBackground: true as const } : {}),
      evidence: {
        toolUseId,
        seq,
        agentId: `agent:${toolUseId}`,
      },
    };
  }

  const updatedBindings: TaskIdentityBinding[] = index.bindings.map((b) => ({
    ...b,
    taskKeys: [...b.taskKeys],
    evidence: [...b.evidence],
  }));

  // hostArtifacts / effectGaps
  const newArtifactAccesses: ArtifactAccessRecord[] = [];
  if (hostArtifacts && hostArtifacts.length > 0) {
    const ownerAgentId = parentToolUseId ? `agent:${parentToolUseId}` : undefined;
    for (const art of hostArtifacts) {
      newArtifactAccesses.push({
        canonicalPath: art.canonicalPath,
        artifactId: art.artifactId,
        mode: art.mode,
        toolUseId,
        ownerAgentId,
        at: timestamp,
      });
    }
  }

  const newEffectGaps: EffectGapRecord[] = [];
  if (event.effectCoverage === "partial" || event.effectCoverage === "unavailable") {
    const ownerAgentId = parentToolUseId ? `agent:${parentToolUseId}` : undefined;
    newEffectGaps.push({
      toolUseId,
      ownerAgentId,
      at: timestamp,
      coverage: event.effectCoverage,
    });
  }

  // 配列結合と上限（Capacities）の適用
  const todoTransitions = index.todoTransitions;
  let delegations = newDelegation ? [...index.delegations, newDelegation] : index.delegations;
  let artifactAccesses = [...index.artifactAccesses, ...newArtifactAccesses];
  let effectGaps = [...index.effectGaps, ...newEffectGaps];

  let droppedDelegations = 0;
  if (delegations.length > MAX_DELEGATIONS) {
    droppedDelegations = delegations.length - MAX_DELEGATIONS;
    delegations = delegations.slice(droppedDelegations);
  }

  let droppedArtifacts = 0;
  if (artifactAccesses.length > MAX_ARTIFACT_ACCESSES) {
    droppedArtifacts = artifactAccesses.length - MAX_ARTIFACT_ACCESSES;
    artifactAccesses = artifactAccesses.slice(droppedArtifacts);
  }

  let droppedGaps = 0;
  if (effectGaps.length > MAX_EFFECT_GAPS) {
    droppedGaps = effectGaps.length - MAX_EFFECT_GAPS;
    effectGaps = effectGaps.slice(droppedGaps);
  }

  const coverage: EvidenceCoverage = {
    todoTransitions: index.coverage.todoTransitions,
    delegations: index.coverage.delegations + droppedDelegations,
    artifactAccesses: index.coverage.artifactAccesses + droppedArtifacts,
    effectGaps: index.coverage.effectGaps + droppedGaps,
    longGaps: index.coverage.longGaps,
  };

  // pp1 progress。所有照合は fold 時点の delegations に対する温存判定
  // （fold は seq 順のため、emission 時点で endedAt 未確定 = その時点で未終了と同値）
  let progressTransitions = index.progressTransitions;
  let invalidProgressCount = index.invalidProgressCount;
  if (event.toolName === PROGRESS_WIRE_TOOL_NAME) {
    const pe = event.progressEmission;
    if (pe === undefined) {
      invalidProgressCount = invalidProgressCount + 1;
    } else {
      const emitter = parentToolUseId ? `agent:${parentToolUseId}` : undefined;
      const inWindow = (d: DelegationRecord) =>
        d.agentId === emitter && isAssignmentActiveAt(d, timestamp, index.progressTransitions);
      // taskless 逆引き: emitter + 時間包含が exactly 1 で emission 時点までに reopen が無い
      // 場合だけ Assignment へ束縛する。reopen 後は同一 AgentRun が別 Task を扱いえるため継承しない。
      // 0件・複数・reopen 後は非確定とし、推測（latest-wins 等）を一切行わない
      const scoped = emitter === undefined ? [] : delegations.filter(inWindow);
      const only = scoped.length === 1 ? scoped[0] : undefined;
      const reopenedBefore = only?.reopens?.some((r) => r.at <= timestamp) === true;
      const candidates: DelegationRecord[] = only !== undefined && !reopenedBefore ? [only] : [];
      const ownershipVerified = candidates.length >= 1;
      const resolvedAssignmentRef =
        candidates.length === 1 ? `${candidates[0].agentId}@${candidates[0].startedAt}` : undefined;
      const rec: ProgressTransitionRecord = {
        state: pe.state,
        at: timestamp,
        toolUseId,
        ...(emitter !== undefined ? { agentId: emitter } : {}),
        ownershipVerified,
        ...(resolvedAssignmentRef !== undefined ? { resolvedAssignmentRef } : {}),
        ...(pe.activity !== undefined ? { activity: pe.activity } : {}),
        ...(pe.blocker !== undefined ? { blocker: pe.blocker } : {}),
        ...(pe.evidence !== undefined ? { evidenceDecl: pe.evidence } : {}),
        ...(pe.next !== undefined ? { next: pe.next } : {}),
      };
      progressTransitions = [...progressTransitions, rec];
      if (progressTransitions.length > MAX_PROGRESS_TRANSITIONS) {
        progressTransitions = progressTransitions.slice(progressTransitions.length - MAX_PROGRESS_TRANSITIONS);
      }
    }
  }

  return {
    bindings: updatedBindings,
    todoTransitions,
    transitionSummaries: index.transitionSummaries,
    delegations,
    humanMessageTimes: index.humanMessageTimes,
    firstHumanMessageLine: index.firstHumanMessageLine,
    firstHumanMessageText: index.firstHumanMessageText,
    timeBuckets: index.timeBuckets,
    execLogMarks: index.execLogMarks,
    longGaps: index.longGaps,
    droppedLongGapMs: index.droppedLongGapMs,
    gapScan: index.gapScan,
    artifactAccesses,
    effectGaps,
    coverage,
    hash: "",
    progressTransitions,
    invalidProgressCount,
    pendingIntents,
  };
}

export function assignmentRefOf(d: DelegationRecord): string {
  return `${d.agentId}@${d.startedAt}`;
}

// Assignment の有効期間: 開始 = startedAt、終了 = min(endedAt 確定値,
// 当該 Assignment scoped の done 遷移時点)。background 委任は endedAt が恒久未確定になりうるため
// done emission による closure が無いと有効判定が閉じない。
// この述語を明示照合・taskless 逆引き・Task 集約の3箇所で共用する（別述語を作らない）
export function isAssignmentActiveAt(
  d: DelegationRecord,
  at: number,
  transitions: readonly ProgressTransitionRecord[]
): boolean {
  if (d.startedAt > at) return false;
  if (d.endedAt !== undefined && at > d.endedAt) return false;
  const ref = assignmentRefOf(d);
  for (const t of transitions) {
    if (t.state !== "done") continue;
    if (t.resolvedAssignmentRef !== ref) continue;
    if (t.at <= at) return false;
  }
  return true;
}

// Assignment-level の pp1 state。done は投影しない: done を emit した
// Assignment は有効集合から外れるため到達不能。Task 完了は observed 側の責務
export type AssignmentProgressState = "active" | "blocked" | "review";

export function deriveAssignmentProgressStates(index: SemanticEvidenceIndex): Record<string, AssignmentProgressState> {
  const refOf = assignmentRefOf;
  const scoped = new Map<string, ProgressState>();
  for (const t of index.progressTransitions) {
    if (!t.ownershipVerified) continue;
    if (t.resolvedAssignmentRef === undefined) continue;
    scoped.set(t.resolvedAssignmentRef, t.state);
  }
  // 評価時点は progress emission と Assignment lifecycle（startedAt / endedAt）を含む最新観測点の直後
  // （isAssignmentActiveAt は端点包含のため horizon そのものにしない）
  let horizon = 0;
  for (const t of index.progressTransitions) if (t.at > horizon) horizon = t.at;
  for (const d of index.delegations) {
    if (d.startedAt > horizon) horizon = d.startedAt;
    if (d.endedAt !== undefined && d.endedAt > horizon) horizon = d.endedAt;
  }
  const evaluatedAt = horizon + 1;
  const out: Record<string, AssignmentProgressState> = {};
  for (const d of index.delegations) {
    if (!isAssignmentActiveAt(d, evaluatedAt, index.progressTransitions)) continue;
    const st = scoped.get(refOf(d));
    if (st === "active" || st === "blocked" || st === "review") {
      out[progressSubjectKey(`attempt:${d.toolUseId}`)] = st;
    }
  }
  return out;
}

// hash 入力は明示射影で作る。汎用のキー名一致で落とすと、EffectGapRecord.coverage
// （unknownEffects の唯一の観測根拠）のような同名の意味フィールドまで消え、
// live/history の差に盲目な hash になる
function hashProjection(index: SemanticEvidenceIndex): unknown {
  const ref = (e: EvidenceRef) => ({ toolUseId: e.toolUseId, agentId: e.agentId });
  return {
    bindings: index.bindings.map((b) => ({
      semanticTaskId: b.semanticTaskId,
      taskKeys: [...b.taskKeys].sort(),
      stability: b.stability,
      evidence: b.evidence.map(ref),
    })),
    todoTransitions: index.todoTransitions.map((t) => ({
      taskKey: t.taskKey, from: t.from, to: t.to, at: t.at, evidence: ref(t.evidence),
    })),
    transitionSummaries: [...index.transitionSummaries]
      .sort((a, b) => (a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0))
      .map((s) => ({
        taskKey: s.taskKey,
        reopenCount: s.reopenCount,
        completedCount: s.completedCount,
        lastTransition: s.lastTransition
          ? {
              taskKey: s.lastTransition.taskKey,
              from: s.lastTransition.from,
              to: s.lastTransition.to,
              at: s.lastTransition.at,
              evidence: ref(s.lastTransition.evidence),
            }
          : undefined,
        firstStartedAt: s.firstStartedAt,
      })),
    delegations: index.delegations.map((d) => ({
      agentId: d.agentId,
      toolUseId: d.toolUseId,
      parentToolUseId: d.parentToolUseId,
      agentType: d.agentType,
      description: d.description,
      activeTaskKeyAtStart: d.activeTaskKeyAtStart,
      activeAmbiguousAtStart: d.activeAmbiguousAtStart,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      transcriptAgentId: d.transcriptAgentId,
      reopens: d.reopens?.map((r) => ({ at: r.at })),
      evidence: ref(d.evidence),
    })),
    artifactAccesses: index.artifactAccesses.map((a) => ({
      canonicalPath: a.canonicalPath, artifactId: a.artifactId, mode: a.mode,
      toolUseId: a.toolUseId, ownerAgentId: a.ownerAgentId, at: a.at,
    })),
    effectGaps: index.effectGaps.map((g) => ({
      toolUseId: g.toolUseId, ownerAgentId: g.ownerAgentId, at: g.at, coverage: g.coverage,
    })),
    // humanMessageTimes は hash に含めない: live の user_message は Host 送信側で
    // 生成され record 時刻との同値保証が無い（R6b の「直前」判定用の補助入力であり
    // 同一性データではない — coverage と同じ扱い）
    // longGaps / droppedLongGapMs / gapScan も同理由で非入力（裁定A3）。
    // 足すと evidenceHash が変わる。モデル出力へは効くので
    // semantic-model.ts の semanticHash 側の入力列には含める
  };
}

function canonicalizeForHash(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const canonicalItem = canonicalizeForHash(item);
      if (canonicalItem !== undefined) {
        items.push(canonicalItem);
      }
    }
    return items;
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const result: Record<string, unknown> = {};
  let hasProperties = false;

  for (const k of keys) {

    const val = source[k];
    const canonicalVal = canonicalizeForHash(val);
    if (canonicalVal !== undefined) {
      result[k] = canonicalVal;
      hasProperties = true;
    }
  }

  if (!hasProperties) {
    return undefined;
  }
  return result;
}

function stringifyCanonical(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stringifyCanonical(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) {
      entries.push(JSON.stringify(k) + ":" + stringifyCanonical(v));
    }
  }
  return "{" + entries.join(",") + "}";
}

export function evidenceIndexHash(index: SemanticEvidenceIndex): string {
  const canonical = canonicalizeForHash(hashProjection(index));
  const json = canonical !== undefined ? stringifyCanonical(canonical) : "{}";
  return createHash("sha256").update(json).digest("hex");
}
