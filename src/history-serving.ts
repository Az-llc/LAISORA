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

// 過去 chunk 1回ぶんの最低件数。上限ではなく、ここから turn 境界まで古い側へ伸びる
// （history-window.ts）。webview からは受け取らない
const HISTORY_CHUNK_MIN_ITEMS = 200;
// 応答が上限を超えたときに順に試す minItems。末尾の 1 は「anchor 直前の1 turn」ちょうどで、
// turn 境界不変条件を保ったまま作れる最小の chunk（history-window.ts の snapChunkStart）。
// ここまで下げても超える場合だけが真の行き止まり＝単一イベントが上限を超えている
const HISTORY_CHUNK_MIN_ITEMS_LADDER = [HISTORY_CHUNK_MIN_ITEMS, 50, 12, 3, 1];
// postMessage 1件の上限。Agent Inspector と同じ webview・同じ経路へ載せるので同じ値を使う
const HISTORY_CHUNK_RESPONSE_BYTES = INSPECTOR_RESPONSE_BYTES;
// 会話 chunk は本文をそのまま運ぶので件数ではなくバイトで抑える。
// **40 件 × 20000 文字は byte 上限に絶対収まらない**（日本語は 1 文字 3 バイト）ので、
// 件数だけを固定すると上限超過で行き止まりになる。件数を段階的に下げて作り直す。
// 1 件でも超えるときは本文をさらに切る（会話を歯抜けにしない）
const CONVERSATION_CHUNK_ITEMS_LADDER = [40, 16, 6, 2, 1];
const CONVERSATION_CHUNK_RESPONSE_BYTES = INSPECTOR_RESPONSE_BYTES;
const CONVERSATION_TEXT_MAX = 20000;

// Inspector の inspectorRequests とは別に持つ。共有すると Inspector の新要求が
// 履歴要求を失効させる（面・タブごとに最新1本という規約は同じ）
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

// 1 chunk に載せる件数が少ないほど 1 件あたりへ割ける本文は増やせるが、上限を跨ぐと
// 検査対象が変わるので固定値で切る。**サロゲートペアを割らない**（末尾に壊れた符号単位が残る）
function clampConversationText<T extends { text: string }>(m: T, maxItems: number): T {
  const limit = maxItems <= 2 ? CONVERSATION_TEXT_MAX : Math.floor(CONVERSATION_TEXT_MAX / 4);
  if (m.text.length <= limit) return m;
  let cut = limit - 1;
  const code = m.text.charCodeAt(cut - 1);
  // 直前が上位サロゲートなら1つ手前で切る
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

// 0 件は載せない（省略 = 欠落なし）。値が付くのは登録時に読めなかった行があったときだけ
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

// 送出の全経路がここを通り、Output に reason と sessionId を 1 行残す。経路ごとに書くと
// 一過性の理由（stale-request 等）が無言のまま再試行を使い切り、画面の「止まりました」だけが
// 残って Output からは何も追えない（R-14）
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
        // minItems は Host が決める。msg から取らないこと（webview に chunk サイズを
        // 握らせない — protocol.ts の agentInspectorRequest と同じ規則）
        // cursor が undefined になるのは「anchor が最古のイベント」のときだけ。
        // どちらも無い要求をここへ落とすと、終端ページ（最古到達）と区別が付かなくなる
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
          // 上限を超えたら minItems を下げて作り直す。turn 境界不変条件が要求するのは chunk の
          // 先頭が turn_started であることだけで件数ではないので、1 まで下げても壊れない。
          // 同じ start に着地した rung は再シリアライズしない（巨大 turn で効く）
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
          // 1 turn でも上限を超える（実測: 2113 件の単一 turn）。turn 内で割り、新しい側の
          // 収まる分だけ返す。nextCursor は残した先頭イベントを anchor にした mid-turn cursor
          // で、次の要求が同じ経路で残り（古い側）を返す。webview の prepend は turn 分割を
          // 前提に stash（pastHeadline / pastPendingAnchor）を chunk 跨ぎで持つので描画は壊れない。
          // ここでエラーへ倒すと「過去の読み込みが止まりました」が再開不能の行き止まりになる
          const page = nextHistoryChunk({ scopeKey, cursor, minItems: 1 });
          const partialResponse = (drop: number, items?: NormalizedEvent[]) => {
            const first = page.items[drop];
            // 残した先頭が窓の最古（index 0）なら cursor は無く、そこが終端。
            // hasMore を true で固定すると nextCursor 無しの hasMore が出て、webview の
            // 裏読みが「続きがあるのに cursor が無い」で止まる（drop=0 でだけ起きる）
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
          // 落とす件数は単調（多く落とすほど小さい）なので最小の drop を二分探索する
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
            // 単一イベントだけで予算を超える（実測: 313KB の user_message）。ここでエラーへ倒すと
            // 「過去の読み込みが止まりました」が再開不能になり、全件を裏で読み終える契約
            // （R-CNV-01）が満たせない。本文を切って必ず送る。予算は関門ではない
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
        // ここへ来る undefined は実装バグ。上の 2 経路が必ず組み立てる（catch が host-error へ倒す）
        if (chunkResponse === undefined) throw new Error("history chunk response not built");
        if (!requestStillValid()) {
          await postHistoryChunkError(st, sender, session, msg.requestId, generation, "stale-request");
          break;
        }
        await st.postTo(sender, chunkResponse);
      } catch (error) {
        // HistoryWindowError 以外は実装バグ。history-unavailable へ倒すと webview 側の
        // 「正常な縮退」に化けて沈黙する（host-error は診断へ回る reason）
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
        // 遡りの対象は resume したタブだけ。live の会話ブロックは uuid を持たないので
        // 重複を判定できず、prepend すると画面に同じ発言が二度出る
        if (session.conversationAnchorUuids.length === 0) {
          await postConversationHistoryError(
            st, sender, session, msg.requestId, generation, "session-unavailable"
          );
          break;
        }
        // anchorUuid が載っていれば cursor より優先する。cursor が Host 側の退避で
        // 無効になった後の取り直しがこれで、無いと起点が黙って先頭へ巻き戻る
        let cursor = msg.anchorUuid === undefined ? msg.cursor : undefined;
        const anchors =
          msg.anchorUuid === undefined
            ? session.conversationAnchorUuids
            : [msg.anchorUuid, ...session.conversationAnchorUuids];
        if (cursor === undefined || !hasConversationHistory(scopeKey)) {
          // 起点から取り直す要求（初回・cursor 喪失後の再開）と、LRU 退避で登録が
          // 消えた場合。ここでだけ transcript を読む。**cursor を持つ通常のページングでは
          // 読まない**（要求のたびに読み直すと 14MB 級で Extension Host が止まる — P2）
          const lookup: SessionFileLookup =
            session.resumeFilePath !== undefined
              ? { path: session.resumeFilePath, reason: null }
              : lookupSessionFile(session.resumeSessionId ?? session.auth?.sessionId ?? "");
          const filePath = lookup.path;
          if (filePath === null) {
            // 走査に失敗しただけのときに終端の理由を返さない。返すと webview が
            // 「読み終わった」として進行表示を消す（R-17）
            await postConversationHistoryError(
              st, sender, session, msg.requestId, generation,
              lookup.reason === "scan_failed" ? "session-scan-failed" : "session-unavailable",
              lookup.reason === "scan_failed" ? lookup.detail : undefined
            );
            break;
          }
          const read = await readConversationMessages(filePath, isInSessionStore);
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
          // 画面に出ている最古のメッセージより前から始める（uuid で照合する）
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
          // 同じ位置に着地した段は作り直さない（終端付近で効く）
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
        // ConversationHistoryError 以外は実装バグ。history-unavailable へ倒すと
        // webview 側の「正常な縮退」に化けて沈黙する
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
            // transcript scope は最初に要求された anchor までの prefix だけを持つ。別 surface の
            // restore が後で新しい anchor を積んだ場合は同じ JSONL から prefix を伸ばす。
            // 既発行 cursor は登録後も識別子で解決できるため、scope を明示解放しない。
            if (!(error instanceof HistoryWindowError) || error.reason !== "unknown-anchor") throw error;
            needsTranscriptScope = true;
          }
        }
        if (needsTranscriptScope) {
          // スコープは anchor 要求でだけ組む。cursor だけの要求で登録が無い（LRU 退避後）のは
          // cursor 失効で、webview が anchor から取り直す
          if (msg.anchor === undefined) throw new HistoryWindowError("invalid-cursor");
          // transcript の fold は seq を 1 から振り直す。Host の EventLog と同じ番号になるのは
          // hydration（runResumeHydration）で同じ JSONL を同じ fold で読んだタブだけで、
          // live で作ったタブは同じ generation:seq が別のイベントを指す（無言でずれる）
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
          // hydration 後に generation が進んでいても（CLI 再起動）、webview が持つ識別子は
          // hydration 時点の generation。その番号で組まないと anchor が見つからない
          draft.generation = anchor.generation;
          // draft.events は foldEventState が EVENT_LOG_MAX で先頭から切る。ここで欲しいのは
          // その切られた先頭なので、fold の戻り値を別に溜める（draft.events を使うと Host が
          // 保持していない分は二度と届かない）。anchor まで読めば十分で、以降は fold しない
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
