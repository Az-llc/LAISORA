import { getLaisoraConfiguration } from "./claude-settings";
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { configuredClaudeExecutablePath, inheritedProfile, resolveSessionCwd } from "./claude-settings";
import { claudeConfigDir } from "./claude-env";
import { resolveHandoffRuntime } from "./claudeHost";
import { openResumedSession } from "./resume-hydration";
import type { Session } from "./session";
import {
  handoffDecisionCounts,
  handoffDecisionLineCount,
  handoffContextUsageKey,
  handoffUnreadableLinesKey,
  type HandoffContextUsage,
} from "./handoff-envelope";
import {
  HANDOFF_DETAIL_MAX_BYTES,
  HandoffRunner,
  buildHandoffDetailParts,
  extractHandoffDetail,
  parseHandoffRecords,
  shouldActivateForkTab,
  type HandoffDetail,
  type HandoffOutcome,
  type HandoffRecordsRead,
  COMPACT_HEARTBEAT_GRACE_MS,
} from "./handoff-runner";
import { extensionContext, output } from "./host-context";
import { normalizeApiKeyPolicy, restoredHandoffRunId, type HostToWebview, type WebviewToHost } from "./protocol";
import { lookupSessionFile } from "./session-files";
import { displayTitleFromSummary } from "./session-list";
import { sessionSummaryOf } from "./session-list-wiring";
import type { SessionStore } from "./store-surfaces";

export const handoffDetailSources = new Map<string, { runId: string; detail: HandoffDetail }>();

const handoffRuns = new Map<string, { runId: string; runner: HandoffRunner | null }>();

export function handoffPersist(): { get(k: string): unknown; update(k: string, v: unknown): Promise<void> } {
  return {
    get: (k) => extensionContext?.globalState.get(k),
    update: async (k, v) => {
      await extensionContext?.globalState.update(k, v);
    },
  };
}

export const handoffFs = {
  unlink: (p: string) => unlink(p),
  readFile: (p: string) => readFile(p, "utf8"),
};

async function writeHandoffDiagnostic(name: string, text: string): Promise<string> {
  const dir = join(claudeConfigDir(), "laisora-handoff-diagnostics");
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, text, "utf8");
  return p;
}

export async function readHandoffRecords(filePath: string): Promise<HandoffRecordsRead> {
  return parseHandoffRecords(await readFile(filePath, "utf8"));
}

async function runHandoff(st: SessionStore, sender: vscode.Webview, target: Session): Promise<void> {
  const runId = randomUUID();
  const profile = inheritedProfile(target);
  const source = { sessionId: target.resumeSessionId ?? target.auth?.sessionId ?? "", title: target.title };
  const fail = (reason: string, detail?: string, tabId: string = target.tabId): void => {
    st.post({
      type: "handoffStatus",
      tabId,
      runId,
      state: "failed",
      reason,
      detail,
      message:
        reason === "tab_failed"
          ? l10n.t("The handoff was already created. You can open it from the history.")
          : l10n.t("Handoff aborted ({0})", `${reason}${detail === undefined ? "" : `: ${detail}`}`),
      source,
    });
  };
  const busy = (): boolean => (target.conversation?.state ?? "idle") !== "idle";
  const sourceConversation = target.conversation;
  const sourceGeneration = target.logicalGeneration;
  const contextUsage: HandoffContextUsage = { before: null, after: "pending" };
  let snapshotWrite: Promise<void> = Promise.resolve();

  if (busy()) {
    fail("source_busy");
    return;
  }
  if (handoffRuns.has(target.tabId)) {
    fail("already_running");
    return;
  }
  const reservation: { runId: string; runner: HandoffRunner | null } = { runId, runner: null };
  handoffRuns.set(target.tabId, reservation);
  try {
    if (source.sessionId.length === 0) {
      fail("fork_failed", "no_session_id");
      return;
    }
    const cfg = getLaisoraConfiguration();
    const cwd = resolveSessionCwd(target);
    if (cwd === undefined) {
      fail("fork_failed", "no_cwd");
      return;
    }
    let runtime: Awaited<ReturnType<typeof resolveHandoffRuntime>>;
    try {
      runtime = await resolveHandoffRuntime(
        configuredClaudeExecutablePath(cfg),
        normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit"))
      );
    } catch (e) {
      fail("fork_failed", String(e));
      return;
    }

    const runner = new HandoffRunner({
      sdk: runtime.sdk,
      cwd,
      claudeExecutablePath: runtime.claudeExecutablePath,
      env: runtime.env,
      model: profile.model ?? undefined,
      effort: profile.effort ?? undefined,
      settingSources: cfg.get<Array<"user" | "project" | "local">>("claude.settingSources", ["user", "project", "local"]),
      lookupSessionFileById: async (id) => lookupSessionFile(id),
      readRecords: readHandoffRecords,
      fs: handoffFs,
      writeDiagnostic: writeHandoffDiagnostic,
      persist: handoffPersist(),
      now: () => Date.now(),
      timeoutMs: COMPACT_HEARTBEAT_GRACE_MS,
      log: (line) => output.appendLine(`[${target.title}] ${line}`),
      onPhase: (phase) => {
        st.post({
          type: "handoffStatus",
          tabId: target.tabId,
          runId,
          state: "running",
          phase,
          message: l10n.t("Handing off"),
          source,
        });
      },
      onForkCreated: (forkSessionId) => {
        snapshotWrite = handoffPersist().update(handoffContextUsageKey(forkSessionId), { ...contextUsage }).catch((error) =>
          output.appendLine("[handoff] context snapshot could not be saved: " + String(error)));
      },
      onProgress: (info) => {
        st.post({
          type: "handoffStatus",
          tabId: target.tabId,
          runId,
          state: "running",
          phase: info.phase,
          progress: { heartbeats: info.heartbeats, elapsedMs: info.elapsedMs, since: info.since },
          message: l10n.t("Handing off"),
          source,
        });
      },
    });
    reservation.runner = runner;
    let sourceTitle = target.title;
    try {
      const summary = await sessionSummaryOf(source.sessionId);
      if (summary !== undefined) sourceTitle = displayTitleFromSummary(summary, source.sessionId);
    } catch (error) {
      output.appendLine(`[${target.title}] handoff source title unresolved; using tab title: ${String(error)}`);
    }
    const sourceUnchanged = (): boolean =>
      !target.closed && target.conversation === sourceConversation && target.logicalGeneration === sourceGeneration;
    const before = sourceUnchanged() ? await sourceConversation?.captureHandoffContextUsage() ?? null : null;
    contextUsage.before = sourceUnchanged() ? before : null;
    const outcome: HandoffOutcome = await runner.run({
      sourceSessionId: source.sessionId,
      sourceTitle,
      runId,
      sourceBusy: busy,
    });
    if (!outcome.ok) {
      const forkSessionId = outcome.forkSessionId;
      if (forkSessionId !== undefined && (await lookupSessionFile(forkSessionId)).reason === "not_found") {
        void snapshotWrite.then(() => handoffPersist().update(handoffContextUsageKey(forkSessionId), undefined)).catch((error) =>
          output.appendLine("[handoff] context snapshot could not be removed: " + String(error)));
      }
      fail(outcome.reason, outcome.detail);
      return;
    }
    const contextUsageKey = handoffContextUsageKey(outcome.forkSessionId);
    if (outcome.unreadableLineCount > 0) {
      void handoffPersist().update(handoffUnreadableLinesKey(outcome.forkSessionId), outcome.unreadableLineCount).catch((error) =>
        output.appendLine("[handoff] unreadable line count could not be saved: " + String(error)));
    }
    const opened = await openResumedSession(st, {
      sessionId: outcome.forkSessionId,
      filePath: outcome.forkFilePath,
      activate: shouldActivateForkTab(st.activeTabIdOf(sender), target.tabId),
      inherit: profile,
      knownCwd: cwd,
    });
    if (!opened.tabPosted || opened.session === undefined) {
      fail("tab_failed");
      return;
    }
    const forkSession = opened.session;
    const decisions = outcome.detail?.decisions;
    forkSession.handoffSource = {
      contextUsage,
      sessionId: source.sessionId,
      title: sourceTitle,
      ...(outcome.compact !== undefined ? { compact: outcome.compact } : {}),
      utteranceCount: outcome.utteranceCount,
      ...(outcome.unreadableLineCount > 0 ? { unreadableLineCount: outcome.unreadableLineCount } : {}),
      ...(decisions !== undefined
        ? { decisionCount: handoffDecisionLineCount(decisions), decisions: handoffDecisionCounts(decisions) }
        : {}),
      detailRunId: restoredHandoffRunId(outcome.forkSessionId),
    };
    if (outcome.unreadableLineCount > 0) {
      output.appendLine(`[handoff] ${runId} F の ${outcome.unreadableLineCount} 行を JSON として読めなかった（逐語が欠けている可能性）`);
    }
    const done = {
      type: "handoffStatus",
      runId,
      state: "done",
      contextUsage,
      ...(decisions !== undefined ? { decisions: handoffDecisionCounts(decisions) } : {}),
      message:
        outcome.unreadableLineCount > 0
          ? l10n.t(
              "Handoff complete ({0} lines of the record could not be read; some messages may be missing)",
              outcome.unreadableLineCount
            )
          : l10n.t("Handoff complete"),
      source,
      fork: { sessionId: outcome.forkSessionId, tabId: forkSession.tabId, title: forkSession.title },
      ...(outcome.compact !== undefined ? { compact: outcome.compact } : {}),
      utteranceCount: outcome.utteranceCount,
      ...(outcome.unreadableLineCount > 0 ? { unreadableLineCount: outcome.unreadableLineCount } : {}),
    } as const;
    if (outcome.detail !== undefined) {
      handoffDetailSources.set(forkSession.tabId, { runId, detail: outcome.detail });
    }
    st.post({ ...done, tabId: target.tabId });
    st.post({ ...done, tabId: forkSession.tabId });
    const generation = forkSession.logicalGeneration;
    void settleHandoffContextUsage(forkSession, contextUsage).then(async () => {
      if (forkSession.logicalGeneration !== generation) return;
      if (!target.closed) st.post({ ...done, tabId: target.tabId });
      if (!forkSession.closed) st.post({ ...done, tabId: forkSession.tabId });
      await snapshotWrite;
      await handoffPersist().update(contextUsageKey, { ...contextUsage });
    }).catch((error) => {
      output.appendLine("[handoff] context snapshot could not be saved: " + String(error));
      if (forkSession.logicalGeneration === generation && !forkSession.closed) st.post({ ...done, tabId: forkSession.tabId });
    });
  } catch (e) {
    fail("commit_failed", String(e));
  } finally {
    if (handoffRuns.get(target.tabId)?.runId === runId) handoffRuns.delete(target.tabId);
  }
}

const handoffDetailRestores = new Map<string, Promise<{ runId: string; detail: HandoffDetail } | undefined>>();

async function restoreHandoffDetailSource(
  st: SessionStore,
  tabId: string,
  runId: string,
  cachedRunId: boolean
): Promise<{ runId: string; detail: HandoffDetail } | undefined> {
  const session = st.sessions.get(tabId);
  const forkSessionId = session?.resumeSessionId;
  if (session === undefined || forkSessionId === undefined || session.resumeFilePath === undefined) return undefined;
  if (!cachedRunId && runId !== restoredHandoffRunId(forkSessionId)) return undefined;
  const key = `${tabId}\u0000${runId}`;
  const inFlight = handoffDetailRestores.get(key);
  if (inFlight !== undefined) return inFlight;
  const filePath = session.resumeFilePath;
  const started = (async () => {
    let detail: HandoffDetail | undefined;
    try {
      detail = extractHandoffDetail((await readHandoffRecords(filePath)).records, forkSessionId);
    } catch (error) {
      output.appendLine(`[handoff] detail restore failed: ${forkSessionId}: ${String(error)}`);
      return undefined;
    }
    if (detail === undefined) return undefined;
    const entry = { runId, detail };
    handoffDetailSources.set(tabId, entry);
    output.appendLine(`[handoff] detail restored from record: ${forkSessionId}`);
    return entry;
  })().finally(() => {
    handoffDetailRestores.delete(key);
  });
  handoffDetailRestores.set(key, started);
  return started;
}

async function sendHandoffDetailPart(
  st: SessionStore,
  sender: vscode.Webview,
  tabId: string,
  runId: string,
  part: number,
  refresh: boolean
): Promise<void> {
  const empty: Extract<HostToWebview, { type: "handoffDetail" }> = {
    type: "handoffDetail",
    tabId,
    runId,
    part,
    total: 0,
    utterances: [],
  };
  const cached = handoffDetailSources.get(tabId);
  const hit = cached?.runId === runId ? cached : undefined;
  const sourceRef = hit !== undefined && !refresh
    ? hit
    : await restoreHandoffDetailSource(st, tabId, runId, hit !== undefined) ?? hit;
  if (sourceRef === undefined) {
    await st.postTo(sender, empty);
    return;
  }
  const base = jsonByteLength({ type: "handoffDetail", tabId, runId, part, total: 0, utterances: [] });
  const parts = buildHandoffDetailParts(
    sourceRef.detail.summary,
    sourceRef.detail.utterances,
    HANDOFF_DETAIL_MAX_BYTES - base,
    sourceRef.detail.decisions
  );
  const chunk = parts[part];
  if (chunk === undefined) {
    await st.postTo(sender, { ...empty, total: parts.length });
    return;
  }
  await st.postTo(sender, {
    type: "handoffDetail",
    tabId,
    runId,
    part,
    total: parts.length,
    ...(chunk.summary !== undefined ? { summary: chunk.summary } : {}),
    ...(chunk.decisions !== undefined ? { decisions: chunk.decisions } : {}),
    utterances: chunk.utterances,
  });
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function openHandoffSourceSession(
  st: SessionStore,
  sender: vscode.Webview,
  origin: Session,
  sourceSessionId: string
): Promise<void> {
  const existing = [...st.sessions.values()].find(
    (s) => !s.closed && (s.resumeSessionId === sourceSessionId || s.auth?.sessionId === sourceSessionId)
  );
  if (existing) {
    await st.postTo(sender, { type: "activateTab", tabId: existing.tabId });
    return;
  }
  const lookup = lookupSessionFile(sourceSessionId);
  if (lookup.reason === "not_found") {
    output.appendLine(`[handoff] source not found: ${sourceSessionId}`);
    origin.pushEvent({
      kind: "error",
      message: l10n.t("LAISORA: The previous conversation was not found ({0}).", sourceSessionId),
      fatal: false,
    });
    return;
  }
  if (lookup.reason === "scan_failed") {
    output.appendLine(`[handoff] source lookup failed: ${sourceSessionId}: ${lookup.detail}`);
    origin.pushEvent({
      kind: "error",
      message: l10n.t("LAISORA: Could not check the previous conversation's record. Please try again."),
      fatal: false,
    });
    return;
  }
  if (lookup.path) {
    await openResumedSession(st, {
      sessionId: sourceSessionId,
      filePath: lookup.path,
      activate: true,
    });
  }
}

export async function handleHandoffMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "startHandoff" | "getHandoffDetail" | "cancelHandoff" | "openHandoffSource" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "startHandoff":
      await runHandoff(st, sender, target!);
      break;
    case "getHandoffDetail":
      await sendHandoffDetailPart(st, sender, target!.tabId, msg.runId, msg.part, msg.refresh === true);
      break;
    case "cancelHandoff": {
      const active = handoffRuns.get(target!.tabId);
      if (active?.runId === msg.runId && active.runner?.cancel()) {
        st.post({
          type: "handoffStatus",
          tabId: target!.tabId,
          runId: msg.runId,
          state: "failed",
          reason: "cancelled",
          message: l10n.t("Cancelled"),
          source: { sessionId: target!.resumeSessionId ?? target!.auth?.sessionId ?? "", title: target!.title },
        });
      }
      break;
    }
    case "openHandoffSource":
      await openHandoffSourceSession(st, sender, target!, msg.sourceSessionId);
      break;
  }
}

export async function settleHandoffContextUsage(session: Pick<Session, "starting" | "conversation" | "closed" | "expectedConversationId">, usage: HandoffContextUsage): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    usage.after = await Promise.race([
      (async () => {
        await session.starting;
        const conversation = session.conversation;
        if (session.closed || !conversation || conversation.conversationId !== session.expectedConversationId) return null;
        return await conversation.initialContextUsage;
      })(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10_000); }),
    ]);
  } catch {
    usage.after = null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
