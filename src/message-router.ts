import * as vscode from "vscode";

import { handleComposerMessage } from "./composer-io";
import { setComposerFocus } from "./composer-paste";
import { handleAnalysisMessage } from "./analysis-messages";
import { handleConversationMessage } from "./conversation-lifecycle";
import { openEditDiff } from "./edit-diff-host";
import { handleHandoffMessage, noteComposerDrafts } from "./handoff-wiring";
import { handleResumeMessage } from "./resume-hydration";
import { handleSurfaceMessage, reorderSessionTabs } from "./store-surfaces";
import { runHostActionMessage, userSettingsMessage, welcomeActionMessage } from "./gateway-host-actions";

import { handleHistoryMessage } from "./history-serving";
import { output } from "./host-context";
import { handleInspectorMessage } from "./inspector-wiring";
import { handleSessionFileMessage } from "./session-list-wiring";
import { handleTodoMessage, openTodoConversation, setTodoDrawerFocus } from "./todo-surface";
import { isWebviewToHost, rejectedTodoEditId } from "./protocol";
import type { SessionStore } from "./store-surfaces";

export async function handleWebviewMessage(
  st: SessionStore,
  raw: unknown,
  sender: vscode.Webview
): Promise<void> {
  if (!isWebviewToHost(raw)) {
    output.appendLine(`[drop] invalid webview message: ${JSON.stringify(raw).slice(0, 200)}`);
    const requestId = rejectedTodoEditId(raw);
    if (requestId !== undefined) void st.postTo(sender, { type: "todoEditResult", requestId, ok: false, error: "rejected" });
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
      case "setRemoteControl":
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
      case "copyFilePath":
      case "exportTab":
      case "artifact/preview":
      case "openThemePicker":
      case "attachImage":
      case "removeAttachment":
        await handleComposerMessage(st, msg, target, sender);
        break;
      case "openEditDiff":
        await openEditDiff(target!, msg);
        break;
      case "renameTab":
      case "renameSession":
      case "setSessionHidden":
      case "listSessions":
      case "requestAccountUsage":
      case "accountUsagePanelClosed":
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
      case "composerFocus":
        setComposerFocus(sender, msg.focused);
        break;
      case "composerDrafts":
        noteComposerDrafts(sender, msg.tabIds);
        break;
      case "runHostAction":
        await runHostActionMessage(msg);
        break;
      case "welcomeAction":
        await welcomeActionMessage(msg);
        break;
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
      case "todoEdit":
      case "todoDetailRequest":
      case "todoLogRequest":
      case "todoSectionOrder":
      case "todoImageRequest":
      case "todoOpenDoc":
      case "todoAskSourceRequest":
      case "todoAskDismiss":
      case "todoChangesRequest":
        await handleTodoMessage(msg, sender);
        break;
      case "todoDrawerFocus":
        setTodoDrawerFocus(sender, msg.focused);
        break;
      case "reorderTabs":
        reorderSessionTabs(st, msg.order, sender);
        break;
      case "todoOpenConversation":
        await openTodoConversation(st, msg, sender);
        break;
      default: {
        const unrouted: never = msg;
        output.appendLine(`[drop] unrouted webview message: ${(unrouted as { type: string }).type}`);
      }
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
  }
}
