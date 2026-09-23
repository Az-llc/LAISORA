import type { NormalizedEvent } from "./protocol.js";
import * as l10n from "@vscode/l10n";
import { isRequestMessageText } from "./time-buckets";
import { parseMarkdown } from "./webview/markdown-ast";
import { findCommitBoundary, recordSeparator } from "./webview/commit-boundary";

export const MAX_PHASES = 256;

// 上限に達したときに捨ててよいのは詳細（segment・agent記録・turn/segment参照・task記録・
// 未終了ツールの配置）だけで、件数・失敗数・経過時間・tokens・running/stale は必ず
// phase / rollup の集計（WorkTotals）へ残す。捨てたことは coverage へ出す。
const MAX_SEGMENTS = 512;
const MAX_PHASE_REFS = 64;
const MAX_PHASE_AGENTS = 64;
const MAX_TASKS = 256;
// 未終了ツールの配置は遅延完了の帰属先そのもので、捨てると集計を戻せない。上限は実運用で
// 届かない値にし、複製コストはバケット分割で抑える（単一 record を毎イベント丸ごと複製しない）
const MAX_TRACKED_TOOL_USES = 8192;
const PLACEMENT_BUCKETS = 64;
// 未解決の承認は CLI が応答を待つため実運用では同時に数件。上限は保険で、超えたときは
// 最古の requestId の記録と件数を同時に外す。件数だけ残すと、その要求が解決しても
// どの phase から引くか決められず永久に承認待ちのまま畳めなくなる
const MAX_TRACKED_APPROVALS = 256;

export type OperationKind = "observe" | "mutate" | "verify" | "delegated" | "neutral" | "unknown";
export type PhaseOperation = "unknown" | "delegated" | "observe" | "mutate" | "verify";
export type FallbackOperation = "unknown" | "observe" | "mutate" | "verify";
export type TaskStatus = "pending" | "in_progress" | "completed" | "unknown";
export type WorkStatus = "running" | "completed" | "failed" | "stale" | "unknown";

export interface WorkCoverage {
  summary: "complete" | "prefix-truncated";
  details: "complete" | "prefix-truncated";
  source: "live" | "provider-transcript" | "event-tail";
  droppedEventCount?: number;
  omittedMessageCount?: number;
  omittedToolCount?: number;
  // 上限で追跡をやめた承認要求。件数側からも外しているので、ここに出ない限り
  // pendingApprovalCount は追跡中の未解決要求と一致する
  untrackedApprovalCount?: number;
  // 通知を待っていた背景タスクを placement の上限退避で追跡できなくなった件数。退避後の通知は
  // 完了と断言しない（集計に入らない。完了済みの退避は数えない）
  untrackedBackgroundCount?: number;
  // resume で meta / transcript を読めなかったサブエージェント
  unreadableAgentCount?: number;
  // history 全量パースで欠落した子 transcript 相当の論理単位（上限超過・読取失敗した
  // ファイル1件につき+1。inline sidechain を捨てて子ファイルも読めなかった場合は+1）
  omittedTranscriptCount?: number;
  // 木の深さ上限で親子の辺を捨て「階層未確認」へ回した件数
  depthLimitedAgentCount?: number;
  // summary を "prefix-truncated" へ倒した原因。どれも無いとき webview は reducer 自身の
  // 上限退避（最古の task / placement を捨てた）と読み「先頭の作業は集計外」と書く。
  // 新しい原因で summary だけ倒すと画面がその断定へ戻る（R-DSP-01。G-COV-7）
  // subagents/ の一覧または meta が読めず agent 木が欠けた
  hierarchyIncomplete?: true;
  // reduceWorkModel が例外を投げて捨てたイベント件数
  reducerErrorCount?: number;
  // resume の全量走査が終わっていない（loading）／失敗した（failed）。live 分だけの集計
  hydrationUnconfirmed?: "loading" | "failed";
  // 親 transcript の読み取りが途中で失敗した（それ以降のイベントは無い）
  historyReadError?: string;
  // 親 transcript で JSON として読めなかった行数
  historyMalformedLineCount?: number;
  // Task ツールの入力を解釈できず配置しなかった件数
  unparsedTaskInputCount?: number;
  // 証拠索引（foldEvidence）が例外で捨てたイベント件数。summary の件数は減らない（reducer は通っている）が、
  // 状況・L3・LLM 入力・Inspector の根拠からは欠ける。Host の Session がイベント fold 時に立てる
  evidenceFoldErrorCount?: number;
  // 状況（semantic）の導出が例外で失敗した。stale = 状況タブは最後に成功した時点のまま、
  // unavailable = 一度も出せていない。Host の Session が射影時に立て、導出が成功した payload には付かない
  semanticDerivationFailed?: "stale" | "unavailable";
  phaseHistory: "complete" | "prefix-compacted";
  compactedPhaseCount: number;
}

export type WorkPhaseState = "approval" | "failed" | "running" | "stale" | "done";

// phase の実行状態はここだけで決める。renderer や projection で件数から
// 組み立て直すと、ターンが終わっている phase を「実行中」と表示する分岐が復活する。
// currentPhaseId はターン終端で解除しない（次ターンの作業を同じ phase へ戻すため）ので、
// 現在フェーズかどうかだけでは実行中を判定できない
export function phaseStateOf(totals: WorkTotals, isCurrent: boolean, turnActive: boolean): WorkPhaseState {
  if (totals.pendingApprovalCount > 0) return "approval";
  if (totals.failCount > 0 || totals.childFailCount > 0) return "failed";
  if (totals.runningCount > 0 || (totals.backgroundRunningCount ?? 0) > 0) return "running";
  if (isCurrent && turnActive) return "running";
  if (totals.staleCount > 0) return "stale";
  return "done";
}

// phase と rollup が共通で持つ集計面。詳細を退避しても、この面だけは常に維持する
export interface WorkTotals {
  elapsedMs: number;
  toolCount: number;
  failCount: number;
  operationCounts: Record<OperationKind, number>;
  taskCount: number;
  agentCount: number;
  agentTokens: number;
  // agent 配下のツール。phase 直下の toolCount へは入れないが、agent 記録を捨てても失わない
  childToolCount: number;
  childFailCount: number;
  // agent の状態数。ツールの実行中数ではない
  staleCount: number;
  runningCount: number;
  // 背景 Bash（run_in_background）の実行中数。委任ではないので runningCount（agent の状態数）とは別に持つ。
  // phase の実行状態はこれも見る。無いと背景 Bash だけが動く phase が「done」と出る（R-19）
  backgroundRunningCount?: number;
  // 追跡中の未解決な承認要求。上限で追跡をやめた分はここからも外し、
  // coverage.untrackedApprovalCount へ出す（外さないと解決しても減らせず永久に承認待ちになる）
  pendingApprovalCount: number;
  revision: number;
}

export interface WorkTask {
  taskKey: string;
  description: string;
  // 進行中に出す表現（TodoWrite/TaskCreate の activeForm）。description とは別に持つ
  activeForm?: string;
  status: TaskStatus;
  occurrence: number;
  // 担当phaseがrollupへ併合済み。次に in_progress へ戻ったとき新occurrenceを起こす
  compacted?: boolean;
  revision: number;
}

export interface WorkAgent {
  agentId: string;
  transcriptAgentId?: string;
  parentAgentId: string | null;
  toolUseId: string;
  parentToolUseId: string | null;
  spawnDepth: number;
  agentType?: string;
  description: string;
  modelDeclared?: string;
  modelMeasured?: string;
  effortDeclared?: string;
  effortMeasured?: string;
  status: WorkStatus;
  startedAt: number;
  endedAt?: number;
  elapsedMs: number;
  tokens?: number;
  childCount: number;
  failCount: number;
  revision: number;
}

export interface WorkSegment {
  segmentId: string;
  phaseId: string;
  taskKey?: string;
  turnIds: string[];
  startedAt: number;
  endedAt?: number;
  // 詳細カード1枚分の集計。phase 集計では代用できない（1つの phase が複数の segment を束ねるため、
  // phase の値をカードへ出すと同じ数値が複数カードへ重複して出る）。
  // 数えるのは counted のツールだけ＝agent の子ツールは agent 1件へ含める（二重計上防止）
  toolCount: number;
  failCount: number;
  // agent 配下で失敗した子ツール。phase 側と同じく直下の失敗とは分けて持つ
  childFailCount: number;
  elapsedMs: number;
  runningCount: number;
  staleCount: number;
  revision: number;
}

export interface WorkPhase extends WorkTotals {
  phaseId: string;
  taskKey?: string;
  occurrence?: number;
  operation: PhaseOperation;
  title: string;
  segmentIds: string[];
  segmentCount: number;
  turnIds: string[];
  turnCount: number;
  lastTurnId?: string;
  agents: WorkAgent[];
  startedAt: number;
  endedAt?: number;
}

export interface WorkRollup extends WorkTotals {
  phaseId: "rollup";
  title: string;
  compactedPhaseCount: number;
  startedAt: number;
  endedAt: number;
}

export type PhaseRef = { kind: "phase"; phaseId: string } | { kind: "rollup" };

// 記帳系ツールの意図。状態へ反映するのは成功終了時（失敗した更新は成立していないため）
export type TaskIntent =
  | { kind: "todo"; items: { taskKey: string; description: string; activeForm?: string; status: TaskStatus }[] }
  | { kind: "create"; toolUseId: string; subject: string; activeForm?: string; status: TaskStatus }
  | {
      kind: "update";
      taskKey: string;
      subject?: string;
      activeForm?: string;
      status?: TaskStatus;
      deleted?: boolean;
    };

// 実行中ツールの記録。tool_call_started 時点で配置先を固定し、終了時に現在phase/segmentを
// 一切参照しない。agent の running/stale はこの記録が正本で、
// phase 側の agent 記録が退避されていても集計を戻せる
export interface WorkTool {
  toolUseId: string;
  parentToolUseId: string | null;
  toolName: string;
  description: string;
  operation: OperationKind;
  startedAt: number;
  counted: boolean;
  phaseRef?: PhaseRef;
  segmentId?: string;
  agentId?: string;
  ownerAgentId?: string;
  spawnDepth?: number;
  taskIntent?: TaskIntent;
  stale?: boolean;
  // 起動 ACK が task id を運んだ背景タスク（Agent の async 起動・Bash の run_in_background）。
  // ACK では閉じず、task_notification で閉じる（裁定A2）
  background?: { taskId: string };
  // 起動時に run_in_background が宣言された Agent。ACK 本文が認識できず id が取れなくても
  // 完了として閉じない（L2 の非受理 ACK 縮退と同じ: completed へ漏らさず stale へ落ちる）
  declaredBackground?: true;
  // Agent の reopen（SendMessage 成功）時刻。経過は直近の開始から数える
  resumedAt?: number;
}

// 背景タスクの相関索引。task id → 元の placement。通知は合成 toolUseId で届くので、これ無しでは
// 元の placement を閉じられない。terminal 確定後もエントリを残す（重複通知の無視・Agent の reopen）。
// placement の退避と同時に消す
export interface BackgroundTaskEntry {
  toolUseId: string;
  kind: "agent" | "tool";
  terminal?: "completed" | "failed" | "stale";
  // background_tasks（REPLACE）の集合から消えたが通知は未着。次の turn_started で stale に確定する。
  // 即 stale にしないのは、CLI が background_tasks_changed:[] を通知の 1ms 前に送るため
  pendingStale?: true;
}

// 未終了ツールの索引。毎イベント複製するため、キー空間をバケットへ分けて
// 変更のあった1バケットだけを複製する。参照は findToolPlacement を使う
export interface ToolPlacementIndex {
  buckets: Record<string, WorkTool>[];
  size: number;
}

export interface WorkModelState {
  planDeclaration?: { goal: string; at: number };
  planText?: { turnId: string; text: string; declaredThrough: number; recordEnded?: true };
  planHistory?: PlanHistoryEntry[];
  planHistoryTruncated?: boolean;
  revision: number;
  phases: WorkPhase[];
  rollup?: WorkRollup;
  segments: WorkSegment[];
  tasks: WorkTask[];
  toolPlacements: ToolPlacementIndex;
  // requestId → 承認要求を計上した配置先。approval_resolved は requestId しか持たないので、
  // これが無いとどの phase の件数を戻すか決められない（tool の placement と同じ考え方）
  approvalPlacements: Record<string, PhaseRef>;
  phaseByTaskKey: Record<string, string>;
  runningAgentToolUseIds: string[];
  // 未終了の非agentツール。ターン境界で「実行中」表示を畳むために持つ。agent と分けるのは、
  // 完了済みまで走査すると完了済みの経過時間・tokens が毎ターン消えるため
  runningToolUseIds: string[];
  backgroundTasks: Record<string, BackgroundTaskEntry>;
  activeTaskKey?: string;
  ambiguity?: "multiple-active-tasks";
  // 上限で捨てた in_progress task の数。帰属判定を「1件だけ」と誤らせないために数える
  omittedActiveTaskCount: number;
  fallbackOperation: FallbackOperation;
  // ターンが進行中か。currentPhaseId はターン終端で解除しない（次ターンの作業を同じ phase へ
  // 戻すため）ので、これが無いと終了済みターンの phase を「実行中」と判定してしまう
  turnActive: boolean;
  currentPhaseId?: string;
  currentSegmentId?: string;
  nextPhaseOrdinal: number;
  nextSegmentOrdinal: number;
  // inputPreview が壊れて解釈できなかった記帳/Bash入力の件数。黙って捨てないための観測点
  unparsedInputCount: number;
  coverage: WorkCoverage;
}

export type WorkModel = WorkModelState;
export type PlanHistoryEntry = { at: number; kind: "user" } | {
  at: number; kind: "todos"; source?: "tasks"; created?: boolean; removed?: boolean; items: Extract<TaskIntent, { kind: "todo" }>["items"];
};
export type WorkSignal = Readonly<NormalizedEvent>;

type ToolStartedSignal = Extract<NormalizedEvent, { kind: "tool_call_started" }>;
type ToolFinishedSignal = Extract<NormalizedEvent, { kind: "tool_call_finished" }>;

export interface ToolVocabulary {
  observe: ReadonlySet<string>;
  mutate: ReadonlySet<string>;
  delegate: ReadonlySet<string>;
  task: ReadonlySet<string>;
  shell?: { toolName: string; commandField: string };
  verifyCommands: readonly string[];
}

const OPERATION_KINDS: OperationKind[] = ["observe", "mutate", "verify", "delegated", "neutral", "unknown"];

export const CLAUDE_VOCABULARY: ToolVocabulary = {
  observe: new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]),
  mutate: new Set(["Edit", "Write", "NotebookEdit"]),
  delegate: new Set(["Agent", "Task"]),
  task: new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]),
  shell: { toolName: "Bash", commandField: "command" },
  verifyCommands: [
    "(?:npm|pnpm|yarn|bun) (?:test|run lint)",
    "pytest",
    "python -m pytest",
    "cargo test",
    "go test",
    "dotnet test",
    "ctest",
    "jest",
    "vitest",
    "tsc --noEmit",
    "eslint",
  ],
};

function buildVerifyCommandRegex(commands: readonly string[]): RegExp | null {
  if (commands.length === 0) return null;
  // allowlist 側で \s を使うと改行に一致してしまうため [ \t] と [^\n\r] に限定する
  return new RegExp(`^(?:${commands.join("|")})(?:[ \\t][^\\n\\r]*)?$`);
}

const CLAUDE_VERIFY_COMMAND_RE = buildVerifyCommandRegex(CLAUDE_VOCABULARY.verifyCommands);

// 実測: TaskCreate の結果は 'Task #7 created successfully: <件名>' のプレーンテキスト。
// 入力側に taskId は無い（SDK実測知見.md）。JSON形式にも保険で一致させる
const TASK_CREATE_ID_RE = /Task #(\d+)\b/;
const TASK_CREATE_JSON_ID_RE = /"id"\s*:\s*"?([^",}\s]+)"?/;
// 実測: Agent/Task の結果テキストに含まれるサブエージェント消費量（tab.ts と同一の形）
const SUBAGENT_TOKENS_RE = /subagent_tokens[":\s]*(\d+)/;
// TodoWrite のキー分離子（content に現れない制御文字）
const TODO_KEY_SEPARATOR = "\u001f";

function createOperationCounts(): Record<OperationKind, number> {
  return { observe: 0, mutate: 0, verify: 0, delegated: 0, neutral: 0, unknown: 0 };
}

function createPlacementIndex(): ToolPlacementIndex {
  const buckets: Record<string, WorkTool>[] = [];
  for (let i = 0; i < PLACEMENT_BUCKETS; i++) buckets.push({});
  return { buckets, size: 0 };
}

function bucketOf(toolUseId: string): number {
  let hash = 0;
  for (let i = 0; i < toolUseId.length; i++) hash = (hash * 31 + toolUseId.charCodeAt(i)) | 0;
  return Math.abs(hash) % PLACEMENT_BUCKETS;
}

export function findToolPlacement(state: WorkModelState, toolUseId: string): WorkTool | undefined {
  return state.toolPlacements.buckets[bucketOf(toolUseId)][toolUseId];
}

export function findWorkSegment(state: WorkModelState, segmentId: string | undefined): WorkSegment | undefined {
  return findSegment(state, segmentId);
}

export function toolPlacementCount(state: WorkModelState): number {
  return state.toolPlacements.size;
}

export function createWorkModelState(): WorkModelState {
  return {
    revision: 0,
    phases: [],
    segments: [],
    tasks: [],
    toolPlacements: createPlacementIndex(),
    approvalPlacements: {},
    phaseByTaskKey: {},
    runningAgentToolUseIds: [],
    runningToolUseIds: [],
    backgroundTasks: {},
    omittedActiveTaskCount: 0,
    fallbackOperation: "unknown",
    turnActive: false,
    nextPhaseOrdinal: 1,
    nextSegmentOrdinal: 1,
    unparsedInputCount: 0,
    coverage: {
      summary: "complete",
      details: "complete",
      source: "live",
      phaseHistory: "complete",
      compactedPhaseCount: 0,
    },
  };
}

function parseToolInput(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTaskId(source: Record<string, unknown>): string | undefined {
  const value = source.taskId;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readTaskStatus(value: unknown): TaskStatus | undefined {
  if (value === "pending" || value === "in_progress" || value === "completed") return value;
  return undefined;
}

// シェルの引用符を解釈したうえで、コマンド結合が引用符の外にあるかだけを見る。
// 引用符を無視すると --testNamePattern="foo|bar" のような単一コマンドまで弾く。
// 二重引用符の中でもコマンド置換は実行されるので $( とバッククォートは中でも結合として扱う。
// 引用符が閉じていない（inputPreview の切り詰め）ときは単一コマンドと断定できないため結合扱い
function hasCommandSeparator(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "`") return true;
      if (char === "$" && command[i + 1] === "(") return true;
      continue;
    }
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "&" || char === "|" || char === ";" || char === "\n" || char === "\r") return true;
    if (char === "`") return true;
    if (char === "$" && command[i + 1] === "(") return true;
  }
  return quote !== null;
}

function isVerifyCommand(command: string, vocab: ToolVocabulary): boolean {
  if (command.length === 0 || vocab.verifyCommands.length === 0) return false;
  if (hasCommandSeparator(command)) return false;
  const regex = vocab === CLAUDE_VOCABULARY ? CLAUDE_VERIFY_COMMAND_RE : buildVerifyCommandRegex(vocab.verifyCommands);
  return regex !== null && regex.test(command);
}

export function classifyOperation(signal: WorkSignal, vocab: ToolVocabulary = CLAUDE_VOCABULARY): OperationKind {
  if (signal.kind !== "tool_call_started") return "unknown";
  if (vocab.observe.has(signal.toolName)) return "observe";
  if (vocab.mutate.has(signal.toolName)) return "mutate";
  if (vocab.delegate.has(signal.toolName)) return "delegated";
  if (!vocab.shell || signal.toolName !== vocab.shell.toolName) return "neutral";
  const input = parseToolInput(signal.inputPreview);
  const command = input ? input[vocab.shell.commandField] : undefined;
  if (typeof command !== "string") return "neutral";
  return isVerifyCommand(command, vocab) ? "verify" : "neutral";
}

function phaseTitle(operation: PhaseOperation): string {
  switch (operation) {
    case "observe":
      return l10n.t("Information gathering");
    case "mutate":
      return l10n.t("File updates");
    case "verify":
      return l10n.t("Verification and adjustment");
    case "delegated":
      return l10n.t("Subagent work");
    default:
      return l10n.t("Other work");
  }
}

function fallbackRank(operation: FallbackOperation): number {
  switch (operation) {
    case "observe":
      return 1;
    case "mutate":
      return 2;
    case "verify":
      return 3;
    default:
      return 0;
  }
}

interface Draft {
  next: WorkModelState;
  copiedPhaseIds: Set<string>;
  copiedSegmentIds: Set<string>;
  copiedTaskKeys: Set<string>;
  copiedAgentIds: Set<string>;
  copiedBuckets: Set<number>;
  approvalsCopied: boolean;
  phasesCopied: boolean;
  segmentsCopied: boolean;
  tasksCopied: boolean;
  placementsCopied: boolean;
  phaseByTaskKeyCopied: boolean;
  runningAgentsCopied: boolean;
  runningToolsCopied: boolean;
  backgroundTasksCopied: boolean;
  rollupCopied: boolean;
  coverageCopied: boolean;
}

// 入力stateは共有したまま、書き換える枝だけを複製する。深いコピーへ戻すと 5000件時点で
// 1イベント13.65ms（実測）に戻り Extension Host が止まる
function beginDraft(previousState: WorkModelState): Draft {
  return {
    next: { ...previousState, revision: previousState.revision + 1 },
    copiedPhaseIds: new Set(),
    copiedSegmentIds: new Set(),
    copiedTaskKeys: new Set(),
    copiedAgentIds: new Set(),
    copiedBuckets: new Set(),
    approvalsCopied: false,
    phasesCopied: false,
    segmentsCopied: false,
    tasksCopied: false,
    placementsCopied: false,
    phaseByTaskKeyCopied: false,
    runningAgentsCopied: false,
    runningToolsCopied: false,
    backgroundTasksCopied: false,
    rollupCopied: false,
    coverageCopied: false,
  };
}

// delete 演算子は対象オブジェクトを V8 の dictionary mode へ落とし、以後のコピーが目に見えて
// 遅くなる。この record は毎イベント複製するため、キー削除は必ず再構築で行う
function withoutKey<T>(source: Record<string, T>, omitted: string): Record<string, T> {
  const target: Record<string, T> = {};
  for (const key in source) {
    if (key === omitted) continue;
    target[key] = source[key];
  }
  return target;
}

function findPhaseIndex(phases: readonly WorkPhase[], phaseId: string | undefined): number {
  if (phaseId === undefined) return -1;
  for (let i = phases.length - 1; i >= 0; i--) {
    if (phases[i].phaseId === phaseId) return i;
  }
  return -1;
}

function findPhase(state: WorkModelState, phaseId: string | undefined): WorkPhase | undefined {
  const index = findPhaseIndex(state.phases, phaseId);
  return index < 0 ? undefined : state.phases[index];
}

function findSegment(state: WorkModelState, segmentId: string | undefined): WorkSegment | undefined {
  if (segmentId === undefined) return undefined;
  for (let i = state.segments.length - 1; i >= 0; i--) {
    if (state.segments[i].segmentId === segmentId) return state.segments[i];
  }
  return undefined;
}

function draftPhases(d: Draft): WorkPhase[] {
  if (!d.phasesCopied) {
    d.next.phases = d.next.phases.slice();
    d.phasesCopied = true;
  }
  return d.next.phases;
}

function draftPhase(d: Draft, phaseId: string | undefined): WorkPhase | undefined {
  if (phaseId === undefined) return undefined;
  const phases = draftPhases(d);
  const index = findPhaseIndex(phases, phaseId);
  if (index < 0) return undefined;
  if (!d.copiedPhaseIds.has(phaseId)) {
    const source = phases[index];
    phases[index] = {
      ...source,
      segmentIds: source.segmentIds.slice(),
      turnIds: source.turnIds.slice(),
      agents: source.agents.slice(),
      operationCounts: { ...source.operationCounts },
      revision: d.next.revision,
    };
    d.copiedPhaseIds.add(phaseId);
  }
  return phases[index];
}

function draftAgent(d: Draft, phase: WorkPhase, agentId: string | undefined): WorkAgent | undefined {
  if (agentId === undefined) return undefined;
  const index = phase.agents.findIndex((agent) => agent.agentId === agentId);
  if (index < 0) return undefined;
  if (!d.copiedAgentIds.has(agentId)) {
    phase.agents[index] = { ...phase.agents[index], revision: d.next.revision };
    d.copiedAgentIds.add(agentId);
  }
  return phase.agents[index];
}

function draftSegments(d: Draft): WorkSegment[] {
  if (!d.segmentsCopied) {
    d.next.segments = d.next.segments.slice();
    d.segmentsCopied = true;
  }
  return d.next.segments;
}

function draftSegment(d: Draft, segmentId: string | undefined): WorkSegment | undefined {
  if (segmentId === undefined) return undefined;
  const segments = draftSegments(d);
  const index = segments.findIndex((segment) => segment.segmentId === segmentId);
  if (index < 0) return undefined;
  if (!d.copiedSegmentIds.has(segmentId)) {
    segments[index] = {
      ...segments[index],
      turnIds: segments[index].turnIds.slice(),
      revision: d.next.revision,
    };
    d.copiedSegmentIds.add(segmentId);
  }
  return segments[index];
}

function draftTasks(d: Draft): WorkTask[] {
  if (!d.tasksCopied) {
    d.next.tasks = d.next.tasks.slice();
    d.tasksCopied = true;
  }
  return d.next.tasks;
}

function draftTask(d: Draft, taskKey: string | undefined): WorkTask | undefined {
  if (taskKey === undefined) return undefined;
  const tasks = draftTasks(d);
  const index = tasks.findIndex((task) => task.taskKey === taskKey);
  if (index < 0) return undefined;
  if (!d.copiedTaskKeys.has(taskKey)) {
    tasks[index] = { ...tasks[index], revision: d.next.revision };
    d.copiedTaskKeys.add(taskKey);
  }
  return tasks[index];
}

function draftPlacementIndex(d: Draft): ToolPlacementIndex {
  if (!d.placementsCopied) {
    d.next.toolPlacements = { buckets: d.next.toolPlacements.buckets.slice(), size: d.next.toolPlacements.size };
    d.placementsCopied = true;
  }
  return d.next.toolPlacements;
}

function draftBucket(d: Draft, bucket: number): Record<string, WorkTool> {
  const index = draftPlacementIndex(d);
  if (!d.copiedBuckets.has(bucket)) {
    index.buckets[bucket] = { ...index.buckets[bucket] };
    d.copiedBuckets.add(bucket);
  }
  return index.buckets[bucket];
}

function draftPlacement(d: Draft, toolUseId: string): WorkTool | undefined {
  const bucket = draftBucket(d, bucketOf(toolUseId));
  const placement = bucket[toolUseId];
  if (!placement) return undefined;
  bucket[toolUseId] = { ...placement };
  return bucket[toolUseId];
}

function draftApprovals(d: Draft): Record<string, PhaseRef> {
  if (!d.approvalsCopied) {
    d.next.approvalPlacements = { ...d.next.approvalPlacements };
    d.approvalsCopied = true;
  }
  return d.next.approvalPlacements;
}

function draftPhaseByTaskKey(d: Draft): Record<string, string> {
  if (!d.phaseByTaskKeyCopied) {
    d.next.phaseByTaskKey = { ...d.next.phaseByTaskKey };
    d.phaseByTaskKeyCopied = true;
  }
  return d.next.phaseByTaskKey;
}

function draftRunningAgents(d: Draft): string[] {
  if (!d.runningAgentsCopied) {
    d.next.runningAgentToolUseIds = d.next.runningAgentToolUseIds.slice();
    d.runningAgentsCopied = true;
  }
  return d.next.runningAgentToolUseIds;
}

function draftRunningTools(d: Draft): string[] {
  if (!d.runningToolsCopied) {
    d.next.runningToolUseIds = d.next.runningToolUseIds.slice();
    d.runningToolsCopied = true;
  }
  return d.next.runningToolUseIds;
}

function draftBackgroundTasks(d: Draft): Record<string, BackgroundTaskEntry> {
  if (!d.backgroundTasksCopied) {
    d.next.backgroundTasks = { ...d.next.backgroundTasks };
    d.backgroundTasksCopied = true;
  }
  return d.next.backgroundTasks;
}

function draftRollup(d: Draft): WorkRollup | undefined {
  const rollup = d.next.rollup;
  if (!rollup) return undefined;
  if (!d.rollupCopied) {
    d.next.rollup = { ...rollup, operationCounts: { ...rollup.operationCounts }, revision: d.next.revision };
    d.rollupCopied = true;
  }
  return d.next.rollup;
}

function draftCoverage(d: Draft): WorkCoverage {
  if (!d.coverageCopied) {
    d.next.coverage = { ...d.next.coverage };
    d.coverageCopied = true;
  }
  return d.next.coverage;
}

// 詳細を捨てたら必ずここを通す。捨てたのに complete のままにしない
function markDetailsTruncated(d: Draft, omittedTools = 0): void {
  const coverage = draftCoverage(d);
  coverage.details = "prefix-truncated";
  if (omittedTools > 0) coverage.omittedToolCount = (coverage.omittedToolCount ?? 0) + omittedTools;
}

// 帰属（タスク状態・agent配置）に影響する欠落を出す
function markSummaryTruncated(d: Draft): void {
  draftCoverage(d).summary = "prefix-truncated";
}

function pushBounded(d: Draft, values: string[], value: string, limit: number): void {
  values.push(value);
  if (values.length <= limit) return;
  values.shift();
  markDetailsTruncated(d);
}

/** 配置先の集計面（phase か rollup）を取り出す。詳細記録の有無に依存しない */
interface TotalsTarget {
  totals: WorkTotals;
  phase?: WorkPhase;
  rollup?: WorkRollup;
}

function draftTotals(d: Draft, phaseRef: PhaseRef | undefined): TotalsTarget | undefined {
  if (phaseRef === undefined) return undefined;
  if (phaseRef.kind === "rollup") {
    const rollup = draftRollup(d);
    return rollup ? { totals: rollup, rollup } : undefined;
  }
  const phase = draftPhase(d, phaseRef.phaseId);
  return phase ? { totals: phase, phase } : undefined;
}

function upsertTask(
  d: Draft,
  taskKey: string,
  description: string,
  status: TaskStatus,
  activeForm?: string
): WorkTask {
  const existing = draftTask(d, taskKey);
  if (existing) {
    existing.description = description;
    existing.status = status;
    if (activeForm !== undefined) existing.activeForm = activeForm;
    return existing;
  }
  const tasks = draftTasks(d);
  const created: WorkTask = { taskKey, description, activeForm, status, occurrence: 1, revision: d.next.revision };
  tasks.push(created);
  d.copiedTaskKeys.add(taskKey);
  return created;
}

function removeTask(d: Draft, taskKey: string): void {
  const tasks = draftTasks(d);
  const index = tasks.findIndex((task) => task.taskKey === taskKey);
  if (index < 0) return;
  tasks.splice(index, 1);
}

// 上限は必ず成立させる。in_progress しか無い場合も退避し、帰属判定が「1件だけ」へ
// 誤って倒れないよう omittedActiveTaskCount で数える
function boundTasks(d: Draft): void {
  const tasks = draftTasks(d);
  while (tasks.length > MAX_TASKS) {
    let index = tasks.findIndex((task) => task.status !== "in_progress");
    if (index < 0) {
      index = 0;
      d.next.omittedActiveTaskCount++;
      markSummaryTruncated(d);
    }
    tasks.splice(index, 1);
    markDetailsTruncated(d);
  }
}

function recomputeActiveTask(d: Draft): void {
  let active: string | undefined;
  let count = 0;
  for (const task of d.next.tasks) {
    if (task.status !== "in_progress") continue;
    count++;
    active = task.taskKey;
  }
  const total = count + d.next.omittedActiveTaskCount;
  d.next.activeTaskKey = total === 1 && count === 1 ? active : undefined;
  d.next.ambiguity = total > 1 ? "multiple-active-tasks" : undefined;
}

function parseTodoIntent(input: Record<string, unknown>): TaskIntent | undefined {
  const todos = input.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: { taskKey: string; description: string; activeForm?: string; status: TaskStatus }[] = [];
  const ordinals = new Map<string, number>();
  for (const raw of todos) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    const content = readString(item, "content");
    const status = readTaskStatus(item.status);
    if (content === undefined || status === undefined) return undefined;
    const ordinal = (ordinals.get(content) ?? 0) + 1;
    ordinals.set(content, ordinal);
    items.push({
      taskKey: `todo:${content}${TODO_KEY_SEPARATOR}${ordinal}`,
      description: content,
      activeForm: readString(item, "activeForm"),
      status,
    });
  }
  return { kind: "todo", items };
}

export function parseTaskIntentFromRawInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
  toolUseId: string = ""
): TaskIntent | undefined {
  if (!input) return undefined;
  if (toolName === "TodoWrite") return parseTodoIntent(input);
  if (toolName === "TaskCreate") {
    const subject = readString(input, "subject");
    if (subject === undefined) return undefined;
    return {
      kind: "create",
      toolUseId,
      subject,
      activeForm: readString(input, "activeForm"),
      status: readTaskStatus(input.status) ?? "pending",
    };
  }
  if (toolName === "TaskUpdate") {
    const taskId = readTaskId(input);
    if (taskId === undefined) return undefined;
    // 実測: TaskUpdate の status には "deleted" もある（SDK実測知見.md）
    return {
      kind: "update",
      taskKey: `task:${taskId}`,
      subject: readString(input, "subject"),
      activeForm: readString(input, "activeForm"),
      status: readTaskStatus(input.status),
      deleted: input.status === "deleted",
    };
  }
  return undefined;
}

function parseTaskIntent(e: ToolStartedSignal): TaskIntent | undefined {
  const input = parseToolInput(e.inputPreview);
  if (!input) return undefined;
  return parseTaskIntentFromRawInput(e.toolName, input, e.toolUseId);
}

// TodoWrite は現在のtodo配列そのものが状態（レベル信号）。配列から消えた todo を失効させないと
// 完了済みタスクが in_progress のまま残り、後続作業が誤帰属する
function applyTodoIntent(
  d: Draft,
  items: { taskKey: string; description: string; activeForm?: string; status: TaskStatus }[]
): void {
  const tasks = draftTasks(d);
  const previous = new Map(tasks.map((task) => [task.taskKey, task]));
  const retained = tasks.filter((task) => !task.taskKey.startsWith("todo:"));
  const todoTasks = items.map((item) => {
    const old = previous.get(item.taskKey);
    // 退避済みの todo が配列へ戻ってきたら、記録側で数え直せるので omitted 分を返す
    if (!old && item.status === "in_progress") releaseOmittedActiveTask(d);
    if (
      old &&
      old.status === item.status &&
      old.description === item.description &&
      old.activeForm === item.activeForm
    ) {
      return old;
    }
    if (old) {
      return {
        ...old,
        description: item.description,
        activeForm: item.activeForm,
        status: item.status,
        revision: d.next.revision,
      };
    }
    return {
      taskKey: item.taskKey,
      description: item.description,
      activeForm: item.activeForm,
      status: item.status,
      occurrence: 1,
      revision: d.next.revision,
    };
  });
  d.next.tasks = [...retained, ...todoTasks];
}

export function taskCreateKeyFromResult(intentToolUseId: string, resultPreview: string): string {
  const match = TASK_CREATE_ID_RE.exec(resultPreview) ?? TASK_CREATE_JSON_ID_RE.exec(resultPreview);
  return match ? `task:${match[1]}` : `task:pending:${intentToolUseId}`;
}

function applyCreateIntent(d: Draft, intent: Extract<TaskIntent, { kind: "create" }>, resultPreview: string): void {
  const taskKey = taskCreateKeyFromResult(intent.toolUseId, resultPreview);
  upsertTask(d, taskKey, intent.subject, intent.status, intent.activeForm);
}

// 記録が退避された in_progress task が in_progress を抜けた合図。これを取り込まないと
// omittedActiveTaskCount が減らず、以後ずっと「複数タスクが進行中」に固着して
// 明示タスクのphaseが二度と作られなくなる（記録が無い側の同定はできないので下限0で丸める）
function releaseOmittedActiveTask(d: Draft): void {
  if (d.next.omittedActiveTaskCount === 0) return;
  d.next.omittedActiveTaskCount--;
}

function applyUpdateIntent(d: Draft, intent: Extract<TaskIntent, { kind: "update" }>): void {
  const known = draftTask(d, intent.taskKey);
  if (intent.deleted) {
    if (!known) releaseOmittedActiveTask(d);
    removeTask(d, intent.taskKey);
    return;
  }
  const existing = known;
  if (!existing) {
    if (intent.status !== undefined && intent.status !== "in_progress") releaseOmittedActiveTask(d);
    const fallbackName = intent.taskKey.startsWith("task:") ? intent.taskKey.slice("task:".length) : intent.taskKey;
    upsertTask(
      d,
      intent.taskKey,
      intent.subject ?? l10n.t("Task {0}", fallbackName),
      intent.status ?? "pending",
      intent.activeForm
    );
    return;
  }
  if (intent.subject !== undefined) existing.description = intent.subject;
  if (intent.activeForm !== undefined) existing.activeForm = intent.activeForm;
  // status 未指定は「変更なし」。unknown で上書きすると進行中タスクから作業が外れる
  if (intent.status !== undefined) existing.status = intent.status;
}

function applyTaskIntent(d: Draft, intent: TaskIntent, e: ToolFinishedSignal): void {
  if (intent.kind === "todo") applyTodoIntent(d, intent.items);
  else if (intent.kind === "create") applyCreateIntent(d, intent, e.resultPreview);
  else applyUpdateIntent(d, intent);
  boundTasks(d);
  const previousActive = d.next.activeTaskKey;
  recomputeActiveTask(d);
  if (previousActive !== d.next.activeTaskKey) closeSegment(d, e.timestamp);
}

function closeSegment(d: Draft, timestamp: number): void {
  const current = findSegment(d.next, d.next.currentSegmentId);
  if (current && current.endedAt === undefined) {
    const drafted = draftSegment(d, current.segmentId);
    if (drafted) drafted.endedAt = timestamp;
  }
  d.next.currentSegmentId = undefined;
}

function boundSegments(d: Draft): void {
  const segments = draftSegments(d);
  while (segments.length > MAX_SEGMENTS) {
    const index = segments.findIndex((segment) => segment.endedAt !== undefined);
    if (index < 0) return;
    segments.splice(index, 1);
    markDetailsTruncated(d);
  }
}

function compactPhases(d: Draft, removed: WorkPhase[]): void {
  const state = d.next;
  if (!state.rollup) {
    state.rollup = {
      phaseId: "rollup",
      title: l10n.t("Initial work"),
      compactedPhaseCount: 0,
      startedAt: removed[0].startedAt,
      endedAt: removed[0].endedAt ?? removed[0].startedAt,
      elapsedMs: 0,
      toolCount: 0,
      failCount: 0,
      operationCounts: createOperationCounts(),
      taskCount: 0,
      agentCount: 0,
      agentTokens: 0,
      childToolCount: 0,
      childFailCount: 0,
      staleCount: 0,
      runningCount: 0,
      pendingApprovalCount: 0,
      revision: state.revision,
    };
    d.rollupCopied = true;
  }
  const rollup = draftRollup(d)!;
  for (const phase of removed) {
    rollup.compactedPhaseCount++;
    rollup.startedAt = Math.min(rollup.startedAt, phase.startedAt);
    rollup.endedAt = Math.max(rollup.endedAt, phase.endedAt ?? phase.startedAt);
    rollup.elapsedMs += phase.elapsedMs;
    rollup.toolCount += phase.toolCount;
    rollup.failCount += phase.failCount;
    rollup.taskCount += phase.taskCount;
    rollup.agentCount += phase.agentCount;
    rollup.agentTokens += phase.agentTokens;
    rollup.childToolCount += phase.childToolCount;
    rollup.childFailCount += phase.childFailCount;
    rollup.staleCount += phase.staleCount;
    rollup.runningCount += phase.runningCount;
    rollup.backgroundRunningCount = (rollup.backgroundRunningCount ?? 0) + (phase.backgroundRunningCount ?? 0);
    rollup.pendingApprovalCount += phase.pendingApprovalCount;
    for (const kind of OPERATION_KINDS) rollup.operationCounts[kind] += phase.operationCounts[kind];
    if (phase.taskKey === undefined) continue;
    if (state.phaseByTaskKey[phase.taskKey] === phase.phaseId) {
      state.phaseByTaskKey = withoutKey(state.phaseByTaskKey, phase.taskKey);
      d.phaseByTaskKeyCopied = true;
    }
    const task = draftTask(d, phase.taskKey);
    if (task) {
      task.compacted = true;
      continue;
    }
    // task記録が上限で退避済みでも occurrence 連鎖は切らさない（phase が taskKey と occurrence を持つ）
    draftTasks(d).push({
      taskKey: phase.taskKey,
      description: phase.title,
      status: "unknown",
      occurrence: phase.occurrence ?? 1,
      compacted: true,
      revision: state.revision,
    });
    d.copiedTaskKeys.add(phase.taskKey);
  }
  rollup.revision = state.revision;
  boundTasks(d);

  const removedIds = new Set(removed.map((phase) => phase.phaseId));
  for (let bucket = 0; bucket < PLACEMENT_BUCKETS; bucket++) {
    const source = state.toolPlacements.buckets[bucket];
    for (const key in source) {
      const placement = source[key];
      if (placement.phaseRef?.kind !== "phase" || !removedIds.has(placement.phaseRef.phaseId)) continue;
      const drafted = draftPlacement(d, key);
      if (drafted) drafted.phaseRef = { kind: "rollup" };
    }
  }
  // 未解決の承認が rollup へ移った phase を指したままだと、後から来る approval_resolved が
  // 消えた phase の件数を戻そうとして総計が合わなくなる
  for (const requestId in state.approvalPlacements) {
    const placement = state.approvalPlacements[requestId];
    if (placement.kind !== "phase" || !removedIds.has(placement.phaseId)) continue;
    draftApprovals(d)[requestId] = { kind: "rollup" };
  }
  state.segments = draftSegments(d).filter((segment) => !removedIds.has(segment.phaseId));

  const coverage = draftCoverage(d);
  coverage.phaseHistory = "prefix-compacted";
  coverage.compactedPhaseCount = rollup.compactedPhaseCount;
  coverage.details = "prefix-truncated";
}

function addPhase(d: Draft, phase: WorkPhase): void {
  const phases = draftPhases(d);
  if (phases.length + (d.next.rollup ? 1 : 0) >= MAX_PHASES) {
    const removed = phases.splice(0, d.next.rollup ? 1 : 2);
    compactPhases(d, removed);
  }
  phases.push(phase);
  d.copiedPhaseIds.add(phase.phaseId);
}

function createPhase(
  d: Draft,
  options: { taskKey?: string; occurrence?: number; operation: PhaseOperation; title: string; timestamp: number }
): WorkPhase {
  const state = d.next;
  const phase: WorkPhase = {
    phaseId: `phase-${state.nextPhaseOrdinal++}`,
    taskKey: options.taskKey,
    occurrence: options.occurrence,
    operation: options.operation,
    title: options.title,
    segmentIds: [],
    segmentCount: 0,
    turnIds: [],
    turnCount: 0,
    agents: [],
    startedAt: options.timestamp,
    elapsedMs: 0,
    toolCount: 0,
    failCount: 0,
    operationCounts: createOperationCounts(),
    taskCount: options.taskKey === undefined ? 0 : 1,
    agentCount: 0,
    agentTokens: 0,
    childToolCount: 0,
    childFailCount: 0,
    staleCount: 0,
    runningCount: 0,
    pendingApprovalCount: 0,
    revision: state.revision,
  };
  addPhase(d, phase);
  state.currentPhaseId = phase.phaseId;
  return phase;
}

function taskPhase(d: Draft, taskKey: string, timestamp: number): WorkPhase {
  const state = d.next;
  const existing = draftPhase(d, state.phaseByTaskKey[taskKey]);
  if (existing) return existing;
  const task = draftTask(d, taskKey);
  let occurrence = 1;
  if (task) {
    if (task.compacted) {
      task.occurrence++;
      task.compacted = false;
    }
    occurrence = task.occurrence;
  }
  const phase = createPhase(d, {
    taskKey,
    occurrence,
    operation: "unknown",
    title: task?.description ?? l10n.t("Untitled task"),
    timestamp,
  });
  draftPhaseByTaskKey(d)[taskKey] = phase.phaseId;
  return phase;
}

function advanceFallback(d: Draft, operation: OperationKind): void {
  if (operation !== "observe" && operation !== "mutate" && operation !== "verify") return;
  if (fallbackRank(operation) <= fallbackRank(d.next.fallbackOperation)) return;
  d.next.fallbackOperation = operation;
}

// unknown / delegated は「まだ分類する根拠が無い」状態。最初の observe/mutate/verify は
// 現在phaseをその場で昇格させる（新phaseを作ると Bash 起点の会話で「その他の作業」が残り、
// Todo無しfallbackが4個になる）
function isUnclassified(phase: WorkPhase): boolean {
  return phase.operation === "unknown" || phase.operation === "delegated";
}

function destination(d: Draft, operation: OperationKind, timestamp: number): WorkPhase {
  const state = d.next;
  if (state.activeTaskKey !== undefined) return taskPhase(d, state.activeTaskKey, timestamp);
  advanceFallback(d, operation);
  const current = findPhase(state, state.currentPhaseId);
  const reusable =
    current !== undefined &&
    current.taskKey === undefined &&
    (isUnclassified(current) || current.operation === state.fallbackOperation);
  if (reusable) return draftPhase(d, current.phaseId)!;
  return createPhase(d, {
    operation: state.fallbackOperation,
    title: phaseTitle(state.fallbackOperation),
    timestamp,
  });
}

// Agent/Task は「単独の場合のみサブエージェント作業」。他の作業が同じphaseに
// 入った時点で通常の分類へ戻す
function relabelFallbackPhase(d: Draft, phase: WorkPhase): void {
  if (phase.taskKey !== undefined) return;
  const fallback = d.next.fallbackOperation;
  let operation: PhaseOperation;
  if (fallback !== "unknown") {
    operation = fallback;
  } else {
    const counts = phase.operationCounts;
    const others = counts.observe + counts.mutate + counts.verify + counts.neutral + counts.unknown;
    operation = counts.delegated > 0 && others === 0 ? "delegated" : "unknown";
  }
  if (phase.operation === operation) return;
  phase.operation = operation;
  phase.title = phaseTitle(operation);
}

function trackTurn(d: Draft, phase: WorkPhase, turnId: string): void {
  if (turnId.length === 0 || phase.lastTurnId === turnId) return;
  phase.lastTurnId = turnId;
  pushBounded(d, phase.turnIds, turnId, MAX_PHASE_REFS);
  phase.turnCount++;
}

function place(d: Draft, phase: WorkPhase, timestamp: number, turnId: string): WorkSegment {
  trackTurn(d, phase, turnId);
  const current = findSegment(d.next, d.next.currentSegmentId);
  if (current && current.phaseId === phase.phaseId && current.endedAt === undefined) {
    // 呼び出し側が集計を書き換えるので、再利用でも必ず複製を返す（前state共有のまま
    // 加算すると過去の state まで書き換わる）
    const drafted = draftSegment(d, current.segmentId)!;
    if (!drafted.turnIds.includes(turnId)) drafted.turnIds.push(turnId);
    return drafted;
  }
  closeSegment(d, timestamp);
  const segment: WorkSegment = {
    segmentId: `segment-${d.next.nextSegmentOrdinal++}`,
    phaseId: phase.phaseId,
    taskKey: phase.taskKey,
    turnIds: [turnId],
    startedAt: timestamp,
    toolCount: 0,
    failCount: 0,
    childFailCount: 0,
    elapsedMs: 0,
    runningCount: 0,
    staleCount: 0,
    revision: d.next.revision,
  };
  const segments = draftSegments(d);
  segments.push(segment);
  d.copiedSegmentIds.add(segment.segmentId);
  boundSegments(d);
  pushBounded(d, phase.segmentIds, segment.segmentId, MAX_PHASE_REFS);
  phase.segmentCount++;
  d.next.currentSegmentId = segment.segmentId;
  d.next.currentPhaseId = phase.phaseId;
  return segment;
}

// agent記録は詳細。件数・tokens・running/stale は WorkTotals 側が持つので、
// 上限超過ではここを捨ててよい（捨てたことは coverage へ出す）
function addAgent(d: Draft, phase: WorkPhase, agent: WorkAgent): void {
  phase.agents.push(agent);
  d.copiedAgentIds.add(agent.agentId);
  if (phase.agents.length <= MAX_PHASE_AGENTS) return;
  const isSettled = (candidate: WorkAgent): boolean =>
    candidate.status === "completed" || candidate.status === "failed";
  const settled = phase.agents.findIndex(isSettled);
  phase.agents.splice(settled >= 0 ? settled : 0, 1);
  markDetailsTruncated(d, 1);
}

function removeRunningAgent(d: Draft, toolUseId: string): void {
  if (!d.next.runningAgentToolUseIds.includes(toolUseId)) return;
  d.next.runningAgentToolUseIds = draftRunningAgents(d).filter((id) => id !== toolUseId);
}

function removeRunningTool(d: Draft, toolUseId: string): void {
  if (!d.next.runningToolUseIds.includes(toolUseId)) return;
  d.next.runningToolUseIds = draftRunningTools(d).filter((id) => id !== toolUseId);
}

// 1件を stale へ畳む。segment 側は counted のツールだけを数えているので、そちらに合わせて増減する
function markToolStale(d: Draft, toolUseId: string, timestamp: number, isAgent: boolean): void {
  const current = findToolPlacement(d.next, toolUseId);
  if (!current || current.stale === true) return;
  const placement = draftPlacement(d, toolUseId)!;
  placement.stale = true;
  const segment = placement.counted ? draftSegment(d, placement.segmentId) : undefined;
  if (segment) {
    segment.runningCount--;
    segment.staleCount++;
  }
  if (placement.background !== undefined) settleBackgroundStale(d, placement);
  if (!isAgent) return;
  const target = draftTotals(d, placement.phaseRef);
  if (!target) return;
  target.totals.runningCount--;
  target.totals.staleCount++;
  const agent = target.phase ? draftAgent(d, target.phase, placement.agentId) : undefined;
  if (!agent || agent.status !== "running") return;
  agent.status = "stale";
  agent.endedAt = timestamp;
  agent.elapsedMs = Math.max(0, timestamp - agent.startedAt);
}

// 別の上限は設けない。ここへ入るのは未終了ツールだけで、終了・退避のどちらでも
// 同時にリストから外れるため、長さは placement 索引の上限（MAX_TRACKED_TOOL_USES）を超えない
function trackRunningTool(d: Draft, toolUseId: string): void {
  draftRunningTools(d).push(toolUseId);
}

// 退避しても集計が壊れないよう、実行中agentの配置は先に stale へ畳んでから捨てる。
// 非agentを優先して捨てるのは、agent配置を失うと子ツールが親を見つけられず
// トップレベルとして二重計上されるため
function evictOldestPlacement(d: Draft): void {
  const index = draftPlacementIndex(d);
  let victim: WorkTool | undefined;
  for (let bucket = 0; bucket < PLACEMENT_BUCKETS; bucket++) {
    const source = index.buckets[bucket];
    for (const key in source) {
      const candidate = source[key];
      if (victim === undefined) {
        victim = candidate;
        continue;
      }
      const candidateIsAgent = candidate.agentId !== undefined;
      const victimIsAgent = victim.agentId !== undefined;
      if (candidateIsAgent !== victimIsAgent) {
        if (!candidateIsAgent) victim = candidate;
        continue;
      }
      if (candidate.startedAt < victim.startedAt) victim = candidate;
    }
  }
  if (victim === undefined) return;
  // 退避した配置の終了イベントは帰属先を持たないため、経過時間・失敗数（子ツールなら
  // childFailCount）が集計へ入らない。総計が実態からずれるので summary 側も欠落扱いにする
  // （詳細を捨てても総計は保つ。保てないなら coverage へ出す）
  markSummaryTruncated(d);
  // 追跡をやめる分は segment の実行中数からも外す。外さないとそのカードが永久に「実行中」になる
  if (victim.counted && victim.stale !== true) {
    const segment = draftSegment(d, victim.segmentId);
    if (segment) {
      segment.runningCount--;
      segment.staleCount++;
    }
  }
  if (victim.agentId !== undefined && victim.stale !== true) {
    const target = draftTotals(d, victim.phaseRef);
    if (target) {
      target.totals.runningCount--;
      target.totals.staleCount++;
      if (target.phase) {
        const agent = draftAgent(d, target.phase, victim.agentId);
        if (agent && agent.status === "running") agent.status = "stale";
      }
    }
  }
  if (victim.background !== undefined) {
    const taskId = victim.background.taskId;
    const entry = d.next.backgroundTasks[taskId];
    // 通知待ちのまま退避したものだけを欠落として数える。完了済みの退避は集計に影響しない
    if (entry !== undefined && entry.terminal === undefined) {
      const coverage = draftCoverage(d);
      coverage.untrackedBackgroundCount = (coverage.untrackedBackgroundCount ?? 0) + 1;
      if (victim.agentId === undefined && victim.stale !== true) {
        const target = draftTotals(d, victim.phaseRef);
        if (target) target.totals.backgroundRunningCount = Math.max(0, (target.totals.backgroundRunningCount ?? 0) - 1);
      }
    }
    d.next.backgroundTasks = withoutKey(d.next.backgroundTasks, taskId);
    d.backgroundTasksCopied = true;
  }
  removeRunningAgent(d, victim.toolUseId);
  removeRunningTool(d, victim.toolUseId);
  deletePlacement(d, victim.toolUseId);
  markDetailsTruncated(d, 1);
}

function setPlacement(d: Draft, placement: WorkTool): void {
  const isNew = findToolPlacement(d.next, placement.toolUseId) === undefined;
  if (isNew && d.next.toolPlacements.size >= MAX_TRACKED_TOOL_USES) evictOldestPlacement(d);
  const bucket = draftBucket(d, bucketOf(placement.toolUseId));
  if (bucket[placement.toolUseId] === undefined) draftPlacementIndex(d).size++;
  bucket[placement.toolUseId] = placement;
}

function deletePlacement(d: Draft, toolUseId: string): void {
  const bucketId = bucketOf(toolUseId);
  const index = draftPlacementIndex(d);
  if (index.buckets[bucketId][toolUseId] === undefined) return;
  index.buckets[bucketId] = withoutKey(index.buckets[bucketId], toolUseId);
  d.copiedBuckets.add(bucketId);
  index.size--;
}

function handleToolStart(d: Draft, e: ToolStartedSignal): void {
  if (CLAUDE_VOCABULARY.task.has(e.toolName)) {
    const intent = e.taskIntentStructured ?? parseTaskIntent(e);
    if (intent) {
      // 記帳系は作業件数へ混ぜない。状態へ反映するのは成功終了時（失敗した更新は成立していない）
      setPlacement(d, {
        toolUseId: e.toolUseId,
        parentToolUseId: e.parentToolUseId,
        toolName: e.toolName,
        description: e.inputSummary ?? e.toolName,
        operation: "neutral",
        startedAt: e.timestamp,
        counted: false,
        taskIntent: intent,
      });
      return;
    }
    d.next.unparsedInputCount++;
    markSummaryTruncated(d);
    const coverage = draftCoverage(d);
    coverage.unparsedTaskInputCount = (coverage.unparsedTaskInputCount ?? 0) + 1;
  }
  const state = d.next;
  const operation = classifyOperation(e);
  const parent = e.parentToolUseId === null ? undefined : findToolPlacement(state, e.parentToolUseId);
  const owner = parent?.agentId === undefined ? undefined : parent;

  let phaseRef: PhaseRef | undefined;
  let segmentId: string | undefined;
  let phase: WorkPhase | undefined;
  if (owner) {
    phaseRef = owner.phaseRef;
    segmentId = owner.segmentId;
    if (phaseRef?.kind === "phase") phase = draftPhase(d, phaseRef.phaseId);
  } else {
    phase = destination(d, operation, e.timestamp);
    phaseRef = { kind: "phase", phaseId: phase.phaseId };
    const segment = place(d, phase, e.timestamp, e.turnId);
    segmentId = segment.segmentId;
    segment.toolCount++;
    segment.runningCount++;
  }
  const target = draftTotals(d, phaseRef);

  if (target && owner === undefined) {
    target.totals.toolCount++;
    target.totals.operationCounts[operation]++;
  }
  if (target && owner) {
    target.totals.childToolCount++;
    if (target.phase) {
      const ownerAgent = draftAgent(d, target.phase, owner.agentId);
      if (ownerAgent) ownerAgent.childCount++;
    }
  }

  let agentId: string | undefined;
  let spawnDepth: number | undefined;
  if (operation === "delegated") {
    agentId = `agent:${e.toolUseId}`;
    spawnDepth = owner ? (owner.spawnDepth ?? 1) + 1 : 1;
    if (target) {
      target.totals.agentCount++;
      target.totals.runningCount++;
      if (target.phase) {
        addAgent(d, target.phase, {
          agentId,
          parentAgentId: owner?.agentId ?? null,
          toolUseId: e.toolUseId,
          parentToolUseId: e.parentToolUseId,
          spawnDepth,
          agentType: e.subagentType,
          description: e.inputSummary ?? e.toolName,
          modelDeclared: e.subagentModel,
          effortDeclared: e.subagentEffort,
          status: "running",
          startedAt: e.timestamp,
          elapsedMs: 0,
          childCount: 0,
          failCount: 0,
          revision: state.revision,
        });
      }
    }
    draftRunningAgents(d).push(e.toolUseId);
  } else {
    trackRunningTool(d, e.toolUseId);
  }
  if (phase && owner === undefined) relabelFallbackPhase(d, phase);

  setPlacement(d, {
    toolUseId: e.toolUseId,
    parentToolUseId: e.parentToolUseId,
    toolName: e.toolName,
    description: e.inputSummary ?? e.toolName,
    operation,
    startedAt: e.timestamp,
    counted: owner === undefined,
    phaseRef,
    segmentId,
    agentId,
    ownerAgentId: owner?.agentId,
    spawnDepth,
    ...(e.isBackground === true || e.delegation?.isBackground === true ? { declaredBackground: true as const } : {}),
  });
}

function parseSubagentTokens(resultPreview: string): number | undefined {
  const match = SUBAGENT_TOKENS_RE.exec(resultPreview);
  return match ? Number(match[1]) : undefined;
}

// 背景タスクの起動 ACK。閉じずに索引へ登録し、通知を待つ（裁定A2: ACK は完了ではない）
function markBackgroundStarted(d: Draft, toolUseId: string, taskId: string): void {
  const placement = draftPlacement(d, toolUseId);
  if (!placement) return;
  placement.background = { taskId };
  const kind = placement.agentId !== undefined ? "agent" : "tool";
  draftBackgroundTasks(d)[taskId] = { toolUseId, kind };
  if (kind === "tool") {
    const target = draftTotals(d, placement.phaseRef);
    if (target) target.totals.backgroundRunningCount = (target.totals.backgroundRunningCount ?? 0) + 1;
  }
}

// 背景を stale に確定する（終端イベント・pendingStale の確定・hydration 末尾）。以後の通知は無視される
function settleBackgroundStale(d: Draft, placement: WorkTool): void {
  const taskId = placement.background?.taskId;
  if (taskId === undefined) return;
  const entry = d.next.backgroundTasks[taskId];
  if (entry !== undefined && entry.terminal === undefined) {
    draftBackgroundTasks(d)[taskId] = { toolUseId: entry.toolUseId, kind: entry.kind, terminal: "stale" };
  }
  if (placement.agentId === undefined) {
    const target = draftTotals(d, placement.phaseRef);
    if (target) target.totals.backgroundRunningCount = Math.max(0, (target.totals.backgroundRunningCount ?? 0) - 1);
  }
}

// 背景 1 件を終端へ畳む。ACK で入れなかった集計（経過・実行中数・失敗）をここで入れる
function finishBackground(
  d: Draft,
  placement: WorkTool,
  timestamp: number,
  status: "completed" | "failed" | "stale"
): void {
  const elapsedMs = Math.max(0, timestamp - (placement.resumedAt ?? placement.startedAt));
  const segment = draftSegment(d, placement.segmentId);
  if (segment && placement.counted) {
    if (placement.stale) segment.staleCount--;
    else segment.runningCount--;
    segment.elapsedMs += elapsedMs;
    if (status === "failed") segment.failCount++;
  }
  const target = draftTotals(d, placement.phaseRef);
  if (target) {
    if (target.phase) target.phase.endedAt = Math.max(target.phase.endedAt ?? 0, timestamp);
    if (target.rollup) target.rollup.endedAt = Math.max(target.rollup.endedAt, timestamp);
    if (placement.counted) {
      target.totals.elapsedMs += elapsedMs;
      if (status === "failed") target.totals.failCount++;
    }
    if (placement.agentId !== undefined) {
      if (placement.stale) target.totals.staleCount--;
      else target.totals.runningCount--;
      if (status === "stale") target.totals.staleCount++;
      const agent = target.phase ? draftAgent(d, target.phase, placement.agentId) : undefined;
      if (agent) {
        agent.status = status;
        agent.endedAt = timestamp;
        agent.elapsedMs += elapsedMs;
        if (status === "failed") agent.failCount++;
      }
    } else if (!placement.stale) {
      target.totals.backgroundRunningCount = Math.max(0, (target.totals.backgroundRunningCount ?? 0) - 1);
    }
  }
  removeRunningAgent(d, placement.toolUseId);
  removeRunningTool(d, placement.toolUseId);
  // Bash は reopen しないので placement を消す。Agent は SendMessage で再開しうるので残す（退避で消える）
  if (placement.agentId === undefined) {
    deletePlacement(d, placement.toolUseId);
  } else {
    const p = draftPlacement(d, placement.toolUseId);
    if (p && status === "stale") p.stale = true;
  }
}

// task_notification（合成 toolUseId）。task id で元の placement を引いて閉じる。
// 観測外・重複・退避後・終端済みは無視する（completed と断言しない）
function closeBackgroundByNotification(d: Draft, taskId: string, status: string | undefined, timestamp: number): void {
  const entry = d.next.backgroundTasks[taskId];
  if (entry === undefined || entry.terminal !== undefined) return;
  const terminal: "completed" | "failed" | "stale" =
    status === "completed" ? "completed" : status === "failed" ? "failed" : "stale";
  draftBackgroundTasks(d)[taskId] = { toolUseId: entry.toolUseId, kind: entry.kind, terminal };
  const placement = findToolPlacement(d.next, entry.toolUseId);
  if (placement) finishBackground(d, placement, timestamp, terminal);
}

// SendMessage 成功（resumedAgentId）: 終端済みの Agent を running へ戻す。running なら何もしない。
// 通知より先に届いた場合も running のまま（順序逆転で completed に倒さない）
function reopenBackground(d: Draft, taskId: string, timestamp: number): void {
  const entry = d.next.backgroundTasks[taskId];
  if (entry === undefined || entry.kind !== "agent" || entry.terminal === undefined) return;
  const placement = draftPlacement(d, entry.toolUseId);
  if (!placement) {
    const coverage = draftCoverage(d);
    coverage.untrackedBackgroundCount = (coverage.untrackedBackgroundCount ?? 0) + 1;
    return;
  }
  draftBackgroundTasks(d)[taskId] = { toolUseId: entry.toolUseId, kind: entry.kind };
  const wasStale = placement.stale === true;
  placement.stale = false;
  placement.resumedAt = timestamp;
  const segment = draftSegment(d, placement.segmentId);
  if (segment && placement.counted) {
    segment.runningCount++;
    if (wasStale) segment.staleCount--;
  }
  const target = draftTotals(d, placement.phaseRef);
  if (target) {
    target.totals.runningCount++;
    if (wasStale) target.totals.staleCount--;
    const agent = target.phase ? draftAgent(d, target.phase, placement.agentId) : undefined;
    if (agent) {
      agent.status = "running";
      agent.endedAt = undefined;
    }
  }
  if (!d.next.runningAgentToolUseIds.includes(placement.toolUseId)) draftRunningAgents(d).push(placement.toolUseId);
}

// background_tasks（REPLACE のレベル信号）: 追跡中の task id が集合に無ければ pendingStale。
// 集合に戻ればフラグを外す。確定は次の turn_started（settlePendingStale）
function notePendingStale(d: Draft, tasks: ReadonlyArray<{ id: string; ambient?: true }>): void {
  const alive = new Set(tasks.filter((t) => t.ambient !== true).map((t) => t.id));
  for (const [taskId, entry] of Object.entries(d.next.backgroundTasks)) {
    if (entry.terminal !== undefined) continue;
    const gone = !alive.has(taskId);
    if (gone && entry.pendingStale !== true) draftBackgroundTasks(d)[taskId] = { ...entry, pendingStale: true };
    else if (!gone && entry.pendingStale === true) draftBackgroundTasks(d)[taskId] = { toolUseId: entry.toolUseId, kind: entry.kind };
  }
}

function settlePendingStale(d: Draft, timestamp: number): void {
  for (const [taskId, entry] of Object.entries(d.next.backgroundTasks)) {
    if (entry.terminal !== undefined || entry.pendingStale !== true) continue;
    const placement = findToolPlacement(d.next, entry.toolUseId);
    if (placement) {
      markToolStale(d, entry.toolUseId, timestamp, placement.agentId !== undefined);
      removeRunningAgent(d, entry.toolUseId);
      removeRunningTool(d, entry.toolUseId);
    } else {
      draftBackgroundTasks(d)[taskId] = { toolUseId: entry.toolUseId, kind: entry.kind, terminal: "stale" };
    }
  }
}

// ストリームが閉じている（history の hydration 末尾・CLI 死亡で終端イベントが来ない）ときに host が当てる。
// 通知未観測の背景を全て stale にする。revision は進めない（markSubagentGaps と同じ扱い）
export function markBackgroundUnconfirmed(state: WorkModelState, timestamp: number): WorkModelState {
  const open = Object.entries(state.backgroundTasks).filter(([, e]) => e.terminal === undefined);
  if (open.length === 0) return state;
  const d = beginDraft(state);
  d.next.revision = state.revision;
  for (const [taskId, entry] of open) {
    const placement = findToolPlacement(d.next, entry.toolUseId);
    if (placement) {
      markToolStale(d, entry.toolUseId, timestamp, placement.agentId !== undefined);
      removeRunningAgent(d, entry.toolUseId);
      removeRunningTool(d, entry.toolUseId);
    } else {
      draftBackgroundTasks(d)[taskId] = { toolUseId: entry.toolUseId, kind: entry.kind, terminal: "stale" };
    }
  }
  return d.next;
}

function handleToolFinish(d: Draft, e: ToolFinishedSignal): void {
  // 通知（合成 toolUseId）は placement を持たない。placement 検索より先に task id で解決する
  if (e.taskNotification !== undefined) {
    closeBackgroundByNotification(d, e.taskNotification.agentId, e.taskNotification.status, e.timestamp);
    return;
  }
  // SendMessage の成功結果は「同じ Agent が再び動き出した」観測。SendMessage 自身の終端処理は続ける
  if (e.resumedAgentId !== undefined && !e.isError) reopenBackground(d, e.resumedAgentId, e.timestamp);
  const placement = findToolPlacement(d.next, e.toolUseId);
  // 配置が無いのは上限退避（退避時に coverage へ記録済み）か、観測範囲外で始まったツール
  if (!placement) return;
  const backgroundTaskId =
    !e.isError && placement.taskIntent === undefined ? (e.asyncLaunchedAgentId ?? e.backgroundTaskId) : undefined;
  if (backgroundTaskId !== undefined) {
    if (e.asyncLaunchedAgentId && placement.phaseRef?.kind === "phase") {
      const phase = draftPhase(d, placement.phaseRef.phaseId);
      const agent = phase && draftAgent(d, phase, placement.agentId);
      if (agent) agent.transcriptAgentId = e.asyncLaunchedAgentId;
    }
    // 起動 ACK は完了ではない（裁定A2）。閉じずに索引へ登録し、通知を待つ
    markBackgroundStarted(d, e.toolUseId, backgroundTaskId);
    return;
  }
  if (placement.declaredBackground === true && placement.agentId !== undefined && !e.isError) {
    // 宣言は background なのに ACK から id が取れない（本文が想定外）。completed へ倒さず、
    // 通知では決して閉じられない索引エントリ（鍵は toolUseId）にして終端イベントで stale にする
    markBackgroundStarted(d, e.toolUseId, e.toolUseId);
    return;
  }
  deletePlacement(d, e.toolUseId);
  if (placement.taskIntent !== undefined) {
    if (!e.isError && placement.parentToolUseId === null && placement.taskIntent.kind === "todo")
      recordPlanHistory(d, { kind: "todos", at: e.timestamp, items: placement.taskIntent.items });
    if (!e.isError) {
      const intent = placement.taskIntent;
      const taskKey = intent.kind === "create" ? taskCreateKeyFromResult(intent.toolUseId, e.resultPreview)
        : intent.kind === "update" ? intent.taskKey : undefined;
      const previousTask = d.next.tasks.find(task => task.taskKey === taskKey);
      applyTaskIntent(d, placement.taskIntent, e);
      if (placement.parentToolUseId === null && placement.taskIntent.kind !== "todo") {
        const task = d.next.tasks.find(task => task.taskKey === taskKey) ?? previousTask;
        if (task) recordPlanHistory(d, { kind: "todos", source: "tasks", at: e.timestamp,
          ...(intent.kind === "create" ? { created: true } : {}),
          ...(intent.kind === "update" && intent.deleted ? { removed: true } : {}),
          items: [{ taskKey: task.taskKey, description: task.description, activeForm: task.activeForm, status: task.status }] });
      }
    }
    return;
  }
  removeRunningAgent(d, e.toolUseId);
  removeRunningTool(d, e.toolUseId);
  const elapsedMs = Math.max(0, e.timestamp - placement.startedAt);
  // 配置は開始時に固定されている。カード切替後に終了しても、集計は開始時の segment へ入る
  // ターン終端で stale へ畳んだ後に遅れて終わる経路があるので、
  // どちらの計数から引くかは placement.stale で決める（両方 running から引くと負になる）
  const segment = draftSegment(d, placement.segmentId);
  if (segment && placement.counted) {
    if (placement.stale) segment.staleCount--;
    else segment.runningCount--;
    segment.elapsedMs += elapsedMs;
    if (e.isError) segment.failCount++;
  } else if (segment && placement.ownerAgentId !== undefined && e.isError) {
    segment.childFailCount++;
  }
  const target = draftTotals(d, placement.phaseRef);
  if (!target) return;
  if (target.phase) target.phase.endedAt = e.timestamp;
  if (target.rollup) target.rollup.endedAt = Math.max(target.rollup.endedAt, e.timestamp);

  // 子ツールの経過時間は agent 自身の経過時間に含まれるため、counted のときだけ加算する
  if (placement.counted) {
    target.totals.elapsedMs += elapsedMs;
    if (e.isError) target.totals.failCount++;
  } else if (placement.ownerAgentId !== undefined && e.isError) {
    target.totals.childFailCount++;
    if (target.phase) {
      const ownerAgent = draftAgent(d, target.phase, placement.ownerAgentId);
      if (ownerAgent) ownerAgent.failCount++;
    }
  }
  if (placement.agentId === undefined) return;

  if (placement.stale) target.totals.staleCount--;
  else target.totals.runningCount--;
  const tokens = parseSubagentTokens(e.resultPreview);
  if (tokens !== undefined) target.totals.agentTokens += tokens;

  const agent = target.phase ? draftAgent(d, target.phase, placement.agentId) : undefined;
  if (!agent) return;
  agent.status = e.isError ? "failed" : "completed";
  agent.endedAt = e.timestamp;
  agent.elapsedMs = elapsedMs;
  if (e.isError) agent.failCount++;
  if (tokens !== undefined) agent.tokens = tokens;
}

// ターン境界で、実行中として残っているものだけを stale にする。走査するのは実行中リストだけで、
// 完了済みは触らない（完了済みまで走査すると経過時間・tokens が毎ターン消える）。
// ターン開始側でも呼ぶ: 終端イベントを取りこぼした場合、ここが唯一の回収点になる
// （取りこぼすと前ターンの作業が「実行中」のまま永久に回り続ける）
// includeBackground=false（turn_completed / turn_started）は背景を残す。ストリーム継続中の区切りで
// 背景は生きている。true（turn_interrupted / turn_failed / conversation_closed）は query の終端で、
// CLI が背景を kill する。リストを無条件に空にしない——残した背景が追跡から落ち、
// 後の終端イベントで二度と回収できなくなる
function markRunningWorkStale(d: Draft, timestamp: number, includeBackground: boolean): void {
  const isBackground = (toolUseId: string): boolean => findToolPlacement(d.next, toolUseId)?.background !== undefined;
  const keptAgents: string[] = [];
  for (const toolUseId of d.next.runningAgentToolUseIds) {
    if (!includeBackground && isBackground(toolUseId)) {
      keptAgents.push(toolUseId);
      continue;
    }
    markToolStale(d, toolUseId, timestamp, true);
  }
  const keptTools: string[] = [];
  for (const toolUseId of d.next.runningToolUseIds) {
    if (!includeBackground && isBackground(toolUseId)) {
      keptTools.push(toolUseId);
      continue;
    }
    markToolStale(d, toolUseId, timestamp, false);
  }
  if (d.next.runningAgentToolUseIds.length !== keptAgents.length) {
    d.next.runningAgentToolUseIds = keptAgents;
    d.runningAgentsCopied = true;
  }
  if (d.next.runningToolUseIds.length !== keptTools.length) {
    d.next.runningToolUseIds = keptTools;
    d.runningToolsCopied = true;
  }
}

// 追跡をやめる承認は件数からも外す。外さないと approval_resolved が未知IDとして無視され、
// 全件解決してもその phase が承認待ちのまま残る
function untrackApproval(d: Draft, requestId: string): void {
  const phaseRef = d.next.approvalPlacements[requestId];
  d.next.approvalPlacements = withoutKey(draftApprovals(d), requestId);
  const evicted = draftTotals(d, phaseRef);
  if (evicted) evicted.totals.pendingApprovalCount--;
  markDetailsTruncated(d);
  const coverage = draftCoverage(d);
  coverage.untrackedApprovalCount = (coverage.untrackedApprovalCount ?? 0) + 1;
}

// 承認要求は現在phaseの出来事として数える。phase 境界にはしない（agent 起動と同じ扱い）
function handleApprovalRequest(d: Draft, e: Extract<NormalizedEvent, { kind: "approval_request" }>): void {
  // 同じ requestId の再送で二重に数えない。記録は1件しか持てないので、増やすと解決時に戻せない
  if (d.next.approvalPlacements[e.requestId] !== undefined) return;
  const phase = destination(d, "unknown", e.timestamp);
  const target = draftTotals(d, { kind: "phase", phaseId: phase.phaseId });
  if (!target) return;
  const keys = Object.keys(draftApprovals(d));
  if (keys.length >= MAX_TRACKED_APPROVALS) untrackApproval(d, keys[0]);
  target.totals.pendingApprovalCount++;
  draftApprovals(d)[e.requestId] = { kind: "phase", phaseId: phase.phaseId };
}

function handleApprovalResolved(d: Draft, e: Extract<NormalizedEvent, { kind: "approval_resolved" }>): void {
  const phaseRef = d.next.approvalPlacements[e.requestId];
  // 記録が無いのは上限退避（退避時に coverage へ記録済み）か、観測範囲外で始まった承認
  if (phaseRef === undefined) return;
  d.next.approvalPlacements = withoutKey(draftApprovals(d), e.requestId);
  const target = draftTotals(d, phaseRef);
  if (target) target.totals.pendingApprovalCount--;
}

function handleSubagentInfo(d: Draft, e: Extract<NormalizedEvent, { kind: "subagent_info" }>): void {
  const placement = findToolPlacement(d.next, e.toolUseId);
  if (!placement || placement.agentId === undefined || placement.phaseRef?.kind !== "phase") return;
  const phase = draftPhase(d, placement.phaseRef.phaseId);
  if (!phase) return;
  const agent = draftAgent(d, phase, placement.agentId);
  if (!agent) return;
  if (e.model !== undefined) agent.modelMeasured = e.model;
  if (e.agentId !== undefined) agent.transcriptAgentId = e.agentId;
}

function recordPlanHistory(d: Draft, entry: PlanHistoryEntry): void {
  const history = [...(d.next.planHistory ?? []), entry];
  // R-DSP-03: bound retained declaration events like tasks, and disclose the missing prefix in PLAN.
  if (history.length > MAX_TASKS) d.next.planHistoryTruncated = true;
  d.next.planHistory = history.slice(-MAX_TASKS);
}

function applySignal(d: Draft, signal: WorkSignal): void {
  switch (signal.kind) {
    case "tool_call_started":
      handleToolStart(d, signal);
      return;
    case "tool_call_finished":
      handleToolFinish(d, signal);
      return;
    case "subagent_info":
      handleSubagentInfo(d, signal);
      return;
    case "approval_request":
      handleApprovalRequest(d, signal);
      return;
    case "approval_resolved":
      handleApprovalResolved(d, signal);
      return;
    case "assistant_message_uuid":
      if (d.next.planText?.turnId === signal.turnId) d.next.planText = { ...d.next.planText, recordEnded: true };
      return;
    case "assistant_text_delta": {
      const previous = d.next.planText?.turnId === signal.turnId ? d.next.planText : undefined;
      const head = previous === undefined ? "" : previous.text + (previous.recordEnded ? recordSeparator(previous.text) : "");
      const text = head + signal.text;
      let declaredThrough = previous?.declaredThrough ?? -1;
      if (text.includes("laisora-plan")) {
        for (const node of parseMarkdown(text)) {
          if (node.type !== "plan" || node.offset <= declaredThrough) continue;
          d.next.planDeclaration = { goal: node.goal, at: signal.timestamp };
          declaredThrough = node.offset;
        }
      }
      const boundary = findCommitBoundary(text, 0);
      d.next.planText = { turnId: signal.turnId, text: boundary < 0 ? text : text.slice(boundary),
        declaredThrough: boundary < 0 ? declaredThrough : declaredThrough - boundary };
      // ツールを1件も使わないターンでも概要を空にしない
      const phase = destination(d, "unknown", signal.timestamp);
      place(d, phase, signal.timestamp, signal.turnId);
      relabelFallbackPhase(d, phase);
      return;
    }
    case "turn_completed":
      d.next.turnActive = false;
      closeSegment(d, signal.timestamp);
      markRunningWorkStale(d, signal.timestamp, false);
      return;
    case "turn_interrupted":
    case "turn_failed":
      d.next.turnActive = false;
      closeSegment(d, signal.timestamp);
      markRunningWorkStale(d, signal.timestamp, true);
      return;
    case "turn_started":
      d.next.turnActive = true;
      closeSegment(d, signal.timestamp);
      settlePendingStale(d, signal.timestamp);
      markRunningWorkStale(d, signal.timestamp, false);
      return;
    case "conversation_closed":
      d.next.turnActive = false;
      closeSegment(d, signal.timestamp);
      markRunningWorkStale(d, signal.timestamp, true);
      return;
    case "background_tasks":
      notePendingStale(d, signal.tasks);
      return;
    case "user_message":
      if (isRequestMessageText(signal.text)) recordPlanHistory(d, { kind: "user", at: signal.timestamp });
      closeSegment(d, signal.timestamp);
      return;
    default:
      return;
  }
}

// bounded EventLog から詳細イベントを落としたことを集計側へ出す。reducer は落とす前の
// イベントを既に畳んでいるので summary は欠けないが、details は欠ける。
// revision は進めない。WorkSignal 列から再計算した WorkModel と revision まで一致する
// ことが前提で、切り詰め回数だけ live 側が先へ進むと崩れる
export function markEventLogTrimmed(state: WorkModelState, droppedCount: number): WorkModelState {
  if (droppedCount <= 0) return state;
  return {
    ...state,
    coverage: {
      ...state.coverage,
      details: "prefix-truncated",
      droppedEventCount: (state.coverage.droppedEventCount ?? 0) + droppedCount,
    },
  };
}

// resume でサブエージェントの meta / transcript を読めなかったぶんを出す。
// meta が読めないと agent tree ごと欠けるので、その場合は概要も欠落扱いにする
// （読めていないのに「概要: セッション全体」と表示しないため）
export function markSubagentGaps(
  state: WorkModelState,
  gaps: { unreadableAgentCount: number; hierarchyIncomplete: boolean }
): WorkModelState {
  if (gaps.unreadableAgentCount <= 0 && !gaps.hierarchyIncomplete) return state;
  const coverage: WorkCoverage = { ...state.coverage, details: "prefix-truncated" };
  if (gaps.unreadableAgentCount > 0) {
    coverage.unreadableAgentCount = (coverage.unreadableAgentCount ?? 0) + gaps.unreadableAgentCount;
  }
  if (gaps.hierarchyIncomplete) {
    coverage.summary = "prefix-truncated";
    coverage.hierarchyIncomplete = true;
  }
  return { ...state, coverage };
}

export function reduceWorkModel(previousState: WorkModelState, workSignal: WorkSignal): WorkModelState {
  const d = beginDraft(previousState);
  applySignal(d, workSignal);
  return d.next;
}

export function deriveWorkModel(
  workSignals: readonly WorkSignal[],
  initialCheckpoint: WorkModelState = createWorkModelState()
): WorkModel {
  let state = initialCheckpoint;
  for (const signal of workSignals) state = reduceWorkModel(state, signal);
  return state;
}
