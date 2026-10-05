import type { ToolIntentInput } from "./webview/status-line";
import type { NormalizedEvent } from "./protocol.js";
import * as l10n from "@vscode/l10n";
import { isRequestMessageText } from "./time-buckets";
import { isPureCommandWrapper } from "./human-input-vocabulary";
import { parseMarkdown } from "./webview/markdown-ast";
import { findCommitBoundary, recordSeparator } from "./webview/commit-boundary";

export const MAX_PHASES = 256;

const MAX_SEGMENTS = 512;
const MAX_PHASE_REFS = 64;
const MAX_PHASE_AGENTS = 64;
const MAX_TASKS = 256;
const MAX_TRACKED_TOOL_USES = 8192;
const PLACEMENT_BUCKETS = 64;
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
  untrackedApprovalCount?: number;
  untrackedBackgroundCount?: number;
  unreadableAgentCount?: number;
  omittedTranscriptCount?: number;
  depthLimitedAgentCount?: number;
  hierarchyIncomplete?: true;
  reducerErrorCount?: number;
  hydrationUnconfirmed?: "loading" | "failed";
  historyReadError?: string;
  historyMalformedLineCount?: number;
  unparsedTaskInputCount?: number;
  evidenceFoldErrorCount?: number;
  semanticDerivationFailed?: "stale" | "unavailable";
  phaseHistory: "complete" | "prefix-compacted";
  compactedPhaseCount: number;
}

export type WorkPhaseState = "approval" | "failed" | "running" | "stale" | "done";

export function phaseStateOf(totals: WorkTotals, isCurrent: boolean, turnActive: boolean): WorkPhaseState {
  if (totals.pendingApprovalCount > 0) return "approval";
  if (totals.failCount > 0 || totals.childFailCount > 0) return "failed";
  if (totals.runningCount > 0 || (totals.backgroundRunningCount ?? 0) > 0) return "running";
  if (isCurrent && turnActive) return "running";
  if (totals.staleCount > 0) return "stale";
  return "done";
}

export interface WorkTotals {
  elapsedMs: number;
  toolCount: number;
  failCount: number;
  operationCounts: Record<OperationKind, number>;
  taskCount: number;
  agentCount: number;
  agentTokens: number;
  childToolCount: number;
  childFailCount: number;
  staleCount: number;
  runningCount: number;
  backgroundRunningCount?: number;
  pendingApprovalCount: number;
  revision: number;
}

export interface WorkTask {
  taskKey: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  occurrence: number;
  compacted?: boolean;
  revision: number;
}

export interface WorkAgent {
  runStartedAt?: number;
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
  toolCount: number;
  failCount: number;
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

export interface WorkTool {
  requestIndex?: number;
  intentInput?: ToolIntentInput;
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
  background?: { taskId: string };
  declaredBackground?: true;
  resumedAt?: number;
  notifiedTokens?: number;
}

export interface BackgroundTaskEntry {
  toolUseId: string;
  kind: "agent" | "tool";
  terminal?: "completed" | "failed" | "stale";
  pendingStale?: true;
}

export interface ToolPlacementIndex {
  buckets: Record<string, WorkTool>[];
  size: number;
}

export interface WorkModelState {
  requests?: WorkRequestTotals[];
  requestOffset?: number;
  requestByTurn?: Record<string, number>;
  requestHeadline?: { turnId: string | null; text: string };
  planDeclaration?: { goal: string; at: number };
  planBoundaryAt?: number;
  planText?: { turnId: string; text: string; declaredThrough: number; recordEnded?: true };
  planHistory?: PlanHistoryEntry[];
  planHistoryTruncated?: boolean;
  planHistoryLostThrough?: number;
  revision: number;
  displayOnlySignalCount?: number;
  phases: WorkPhase[];
  rollup?: WorkRollup;
  segments: WorkSegment[];
  tasks: WorkTask[];
  toolPlacements: ToolPlacementIndex;
  approvalPlacements: Record<string, PhaseRef>;
  phaseByTaskKey: Record<string, string>;
  runningAgentToolUseIds: string[];
  runningToolUseIds: string[];
  backgroundTasks: Record<string, BackgroundTaskEntry>;
  activeTaskKey?: string;
  ambiguity?: "multiple-active-tasks";
  omittedActiveTaskCount: number;
  fallbackOperation: FallbackOperation;
  turnActive: boolean;
  currentPhaseId?: string;
  currentSegmentId?: string;
  nextPhaseOrdinal: number;
  nextSegmentOrdinal: number;
  unparsedInputCount: number;
  coverage: WorkCoverage;
}

export type WorkModel = WorkModelState;
export interface WorkRequestTotals {
  incomplete?: true;
  turnIds: string[];
  number: string;
  command?: string;
  cliInserted?: boolean;
  toolCount: number;
  agentCount: number;
  failCount: number;
  revision: number;
}

function draftRequest(d: Draft, index: number | undefined): WorkRequestTotals | undefined {
  if (index !== undefined) index -= d.next.requestOffset ?? 0;
  if (index === undefined || !d.next.requests?.[index]) return undefined;
  d.next.requests = d.next.requests.slice();
  const request = { ...d.next.requests[index], revision: d.next.revision };
  d.next.requests[index] = request;
  return request;
}

function startRequest(d: Draft, signal: Extract<WorkSignal, { kind: "turn_started" }>): void {
  if (d.next.requests === undefined) return;
  if (d.next.requestByTurn?.[signal.turnId] !== undefined) return;
  const headline = d.next.requestHeadline;
  const text = !signal.cliInserted && headline && (headline.turnId === null || headline.turnId === signal.turnId) ? headline.text : undefined;
  const command = text !== undefined && isPureCommandWrapper(text) ? text : undefined;
  const requests = d.next.requests ?? [];
  const previous = requests.at(-1);
  const repeats = command !== undefined && previous?.command === command;
  const index = (d.next.requestOffset ?? 0) + (repeats ? requests.length - 1 : requests.length);
  let dropped: readonly string[] = [];
  if (repeats) {
    const request = draftRequest(d, index)!;
    request.turnIds = [...request.turnIds, signal.turnId];
    if (request.turnIds.length > MAX_PHASE_REFS) {
      request.incomplete = true;
      dropped = [request.turnIds.shift()!];
    }
  } else {
    d.next.requests = [...requests, { turnIds: [signal.turnId], number: String(index + 1).padStart(2, "0"),
      command, cliInserted: signal.cliInserted, toolCount: 0, agentCount: 0, failCount: 0, revision: d.next.revision }];
    if (d.next.requests.length > MAX_TASKS) {
      dropped = d.next.requests.shift()!.turnIds;
      d.next.requestOffset = (d.next.requestOffset ?? 0) + 1;
    }
  }
  d.next.requestByTurn = withKey(d.next.requestByTurn, signal.turnId, index, new Set(dropped));
  if (text !== undefined) d.next.requestHeadline = undefined;
}

function reconcileRequestCommands(d: Draft, turnId: string, text: string): void {
  const index = d.next.requestByTurn?.[turnId];
  const request = draftRequest(d, index);
  if (!request || request.cliInserted) return;
  request.command = isPureCommandWrapper(text) ? text : undefined;
  const offset = d.next.requestOffset ?? 0;
  const merged: WorkRequestTotals[] = [];
  const indices = new Map<number, number>();
  for (const [i, current] of d.next.requests!.entries()) {
    const previous = merged.at(-1);
    if (current.command !== undefined && previous?.command === current.command) {
      previous.turnIds = [...previous.turnIds, ...current.turnIds];
      previous.toolCount += current.toolCount;
      previous.agentCount += current.agentCount;
      previous.failCount += current.failCount;
      previous.incomplete ||= current.incomplete;
      previous.revision = d.next.revision;
      if (previous.turnIds.length > MAX_PHASE_REFS) {
        previous.incomplete = true;
        previous.turnIds = previous.turnIds.slice(-MAX_PHASE_REFS);
      }
    } else {
      merged.push({ ...current, number: String(offset + merged.length + 1).padStart(2, "0") });
    }
    indices.set(offset + i, offset + merged.length - 1);
  }
  if (merged.length === d.next.requests!.length) return;
  d.next.requests = merged;
  d.next.requestByTurn = Object.fromEntries(merged.flatMap((r, i) => r.turnIds.map(id => [id, offset + i])));
  for (const bucket of d.next.toolPlacements.buckets) for (const placement of Object.values(bucket)) {
    const nextIndex = indices.get(placement.requestIndex!);
    if (nextIndex !== undefined && nextIndex !== placement.requestIndex) draftPlacement(d, placement.toolUseId)!.requestIndex = nextIndex;
  }
}
export type PlanHistoryEntry = { at: number; kind: "user" } | {
  at: number; kind: "todos"; source?: "tasks"; created?: boolean; removed?: boolean; items: Extract<TaskIntent, { kind: "todo" }>["items"];
} | {
  at: number; kind: "resume"; agentId: string; description: string; status: WorkStatus; endedAt?: number;
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

export function isBookkeepingTool(toolName: string): boolean {
  return CLAUDE_VOCABULARY.task.has(toolName);
}

function buildVerifyCommandRegex(commands: readonly string[]): RegExp | null {
  if (commands.length === 0) return null;
  return new RegExp(`^(?:${commands.join("|")})(?:[ \\t][^\\n\\r]*)?$`);
}

const CLAUDE_VERIFY_COMMAND_RE = buildVerifyCommandRegex(CLAUDE_VOCABULARY.verifyCommands);

const TASK_CREATE_ID_RE = /Task #(\d+)\b/;
const TASK_CREATE_JSON_ID_RE = /"id"\s*:\s*"?([^",}\s]+)"?/;
const SUBAGENT_TOKENS_RE = /subagent_tokens[":\s]*(\d+)/;
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
    requests: [],
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

function withoutKey<T>(source: Record<string, T>, omitted: string): Record<string, T> {
  const target: Record<string, T> = {};
  for (const key in source) {
    if (key === omitted) continue;
    target[key] = source[key];
  }
  return target;
}

function withKey<T>(source: Record<string, T> | undefined, key: string, value: T, omitted: ReadonlySet<string>): Record<string, T> {
  const target: Record<string, T> = {};
  for (const existing in source) {
    if (!omitted.has(existing)) target[existing] = source[existing];
  }
  target[key] = value;
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

function markDetailsTruncated(d: Draft, omittedTools = 0): void {
  const coverage = draftCoverage(d);
  coverage.details = "prefix-truncated";
  if (omittedTools > 0) coverage.omittedToolCount = (coverage.omittedToolCount ?? 0) + omittedTools;
}

function markSummaryTruncated(d: Draft): void {
  draftCoverage(d).summary = "prefix-truncated";
}

function pushBounded(d: Draft, values: string[], value: string, limit: number): void {
  values.push(value);
  if (values.length <= limit) return;
  values.shift();
  markDetailsTruncated(d);
}

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

function applyTodoIntent(
  d: Draft,
  items: { taskKey: string; description: string; activeForm?: string; status: TaskStatus }[]
): void {
  const tasks = draftTasks(d);
  const previous = new Map(tasks.map((task) => [task.taskKey, task]));
  const retained = tasks.filter((task) => !task.taskKey.startsWith("todo:"));
  const todoTasks = items.map((item) => {
    const old = previous.get(item.taskKey);
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

function trackRunningTool(d: Draft, toolUseId: string): void {
  draftRunningTools(d).push(toolUseId);
}

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
  markSummaryTruncated(d);
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
  if (isBookkeepingTool(e.toolName)) {
    const intent = e.taskIntentStructured ?? parseTaskIntent(e);
    if (intent) {
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

  const requestIndex = owner?.requestIndex ?? state.requestByTurn?.[e.turnId];
  const request = draftRequest(d, requestIndex);
  if (request) {
    request.toolCount++;
    if (agentId !== undefined) request.agentCount++;
  }

  setPlacement(d, {
    requestIndex,
    toolUseId: e.toolUseId,
    parentToolUseId: e.parentToolUseId,
    toolName: e.toolName,
    intentInput: e.intentInput,
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

function finishBackground(
  d: Draft,
  placement: WorkTool,
  timestamp: number,
  status: "completed" | "failed" | "stale"
): void {
  if (status === "failed") {
    const request = draftRequest(d, placement.requestIndex);
    if (request) request.failCount++;
  }
  const elapsedMs = Math.max(0, timestamp - (placement.resumedAt ?? placement.startedAt));
  const segment = draftSegment(d, placement.segmentId);
  if (segment && placement.counted) {
    if (placement.stale) segment.staleCount--;
    else segment.runningCount--;
    segment.elapsedMs += elapsedMs;
    if (status === "failed") segment.failCount++;
  } else if (segment && placement.ownerAgentId !== undefined && status === "failed") {
    segment.childFailCount++;
  }
  const target = draftTotals(d, placement.phaseRef);
  if (target) {
    if (target.phase) target.phase.endedAt = Math.max(target.phase.endedAt ?? 0, timestamp);
    if (target.rollup) target.rollup.endedAt = Math.max(target.rollup.endedAt, timestamp);
    if (placement.counted) {
      target.totals.elapsedMs += elapsedMs;
      if (status === "failed") target.totals.failCount++;
    } else if (placement.ownerAgentId !== undefined && status === "failed") {
      target.totals.childFailCount++;
      if (target.phase) {
        const owner = draftAgent(d, target.phase, placement.ownerAgentId);
        if (owner) owner.failCount++;
      }
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
  if (placement.agentId === undefined) {
    deletePlacement(d, placement.toolUseId);
  } else {
    const p = draftPlacement(d, placement.toolUseId);
    if (p && status === "stale") p.stale = true;
  }
}

function recordNotifiedTokens(d: Draft, toolUseId: string, tokens: number): void {
  const placement = draftPlacement(d, toolUseId);
  if (!placement || placement.agentId === undefined) return;
  const target = draftTotals(d, placement.phaseRef);
  if (target) {
    target.totals.agentTokens += tokens - (placement.notifiedTokens ?? 0);
    const agent = target.phase ? draftAgent(d, target.phase, placement.agentId) : undefined;
    if (agent) agent.tokens = tokens;
  }
  placement.notifiedTokens = tokens;
}

function closeBackgroundByNotification(
  d: Draft,
  taskId: string,
  status: string | undefined,
  timestamp: number,
  tokens: number | undefined
): void {
  const entry = d.next.backgroundTasks[taskId];
  if (entry === undefined) return;
  if (entry.terminal === undefined) {
    const terminal: "completed" | "failed" | "stale" =
      status === "completed" ? "completed" : status === "failed" ? "failed" : "stale";
    draftBackgroundTasks(d)[taskId] = { toolUseId: entry.toolUseId, kind: entry.kind, terminal };
    const placement = findToolPlacement(d.next, entry.toolUseId);
    if (placement) finishBackground(d, placement, timestamp, terminal);
  }
  if (entry.kind === "agent" && tokens !== undefined) recordNotifiedTokens(d, entry.toolUseId, tokens);
}

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
      recordPlanHistory(d, { kind: "resume", at: timestamp, agentId: agent.agentId, description: agent.description,
        status: agent.status, ...(agent.endedAt === undefined ? {} : { endedAt: agent.endedAt }) });
      agent.status = "running";
      agent.runStartedAt = timestamp;
      agent.endedAt = undefined;
    }
  }
  if (!d.next.runningAgentToolUseIds.includes(placement.toolUseId)) draftRunningAgents(d).push(placement.toolUseId);
}

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
  if (e.taskNotification !== undefined) {
    closeBackgroundByNotification(d, e.taskNotification.agentId, e.taskNotification.status, e.timestamp, e.taskNotification.tokens);
    return;
  }
  if (e.resumedAgentId !== undefined && !e.isError) reopenBackground(d, e.resumedAgentId, e.timestamp);
  const placement = findToolPlacement(d.next, e.toolUseId);
  if (!placement) return;
  const backgroundTaskId =
    !e.isError && placement.taskIntent === undefined ? (e.asyncLaunchedAgentId ?? e.backgroundTaskId) : undefined;
  if (backgroundTaskId !== undefined) {
    if (e.asyncLaunchedAgentId && placement.phaseRef?.kind === "phase") {
      const phase = draftPhase(d, placement.phaseRef.phaseId);
      const agent = phase && draftAgent(d, phase, placement.agentId);
      if (agent) agent.transcriptAgentId = e.asyncLaunchedAgentId;
    }
    markBackgroundStarted(d, e.toolUseId, backgroundTaskId);
    return;
  }
  if (placement.declaredBackground === true && placement.agentId !== undefined && !e.isError) {
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
  if (e.isError) {
    const request = draftRequest(d, placement.requestIndex);
    if (request) request.failCount++;
  }
  const elapsedMs = Math.max(0, e.timestamp - placement.startedAt);
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

function untrackApproval(d: Draft, requestId: string): void {
  const phaseRef = d.next.approvalPlacements[requestId];
  d.next.approvalPlacements = withoutKey(draftApprovals(d), requestId);
  const evicted = draftTotals(d, phaseRef);
  if (evicted) evicted.totals.pendingApprovalCount--;
  markDetailsTruncated(d);
  const coverage = draftCoverage(d);
  coverage.untrackedApprovalCount = (coverage.untrackedApprovalCount ?? 0) + 1;
}

function handleApprovalRequest(d: Draft, e: Extract<NormalizedEvent, { kind: "approval_request" }>): void {
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
  while (history.length > MAX_TASKS) {
    const earlier = history.findIndex(row => row.kind !== "user" && row.at < (d.next.planBoundaryAt ?? Number.NEGATIVE_INFINITY));
    const [lost] = history.splice(earlier < 0 ? 0 : earlier, 1);
    d.next.planHistoryTruncated = true;
    d.next.planHistoryLostThrough = Math.max(d.next.planHistoryLostThrough ?? Number.NEGATIVE_INFINITY, lost.at);
  }
  d.next.planHistory = history;
}

export function foldPlanDeclarationText(previous: WorkModelState["planText"], turnId: string, delta: string, at: number): {
  text: NonNullable<WorkModelState["planText"]>; declarations: { goal: string; at: number }[];
} {
  const prior = previous?.turnId === turnId ? previous : undefined;
  const head = prior === undefined ? "" : prior.text + (prior.recordEnded ? recordSeparator(prior.text) : "");
  const text = head + delta;
  let declaredThrough = prior?.declaredThrough ?? -1;
  const declarations: { goal: string; at: number }[] = [];
  if (text.includes("laisora-plan")) {
    for (const node of parseMarkdown(text)) {
      if (node.type !== "plan" || node.offset <= declaredThrough) continue;
      declarations.push({ goal: node.goal, at });
      declaredThrough = node.offset;
    }
  }
  const boundary = findCommitBoundary(text, 0);
  return { text: { turnId, text: boundary < 0 ? text : text.slice(boundary),
    declaredThrough: boundary < 0 ? declaredThrough : declaredThrough - boundary }, declarations };
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
      const folded = foldPlanDeclarationText(d.next.planText, signal.turnId, signal.text, signal.timestamp);
      d.next.planText = folded.text;
      for (const declaration of folded.declarations) d.next.planDeclaration = declaration;
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
      startRequest(d, signal);
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
      d.next.requestHeadline = { turnId: signal.turnId, text: signal.text.split("\n").find(line => line.trim().length > 0)?.trim() ?? "" };
      if (signal.turnId !== null && d.next.requestByTurn?.[signal.turnId] !== undefined) {
        reconcileRequestCommands(d, signal.turnId, d.next.requestHeadline.text);
        d.next.requestHeadline = undefined;
      }
      if (isRequestMessageText(signal.text)) recordPlanHistory(d, { kind: "user", at: signal.timestamp });
      closeSegment(d, signal.timestamp);
      return;
    case "compact_boundary":
      if (signal.priorGeneration !== true) return;
      d.next.planDeclaration = undefined;
      d.next.planBoundaryAt = signal.timestamp;
      return;
    default:
      return;
  }
}

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

export const DISPLAY_ONLY_SIGNAL_KINDS: ReadonlySet<WorkSignal["kind"]> = new Set<WorkSignal["kind"]>(["local_command_output"]);

export function reduceWorkModel(previousState: WorkModelState, workSignal: WorkSignal): WorkModelState {
  const d = beginDraft(previousState);
  applySignal(d, workSignal);
  if (DISPLAY_ONLY_SIGNAL_KINDS.has(workSignal.kind)) d.next.displayOnlySignalCount = (previousState.displayOnlySignalCount ?? 0) + 1;
  return d.next;
}

export function semanticRevision(state: WorkModelState): number {
  return state.revision - (state.displayOnlySignalCount ?? 0);
}

export function deriveWorkModel(
  workSignals: readonly WorkSignal[],
  initialCheckpoint: WorkModelState = createWorkModelState()
): WorkModel {
  let state = initialCheckpoint;
  for (const signal of workSignals) state = reduceWorkModel(state, signal);
  return state;
}
