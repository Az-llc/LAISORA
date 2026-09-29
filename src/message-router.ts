import * as vscode from "vscode";

import { handleComposerMessage } from "./composer-io";
import { handleAnalysisMessage } from "./analysis-messages";
import { handleConversationMessage } from "./conversation-lifecycle";
import { handleHandoffMessage } from "./handoff-wiring";
import { handleResumeMessage } from "./resume-hydration";
import { handleSurfaceMessage } from "./store-surfaces";
import { runHostActionMessage, userSettingsMessage } from "./gateway-host-actions";

import { handleHistoryMessage } from "./history-serving";
import { output } from "./host-context";
import { handleInspectorMessage } from "./inspector-wiring";
import { handleSessionFileMessage } from "./session-list-wiring";
import { isWebviewToHost } from "./protocol";
import type { SessionStore } from "./store-surfaces";

export async function handleWebviewMessage(
  st: SessionStore,
  raw: unknown,
  sender: vscode.Webview
): Promise<void> {
  if (!isWebviewToHost(raw)) {
    output.appendLine(`[drop] invalid webview message: ${JSON.stringify(raw).slice(0, 200)}`);
    return;
  }
  const msg = raw;
  const target = "tabId" in msg ? st.sessions.get(msg.tabId) : undefined;
  if ("tabId" in msg && !target) {
    output.appendLine(`[drop] message for unknown tab: ${msg.type} ${msg.tabId}`);
    return;
  }
  try {
    switch (msg.type) {
      case "ready":
      case "webviewDiagnostic":
      case "activeTab":
      case "newTab":
      case "closeTab":
      case "clearTab":
        await handleSurfaceMessage(st, msg, sender, target);
        if (msg.type === "ready") void st.postTo(sender, userSettingsMessage());
        break;
      case "send":
      case "cancelAutoResume":
      case "interrupt":
      case "approvalDecision":
      case "setMode":
      case "setEffort":
      case "setModel":
        await handleConversationMessage(st, msg, target);
        break;
      case "startHandoff":
      case "getHandoffDetail":
      case "cancelHandoff":
      case "openHandoffSource":
        await handleHandoffMessage(st, msg, sender, target);
        break;
      case "queryFiles":
      case "pickFiles":
      case "openFile":
      case "exportTab":
      case "artifact/preview":
      case "openThemePicker":
      case "attachImage":
      case "removeAttachment":
        await handleComposerMessage(st, msg, target, sender);
        break;
      case "renameTab":
      case "listSessions":
      case "requestCachedUsage":
      case "sessionImageRequest":
      case "openSessionImage":
        await handleSessionFileMessage(st, msg, sender, target);
        break;
      case "agentInspectorRequest":
        await handleInspectorMessage(st, msg, sender, target);
        break;
      case "historyChunkRequest":
      case "conversationHistoryRequest":
      case "worklogTranscriptRequest":
        await handleHistoryMessage(st, msg, sender, target);
        break;
      case "runHostAction":
        await runHostActionMessage(msg);
        break;
      case "analyzeCurrent":
      case "llmAnalysisRequest":
      case "suggestSessionName":
      case "summarizeSession":
      case "setLlmAnalysisEnabled":
      case "startFindingSession":
      case "prepareHistoricalDraft":
      case "selectAnalysisArtifact":
        await handleAnalysisMessage(st, msg, sender, target);
        break;
      case "resumeSession":
      case "resumeHydrationRetry":
        await handleResumeMessage(st, msg, target);
        break;
    }
  } catch (e) {
    output.appendLine(`[error] ${String(e)}`);
    const errTarget = target ?? [...st.sessions.values()][0];
    if (errTarget) {
      errTarget.pushEvent({
        kind: "error",
        message: String(e),
        fatal: false,
      });
    }
    void st.postTo(sender, { type: "analysisFailed", kind: "script", ...("tabId" in msg ? { tabId: msg.tabId } : {}) });
  }
}
