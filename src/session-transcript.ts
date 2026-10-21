import { captureToolIntentInput } from "./tool-intent";
import type { RosterSource } from "./roster-evidence";
import { apiRetryEvent, localCommandOutput, taskNotificationDisplayFields, taskNotificationPreview, toolResultPreview } from "./transcript-display";
import type { HostArtifactAccess } from "./artifact-access";
import type { AssistantUsage, AskUserQuestionSpec, EventProvenance, ImageRefInfo, NormalizedEventBody, RestoredAgent, RestoredApprovalCard, ResumePreviewMessage, TaskNotificationInfo } from "./protocol";
import type { ConversationMessage } from "./conversation-history";
import { assistantUsageFromRaw, isObservedTime, isSyntheticModel, RESUME_PREVIEW_MESSAGE_MAX, summarizeToolInput } from "./protocol";
import type { WorkCoverage } from "./work-model";
import { compactBoundaryTime } from "./time-buckets";
import { extractResumeSignals, extractStage0ToolFields, isResumeSignalToolName, parseTaskNotification } from "./tool-observation";
import { redactAbsolutePaths, redactOptional } from "./path-redaction";
import { advanceRunRoot, countFileEdit, singleToolUseResult, type RunRootState } from "./edit-summary";
import { isFileWritingTool } from "./file-writing-tools";
import { fileIdentityOf, sameFileIdentity, type FileIdentity } from "./path-containment";
import {
  formatRefusalMessage,
  extractAssistantTextBlocks,
  isApiErrorFrame,
  isRefusalErrorProse,
  parseRefusalNotice,
  refusalFallbackEvent,
  parseRefusalStop,
} from "./claude-normalizer";
import { HANDOFF_TAG, parseHandoffEnvelope, type HandoffEnvelopeV2 } from "./handoff-envelope";
import { isLaisoraInputText, laisoraInputLine, parseLaisoraInput } from "./laisora-input";
import { ASK_QUALITY_DENIAL_HEAD, feedbackRejectedTitles, resolveRejectedAsks, type AskRejection } from "./markdown-ast";
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

export interface SessionTranscript {
  title: string;
  recordedModel?: string;
  messages: TranscriptMessage[];
  coverage: WorkCoverage;
  malformedLineCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  claudeCodeVersion?: string;
}

export type TranscriptMessage = Omit<ConversationMessage, "uuid"> & { uuid?: string };

const REPLAY_MESSAGE_MAX = 80;
const PRIOR_GENERATION_KINDS: ReadonlySet<NormalizedEventBody["kind"]> = new Set(["compact_boundary", "local_command_output", "user_message", "assistant_text_delta", "model_observed", "tool_call_started", "tool_call_finished"]);
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const RESUME_TAIL_MAX_BYTES = 1024 * 1024;
const RESUME_TAIL_MAX_RECORDS = 1500;
const RESUME_CAPTURE_CHUNK_BYTES = 64 * 1024;
const AGENT_WAKE_ORIGIN_KINDS: ReadonlySet<string> = new Set(["task-notification", "peer"]);
const EARLIER_GENERATION_TURN_ID = "replay-earlier-generation";
const QUEUED_COMMAND_TYPE = "queued_command";
const TOOL_RESULT_TYPE = "tool_result";
const APPROVAL_RESOLVED_TYPE = "approval_resolved";
// A record whose JSON line lacks the quoted value cannot carry it: JSON.stringify writes ASCII string values verbatim.
const QUEUED_COMMAND_MARK = JSON.stringify(QUEUED_COMMAND_TYPE);
const TOOL_RESULT_MARK = JSON.stringify(TOOL_RESULT_TYPE);
const APPROVAL_RESOLVED_MARK = JSON.stringify(APPROVAL_RESOLVED_TYPE);

export interface ResumeReadSet {
  parentEndOffset: number;
  lastCompleteParentTimestamp: number | undefined;
  recordedModel?: string;
  recordedModelSettled?: boolean;
  subagents: Array<{ path: string; size: number }>;
}

type FileStamp = FileIdentity | null;

interface ReadInputs {
  files: Map<string, FileStamp>;
  dirs: Map<string, string[] | null>;
  allowed: Map<string, boolean>;
}

const readInputsByResult = new WeakMap<object, ReadInputs>();

function createReadInputs(): ReadInputs {
  return { files: new Map(), dirs: new Map(), allowed: new Map() };
}

function mergeReadInputs(into: ReadInputs, from: ReadInputs): void {
  for (const [p, value] of from.files) into.files.set(p, value);
  for (const [p, value] of from.dirs) into.dirs.set(p, value);
  for (const [p, value] of from.allowed) into.allowed.set(p, value);
}

async function fileStamp(filePath: string): Promise<FileStamp> {
  const { stat } = await import("node:fs/promises");
  try {
    return fileIdentityOf(await stat(filePath));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

async function dirListing(dirPath: string): Promise<string[] | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    return (await readdir(dirPath)).sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

async function readInputsCurrent(inputs: ReadInputs, isAllowedPath: (p: string) => boolean): Promise<boolean> {
  for (const [p, wasAllowed] of inputs.allowed) if (isAllowedPath(p) !== wasAllowed) return false;
  try {
    const dirs = await Promise.all([...inputs.dirs].map(async ([p, listing]) => {
      const now = await dirListing(p);
      return now === null || listing === null ? now === listing : now.length === listing.length && now.every((name, i) => name === listing[i]);
    }));
    if (dirs.includes(false)) return false;
    const files = await Promise.all([...inputs.files].map(async ([p, before]) => {
      const now = await fileStamp(p);
      return now === null || before === null ? now === before : sameFileIdentity(now, before);
    }));
    return !files.includes(false);
  } catch {
    return false;
  }
}

export async function transcriptReadStillCurrent(result: object, isAllowedPath: (p: string) => boolean): Promise<boolean> {
  const inputs = readInputsByResult.get(result);
  return inputs !== undefined && await readInputsCurrent(inputs, isAllowedPath);
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
  size: number,
  sessionId: string | undefined
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
    if (!assistantFound && isHandoffGenerationBoundary(record, sessionId)) assistantFound = true;
    if (!assistantFound && record.type === "assistant" && record.isSidechain !== true) {
      assistantFound = true;
      const model = asRecord(record.message)?.model;
      recordedModel = typeof model === "string" && model.length > 0 && !isSyntheticModel(model) ? model : undefined;
    }
  };
  const scanFloor = Math.max(0, size - RESUME_TAIL_MAX_BYTES);

  while (position > 0) {
    if (boundaryFound && position <= scanFloor) {
      return { parentEndOffset, lastCompleteParentTimestamp, recordedModel, recordedModelSettled: assistantFound };
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
          return { parentEndOffset, lastCompleteParentTimestamp, recordedModel, recordedModelSettled: true };
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
  return { parentEndOffset, lastCompleteParentTimestamp, recordedModel, recordedModelSettled: boundaryFound };
}

export async function captureResumeReadSet(parentPath: string): Promise<ResumeReadSet> {
  const { open, readdir, stat } = await import("node:fs/promises");
  const handle = await open(parentPath, "r");
  let boundary: Omit<ResumeReadSet, "subagents">;
  try {
    boundary = await captureParentBoundary(handle, (await handle.stat()).size, recordFileSessionId(parentPath));
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

const NOT_OBJECT_LINE = Symbol("not-object-line");
const UNPARSEABLE_LINE = Symbol("unparseable-line");
type LineValue = Record<string, unknown> | typeof NOT_OBJECT_LINE | typeof UNPARSEABLE_LINE;

interface RecordGeneration {
  readonly start: number;
  queuedSources(): ReadonlyMap<string, string | undefined>;
  approvalResults(): ReadonlyMap<string, ApprovalResultRecord>;
}

interface RecordLines {
  readonly count: number;
  readonly endsAtBoundary: boolean;
  value(index: number): LineValue | undefined;
  generation(sessionId: string | undefined): RecordGeneration;
}

const COPIED_SESSION_ID = "[a-zA-Z0-9-]+";
const COPIED_SESSION_ID_RE = new RegExp(`^${COPIED_SESSION_ID}$`);
const COPIED_RECORD_TAIL_RE = new RegExp(`"forkedFrom":\\{"sessionId":"${COPIED_SESSION_ID}"(?:,"messageUuid":"[^"\\\\]*")?\\}\\}\\s*$`);
const COPIED_RECORD_TAIL_SCAN = 256;
const HANDOFF_ENVELOPE_MARK = `<${HANDOFF_TAG}`;
const COMPACT_BOUNDARY_SUBTYPE = "compact_boundary";
const COMPACT_BOUNDARY_MARK = JSON.stringify(COMPACT_BOUNDARY_SUBTYPE);

function isCopiedRecordLine(line: string): boolean {
  return COPIED_RECORD_TAIL_RE.test(line.length > COPIED_RECORD_TAIL_SCAN ? line.slice(-COPIED_RECORD_TAIL_SCAN) : line);
}

function isCompactBoundaryRecord(record: Record<string, unknown>): boolean {
  return record.type === "system" && record.subtype === COMPACT_BOUNDARY_SUBTYPE;
}

function earlierGenerationEnd(
  lines: readonly string[],
  valueAt: (index: number) => LineValue | undefined,
  sessionId: string | undefined
): number {
  if (sessionId === undefined || sessionId.length === 0) return 0;
  let end = 0;
  while (end < lines.length && isCopiedRecordLine(lines[end])) end++;
  if (end === 0) return 0;
  let compacted = false;
  for (let i = end; i < lines.length; i++) {
    const compactCandidate = !compacted && lines[i].includes(COMPACT_BOUNDARY_MARK);
    if (!compactCandidate && !lines[i].includes(HANDOFF_ENVELOPE_MARK)) continue;
    const record = recordOf(valueAt(i));
    if (record === null || record.isSidechain === true) continue;
    if (compactCandidate && isCompactBoundaryRecord(record) && isObservedTime(parsedTimestamp(record.timestamp))) compacted = true;
    else if (isHandoffGenerationBoundary(record, sessionId)) return compacted ? end : 0;
  }
  return 0;
}

function lineValue(line: string): LineValue | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ? NOT_OBJECT_LINE : parsed as Record<string, unknown>;
  } catch {
    return UNPARSEABLE_LINE;
  }
}

function recordOf(value: LineValue | undefined): Record<string, unknown> | null {
  return typeof value === "object" ? value : null;
}

function collectPrePass(
  lines: readonly string[],
  valueAt: (index: number) => LineValue | undefined,
  queued: Map<string, string | undefined> | undefined,
  approvals: Map<string, ApprovalResultRecord> | undefined,
  from = 0
): void {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const forQueued = queued !== undefined && line.includes(QUEUED_COMMAND_MARK);
    const forApproval = approvals !== undefined && (line.includes(TOOL_RESULT_MARK) || line.includes(APPROVAL_RESOLVED_MARK));
    if (!forQueued && !forApproval) continue;
    const record = recordOf(valueAt(i));
    if (record === null) continue;
    if (forQueued) addQueuedPromptSource(queued, record);
    if (forApproval) addApprovalResults(approvals, record);
  }
}

function recordLinesOver(
  lines: readonly string[],
  endsAtBoundary: boolean,
  values?: Array<LineValue | undefined>
): RecordLines {
  const value = values === undefined
    ? (index: number) => lineValue(lines[index])
    : (index: number) => values[index] ??= lineValue(lines[index]);
  const generations = new Map<string | undefined, RecordGeneration>();
  return {
    count: lines.length,
    endsAtBoundary,
    value,
    generation: (sessionId) => {
      let generation = generations.get(sessionId);
      if (generation === undefined) {
        const start = earlierGenerationEnd(lines, value, sessionId);
        let queued: Map<string, string | undefined> | undefined;
        let approvals: Map<string, ApprovalResultRecord> | undefined;
        generation = {
          start,
          queuedSources: () => {
            if (queued === undefined) collectPrePass(lines, value, queued = new Map(), undefined, start);
            return queued;
          },
          approvalResults: () => {
            if (approvals === undefined) collectPrePass(lines, value, undefined, approvals = new Map(), start);
            return approvals;
          },
        };
        generations.set(sessionId, generation);
      }
      return generation;
    },
  };
}

async function parsedRecordLines(text: string, sessionId: string | undefined): Promise<RecordLines> {
  const lines = text.split("\n");
  const values: Array<LineValue | undefined> = new Array(lines.length);
  const records = recordLinesOver(lines, text.endsWith("\n"), values);
  const own = records.generation(sessionId);
  const maybeYield = createParseYielder();
  for (let i = own.start; i < lines.length; i++) {
    const line = lines[i];
    if (values[i] !== undefined || !line.trim()) continue;
    const pendingYield = maybeYield();
    if (pendingYield) await pendingYield;
    values[i] = lineValue(line);
  }
  own.queuedSources();
  own.approvalResults();
  return records;
}

async function readRecordLines(filePath: string, resumeReadSet: ResumeReadSet | undefined): Promise<RecordLines> {
  const { readFile } = await import("node:fs/promises");
  const text = resumeReadSet
    ? await readUtf8Prefix(filePath, resumeReadSet.parentEndOffset)
    : await readFile(filePath, "utf8");
  return recordLinesOver(text.split("\n"), text.endsWith("\n"));
}

export class ParentRecordSource {
  private pending: Promise<RecordLines> | undefined;
  private released = false;

  constructor(readonly filePath: string, readonly readSet: ResumeReadSet, private readonly onRelease: () => void) {}

  records(filePath: string, resumeReadSet: ResumeReadSet | undefined): Promise<RecordLines> {
    if (this.released || filePath !== this.filePath || resumeReadSet !== this.readSet) {
      return readRecordLines(filePath, resumeReadSet);
    }
    if (this.pending === undefined) {
      const pending = readUtf8Prefix(this.filePath, this.readSet.parentEndOffset)
        .then((text) => parsedRecordLines(text, recordFileSessionId(this.filePath)));
      this.pending = pending;
      pending.catch(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    return this.pending;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.pending = undefined;
    this.onRelease();
  }
}

// One parsed parent at a time: restoring several tabs runs their reads concurrently (src/extension.ts#restorePersistedTabs).
const SHARED_PARSE_WAIT_MAX_MS = 30_000;

export interface ParentParseClaim {
  drop(): void;
}

class ParseTurnClaim implements ParentParseClaim {
  requestSeq: number | undefined;
  grant: (() => void) | undefined;
  reserved: boolean;
  firstInLine = false;
  hold: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly reserveMs: number) {
    this.reserved = reserveMs > 0;
  }
  drop(): void {
    endParseTurn(this);
  }
  requestTurn(): void {
    this.requestSeq = ++parseTurnRequestSeq;
    this.firstInLine = this.reserved;
    this.endReservation();
  }
  endReservation(): void {
    this.reserved = false;
    clearTimeout(this.hold);
    this.hold = undefined;
  }
  startHold(): void {
    if (this.hold !== undefined) return;
    this.hold = setTimeout(() => {
      this.hold = undefined;
      this.reserved = false;
      grantParseTurn();
    }, this.reserveMs);
    this.hold.unref?.();
  }
}

const parseTurnClaims: ParseTurnClaim[] = [];
let parseTurnHolder: ParseTurnClaim | undefined;
let parseTurnRequestSeq = 0;

function nextParseTurn(): ParseTurnClaim | undefined {
  let next: ParseTurnClaim | undefined;
  for (const claim of parseTurnClaims) {
    if (claim.requestSeq === undefined) continue;
    if (
      next === undefined ||
      (claim.firstInLine && !next.firstInLine) ||
      (claim.firstInLine === next.firstInLine && claim.requestSeq < next.requestSeq!)
    ) next = claim;
  }
  return next;
}

function grantParseTurn(): void {
  if (parseTurnHolder !== undefined) return;
  const next = nextParseTurn();
  if (next === undefined) return;
  const reserved = parseTurnClaims.filter((claim) => claim.reserved);
  if (reserved.length > 0 && !next.firstInLine) {
    for (const claim of reserved) claim.startHold();
    return;
  }
  parseTurnClaims.splice(parseTurnClaims.indexOf(next), 1);
  parseTurnHolder = next;
  next.grant?.();
}

function endParseTurn(claim: ParseTurnClaim): void {
  claim.endReservation();
  const queued = parseTurnClaims.indexOf(claim);
  if (queued >= 0) parseTurnClaims.splice(queued, 1);
  if (parseTurnHolder === claim) parseTurnHolder = undefined;
  grantParseTurn();
}

export function claimParentParseTurn(reserveMs: number): ParentParseClaim {
  const claim = new ParseTurnClaim(reserveMs);
  parseTurnClaims.push(claim);
  return claim;
}

export async function parentRecordSource(
  filePath: string,
  readSet: ResumeReadSet | undefined,
  claimed?: ParentParseClaim
): Promise<{ source: ParentRecordSource | undefined; waitedMs: number; timedOut: boolean }> {
  const claim = claimed instanceof ParseTurnClaim && parseTurnClaims.includes(claimed)
    ? claimed
    : claimParentParseTurn(0) as ParseTurnClaim;
  if (readSet === undefined) {
    claim.drop();
    return { source: undefined, waitedMs: 0, timedOut: false };
  }
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = await Promise.race([
    new Promise<true>((resolve) => {
      claim.grant = () => resolve(true);
      claim.requestTurn();
      grantParseTurn();
    }),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), SHARED_PARSE_WAIT_MAX_MS); }),
  ]);
  clearTimeout(timer);
  const waitedMs = Date.now() - startedAt;
  if (!reached) {
    claim.drop();
    return { source: undefined, waitedMs, timedOut: true };
  }
  return { source: new ParentRecordSource(filePath, readSet, () => claim.drop()), waitedMs, timedOut: false };
}

function recordLinesOf(
  source: ParentRecordSource | undefined,
  filePath: string,
  resumeReadSet: ResumeReadSet | undefined
): Promise<RecordLines> {
  return source ? source.records(filePath, resumeReadSet) : readRecordLines(filePath, resumeReadSet);
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
        const model = typeof rawModel === "string" && rawModel.length > 0 && !isSyntheticModel(rawModel) ? rawModel : undefined;
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

function recordCwd(record: Record<string, unknown>, fallback: string): string {
  return typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : fallback;
}

function historyTurnTexts(rawEvents: readonly RawHistoryItem[], turnId: string): RawHistoryItem[] {
  return rawEvents.filter((item) => item.body.kind === "assistant_text_delta" && item.body.turnId === turnId);
}

function applyHistoryAskRejections(rawEvents: RawHistoryItem[], rejections: readonly (AskRejection & { turnId: string })[]): void {
  for (const turnId of new Set(rejections.map((rejection) => rejection.turnId))) {
    const items = historyTurnTexts(rawEvents, turnId);
    const resolved = resolveRejectedAsks(items.map((item) => (item.body as { text: string }).text), rejections.filter((rejection) => rejection.turnId === turnId));
    items.forEach((item, index) => {
      const text = resolved[index];
      const at = rawEvents.indexOf(item);
      if (text === null) rawEvents.splice(at, 1);
      else if (text !== (item.body as { text: string }).text) rawEvents[at] = { ...item, body: { ...item.body, text } as RawHistoryItem["body"] };
    });
  }
}

function resolveMessageAskRejections(messages: ConversationMessage[], from: number, rejections: readonly AskRejection[]): void {
  if (rejections.length === 0) return;
  const assistants = messages.slice(from).filter((message) => message.role === "assistant");
  const resolved = resolveRejectedAsks(assistants.map((message) => message.text), rejections);
  assistants.forEach((message, index) => {
    const text = resolved[index];
    const at = messages.indexOf(message);
    if (text === null) messages.splice(at, 1);
    else if (text !== message.text) messages[at] = { ...message, text };
  });
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

export interface SessionHistoryRead {
  events: HistoryEvent[];
  rosterSources?: RosterSource[];
  coverage: WorkCoverage;
  claudeCodeVersion?: string;
  generationStartAt?: number;
  sentUserUuids: ReadonlySet<string>;
  recordAssistantUuids: ReadonlySet<string>;
  malformedLineCount: number;
  droppedTaskNotificationCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  subagentsReadError?: string;
  subagentGaps?: SubagentGap[];
  ancestorUsageReadThrough?: number;
}

interface SessionHistoryOptions {
  subagentsDir?: string;
  resumeReadSet?: ResumeReadSet;
  generationSessionId?: string;
  usageAncestors?: readonly string[];
  parentRecords?: ParentRecordSource;
}

export async function readSessionHistory(
  parentFilePath: string,
  isAllowedPath: (p: string) => boolean,
  opts?: SessionHistoryOptions
): Promise<SessionHistoryRead> {
  const read = await readHistory(parentFilePath, isAllowedPath, opts ?? {}, false);
  if (read.inputs !== undefined) readInputsByResult.set(read.history, read.inputs);
  return read.history;
}

interface HistoryReadOutcome {
  history: SessionHistoryRead;
  launchedAt: ReadonlyMap<string, number>;
  inputs: ReadInputs | undefined;
}

async function readHistory(
  parentFilePath: string,
  isAllowedPath: (p: string) => boolean,
  opts: SessionHistoryOptions,
  usageOnly: boolean
): Promise<HistoryReadOutcome> {
  const inputs = createReadInputs();
  let reusable = true;
  const allowed = (p: string): boolean => {
    const ok = isAllowedPath(p);
    inputs.allowed.set(p, ok);
    return ok;
  };
  const stamp = async (p: string): Promise<FileStamp | undefined> => {
    const current = await fileStamp(p).catch(() => undefined);
    if (current === undefined) reusable = false;
    else inputs.files.set(p, current);
    return current;
  };
  const launchedAt = new Map<string, number>();
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
  let ancestorUsageReadError: string | undefined;
  let ancestorUsageReadThrough: number | undefined;
  let claudeCodeVersion: string | undefined;
  let cwd = "";
  let boundaryPartialExcludedCount = 0;
  const generationSessionId = opts?.generationSessionId;
  const boundaryOwnerId = generationSessionId ?? (usageOnly ? undefined : recordFileSessionId(parentFilePath));
  let generationEnvelopeSeen = false;
  let generationBoundaryAt: number | undefined;
  let generationStartAt: number | undefined;

  if (!allowed(parentFilePath)) {
    return { history: {
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
      sentUserUuids: new Set(),
      recordAssistantUuids: new Set(),
    }, launchedAt, inputs: undefined };
  }

  const rawEvents: RawHistoryItem[] = [];
  const sentUserUuids = new Set<string>();
  const recordAssistantUuids = new Set<string>();
  const askRejections: (AskRejection & { turnId: string })[] = [];
  const usageSources = new Map<string, number>();
  const usageOwnerSources = new Set<string>();
  const parentTurns: ParentTurnSpan[] = [];
  const seenToolUseIds = new Set<string>();
  const seenToolResultIds = new Set<string>();

  const notificationOrdinals = new Map<string, number>();
  const observedAsyncAgentIds = new Set<string>();
  const ownAgentLaunches = new Map<string, string>();
  const subagentGaps: SubagentGap[] = [];
  const observedBackgroundTaskIds = new Set<string>();
  const resumeSignalToolNames = new Map<string, string>();
  const editToolNames = new Map<string, string>();
  let runRoot: RunRootState = { shellInTurn: false };
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
  let pendingSilentTurn = true;
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
    const { readFile, readdir } = await import("node:fs/promises");
    const parentStamp = await stamp(parentFilePath);
    if (opts.resumeReadSet && parentStamp?.size !== opts.resumeReadSet.parentEndOffset) reusable = false;
    const parentRecords = await recordLinesOf(opts.parentRecords, parentFilePath, opts.resumeReadSet);
    const generation = parentRecords.generation(generationSessionId);
    let earlierTurnOpen = generation.start > 0;
    if (earlierTurnOpen) {
      currentTurnId = EARLIER_GENERATION_TURN_ID;
      pendingSilentTurn = false;
      parentTurns.push({ turnId: EARLIER_GENERATION_TURN_ID, startedAt: Number.NEGATIVE_INFINITY, endedAt: Number.NEGATIVE_INFINITY });
    }
    const acceptParentRecord = createRecordUuidFilter();
    const queuedSources = generation.queuedSources();
    const seenQueuedPrompts = new Set<string>();
    const maybeYieldParent = createParseYielder();

    for (let parentLineIndex = generation.start; parentLineIndex < parentRecords.count; parentLineIndex++) {
      const value = parentRecords.value(parentLineIndex);
      if (value === undefined) continue;
      const pendingYield = maybeYieldParent();
      if (pendingYield) await pendingYield;
      if (value === NOT_OBJECT_LINE) {
        malformedLineCount++;
        continue;
      }
      if (value === UNPARSEABLE_LINE) {
        if (
          opts?.resumeReadSet &&
          !parentRecords.endsAtBoundary &&
          parentLineIndex === parentRecords.count - 1
        ) {
          boundaryPartialExcludedCount++;
          continue;
        }
        malformedLineCount++;
        continue;
      }
      const obj = value;

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
      if (!usageOnly) runRoot = advanceRunRoot(runRoot, obj);

      const rawTs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
      const recordTime = Number.isFinite(rawTs) ? rawTs : lastParentTimestamp;
      lastParentTimestamp = recordTime;
      if (earlierTurnOpen && Number.isFinite(rawTs)) {
        earlierTurnOpen = false;
        lastTurnActivityTimestamp = recordTime;
        rawEvents.push({
          body: { kind: "turn_started", turnId: EARLIER_GENERATION_TURN_ID, provenance: { path: "history" } },
          timestamp: recordTime,
          sourcePriority: 0,
          fileOrder: parentOrderCounter++,
        });
      }
      const sourceSession = asRecord(obj.forkedFrom)?.sessionId;
      const copiedFrom = typeof sourceSession === "string" && COPIED_SESSION_ID_RE.test(sourceSession) ? sourceSession : undefined;
      if (copiedFrom !== undefined) {
        usageSources.set(copiedFrom, Math.max(usageSources.get(copiedFrom) ?? 0, recordTime));
      }

      if (boundaryOwnerId !== undefined && isHandoffGenerationBoundary(obj, boundaryOwnerId)) {
        if (!generationEnvelopeSeen) {
          generationEnvelopeSeen = true;
          for (const item of rawEvents) {
            const at = compactBoundaryTime(item.body, item.timestamp);
            if (at !== undefined && (generationBoundaryAt === undefined || at > generationBoundaryAt)) generationBoundaryAt = at;
            if (generationSessionId !== undefined && PRIOR_GENERATION_KINDS.has(item.body.kind)) {
              item.body = { ...item.body, priorGeneration: true as const } as typeof item.body;
            }
          }
        }
        if (generationSessionId !== undefined) {
          generationStartAt = recordTime;
          sentUserUuids.clear();
          recordAssistantUuids.clear();
          lastRootModel = null;
          malformedLineCount = 0;
          inlineSidechainSkipped = 0;
          droppedTaskNotificationCount = 0;
        }
      }
      const sentUuid = sentUserUuidOf(obj);
      if (sentUuid !== undefined) sentUserUuids.add(sentUuid);
      if (obj.type === "assistant" && typeof obj.uuid === "string" && obj.uuid.length > 0) recordAssistantUuids.add(obj.uuid);

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
        const agentWake = obj.type === "user" && AGENT_WAKE_ORIGIN_KINDS.has(String(asRecord(obj.origin)?.kind));
        if (humanText === null && currentTurnId !== null && (STEER_TAG_RE.test(joinedText) || agentWake)) {
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
        const askFeedback = cliInsertedText !== null && currentTurnId !== null && cliInsertedText.includes(ASK_QUALITY_DENIAL_HEAD) ? cliInsertedText : null;
        if (askFeedback !== null && currentTurnId !== null) {
          const texts = historyTurnTexts(rawEvents, currentTurnId).map((item) => (item.body as { text: string }).text);
          askRejections.push({ turnId: currentTurnId, upTo: texts.length, titles: feedbackRejectedTitles(texts.join("\n\n"), askFeedback) });
        }
        const turnInsertedText = askFeedback === null ? cliInsertedText : null;
        const absorbedMidTurn = extractQueuedPromptRecord(obj) !== null && prompt !== null && currentTurnId !== null;
        if (absorbedMidTurn && prompt !== null) {
          rawEvents.push({
            body: { kind: "user_message", turnId: currentTurnId, text: prompt.text, ...(prompt.uuid ? { uuid: prompt.uuid } : {}),
              ...(prompt.imageRefs ? { imageRefs: prompt.imageRefs } : {}), provenance: { path: "history" } },
            timestamp: recordTime, sourcePriority: 0, fileOrder: parentOrderCounter++,
          });
          lastTurnActivityTimestamp = recordTime;
        }
        if (!absorbedMidTurn && (prompt !== null || turnInsertedText !== null)) {
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
              ...(turnInsertedText !== null ? { cliInserted: true as const } : {}),
              ...(turnInsertedText !== null && isLaisoraInputText(turnInsertedText) ? { laisoraInput: true as const } : {}),
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
                ...(prompt.uuid ? { uuid: prompt.uuid } : {}),
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

            lastTurnActivityTimestamp = recordTime;
            const resumeSignals = toolResultSignals(resumeSignalToolNames.get(toolUseId), toolResult.content);
            if (resumeSignals?.asyncLaunchedAgentId) observedAsyncAgentIds.add(resumeSignals.asyncLaunchedAgentId);
            if (resumeSignals?.resumedAgentId) observedAsyncAgentIds.add(resumeSignals.resumedAgentId);
            if (copiedFrom === undefined) noteOwnAgentLaunch(ownAgentLaunches, resumeSignals, toolUseId);
            if (resumeSignals?.backgroundTaskId) observedBackgroundTaskIds.add(resumeSignals.backgroundTaskId);
            if (usageOnly) continue;
            const preview = toolResultPreview(toolResult.content);
            const isError = toolResult.is_error === true;
            const turnId = currentTurnId ?? "replay-turn-1";
            const editToolName = editToolNames.get(toolUseId);
            const fileEdit = editToolName !== undefined && !isError
              ? countFileEdit(editToolName, singleToolUseResult(content, obj.toolUseResult), runRoot.root ?? cwd)
              : undefined;

            rawEvents.push({
              body: {
                kind: "tool_call_finished",
                turnId,
                toolUseId,
                isError,
                resultPreview: preview,
                ...(resumeSignals ?? {}),
                ...(fileEdit ? { fileEdit } : {}),
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
        const { text, narration } = assistantRecordText(content, obj.narration_block_indexes);
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
        if (model !== null && !isSyntheticModel(model) && model !== lastRootModel) {
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
              ...(narration ? { recordUuid: typeof obj.uuid === "string" && obj.uuid.length > 0 ? obj.uuid : null } : {}),
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
            if (isFileWritingTool(toolUse.name)) editToolNames.set(toolUseId, toolUse.name);
            lastTurnActivityTimestamp = recordTime;
            launchedAt.set(toolUseId, recordTime);
            if (usageOnly && copiedFrom === undefined) continue;

            const rawInput = asRecord(toolUse.input) ?? undefined;
            const currentCwd = recordCwd(obj, cwd);
            const stage0 = extractStage0ToolFields(toolUse.name, rawInput, toolUseId, currentCwd);
            if (stage0.delegation !== undefined && copiedFrom !== undefined) usageOwnerSources.add(copiedFrom);
            if (usageOnly) continue;
            const inputSummary = redactOptional(summarizeToolInput(toolUse.name, toolUse.input) ?? undefined);
            const inputPreview = redactAbsolutePaths(JSON.stringify(toolUse.input) ?? "").slice(0, 2000);

            rawEvents.push({
              body: {
                kind: "tool_call_started",
                turnId,
                toolUseId,
                parentToolUseId: null,
                toolName: toolUse.name,
                ...(messageId === null ? {} : { messageId }),
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
      } else if (isCompactBoundaryRecord(obj)) {
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
        rawEvents.push(item);
      } else if (obj.type === "system") {
        const retry = apiRetryEvent(obj, currentTurnId);
        if (retry) {
          openPendingSilentTurn(recordTime);
          lastTurnActivityTimestamp = recordTime;
          rawEvents.push({ body: { ...retry, turnId: currentTurnId, provenance: { path: "history" } },
            timestamp: recordTime, sourcePriority: 0, fileOrder: parentOrderCounter++ });
        }
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
    applyHistoryAskRejections(rawEvents, askRejections);

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

    if (allowed(subagentsDir)) {
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
        const listing = await dirListing(subagentsDir).catch(() => undefined);
        if (listing === undefined) reusable = false;
        else {
          inputs.dirs.set(subagentsDir, listing);
          const listed = (listing ?? []).filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"));
          if (listed.length !== capturedByName.size || listed.some((name) => !capturedByName.has(name))) reusable = false;
        }
      } else {
        try {
          entries = await readdir(subagentsDir);
          inputs.dirs.set(subagentsDir, [...entries].sort());
        } catch (error) {
          if ((error as { code?: unknown }).code !== "ENOENT") {
            subagentsReadError = String(error);
          } else {
            inputs.dirs.set(subagentsDir, null);
          }
        }
      }

      if (entries.length > 0) {
        const metaMap = new Map<string, string>();
        const metaFiles = entries.filter((name) => name.startsWith("agent-") && name.endsWith(".meta.json"));
        for (const metaName of metaFiles) {
          const agentId = metaName.slice("agent-".length, metaName.length - ".meta.json".length);
          if (!agentId) continue;
          await stamp(`${subagentsDir}/${metaName}`);
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

          const childStamp = await stamp(childFilePath);
          let fileSize: number;
          if (captured) {
            fileSize = captured.size;
            if (captured.path !== childFilePath || childStamp?.size !== captured.size) reusable = false;
          } else if (childStamp) {
            fileSize = childStamp.size;
          } else {
            coverage.details = "prefix-truncated";
            coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
            if (parentToolUseId !== null) subagentGaps.push({ toolUseId: parentToolUseId, cause: "unread" });
            continue;
          }

          if (fileSize > MAX_SUBAGENT_TRANSCRIPT_BYTES || !allowed(effectiveChildPath)) {
            coverage.details = "prefix-truncated";
            coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
            if (parentToolUseId !== null) subagentGaps.push({ toolUseId: parentToolUseId, cause: "unread" });
            continue;
          }

          let childText: string;
          try {
            childText = captured
              ? await readUtf8Prefix(effectiveChildPath, captured.size)
              : await readFile(childFilePath, "utf8");
            subagentTranscriptsRead++;
          } catch {
            reusable = false;
            coverage.details = "prefix-truncated";
            coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
            if (parentToolUseId !== null) subagentGaps.push({ toolUseId: parentToolUseId, cause: "unread" });
            continue;
          }

          let childLastTimestamp = 0;
          let childOrderCounter = 0;
          const acceptChildRecord = createRecordUuidFilter();
          const childLines = childText.split("\n");
          const childEndsAtBoundary = childText.endsWith("\n");
          const maybeYieldChild = createParseYielder();

          for (let childLineIndex = 0; childLineIndex < childLines.length; childLineIndex++) {
            const value = lineValue(childLines[childLineIndex]);
            if (value === undefined) continue;
            const pendingYield = maybeYieldChild();
            if (pendingYield) await pendingYield;
            if (value === NOT_OBJECT_LINE) {
              malformedLineCount++;
              if (parentToolUseId !== null) subagentGaps.push({ toolUseId: parentToolUseId, cause: "malformed" });
              continue;
            }
            if (value === UNPARSEABLE_LINE) {
              if (captured && !childEndsAtBoundary && childLineIndex === childLines.length - 1) {
                boundaryPartialExcludedCount++;
                continue;
              }
              malformedLineCount++;
              const trailingPartial = !childEndsAtBoundary && childLineIndex === childLines.length - 1;
              if (parentToolUseId !== null && !trailingPartial) subagentGaps.push({ toolUseId: parentToolUseId, cause: "malformed" });
              continue;
            }
            const obj = value;

            if (!acceptChildRecord(obj)) continue;

            const rawTs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
            const recordTime = Number.isFinite(rawTs) ? rawTs : childLastTimestamp;
            childLastTimestamp = recordTime;

            let recordTurnId: string | undefined;
            const turnOf = (): string => recordTurnId ??= findTurnIdForTimestamp(parentTurns, recordTime);
            const message = asRecord(obj.message);
            const content = message?.content;

            if (parentToolUseId !== null && obj.type === "assistant" && typeof message?.id === "string" && typeof message.usage === "object" && message.usage !== null) {
              rawEvents.push({ body: { kind: "assistant_usage", turnId: turnOf(), parentToolUseId,
                messageId: message.id, usage: assistantUsageFromRaw(message.usage, true), provenance: { path: "history" } },
                timestamp: recordTime, sourcePriority: childFileIndex, fileOrder: childOrderCounter++ });
            }

            if (obj.type === "user") {
              if (Array.isArray(content)) {
                for (const block of content) {
                  const toolResult = asRecord(block);
                  if (toolResult?.type !== "tool_result" || typeof toolResult.tool_use_id !== "string") continue;
                  const toolUseId = toolResult.tool_use_id;
                  if (toolUseId.length === 0 || seenToolResultIds.has(toolUseId)) continue;
                  seenToolResultIds.add(toolUseId);

                  const resumeSignals = toolResultSignals(resumeSignalToolNames.get(toolUseId), toolResult.content);
                  if (resumeSignals?.asyncLaunchedAgentId) observedAsyncAgentIds.add(resumeSignals.asyncLaunchedAgentId);
                  if (resumeSignals?.resumedAgentId) observedAsyncAgentIds.add(resumeSignals.resumedAgentId);
                  noteOwnAgentLaunch(ownAgentLaunches, resumeSignals, toolUseId);
                  if (resumeSignals?.backgroundTaskId) observedBackgroundTaskIds.add(resumeSignals.backgroundTaskId);
                  if (usageOnly) continue;
                  const preview = toolResultPreview(toolResult.content);
                  const isError = toolResult.is_error === true;

                  rawEvents.push({
                    body: {
                      kind: "tool_call_finished",
                      turnId: turnOf(),
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
                    turnId: turnOf(),
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
                launchedAt.set(toolUseId, recordTime);
                if (usageOnly) continue;

                const rawInput = asRecord(toolUse.input) ?? undefined;
                const currentCwd = recordCwd(obj, cwd);
                const stage0 = extractStage0ToolFields(toolUse.name, rawInput, toolUseId, currentCwd);
                const inputSummary = redactOptional(summarizeToolInput(toolUse.name, toolUse.input) ?? undefined);
                const inputPreview = redactAbsolutePaths(JSON.stringify(toolUse.input) ?? "").slice(0, 2000);

                rawEvents.push({
                  body: {
                    kind: "tool_call_started",
                    turnId: turnOf(),
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
                      turnId: turnOf(),
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

  const copiedBeforeGeneration = generationBoundaryAt !== undefined && [...usageSources.values()].every((through) => through < generationBoundaryAt!);
  const rosterSources: RosterSource[] = [];
  const usageAncestors = [...opts?.usageAncestors ?? [], parentFilePath];
  for (const [sessionId, through] of copiedBeforeGeneration ? [] : usageSources) {
    const sourcePath = parentFilePath.replace(/[^\\/]+$/, `${sessionId}.jsonl`);
    if (usageAncestors.includes(sourcePath) || !allowed(sourcePath)) continue;
    const source = await readUsageSource(sourcePath, isAllowedPath, usageAncestors);
    if (source.inputs === undefined) reusable = false;
    else mergeReadInputs(inputs, source.inputs);
    rosterSources.push({ sessionId, through }, ...source.rosterSources.map(s => ({ ...s, through: Math.min(through, s.through) })));
    const { unreadError, deeperError } = source;
    const childGap = unreadError === undefined ? copiedChildGap(source.gaps, seenToolUseIds, through) : undefined;
    const sourceError = unreadError ?? deeperError ?? childGap;
    if (sourceError !== undefined && usageOwnerSources.has(sessionId)) {
      ancestorUsageReadError ??= sourceError;
      const gapThrough = deeperError === undefined || unreadError !== undefined || childGap !== undefined ? through : Math.min(through, source.ancestorUsageReadThrough ?? through);
      ancestorUsageReadThrough = Math.max(ancestorUsageReadThrough ?? gapThrough, gapThrough);
    }
    for (const event of source.childUsage) {
      if (!seenToolUseIds.has(event.body.parentToolUseId) || event.timestamp > through) continue;
      rawEvents.push({ body: { ...event.body }, timestamp: event.timestamp, sourcePriority: 0, fileOrder: parentOrderCounter++ });
    }
  }

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
      body: item.body,
      timestamp: item.timestamp,
    };
    if (item.hostArtifacts && item.hostArtifacts.length > 0) {
      ev.hostArtifacts = item.hostArtifacts;
    }
    return ev;
  });

  if (malformedLineCount > 0 || readError || subagentsReadError) {
    coverage.summary = "prefix-truncated";
    coverage.details = "prefix-truncated";
  }
  if (readError) coverage.historyReadError = readError;
  if (malformedLineCount > 0) coverage.historyMalformedLineCount = malformedLineCount;
  if (subagentsReadError) coverage.hierarchyIncomplete = true;
  if (ancestorUsageReadError !== undefined) {
    coverage.ancestorUsageReadError = ancestorUsageReadError;
    const markedBoundaryAt = generationSessionId === undefined ? undefined : generationBoundaryAt;
    if (markedBoundaryAt === undefined || ancestorUsageReadThrough === undefined || ancestorUsageReadThrough >= markedBoundaryAt) {
      coverage.ancestorUsageReachesGeneration = true;
    }
  }

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

  const missingAnnouncedTranscripts = [...ownAgentLaunches].filter(([id]) => !listedSubagentAgentIds.has(id));
  if (missingAnnouncedTranscripts.length > 0) {
    coverage.unreadableAgentCount = (coverage.unreadableAgentCount ?? 0) + missingAnnouncedTranscripts.length;
    for (const [, toolUseId] of missingAnnouncedTranscripts) subagentGaps.push({ toolUseId, cause: "unlisted" });
  }

  if (readError !== undefined || subagentsReadError !== undefined || boundaryPartialExcludedCount > 0) reusable = false;
  return { history: {
    events,
    rosterSources,
    coverage,
    claudeCodeVersion,
    ...(generationStartAt !== undefined ? { generationStartAt } : {}),
    sentUserUuids,
    recordAssistantUuids,
    malformedLineCount,
    droppedTaskNotificationCount,
    ...(opts?.resumeReadSet ? { boundaryPartialExcludedCount } : {}),
    readError,
    subagentsReadError,
    ...(subagentGaps.length > 0 ? { subagentGaps } : {}),
    ancestorUsageReadThrough,
  }, launchedAt, inputs: reusable ? inputs : undefined };
}

interface SubagentGap {
  toolUseId: string;
  cause: "unread" | "unlisted" | "malformed";
}

interface UsageSource {
  rosterSources: RosterSource[];
  unreadError?: string;
  deeperError?: string;
  ancestorUsageReadThrough?: number;
  gaps: Array<SubagentGap & { launchedAt?: number }>;
  childUsage: Array<{ body: Extract<HistoryEvent["body"], { kind: "assistant_usage" }> & { parentToolUseId: string }; timestamp: number }>;
  inputs?: ReadInputs;
}

function recordFileSessionId(filePath: string): string | undefined {
  return /([^\\/]+)\.jsonl$/i.exec(filePath)?.[1];
}

function usageSourceOf(read: HistoryReadOutcome): UsageSource {
  const { history, launchedAt, inputs } = read;
  const childUsage: UsageSource["childUsage"] = [];
  for (const event of history.events) {
    if (event.body.kind === "assistant_usage" && event.body.parentToolUseId !== null) {
      childUsage.push({ body: event.body as UsageSource["childUsage"][number]["body"], timestamp: event.timestamp });
    }
  }
  return {
    rosterSources: history.rosterSources ?? [],
    unreadError: history.readError ?? history.subagentsReadError,
    deeperError: history.coverage.ancestorUsageReadError,
    ancestorUsageReadThrough: history.ancestorUsageReadThrough,
    gaps: (history.subagentGaps ?? []).map((gap) => ({ ...gap, launchedAt: launchedAt.get(gap.toolUseId) })),
    childUsage,
    ...(inputs !== undefined ? { inputs } : {}),
  };
}

async function readUsageSource(
  sourcePath: string,
  isAllowedPath: (p: string) => boolean,
  usageAncestors: readonly string[]
): Promise<UsageSource> {
  return usageSourceOf(await readHistory(sourcePath, isAllowedPath, { usageAncestors }, true));
}

function toolResultSignals(toolName: string | undefined, content: unknown): ReturnType<typeof extractResumeSignals> {
  if (toolName === undefined) return undefined;
  const raw = Array.isArray(content)
    ? content
        .filter((c: unknown) => asRecord(c)?.type === "text")
        .map((c: unknown) => String(asRecord(c)?.text ?? ""))
        .join("\n")
    : typeof content === "string"
      ? content
      : "";
  return extractResumeSignals(toolName, raw);
}

function noteOwnAgentLaunch(launches: Map<string, string>, signals: { asyncLaunchedAgentId?: string; resumedAgentId?: string } | undefined, toolUseId: string): void {
  if (signals?.asyncLaunchedAgentId) launches.set(signals.asyncLaunchedAgentId, toolUseId);
  if (signals?.resumedAgentId) launches.set(signals.resumedAgentId, toolUseId);
}

function copiedChildGap(gaps: UsageSource["gaps"], copiedToolUseIds: ReadonlySet<string>, through: number): string | undefined {
  const counts = new Map<SubagentGap["cause"], Set<string>>();
  for (const gap of gaps) {
    const at = gap.launchedAt;
    if (!copiedToolUseIds.has(gap.toolUseId) || at === undefined || at > through) continue;
    counts.set(gap.cause, (counts.get(gap.cause) ?? new Set<string>()).add(gap.toolUseId));
  }
  if (counts.size === 0) return undefined;
  return `subagent transcripts incomplete (${[...counts].map(([cause, ids]) => `${cause}=${ids.size}`).join(" ")})`;
}

export interface ConversationMessageParser {
  push(lines: readonly string[], options?: { lastLineMayBePartial?: boolean }): Promise<void>;
  result(): ReturnType<ConversationRecordParser["result"]>;
}

interface ConversationRecordParser {
  pushRecords(records: RecordLines, options?: { lastLineMayBePartial?: boolean; wholeRecord?: boolean }): Promise<void>;
  result(): {
    messages: ConversationMessage[];
    malformedLineCount: number;
    droppedWithoutUuidCount: number;
    boundaryPartialExcludedCount: number;
    handoffEnvelope?: HandoffEnvelopeV2;
    lastTimestamp: number;
  };
}

export function createConversationMessageParser(sessionId?: string, keep?: (message: ConversationMessage) => boolean): ConversationMessageParser {
  const parser = createConversationRecordParser(sessionId, keep);
  return {
    push: (lines, options) => parser.pushRecords(recordLinesOver(lines, lines[lines.length - 1] === ""), options),
    result: () => parser.result(),
  };
}

function createConversationRecordParser(sessionId?: string, keep?: (message: ConversationMessage) => boolean): ConversationRecordParser {
  let messages: ConversationMessage[] = [];
  let malformedLineCount = 0;
  let droppedWithoutUuidCount = 0;
  let boundaryPartialExcludedCount = 0;
  let handoffEnvelope: HandoffEnvelopeV2 | undefined;
  let cutFrom = 0;
  const acceptRecord = createRecordUuidFilter();
  const queuedSources = new Map<string, string | undefined>();
  const seenQueuedPrompts = new Set<string>();
  const approvalIndex = new Map<string, ApprovalResultRecord>();
  const approvalResults: ApprovalRestoreIndex = { results: approvalIndex, seen: new Set() };
  let lastTimestamp = 0;
  let askTurnFrom = 0;
  const askRejections: AskRejection[] = [];
  const compactBeforeTurn = (): void => {
    if (keep === undefined) return;
    messages = messages.slice(cutFrom).filter(keep);
    cutFrom = 0;
  };
  return {
    async pushRecords(records, options = {}) {
      const generation = records.generation(options.wholeRecord ? sessionId : undefined);
      for (const [source, uuid] of generation.queuedSources()) if (!queuedSources.has(source)) queuedSources.set(source, uuid);
      for (const [id, result] of generation.approvalResults()) approvalIndex.set(id, result);
      const maybeYield = createParseYielder();
      for (let i = generation.start; i < records.count; i++) {
        const value = records.value(i);
        if (value === undefined) continue;
        const pendingYield = maybeYield();
        if (pendingYield) await pendingYield;
        if (value === NOT_OBJECT_LINE) {
          malformedLineCount++;
          continue;
        }
        if (value === UNPARSEABLE_LINE) {
          if (options.lastLineMayBePartial && i === records.count - 1) {
            boundaryPartialExcludedCount++;
            continue;
          }
          malformedLineCount++;
          continue;
        }
        const obj = value;
        if (!acceptRecord(obj)) continue;
        if (obj.isSidechain === true) continue;
        if (isHandoffGenerationBoundary(obj, sessionId)) {
          cutFrom = messages.length;
          askTurnFrom = messages.length;
          askRejections.length = 0;
          malformedLineCount = 0;
          droppedWithoutUuidCount = 0;
        }
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
            const feedback = obj.type === "user" ? extractCliInsertedUserText(obj) : null;
            const sentByLaisora = feedback === null ? undefined : parseLaisoraInput(feedback);
            if (sentByLaisora !== undefined) {
              const line = laisoraInputLine(sentByLaisora.input);
              if (line !== undefined && uuid.length > 0) messages.push({ uuid, role: "system", text: line, timestamp: lastTimestamp });
              continue;
            }
            if (feedback !== null && feedback.includes(ASK_QUALITY_DENIAL_HEAD)) {
              const texts = messages.slice(askTurnFrom).filter((message) => message.role === "assistant").map((message) => message.text);
              askRejections.push({ upTo: texts.length, titles: feedbackRejectedTitles(texts.join("\n\n"), feedback) });
            }
            {
              const raw = verbatimTextOf(obj);
              if (raw.startsWith(HANDOFF_ENVELOPE_MARK)) {
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
          const earlier = obj.type === "attachment" ? messages.findIndex((message) => message.role === "user" && message.uuid === uuid) : -1;
          if (earlier >= 0) {
            messages.splice(earlier, 1);
            if (earlier < cutFrom) cutFrom--;
            if (earlier < askTurnFrom) askTurnFrom--;
          }
          const { text: body, imageRefs } = prompt;
          resolveMessageAskRejections(messages, askTurnFrom, askRejections.splice(0));
          compactBeforeTurn();
          askTurnFrom = messages.length;
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
          const model = typeof rawModel === "string" && rawModel.length > 0 && !isSyntheticModel(rawModel) ? rawModel : undefined;
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
    },
    result() {
      const settled = messages.slice();
      resolveMessageAskRejections(settled, askTurnFrom, askRejections);
      return {
        messages: settled.slice(cutFrom),
        malformedLineCount,
        droppedWithoutUuidCount,
        boundaryPartialExcludedCount,
        ...(handoffEnvelope ? { handoffEnvelope } : {}),
        lastTimestamp,
      };
    },
  };
}

export async function readConversationMessages(
  filePath: string,
  isAllowedPath: (filePath: string) => boolean,
  resumeReadSet?: ResumeReadSet,
  sessionId?: string,
  parentRecords?: ParentRecordSource
): Promise<{
  messages: ConversationMessage[];
  malformedLineCount: number;
  droppedWithoutUuidCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  handoffEnvelope?: HandoffEnvelopeV2;
}> {
  const failed = (readError: string) => ({
    messages: [], malformedLineCount: 0, droppedWithoutUuidCount: 0,
    ...(resumeReadSet ? { boundaryPartialExcludedCount: 0 } : {}), readError,
  });
  if (!isAllowedPath(filePath)) return failed("outside-session-store");
  let records: RecordLines;
  try {
    records = await recordLinesOf(parentRecords, filePath, resumeReadSet);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  const parser = createConversationRecordParser(sessionId);
  await parser.pushRecords(records, { lastLineMayBePartial: resumeReadSet !== undefined && !records.endsAtBoundary, wholeRecord: true });
  const { boundaryPartialExcludedCount, lastTimestamp: _last, ...read } = parser.result();
  return { ...read, ...(resumeReadSet ? { boundaryPartialExcludedCount } : {}) };
}

export async function readSessionTranscript(
  filePath: string,
  isAllowedPath: (filePath: string) => boolean,
  resumeReadSet?: ResumeReadSet,
  sessionId?: string,
  parentRecords?: ParentRecordSource
): Promise<SessionTranscript> {
  const acceptNarrationRecord = createRecordUuidFilter();
  const messages: TranscriptMessage[] = [];
  let lastTimestamp = 0;
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
      const records = await recordLinesOf(parentRecords, filePath, resumeReadSet);
      const generation = records.generation(sessionId);
      title = earlierGenerationTitle(records, generation.start);
      const queuedSources = generation.queuedSources();
      const seenQueuedPrompts = new Set<string>();
      const approvalResults: ApprovalRestoreIndex = { results: generation.approvalResults(), seen: new Set() };
      const maybeYield = createParseYielder();
      for (let lineIndex = generation.start; lineIndex < records.count; lineIndex++) {
        const value = records.value(lineIndex);
        if (value === undefined) continue;
        const pendingYield = maybeYield();
        if (pendingYield) await pendingYield;
        if (value === NOT_OBJECT_LINE) {
          malformedLineCount++;
          continue;
        }
        if (value === UNPARSEABLE_LINE) {
          if (resumeReadSet && !records.endsAtBoundary && lineIndex === records.count - 1) {
            boundaryPartialExcludedCount++;
            continue;
          }
          malformedLineCount++;
          continue;
        }
        const obj = value;
        if (typeof obj.version === "string" && obj.version.length > 0) {
          claudeCodeVersion = obj.version;
        }
        const message = asRecord(obj.message);
        const content = message?.content;
        lastTimestamp = recordTimestamp(obj.timestamp, lastTimestamp);
        if (isHandoffGenerationBoundary(obj, sessionId)) {
          cutFrom = messages.length;
          recordedModel = undefined;
          malformedLineCount = 0;
        }
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
        } else if (obj.type === "assistant") {
          if (obj.isSidechain !== true) {
            const model = message?.model;
            recordedModel = typeof model === "string" && model.length > 0 && !isSyntheticModel(model) ? model : undefined;
          }
          const recordText = assistantRecordText(content, obj.narration_block_indexes);
          const text = obj.isSidechain === true || (recordText.narration && !acceptNarrationRecord(obj))
            ? "" : recordText.text;
          if (text && !isRefusalErrorProse(obj, message)) {
            const rawModel = message?.model;
            const model = typeof rawModel === "string" && rawModel.length > 0 && !isSyntheticModel(rawModel) ? rawModel : undefined;
            messages.push({
              role: "assistant",
              text,
              uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
              ...(model ? { model } : {}),
              timestamp: lastTimestamp,
            });
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
  const generationMessages = messages.slice(cutFrom);
  const omittedMessageCount = Math.max(0, generationMessages.length - REPLAY_MESSAGE_MAX);
  if (omittedMessageCount > 0) {
    coverage.details = "prefix-truncated";
    coverage.omittedMessageCount = (coverage.omittedMessageCount ?? 0) + omittedMessageCount;
  }
  return {
    title,
    messages: generationMessages.slice(-REPLAY_MESSAGE_MAX),
    coverage,
    malformedLineCount,
    ...(resumeReadSet ? { boundaryPartialExcludedCount } : {}),
    readError,
    claudeCodeVersion,
    recordedModel,
  };
}

function earlierGenerationTitle(records: RecordLines, end: number): string {
  if (end === 0) return "";
  const queuedSources = records.generation(undefined).queuedSources();
  const seenQueuedPrompts = new Set<string>();
  for (let i = 0; i < end; i++) {
    const record = recordOf(records.value(i));
    if (record === null || (record.type !== "user" && record.type !== "attachment")) continue;
    const title = extractHumanUserPrompt(record, queuedSources, seenQueuedPrompts)?.text.split("\n")[0];
    if (title) return title;
  }
  return "";
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
  const inputs = createReadInputs();
  let reusable = true;
  const stamp = async (p: string): Promise<void> => {
    const current = await fileStamp(p).catch(() => undefined);
    if (current === undefined) reusable = false;
    else inputs.files.set(p, current);
  };
  const finish = (): SubagentRestore => {
    result.elapsedMs = Date.now() - startedAt;
    if (reusable && result.readError === undefined && result.transcriptReadFailureCount === 0) readInputsByResult.set(result, inputs);
    return result;
  };
  const base = sessionFilePath.replace(/\.jsonl$/i, "");
  const dir = `${base}/subagents`;
  if (base === sessionFilePath || !isAllowedPath(dir)) {
    result.readError = "outside-session-store";
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }
  inputs.allowed.set(dir, true);
  let names: string[];
  const { open, readFile, readdir } = await import("node:fs/promises");
  try {
    const listing = await readdir(dir);
    inputs.dirs.set(dir, [...listing].sort());
    names = listing.filter((name) => name.endsWith(".meta.json"));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") result.readError = String(error);
    else inputs.dirs.set(dir, null);
    return finish();
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
    await stamp(`${dir}/${name}`);
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
    await stamp(`${dir}/agent-${agent.agentId}.jsonl`);
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
  return finish();
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
  return recordOf(lineValue(line));
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
  return Object.keys(obj).length > 0 ? { ...obj } as Record<string, string> : undefined;
}

function approvalBehavior(value: unknown): ApprovalResultRecord["behavior"] {
  return value === "allow" || value === "deny" || value === "withdrawn" ? value : undefined;
}

interface ApprovalRestoreIndex {
  results: ReadonlyMap<string, ApprovalResultRecord>;
  seen: Set<string>;
}

function addApprovalResults(results: Map<string, ApprovalResultRecord>, record: Record<string, any>): void {
  if (record.isSidechain === true) return;
  if (record.type === APPROVAL_RESOLVED_TYPE && typeof record.requestId === "string") {
    results.set(record.requestId, { text: "", answers: stringAnswers(record.answers), behavior: approvalBehavior(record.behavior) });
  }
  if (record.type !== "user") return;
  const content = asRecord(record.message)?.content;
  if (!Array.isArray(content)) return;
  const detail = content.filter((block) => asRecord(block)?.type === TOOL_RESULT_TYPE).length === 1 ? asRecord(record.toolUseResult) : null;
  for (const block of content) {
    const result = asRecord(block);
    if (result?.type !== TOOL_RESULT_TYPE || typeof result.tool_use_id !== "string") continue;
    results.set(result.tool_use_id, {
      text: joinTextBlocks(result.content),
      answers: stringAnswers(detail?.answers),
      behavior: approvalBehavior(detail?.behavior),
      isError: result.is_error === true,
    });
  }
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

function assistantRecordText(content: unknown, narrationBlockIndexes?: unknown): { text: string; narration: boolean } {
  const texts = extractAssistantTextBlocks(content, narrationBlockIndexes);
  const narration = Array.isArray(content) && content.some((block, index) => asRecord(block)?.type === "thinking" && texts[index].length > 0);
  return { text: narration ? texts.join("") : extractText(content), narration };
}

function extractAssistantRecordText(content: unknown, narrationBlockIndexes?: unknown): string {
  return assistantRecordText(content, narrationBlockIndexes).text;
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
  return record.isMeta === true || isLaisoraInputRecord(record) ? null : extractUserRecordText(record);
}

function isLaisoraInputRecord(record: Record<string, unknown>): boolean {
  const text = extractUserRecordText(record);
  return text !== null && isLaisoraInputText(text);
}

function sentUserUuidOf(obj: Record<string, unknown>): string | undefined {
  const attachment = asRecord(obj.attachment);
  const queued = obj.type === "attachment" && attachment?.type === QUEUED_COMMAND_TYPE;
  if (obj.type !== "user" && !queued) return undefined;
  const origin = asRecord(attachment?.origin) ?? asRecord(obj.origin);
  if (origin && origin.kind !== "human") return undefined;
  const uuid = queued ? attachment?.source_uuid : obj.uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : undefined;
}

export function extractQueuedPromptRecord(obj: Record<string, unknown>): Record<string, unknown> | null {
  const attachment = asRecord(obj.attachment);
  if (obj.type !== "attachment" || attachment?.type !== QUEUED_COMMAND_TYPE || attachment.commandMode !== "prompt") return null;
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

function addQueuedPromptSource(sources: Map<string, string | undefined>, record: Record<string, any>): void {
  if (!extractQueuedPromptRecord(record) || !extractHumanUserPrompt(record)) return;
  const source = asRecord(record.attachment)?.source_uuid;
  if (typeof source === "string" && source.length > 0 && !sources.has(source)) {
    sources.set(source, typeof record.uuid === "string" ? record.uuid : undefined);
  }
}

function queuedPromptSources(lines: readonly string[]): Map<string, string | undefined> {
  const sources = new Map<string, string | undefined>();
  collectPrePass(lines, (index) => lineValue(lines[index]), sources, undefined);
  return sources;
}

export function extractCliInsertedUserText(obj: Record<string, unknown>): string | null {
  return obj.isMeta === true || isLaisoraInputRecord(obj) ? extractUserRecordText(obj) : null;
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
    if (isCompactBoundaryRecord(record)) continue;
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
