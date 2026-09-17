import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

import { claudeProjectsDir } from "./claude-env";
import { getLaisoraConfiguration } from "./claude-settings";
import type { Session } from "./extension";
import { extensionContext, output, sinceActivation, store } from "./host-context";
import {
  SESSION_ID_RE,
  type ImageAttachment,
  type SessionListItem,
  type SessionScanDegradation,
  type WebviewToHost,
} from "./protocol";
import {
  appendSessionRecord,
  errText,
  readCachedUsage,
  resolveSessionImage,
  sessionTranscriptRef,
} from "./session-files";
import { formatCustomTitleRecord, normalizeTitleValue } from "./session-display-title";
import type { SessionCandidate } from "./session-list";
import { candidatePathIndex, displayTitleFromSummary, rankSessionCandidates, streamSessionRows } from "./session-list";
import type { SessionStore } from "./store-surfaces";

const USED_SESSIONS_KEY = "history.laisoraSessions";
let usedSessions: Record<string, string> | undefined;
function usedSessionPaths(): Record<string, string> {
  return usedSessions ??= extensionContext?.globalState.get<Record<string, string>>(USED_SESSIONS_KEY, {}) ?? {};
}
export function rememberSession(session: Session): void {
  const id = session.resumeSessionId ?? session.auth?.sessionId;
  if (!id) return;
  if (!usedSessionPaths()[id]) {
    const ref = sessionTranscriptRef(session);
    if (ref) {
      usedSessionPaths()[ref.sessionId] = ref.file;
      void extensionContext?.globalState.update(USED_SESSIONS_KEY, { ...usedSessionPaths() }).then(undefined,
        error => output.appendLine(`[history] Could not save LAISORA session index: ${String(error)}`));
    }
  }
  // 呼び出し元はセッション id が確定・変化した点（初回ターン完了・resume・ハンドオフ）と一致する
  void persistOpenTabs();
}

// ---------- 起動時のタブ復元（laisora.restoreTabsOnStartup） ----------

const OPEN_TABS_KEY = "history.laisoraOpenTabs";

export interface PersistedOpenTab {
  sessionId: string;
  filePath?: string;
  cwd: string;
  title?: string;
  order: number;
}

// 消費点で毎回読む（tabLimit と同じ理由）。偽 vscode のハーネスは供給しないキーで throw する
export function restoreTabsOnStartupEnabled(): boolean {
  try {
    return getLaisoraConfiguration().get<boolean>("restoreTabsOnStartup", true) !== false;
  } catch {
    return true;
  }
}

function openTabEntries(): PersistedOpenTab[] {
  const entries: PersistedOpenTab[] = [];
  const seen = new Set<string>();
  for (const s of store?.sessions.values() ?? []) {
    if (s.closed) continue;
    // セッション id を持たないタブ（一度も送信していない）は復元するものが無いので載せない
    const sessionId = s.resumeSessionId ?? s.auth?.sessionId;
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const filePath = s.resumeSessionId && s.resumeFilePath ? s.resumeFilePath : usedSessionPaths()[sessionId];
    entries.push({
      sessionId,
      ...(filePath ? { filePath } : {}),
      cwd: s.cwd,
      title: s.title,
      order: entries.length,
    });
  }
  return entries;
}

// 一覧は workspaceState に置く。globalState は全ウィンドウで共有され、別ウィンドウの一覧で上書きされる。
// ?. は偽 vscode のハーネスが workspaceState を供給しないため
function openTabsMemento(): vscode.Memento | undefined {
  return extensionContext?.workspaceState;
}

let lastPersistedOpenTabs: string | undefined;
function openTabsPersistFailed(error: unknown): void {
  lastPersistedOpenTabs = undefined;
  output.appendLine(`[history] Could not save the open tab list: ${String(error)}`);
}

// 同期に投げない。呼び出し元（closeTab / clearTab / rememberSession）は `void` で呼んだ後に
// タブの閉鎖・初期化の続きを実行するので、ここで投げるとその操作が途中で止まる（R-SES-01）
export function persistOpenTabs(): Promise<void> {
  try {
    const entries = openTabEntries();
    const serialized = JSON.stringify(entries);
    if (serialized === lastPersistedOpenTabs) return Promise.resolve();
    const update = openTabsMemento()?.update(OPEN_TABS_KEY, entries);
    if (!update) return Promise.resolve();
    lastPersistedOpenTabs = serialized;
    return Promise.resolve(update).then(undefined, openTabsPersistFailed);
  } catch (error) {
    openTabsPersistFailed(error);
    return Promise.resolve();
  }
}

export function readPersistedOpenTabs(): PersistedOpenTab[] {
  const raw = openTabsMemento()?.get<unknown>(OPEN_TABS_KEY);
  if (!Array.isArray(raw)) return [];
  const entries: PersistedOpenTab[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    // ファイル名へ連結する前に絞る（契約 session-tabs）
    if (typeof r.sessionId !== "string" || !SESSION_ID_RE.test(r.sessionId) || seen.has(r.sessionId)) continue;
    seen.add(r.sessionId);
    entries.push({
      sessionId: r.sessionId,
      ...(typeof r.filePath === "string" ? { filePath: r.filePath } : {}),
      cwd: typeof r.cwd === "string" ? r.cwd : "",
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : entries.length,
    });
  }
  return entries.sort((a, b) => a.order - b.order);
}
type HistorySource = "laisora" | "claude";
const historyPages = new Map<HistorySource, { token: number; candidates: SessionCandidate[] }>();

const originCache = new Map<string, "claude" | "unknown">();
async function historicalOrigin(file: string): Promise<"claude" | "unknown"> {
  const cached = originCache.get(file);
  if (cached) return cached;
  // Read metadata only. A truncated or absent origin is unknown, never proof of ownership.
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return "unknown";
  let origin: "claude" | "unknown" = "unknown";
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.type !== "user" && record.type !== "assistant") continue;
        if (typeof record.entrypoint !== "string") continue;
        origin = record.entrypoint === "cli" || record.entrypoint === "claude-vscode" ? "claude" : "unknown";
        break;
      } catch { /* incomplete metadata stays unclassified */ }
    }
    originCache.set(file, origin);
  } catch { return "unknown"; } finally { await handle.close(); }
  return origin;
}

// ---------- resume: Claude Code セッションストア（~/.claude/projects）の列挙・読取 ----------

// セッション一覧（全プロジェクト横断・mtime降順）。タイトル・cwd・mtime の解決は SDK の
// listSessions に委ねる（公式 /resume ピッカーと同じ解決器: customTitle > aiTitle >
// 最後の発言 > 最初の発言。head/tail 各 64KB + sidecar custom-title.json を読む）。
// includeProgrammatic を false にしないこと。SDK 経由で動く LAISORA 自身のセッションが
// 落ち、実測で 40 件中 38 件が一覧から消える。
// SDKSessionInfo は filePath を持たないので、sessionId → パスの対応だけ readdir で作る
// （ファイル本体は読まない）。組み立ては session-list.ts の純関数。
// SDK は dist へ束ねてあるが、esbuild は ESM 依存の評価を最初の require まで遅延させる
// （dist/extension.js の init_sdk）。この評価は同期で、初回だけ二桁〜三桁 ms かかる。
// この費用は webview の ready ハンドラが払い終えている: warmup → ClaudeHost.start() の
// 第一文が同じ require を同期で通す（claudeHost.ts の start）。listSessions を出すのは
// webview の openHistPanel だけで、その postMessage は同じ経路の ready より後にしか
// 起きないため、履歴一覧の解決がこの評価を背負うことはない。
// ここへ先払いを足さないこと: 評価は既に済んでいるので、残る仕事は存在しない UUID の getSessionInfo だけになり、
// 冷間で readdir と多数の stat が走って利用者の履歴要求と競合する
let sessionSdk: Pick<typeof ClaudeCodeSdk, "getSessionInfo"> | undefined;
function sessionInfoSdk(): Pick<typeof ClaudeCodeSdk, "getSessionInfo"> {
  if (sessionSdk === undefined) {
    sessionSdk = require("@anthropic-ai/claude-agent-sdk") as Pick<typeof ClaudeCodeSdk, "getSessionInfo">;
  }
  return sessionSdk;
}

// 単一セッションの summary を SDK から引く。一覧（listSessions）と同じ解決器なので、
// 一覧とタブ名が食い違わない。自前で custom-title を読みに行くと解決器の写しになり腐る。
// 先頭行の取り出し・空判定・切り詰めをここでやらないこと。displayTitleFromSummary と
// 二重の正規化になり、先頭行が空の summary で一覧（無題）とタブ（据え置き）が割れる（R-SES-05）
// 公式の単体解決器を叩く唯一の場所。タブ名（sessionSummaryOf 経由）と履歴一覧が同じ
// 呼び出しを通るので、両者が食い違わない（R-SES-05）。
// dir は渡さない。SDK の dir は「実 cwd」で、これを SDK 側が Jf() で符号化して
// ~/.claude/projects/<符号化名> を組み立てる（sdk.mjs er / Ci）。こちらが readdir で
// 知っているのは符号化後のディレクトリ名で、Jf は非可逆（[^a-zA-Z0-9]→'-'・200 字超は
// 切り詰め＋ハッシュ）なため cwd は復元できない。逆変換は禁止（別プロジェクトの
// セッションを掴む — session-list.ts の toSessionListItems 参照）
// onError は「例外で解決できなかった」と「要約を持たないので読み飛ばす」を呼び出し側で
// 区別するためにある。区別しないと、解決が全滅した一覧が 0 件として complete し、
// 画面が「セッションが見つかりません」と断言する（R-21）
async function sessionInfoOf(
  sessionId: string,
  onError?: (err: unknown) => void
): Promise<ClaudeCodeSdk.SDKSessionInfo | undefined> {
  try {
    const sdk = sessionInfoSdk();
    return await sdk.getSessionInfo(sessionId);
  } catch (err) {
    onError?.(err);
    return undefined;
  }
}

export async function sessionSummaryOf(sessionId: string): Promise<string | undefined> {
  const info = await sessionInfoOf(sessionId);
  return typeof info?.summary === "string" ? info.summary : undefined;
}

// タブ名を履歴一覧と同じ値へ付け直す。autoTitled は読まない（読むと初回発言の名前で
// 固定され、履歴一覧の summary が動いた分だけ食い違う — R-SES-05）
export async function refreshTabTitle(session: Session): Promise<void> {
  // SDK が system/init の session_id として報告した「今書いているセッション」の id だけを使う。
  // expectedConversationId は claudeHost が自前で振る randomUUID で SDK へ渡らないため、
  // getSessionInfo が必ず空を返す（このタブ名は二度と変わらなくなる）
  const sessionId = session.auth?.sessionId;
  const generation = session.logicalGeneration;
  try {
    if (!sessionId) return;
    rememberSession(session);
    const summary = await sessionSummaryOf(sessionId);
    // 解決できないときは既存のタブ名を保ち、印も立てない。次のターンで再試行する（R-SES-05）
    if (summary === undefined) return;
    // await をまたぐ間に /clear や resume で別セッションになったタブへ名前を入れない
    if (session.logicalGeneration !== generation || session.closed) return;
    session.titleRefreshed = true;
    const title = displayTitleFromSummary(summary, sessionId);
    if (title === session.title) return;
    session.title = title;
    store?.post({ type: "tabRenamed", tabId: session.tabId, title });
  } finally {
    // 世代が変わっていたら resetLogicalSession が既に降ろしている。降ろし直すと
    // 新世代の起動中フラグを消して二重起動を許す
    if (session.logicalGeneration === generation) session.titleRefreshing = false;
  }
}

// セッション一覧（全プロジェクト横断・mtime 降順）を、確定した行から逐次 emit する。
// sdk.listSessions を await すると、全件を解決し終えるまで冷間で 8〜12 秒何も出ない。
// 走査は自前の readdir+stat（本文は読まない）で、タイトル・cwd の解決だけを
// 公式の単体解決器へ委ねる。解決器が同じなので一覧とタブ名は一致する（R-SES-05）。
//
// 候補は SESSION_LIST_LIMIT より深く取り、解決できない候補は行の枠を消費させずに読み飛ばす。
// SDK の listSessions も同じことをしている（sdk.mjs iHe: `if(!h) continue` で limit 件
// 埋まるまで候補を進める）。上位 40 件で打ち切ると、要約を持たない候補や UUID でない
// ファイル名の分だけ行が減る。
let sessionListRequestSeq = 0;

async function listPastSessions(
  requestId: number,
  emit: (sessions: SessionListItem[], complete: boolean, degraded?: SessionScanDegradation, nextCursor?: string) => void,
  options: { source?: HistorySource; cursor?: string } = {}
): Promise<void> {
  const listStartT = Date.now();
  const root = claudeProjectsDir();
  const entries: SessionCandidate[] = [];
  for (const session of store?.sessions.values() ?? []) rememberSession(session);
  const known = usedSessionPaths();
  const source = options.source ?? "claude";
  const savedPage = historyPages.get(source);
  const cursorParts = options.cursor?.split(":").map(Number);
  const continuation = cursorParts && savedPage?.token === cursorParts[0] ? savedPage : undefined;
  const offset = continuation ? cursorParts![1] : 0;

  // 読めなかったものを種類別に数える。ここを数えないと、走査が失敗しても complete=true・
  // 0 件で返り、画面が「セッションが見つかりません」と断言する（R-21。Google Drive 同期下で
  // 現実に起こる）。emit へ渡すこと自体を消すと検査 W-F0-DEG が落ちる
  const degradation: SessionScanDegradation = {
    rootFailed: false,
    unreadableProjects: 0,
    statFailed: 0,
    resolveFailed: 0,
    unresolvedCandidates: 0,
  };
  const degraded = (): SessionScanDegradation | undefined =>
    degradation.rootFailed ||
    degradation.unreadableProjects > 0 ||
    degradation.statFailed > 0 ||
    degradation.resolveFailed > 0 ||
    degradation.unresolvedCandidates > 0
      ? { ...degradation }
      : undefined;
  try {
    // withFileTypes でディレクトリだけに絞る。保存先直下に同期のロックファイル等があると
    // readdir が ENOTDIR で落ち、健全なのに「1 個のプロジェクトを読めません」を出し続ける
    // （警告が常時点灯すると誰も読まなくなる）
    if (continuation) {
      entries.push(...continuation.candidates);
    } else for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = entry.name;
      try {
        for (const f of readdirSync(join(root, dir))) {
          if (!f.endsWith(".jsonl")) continue;
          const sessionId = f.slice(0, -".jsonl".length);
          const filePath = join(root, dir, f);
          try {
            entries.push({ sessionId, filePath, mtime: statSync(filePath).mtimeMs });
          } catch {
            degradation.statFailed++;
          }
        }
      } catch (err) {
        degradation.unreadableProjects++;
        output.appendLine(`[history] プロジェクトを読めません: ${dir} — ${errText(err)}`);
      }
    }
  } catch (err) {
    // ENOENT は「まだ 1 件も会話していない」＝本当に 0 件。障害として警告すると、
    // 新規導入の利用者に常時「保存先を読めません」を出すことになる
    if ((err as { code?: unknown }).code !== "ENOENT") {
      degradation.rootFailed = true;
      output.appendLine(`[history] 保存先を読めません: ${root} — ${errText(err)}`);
    }
    emit([], true, degraded());
    return;
  }
  if (degradation.statFailed > 0) {
    output.appendLine(`[history] stat できないファイル ${degradation.statFailed} 件（候補から除外・req ${requestId}）`);
  }
  // Older releases did not record ownership. Unknown SDK histories remain accessible,
  // explicitly marked, rather than being relabelled as official Claude Code sessions.
  if (!continuation && options.source) {
    for (let i = 0; i < entries.length; i += 4) {
      await Promise.all(entries.slice(i, i + 4).map(async c => {
        if (!known[c.sessionId]) await historicalOrigin(c.filePath);
      }));
    }
  }
  const candidates = continuation ? entries : rankSessionCandidates(entries).filter(c =>
    !options.source || (source === "laisora"
      ? !!known[c.sessionId] || originCache.get(c.filePath) !== "claude"
      : !known[c.sessionId] && originCache.get(c.filePath) === "claude"));
  const token = continuation?.token ?? requestId;
  if (!continuation) historyPages.set(source, {token, candidates});
  const pathBySessionId = candidatePathIndex(candidates);
  const scanDoneT = Date.now();
  output.appendLine(
    `[history] ${sinceActivation()} 候補 ${candidates.length} 件（走査 ${scanDoneT - listStartT}ms・req ${requestId}）`
  );

  let firstRowT = 0;
  let resolveStarts = 0;
  // この要求で最初に始めた 1 件の所要。SESSION_RESOLVE_FIRST_BATCH = 1 なので単独計測になる。
  // プロセス全体の一度きりの費用ではない（要求ごとに毎回出る）。SDK のモジュール評価は
  // ready ハンドラの warmup が払い終えており、評価後の getSessionInfo に一度きりの費用は
  // 無い（実測: 初回 5ms・同 id 1ms・別 id 2ms）。三桁〜四桁 ms が出たら、
  // それはこの 1 件の I/O か同時実行との競合
  let firstResolveMs = -1;
  let rowsSent = 0;
  const { sent, scanned, nextIndex } = await streamSessionRows(
    candidates.slice(offset),
    pathBySessionId,
    async (c) => {
      const first = ++resolveStarts === 1;
      const t = first ? Date.now() : 0;
      const info = await sessionInfoOf(c.sessionId, (err) => {
        degradation.resolveFailed++;
        if (degradation.resolveFailed === 1) {
          output.appendLine(`[history] 要約を解決できません: ${c.sessionId} — ${errText(err)}`);
        }
      });
      if (first) firstResolveMs = Date.now() - t;
      return info && typeof info.summary === "string" ? info : undefined;
    },
    (sessions: SessionListItem[], complete: boolean) => {
      rowsSent += sessions.length;
      // 最後の emit の直前に判定する。候補はあったのに 1 行も出せなかったのなら、
      // それは「無い」ではなく「出せなかった」。getSessionInfo は壊れた記録に対して
      // 例外を投げずに undefined を返すことがあり、resolveFailed だけでは捕まらない
      if (complete && rowsSent === 0 && candidates.length > 0) {
        degradation.unresolvedCandidates = candidates.length;
        output.appendLine(
          `[history] 候補 ${candidates.length} 件から 1 行も解決できません（req ${requestId}）`
        );
      }
      if (firstRowT === 0 && sessions.length > 0) {
        firstRowT = Date.now();
        output.appendLine(
          `[history] ${sinceActivation()} 初行到達 ${firstRowT - listStartT}ms` +
            `（解決 ${resolveStarts}件・先頭解決 ${firstResolveMs}ms・req ${requestId}）`
        );
      }
      if (source === "laisora") for (const row of sessions) {
        if (!known[row.sessionId]) row.originUnverified = true;
      }
      emit(sessions, false, degraded());
    }
  );
  emit([], true, degraded(), nextIndex === undefined ? undefined : `${token}:${offset + nextIndex}`);
  output.appendLine(
    `[history] ${sinceActivation()} 一覧完了 ${Date.now() - listStartT}ms（${sent}行 / 候補 ${scanned}件解決 / 走査 ${scanDoneT - listStartT}ms・req ${requestId}）`
  );
}

export async function handleSessionFileMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "renameTab" | "listSessions" | "requestCachedUsage" | "sessionImageRequest" | "openSessionImage" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "renameTab": {
      // /rename を SDK へ素通しすると custom-title が JSONL に書かれず、タブ名にも履歴一覧にも反映されない。
      // Host が CLI と同じレコードを書き、タブ名は履歴一覧と同じ解決器（displayTitleFromSummary）を通す（R-SES-05）
      const s = target!;
      const ref = sessionTranscriptRef(s);
      if (ref === null) {
        s.pushEvent({
          kind: "error",
          message: l10n.t("/rename can be used once the session file is determined (try again after the first response)."),
          fatal: false,
        });
        break;
      }
      const title = normalizeTitleValue(msg.title);
      if (title === null) {
        s.pushEvent({ kind: "error", message: l10n.t("Usage: /rename <new name>"), fatal: false });
        break;
      }
      const generation = s.logicalGeneration;
      try {
        await appendSessionRecord(ref.file, formatCustomTitleRecord(ref.sessionId, title));
      } catch (error) {
        s.pushEvent({
          kind: "error",
          message: l10n.t("/rename: Could not write to the session file ({0})", String(error)),
          fatal: false,
        });
        break;
      }
      // 書き込み待ちの間に /clear や resume で別セッションになったタブへ名前を入れない
      if (s.closed || s.logicalGeneration !== generation) break;
      s.title = displayTitleFromSummary(title, ref.sessionId);
      s.autoTitled = true;
      st.post({ type: "tabRenamed", tabId: s.tabId, title: s.title });
      break;
    }
    case "listSessions": {
      const requestId = ++sessionListRequestSeq;
      await listPastSessions(
        requestId,
        (sessions: SessionListItem[], complete: boolean, degraded?: SessionScanDegradation, nextCursor?: string) => {
          // パネルを開き直すと新しい実行が始まる。古い実行の行は送らない
          if (requestId !== sessionListRequestSeq) return;
          st.post({ type: "sessions", requestId, sessions, complete, degraded, source: msg.source, nextCursor, append: msg.cursor !== undefined });
        },
        {source: msg.source, cursor: msg.cursor}
      );
      break;
    }
    case "requestCachedUsage": {
      // 実測: CLI は利用率を実APIコールを伴うターンでしか送ってこないため、
      // 起動直後は LAISORA 側に何も無い。CLI 自身が ~/.claude.json の
      // cachedUsageUtilization に最後の取得結果を残しているので、それを初期表示に使う。
      const cached = readCachedUsage();
      if (cached) st.post({ type: "cachedUsage", ...cached });
      break;
    }
    case "sessionImageRequest": {
      const session = target!;
      const res = await resolveSessionImage(session, msg.ref);
      if ("error" in res) {
        await st.postTo(sender, {
          type: "sessionImageError",
          tabId: session.tabId,
          requestId: msg.requestId,
          reason: res.error,
        });
      } else {
        await st.postTo(sender, {
          type: "sessionImageResult",
          tabId: session.tabId,
          requestId: msg.requestId,
          mediaType: res.mediaType,
          data: res.data,
        });
      }
      break;
    }
    case "openSessionImage": {
      const session = target;
      if (!session || !extensionContext) {
        void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
        break;
      }
      try {
        let imageBytes: { mediaType: ImageAttachment["mediaType"]; data: string } | undefined;
        let fileKey = "";
        if (msg.ref) {
          const res = await resolveSessionImage(session, msg.ref);
          if ("error" in res) {
            void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
            break;
          }
          imageBytes = res;
          const refPart =
            msg.ref.kind === "record" ? msg.ref.uuid : `${msg.ref.generation}-${msg.ref.seq}`;
          fileKey = `${session.tabId}-${refPart}-${msg.ref.index}`;
        } else if (msg.inline) {
          imageBytes = msg.inline;
          fileKey = `${session.tabId}-inline-${Date.now()}`;
        }
        if (!imageBytes) {
          void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
          break;
        }
        const extMap: Record<ImageAttachment["mediaType"], string> = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
        };
        const ext = extMap[imageBytes.mediaType] || "png";
        const imagesDir = vscode.Uri.joinPath(extensionContext.globalStorageUri, "images");
        await vscode.workspace.fs.createDirectory(imagesDir);
        const fileUri = vscode.Uri.joinPath(imagesDir, `${fileKey}.${ext}`);
        const buffer = Buffer.from(imageBytes.data, "base64");
        await vscode.workspace.fs.writeFile(fileUri, buffer);
        await vscode.commands.executeCommand("vscode.open", fileUri);
      } catch {
        void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not open the image."));
      }
      break;
    }
  }
}
