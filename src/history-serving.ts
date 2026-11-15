import * as vscode from "vscode";

import { INSPECTOR_RESPONSE_BYTES } from "./agent-inspector";
import {
  ConversationHistoryError,
  clipConversationMessage,
  clipConversationText,
  conversationCursorThroughAnyUuid,
  conversationMessageByUuid,
  hasConversationHistory,
  nextConversationChunk,
  registerConversationHistory,
} from "./conversation-history";
import {
  createHydrationDraft,
  foldRestoredRecords,
  readRestoredRecords,
} from "./resume-hydration";
import {
  historyScopeKey,
  historyTranscriptScopeKey,
  type Session,
} from "./session";
import { fitEventForTransport } from "./history-chunk-fit";
import {
  HistoryWindowError,
  cursorForAnchor,
  hasHistoryWindow,
  nextHistoryChunk,
  registerHistoryWindow,
} from "./history-window";
import { output } from "./host-context";
import { CONVERSATION_TEXT_MAX } from "./protocol";
import type {
  ConversationHistoryErrorReason,
  ConversationHistoryPagePayload,
  HistoryChunkErrorReason,
  HistoryChunkPagePayload,
  NormalizedEvent,
  WebviewToHost,
} from "./protocol";
import {
  isInSessionStore,
  lookupSessionFile,
  sessionIdForOutput,
  sessionTranscriptLookup,
  type SessionFileLookup,
} from "./session-files";
import { readConversationMessages, unturnedParentRecordSource } from "./session-transcript";
import { sessionRecordId } from "./session-record";
import { currentScopeMax, type SessionStore } from "./store-surfaces";

const HISTORY_CHUNK_MIN_ITEMS = 200;
const HISTORY_CHUNK_MIN_ITEMS_LADDER = [HISTORY_CHUNK_MIN_ITEMS, 50, 12, 3, 1];
const HISTORY_CHUNK_RESPONSE_BYTES = INSPECTOR_RESPONSE_BYTES;
const CONVERSATION_CHUNK_ITEMS_LADDER = [40, 16, 6, 2, 1];
const CONVERSATION_CHUNK_RESPONSE_BYTES = INSPECTOR_RESPONSE_BYTES;

export interface LatestRequests {
  set(sender: vscode.Webview, tabId: string, requestId: string): void;
  isLatest(sender: vscode.Webview, tabId: string, requestId: string): boolean;
}

export function latestRequests(): LatestRequests {
  const byWebview = new WeakMap<vscode.Webview, Map<string, string>>();
  return {
    set(sender, tabId, requestId) {
      let byTab = byWebview.get(sender);
      if (!byTab) {
        byTab = new Map();
        byWebview.set(sender, byTab);
      }
      byTab.set(tabId, requestId);
    },
    isLatest: (sender, tabId, requestId) => byWebview.get(sender)?.get(tabId) === requestId,
  };
}

const historyRequests = latestRequests();
const worklogTranscriptRequests = latestRequests();
const conversationRequests = latestRequests();

async function postChunkError(
  st: SessionStore,
  sender: vscode.Webview,
  type: "historyChunkError" | "worklogTranscriptError",
  session: Session,
  requestId: string,
  generation: number,
  reason: HistoryChunkErrorReason
): Promise<void> {
  await st.postTo(sender, { type, tabId: session.tabId, requestId, generation, reason });
}


function stripHistoryChunkImages(items: NormalizedEvent[]): NormalizedEvent[] {
  return items.map((item) => {
    if (item.kind === "user_message" && item.images && item.images.length > 0) {
      return {
        ...item,
        images: [],
        imageRefs: item.images.map((im, index) => ({
          ref: { kind: "event", generation: item.generation, seq: item.seq, index },
          mediaType: im.mediaType,
        })),
      };
    }
    return item;
  });
}

function conversationHistoryGapFields(
  session: Session
): { malformedLineCount?: number; droppedWithoutUuidCount?: number } {
  const gaps = session.conversationHistoryGaps;
  if (gaps === undefined) return {};
  return {
    ...(gaps.malformedLineCount > 0 ? { malformedLineCount: gaps.malformedLineCount } : {}),
    ...(gaps.droppedWithoutUuidCount > 0 ? { droppedWithoutUuidCount: gaps.droppedWithoutUuidCount } : {}),
  };
}

async function postConversationHistoryError(
  st: SessionStore,
  sender: vscode.Webview,
  session: Session,
  requestId: string,
  generation: number,
  reason: ConversationHistoryErrorReason,
  detail?: string
): Promise<void> {
  output.appendLine(
    `[${session.title}] 会話履歴エラー: ${reason} session=${sessionIdForOutput(session)} req=${requestId}` +
      (detail === undefined ? "" : ` — ${detail}`)
  );
  await st.postTo(sender, {
    type: "conversationHistoryError",
    tabId: session.tabId,
    requestId,
    generation,
    reason,
  });
}


async function loadConversationScope(
  session: Session,
  scopeKey: string,
  stillValid: () => boolean
): Promise<{ reason: ConversationHistoryErrorReason; detail?: string } | undefined> {
  const lookup: SessionFileLookup =
    session.resumeFilePath !== undefined
      ? { path: session.resumeFilePath, reason: null }
      : lookupSessionFile(sessionRecordId(session) ?? "");
  const filePath = lookup.path;
  if (filePath === null) {
    return lookup.reason === "scan_failed"
      ? { reason: "session-scan-failed", detail: lookup.detail }
      : { reason: "session-unavailable" };
  }
  const read = await readConversationMessages(filePath, isInSessionStore, undefined, sessionRecordId(session));
  if (!stillValid()) return { reason: "stale-request" };
  if (read.readError) return { reason: "read-failed", detail: read.readError };
  registerConversationHistory(scopeKey, read.messages, currentScopeMax());
  session.conversationHistoryGaps = {
    malformedLineCount: read.malformedLineCount,
    droppedWithoutUuidCount: read.droppedWithoutUuidCount,
  };
  output.appendLine(
    `[${session.title}] 会話履歴を登録: ${read.messages.length}件 ` +
      `malformed=${read.malformedLineCount} uuid欠落=${read.droppedWithoutUuidCount}`
  );
  return undefined;
}

export async function handleHistoryMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "historyChunkRequest" | "conversationHistoryRequest" | "conversationMessageTextRequest" | "worklogTranscriptRequest" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "historyChunkRequest": {
      const session = target!;
      const generation = session.generation;
      const scopeKey = historyScopeKey(session);
      historyRequests.set(sender, session.tabId, msg.requestId);
      const requestStillValid = (): boolean =>
        st.sessions.get(session.tabId) === session &&
        !session.closed &&
        session.generation === generation &&
        historyRequests.isLatest(sender, session.tabId, msg.requestId);
      if (!requestStillValid()) {
        await postChunkError(st, sender, "historyChunkError", session, msg.requestId, generation, "stale-request");
        break;
      }
      try {
        let cursor: string | undefined;
        if (msg.cursor !== undefined) cursor = msg.cursor;
        else if (msg.anchor !== undefined) cursor = cursorForAnchor(scopeKey, msg.anchor).cursor;
        else throw new HistoryWindowError("invalid-request");
        const buildResponse = (page: HistoryChunkPagePayload) => ({
          type: "historyChunkResult" as const,
          tabId: session.tabId,
          requestId: msg.requestId,
          generation,
          page,
        });
        let chunkResponse =
          cursor === undefined
            ? buildResponse({
                items: [],
                hasMore: false,
                coverage: {
                  returnedCount: 0,
                  remainingOlderCount: 0,
                  oldestReached: true,
                  snapExtendedBy: 0,
                },
              })
            : undefined;
        if (cursor !== undefined) {
          let previousStart = -1;
          for (const minItems of HISTORY_CHUNK_MIN_ITEMS_LADDER) {
            const page = nextHistoryChunk({ scopeKey, cursor, minItems });
            if (page.coverage.remainingOlderCount === previousStart) continue;
            previousStart = page.coverage.remainingOlderCount;
            const candidate = buildResponse({ ...page, items: stripHistoryChunkImages(page.items) });
            if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= HISTORY_CHUNK_RESPONSE_BYTES) {
              chunkResponse = candidate;
              break;
            }
          }
        }
        if (chunkResponse === undefined && cursor !== undefined) {
          const page = nextHistoryChunk({ scopeKey, cursor, minItems: 1 });
          const partialResponse = (drop: number, items?: NormalizedEvent[]) => {
            const first = page.items[drop];
            const handle = cursorForAnchor(scopeKey, {
              generation: first.generation,
              seq: first.seq,
            });
            return buildResponse({
              items: items ?? stripHistoryChunkImages(page.items.slice(drop)),
              nextCursor: handle.cursor,
              hasMore: handle.hasMore,
              coverage: {
                returnedCount: page.items.length - drop,
                remainingOlderCount: page.coverage.remainingOlderCount + drop,
                oldestReached: !handle.hasMore,
                snapExtendedBy: 0,
              },
            });
          };
          const fits = (drop: number) =>
            Buffer.byteLength(JSON.stringify(partialResponse(drop)), "utf8") <=
            HISTORY_CHUNK_RESPONSE_BYTES;
          let lo = 1;
          let hi = page.items.length - 1;
          let best = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (fits(mid)) {
              best = mid;
              hi = mid - 1;
            } else {
              lo = mid + 1;
            }
          }
          if (best !== -1) chunkResponse = partialResponse(best);
          else {
            const drop = page.items.length - 1;
            const overhead = Buffer.byteLength(JSON.stringify(partialResponse(drop, [])), "utf8");
            const only = stripHistoryChunkImages([page.items[drop]])[0];
            chunkResponse = partialResponse(drop, [
              fitEventForTransport(only, HISTORY_CHUNK_RESPONSE_BYTES - overhead),
            ]);
            output.appendLine(
              `[${session.title}] 履歴chunk: 単一イベントが予算超過のため本文を切って送出（この turn ${page.items.length}件）`
            );
          }
        }
        if (chunkResponse === undefined) throw new Error("history chunk response not built");
        if (!requestStillValid()) {
          await postChunkError(st, sender, "historyChunkError", session, msg.requestId, generation, "stale-request");
          break;
        }
        await st.postTo(sender, chunkResponse);
      } catch (error) {
        const reason: HistoryChunkErrorReason =
          error instanceof HistoryWindowError ? error.reason : "host-error";
        output.appendLine(
          `[${session.title}] 履歴chunk失敗: ${reason}` +
            (error instanceof HistoryWindowError ? "" : ` ${String(error)}`)
        );
        await postChunkError(st, sender, "historyChunkError", session, msg.requestId, generation, reason);
      }
      break;
    }
    case "conversationHistoryRequest": {
      const session = target!;
      const generation = session.generation;
      const scopeKey = historyScopeKey(session);
      conversationRequests.set(sender, session.tabId, msg.requestId);
      const requestStillValid = (): boolean =>
        st.sessions.get(session.tabId) === session &&
        !session.closed &&
        session.generation === generation &&
        conversationRequests.isLatest(sender, session.tabId, msg.requestId);
      if (!requestStillValid()) {
        await postConversationHistoryError(
          st, sender, session, msg.requestId, generation, "stale-request"
        );
        break;
      }
      try {
        let cursor = msg.anchorUuids === undefined ? msg.cursor : undefined;
        const anchors = [...(msg.anchorUuids ?? []), ...session.conversationAnchorUuids];
        if (cursor === undefined || !hasConversationHistory(scopeKey)) {
          if (anchors.length === 0) {
            await postConversationHistoryError(
              st, sender, session, msg.requestId, generation, "session-unavailable"
            );
            break;
          }
          const loaded = await loadConversationScope(session, scopeKey, requestStillValid);
          if (loaded !== undefined) {
            await postConversationHistoryError(
              st, sender, session, msg.requestId, generation, loaded.reason, loaded.detail
            );
            break;
          }
          cursor = conversationCursorThroughAnyUuid(scopeKey, anchors);
        }
        let response:
          | {
              type: "conversationHistoryResult";
              tabId: string;
              requestId: string;
              generation: number;
              page: ConversationHistoryPagePayload;
            }
          | undefined;
        let lastCount = -1;
        for (const maxItems of CONVERSATION_CHUNK_ITEMS_LADDER) {
          const raw = nextConversationChunk({ scopeKey, cursor, maxItems });
          if (raw.items.length === lastCount) continue;
          lastCount = raw.items.length;
          const page = {
            ...raw,
            items: raw.items.map((m) =>
              clipConversationMessage(m, maxItems <= 2 ? CONVERSATION_TEXT_MAX : Math.floor(CONVERSATION_TEXT_MAX / 4))
            ),
            coverage: { ...raw.coverage, ...conversationHistoryGapFields(session) },
          };
          const candidate = {
            type: "conversationHistoryResult" as const,
            tabId: session.tabId,
            requestId: msg.requestId,
            generation,
            page,
          };
          if (
            Buffer.byteLength(JSON.stringify(candidate), "utf8") <=
            CONVERSATION_CHUNK_RESPONSE_BYTES
          ) {
            response = candidate;
            break;
          }
        }
        if (response === undefined) {
          await postConversationHistoryError(
            st, sender, session, msg.requestId, generation, "response-too-large", "1件でも上限を超える"
          );
          break;
        }
        if (!requestStillValid()) {
          await postConversationHistoryError(
            st, sender, session, msg.requestId, generation, "stale-request"
          );
          break;
        }
        await st.postTo(sender, response);
      } catch (error) {
        const reason: ConversationHistoryErrorReason =
          error instanceof ConversationHistoryError ? error.reason : "host-error";
        await postConversationHistoryError(
          st, sender, session, msg.requestId, generation, reason,
          error instanceof ConversationHistoryError ? undefined : String(error)
        );
      }
      break;
    }
    case "conversationMessageTextRequest": {
      const session = target!;
      const generation = session.generation;
      const scopeKey = historyScopeKey(session);
      const stillValid = (): boolean =>
        st.sessions.get(session.tabId) === session && !session.closed && session.generation === generation;
      const fail = async (reason: ConversationHistoryErrorReason, detail?: string): Promise<void> => {
        output.appendLine(
          `[${session.title}] 発言の続きの取得失敗: ${reason} session=${sessionIdForOutput(session)} uuid=${msg.uuid}` +
            (detail === undefined ? "" : ` — ${detail}`)
        );
        await st.postTo(sender, { type: "conversationMessageTextError", tabId: session.tabId, requestId: msg.requestId, reason });
      };
      try {
        let found = hasConversationHistory(scopeKey) ? conversationMessageByUuid(scopeKey, msg.uuid) : undefined;
        if (found === undefined) {
          const loaded = await loadConversationScope(session, scopeKey, stillValid);
          if (loaded !== undefined) {
            await fail(loaded.reason, loaded.detail);
            break;
          }
          found = conversationMessageByUuid(scopeKey, msg.uuid);
        }
        if (found === undefined) {
          await fail("unknown-anchor");
          break;
        }
        const piece = clipConversationText({ text: found.text.slice(msg.offset) }, CONVERSATION_TEXT_MAX);
        await st.postTo(sender, {
          type: "conversationMessageTextResult",
          tabId: session.tabId,
          requestId: msg.requestId,
          uuid: msg.uuid,
          offset: msg.offset,
          text: piece.text,
          ...(piece.clipped ? { clipped: true as const } : {}),
        });
      } catch (error) {
        await fail(error instanceof ConversationHistoryError ? error.reason : "host-error", String(error));
      }
      break;
    }
    case "worklogTranscriptRequest": {
      const session = target!;
      const generation = session.generation;
      const scopeKey = historyTranscriptScopeKey(session);
      worklogTranscriptRequests.set(sender, session.tabId, msg.requestId);
      const requestStillValid = (): boolean =>
        st.sessions.get(session.tabId) === session &&
        !session.closed &&
        session.generation === generation &&
        worklogTranscriptRequests.isLatest(sender, session.tabId, msg.requestId);
      if (!requestStillValid()) {
        await postChunkError(st, sender, "worklogTranscriptError", session, msg.requestId, generation, "stale-request");
        break;
      }
      try {
        let anchorCursor: string | undefined;
        let anchorResolved = false;
        let needsTranscriptScope = !hasHistoryWindow(scopeKey);
        if (!needsTranscriptScope && msg.anchor !== undefined) {
          try {
            anchorCursor = cursorForAnchor(scopeKey, msg.anchor).cursor;
            anchorResolved = true;
          } catch (error) {
            if (!(error instanceof HistoryWindowError) || error.reason !== "unknown-anchor") throw error;
            needsTranscriptScope = true;
          }
        }
        if (needsTranscriptScope) {
          if (msg.anchor === undefined) throw new HistoryWindowError("invalid-cursor");
          if (session.workModel.coverage.source !== "provider-transcript") {
            await postChunkError(
              st, sender, "worklogTranscriptError", session, msg.requestId, generation, "history-unavailable"
            );
            break;
          }
          const { ref, lookup } = sessionTranscriptLookup(session);
          if (ref === null) {
            output.appendLine(
              `[${session.title}] worklogTranscript: ${lookup.reason ?? "no_session_id"} session=${sessionIdForOutput(session)}` +
                (lookup.reason === "scan_failed" ? ` — ${lookup.detail}` : "")
            );
            await postChunkError(
              st, sender, "worklogTranscriptError", session, msg.requestId, generation, "history-unavailable"
            );
            break;
          }
          if (!isInSessionStore(ref.file)) {
            await postChunkError(
              st, sender, "worklogTranscriptError", session, msg.requestId, generation, "history-unavailable"
            );
            break;
          }
          const resumed = session.hydration;
          const readSet =
            resumed !== null && resumed.filePath === ref.file && resumed.sessionId === ref.sessionId
              ? resumed.readSet
              : undefined;
          const parentRecords = unturnedParentRecordSource(ref.file, readSet);
          let restored: Awaited<ReturnType<typeof readRestoredRecords>>;
          try {
            restored = await readRestoredRecords(ref.file, ref.sessionId, readSet, parentRecords);
          } finally {
            parentRecords.release();
          }
          const { transcript, history } = restored;
          if (!requestStillValid()) {
            await postChunkError(
              st, sender, "worklogTranscriptError", session, msg.requestId, generation, "stale-request"
            );
            break;
          }
          if (history.subagentsReadError !== undefined) {
            output.appendLine(`[${session.title}] 履歴transcript subagents/ read failed: ${history.subagentsReadError}`);
          }
          if (history.coverage.ancestorUsageReadError !== undefined) {
            output.appendLine(`[${session.title}] 履歴transcript earlier-conversation record read failed (child usage not counted): ${history.coverage.ancestorUsageReadError}`);
          }
          const historyReadError = history.readError;
          if (historyReadError !== undefined) {
            output.appendLine(`[${session.title}] 履歴transcript読み取り失敗: ${historyReadError}`);
            await postChunkError(
              st, sender, "worklogTranscriptError", session, msg.requestId, generation, "host-error"
            );
            break;
          }
          const anchor = msg.anchor;
          const draft = createHydrationDraft(session);
          draft.generation = anchor.generation;
          const scopeEvents: NormalizedEvent[] = [];
          const outcome = await foldRestoredRecords(
            draft,
            transcript,
            history,
            (step) => {
              const folded = step.normalizedEvent;
              if (folded === null) return "continue";
              scopeEvents.push(folded);
              return folded.seq === anchor.seq ? "stop" : "continue";
            },
            () => !requestStillValid(),
            session.restoredWritesLost?.sessionId === ref.sessionId ? session.restoredWritesLost.notice : undefined
          );
          if (outcome === "invalidated") {
            await postChunkError(st, sender, "worklogTranscriptError", session, msg.requestId, generation, "stale-request");
            break;
          }
          const anchorEvent: NormalizedEvent | undefined =
            outcome === "stopped" ? scopeEvents[scopeEvents.length - 1] : undefined;
          const held = session.events.find(
            (e) => e.generation === anchor.generation && e.seq === anchor.seq
          );
          const aligned =
            anchorEvent !== undefined &&
            (held === undefined ||
              (held.kind === anchorEvent.kind && held.timestamp === anchorEvent.timestamp));
          if (!aligned) {
            output.appendLine(
              `[${session.title}] 履歴transcript: anchor ${anchor.generation}:${anchor.seq} が記録の fold と一致しない`
            );
            await postChunkError(
              st, sender, "worklogTranscriptError", session, msg.requestId, generation, "history-unavailable"
            );
            break;
          }
          registerHistoryWindow(scopeKey, scopeEvents, currentScopeMax());
        }

        let cursor: string | undefined;
        if (msg.cursor !== undefined) cursor = msg.cursor;
        else if (msg.anchor !== undefined) {
          cursor = anchorResolved ? anchorCursor : cursorForAnchor(scopeKey, msg.anchor).cursor;
        }
        else throw new HistoryWindowError("invalid-request");

        const buildResponse = (page: HistoryChunkPagePayload) => ({
          type: "worklogTranscriptResult" as const,
          tabId: session.tabId,
          requestId: msg.requestId,
          generation,
          page,
        });
        let transcriptResponse =
          cursor === undefined
            ? buildResponse({
                items: [],
                hasMore: false,
                coverage: { returnedCount: 0, remainingOlderCount: 0, oldestReached: true, snapExtendedBy: 0 },
              })
            : undefined;
        const getTranscriptChunk = (k: string, c: string, m: number) =>
          nextHistoryChunk({ scopeKey: k, cursor: c, minItems: m });
        if (cursor !== undefined) {
          let previousStart = -1;
          for (const minItems of HISTORY_CHUNK_MIN_ITEMS_LADDER) {
            const page = getTranscriptChunk(scopeKey, cursor, minItems);
            if (page.coverage.remainingOlderCount === previousStart) continue;
            previousStart = page.coverage.remainingOlderCount;
            const candidate = buildResponse({ ...page, items: stripHistoryChunkImages(page.items) });
            if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= (HISTORY_CHUNK_RESPONSE_BYTES | 0)) {
              transcriptResponse = candidate;
              break;
            }
          }
        }
        if (transcriptResponse === undefined && cursor !== undefined) {
          const page = getTranscriptChunk(scopeKey, cursor, 1);
          const partialResponse = (drop: number, items?: NormalizedEvent[]) => {
            const first = page.items[drop];
            const handle = cursorForAnchor(scopeKey, {
              generation: first.generation,
              seq: first.seq,
            });
            return buildResponse({
              items: items ?? stripHistoryChunkImages(page.items.slice(drop)),
              nextCursor: handle.cursor,
              hasMore: Boolean(handle.hasMore),
              coverage: {
                returnedCount: page.items.length - drop,
                remainingOlderCount: page.coverage.remainingOlderCount + drop,
                oldestReached: !handle.hasMore,
                snapExtendedBy: 0,
              },
            });
          };
          const fitsChunk = (drop: number) =>
            Buffer.byteLength(JSON.stringify(partialResponse(drop)), "utf8") <=
            (HISTORY_CHUNK_RESPONSE_BYTES | 0);
          let lo = 1;
          let hi = page.items.length - 1;
          let best = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (fitsChunk(mid)) {
              best = mid;
              hi = mid - 1;
            } else {
              lo = mid + 1;
            }
          }
          if (best !== -1) transcriptResponse = partialResponse(best);
          else {
            const drop = page.items.length - 1;
            const overhead = Buffer.byteLength(JSON.stringify(partialResponse(drop, [])), "utf8");
            const only = stripHistoryChunkImages([page.items[drop]])[0];
            transcriptResponse = partialResponse(drop, [
              fitEventForTransport(only, HISTORY_CHUNK_RESPONSE_BYTES - overhead),
            ]);
            output.appendLine(
              `[${session.title}] 履歴transcript: 単一イベントが予算超過のため本文を切って送出（この turn ${page.items.length}件）`
            );
          }
        }
        if (transcriptResponse === undefined) throw new Error("worklog transcript chunk response not built");
        if (!requestStillValid()) {
          await postChunkError(st, sender, "worklogTranscriptError", session, msg.requestId, generation, "stale-request");
          break;
        }
        await st.postTo(sender, transcriptResponse);
      } catch (error) {
        const reason: HistoryChunkErrorReason =
          error instanceof HistoryWindowError ? error.reason : "host-error";
        output.appendLine(
          `[${session.title}] 履歴transcript失敗: ${reason}` +
            (error instanceof HistoryWindowError ? "" : ` ${String(error)}`)
        );
        await postChunkError(st, sender, "worklogTranscriptError", session, msg.requestId, generation, reason);
      }
      break;
    }
  }
}
