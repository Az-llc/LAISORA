import { captureToolIntentInput } from "./webview/status-line";
import { subagentResultForDisplay } from "./subagent-result";
import type { HostArtifactAccess } from "./artifact-access";
import type { AssistantUsage, EventProvenance, ImageRefInfo, NormalizedEventBody, RestoredAgent, ResumePreviewMessage } from "./protocol";
import { assistantUsageFromRaw, RESUME_PREVIEW_MESSAGE_MAX, summarizeToolInput } from "./protocol";
import type { WorkCoverage } from "./work-model";
import { extractResumeSignals, extractStage0ToolFields, parseTaskNotification, RESUME_SIGNAL_TOOL_NAMES } from "./tool-observation";
import { redactAbsolutePaths, redactOptional } from "./path-redaction";
import {
  formatRefusalMessage,
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
  // longGap の境界時刻（このイベントより前に起きたもの）。イベントを生まない
  // 注入レコード（task-notification / 引数なしコマンドラッパ等）は L1.5 に現れないため、
  // 走査へは NormalizedEvent ではなくこの側チャネルで渡す（裁定C2。humanMessageTimes と同型）。
  // 最後のイベントより後ろの境界は、間隔を閉じる相手が居ないので載せない
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
  // uuid は会話の遡り（Phase 2）で重複を弾くための表示専用の識別子。
  // 無いレコードもありうるので optional（無い場合は重複判定の対象外になる）
  messages: Array<{ role: "user" | "assistant"; text: string; uuid?: string; imageRefs?: ImageRefInfo[]; model?: string; timestamp: number }>;
  tools: ReplayedTool[];
  summaryInput: {
    messages: Array<{ role: "user" | "assistant"; text: string }>;
    tools: ReplayedTool[];
  };
  coverage: WorkCoverage;
  malformedLineCount: number;
  // read-set を渡したときだけ返る。境界で切れた末尾行の件数で、malformedLineCount とは別勘定
  boundaryPartialExcludedCount?: number;
  readError?: string;
  claudeCodeVersion?: string;
}

const REPLAY_MESSAGE_MAX = 80;
const REPLAY_TOOL_MAX = 200;
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 8 * 1024 * 1024; // 8MB
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
  // FP-1: timestamp 探索は preview と同じ 1MiB を上限とし、末尾に timestamp 欠落レコードが
  // 続くファイルで Phase 1 前の走査が O(size) 化するのを防ぐ。超過時は undefined へ縮退。
  // parentEndOffset の境界探索自体は打ち切らない（0 に縮退すると捕捉履歴が空になり、
  // capture 前の内容が hydration からも live からも拾われなくなる）
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
    // FP-1: subagent は 1 セッションで実測 113 件まで増える。stat を直列に await すると
    // libuv の threadpool が塞がっているとき件数ぶんの待ちが積み上がり、Phase 1 が伸びる。
    // Promise.all は入力順を保つので names.sort() の順序は変わらない
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
    // Phase 2 / FP-1: parse の連続占有を500 recordsまたは8msに制限する。
    return new Promise<void>((resolve) => setImmediate(() => {
      recordCount = 0;
      startedAt = Date.now();
      resolve();
    }));
  };
}

// 世代境界の述語（R-HND-09）。preview / replay / 裏読み / 要約詳細の再抽出が共有する。
// **配列 index を読み手の外へ出さないこと**: uuid を持たないレコードを readConversationMessages は
// push せず readSessionTranscript は push するので、index を共有すると片方で前世代が漏れるか
// 当世代が削れる。共有してよいのは「どのレコードで真になるか」だけ
export function isHandoffGenerationBoundary(
  record: Record<string, unknown>,
  sessionId: string | undefined
): boolean {
  if (sessionId === undefined || sessionId.length === 0) return false;
  if (record.type !== "user") return false;
  // sidechain は子エージェントの実行。ここで弾かないと、sidechain を先に落とす読み手と
  // 述語を先に呼ぶ読み手で境界がずれる（片方だけ前世代を返す）
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
    // FP-1 / R-TAB-08 / R-CNV-02: 1MiB内に境界が無い巨大単一行はpreview 0件へ縮退する。
    if (firstNewline < 0) return [];
    buffer = buffer.subarray(firstNewline + 1);
  }

  // FP-1（v1 Phase 1）: 改行境界を確認できた行だけを parse する。未終端の末尾行は
  // 書込途中でありえ、read-set 境界（parentEndOffset）外のレコードでもある。
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  buffer = buffer.subarray(0, lastNewline + 1);

  const lines = buffer.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const acceptRecord = createRecordUuidFilter();
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
    if (!uuid) continue;
    if (obj.type === "user") {
      const text = extractHumanUserText(obj);
      if (text) {
        const imageRefs = extractImageRefs(asRecord(obj.message)?.content, uuid);
        messages.push({
          uuid,
          role: "user",
          text,
          ...(imageRefs && imageRefs.length > 0 ? { imageRefs } : {}),
        });
      }
    } else if (obj.type === "assistant") {
      const message = asRecord(obj.message);
      const text = extractText(message?.content);
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

// provider transcript は会話系統の fork でメッセージ全体（message/timestamp/uuid 一致・
// parentUuid だけ違う）を再追記することがある。2 回目は観測事実ではなくファイルの
// アーティファクトで、数えると幻のツール失敗・偽の longGap が出る。この判定は **record 単位**で、block 単位の
// seenToolUseIds / seenToolResultIds とは別物 — あちらは重複レコード内の tool_use /
// tool_result しか落とさず、assistant テキストと usage は素通しする。
// 重複は 1 ファイル内の再追記なので Set も 1 ファイルにつき 1 個で閉じる。
// uuid を持たない record 種は素通しする
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
  // 引き継ぎ封筒（forkSessionId === generationSessionId）のレコード時刻。
  // 呼び出し側が当世代だけを取り出すための境界で、events 自体は切っていない
  generationStartAt?: number;
  malformedLineCount: number;
  // ゲートで捨てた task-notification の計数。破棄は fold 到達前で
  // EvidenceIndex からは観測できないため、Adapter 側の hash 非入力カウンタとして持つ
  droppedTaskNotificationCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  // subagents/ の一覧だけが読めなかった（親は読めている）。readError に畳むと呼び出し側が
  // 「履歴なし」と扱う
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
  // 世代境界より前に現れた compact_boundary。events は切らない（作業ログ・集計は全世代）ので、
  // 会話面が落とせるよう印だけを付ける対象（R-HND-13）
  const preBoundaryCompacts = new Set<RawHistoryItem>();
  const parentTurns: ParentTurnSpan[] = [];
  const seenToolUseIds = new Set<string>();
  const seenToolResultIds = new Set<string>();

  // task-notification は tool_result block を持たない注入 user record のため、合成 toolUseId
  // （既存 placement に一致しない）で tool_call_finished に載せる。序数は agentId 単位で
  // live（claude-normalizer）と同じ規則にする（同一 task-id の複数回通知）
  const notificationOrdinals = new Map<string, number>();
  // live（claude-normalizer）と同じゲート: 起動ACK/resume で実在を観測した agentId のみ
  // イベント化する。無条件だと観測範囲外の通知が reducer の revision を進め、
  // 委任ゼロの既存セッションでも semanticHash が変わる
  const observedAsyncAgentIds = new Set<string>();
  // 背景 Bash の task id は別集合。observedAsyncAgentIds は「起動を告知したのに子 transcript が無い
  // サブエージェント」の検出にも使うので、Bash を混ぜると背景 Bash が全て読み取り不能な子として数えられる
  const observedBackgroundTaskIds = new Set<string>();
  const resumeSignalToolNames = new Map<string, string>();
  let droppedTaskNotificationCount = 0;
  const makeNotificationFields = (text: string) => {
    const notification = parseTaskNotification(text);
    if (!notification) return null;
    if (!observedAsyncAgentIds.has(notification.agentId) && !observedBackgroundTaskIds.has(notification.agentId)) {
      droppedTaskNotificationCount++;
      return null;
    }
    const ordinal = (notificationOrdinals.get(notification.agentId) ?? 0) + 1;
    notificationOrdinals.set(notification.agentId, ordinal);
    return {
      toolUseId: `task-notification:${notification.agentId}:${ordinal}`,
      // 本文は載せない（<summary>/<output-file> の自由文が S0-4 のパス漏えい検査対象になる。
      // fold が使うのは taskNotification の構造化値のみ）
      resultPreview: "",
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
  // steering envelope（非人間）で閉じた turn の後続。次の root レコードで開く
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
  // subagents/ に列挙できた子 transcript の agentId。observedAsyncAgentIds との差が
  // 「親が起動 ACK で告知したのに実体が無い」子になる（読めたが失敗した分は
  // omittedTranscriptCount 側で既に数えているのでここへ入れて二重計上を防ぐ）
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

      // 親 JSONL に inline される sidechain record は子エージェントの実行であり、
      // 親パスで拾うと (a) 子の発話が親 turn に混入 (b) parentToolUseId=null で登録され、
      // 正しい帰属を持つ subagents/ 側の同一 toolUseId が dedup で負ける。
      // subagents/ が無いログでは欠落側へ倒れるため、件数を coverage へ明示する
      if (obj.isSidechain === true) {
        inlineSidechainSkipped++;
        continue;
      }

      const rawTs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
      const recordTime = Number.isFinite(rawTs) ? rawTs : lastParentTimestamp;
      lastParentTimestamp = recordTime;

      // 世代境界の時刻だけを控える。ここでイベントを落とさない: 作業ログと集計は前世代を含める。
      // 切るかどうかは呼び出し側が決める（会話の書き出しだけが切る）
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

      if (obj.type === "user") {
        // 注入レコード・引数なしコマンドラッパは longGap の境界（裁定C1/C2）。
        // tool_result を持つレコードは tool_call_finished が境界になるのでここでは要らない
        const joinedText = joinTextBlocks(content);
        if (isGapBoundaryText(joinedText)) {
          gapBoundaries.push(recordTime);
        }
        const humanText = extractHumanUserText(obj);
        // CLI が差し込んだ user レコード（/compact 後の継続行など）。発言ではないが turn は開く
        const cliInsertedText = humanText === null ? extractCliInsertedUserText(obj) : null;
        // steering envelope: 非人間・非境界。次ターン先頭の user レコードとして
        // 記録された形は live 側で result → 暗黙 startTurn になるため、turn だけ分割し
        // user_message は作らない。tool_result 境界で消費された形は attachment レコードで
        // ここへ来ない。turn を開いていない位置の steer レコードは外部ログの防御として無視する
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
          // live は次の root message_start で暗黙 startTurn するため、turn_started はここではなく
          // 次の root レコード（assistant / tool_result）の時刻で開く（openPendingSilentTurn）。
          // 後続レコードが無ければ turn は開かない（live も message_start が来なければ開かない）
          currentTurnId = null;
          pendingSilentTurn = true;
        }
        if (humanText || cliInsertedText !== null) {
          // steer 直後の人間発話: silent turn は開かず、人間発話の turn がそれを引き継ぐ
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

          if (humanText) {
            const userUuid = typeof obj.uuid === "string" && obj.uuid.length > 0 ? obj.uuid : undefined;
            const imageRefs = extractImageRefs(content, userUuid);
            rawEvents.push({
              body: {
                kind: "user_message",
                turnId: currentTurnId,
                text: humanText,
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

            // live（claude-normalizer）と同一規則: 配列 content は text 要素の join。
            // 表現が経路で割れると TaskCreate の resultPreview 由来 taskKey が経路依存になる
            const raw = Array.isArray(toolResult.content)
              ? toolResult.content
                  .filter((c: unknown) => asRecord(c)?.type === "text")
                  .map((c: unknown) => String(asRecord(c)?.text ?? ""))
                  .join("\n")
              : typeof toolResult.content === "string"
                ? toolResult.content
                : "";
            const preview = redactAbsolutePaths(subagentResultForDisplay(raw)).slice(0, 2000);
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

        // task-notification は turn 活動時刻（lastTurnActivityTimestamp）に含めない:
        // ターン間に届く注入であり、含めると既存セッションの turn 窓・子イベント帰属が変わる
        for (const text of collectNotificationTexts(content)) {
          const fields = makeNotificationFields(text);
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
        const text = extractText(content);
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
            if (RESUME_SIGNAL_TOOL_NAMES.has(toolUse.name)) {
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
        // 境界はこの先のレコードで見つかるので、印はここでは付けられない（封筒が無い記録で
        // 全件が前世代になる）。候補として控え、境界が実在したときだけ events 組み立てで印を付ける
        if (generationSessionId !== undefined && generationStartAt === undefined) {
          preBoundaryCompacts.add(item);
        }
        rawEvents.push(item);
      } else if (obj.type === "system") {
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
        // task-notification は2つの形で届く。ターン間に直接注入される場合は user record だが、
        // キューへ積まれて後から流し込まれた場合は attachment record（本文は attachment.prompt）
        // になる。user だけを見ていると後者が丸ごと落ち、async 委任の完了信号が来ないまま
        // endedAt が undefined で残る（裁定A2 は ACK では確定させないので、通知が唯一の確定源）。
        const prompt = asRecord(obj.attachment)?.prompt;
        if (typeof prompt === "string") {
          for (const text of collectNotificationTexts(prompt)) {
            const fields = makeNotificationFields(text);
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
            // meta parse error ignored
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

          // isAllowedPath 検査は呼び手供給の captured.path（ResumeReadSet）を
          // outside-session-store 契約へ縛るガード。readdir 由来経路は親 dir 検査済みで実質不変
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
                  const preview = redactAbsolutePaths(subagentResultForDisplay(raw)).slice(0, 2000);
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
                const fields = makeNotificationFields(text);
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
                if (RESUME_SIGNAL_TOOL_NAMES.has(toolUse.name)) {
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

  // 単調性は直前の timestamp 昇順ソート自体が保証する（累積 max クランプは不要）
  const events: HistoryEvent[] = rawEvents.map((item) => {
    const ev: HistoryEvent = {
      body:
        generationStartAt !== undefined &&
        preBoundaryCompacts.has(item) &&
        item.body.kind === "compact_boundary"
          ? { ...item.body, priorGeneration: true as const }
          : item.body,
      timestamp: item.timestamp,
    };
    if (item.hostArtifacts && item.hostArtifacts.length > 0) {
      ev.hostArtifacts = item.hostArtifacts;
    }
    return ev;
  });

  // 境界時刻を「その時刻以降で最初のイベント」へ前置として配る。rawEvents へ混ぜないのは
  // fileOrder / seq がずれて L1.5 のイベント列そのもの（= WorkModel / SemanticModel）が
  // 動くため。最後のイベントより後ろの境界は間隔を閉じられないので捨てる
  gapBoundaries.sort((a, b) => a - b);
  let boundaryCursor = 0;
  for (const ev of events) {
    const attached: number[] = [];
    while (boundaryCursor < gapBoundaries.length && gapBoundaries[boundaryCursor] <= ev.timestamp) {
      attached.push(gapBoundaries[boundaryCursor++]);
    }
    if (attached.length > 0) ev.gapBoundaries = attached;
  }

  // inline sidechain のスキップは、subagents/ から同じ実行を読めた場合は欠落ではない。
  // 子 transcript を1つも読めなかった場合のみ「1論理 transcript 分の欠落」として明示する
  if (inlineSidechainSkipped > 0 && subagentTranscriptsRead === 0) {
    coverage.details = "prefix-truncated";
    coverage.omittedTranscriptCount = (coverage.omittedTranscriptCount ?? 0) + 1;
  }

  // resume 側は subagents/ ごと引き継がれないことがある。readdir が ENOENT だと
  // entries.length===0 で子読み込みブロックを素通りするため、ここで突合しないと
  // 「委任が無かったセッション」と区別がつかず、225 イベント少ないまま
  // coverage が complete で返る（構造は変えず availability として持つ）
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

// 会話ログの遡り（History Lazy Loading Phase 2）専用の読み手。
// readSessionTranscript とは別に置く: 向こうは tools / results / coverage / title / cwd まで
// 組み立てる resume 経路の正本で、ページングのたびに全部を作り直すのは重すぎる
// （実測で transcript は最大 14MB）。本文の取り出し規則は共有する — extractHumanUserText /
// extractText を別実装にすると、遡って出した本文と復元した本文の見え方がずれる。
//
// 返すのは presentation 用の最小項目だけ。ここから作った payload は pushEvent を通さない。
export async function readConversationMessages(
  filePath: string,
  isAllowedPath: (filePath: string) => boolean,
  resumeReadSet?: ResumeReadSet,
  sessionId?: string
): Promise<{
  messages: Array<{ uuid: string; role: "user" | "assistant"; text: string; timestamp: number; imageRefs?: ImageRefInfo[] }>;
  malformedLineCount: number;
  // uuid を持たないレコードは識別できず重複を検出できないので運ばない。件数は突合へ回す
  droppedWithoutUuidCount: number;
  boundaryPartialExcludedCount?: number;
  readError?: string;
  handoffEnvelope?: HandoffEnvelopeV2;
}> {
  const messages: Array<{
    uuid: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    imageRefs?: ImageRefInfo[];
  }> = [];
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
    const uuid = typeof obj.uuid === "string" ? obj.uuid : "";
    if (obj.type === "user") {
      const body = extractHumanUserText(obj);
      if (!body) {
        // Forked logs retain earlier generations. The last envelope is the current handoff.
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
      const imageRefs = extractImageRefs(asRecord(obj.message)?.content, uuid);
      messages.push({
        uuid,
        role: "user",
        text: body,
        timestamp: lastTimestamp,
        ...(imageRefs ? { imageRefs } : {}),
      });
    } else if (obj.type === "assistant") {
      const message = asRecord(obj.message);
      const body = extractText(message?.content);
      if (!body || isRefusalErrorProse(obj, message)) continue;
      if (uuid.length === 0) {
        droppedWithoutUuidCount++;
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
  const messages: Array<{ role: "user" | "assistant"; text: string; uuid?: string; imageRefs?: ImageRefInfo[]; model?: string; timestamp: number }> = [];
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
      // ループ内の `text` は本文抽出結果に覆われるので、境界判定はここで確定させる
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
        if (obj.type === "user") {
          const text = extractHumanUserText(obj);
          if (text) {
            if (!title) title = text.split("\n")[0];
            const uuid = typeof obj.uuid === "string" && obj.uuid.length > 0 ? obj.uuid : undefined;
            const imageRefs = extractImageRefs(content, uuid);
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
              // live（claude-normalizer）と同一規則: 配列 content は text 要素の join。
              // 表現が経路で割れると TaskCreate の resultPreview 由来 taskKey が経路依存になる
              const raw = Array.isArray(toolResult.content)
                ? toolResult.content
                    .filter((c: unknown) => asRecord(c)?.type === "text")
                    .map((c: unknown) => String(asRecord(c)?.text ?? ""))
                    .join("\n")
                : typeof toolResult.content === "string"
                  ? toolResult.content
                  : "";
              const preview = redactAbsolutePaths(subagentResultForDisplay(raw)).slice(0, 2000);
              const isError = toolResult.is_error === true;
              results.set(toolResult.tool_use_id, { isError, preview });
            }
          }
        } else if (obj.type === "assistant") {
          if (obj.isSidechain !== true) {
            const model = message?.model;
            recordedModel = typeof model === "string" && model.length > 0 && !model.startsWith("<") ? model : undefined;
          }
          const text = extractText(content);
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
  // 窓取りは世代の切り出しより後ろ（R-HND-09）。先に窓を取ると前世代のぶんで 80 件が埋まる。
  // summaryInput は切らない（分析・要約の入力は分析の契約側）
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
    summaryInput: { messages, tools: allTools },
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

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === "object" && block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string";
    })
    .map((block) => block.text)
    .filter((text) => !text.startsWith("<ide_") && !text.startsWith("<system-reminder>"))
    .join("\n")
    .trim();
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

// user レコードの表示本文。isMeta（CLI が書いた user レコード）の分岐だけを呼び出し側へ出す。
// 2 つの入口が同じ抑止（封筒・コマンドラッパ・Caveat・中断通知）を共有しないと、
// 片方だけが `<local-command-caveat>` を本文として通す
function extractUserRecordText(obj: Record<string, unknown>): string | null {
  if (obj.type !== "user" || obj.isSidechain) return null;
  // R-HND-06: compact summaries are model output even though JSONL stores them as user records.
  if (obj.isCompactSummary === true) return null;
  const origin = asRecord(obj.origin);
  if (origin && origin.kind !== "human") return null;
  const text = extractText(asRecord(obj.message)?.content);
  if (!text) return null;
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

// `isMeta` は「利用者が打っていない user レコード」の CLI 側の印。実測（2026-09-16・
// ~/.claude/projects 1076 本 / 355909 行）では、この印だけが本文を人間発話として通していた。
// `isVisibleInTranscriptOnly` は単独では 1 件も通さない（必ず isCompactSummary と同時）ので表に足さない
export function extractHumanUserText(obj: Record<string, unknown>): string | null {
  return obj.isMeta === true ? null : extractUserRecordText(obj);
}

// CLI が user レコードとして差し込んだ行。人間発話ではないので user_message にしない
// （work-model / evidence-index / l3 / time-buckets / タイトル / 逐語の全てに混入する）。
// turn 境界の判定にだけ使い、画面はラベルで「利用者の発言ではない」と示す。
// 返るのは extractUserRecordText を通った本文だけなので、`<laisora-handoff>` / `<laisora-steer>`
// の封筒・`<local-command-*>`・skill の前置き（`Base directory for this skill:`）では null になり turn は開かない。
// 開くのは /compact 後の継続行のような、タグを持たない素の本文
export function extractCliInsertedUserText(obj: Record<string, unknown>): string | null {
  return obj.isMeta === true ? extractUserRecordText(obj) : null;
}

export interface VerbatimUtterance {
  n: number;
  at: string;
  kind: "typed" | "answer";
  text: string;
  questions?: string[];
}

// 逐語で運ぶ範囲は 1 世代分（R-HND-02）。世代の切れ目は前回の
// 引き継ぎ封筒であって compact 境界ではない。世代の途中で自動 compact が起きても切らない
// （切ると直近の判断がまとめて落ち、切れる位置が自動 compact のタイミング任せになって、失われた範囲が利用者から見えない）。
// それ以前の世代は要約の連鎖と、履歴に残る各世代の封筒が運ぶ。
// compact の性能向上に合わせて範囲を見直す余地がある。変えるならこの関数だけを直し、
// 絞る方向に変えるなら落とした件数を画面に出すこと（黙って消さない）
// 封筒の検出には生の本文が要る。extractHumanUserText は封筒を非人間として null にするので使えない
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
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (index < generationStart) {
      // 範囲外でも時刻は拾う。timestamp を持たないレコードの補完に使う
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

    const text = extractHumanUserText(record);
    if (text !== null) {
      utterances.push({ n: utterances.length + 1, at: lastAt, kind: "typed", text });
    }
  }
  return utterances;
}
