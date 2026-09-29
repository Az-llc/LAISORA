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
import { handoffDecisionLineCount } from "./handoff-envelope";
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

// 取得後の追記で分割境界を変えないよう、sendHandoffDetailPart は handoffDetailSources の内容を使う。
export const handoffDetailSources = new Map<string, { runId: string; detail: HandoffDetail }>();

const handoffRuns = new Map<string, { runId: string; runner: HandoffRunner | null }>();

// src/handoff-runner.ts#COMPACT_HEARTBEAT_GRACE_MS を全体の締め切りへ流用しない。

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

  // R-HND-07: 画面側の操作可否だけに頼らず、runHandoff でも開始可否を確認する。
  if (busy()) {
    fail("source_busy");
    return;
  }
  if (handoffRuns.has(target.tabId)) {
    fail("already_running");
    return;
  }
  // 並行要求が予約前に通過しないよう、handoffRuns への予約まで非同期処理を挟まない。
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
        normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit")) // R-GW-05
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
    // 復元中はタブ名が未解決の場合があるため、src/session-list-wiring.ts#sessionSummaryOf で名前を取得する。
    let sourceTitle = target.title;
    try {
      const summary = await sessionSummaryOf(source.sessionId);
      if (summary !== undefined) sourceTitle = displayTitleFromSummary(summary, source.sessionId);
    } catch (error) {
      output.appendLine(`[${target.title}] handoff source title unresolved; using tab title: ${String(error)}`);
    }
    const outcome: HandoffOutcome = await runner.run({
      sourceSessionId: source.sessionId,
      sourceTitle,
      runId,
      sourceBusy: busy,
    });
    if (!outcome.ok) {
      fail(outcome.reason, outcome.detail);
      return;
    }
    // R-HND-08: 開始時の選択をキャッシュせず、src/handoff-runner.ts#shouldActivateForkTab に完了時の選択を渡す。
    const opened = await openResumedSession(st, {
      sessionId: outcome.forkSessionId,
      filePath: outcome.forkFilePath,
      activate: shouldActivateForkTab(st.activeTabIdOf(sender), target.tabId),
      inherit: inheritedProfile(target),
      knownCwd: cwd,
    });
    if (!opened.tabPosted || opened.session === undefined) {
      // 表示の失敗で完成した複製を消さない。再取得先は outcome.forkSessionId。
      fail("tab_failed");
      return;
    }
    const forkSession = opened.session;
    forkSession.handoffSource = {
      sessionId: source.sessionId,
      title: sourceTitle,
      ...(outcome.compact !== undefined ? { compact: outcome.compact } : {}),
      utteranceCount: outcome.utteranceCount,
      ...(outcome.detail?.decisions !== undefined
        ? { decisionCount: handoffDecisionLineCount(outcome.detail.decisions) }
        : {}),
      // R-HND-10: 再読込後の展開要求と同じ識別子を使う（src/protocol.ts#restoredHandoffRunId）。
      detailRunId: restoredHandoffRunId(outcome.forkSessionId),
    };
    if (outcome.unreadableLineCount > 0) {
      output.appendLine(`[handoff] ${runId} F の ${outcome.unreadableLineCount} 行を JSON として読めなかった（逐語が欠けている可能性）`);
    }
    // 本文で状態通知を膨らませない。展開内容は sendHandoffDetailPart で返す。
    const decisions = outcome.detail?.decisions;
    const done = {
      type: "handoffStatus",
      runId,
      state: "done",
      ...(decisions !== undefined
        ? {
            decisions: {
              total: decisions.entries.length,
              carried: decisions.carried,
              extracted: decisions.extracted,
              removed: decisions.removed,
              unknownIdRefs: decisions.unknownIdRefs,
              ...(decisions.warn !== undefined ? { warn: decisions.warn } : {}),
            },
          }
        : {}),
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
  } catch (e) {
    fail("commit_failed", String(e));
  } finally {
    if (handoffRuns.get(target.tabId)?.runId === runId) handoffRuns.delete(target.tabId);
  }
}

// R-HND-10: 同時に届く展開要求の読み取りを handoffDetailRestores で共有する。
const handoffDetailRestores = new Map<string, Promise<{ runId: string; detail: HandoffDetail } | undefined>>();

async function restoreHandoffDetailSource(
  st: SessionStore,
  tabId: string,
  runId: string
): Promise<{ runId: string; detail: HandoffDetail } | undefined> {
  const session = st.sessions.get(tabId);
  const forkSessionId = session?.resumeSessionId;
  if (session === undefined || forkSessionId === undefined || session.resumeFilePath === undefined) return undefined;
  if (runId !== restoredHandoffRunId(forkSessionId)) return undefined;
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

// 他の面の追加要求を誘発しないよう、sendHandoffDetailPart は要求元へだけ応答する（verify-webview-wiring#W-HND-8）。
async function sendHandoffDetailPart(
  st: SessionStore,
  sender: vscode.Webview,
  tabId: string,
  runId: string,
  part: number
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
  const sourceRef = cached?.runId === runId ? cached : await restoreHandoffDetailSource(st, tabId, runId);
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

// R-HND-08: 元会話の検索失敗も操作した origin に表示し、操作場所から離れた通知にしない。
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
      await sendHandoffDetailPart(st, sender, target!.tabId, msg.runId, msg.part);
      break;
    case "cancelHandoff": {
      const active = handoffRuns.get(target!.tabId);
      // R-HND-08: 取消の受理は src/handoff-runner.ts#HandoffRunner.cancel に委ね、完成後の表示準備を取消と誤通知しない。
      if (active?.runId === msg.runId && active.runner?.cancel()) {
        // R-HND-08: 取消の表示は src/handoff-runner.ts#HandoffRunner.run の終了を待たない。子プロセスの終了待ちで操作への反応を遅らせない。
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
