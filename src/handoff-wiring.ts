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

// 状態カードの本文。done の時点で 1 回だけ取った内容を保持し、part 要求はここから切る
// （要求のたびに F を読むと、以後の発言や再 compact で要約と part 境界が変わる）
export const handoffDetailSources = new Map<string, { runId: string; detail: HandoffDetail }>();

// 引き継ぎ実行中の Runner。開始元タブごとに 1 本だけ持つ（2 本目を許すと同じ S から
// fork が 2 つでき、片方が孤児のまま残る）
const handoffRuns = new Map<string, { runId: string; runner: HandoffRunner | null }>();

// 「CLI から何も来ない時間」の上限。全体の所要時間ではない（handoff-runner の armTimeout が
// stream のメッセージごとに引き直す）。**絶対時間の締め切りとして使い直さないこと**:
// compact の所要時間は文脈量にほぼ比例するので、絶対時間の締め切りは大きい文脈で compact 完了前に発火し、
// 完成した fork を捨てる。値を伸ばす対処は文脈量が増えるたびに同じ失敗を繰り返す。
// 値の根拠は COMPACT_HEARTBEAT_GRACE_MS の定義に置いてある（別名を作らず直接使う）

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

// HandoffRunner が受け取る記録列。並べ替えず、UUID 重複だけ落とす（時刻の fallback は
// extractVerbatimUserUtterances 側が持つ）
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

  // R-HND-07: 元タブが実行中なら開始しない。webview 側のボタン状態には依存しない
  if (busy()) {
    fail("source_busy");
    return;
  }
  if (handoffRuns.has(target.tabId)) {
    fail("already_running");
    return;
  }
  // 予約は has 判定と同じ tick で置く。await を挟むと同時押下が両方ガードを通り、
  // 同じ S から fork が 2 つできる
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
    // タブ名は resume の hydration 完了まで既定値「会話 N」のままなので、履歴一覧と同じ解決器で JSONL から引く
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
    // R-HND-08: 完了時にフォーカスを奪わない。判定は開始時ではなく完了時のアクティブタブで行う
    const opened = await openResumedSession(st, {
      sessionId: outcome.forkSessionId,
      filePath: outcome.forkFilePath,
      activate: shouldActivateForkTab(st.activeTabIdOf(sender), target.tabId),
      inherit: inheritedProfile(target),
      knownCwd: cwd,
    });
    if (!opened.tabPosted || opened.session === undefined) {
      // F は完成品なので消さない。履歴から開ける
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
      // 再読込後の snapshot もこの ID でカードを描き、展開部は記録から取り直す（R-HND-10）
      detailRunId: restoredHandoffRunId(outcome.forkSessionId),
    };
    if (outcome.unreadableLineCount > 0) {
      output.appendLine(`[handoff] ${runId} F の ${outcome.unreadableLineCount} 行を JSON として読めなかった（逐語が欠けている可能性）`);
    }
    // 本文は載せない（既存条項）。件数だけを状態通知に載せ、行は handoffDetail の part 0 が運ぶ
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
    // 開始元タブは進行表示を消すため、引き継ぎ先タブは状態カードを出すために受け取る
    // 本文は積まない。webview が展開したときだけ getHandoffDetail で取りに来る
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

// 再読込・復元で開いたカードの展開部（R-HND-10）。handoffDetailSources はプロセス内の Map なので
// 再読込で消える。復元の runId（セッション ID 由来）を名乗る要求のときだけ記録から取り直し、
// **1 回だけ** cache へ入れる（part 要求のたびに読み直すと、以後の発言や再 compact で
// 要約と part 境界が変わる）
// 飛行中の読み直し。要約と発言の展開を同時に開くと 2 本の要求が同じ tick で届くので、
// 合流させないと数 MB の記録を 2 回読んで 2 回 parse する
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
  const key = `${tabId} ${runId}`;
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
    // 1 回の復元につき 1 行。同時要求が合流できていなければ行が増える
    output.appendLine(`[handoff] detail restored from record: ${forkSessionId}`);
    return entry;
  })().finally(() => {
    handoffDetailRestores.delete(key);
  });
  handoffDetailRestores.set(key, started);
  return started;
}

// 状態カードの展開部を 1 part 返す。応答は要求元の面だけへ送る（st.post で全可視面へ
// 配ると、各面が次の part を要求して要求数が part ごとに倍化する）
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

// 検索の失敗はリンクを押した会話（origin。引き継ぎ先タブ）へ返す。対象の元会話はまだタブとして
// 存在しないので、表示先は常に origin（R-HND-08。toast にすると操作した場所から離れて出る）
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
      // runId 単位で冪等。古い runId の中止要求で次の実行を止めない
      const active = handoffRuns.get(target!.tabId);
      // R-HND-08: 完成済み fork の表示準備中は、受理されなかった取消を通知しない。
      if (active?.runId === msg.runId && active.runner?.cancel()) {
        // run() の解決は drain 完了後で、CLI が止まるまで数秒〜数分かかりうる。押した瞬間に
        // 失敗表示へ切り替える（同じ runId の後続 failed は webview が捨てる。R-HND-08）
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
