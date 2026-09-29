import * as vscode from "vscode";

import { INSPECTOR_RESPONSE_BYTES } from "./agent-inspector";
import {
  ConversationHistoryError,
  conversationCursorBeforeAnyUuid,
  hasConversationHistory,
  nextConversationChunk,
  registerConversationHistory,
} from "./conversation-history";
import {
  createHydrationDraft,
  foldHistoryEvents,
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
  type SessionFileLookup,
} from "./session-files";
import { readConversationMessages, readSessionHistory } from "./session-transcript";
import { currentScopeMax, type SessionStore } from "./store-surfaces";

const HISTORY_CHUNK_MIN_ITEMS = 200;
// src/history-window.ts#snapChunkStart の境界補正は HISTORY_CHUNK_RESPONSE_BYTES に収まることを保証しない。
const HISTORY_CHUNK_MIN_ITEMS_LADDER = [HISTORY_CHUNK_MIN_ITEMS, 50, 12, 3, 1];
const HISTORY_CHUNK_RESPONSE_BYTES = INSPECTOR_RESPONSE_BYTES;
// 件数だけでは搬送予算を保証できない（CONVERSATION_CHUNK_RESPONSE_BYTES）。
const CONVERSATION_CHUNK_ITEMS_LADDER = [40, 16, 6, 2, 1];
const CONVERSATION_CHUNK_RESPONSE_BYTES = INSPECTOR_RESPONSE_BYTES;
const CONVERSATION_TEXT_MAX = 20000;

const historyRequests = new WeakMap<vscode.Webview, Map<string, string>>();

function setLatestHistoryRequest(sender: vscode.Webview, tabId: string, requestId: string): void {
  let byTab = historyRequests.get(sender);
  if (!byTab) {
    byTab = new Map();
    historyRequests.set(sender, byTab);
  }
  byTab.set(tabId, requestId);
}

function isLatestHistoryRequest(sender: vscode.Webview, tabId: string, requestId: string): boolean {
  return historyRequests.get(sender)?.get(tabId) === requestId;
}

const worklogTranscriptRequests = new WeakMap<vscode.Webview, Map<string, string>>();

function setLatestWorklogTranscriptRequest(sender: vscode.Webview, tabId: string, requestId: string): void {
  let byTab = worklogTranscriptRequests.get(sender);
  if (!byTab) {
    byTab = new Map();
    worklogTranscriptRequests.set(sender, byTab);
  }
  byTab.set(tabId, requestId);
}

function isLatestWorklogTranscriptRequest(
  sender: vscode.Webview,
  tabId: string,
  requestId: string
): boolean {
  return worklogTranscriptRequests.get(sender)?.get(tabId) === requestId;
}

async function postWorklogTranscriptError(
  st: SessionStore,
  sender: vscode.Webview,
  session: Session,
  requestId: string,
  generation: number,
  reason: HistoryChunkErrorReason
): Promise<void> {
  await st.postTo(sender, {
    type: "worklogTranscriptError",
    tabId: session.tabId,
    requestId,
    generation,
    reason,
  });
}

// clampConversationText の切断位置はサロゲートペアを分断しないこと。
function clampConversationText<T extends { text: string }>(m: T, maxItems: number): T {
  const limit = maxItems <= 2 ? CONVERSATION_TEXT_MAX : Math.floor(CONVERSATION_TEXT_MAX / 4);
  if (m.text.length <= limit) return m;
  let cut = limit - 1;
  const code = m.text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { ...m, text: `${m.text.slice(0, cut)}…` };
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

const conversationRequests = new WeakMap<vscode.Webview, Map<string, string>>();

function setLatestConversationRequest(sender: vscode.Webview, tabId: string, requestId: string): void {
  let byTab = conversationRequests.get(sender);
  if (!byTab) {
    byTab = new Map();
    conversationRequests.set(sender, byTab);
  }
  byTab.set(tabId, requestId);
}

function isLatestConversationRequest(
  sender: vscode.Webview,
  tabId: string,
  requestId: string
): boolean {
  return conversationRequests.get(sender)?.get(tabId) === requestId;
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

async function postHistoryChunkError(
  st: SessionStore,
  sender: vscode.Webview,
  session: Session,
  requestId: string,
  generation: number,
  reason: HistoryChunkErrorReason
): Promise<void> {
  await st.postTo(sender, {
    type: "historyChunkError",
    tabId: session.tabId,
    requestId,
    generation,
    reason,
  });
}

export async function handleHistoryMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "historyChunkRequest" | "conversationHistoryRequest" | "worklogTranscriptRequest" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "historyChunkRequest": {
      const session = target!;
      const generation = session.generation;
      const scopeKey = historyScopeKey(session);
      setLatestHistoryRequest(sender, session.tabId, msg.requestId);
      const requestStillValid = (): boolean =>
        st.sessions.get(session.tabId) === session &&
        !session.closed &&
        session.generation === generation &&
        isLatestHistoryRequest(sender, session.tabId, msg.requestId);
      if (!requestStillValid()) {
        await postHistoryChunkError(st, sender, session, msg.requestId, generation, "stale-request");
        break;
      }
      try {
        // src/history-window.ts#cursorForAnchor の終端と不正な要求を混同しない。
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
          // ターン境界では HISTORY_CHUNK_RESPONSE_BYTES に収まらない履歴も読み進められるよう、
          // ターン内で分割する（src/history-window.ts#cursorForAnchor）。
          const page = nextHistoryChunk({ scopeKey, cursor, minItems: 1 });
          const partialResponse = (drop: number, items?: NormalizedEvent[]) => {
            const first = page.items[drop];
            // 終端の判定は src/history-window.ts#cursorForAnchor に揃える。
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
            // 大きなイベントでも履歴の読み込みを継続するため、本文を切り詰める（fitEventForTransport、R-CNV-01）。
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
          await postHistoryChunkError(st, sender, session, msg.requestId, generation, "stale-request");
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
        await postHistoryChunkError(st, sender, session, msg.requestId, generation, reason);
      }
      break;
    }
    case "conversationHistoryRequest": {
      const session = target!;
      const generation = session.generation;
      const scopeKey = historyScopeKey(session);
      setLatestConversationRequest(sender, session.tabId, msg.requestId);
      const requestStillValid = (): boolean =>
        st.sessions.get(session.tabId) === session &&
        !session.closed &&
        session.generation === generation &&
        isLatestConversationRequest(sender, session.tabId, msg.requestId);
      if (!requestStillValid()) {
        await postConversationHistoryError(
          st, sender, session, msg.requestId, generation, "stale-request"
        );
        break;
      }
      try {
        if (session.conversationAnchorUuids.length === 0) {
          await postConversationHistoryError(
            st, sender, session, msg.requestId, generation, "session-unavailable"
          );
          break;
        }
        let cursor = msg.anchorUuid === undefined ? msg.cursor : undefined;
        const anchors =
          msg.anchorUuid === undefined
            ? session.conversationAnchorUuids
            : [msg.anchorUuid, ...session.conversationAnchorUuids];
        if (cursor === undefined || !hasConversationHistory(scopeKey)) {
          // ページ要求ごとの記録の再走査で拡張ホストを塞がないよう、登録済みの履歴を再利用する（hasConversationHistory）。
          const lookup: SessionFileLookup =
            session.resumeFilePath !== undefined
              ? { path: session.resumeFilePath, reason: null }
              : lookupSessionFile(session.resumeSessionId ?? session.auth?.sessionId ?? "");
          const filePath = lookup.path;
          if (filePath === null) {
            // 走査失敗を読了として扱わない（R-CNV-02、postConversationHistoryError）。
            await postConversationHistoryError(
              st, sender, session, msg.requestId, generation,
              lookup.reason === "scan_failed" ? "session-scan-failed" : "session-unavailable",
              lookup.reason === "scan_failed" ? lookup.detail : undefined
            );
            break;
          }
          // 世代境界は src/session-transcript.ts#readConversationMessages に揃える（R-CNV-01 / R-HND-09）。
          const read = await readConversationMessages(
            filePath,
            isInSessionStore,
            undefined,
            session.resumeSessionId ?? session.auth?.sessionId
          );
          if (!requestStillValid()) {
            await postConversationHistoryError(
              st, sender, session, msg.requestId, generation, "stale-request"
            );
            break;
          }
          if (read.readError) {
            await postConversationHistoryError(
              st, sender, session, msg.requestId, generation, "read-failed", read.readError
            );
            break;
          }
          registerConversationHistory(scopeKey, read.messages, currentScopeMax());
          session.conversationHistoryGaps = {
            malformedLineCount: read.malformedLineCount,
            droppedWithoutUuidCount: read.droppedWithoutUuidCount,
          };
          output.appendLine(
            `[${session.title}] 会話履歴を登録: ${read.messages.length}件 ` +
              `malformed=${read.malformedLineCount} uuid欠落=${read.droppedWithoutUuidCount}`
          );
          cursor = conversationCursorBeforeAnyUuid(scopeKey, anchors);
          if (cursor === undefined) {
            await st.postTo(sender, {
              type: "conversationHistoryResult" as const,
              tabId: session.tabId,
              requestId: msg.requestId,
              generation,
              page: {
                items: [],
                hasMore: false,
                coverage: {
                  returnedCount: 0,
                  remainingOlderCount: 0,
                  oldestReached: true,
                  ...conversationHistoryGapFields(session),
                },
              },
            });
            break;
          }
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
            items: raw.items.map((m) => clampConversationText(m, maxItems)),
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
    case "worklogTranscriptRequest": {
      const session = target!;
      const generation = session.generation;
      const scopeKey = historyTranscriptScopeKey(session);
      setLatestWorklogTranscriptRequest(sender, session.tabId, msg.requestId);
      const requestStillValid = (): boolean =>
        st.sessions.get(session.tabId) === session &&
        !session.closed &&
        session.generation === generation &&
        isLatestWorklogTranscriptRequest(sender, session.tabId, msg.requestId);
      if (!requestStillValid()) {
        await postWorklogTranscriptError(st, sender, session, msg.requestId, generation, "stale-request");
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
            // 再登録時も別の表示面が持つカーソルを保つ（verify-history-wiring#W-R49-5）。
            if (!(error instanceof HistoryWindowError) || error.reason !== "unknown-anchor") throw error;
            needsTranscriptScope = true;
          }
        }
        if (needsTranscriptScope) {
          if (msg.anchor === undefined) throw new HistoryWindowError("invalid-cursor");
          // 採番の対応は src/resume-hydration.ts#foldHistoryEvents による復元が前提（verify-history-wiring#W-R49-4）。
          if (session.workModel.coverage.source !== "provider-transcript") {
            await postWorklogTranscriptError(
              st, sender, session, msg.requestId, generation, "history-unavailable"
            );
            break;
          }
          const lookup: SessionFileLookup =
            session.resumeFilePath !== undefined
              ? { path: session.resumeFilePath, reason: null }
              : lookupSessionFile(session.resumeSessionId ?? "");
          const filePath = lookup.path;
          if (filePath === null) {
            output.appendLine(
              `[${session.title}] worklogTranscript: ${lookup.reason} session=${sessionIdForOutput(session)}` +
                (lookup.reason === "scan_failed" ? ` — ${lookup.detail}` : "")
            );
            await postWorklogTranscriptError(
              st, sender, session, msg.requestId, generation, "history-unavailable"
            );
            break;
          }
          if (!isInSessionStore(filePath)) {
            await postWorklogTranscriptError(
              st, sender, session, msg.requestId, generation, "history-unavailable"
            );
            break;
          }
          const history = await readSessionHistory(filePath, isInSessionStore);
          if (!requestStillValid()) {
            await postWorklogTranscriptError(
              st, sender, session, msg.requestId, generation, "stale-request"
            );
            break;
          }
          const historyReadError = history.readError ?? history.subagentsReadError;
          if (historyReadError !== undefined) {
            output.appendLine(`[${session.title}] 履歴transcript読み取り失敗: ${historyReadError}`);
            await postWorklogTranscriptError(
              st, sender, session, msg.requestId, generation, "host-error"
            );
            break;
          }
          const anchor = msg.anchor;
          const draft = createHydrationDraft(session);
          // 再起動後も読み手の識別子に合わせる（src/history-window.ts#cursorForAnchor）。
          draft.generation = anchor.generation;
          // 保持窓を使うと切り詰め済みの先頭が届かない（verify-history-wiring#Wmut-R49-3）。
          const scopeEvents: NormalizedEvent[] = [];
          const outcome = await foldHistoryEvents(
            draft,
            history,
            (step) => {
              const folded = step.normalizedEvent;
              if (folded === null) return "continue";
              scopeEvents.push(folded);
              return folded.seq === anchor.seq ? "stop" : "continue";
            },
            () => !requestStillValid()
          );
          if (outcome === "invalidated") {
            await postWorklogTranscriptError(st, sender, session, msg.requestId, generation, "stale-request");
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
            await postWorklogTranscriptError(
              st, sender, session, msg.requestId, generation, "history-unavailable"
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
          await postWorklogTranscriptError(st, sender, session, msg.requestId, generation, "stale-request");
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
        await postWorklogTranscriptError(st, sender, session, msg.requestId, generation, reason);
      }
      break;
    }
  }
}
