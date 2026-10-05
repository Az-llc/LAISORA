import { captureToolIntentInput } from "./webview/status-line";
import { localCommandOutput, taskNotificationDisplayFields, taskNotificationPreview, toolResultPreview } from "./transcript-display";
import type { HostArtifactAccess } from "./artifact-access";
import type { AssistantUsage, AskUserQuestionSpec, EventProvenance, ImageRefInfo, NormalizedEventBody, RestoredAgent, RestoredApprovalCard, ResumePreviewMessage, TaskNotificationInfo } from "./protocol";
import type { ConversationMessage } from "./conversation-history";
import { assistantUsageFromRaw, RESUME_PREVIEW_MESSAGE_MAX, summarizeToolInput } from "./protocol";
import type { WorkCoverage } from "./work-model";
import { extractResumeSignals, extractStage0ToolFields, isResumeSignalToolName, parseTaskNotification } from "./tool-observation";
import { redactAbsolutePaths, redactOptional } from "./path-redaction";
import {
  formatRefusalMessage,
  extractAssistantTextBlocks,
  isApiErrorFrame,
  isRefusalErrorProse,
  parseRefusalNotice,
  refusalFallbackEvent,
  parseRefusalStop,
} from "./claude-normalizer";
import { parseHandoffEnvelope, type HandoffEnvelopeV2 } from "./handoff-envelope";
import {
  COMMAND_ARGS_RE,
  COMMAND_NAME_RE,
  INJECTED_TAG_RE,
  isGapBoundaryText,
  isNonHumanCommandName,
  joinTextBlocks,
  PURE_COMMAND_WRAPPER_RE,
  STEER_TAG_RE,
  LAISORA_ENVELOPE_RE,
} from "./human-input-vocabulary";

export interface HistoryEvent {
  body: NormalizedEventBody & { provenance: EventProvenance };
  timestamp: number;
  hostArtifacts?: HostArtifactAccess[];
  gapBoundaries?: number[];
}

export interface ReplayedTool {
  toolName: string;
  inputSummary?: string;
  inputPreview: string;
  isError?: boolean;
  resultPreview?: string;
}

export interface SessionTranscript {
  title: string;
  recordedModel?: string;
  messages: TranscriptMessage[];
  tools: ReplayedTool[];
  summaryInput: {
    messages: Array<{ role: "user" | "assistant"; text: string }>;
    tools: ReplayedTool[];
  };
  coverage: WorkCoverage;
  malformedLineCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  claudeCodeVersion?: string;
}

type TranscriptMessage = Omit<ConversationMessage, "uuid"> & { uuid?: string };

const REPLAY_MESSAGE_MAX = 80;
const REPLAY_TOOL_MAX = 200;
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const RESUME_TAIL_MAX_BYTES = 1024 * 1024;
const RESUME_TAIL_MAX_RECORDS = 1500;
const RESUME_CAPTURE_CHUNK_BYTES = 64 * 1024;

export interface ResumeReadSet {
  parentEndOffset: number;
  lastCompleteParentTimestamp: number | undefined;
  recordedModel?: string;
  subagents: Array<{ path: string; size: number }>;
}

async function readHandleRange(
  handle: import("node:fs/promises").FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

async function readUtf8Prefix(filePath: string, byteLength: number): Promise<string> {
  const { open } = await import("node:fs/promises");
  const handle = await open(filePath, "r");
  try {
    const buffer = await readHandleRange(handle, 0, byteLength);
    if (buffer.length !== byteLength) throw new Error("captured-prefix-short-read");
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function parsedTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function captureParentBoundary(
  handle: import("node:fs/promises").FileHandle,
  size: number
): Promise<Omit<ResumeReadSet, "subagents">> {
  let position = size;
  let boundaryFound = false;
  let parentEndOffset = 0;
  let suffix = Buffer.alloc(0);
  let lastCompleteParentTimestamp: number | undefined;
  let recordedModel: string | undefined;
  let assistantFound = false;
  const observeLine = (line: Buffer): void => {
    const record = parseRecord(line.toString("utf8"));
    if (!record) return;
    lastCompleteParentTimestamp ??= parsedTimestamp(record.timestamp);
    if (!assistantFound && record.type === "assistant" && record.isSidechain !== true) {
      assistantFound = true;
      const model = asRecord(record.message)?.model;
      recordedModel = typeof model === "string" && model.length > 0 && !model.startsWith("<") ? model : undefined;
    }
  };
  const scanFloor = Math.max(0, size - RESUME_TAIL_MAX_BYTES);

  while (position > 0) {
    if (boundaryFound && position <= scanFloor) {
      return { parentEndOffset, lastCompleteParentTimestamp, recordedModel };
    }
    const start = Math.max(0, position - RESUME_CAPTURE_CHUNK_BYTES);
    const chunk = await readHandleRange(handle, start, position - start);
    if (chunk.length !== position - start) throw new Error("captured-parent-short-read");
    let scan = chunk;
    if (!boundaryFound) {
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        position = start;
        continue;
      }
      boundaryFound = true;
      parentEndOffset = start + lastNewline + 1;
      scan = chunk.subarray(0, lastNewline + 1);
    }

    const combined = suffix.length > 0 ? Buffer.concat([scan, suffix]) : scan;
    let lineEnd = combined.length;
    for (let i = combined.length - 1; i >= 0; i--) {
      if (combined[i] !== 0x0a) continue;
      if (i + 1 < lineEnd) {
        observeLine(combined.subarray(i + 1, lineEnd));
        if (lastCompleteParentTimestamp !== undefined && assistantFound) {
          return { parentEndOffset, lastCompleteParentTimestamp, recordedModel };
        }
      }
      lineEnd = i;
    }
    suffix = Buffer.from(combined.subarray(0, lineEnd));
    position = start;
  }

  if (boundaryFound && suffix.length > 0) {
    observeLine(suffix);
  }
  return { parentEndOffset, lastCompleteParentTimestamp, recordedModel };
}

export async function captureResumeReadSet(parentPath: string): Promise<ResumeReadSet> {
  const { open, readdir, stat } = await import("node:fs/promises");
  const handle = await open(parentPath, "r");
  let boundary: Omit<ResumeReadSet, "subagents">;
  try {
    boundary = await captureParentBoundary(handle, (await handle.stat()).size);
  } finally {
    await handle.close();
  }

  const baseDir = parentPath.replace(/\.jsonl$/i, "");
  const subagentsDir = `${baseDir}/subagents`;
  const subagents: Array<{ path: string; size: number }> = [];
  if (baseDir !== parentPath) {
    let names: string[] = [];
    try {
      names = (await readdir(subagentsDir))
        .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
        .sort();
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
    const sizes = await Promise.all(names.map((name) => stat(`${subagentsDir}/${name}`)));
    for (let i = 0; i < names.length; i++) {
      subagents.push({ path: `${subagentsDir}/${names[i]}`, size: sizes[i].size });
    }
  }
  return { ...boundary, subagents };
}

export function createParseYielder(): () => Promise<void> | undefined {
  let recordCount = 0;
  let startedAt = Date.now();
  return () => {
    recordCount++;
    if (recordCount < 500 && Date.now() - startedAt < 8) return;
    return new Promise<void>((resolve) => setImmediate(() => {
      recordCount = 0;
      startedAt = Date.now();
      resolve();
    }));
  };
}

export function isHandoffGenerationBoundary(
  record: Record<string, unknown>,
  sessionId: string | undefined
): boolean {
  if (sessionId === undefined || sessionId.length === 0) return false;
  if (record.type !== "user") return false;
  if (record.isSidechain === true) return false;
  const parsed = parseHandoffEnvelope(verbatimTextOf(record));
  return parsed.ok && parsed.version === "2" && parsed.envelope.snapshot.forkSessionId === sessionId;
}

export async function readResumePreviewTail(
  parentPath: string,
  sessionId?: string
): Promise<ResumePreviewMessage[]> {
  const { open } = await import("node:fs/promises");
  const handle = await open(parentPath, "r");
  let buffer: Buffer;
  let start: number;
  try {
    const size = (await handle.stat()).size;
    start = Math.max(0, size - RESUME_TAIL_MAX_BYTES);
    buffer = await readHandleRange(handle, start, size - start);
  } finally {
    await handle.close();
  }

  if (start > 0) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline < 0) return [];
    buffer = buffer.subarray(firstNewline + 1);
  }

  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  buffer = buffer.subarray(0, lastNewline + 1);

  const lines = buffer.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const acceptRecord = createRecordUuidFilter();
  const queuedSources = queuedPromptSources(lines);
  const seenQueuedPrompts = new Set<string>();
  const messages: ResumePreviewMessage[] = [];
  const maybeYield = createParseYielder();
  let recordsScanned = 0;
  for (let i = lines.length - 1; i >= 0 && recordsScanned < RESUME_TAIL_MAX_RECORDS; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    recordsScanned++;
    const pendingYield = maybeYield();
    if (pendingYield) await pendingYield;
    const obj = parseRecord(line);
    if (!obj) continue;
    if (isHandoffGenerationBoundary(obj, sessionId)) break;
    if (!acceptRecord(obj) || obj.isSidechain === true) continue;
    const uuid = typeof obj.uuid === "string" ? obj.uuid : "";
    if (obj.type === "user" || obj.type === "attachment") {
      const prompt = extractHumanUserPrompt(obj, queuedSources, seenQueuedPrompts);
      if (prompt) {
        const { text, imageRefs, uuid } = prompt;
        if (!uuid) continue;
        messages.push({
          uuid,
          role: "user",
          text,
          ...(imageRefs && imageRefs.length > 0 ? { imageRefs } : {}),
        });
      }
    } else if (obj.type === "assistant") {
      if (!uuid) continue;
      const message = asRecord(obj.message);
      const text = extractAssistantRecordText(message?.content, obj.narration_block_indexes);
      if (text && !isRefusalErrorProse(obj, message)) {
        const rawModel = message?.model;
        const model = typeof rawModel === "string" && rawModel.length > 0 && !rawModel.startsWith("<") ? rawModel : undefined;
        messages.push({ uuid, role: "assistant", text, ...(model ? { model } : {}) });
      }
    }
    if (messages.length >= RESUME_PREVIEW_MESSAGE_MAX) break;
  }
  messages.reverse();
  return messages;
}

interface RawHistoryItem {
  body: NormalizedEventBody & { provenance: EventProvenance };
  timestamp: number;
  hostArtifacts?: HostArtifactAccess[];
  sourcePriority: number;
  fileOrder: number;
}

interface ParentTurnSpan {
  turnId: string;
  startedAt: number;
  endedAt: number;
}

export function createRecordUuidFilter(): (record: { uuid?: unknown }) => boolean {
  const seen = new Set<string>();
  return (record) => {
    const uuid = record.uuid;
    if (typeof uuid !== "string" || uuid.length === 0) return true;
    if (seen.has(uuid)) return false;
    seen.add(uuid);
    return true;
  };
}

function findTurnIdForTimestamp(
  turns: readonly ParentTurnSpan[],
  timestamp: number
): string {
  if (turns.length === 0) return "replay-turn-1";

  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.startedAt <= timestamp && timestamp <= t.endedAt) {
      return t.turnId;
    }
  }

  let closestTurn = turns[0];
  let minDistance = Infinity;
  for (const t of turns) {
    const dist = timestamp < t.startedAt
      ? t.startedAt - timestamp
      : timestamp > t.endedAt
      ? timestamp - t.endedAt
      : 0;
    if (dist < minDistance) {
      minDistance = dist;
      closestTurn = t;
    }
  }
  return closestTurn.turnId;
}

export async function readSessionHistory(
  parentFilePath: string,
  isAllowedPath: (p: string) => boolean,
  opts?: { subagentsDir?: string; resumeReadSet?: ResumeReadSet; generationSessionId?: string }
): Promise<{
  events: HistoryEvent[];
  coverage: WorkCoverage;
  claudeCodeVersion?: string;
  generationStartAt?: number;
  malformedLineCount: number;
  droppedTaskNotificationCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  subagentsReadError?: string;
}> {
  const coverage: WorkCoverage = {
    summary: "complete",
    details: "complete",
    source: "provider-transcript",
    phaseHistory: "complete",
    compactedPhaseCount: 0,
  };
  let malformedLineCount = 0;
  let readError: string | undefined;
  let subagentsReadError: string | undefined;
  let claudeCodeVersion: string | undefined;
  let cwd = "";
  let boundaryPartialExcludedCount = 0;
  const generationSessionId = opts?.generationSessionId;
  let generationStartAt: number | undefined;

  if (!isAllowedPath(parentFilePath)) {
    return {
      events: [],
      coverage: {
        ...coverage,
        summary: "prefix-truncated",
        details: "prefix-truncated",
        historyReadError: "outside-session-store",
      },
      malformedLineCount: 0,
      droppedTaskNotificationCount: 0,
      ...(opts?.resumeReadSet ? { boundaryPartialExcludedCount: 0 } : {}),
      readError: "outside-session-store",
    };
  }

  const rawEvents: RawHistoryItem[] = [];
  const preBoundaryCompacts = new Set<RawHistoryItem>();
  const parentTurns: ParentTurnSpan[] = [];
  const seenToolUseIds = new Set<string>();
  const seenToolResultIds = new Set<string>();

  const notificationOrdinals = new Map<string, number>();
  const observedAsyncAgentIds = new Set<string>();
  const observedBackgroundTaskIds = new Set<string>();
  const resumeSignalToolNames = new Map<string, string>();
  let droppedTaskNotificationCount = 0;
  const makeNotificationFields = (text: string | TaskNotificationInfo, record?: Record<string, unknown>) => {
    const notification = typeof text === "string" ? parseTaskNotification(text, {
      trustedOrigin: asRecord(record?.origin)?.kind === "task-notification",
    }) : text;
    if (!notification) return null;
    if (!observedAsyncAgentIds.has(notification.agentId) && !observedBackgroundTaskIds.has(notification.agentId)) {
      droppedTaskNotificationCount++;
      return null;
    }
    const ordinal = (notificationOrdinals.get(notification.agentId) ?? 0) + 1;
    notificationOrdinals.set(notification.agentId, ordinal);
    return {
      toolUseId: `task-notification:${notification.agentId}:${ordinal}`,
      resultPreview: taskNotificationPreview(notification),
      taskNotification: notification,
    };
  };
  const collectNotificationTexts = (content: unknown): string[] => {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    const texts: string[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    return texts;
  };

  let turnOrdinal = 0;
  let currentTurnId: string | null = null;
  let lastTurnActivityTimestamp = 0;
  let pendingSilentTurn = false;
  const openPendingSilentTurn = (at: number): void => {
    if (!pendingSilentTurn) return;
    pendingSilentTurn = false;
    turnOrdinal++;
    currentTurnId = "replay-turn-" + turnOrdinal;
    lastTurnActivityTimestamp = at;
    parentTurns.push({ turnId: currentTurnId, startedAt: at, endedAt: at });
    rawEvents.push({
      body: { kind: "turn_started", turnId: currentTurnId, provenance: { path: "history" } },
      timestamp: at,
      sourcePriority: 0,
      fileOrder: parentOrderCounter++,
    });
  };
  let lastParentTimestamp = 0;
  let parentOrderCounter = 0;
  let inlineSidechainSkipped = 0;
  const gapBoundaries: number[] = [];
  let subagentTranscriptsRead = 0;
  const listedSubagentAgentIds = new Set<string>();
  const seenAssistantUsageMessageIds = new Set<string>();
  let lastRootModel: string | null = null;
  let pendingUsage: {
    messageId: string;
    turnId: string;
    usage: AssistantUsage;
    timestamp: number;
  } | null = null;
  const flushPendingUsage = () => {
    if (!pendingUsage) return;
    rawEvents.push({
      body: {
        kind: "assistant_usage",
        turnId: pendingUsage.turnId,
        messageId: pendingUsage.messageId,
        parentToolUseId: null,
        usage: pendingUsage.usage,
        provenance: { path: "history" },
      },
      timestamp: pendingUsage.timestamp,
      sourcePriority: 0,
      fileOrder: parentOrderCounter++,
    });
    pendingUsage = null;
  };

  try {
    const { readFile, stat, readdir } = await import("node:fs/promises");
    const parentText = opts?.resumeReadSet
      ? await readUtf8Prefix(parentFilePath, opts.resumeReadSet.parentEndOffset)
      : await readFile(parentFilePath, "utf8");
    const acceptParentRecord = createRecordUuidFilter();
    const parentLines = parentText.split("\n");
    const queuedSources = queuedPromptSources(parentLines);
    const seenQueuedPrompts = new Set<string>();
    const parentEndsAtBoundary = parentText.endsWith("\n");
    const maybeYieldParent = createParseYielder();

    for (let parentLineIndex = 0; parentLineIndex < parentLines.length; parentLineIndex++) {
      const line = parentLines[parentLineIndex];
      if (!line.trim()) continue;
      const pendingYield = maybeYieldParent();
      if (pendingYield) await pendingYield;
      let obj: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          malformedLineCount++;
          continue;
        }
        obj = parsed as Record<string, unknown>;
      } catch {
        if (
          opts?.resumeReadSet &&
          !parentEndsAtBoundary &&
          parentLineIndex === parentLines.length - 1
        ) {
          boundaryPartialExcludedCount++;
          continue;
        }
        malformedLineCount++;
        continue;
      }

      if (!acceptParentRecord(obj)) continue;

      if (typeof obj.version === "string" && obj.version.length > 0) {
        claudeCodeVersion = obj.version;
      }
      if (!cwd && typeof obj.cwd === "string" && obj.cwd.length > 0) {
        cwd = obj.cwd;
      }

      if (obj.isSidechain === true) {
        inlineSidechainSkipped++;
        continue;
      }

      const rawTs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
      const recordTime = Number.isFinite(rawTs) ? rawTs : lastParentTimestamp;
      lastParentTimestamp = recordTime;

      if (generationSessionId !== undefined && isHandoffGenerationBoundary(obj, generationSessionId)) {
        generationStartAt = recordTime;
      }

      const message = asRecord(obj.message);
      const content = message?.content;
      const assistantMessageId =
        obj.type === "assistant" && typeof message?.id === "string" && message.id.length > 0
          ? message.id
          : null;
      if (pendingUsage && pendingUsage.messageId !== assistantMessageId) {
        flushPendingUsage();
      }

      const localOutput = localCommandOutput(obj);
      if (localOutput !== undefined) {
        const item: RawHistoryItem = {
          body: { kind: "local_command_output", text: localOutput,
            ...(typeof obj.uuid === "string" ? { uuid: obj.uuid } : {}), provenance: { path: "history" } },
          timestamp: recordTime, sourcePriority: 0, fileOrder: parentOrderCounter++,
        };
        if (generationSessionId !== undefined && generationStartAt === undefined) preBoundaryCompacts.add(item);
        rawEvents.push(item);
        continue;
      }

      if (obj.type === "user" || extractQueuedPromptRecord(obj) !== null) {
        const joinedText = joinTextBlocks(content);
        if (isGapBoundaryText(joinedText)) {
          gapBoundaries.push(recordTime);
        }
        const prompt = extractHumanUserPrompt(obj, queuedSources, seenQueuedPrompts);
        const humanText = prompt?.text ?? null;
        const cliInsertedText = obj.type === "user" && humanText === null ? extractCliInsertedUserText(obj) : null;
        if (humanText === null && currentTurnId !== null && STEER_TAG_RE.test(joinedText)) {
          const completedTime = lastTurnActivityTimestamp || recordTime;
          rawEvents.push({
            body: { kind: "turn_completed", turnId: currentTurnId, provenance: { path: "history" } },
            timestamp: completedTime,
            sourcePriority: 0,
            fileOrder: parentOrderCounter++,
          });
          if (parentTurns.length > 0) {
            parentTurns[parentTurns.length - 1].endedAt = completedTime;
          }
          currentTurnId = null;
          pendingSilentTurn = true;
        }
        const absorbedMidTurn = extractQueuedPromptRecord(obj) !== null && prompt !== null && currentTurnId !== null;
        if (absorbedMidTurn && prompt !== null) {
          rawEvents.push({
            body: { kind: "user_message", turnId: currentTurnId, text: prompt.text,
              ...(prompt.imageRefs ? { imageRefs: prompt.imageRefs } : {}), provenance: { path: "history" } },
            timestamp: recordTime, sourcePriority: 0, fileOrder: parentOrderCounter++,
          });
          lastTurnActivityTimestamp = recordTime;
        }
        if (!absorbedMidTurn && (prompt !== null || cliInsertedText !== null)) {
          pendingSilentTurn = false;
          if (currentTurnId !== null) {
            const completedTime = lastTurnActivityTimestamp || recordTime;
            rawEvents.push({
              body: {
                kind: "turn_completed",
                turnId: currentTurnId,
                provenance: { path: "history" },
              },
              timestamp: completedTime,
              sourcePriority: 0,
              fileOrder: parentOrderCounter++,
            });
            if (parentTurns.length > 0) {
              parentTurns[parentTurns.length - 1].endedAt = completedTime;
            }
          }

          turnOrdinal++;
          currentTurnId = `replay-turn-${turnOrdinal}`;
          lastTurnActivityTimestamp = recordTime;
          parentTurns.push({
            turnId: currentTurnId,
            startedAt: recordTime,
            endedAt: recordTime,
          });

          rawEvents.push({
            body: {
              kind: "turn_started",
              turnId: currentTurnId,
              ...(cliInsertedText !== null ? { cliInserted: true as const } : {}),
              provenance: { path: "history" },
            },
            timestamp: recordTime,
            sourcePriority: 0,
            fileOrder: parentOrderCounter++,
          });

          if (prompt !== null) {
            const imageRefs = prompt.imageRefs;
            rawEvents.push({
              body: {
                kind: "user_message",
                turnId: currentTurnId,
                text: prompt.text,
                ...(imageRefs ? { imageRefs } : {}),
                provenance: { path: "history" },
              },
              timestamp: recordTime,
              sourcePriority: 0,
              fileOrder: parentOrderCounter++,
            });
          }
        }

        if (Array.isArray(content)) {
          for (const block of content) {
            const toolResult = asRecord(block);
            if (toolResult?.type !== "tool_result" || typeof toolResult.tool_use_id !== "string") continue;
            const toolUseId = toolResult.tool_use_id;
            if (toolUseId.length === 0 || seenToolResultIds.has(toolUseId)) continue;
            seenToolResultIds.add(toolUseId);
            openPendingSilentTurn(recordTime);

            const raw = Array.isArray(toolResult.content)
              ? toolResult.content
                  .filter((c: unknown) => asRecord(c)?.type === "text")
                  .map((c: unknown) => String(asRecord(c)?.text ?? ""))
                  .join("\n")
              : typeof toolResult.content === "string"
                ? toolResult.content
                : "";
            const preview = toolResultPreview(toolResult.content);
            const isError = toolResult.is_error === true;
            const turnId = currentTurnId ?? "replay-turn-1";
            lastTurnActivityTimestamp = recordTime;
            const resumeSignals = extractResumeSignals(resumeSignalToolNames.get(toolUseId), raw);
            if (resumeSignals?.asyncLaunchedAgentId) observedAsyncAgentIds.add(resumeSignals.asyncLaunchedAgentId);
            if (resumeSignals?.resumedAgentId) observedAsyncAgentIds.add(resumeSignals.resumedAgentId);
            if (resumeSignals?.backgroundTaskId) observedBackgroundTaskIds.add(resumeSignals.backgroundTaskId);

            rawEvents.push({
              body: {
                kind: "tool_call_finished",
                turnId,
                toolUseId,
                isError,
                resultPreview: preview,
                ...(resumeSignals ?? {}),
                provenance: { path: "history" },
              },
              timestamp: recordTime,
              sourcePriority: 0,
              fileOrder: parentOrderCounter++,
            });
          }
        }

        for (const text of collectNotificationTexts(content)) {
          const fields = makeNotificationFields(text, obj);
          if (!fields) continue;
          rawEvents.push({
            body: {
              kind: "tool_call_finished",
              turnId: currentTurnId ?? "replay-turn-1",
              isError: false,
              ...fields,
              provenance: { path: "history" },
            },
            timestamp: recordTime,
            sourcePriority: 0,
            fileOrder: parentOrderCounter++,
          });
        }
      } else if (obj.type === "assistant") {
        openPendingSilentTurn(recordTime);
        const text = extractAssistantRecordText(content, obj.narration_block_indexes);
        const refusalStop = parseRefusalStop(message);
        const refusalIsErrorProse = refusalStop !== null && isApiErrorFrame(obj);
        const turnId = currentTurnId ?? "replay-turn-1";
        const messageId = typeof message?.id === "string" && message.id.length > 0 ? message.id : null;
        if (messageId && !seenAssistantUsageMessageIds.has(messageId)) {
          if (typeof message?.usage === "object" && message.usage !== null) {
            seenAssistantUsageMessageIds.add(messageId);
            pendingUsage = {
              messageId,
              turnId,
              usage: assistantUsageFromRaw(message.usage, true),
              timestamp: recordTime,
            };
          }
        } else if (pendingUsage && pendingUsage.messageId === messageId) {
          pendingUsage.timestamp = recordTime;
        }
        const model = typeof message?.model === "string" ? message.model : null;
        if (model !== null && !model.startsWith("<") && model !== lastRootModel) {
          lastRootModel = model;
          rawEvents.push({
            body: {
              kind: "model_observed",
              turnId,
              model,
              provenance: { path: "history" },
            },
            timestamp: recordTime,
            sourcePriority: 0,
            fileOrder: parentOrderCounter++,
          });
        }
        if (refusalStop !== null) {
          rawEvents.push({
            body: {
              kind: "error",
              message: formatRefusalMessage({
                content: refusalIsErrorProse && text ? text : null,
                explanation: refusalStop.explanation,
                category: refusalStop.category,
              }),
              fatal: false,
              provenance: { path: "history" },
            },
            timestamp: recordTime,
            sourcePriority: 0,
            fileOrder: parentOrderCounter++,
          });
        }
        if (text && !refusalIsErrorProse) {
          lastTurnActivityTimestamp = recordTime;
          rawEvents.push({
            body: {
              kind: "assistant_text_delta",
              turnId,
              text,
              provenance: { path: "history" },
            },
            timestamp: recordTime,
            sourcePriority: 0,
            fileOrder: parentOrderCounter++,
          });
          if (typeof obj.uuid === "string" && obj.uuid.length > 0) {
            rawEvents.push({
              body: {
                kind: "assistant_message_uuid",
                turnId,
                uuid: obj.uuid,
                provenance: { path: "history" },
              },
              timestamp: recordTime,
              sourcePriority: 0,
              fileOrder: parentOrderCounter++,
            });
          }
        }

        if (Array.isArray(content)) {
          for (const block of content) {
            const toolUse = asRecord(block);
            if (toolUse?.type !== "tool_use" || typeof toolUse.name !== "string") continue;
            const toolUseId = typeof toolUse.id === "string" ? toolUse.id : "";
            if (toolUseId.length === 0 || seenToolUseIds.has(toolUseId)) continue;
            seenToolUseIds.add(toolUseId);
            if (isResumeSignalToolName(toolUse.name)) {
              resumeSignalToolNames.set(toolUseId, toolUse.name);
            }

            const rawInput = asRecord(toolUse.input) ?? undefined;
            const currentCwd = (typeof obj.cwd === "string" && obj.cwd.length > 0 ? obj.cwd : cwd);
            const stage0 = extractStage0ToolFields(toolUse.name, rawInput, toolUseId, currentCwd);
            const inputSummary = redactOptional(summarizeToolInput(toolUse.name, toolUse.input) ?? undefined);
            const inputPreview = redactAbsolutePaths(JSON.stringify(toolUse.input) ?? "").slice(0, 2000);
            lastTurnActivityTimestamp = recordTime;

            rawEvents.push({
              body: {
                kind: "tool_call_started",
                turnId,
                toolUseId,
                parentToolUseId: null,
                toolName: toolUse.name,
                inputPreview,
                inputSummary,
                intentInput: captureToolIntentInput(toolUse.name, toolUse.input),
                isBackground: stage0.delegation?.isBackground,
                subagentType: stage0.delegation?.subagentType,
                subagentModel: stage0.delegation?.subagentModel,
                delegation: stage0.delegation,
                taskIntentStructured: stage0.taskIntentStructured,
                artifacts: stage0.artifacts,
                effectCoverage: stage0.effectCoverage,
                progressEmission: stage0.progressEmission,
                provenance: { path: "history" },
              },
              timestamp: recordTime,
              hostArtifacts: stage0.hostArtifacts.length > 0 ? stage0.hostArtifacts : undefined,
              sourcePriority: 0,
              fileOrder: parentOrderCounter++,
            });
          }
        }
      } else if (obj.type === "system" && obj.subtype === "compact_boundary") {
        const compactMeta = asRecord(obj.compactMetadata);
        const preTokens = compactMeta?.preTokens;
        const item: RawHistoryItem = {
          body: {
            kind: "compact_boundary",
            trigger: compactMeta?.trigger === "auto" ? "auto" : "manual",
            ...(typeof preTokens === "number" && Number.isFinite(preTokens) ? { preTokens } : {}),
            provenance: { path: "history" },
          },
          timestamp: recordTime,
          sourcePriority: 0,
          fileOrder: parentOrderCounter++,
        };
        if (generationSessionId !== undefined && generationStartAt === undefined) {
          preBoundaryCompacts.add(item);
        }
        rawEvents.push(item);
      } else if (obj.type === "system") {
        if (obj.subtype === "task_notification" && typeof obj.task_id === "string" && obj.task_id) {
          const tokens = asRecord(obj.usage)?.total_tokens;
          const fields = makeNotificationFields({ agentId: obj.task_id,
            ...(typeof obj.tool_use_id === "string" && obj.tool_use_id ? { toolUseId: obj.tool_use_id } : {}),
            ...(typeof obj.status === "string" && obj.status ? { status: obj.status } : {}),
            ...(typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? { tokens } : {}),
            ...taskNotificationDisplayFields(obj.summary, obj.result) });
          if (fields) rawEvents.push({ body: { kind: "tool_call_finished", turnId: currentTurnId ?? "replay-turn-1",
            isError: false, ...fields, provenance: { path: "history" } },
            timestamp: recordTime, sourcePriority: 0, fileOrder: parentOrderCounter++ });
        }
        const notice = parseRefusalNotice(obj);
        if (notice) {
          const fallback = refusalFallbackEvent(notice, currentTurnId);
          if (fallback?.scope === "session") lastRootModel = fallback.fallbackModel;
          if (fallback) rawEvents.push({
            body: { ...fallback, provenance: { path: "history" } },
            timestamp: recordTime, sourcePriority: 0, fileOrder: parentOrderCounter++,
          });
          if (!fallback) rawEvents.push({
            body: {
              kind: "error",
              message: formatRefusalMessage(notice),
              fatal: false,
              provenance: { path: "history" },
            },
            timestamp: recordTime,
            sourcePriority: 0,
            fileOrder: parentOrderCounter++,
          });
        }
      } else if (obj.type === "attachment") {
        const prompt = asRecord(obj.attachment)?.prompt;
        if (typeof prompt === "string") {
          for (const text of collectNotificationTexts(prompt)) {
            const fields = makeNotificationFields(text, obj);
            if (!fields) continue;
            rawEvents.push({
              body: {
                kind: "tool_call_finished",
                turnId: currentTurnId ?? "replay-turn-1",
                isError: false,
                ...fields,
                provenance: { path: "history" },
              },
              timestamp: recordTime,
              sourcePriority: 0,
              fileOrder: parentOrderCounter++,
            });
          }
        }
      }
    }

    flushPendingUsage();

    if (currentTurnId !== null) {
      const finalTimestamp = lastTurnActivityTimestamp || lastParentTimestamp || 0;
      rawEvents.push({
        body: {
          kind: "turn_completed",
          turnId: currentTurnId,
          provenance: { path: "history" },
        },
        timestamp: finalTimestamp,
        sourcePriority: 0,
        fileOrder: parentOrderCounter++,
      });
      if (parentTurns.length > 0) {
        parentTurns[parentTurns.length - 1].endedAt = finalTimestamp;
      }
    }

    const baseDir = parentFilePath.replace(/\.jsonl$/i, "");
    const subagentsDir = opts?.subagentsDir ?? `${baseDir}/subagents`;

    if (isAllowedPath(subagentsDir)) {
      let entries: string[] = [];
      const capturedSubagents = opts?.resumeReadSet?.subagents;
      const capturedByName = new Map<string, { path: string; size: number }>();
      if (capturedSubagents) {
        for (const captured of capturedSubagents) {
          const name = captured.path.split(/[\\/]/).pop() ?? "";
          if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
          capturedByName.set(name, captured);
          entries.push(name, name.replace(/\.jsonl$/i, ".meta.json"));
        }
      } else {
        try {
          entries = await readdir(subagentsDir);
        } catch (error) {
          if ((error as { code?: unknown }).code !== "ENOENT") {
            subagentsReadError = String(error);
          }
        }
      }

      if (entries.length > 0) {
        const metaMap = new Map<string, string>();
        const metaFiles = entries.filter((name) => name.startsWith("agent-") && name.endsWith(".meta.json"));
        for (const metaName of metaFiles) {
          const agentId = metaName.slice("agent-".length, metaName.length - ".meta.json".length);
          if (!agentId) continue;
          try {
            const rawMeta = JSON.parse(await readFile(`${subagentsDir}/${metaName}`, "utf8"));
            const metaObj = asRecord(rawMeta);
            if (metaObj && typeof metaObj.toolUseId === "string") {
              metaMap.set(agentId, metaObj.toolUseId);
            }
          } catch {
          }
        }

        const agentJsonlFiles = entries
          .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
          .sort();

        let childFileIndex = 0;
        for (const jsonlName of agentJsonlFiles) {
          childFileIndex++;
          const agentId = jsonlName.slice("agent-".length, jsonlName.length - ".jsonl".length);
          listedSubagentAgentIds.add(agentId);
          const childFilePath = `${subagentsDir}/${jsonlName}`;
          const captured = capturedByName.get(jsonlName);
          const effectiveChildPath = captured?.path ?? childFilePath;
          const parentToolUseId = metaMap.get(agentId) ?? null;

          let fileSize: number;
          if (captured) {
            fileSize = captured.size;
          } else {
            try {
              fileSize = (await stat(childFilePath)).size;
            } catch {
              coverage.details = "prefix-truncated";
              coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
              continue;
            }
          }

          if (fileSize > MAX_SUBAGENT_TRANSCRIPT_BYTES || !isAllowedPath(effectiveChildPath)) {
            coverage.details = "prefix-truncated";
            coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
            continue;
          }

          let childText: string;
          try {
            childText = captured
              ? await readUtf8Prefix(effectiveChildPath, captured.size)
              : await readFile(childFilePath, "utf8");
            subagentTranscriptsRead++;
          } catch {
            coverage.details = "prefix-truncated";
            coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
            continue;
          }

          let childLastTimestamp = 0;
          let childOrderCounter = 0;
          const acceptChildRecord = createRecordUuidFilter();
          const childLines = childText.split("\n");
          const childEndsAtBoundary = childText.endsWith("\n");
          const maybeYieldChild = createParseYielder();

          for (let childLineIndex = 0; childLineIndex < childLines.length; childLineIndex++) {
            const line = childLines[childLineIndex];
            if (!line.trim()) continue;
            const pendingYield = maybeYieldChild();
            if (pendingYield) await pendingYield;
            let obj: Record<string, unknown>;
            try {
              const parsed: unknown = JSON.parse(line);
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                malformedLineCount++;
                continue;
              }
              obj = parsed as Record<string, unknown>;
            } catch {
              if (captured && !childEndsAtBoundary && childLineIndex === childLines.length - 1) {
                boundaryPartialExcludedCount++;
                continue;
              }
              malformedLineCount++;
              continue;
            }

            if (!acceptChildRecord(obj)) continue;

            const rawTs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
            const recordTime = Number.isFinite(rawTs) ? rawTs : childLastTimestamp;
            childLastTimestamp = recordTime;

            const turnId = findTurnIdForTimestamp(parentTurns, recordTime);
            const message = asRecord(obj.message);
            const content = message?.content;

            if (obj.type === "user") {
              if (Array.isArray(content)) {
                for (const block of content) {
                  const toolResult = asRecord(block);
                  if (toolResult?.type !== "tool_result" || typeof toolResult.tool_use_id !== "string") continue;
                  const toolUseId = toolResult.tool_use_id;
                  if (toolUseId.length === 0 || seenToolResultIds.has(toolUseId)) continue;
                  seenToolResultIds.add(toolUseId);

                  const raw = Array.isArray(toolResult.content)
                    ? toolResult.content
                        .filter((c: unknown) => asRecord(c)?.type === "text")
                        .map((c: unknown) => String(asRecord(c)?.text ?? ""))
                        .join("\n")
                    : typeof toolResult.content === "string"
                      ? toolResult.content
                      : "";
                  const preview = toolResultPreview(toolResult.content);
                  const isError = toolResult.is_error === true;
                  const resumeSignals = extractResumeSignals(resumeSignalToolNames.get(toolUseId), raw);
                  if (resumeSignals?.asyncLaunchedAgentId) observedAsyncAgentIds.add(resumeSignals.asyncLaunchedAgentId);
                  if (resumeSignals?.resumedAgentId) observedAsyncAgentIds.add(resumeSignals.resumedAgentId);
                  if (resumeSignals?.backgroundTaskId) observedBackgroundTaskIds.add(resumeSignals.backgroundTaskId);

                  rawEvents.push({
                    body: {
                      kind: "tool_call_finished",
                      turnId,
                      toolUseId,
                      isError,
                      resultPreview: preview,
                      ...(resumeSignals ?? {}),
                      provenance: { path: "history" },
                    },
                    timestamp: recordTime,
                    sourcePriority: childFileIndex,
                    fileOrder: childOrderCounter++,
                  });
                }
              }
              for (const text of collectNotificationTexts(content)) {
                const fields = makeNotificationFields(text, obj);
                if (!fields) continue;
                rawEvents.push({
                  body: {
                    kind: "tool_call_finished",
                    turnId,
                    isError: false,
                    ...fields,
                    provenance: { path: "history" },
                  },
                  timestamp: recordTime,
                  sourcePriority: childFileIndex,
                  fileOrder: childOrderCounter++,
                });
              }
            } else if (obj.type === "assistant" && Array.isArray(content)) {
              for (const block of content) {
                const toolUse = asRecord(block);
                if (toolUse?.type !== "tool_use" || typeof toolUse.name !== "string") continue;
                const toolUseId = typeof toolUse.id === "string" ? toolUse.id : "";
                if (toolUseId.length === 0 || seenToolUseIds.has(toolUseId)) continue;
                seenToolUseIds.add(toolUseId);
                if (isResumeSignalToolName(toolUse.name)) {
                  resumeSignalToolNames.set(toolUseId, toolUse.name);
                }

                const rawInput = asRecord(toolUse.input) ?? undefined;
                const currentCwd = (typeof obj.cwd === "string" && obj.cwd.length > 0 ? obj.cwd : cwd);
                const stage0 = extractStage0ToolFields(toolUse.name, rawInput, toolUseId, currentCwd);
                const inputSummary = redactOptional(summarizeToolInput(toolUse.name, toolUse.input) ?? undefined);
                const inputPreview = redactAbsolutePaths(JSON.stringify(toolUse.input) ?? "").slice(0, 2000);

                rawEvents.push({
                  body: {
                    kind: "tool_call_started",
                    turnId,
                    toolUseId,
                    parentToolUseId,
                    toolName: toolUse.name,
                    inputPreview,
                    inputSummary,
                    intentInput: captureToolIntentInput(toolUse.name, toolUse.input),
                    isBackground: stage0.delegation?.isBackground,
                    subagentType: stage0.delegation?.subagentType,
                    subagentModel: stage0.delegation?.subagentModel,
                    delegation: stage0.delegation,
                    taskIntentStructured: stage0.taskIntentStructured,
                    artifacts: stage0.artifacts,
                    effectCoverage: stage0.effectCoverage,
                    progressEmission: stage0.progressEmission,
                    provenance: { path: "history" },
                  },
                  timestamp: recordTime,
                  hostArtifacts: stage0.hostArtifacts.length > 0 ? stage0.hostArtifacts : undefined,
                  sourcePriority: childFileIndex,
                  fileOrder: childOrderCounter++,
                });
              }
            } else if (obj.type === "attachment") {
              const prompt = asRecord(obj.attachment)?.prompt;
              if (typeof prompt === "string") {
                for (const text of collectNotificationTexts(prompt)) {
                  const fields = makeNotificationFields(text, obj);
                  if (!fields) continue;
                  rawEvents.push({
                    body: {
                      kind: "tool_call_finished",
                      turnId,
                      isError: false,
                      ...fields,
                      provenance: { path: "history" },
                    },
                    timestamp: recordTime,
                    sourcePriority: childFileIndex,
                    fileOrder: childOrderCounter++,
                  });
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    readError = String(error);
  }

  if (malformedLineCount > 0 || readError || subagentsReadError) {
    coverage.summary = "prefix-truncated";
    coverage.details = "prefix-truncated";
  }
  if (readError) coverage.historyReadError = readError;
  if (malformedLineCount > 0) coverage.historyMalformedLineCount = malformedLineCount;
  if (subagentsReadError) coverage.hierarchyIncomplete = true;

  rawEvents.sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    if (a.sourcePriority !== b.sourcePriority) {
      return a.sourcePriority - b.sourcePriority;
    }
    return a.fileOrder - b.fileOrder;
  });

  const events: HistoryEvent[] = rawEvents.map((item) => {
    const ev: HistoryEvent = {
      body:
        generationStartAt !== undefined &&
        preBoundaryCompacts.has(item) &&
        (item.body.kind === "compact_boundary" || item.body.kind === "local_command_output")
          ? { ...item.body, priorGeneration: true as const }
          : item.body,
      timestamp: item.timestamp,
    };
    if (item.hostArtifacts && item.hostArtifacts.length > 0) {
      ev.hostArtifacts = item.hostArtifacts;
    }
    return ev;
  });

  gapBoundaries.sort((a, b) => a - b);
  let boundaryCursor = 0;
  for (const ev of events) {
    const attached: number[] = [];
    while (boundaryCursor < gapBoundaries.length && gapBoundaries[boundaryCursor] <= ev.timestamp) {
      attached.push(gapBoundaries[boundaryCursor++]);
    }
    if (attached.length > 0) ev.gapBoundaries = attached;
  }

  if (inlineSidechainSkipped > 0 && subagentTranscriptsRead === 0) {
    coverage.details = "prefix-truncated";
    coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
  }

  const missingAnnouncedTranscripts = [...observedAsyncAgentIds].filter(
    (id) => !listedSubagentAgentIds.has(id)
  ).length;
  if (missingAnnouncedTranscripts > 0) {
    coverage.unreadableAgentCount = (coverage.unreadableAgentCount ?? 0) + missingAnnouncedTranscripts;
  }

  return {
    events,
    coverage,
    claudeCodeVersion,
    ...(generationStartAt !== undefined ? { generationStartAt } : {}),
    malformedLineCount,
    droppedTaskNotificationCount,
    ...(opts?.resumeReadSet ? { boundaryPartialExcludedCount } : {}),
    readError,
    subagentsReadError,
  };
}

export async function readConversationMessages(
  filePath: string,
  isAllowedPath: (filePath: string) => boolean,
  resumeReadSet?: ResumeReadSet,
  sessionId?: string
): Promise<{
  messages: ConversationMessage[];
  malformedLineCount: number;
  droppedWithoutUuidCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  handoffEnvelope?: HandoffEnvelopeV2;
}> {
  const messages: ConversationMessage[] = [];
  let malformedLineCount = 0;
  let droppedWithoutUuidCount = 0;
  let boundaryPartialExcludedCount = 0;
  let handoffEnvelope: HandoffEnvelopeV2 | undefined;
  let cutFrom = 0;

  if (!isAllowedPath(filePath)) {
    return {
      messages,
      malformedLineCount,
      droppedWithoutUuidCount,
      ...(resumeReadSet ? { boundaryPartialExcludedCount } : {}),
      readError: "outside-session-store",
    };
  }

  let text: string;
  try {
    if (resumeReadSet) {
      text = await readUtf8Prefix(filePath, resumeReadSet.parentEndOffset);
    } else {
      const { readFile } = await import("node:fs/promises");
      text = await readFile(filePath, "utf8");
    }
  } catch (error) {
    return {
      messages,
      malformedLineCount,
      droppedWithoutUuidCount,
      ...(resumeReadSet ? { boundaryPartialExcludedCount } : {}),
      readError: error instanceof Error ? error.message : String(error),
    };
  }

  const lines = text.split("\n");
  const acceptRecord = createRecordUuidFilter();
  const queuedSources = queuedPromptSources(lines);
  const seenQueuedPrompts = new Set<string>();
  const approvalResults = indexApprovalResults(lines);
  let lastTimestamp = 0;
  const endsAtBoundary = text.endsWith("\n");
  const maybeYield = createParseYielder();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const pendingYield = maybeYield();
    if (pendingYield) await pendingYield;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        malformedLineCount++;
        continue;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      if (resumeReadSet && !endsAtBoundary && i === lines.length - 1) {
        boundaryPartialExcludedCount++;
        continue;
      }
      malformedLineCount++;
      continue;
    }
    if (!acceptRecord(obj)) continue;
    if (obj.isSidechain === true) continue;
    if (isHandoffGenerationBoundary(obj, sessionId)) cutFrom = messages.length;
    lastTimestamp = recordTimestamp(obj.timestamp, lastTimestamp);
    const localOutput = localCommandOutput(obj);
    if (localOutput !== undefined) {
      const uuid = typeof obj.uuid === "string" ? obj.uuid : "";
      if (!uuid) { droppedWithoutUuidCount++; continue; }
      messages.push({ uuid, role: "system", text: localOutput, timestamp: lastTimestamp });
      continue;
    }
    const approvalMessages = extractRestoredApprovalMessages(obj, approvalResults, lastTimestamp);
    const prompt = extractHumanUserPrompt(obj, queuedSources, seenQueuedPrompts);
    const uuid = prompt?.uuid ?? (typeof obj.uuid === "string" ? obj.uuid : "");
    if (obj.type === "user" || obj.type === "attachment") {
      if (prompt === null) {
        {
          const raw = verbatimTextOf(obj);
          if (raw.startsWith("<laisora-handoff")) {
            const parsed = parseHandoffEnvelope(raw);
            if (parsed.ok && parsed.version === "2") {
              handoffEnvelope = parsed.envelope;
            }
          }
        }
        continue;
      }
      if (uuid.length === 0) {
        droppedWithoutUuidCount++;
        continue;
      }
      const { text: body, imageRefs } = prompt;
      messages.push({
        uuid,
        role: "user",
        text: body,
        timestamp: lastTimestamp,
        ...(imageRefs ? { imageRefs } : {}),
      });
    } else if (obj.type === "assistant") {
      const message = asRecord(obj.message);
      const body = extractAssistantRecordText(message?.content, obj.narration_block_indexes);
      if (!body || isRefusalErrorProse(obj, message)) {
        messages.push(...approvalMessages);
        continue;
      }
      if (uuid.length === 0) {
        droppedWithoutUuidCount++;
        messages.push(...approvalMessages);
        continue;
      }
      const rawModel = message?.model;
      const model = typeof rawModel === "string" && rawModel.length > 0 && !rawModel.startsWith("<") ? rawModel : undefined;
      messages.push({
        uuid,
        role: "assistant",
        text: body,
        timestamp: lastTimestamp,
        ...(model ? { model } : {}),
      });
    }
    messages.push(...approvalMessages);
  }
  return {
    messages: messages.slice(cutFrom),
    malformedLineCount,
    droppedWithoutUuidCount,
    ...(resumeReadSet ? { boundaryPartialExcludedCount } : {}),
    ...(handoffEnvelope ? { handoffEnvelope } : {}),
  };
}

export async function readSessionTranscript(
  filePath: string,
  isAllowedPath: (filePath: string) => boolean,
  resumeReadSet?: ResumeReadSet,
  sessionId?: string
): Promise<SessionTranscript> {
  const acceptNarrationRecord = createRecordUuidFilter();
  const messages: TranscriptMessage[] = [];
  const tools: Array<ReplayedTool & { toolUseId: string }> = [];
  const results = new Map<string, { isError: boolean; preview: string }>();
  let lastTimestamp = 0;
  let cwd = "";
  let claudeCodeVersion: string | undefined;
  let recordedModel: string | undefined;
  const coverage: WorkCoverage = {
    summary: "complete",
    details: "complete",
    source: "provider-transcript",
    phaseHistory: "complete",
    compactedPhaseCount: 0,
  };
  let title = "";
  let malformedLineCount = 0;
  let boundaryPartialExcludedCount = 0;
  let readError: string | undefined;
  let cutFrom = 0;

  if (!isAllowedPath(filePath)) {
    readError = "outside-session-store";
  } else {
    try {
      const { readFile } = await import("node:fs/promises");
      const text = resumeReadSet
        ? await readUtf8Prefix(filePath, resumeReadSet.parentEndOffset)
        : await readFile(filePath, "utf8");
      const lines = text.split("\n");
      const queuedSources = queuedPromptSources(lines);
      const seenQueuedPrompts = new Set<string>();
      const approvalResults = indexApprovalResults(lines);
      const endsAtBoundary = text.endsWith("\n");
      const maybeYield = createParseYielder();
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (!line.trim()) continue;
        const pendingYield = maybeYield();
        if (pendingYield) await pendingYield;
        let obj: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            malformedLineCount++;
            continue;
          }
          obj = parsed as Record<string, unknown>;
        } catch {
          if (resumeReadSet && !endsAtBoundary && lineIndex === lines.length - 1) {
            boundaryPartialExcludedCount++;
            continue;
          }
          malformedLineCount++;
          continue;
        }
        if (typeof obj.version === "string" && obj.version.length > 0) {
          claudeCodeVersion = obj.version;
        }
        if (!cwd && typeof obj.cwd === "string" && obj.cwd.length > 0) {
          cwd = obj.cwd;
        }
        const message = asRecord(obj.message);
        const content = message?.content;
        lastTimestamp = recordTimestamp(obj.timestamp, lastTimestamp);
        if (isHandoffGenerationBoundary(obj, sessionId)) cutFrom = messages.length;
        const localOutput = localCommandOutput(obj);
        if (localOutput !== undefined) {
          messages.push({ role: "system", text: localOutput,
            uuid: typeof obj.uuid === "string" ? obj.uuid : undefined, timestamp: lastTimestamp });
          continue;
        }
        if (obj.type === "user" || obj.type === "attachment") {
          const prompt = extractHumanUserPrompt(obj, queuedSources, seenQueuedPrompts);
          if (prompt !== null) {
            const { text, uuid, imageRefs } = prompt;
            if (!title) title = text.split("\n")[0];
            messages.push({
              role: "user",
              text,
              uuid,
              ...(imageRefs ? { imageRefs } : {}),
              timestamp: lastTimestamp,
            });
          }
          if (Array.isArray(content)) {
            for (const block of content) {
              const toolResult = asRecord(block);
              if (toolResult?.type !== "tool_result" || typeof toolResult.tool_use_id !== "string") continue;
              const preview = toolResultPreview(toolResult.content);
              const isError = toolResult.is_error === true;
              results.set(toolResult.tool_use_id, { isError, preview });
            }
          }
        } else if (obj.type === "assistant") {
          if (obj.isSidechain !== true) {
            const model = message?.model;
            recordedModel = typeof model === "string" && model.length > 0 && !model.startsWith("<") ? model : undefined;
          }
          const blocks = extractAssistantTextBlocks(content, obj.narration_block_indexes);
          const hasNarration = Array.isArray(content) && content.some((block, index) => asRecord(block)?.type === "thinking" && blocks[index].length > 0);
          const text = obj.isSidechain === true || (hasNarration && !acceptNarrationRecord(obj))
            ? "" : extractAssistantRecordText(content, obj.narration_block_indexes);
          if (text && !isRefusalErrorProse(obj, message)) {
            const rawModel = message?.model;
            const model = typeof rawModel === "string" && rawModel.length > 0 && !rawModel.startsWith("<") ? rawModel : undefined;
            messages.push({
              role: "assistant",
              text,
              uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
              ...(model ? { model } : {}),
              timestamp: lastTimestamp,
            });
          }
          if (Array.isArray(content)) {
            for (const block of content) {
              const toolUse = asRecord(block);
              if (toolUse?.type !== "tool_use" || typeof toolUse.name !== "string") continue;
              const toolUseId = typeof toolUse.id === "string" ? toolUse.id : "";
              const inputSummary = redactOptional(summarizeToolInput(toolUse.name, toolUse.input) ?? undefined);
              const inputPreview = redactAbsolutePaths(JSON.stringify(toolUse.input) ?? "").slice(0, 2000);
              tools.push({ toolUseId, toolName: toolUse.name, inputSummary, inputPreview });
            }
          }
        }
        messages.push(...extractRestoredApprovalMessages(obj, approvalResults, lastTimestamp));
      }
    } catch (error) {
      readError = String(error);
    }
  }

  if (malformedLineCount > 0 || readError) {
    coverage.summary = "prefix-truncated";
    coverage.details = "prefix-truncated";
  }
  const allTools = tools.map((tool) => withResult(tool, results));
  const generationMessages = messages.slice(cutFrom);
  const omittedMessageCount = Math.max(0, generationMessages.length - REPLAY_MESSAGE_MAX);
  const omittedToolCount = Math.max(0, allTools.length - REPLAY_TOOL_MAX);
  if (omittedMessageCount > 0 || omittedToolCount > 0) {
    coverage.details = "prefix-truncated";
    if (omittedMessageCount > 0) {
      coverage.omittedMessageCount = (coverage.omittedMessageCount ?? 0) + omittedMessageCount;
    }
    if (omittedToolCount > 0) {
      coverage.omittedToolCount = (coverage.omittedToolCount ?? 0) + omittedToolCount;
    }
  }
  return {
    title,
    messages: generationMessages.slice(-REPLAY_MESSAGE_MAX),
    tools: allTools.slice(-REPLAY_TOOL_MAX),
    summaryInput: { messages: messages.filter((m): m is TranscriptMessage & { role: "user" | "assistant" } => !m.restoredApproval && m.role !== "system"), tools: allTools },
    coverage,
    malformedLineCount,
    ...(resumeReadSet ? { boundaryPartialExcludedCount } : {}),
    readError,
    claudeCodeVersion,
    recordedModel,
  };
}

function recordTimestamp(value: unknown, previous: number): number {
  const parsed = parsedTimestamp(value);
  if (parsed === undefined) return previous;
  return Math.max(previous, parsed);
}

const SUBAGENT_TRANSCRIPT_MAX = 64;
const SUBAGENT_HEAD_SCAN_BYTES = 256 * 1024;
const SUBAGENT_TAIL_SCAN_BYTES = 64 * 1024;
const SUBAGENT_HEAD_SCAN_LINES = 200;
const SUBAGENT_TAIL_SCAN_LINES = 40;

export interface SubagentRestore {
  agents: RestoredAgent[];
  metaCount: number;
  malformedMetaCount: number;
  transcriptsRead: number;
  transcriptReadFailureCount: number;
  omittedTranscriptCount: number;
  bytesRead: number;
  elapsedMs: number;
  readError?: string;
}

export async function readSubagentAgents(
  sessionFilePath: string,
  isAllowedPath: (filePath: string) => boolean
): Promise<SubagentRestore> {
  const startedAt = Date.now();
  const result: SubagentRestore = {
    agents: [],
    metaCount: 0,
    malformedMetaCount: 0,
    transcriptsRead: 0,
    transcriptReadFailureCount: 0,
    omittedTranscriptCount: 0,
    bytesRead: 0,
    elapsedMs: 0,
  };
  const base = sessionFilePath.replace(/\.jsonl$/i, "");
  const dir = `${base}/subagents`;
  if (base === sessionFilePath || !isAllowedPath(dir)) {
    result.readError = "outside-session-store";
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }
  let names: string[];
  const { open, readFile, readdir } = await import("node:fs/promises");
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".meta.json"));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") result.readError = String(error);
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }
  names.sort();
  for (const name of names) {
    result.metaCount++;
    const agentId = name.slice("agent-".length, name.length - ".meta.json".length);
    if (!name.startsWith("agent-") || agentId.length === 0) {
      result.malformedMetaCount++;
      continue;
    }
    let meta: Record<string, any> | null;
    try {
      meta = asRecord(JSON.parse(await readFile(`${dir}/${name}`, "utf8")));
    } catch {
      meta = null;
    }
    if (!meta || typeof meta.toolUseId !== "string" || typeof meta.spawnDepth !== "number") {
      result.malformedMetaCount++;
      continue;
    }
    result.agents.push({
      agentId,
      parentAgentId: typeof meta.parentAgentId === "string" ? meta.parentAgentId : null,
      toolUseId: meta.toolUseId,
      spawnDepth: meta.spawnDepth,
      agentType: typeof meta.agentType === "string" ? meta.agentType : undefined,
      description: typeof meta.description === "string" ? meta.description : "",
      modelDeclared: typeof meta.model === "string" ? meta.model : undefined,
    });
  }

  for (const agent of result.agents) {
    if (result.transcriptsRead >= SUBAGENT_TRANSCRIPT_MAX) {
      result.omittedTranscriptCount++;
      continue;
    }
    let edges: TranscriptEdges;
    try {
      edges = await readTranscriptEdges(open, `${dir}/agent-${agent.agentId}.jsonl`);
    } catch {
      result.transcriptReadFailureCount++;
      continue;
    }
    result.transcriptsRead++;
    result.bytesRead += edges.bytesRead;
    applyTranscriptAttributes(agent, edges.head, edges.tail);
  }
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

interface TranscriptEdges {
  head: string[];
  tail: string[];
  bytesRead: number;
}

async function readTranscriptEdges(
  open: typeof import("node:fs/promises").open,
  filePath: string
): Promise<TranscriptEdges> {
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= SUBAGENT_HEAD_SCAN_BYTES + SUBAGENT_TAIL_SCAN_BYTES) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = size > 0 ? await handle.read(buffer, 0, size, 0) : { bytesRead: 0 };
      const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
      return { head: lines, tail: lines, bytesRead };
    }
    const headBuffer = Buffer.alloc(SUBAGENT_HEAD_SCAN_BYTES);
    const head = await handle.read(headBuffer, 0, SUBAGENT_HEAD_SCAN_BYTES, 0);
    const tailBuffer = Buffer.alloc(SUBAGENT_TAIL_SCAN_BYTES);
    const tail = await handle.read(tailBuffer, 0, SUBAGENT_TAIL_SCAN_BYTES, size - SUBAGENT_TAIL_SCAN_BYTES);
    const headLines = headBuffer.toString("utf8", 0, head.bytesRead).split("\n");
    headLines.pop();
    const tailLines = tailBuffer.toString("utf8", 0, tail.bytesRead).split("\n").slice(1);
    return { head: headLines, tail: tailLines, bytesRead: head.bytesRead + tail.bytesRead };
  } finally {
    await handle.close();
  }
}

function applyTranscriptAttributes(
  agent: RestoredAgent,
  head: readonly string[],
  tail: readonly string[]
): void {
  const headLimit = Math.min(head.length, SUBAGENT_HEAD_SCAN_LINES);
  for (let i = 0; i < headLimit; i++) {
    const record = parseRecord(head[i]);
    if (!record) continue;
    if (agent.startedAt === undefined) {
      const parsed = recordTimestamp(record.timestamp, 0);
      if (parsed > 0) agent.startedAt = parsed;
    }
    if (typeof record.effort === "string" && agent.effortMeasured === undefined) {
      agent.effortMeasured = record.effort;
    }
    const model = asRecord(record.message)?.model;
    if (typeof model === "string" && agent.modelMeasured === undefined) agent.modelMeasured = model;
    if (agent.startedAt !== undefined && agent.effortMeasured !== undefined && agent.modelMeasured !== undefined) {
      break;
    }
  }
  const tailLimit = Math.max(0, tail.length - SUBAGENT_TAIL_SCAN_LINES);
  for (let i = tail.length - 1; i >= tailLimit; i--) {
    const record = parseRecord(tail[i]);
    const parsed = record ? recordTimestamp(record.timestamp, 0) : 0;
    if (parsed <= 0) continue;
    agent.endedAt = parsed;
    break;
  }
}

function parseRecord(line: string): Record<string, any> | null {
  if (!line.trim()) return null;
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function withResult(
  tool: ReplayedTool & { toolUseId: string },
  results: ReadonlyMap<string, { isError: boolean; preview: string }>
): ReplayedTool {
  const result = tool.toolUseId ? results.get(tool.toolUseId) : undefined;
  return {
    toolName: tool.toolName,
    inputSummary: tool.inputSummary,
    inputPreview: tool.inputPreview,
    isError: result?.isError,
    resultPreview: result?.preview,
  };
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null ? value as Record<string, any> : null;
}

interface ApprovalResultRecord {
  text: string;
  answers?: Record<string, string>;
  behavior?: "allow" | "deny" | "withdrawn";
  isError?: boolean;
}

function stringAnswers(value: unknown): Record<string, string> | undefined {
  const obj = asRecord(value);
  if (!obj || Array.isArray(value) || !Object.values(obj).every((answer) => typeof answer === "string")) return undefined;
  return Object.keys(obj).length > 0 ? obj as Record<string, string> : undefined;
}

function approvalBehavior(value: unknown): ApprovalResultRecord["behavior"] {
  return value === "allow" || value === "deny" || value === "withdrawn" ? value : undefined;
}

interface ApprovalRestoreIndex {
  results: Map<string, ApprovalResultRecord>;
  seen: Set<string>;
}

function indexApprovalResults(lines: readonly string[]): ApprovalRestoreIndex {
  const results = new Map<string, ApprovalResultRecord>();
  for (const line of lines) {
    const record = parseRecord(line);
    if (!record || record.isSidechain === true) continue;
    if (record.type === "approval_resolved" && typeof record.requestId === "string") {
      results.set(record.requestId, { text: "", answers: stringAnswers(record.answers), behavior: approvalBehavior(record.behavior) });
    }
    if (record.type !== "user") continue;
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) continue;
    const detail = content.filter((block) => asRecord(block)?.type === "tool_result").length === 1 ? asRecord(record.toolUseResult) : null;
    for (const block of content) {
      const result = asRecord(block);
      if (result?.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
      results.set(result.tool_use_id, {
        text: joinTextBlocks(result.content),
        answers: stringAnswers(detail?.answers),
        behavior: approvalBehavior(detail?.behavior),
        isError: result.is_error === true,
      });
    }
  }
  return { results, seen: new Set() };
}

function redactCardValue(value: unknown): unknown {
  if (typeof value === "string") return redactAbsolutePaths(value);
  if (Array.isArray(value)) return value.map(redactCardValue);
  const record = asRecord(value);
  return record ? Object.fromEntries(Object.entries(record).map(([key, entry]) => [redactAbsolutePaths(key), redactCardValue(entry)])) : value;
}

function restoredQuestions(input: Record<string, unknown>): AskUserQuestionSpec | undefined {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return undefined;
  const questions = [];
  for (const raw of input.questions) {
    const q = asRecord(raw);
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) return undefined;
    const options = [];
    for (const rawOption of q.options) {
      const option = asRecord(rawOption);
      if (!option || typeof option.label !== "string") return undefined;
      options.push({ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) });
    }
    questions.push({ question: q.question, ...(typeof q.header === "string" ? { header: q.header } : {}), multiSelect: q.multiSelect === true, options });
  }
  return { questions };
}

function recordedQuestionAnswers(text: string, questions: AskUserQuestionSpec): Record<string, string> | undefined {
  const prefix = "User has answered your questions: ";
  const suffix = /\. You can now continue(?: with the user's answers in mind)?\.$/.exec(text);
  if (!text.startsWith(prefix) || !suffix) return undefined;
  const body = text.slice(prefix.length, suffix.index);
  const names = questions.questions.map((q) => q.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const entries = [...body.matchAll(new RegExp(`(?:^|, )"(${names.join("|")})"="`, "g"))];
  if (!entries.length || entries[0].index !== 0 || new Set(entries.map((e) => e[1])).size !== entries.length) return undefined;
  const answers: Record<string, string> = {};
  for (let i = 0; i < entries.length; i++) {
    const end = i + 1 < entries.length ? entries[i + 1].index : body.length;
    if (body[end - 1] !== '"') return undefined;
    answers[entries[i][1]] = body.slice(entries[i].index! + entries[i][0].length, end - 1);
  }
  return answers;
}

function extractRestoredApprovalMessages(
  record: Record<string, unknown>,
  index: ApprovalRestoreIndex,
  timestamp: number
): ConversationMessage[] {
  if (record.isSidechain === true) return [];
  const content = asRecord(record.message)?.content;
  const uses = record.type === "approval_request"
    ? [{ id: record.requestId, name: record.toolName, input: record.input ?? record.inputJson ?? record.rawInputJson }]
    : record.type === "assistant" && Array.isArray(content) ? content.filter((b) => asRecord(b)?.type === "tool_use") : [];
  const messages: ConversationMessage[] = [];
  for (const raw of uses) {
    const use = asRecord(raw);
    if (!use || typeof use.id !== "string" || !use.id || typeof use.name !== "string") continue;
    if (index.seen.has(use.id)) continue;
    const result = index.results.get(use.id);
    const rejected = result?.isError === true && /^(?:Error: )?User rejected tool use\b/.test(result.text);
    if (record.type !== "approval_request" && use.name !== "AskUserQuestion" && use.name !== "ExitPlanMode" && !result?.behavior && !rejected) continue;
    index.seen.add(use.id);
    let input = use.input;
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { input = { recordedInput: input }; }
    }
    const questions = use.name === "AskUserQuestion" ? restoredQuestions(asRecord(input) ?? {}) : undefined;
    let answers = result?.answers;
    if (!answers && questions && result?.text) answers = recordedQuestionAnswers(result.text, questions);
    const resolution: RestoredApprovalCard["resolution"] = result?.behavior === "allow" ? "allowed"
      : result?.behavior === "deny" || rejected ? "denied"
      : result?.behavior === "withdrawn" ? "withdrawn"
      : answers ? "answered" : result?.isError ? "failed" : "unknown";
    const restoredApproval = redactCardValue({
      requestId: use.id, toolName: use.name, inputJson: JSON.stringify(redactCardValue(input ?? {})),
      ...(questions ? { questions } : {}), ...(answers ? { answers } : {}), resolution,
    }) as RestoredApprovalCard;
    messages.push({ uuid: `approval:${use.id}`, role: "assistant", text: "", timestamp, restoredApproval });
  }
  return messages;
}

function extractAssistantRecordText(content: unknown, narrationBlockIndexes?: unknown): string {
  const texts = extractAssistantTextBlocks(content, narrationBlockIndexes);
  const hasNarration = Array.isArray(content) && content.some((block, index) => asRecord(block)?.type === "thinking" && texts[index].length > 0);
  return hasNarration ? texts.join("") : extractText(content);
}

function extractText(content: unknown, trim = true): string {
  if (typeof content === "string") return trim ? content.trim() : content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === "object" && block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string";
    })
    .map((block) => block.text)
    .filter((text) => !text.startsWith("<ide_") && !text.startsWith("<system-reminder>"))
    .join("\n");
  return trim ? text.trim() : text;
}

export function extractImageRefs(
  content: unknown,
  uuid: string | undefined
): ImageRefInfo[] | undefined {
  if (!uuid || !Array.isArray(content)) return undefined;
  const refs: ImageRefInfo[] = [];
  let imageIndex = 0;
  for (const block of content) {
    const rec = asRecord(block);
    if (rec?.type !== "image") continue;
    const source = asRecord(rec.source);
    if (source?.type === "base64" && typeof source.media_type === "string") {
      const mt = source.media_type;
      if (mt === "image/png" || mt === "image/jpeg" || mt === "image/gif" || mt === "image/webp") {
        refs.push({
          ref: { kind: "record", uuid, index: imageIndex },
          mediaType: mt,
        });
      }
    }
    imageIndex++;
  }
  return refs.length > 0 ? refs : undefined;
}

function extractUserRecordText(obj: Record<string, unknown>): string | null {
  if (obj.type !== "user" || obj.isSidechain) return null;
  if (obj.isCompactSummary === true) return null;
  const origin = asRecord(obj.origin);
  if (origin && origin.kind !== "human") return null;
  const text = extractText(asRecord(obj.message)?.content);
  if (!text) {
    if (joinTextBlocks(asRecord(obj.message)?.content).trim()) return null;
    return extractImageRefs(asRecord(obj.message)?.content, typeof obj.uuid === "string" ? obj.uuid : undefined) ? "" : null;
  }
  if (text.startsWith("<local-command-stdout>")) return null;
  if (LAISORA_ENVELOPE_RE.test(text)) return null;
  if (INJECTED_TAG_RE.test(text)) {
    const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim();
    const command = COMMAND_NAME_RE.exec(text)?.[1];
    if (!args || (command && PURE_COMMAND_WRAPPER_RE.test(`/${command}`))) return null;
    if (isNonHumanCommandName(command)) return null;
    return args;
  }
  if (text.startsWith("Caveat:") || text.startsWith("Base directory for this skill:")) return null;
  if (text === "[Request interrupted by user]" || text === "[Request interrupted by user for tool use]") return null;
  return text;
}

export function extractHumanUserText(obj: Record<string, unknown>): string | null {
  const record = extractQueuedPromptRecord(obj) ?? obj;
  return record.isMeta === true ? null : extractUserRecordText(record);
}

export function extractQueuedPromptRecord(obj: Record<string, unknown>): Record<string, unknown> | null {
  const attachment = asRecord(obj.attachment);
  if (obj.type !== "attachment" || attachment?.type !== "queued_command" || attachment.commandMode !== "prompt") return null;
  if (obj.isSidechain === true || obj.isMeta === true || attachment.isMeta === true) return null;
  const origin = asRecord(attachment.origin) ?? asRecord(obj.origin);
  if (origin && origin.kind !== "human") return null;
  return { ...obj, type: "user", origin, message: { content: attachment.prompt } };
}

export function extractHumanUserPrompt(obj: Record<string, unknown>, queuedSources?: ReadonlyMap<string, string | undefined>, seenQueuedPrompts?: Set<string>): {
  text: string; uuid?: string; imageRefs?: ImageRefInfo[]; content: unknown;
} | null {
  const queued = extractQueuedPromptRecord(obj);
  const record = queued ?? obj;
  const text = extractHumanUserText(record);
  if (text === null) return null;
  const recordUuid = typeof obj.uuid === "string" && obj.uuid.length > 0 ? obj.uuid : undefined;
  if (!queued && recordUuid && queuedSources?.has(recordUuid)) return null;
  const sourceUuid = asRecord(obj.attachment)?.source_uuid;
  const uuid = queued && typeof sourceUuid === "string" && sourceUuid.length > 0 ? sourceUuid : recordUuid;
  if (queued && uuid && queuedSources?.has(uuid) && queuedSources.get(uuid) !== recordUuid) return null;
  if (queued && uuid && seenQueuedPrompts) {
    if (seenQueuedPrompts.has(uuid)) return null;
    seenQueuedPrompts.add(uuid);
  }
  const content = asRecord(record.message)?.content;
  const rawText = queued ? extractText(content, false) : "";
  return { text: queued && rawText.trim() === text ? rawText : text,
    uuid, content, imageRefs: extractImageRefs(content, recordUuid) };
}

function queuedPromptSources(lines: readonly string[]): Map<string, string | undefined> {
  const sources = new Map<string, string | undefined>();
  for (const line of lines) {
    const record = parseRecord(line);
    if (!record || !extractQueuedPromptRecord(record) || !extractHumanUserPrompt(record)) continue;
    const source = asRecord(record.attachment)?.source_uuid;
    if (typeof source === "string" && source.length > 0 && !sources.has(source)) {
      sources.set(source, typeof record.uuid === "string" ? record.uuid : undefined);
    }
  }
  return sources;
}

export function extractCliInsertedUserText(obj: Record<string, unknown>): string | null {
  return obj.isMeta === true ? extractUserRecordText(obj) : null;
}

export interface VerbatimUtterance {
  n: number;
  at: string;
  kind: "typed" | "answer";
  text: string;
  questions?: string[];
  imageRefs?: ImageRefInfo[];
}

function verbatimTextOf(record: Record<string, unknown>): string {
  const message = record.message;
  const content =
    typeof message === "object" && message !== null && !Array.isArray(message)
      ? (message as Record<string, unknown>).content
      : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const value =
        typeof block === "object" && block !== null && !Array.isArray(block)
          ? (block as Record<string, unknown>)
          : undefined;
      return value?.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("");
}

function verbatimGenerationStart(records: readonly Record<string, unknown>[]): number {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type !== "user") continue;
    const parsed = parseHandoffEnvelope(verbatimTextOf(record));
    if (parsed.ok && parsed.version === "2") return i + 1;
  }
  return 0;
}

export function extractVerbatimUserUtterances(
  records: readonly Record<string, unknown>[]
): VerbatimUtterance[] {
  const utterances: VerbatimUtterance[] = [];
  let lastAt = "";
  const generationStart = verbatimGenerationStart(records);
  const queuedSources = queuedPromptSources(records.map((record) => JSON.stringify(record)));
  const seenQueuedPrompts = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.isSidechain === true) continue;
    if (index < generationStart) {
      if (typeof record.timestamp === "string") lastAt = record.timestamp;
      continue;
    }
    if (record.type === "system" && record.subtype === "compact_boundary") continue;
    if (typeof record.timestamp === "string") lastAt = record.timestamp;

    const toolUseResult = record.type === "user" ? record.toolUseResult : undefined;
    const answers =
      typeof toolUseResult === "object" && toolUseResult !== null && !Array.isArray(toolUseResult)
        ? (toolUseResult as Record<string, unknown>).answers
        : undefined;
    if (typeof answers === "object" && answers !== null && !Array.isArray(answers)) {
      const entries = Object.entries(answers as Record<string, unknown>);
      if (!entries.every(([question, answer]) => typeof question === "string" && typeof answer === "string")) {
        throw new TypeError("AskUserQuestion answers must contain only string keys and values");
      }
      utterances.push({
        n: utterances.length + 1,
        at: lastAt,
        kind: "answer",
        questions: entries.map(([question]) => question),
        text: entries.map(([, answer]) => answer as string).join("\n"),
      });
      continue;
    }

    const prompt = extractHumanUserPrompt(record, queuedSources, seenQueuedPrompts);
    if (prompt !== null) {
      utterances.push({ n: utterances.length + 1, at: lastAt, kind: "typed", text: prompt.text,
        ...(prompt.imageRefs ? { imageRefs: prompt.imageRefs } : {}) });
    }
  }
  return utterances;
}
