import * as l10n from "@vscode/l10n";
import type { SessionListAction, SessionListItem, SessionScanDegradation } from "../protocol";
import { sessionScanNote } from "../session-list";
import {
  histBtn,
  histClearBtn,
  histCountEl,
  histFootEl,
  histListEl,
  histNoteEl,
  histNoticeEl,
  histPanelEl,
  histProgressEl,
  histSearchEl,
  histToolsEl,
  vscode,
} from "./dom";
import { formatDateTime } from "./l10n";
import { createLoader } from "./loader";
import { activeTabId } from "./main";
import { bindTitleEditor } from "./session-header";

let historySource: "laisora" | "claude" = "laisora";
let showHidden = false;
let nextCursor: string | undefined;
let moreButton: HTMLButtonElement | undefined;
let hiddenToggle: HTMLButtonElement | undefined;
const sourceButtons = new Map<string, HTMLButtonElement>();
function requestHistory(append = false): void {
  sessionsPhase = "partial";
  vscode.postMessage({
    type: "listSessions",
    source: historySource,
    cursor: append ? nextCursor : undefined,
    ...(showHidden ? { showHidden: true } : {}),
  });
  if (!append) { latestSessions = []; nextCursor = undefined; latestDegraded = undefined; selectedId = undefined; clearNotice(); }
  renderHistList(latestSessions);
}

let latestSessions: SessionListItem[] = [];
let sessionsPhase: "idle" | "partial" | "complete" = "idle";
let sessionsRequestId = -1;
let latestDegraded: SessionScanDegradation | undefined;
let filteredRows: SessionListItem[] = [];
let selectedId: string | undefined;
let renderDeferred = false;
let searchComposing = false;
let editing: { input: HTMLInputElement; title: HTMLElement } | undefined;
let undoRow: { row: SessionListItem; index: number } | undefined;
const pendingRenames = new Map<string, { requestIds: Set<string>; title?: string }>();
const rowRefs = new Map<string, { row: HTMLElement; title: HTMLElement; cell: HTMLElement }>();

function relativeTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return l10n.t("Just now");
  if (minutes < 60) return l10n.t("{0}m ago", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return l10n.t("{0}h ago", hours);
  const days = Math.floor(hours / 24);
  return l10n.t("{0}d ago", days);
}

function cwdTail(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

export type HistoryDayGroup = "today" | "yesterday" | "week" | "older";

export function historyDayGroup(mtime: number, now = Date.now()): HistoryDayGroup {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (mtime >= day.getTime()) return "today";
  day.setDate(day.getDate() - 1);
  if (mtime >= day.getTime()) return "yesterday";
  day.setDate(day.getDate() - 5);
  if (mtime >= day.getTime()) return "week";
  return "older";
}

function dayGroupLabel(group: HistoryDayGroup): string {
  switch (group) {
    case "today": return l10n.t("Today");
    case "yesterday": return l10n.t("Yesterday");
    case "week": return l10n.t("Previous 7 days");
    case "older": return l10n.t("Older");
  }
}

function span(className: string, text?: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function appendMatches(node: HTMLElement, title: string, query: string): void {
  const lower = title.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle || lower.length !== title.length) { node.textContent = title; return; }
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) node.append(document.createTextNode(title.slice(from, at)));
    const mark = document.createElement("mark");
    mark.textContent = title.slice(at, at + needle.length);
    node.append(mark);
    from = at + needle.length;
  }
  if (from < title.length) node.append(document.createTextNode(title.slice(from)));
}

function closeHistPanel(restoreFocus = false): void {
  endRename(false);
  histPanelEl.classList.add("hidden");
  histBtn.setAttribute("aria-expanded", "false");
  clearNotice();
  if (restoreFocus) histBtn.focus();
}

export function openHistPanel(): void {
  histSearchEl.value = "";
  histClearBtn.hidden = true;
  const r = histBtn.getBoundingClientRect();
  histPanelEl.style.top = `${r.bottom + 4}px`;
  histPanelEl.classList.remove("hidden");
  histBtn.setAttribute("aria-expanded", "true");
  historySource = "laisora";
  showHidden = false;
  for (const [source, button] of sourceButtons) button.setAttribute("aria-pressed", String(source === historySource));
  hiddenToggle?.setAttribute("aria-pressed", "false");
  clearNotice();
  requestHistory();
  histSearchEl.focus();
}

export function applySessionChunk(
  requestId: number,
  sessions: SessionListItem[],
  complete: boolean,
  degraded?: SessionScanDegradation,
  source?: "laisora" | "claude", cursor?: string, append = false,
  includesHidden?: boolean
): void {
  if (source !== undefined && source !== historySource) return;
  if ((includesHidden === true) !== showHidden) return;
  if (requestId < sessionsRequestId) return;
  if (requestId > sessionsRequestId) {
    sessionsRequestId = requestId;
    if (!append) latestSessions = [];
    latestDegraded = undefined;
  }
  sessionsPhase = complete ? "complete" : "partial";
  latestDegraded = degraded;
  if (complete) nextCursor = cursor;
  renderHistList([...new Map(latestSessions.concat(sessions).map(row => [row.sessionId, row])).values()]);
}

export function renderHistList(sessions: SessionListItem[]): void {
  latestSessions = sessions;
  if (editing !== undefined) { renderDeferred = true; return; }
  paintHistList();
}

function paintHistList(): void {
  renderDeferred = false;
  const sessions = latestSessions;
  if (moreButton) {
    moreButton.hidden = nextCursor === undefined;
    moreButton.disabled = sessionsPhase !== "complete";
  }
  const query = histSearchEl.value.trim();
  const needle = query.toLowerCase();
  const filtered = query ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;
  filteredRows = filtered;
  if (selectedId !== undefined && !filtered.some((s) => s.sessionId === selectedId)) selectedId = undefined;
  if (selectedId === undefined && query && filtered.length > 0) selectedId = filtered[0].sessionId;

  histNoteEl.textContent = "";
  const note = sessionsPhase === "complete" ? sessionScanNote(latestDegraded) : undefined;
  if (note !== undefined) {
    const noteEl = document.createElement("div");
    noteEl.className = "hist-note";
    noteEl.setAttribute("role", "status");
    noteEl.append(span("hist-note-mark", "⚠"), span("hist-note-text", note));
    histNoteEl.appendChild(noteEl);
  }

  histCountEl.textContent = "";
  if (latestDegraded?.rootFailed !== true && (sessionsPhase === "complete" || sessions.length > 0)) {
    if (query) {
      const strong = document.createElement("strong");
      strong.textContent = l10n.t("{0} matches", filtered.length);
      histCountEl.append(strong, document.createTextNode(` / ${l10n.t("{0} items", sessions.length)}`));
    } else histCountEl.textContent = l10n.t("{0} items", sessions.length);
  }

  histProgressEl.textContent = "";
  if (sessionsPhase !== "complete" && sessions.length > 0) {
    const pending = document.createElement("span");
    pending.textContent = l10n.t("Checking the rest…");
    histProgressEl.append(createLoader(12), pending);
  }

  histListEl.textContent = "";
  rowRefs.clear();
  histListEl.removeAttribute("aria-activedescendant");
  histSearchEl.removeAttribute("aria-activedescendant");
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hist-empty";
    empty.setAttribute("role", "status");
    const text =
      sessionsPhase !== "complete"
        ? l10n.t("Loading…")
        : note !== undefined
          ? sessions.length === 0
            ? l10n.t("No history could be read")
            : l10n.t("No matching sessions in the readable range")
          : sessions.length === 0
            ? l10n.t("No sessions found")
            : nextCursor ? l10n.t("No matching sessions in loaded history") : l10n.t("No matching sessions");
    if (sessionsPhase !== "complete") empty.append(createLoader(12));
    empty.append(span("hist-empty-text", text));
    histListEl.appendChild(empty);
    return;
  }
  const groups = new Map<HistoryDayGroup, SessionListItem[]>();
  const now = Date.now();
  for (const s of filtered) {
    const group = historyDayGroup(s.mtime, now);
    const rows = groups.get(group);
    if (rows) rows.push(s); else groups.set(group, [s]);
  }
  for (const [group, rows] of groups) {
    const label = dayGroupLabel(group);
    const head = document.createElement("div");
    head.className = "hist-group";
    head.setAttribute("role", "presentation");
    head.append(span("hist-group-label", label), span("hist-group-count", String(rows.length)));
    const rowsEl = document.createElement("ul");
    rowsEl.className = "hist-rows";
    rowsEl.setAttribute("role", "group");
    rowsEl.setAttribute("aria-label", label);
    for (const s of rows) {
      const row = buildRow(s, query);
      rowsEl.appendChild(row);
    }
    histListEl.append(head, rowsEl);
  }
  syncSelection(false);
}

function openSession(s: SessionListItem): void {
  vscode.postMessage({
    type: "resumeSession",
    sessionId: s.sessionId,
    filePath: s.filePath,
    intoTabId: activeTabId ?? undefined,
  });
  closeHistPanel();
}

function buildRow(s: SessionListItem, query: string): HTMLElement {
  const row = document.createElement("li");
  row.className = s.hidden ? "hist-row is-hidden" : "hist-row";
  row.id = `hist-row-${s.sessionId}`;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.setAttribute("aria-keyshortcuts", "Enter F2 Delete");
  const cell = span("hist-title-cell");
  const title = span("hist-title");
  title.title = s.title;
  appendMatches(title, s.title, query);
  cell.appendChild(title);
  const time = span("hist-time", relativeTime(s.mtime));
  time.title = formatDateTime(s.mtime);
  const meta = span("hist-meta");
  meta.append(document.createTextNode(cwdTail(s.cwd)));
  if (s.originUnverified) meta.append(span("hist-origin", l10n.t("Earlier history (app not recorded)")));
  if (s.hidden) meta.append(span("hist-hidden-mark", l10n.t("Hidden")));
  meta.title = s.cwd;
  const actions = span("hist-actions");
  actions.setAttribute("aria-hidden", "true");
  actions.append(actionButton("rename", s), actionButton(s.hidden ? "unhide" : "hide", s));
  row.append(cell, time, meta, actions);
  row.onclick = () => openSession(s);
  rowRefs.set(s.sessionId, { row, title, cell });
  return row;
}

function setRowHidden(s: SessionListItem, hidden: boolean): void {
  vscode.postMessage({ type: "setSessionHidden", sessionId: s.sessionId, hidden });
}

function actionButton(kind: SessionListAction, s: SessionListItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `hist-action hist-action-${kind}`;
  button.dataset.action = kind;
  const label =
    kind === "rename" ? l10n.t("Rename session")
      : kind === "hide" ? l10n.t("Delete from this list (the record is kept)")
        : l10n.t("Show in the list again");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.tabIndex = -1;
  const icon = span(`l-icon l-icon-${kind === "rename" ? "edit" : kind === "hide" ? "eye-closed" : "eye"}`);
  button.append(icon);
  button.onmousedown = (event) => event?.preventDefault();
  button.onclick = (event) => {
    event?.stopPropagation();
    if (kind === "rename") beginRename(s.sessionId);
    else setRowHidden(s, kind === "hide");
  };
  return button;
}

function syncSelection(scroll: boolean): void {
  histListEl.removeAttribute("aria-activedescendant");
  histSearchEl.removeAttribute("aria-activedescendant");
  for (const [sessionId, ref] of rowRefs) {
    const selected = sessionId === selectedId;
    ref.row.setAttribute("aria-selected", String(selected));
    if (!selected) continue;
    histListEl.setAttribute("aria-activedescendant", ref.row.id);
    histSearchEl.setAttribute("aria-activedescendant", ref.row.id);
    if (scroll) ref.row.scrollIntoView?.({ block: "nearest" });
  }
}

function selectedRow(): SessionListItem | undefined {
  return selectedId === undefined ? undefined : filteredRows.find((s) => s.sessionId === selectedId);
}

function moveSelection(to: number | "first" | "last"): void {
  if (filteredRows.length === 0) return;
  const index = filteredRows.findIndex((s) => s.sessionId === selectedId);
  const next =
    to === "first" ? 0
      : to === "last" ? filteredRows.length - 1
        : index < 0 ? (to > 0 ? 0 : filteredRows.length - 1)
          : Math.min(filteredRows.length - 1, Math.max(0, index + to));
  selectedId = filteredRows[next].sessionId;
  syncSelection(true);
}

function beginRename(sessionId: string): void {
  if (editing !== undefined) endRename(false);
  const ref = rowRefs.get(sessionId);
  const row = latestSessions.find((s) => s.sessionId === sessionId);
  if (!ref || !row) return;
  selectedId = sessionId;
  syncSelection(true);
  const input = document.createElement("input");
  input.className = "hist-rename-input";
  input.value = row.title;
  input.onclick = (event) => event?.stopPropagation();
  editing = { input, title: ref.title };
  bindTitleEditor(
    input,
    (value) => {
      if (editing?.input !== input) return;
      const requestId = crypto.randomUUID();
      const pending = pendingRenames.get(row.sessionId) ?? { requestIds: new Set<string>() };
      pending.requestIds.add(requestId);
      pendingRenames.set(row.sessionId, pending);
      vscode.postMessage({ type: "renameSession", sessionId: row.sessionId, filePath: row.filePath, title: value, requestId });
      endRename(true);
    },
    (byKey) => { if (editing?.input === input) endRename(byKey); }
  );
  ref.title.hidden = true;
  ref.cell.appendChild(input);
  input.focus();
  input.select();
}

function endRename(restoreFocus: boolean): void {
  const current = editing;
  if (current === undefined) return;
  editing = undefined;
  current.input.remove();
  current.title.hidden = false;
  if (renderDeferred) paintHistList();
  if (restoreFocus) histListEl.focus();
}

function clearNotice(): void {
  histNoticeEl.textContent = "";
  histNoticeEl.hidden = true;
  undoRow = undefined;
}

function showNotice(text: string, undo?: () => void): void {
  histNoticeEl.textContent = "";
  histNoticeEl.append(span("hist-notice-text", text));
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hist-notice-undo";
    button.textContent = l10n.t("Undo");
    button.onclick = (event) => { event?.stopPropagation(); undo(); };
    histNoticeEl.append(button);
  }
  histNoticeEl.hidden = false;
}

function settleRename(sessionId: string, requestId: string | undefined, title?: string): string | undefined {
  const pending = pendingRenames.get(sessionId);
  if (!pending) return title;
  if (requestId !== undefined) pending.requestIds.delete(requestId);
  if (title !== undefined) pending.title = title;
  if (pending.requestIds.size > 0) return undefined;
  pendingRenames.delete(sessionId);
  return pending.title;
}

function showRowTitle(sessionId: string, title: string | undefined): void {
  if (title === undefined || !latestSessions.some((s) => s.sessionId === sessionId)) return;
  renderHistList(latestSessions.map((s) => s.sessionId === sessionId ? { ...s, title } : s));
}

export function applySessionRenamed(sessionId: string, title: string, requestId?: string): void {
  showRowTitle(sessionId, settleRename(sessionId, requestId, title));
}

function keepFocusInPanel(): void {
  if (histPanelEl.classList.contains("hidden")) return;
  const active = document.activeElement;
  const lost = !active || active === document.body;
  if (!lost && !(active === histListEl && filteredRows.length === 0)) return;
  if (filteredRows.length > 0) histListEl.focus(); else histSearchEl.focus();
}

export function applySessionHiddenChanged(sessionId: string, hidden: boolean): void {
  const index = latestSessions.findIndex((s) => s.sessionId === sessionId);
  const row = index >= 0 ? latestSessions[index] : undefined;
  if (hidden) {
    if (!row) return;
    if (showHidden) latestSessions = latestSessions.map((s) => s.sessionId === sessionId ? { ...s, hidden: true } : s);
    else {
      const at = filteredRows.findIndex((s) => s.sessionId === sessionId);
      latestSessions = latestSessions.filter((s) => s.sessionId !== sessionId);
      if (at >= 0) {
        const visible = filteredRows.filter((s) => s.sessionId !== sessionId);
        selectedId = visible[Math.min(at, visible.length - 1)]?.sessionId;
      }
    }
    renderHistList(latestSessions);
    showNotice(l10n.t("Removed “{0}” from this list. The record is kept.", row.title), () =>
      vscode.postMessage({ type: "setSessionHidden", sessionId, hidden: false }));
    undoRow = { row: { ...row, hidden: false }, index };
    keepFocusInPanel();
    return;
  }
  const undone = undoRow?.row.sessionId === sessionId;
  if (row) latestSessions = latestSessions.map((s) => s.sessionId === sessionId ? { ...s, hidden: false } : s);
  else if (undone && undoRow) {
    const restored = [...latestSessions];
    restored.splice(Math.min(undoRow.index, restored.length), 0, undoRow.row);
    latestSessions = restored;
  }
  if (undone) {
    clearNotice();
    selectedId = sessionId;
  }
  renderHistList(latestSessions);
  if (undone) keepFocusInPanel();
}

export function applySessionListActionFailed(reason: string, sessionId?: string, action?: SessionListAction, requestId?: string): void {
  if (action === "rename" && sessionId !== undefined && requestId !== undefined && pendingRenames.get(sessionId)?.requestIds.has(requestId)) {
    showRowTitle(sessionId, settleRename(sessionId, requestId));
  }
  showNotice(`⚠ ${reason}`);
}

export function onHistoryKeydown(e: KeyboardEvent): void {
  if (histPanelEl.classList.contains("hidden") || editing !== undefined) return;
  if (e.isComposing || searchComposing || e.keyCode === 229) return;
  const target = e.target as HTMLElement | null;
  const onButton = String(target?.tagName ?? "").toLowerCase() === "button";
  const inSearch = target === histSearchEl;
  const take = () => { e.preventDefault(); e.stopPropagation(); };
  switch (e.key) {
    case "Escape":
      take();
      closeHistPanel(true);
      return;
    case "ArrowDown":
    case "ArrowUp":
      take();
      moveSelection(e.key === "ArrowDown" ? 1 : -1);
      if (!inSearch && target !== histListEl) histListEl.focus();
      return;
    case "Home":
    case "End":
      if (inSearch) return;
      take();
      moveSelection(e.key === "Home" ? "first" : "last");
      return;
    case "Enter": {
      const s = onButton ? undefined : selectedRow();
      if (!s) return;
      take();
      openSession(s);
      return;
    }
    case "F2": {
      const s = selectedRow();
      if (!s) return;
      take();
      beginRename(s.sessionId);
      return;
    }
    case "Delete": {
      const s = target === histListEl ? selectedRow() : undefined;
      if (!s) return;
      take();
      setRowHidden(s, !s.hidden);
      return;
    }
  }
}

export function onHistoryListFocus(): void {
  if (histListEl.matches?.(":focus-visible") === false || filteredRows.length === 0) return;
  if (selectedRow() === undefined) moveSelection("first");
  else syncSelection(true);
}

export function initHistory(): void {
  const sources = document.createElement("div");
  sources.className = "hist-sources";
  sources.setAttribute("role", "group");
  sources.setAttribute("aria-label", l10n.t("History source"));
  for (const [source, label] of [["laisora", "LAISORA"], ["claude", "Claude Code"]] as const) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label;
    button.dataset.label = label;
    button.setAttribute("aria-pressed", String(source === historySource));
    button.onclick = () => {
      if (historySource === source) return;
      historySource = source;
      for (const [key, btn] of sourceButtons) btn.setAttribute("aria-pressed", String(key === source));
      requestHistory();
    };
    sourceButtons.set(source, button); sources.appendChild(button);
  }
  histToolsEl.insertBefore(sources, histToolsEl.firstChild);
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.className = "hist-toggle-hidden";
  toggle.textContent = l10n.t("Show hidden");
  toggle.setAttribute("aria-pressed", "false");
  toggle.onclick = () => {
    showHidden = !showHidden;
    toggle.setAttribute("aria-pressed", String(showHidden));
    requestHistory();
  };
  hiddenToggle = toggle;
  moreButton = document.createElement("button");
  moreButton.type = "button"; moreButton.className = "hist-more";
  moreButton.textContent = l10n.t("Load more sessions"); moreButton.hidden = true;
  moreButton.onclick = () => requestHistory(true);
  histFootEl.append(toggle, moreButton);
  histBtn.onclick = (e) => {
    e.stopPropagation();
    if (histPanelEl.classList.contains("hidden")) openHistPanel();
    else closeHistPanel();
  };
  histSearchEl.addEventListener("compositionstart", () => { searchComposing = true; });
  histSearchEl.addEventListener("compositionend", () => { searchComposing = false; });
  histSearchEl.addEventListener("input", () => {
    selectedId = undefined;
    histClearBtn.hidden = histSearchEl.value === "";
    renderHistList(latestSessions);
  });
  histClearBtn.onclick = () => {
    histSearchEl.value = "";
    histClearBtn.hidden = true;
    selectedId = undefined;
    renderHistList(latestSessions);
    histSearchEl.focus();
  };
  histPanelEl.addEventListener("keydown", onHistoryKeydown);
  histListEl.addEventListener("focus", onHistoryListFocus);
  document.addEventListener("click", (e) => {
    if (
      !histPanelEl.classList.contains("hidden") &&
      !e.composedPath().some((node) => node === histBtn || node === histPanelEl)
    ) {
      closeHistPanel();
    }
  });
}
