import * as l10n from "@vscode/l10n";
import { getLaisoraConfiguration } from "./claude-settings";
import * as vscode from "vscode";

import { analyzeSessionFile } from "./analysis";
import { warmup } from "./conversation-lifecycle";
import { formatGeneratedAtLabel, type PersistedActionFinding } from "./analysis-persistence";
import { output } from "./host-context";
import { buildFindingSessionPrompt } from "./llm-report";
import { personalBaseline } from "./personal-baseline";
import type { AttachedFindingView, WebviewToHost } from "./protocol";
import { findSessionFile, isInSessionStore, lookupSessionFile } from "./session-files";
import { llmAnalysisEnabled } from "./session-semantic";
import type { Session } from "./extension";
import { tabLimit, warnTabLimit, type SessionStore } from "./store-surfaces";

function hostDisplayLocale(): string {
  return String(vscode.env?.language ?? "").toLowerCase().startsWith("ja") ? "ja-JP" : "en-US";
}

export async function handleAnalysisMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "analyzeCurrent" | "analyzeSession" | "llmAnalysisRequest" | "summarizeSession" | "suggestSessionName" | "setLlmAnalysisEnabled" | "startFindingSession" | "prepareHistoricalDraft" | "selectAnalysisArtifact" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "analyzeCurrent": {
      // 現在のタブのセッションを分析する。ファイルパスは webview に持たせず、
      // sessionId からホスト側で解決する（webview から任意パスを渡させない）。
      const sid = target!.resumeSessionId ?? target!.auth?.sessionId;
      if (!sid) {
        // 理由は要求元の面の、操作したタブの分析画面へ返す（toast にすると操作対象から離れた場所に出る。R-ANL-11）
        void st.postTo(sender, {
          type: "analysisFailed",
          kind: "script",
          tabId: target!.tabId,
          reason: l10n.t("LAISORA: The session ID is not available yet (analysis is available after the first message is sent)."),
        });
        break;
      }
      const found = lookupSessionFile(sid);
      if (found.path === null) {
        output.appendLine(
          `[analysis] ${found.reason} session=${sid}` + (found.reason === "scan_failed" ? ` — ${found.detail}` : "")
        );
        // 走査に失敗しただけのときに「まだ書き出されていません」と言わない。
        // 待っても直らないので、利用者を存在しない待ちへ誘導することになる（R-33）
        void st.postTo(sender, {
          type: "analysisFailed",
          kind: "script",
          tabId: target!.tabId,
          reason:
            found.reason === "scan_failed"
              ? l10n.t(
                  "LAISORA: Could not determine whether the session log exists (check sync and permissions): {0}",
                  found.detail
                )
              : l10n.t("LAISORA: The session log has not been written yet (wait briefly and try again)."),
        });
        break;
      }
      const path = found.path;
      const { baseline, scan } = await personalBaseline(path);
      void st.postTo(sender, {
        type: "analysis",
        sessionId: sid,
        filePath: path,
        report: analyzeSessionFile(path, baseline, scan, hostDisplayLocale()),
      });
      break;
    }
    case "analyzeSession": {
      // セッションストア外のパスは拒否（readSessionTranscriptと同じガード）
      if (!isInSessionStore(msg.filePath)) {
        // 理由なしで返すと webview は何も描かない（無言の失敗）。記録の有無は唯一の解決器で引き、
        // 走査の失敗を「無い」と言わない（R-33 / R-37 / R-ANL-11）
        const found = lookupSessionFile(msg.sessionId);
        output.appendLine(
          `[analysis] outside_store session=${msg.sessionId} lookup=${found.reason ?? "found"}` +
            (found.reason === "scan_failed" ? ` — ${found.detail}` : "")
        );
        void st.postTo(sender, {
          type: "analysisFailed",
          kind: "script",
          sessionId: msg.sessionId,
          reason:
            found.reason === "scan_failed"
              ? l10n.t(
                  "LAISORA: Could not determine whether the session log exists (check sync and permissions): {0}",
                  found.detail
                )
              : found.path !== null
                ? l10n.t("LAISORA: The requested log path is outside the session store. Open the session from the history list again.")
                : l10n.t("LAISORA: The session log was not found in the session store."),
        });
        break;
      }
      const { baseline, scan } = await personalBaseline(msg.filePath);
      const report = analyzeSessionFile(msg.filePath, baseline, scan, hostDisplayLocale());
      void st.postTo(sender, {
        type: "analysis", sessionId: msg.sessionId, filePath: msg.filePath, report,
      });
      break;
    }
    case "llmAnalysisRequest":
      await target!.llmRunner.requestLlmAnalysis();
      break;
    case "suggestSessionName":
      await target!.summaryRunner.requestSessionNameSuggestion();
      break;
    case "summarizeSession":
      await target!.summaryRunner.requestSessionSummary();
      break;
    case "setLlmAnalysisEnabled": {
      const cfg = getLaisoraConfiguration();
      const info = cfg.inspect?.<boolean>("workLog.llmAnalysis");
      const targetScope =
        info?.workspaceFolderValue !== undefined
          ? (vscode.ConfigurationTarget?.WorkspaceFolder ?? 3)
          : info?.workspaceValue !== undefined
          ? (vscode.ConfigurationTarget?.Workspace ?? 2)
          : (vscode.ConfigurationTarget?.Global ?? 1);
      try {
        await cfg.update("workLog.llmAnalysis", msg.enabled, targetScope);
      } catch (error) {
        output.appendLine(`[error] setLlmAnalysisEnabled failed: ${String(error)}`);
        void vscode.window.showWarningMessage(l10n.t("LAISORA: Could not save the setting."));
      }
      st.post({ type: "llmAnalysisSetting", enabled: llmAnalysisEnabled() });
      break;
    }
    case "startFindingSession": {
      const s = target!;
      const art = s.persistedArtifacts.find((a) => a.artifactId === msg.analysisRunId);
      const base = s.baseRefByArtifactId.get(msg.analysisRunId);
      const finding: PersistedActionFinding | AttachedFindingView | undefined =
        art?.report.findings.find((f) => f.findingId === msg.findingId);
      const models: string[] | null | undefined = art?.executedModels;
      const isoTime = art ? new Date(art.generatedAt).toISOString() : new Date().toISOString();
      const currentBase = s.semantic.semanticBasePayload();

      // R-ANL-02: 表示側の current/stale 判定と同じ参照同一性を Host 境界でも確認する。
      // 保存 artifact と古い webview message の hash 同士が一致しても、現在値が進んでいれば拒否する。
      if (!finding || !base || base !== currentBase || base.semanticHash !== msg.semanticHash) {
        output.appendLine(
          `[${s.title}] startFindingSession 拒否: 分析結果が更新されています (runId=${msg.analysisRunId})`
        );
        // 拒否は押した所見のある分析画面へ返す（R-ANL-02 / R-ANL-11）
        void st.postTo(sender, {
          type: "analysisFailed",
          kind: "action",
          tabId: s.tabId,
          reason: l10n.t("LAISORA: The analysis result has changed. Run the analysis again."),
        });
        break;
      }
      if (st.sessions.size >= tabLimit()) {
        warnTabLimit();
        break;
      }
      const newSession = st.createSession();
      newSession.title = l10n.t("🛠 Fix: {0}", Array.from(finding.title).slice(0, 24).join(""));
      newSession.autoTitled = true;
      st.post({ type: "tabCreated", tab: newSession.snapshot(), activate: true });

      const sessionId = s.resumeSessionId ?? s.auth?.sessionId;
      const filePath = s.resumeFilePath ?? (sessionId ? findSessionFile(sessionId) : undefined);
      const sessionRef = [sessionId, filePath].filter(Boolean).join(" / ") || l10n.t("Tab {0} (session not identified)", s.tabId);
      const prompt = buildFindingSessionPrompt({
        analysisSdk: art?.analysisSdk,
        sessionRef,
        models: models ?? null,
        isoTime,
        finding,
      });

      st.post({ type: "composerPrefill", tabId: newSession.tabId, text: prompt });
      warmup(newSession);
      break;
    }
    case "prepareHistoricalDraft": {
      const s = target!;
      const art = s.persistedArtifacts.find((a) => a.artifactId === msg.artifactId);
      if (!art) {
        output.appendLine(`[${s.title}] prepareHistoricalDraft 拒否: 分析結果が見つかりません (${msg.artifactId})`);
        void st.postTo(sender, {
          type: "analysisFailed",
          kind: "action",
          tabId: s.tabId,
          reason: l10n.t("LAISORA: The analysis result was not found."),
        });
        break;
      }
      const finding = art.report.findings.find((f) => f.findingId === msg.findingId);
      if (!finding) {
        output.appendLine(`[${s.title}] prepareHistoricalDraft 拒否: 所見が見つかりません (${msg.findingId})`);
        void st.postTo(sender, {
          type: "analysisFailed",
          kind: "action",
          tabId: s.tabId,
          reason: l10n.t("LAISORA: The finding was not found."),
        });
        break;
      }
      if (st.sessions.size >= tabLimit()) {
        warnTabLimit();
        break;
      }
      const newSession = st.createSession();
      newSession.title = l10n.t("📄 Past analysis: {0}", Array.from(finding.title).slice(0, 24).join(""));
      newSession.autoTitled = true;
      st.post({ type: "tabCreated", tab: newSession.snapshot(), activate: true });

      const genLabel = formatGeneratedAtLabel(art.generatedAt);
      const sessionId = s.resumeSessionId ?? s.auth?.sessionId;
      const filePath = s.resumeFilePath ?? (sessionId ? findSessionFile(sessionId) : undefined);
      const sessionRef = [sessionId, filePath].filter(Boolean).join(" / ") || l10n.t("Tab {0} (session not identified)", s.tabId);
      const prompt = [
        l10n.t("This finding is based on the analysis at {0} and does not match the current record.", genLabel),
        l10n.t("Review it and send it only if needed."),
        "",
        l10n.t("When improving, check how it relates to the current target and use only the material that still applies."),
        buildFindingSessionPrompt({
          analysisSdk: art.analysisSdk,
          sessionRef,
          models: art.executedModels,
          isoTime: new Date(art.generatedAt).toISOString(),
          finding,
        }),
      ].join("\n");

      st.post({ type: "composerPrefill", tabId: newSession.tabId, text: prompt });
      warmup(newSession);
      break;
    }
    case "selectAnalysisArtifact": {
      const s = target!;
      if (s.persistedArtifacts.some((a) => a.artifactId === msg.artifactId)) {
        s.selectedArtifactId = msg.artifactId;
        s.semantic.scheduleSemanticModelPost();
      }
      break;
    }
  }
}
