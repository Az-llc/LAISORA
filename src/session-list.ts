import * as l10n from "@vscode/l10n";
import type { SessionListItem, SessionScanDegradation } from "./protocol";
import { formatSessionTitleForDisplay, normalizeTitleValue } from "./session-display-title";

export const SESSION_LIST_LIMIT = 40;
export const SESSION_TITLE_MAX = 60;
export const SESSION_RESOLVE_BATCH = 4;
export const SESSION_RESOLVE_FIRST_BATCH = 1;

function resolveStepAt(index: number): number {
  return index === 0 ? SESSION_RESOLVE_FIRST_BATCH : SESSION_RESOLVE_BATCH;
}

export interface SessionSummarySource {
  sessionId: string;
  summary: string;
  cwd?: string;
  lastModified: number;
}

export interface SessionCandidate {
  sessionId: string;
  filePath: string;
  mtime: number;
}

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

export function candidatePathIndex(candidates: readonly SessionCandidate[]): Map<string, string> {
  return new Map(candidates.map((c) => [c.sessionId, c.filePath]));
}

export function untitledLabel(sessionId: string): string {
  return l10n.t("(Untitled: {0})", sessionId.slice(0, 8));
}

export function displayTitleFromSummary(
  summary: string,
  sessionId: string,
  maxLength?: number
): string {
  const normalized = normalizeTitleValue(summary);
  if (normalized === null) return untitledLabel(sessionId);
  return formatSessionTitleForDisplay(normalized, maxLength ?? SESSION_TITLE_MAX);
}

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
    const nextIndex = i + batch.length;
    const infos = await Promise.all(batch.map(resolve));
    scanned += batch.length;
    const resolved: SessionSummarySource[] = [];
    for (let k = 0; k < batch.length && sent + resolved.length < SESSION_LIST_LIMIT; k++) {
      const info = infos[k];
      if (info === undefined) continue;
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
  if (d.unresolvedCandidates > 0) parts.push(l10n.t("{0} candidates (summary unavailable, so they cannot be listed)", d.unresolvedCandidates));
  if (parts.length === 0) return undefined;
  return l10n.t(
    "Could not read {0}. The list is missing these entries. Check sync and permissions, then reopen the history.",
    parts.join(l10n.t(", "))
  );
}
