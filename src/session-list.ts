// 履歴パネルのセッション一覧を組み立てる純関数。I/O と SDK 呼び出しは extension.ts 側。
import * as l10n from "@vscode/l10n";
import type { SessionListItem, SessionScanDegradation } from "./protocol";
import { formatSessionTitleForDisplay, normalizeTitleValue } from "./session-display-title";

export const SESSION_LIST_LIMIT = 40;
export const SESSION_TITLE_MAX = 60;
// 1 バッチの並列解決数。libuv の FS スレッド既定値は 4 で、それを超えて投げても並列度は
// 上がらず待ち行列が伸びるだけになる（バッチ内で最初に確定する 1 件の時刻だけが遅れる）。
export const SESSION_RESOLVE_BATCH = 4;
// 最初のバッチだけ 1 件にする。ここを SESSION_RESOLVE_BATCH と同じにすると、初回配信が
// その件数の解決を待ち、逐次配信でも初行が一覧完了とほぼ同時に着く（利用者には一括表示に見える）。
export const SESSION_RESOLVE_FIRST_BATCH = 1;

// 先頭だけ 1 件、以降は SESSION_RESOLVE_BATCH。index はバッチ先頭の候補位置。
function resolveStepAt(index: number): number {
  return index === 0 ? SESSION_RESOLVE_FIRST_BATCH : SESSION_RESOLVE_BATCH;
}

// SDK の SDKSessionInfo が構造的に満たす最小面。SDK 型に直接依存しないのは、この純関数を
// vscode / SDK 抜きで検査できるようにするため。
export interface SessionSummarySource {
  sessionId: string;
  summary: string;
  cwd?: string;
  lastModified: number;
}

// 逐次解決の候補 1 件。mtime は自前 stat の値で、SDK も同じ扱いをする
// （sdk.mjs Y4 は解決結果の lastModified を候補の stat mtime で上書きする）。
export interface SessionCandidate {
  sessionId: string;
  filePath: string;
  mtime: number;
}

// 候補を SDK の一覧と同じ順序へ並べる。同一 sessionId が複数のプロジェクトディレクトリに
// 現れる（worktree・relocated）ため、mtime 最大の 1 件へ畳む。SDK 側は listSessions が
// 畳んでから toSessionListItems へ渡すので、自前走査で畳まないと
// 同じセッションが二重行になる（sdk.mjs aHe / iHe の重複排除に対応する）。
// 並び順（mtime 降順・同値なら sessionId 降順）は sdk.mjs sHe と同一。
export function rankSessionCandidates(
  entries: readonly SessionCandidate[]
): SessionCandidate[] {
  const byId = new Map<string, SessionCandidate>();
  for (const e of entries) {
    const prev = byId.get(e.sessionId);
    if (prev === undefined || e.mtime > prev.mtime) byId.set(e.sessionId, e);
  }
  return [...byId.values()].sort((a, b) =>
    b.mtime !== a.mtime ? b.mtime - a.mtime : b.sessionId < a.sessionId ? -1 : b.sessionId > a.sessionId ? 1 : 0
  );
}

// 行の filePath は畳んだ後の候補（stat 成功・mtime 最大）から引く。走査中に見た順で
// 上書きした索引を使うと、同じ sessionId が複数プロジェクトにあるとき行が最新でない側や
// stat に失敗した側のパスを掴み、再開と分析がそこで失敗する（SL-40 / SL-41）
export function candidatePathIndex(candidates: readonly SessionCandidate[]): Map<string, string> {
  return new Map(candidates.map((c) => [c.sessionId, c.filePath]));
}

export function untitledLabel(sessionId: string): string {
  return l10n.t("(Untitled: {0})", sessionId.slice(0, 8));
}

// タブ名と履歴一覧の行タイトルが通る唯一の経路。両者を別々に組み立てると、同じセッションが
// 別名で出る（R-SES-05）。maxLength は表示場所ごとの幅であって、名前そのものではない。
export function displayTitleFromSummary(
  summary: string,
  sessionId: string,
  maxLength?: number
): string {
  const normalized = normalizeTitleValue(summary);
  // 空判定は切り詰めの前に行う（切り詰め後は「…」が付いて空にならない）
  if (normalized === null) return untitledLabel(sessionId);
  // 切り詰め長はタブと履歴一覧で同一。別々の値にすると同じセッションが別名で出る（R-SES-05）
  return formatSessionTitleForDisplay(normalized, maxLength ?? SESSION_TITLE_MAX);
}

// 候補をバッチで解決し、確定した行から emit する。I/O は resolve に閉じ込めてあるので
// ここは順序・打ち切り・完了判定だけを持つ。
//
// 解決できなかった候補は行の枠を消費させない（SDK の listSessions と同じ — sdk.mjs iHe の
// `if(!h) continue`）。上位 SESSION_LIST_LIMIT 件で候補を打ち切ると、要約を持たない候補や
// UUID でないファイル名の分だけ行が減る（実測: 上位 40 候補中 2 件が該当）。
//
// emit(_, true) はちょうど 1 回で、それが最後の emit。complete を受け取るまで受信側は
// 件数を確定できない（部分応答を 0 件の根拠にしない）。候補が 0 件でも空の完了を必ず出す。
export async function streamSessionRows(
  candidates: readonly SessionCandidate[],
  pathBySessionId: ReadonlyMap<string, string>,
  resolve: (candidate: SessionCandidate) => Promise<SessionSummarySource | undefined>,
  emit: (rows: SessionListItem[], complete: boolean) => void
): Promise<{ sent: number; scanned: number; nextIndex?: number }> {
  let sent = 0;
  let scanned = 0;
  for (let i = 0; i < candidates.length && sent < SESSION_LIST_LIMIT; ) {
    const batch = candidates.slice(i, i + Math.min(resolveStepAt(i), SESSION_LIST_LIMIT - sent));
    // 打ち切り判定の基準はバッチ幅ではなく実際に進む位置。バッチ幅が可変なので
    // i + SESSION_RESOLVE_BATCH で数えると complete が 1 バッチ早く/遅く立つ
    const nextIndex = i + batch.length;
    const infos = await Promise.all(batch.map(resolve));
    scanned += batch.length;
    const resolved: SessionSummarySource[] = [];
    for (let k = 0; k < batch.length && sent + resolved.length < SESSION_LIST_LIMIT; k++) {
      const info = infos[k];
      if (info === undefined) continue;
      // 並び順の基準を候補側の mtime に揃える（SDK も同じ上書きをする — sdk.mjs Y4）
      resolved.push({ ...info, lastModified: batch[k].mtime });
    }
    const rows = toSessionListItems(resolved, pathBySessionId);
    sent += rows.length;
    const complete = sent >= SESSION_LIST_LIMIT || nextIndex >= candidates.length;
    i = nextIndex;
    if (rows.length === 0 && !complete) continue;
    emit(rows, complete);
    if (complete) return { sent, scanned, nextIndex: nextIndex < candidates.length ? nextIndex : undefined };
  }
  emit([], true);
  return { sent, scanned };
}

// SDKSessionInfo は filePath を持たない。resumeSession は filePath を要求するので、
// 対応するファイルが見つからない sessionId は一覧へ出さない（推測でパスを組み立てない。
// エンコード済みディレクトリ名からの逆変換は一意でなく、別プロジェクトのセッションを掴む）。
export function toSessionListItems(
  infos: readonly SessionSummarySource[],
  pathBySessionId: ReadonlyMap<string, string>
): SessionListItem[] {
  const items: SessionListItem[] = [];
  for (const info of infos) {
    const filePath = pathBySessionId.get(info.sessionId);
    if (filePath === undefined) continue;
    items.push({
      sessionId: info.sessionId,
      filePath,
      title: displayTitleFromSummary(info.summary, info.sessionId),
      cwd: info.cwd ?? "",
      mtime: info.lastModified,
    });
  }
  return items;
}

// 欠落があるときだけ注記を返す。健全なら undefined。
// 画面の文言をここに置くのは、host も webview も同じ文字列を通すため（R-DSP-03。
// 「不完全な値は値 + 注記で出す」の注記側の実体）。
// 「見つかりません」のような否定の断言をここから返さないこと。読めなかったことと
// 存在しないことは別で、この関数が知っているのは前者だけ
export function sessionScanNote(d: SessionScanDegradation | undefined): string | undefined {
  if (d === undefined) return undefined;
  if (d.rootFailed) {
    return l10n.t(
      "Could not read the history storage. 0 items does not mean there are no sessions. Check sync and permissions, then reopen the history."
    );
  }
  const parts: string[] = [];
  if (d.unreadableProjects > 0) parts.push(l10n.t("{0} projects", d.unreadableProjects));
  if (d.statFailed > 0) parts.push(l10n.t("{0} files", d.statFailed));
  if (d.resolveFailed > 0) parts.push(l10n.t("{0} summaries", d.resolveFailed));
  // 候補ゼロ解決を「他に欠落が無いとき」限定にしない。限定すると、プロジェクトも
  // 読めないときにこの情報だけが消えて、どの扉から欠けたかが判別できなくなる
  if (d.unresolvedCandidates > 0) parts.push(l10n.t("{0} candidates (summary unavailable, so they cannot be listed)", d.unresolvedCandidates));
  if (parts.length === 0) return undefined;
  return l10n.t(
    "Could not read {0}. The list is missing these entries. Check sync and permissions, then reopen the history.",
    parts.join(l10n.t(", "))
  );
}
