import * as vscode from "vscode";
import { randomUUID } from "node:crypto";

import {
  AgentInspectorReadError,
  INSPECTOR_RESPONSE_BYTES,
  readAgentInspectorPage,
  releaseInspectorCursor,
} from "./agent-inspector";
import type { Session } from "./extension";
import { output } from "./host-context";
import {
  projectWorkModel,
  type AgentInspectorErrorReason,
  type WebviewToHost,
  type WorkAgentNode,
} from "./protocol";
import { inspectorSessionFile, inspectorSessionFileLookup, sessionIdForOutput } from "./session-files";
import type { SessionStore } from "./store-surfaces";

const inspectorRequests = new WeakMap<vscode.Webview, Map<string, string>>();
const inspectorSurfaceIds = new WeakMap<vscode.Webview, string>();

function inspectorSurfaceId(sender: vscode.Webview): string {
  let id = inspectorSurfaceIds.get(sender);
  if (!id) {
    id = randomUUID();
    inspectorSurfaceIds.set(sender, id);
  }
  return id;
}

function setLatestInspectorRequest(sender: vscode.Webview, tabId: string, requestId: string): void {
  let byTab = inspectorRequests.get(sender);
  if (!byTab) {
    byTab = new Map();
    inspectorRequests.set(sender, byTab);
  }
  byTab.set(tabId, requestId);
}

function isLatestInspectorRequest(sender: vscode.Webview, tabId: string, requestId: string): boolean {
  return inspectorRequests.get(sender)?.get(tabId) === requestId;
}

function findInspectorAgent(roots: readonly WorkAgentNode[], agentId: string): WorkAgentNode | undefined {
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (node.agentId === agentId) return node;
    stack.push(...node.children);
  }
  return undefined;
}

function inspectorAgentForSession(session: Session, agentId: string): WorkAgentNode | undefined {
  const model = projectWorkModel(session.workModel, session.restoredAgents);
  const roots = [...model.unlinkedAgents];
  for (const phase of model.phases) roots.push(...phase.agents);
  return findInspectorAgent(roots, agentId);
}

async function postInspectorError(
  st: SessionStore,
  sender: vscode.Webview,
  session: Session,
  agentId: string,
  requestId: string,
  reason: AgentInspectorErrorReason
): Promise<void> {
  await st.postTo(sender, {
    type: "agentInspectorError",
    tabId: session.tabId,
    agentId,
    requestId,
    generation: session.generation,
    reason,
  });
}

export async function handleInspectorMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "agentInspectorRequest" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "agentInspectorRequest": {
      const session = target!;
      const generation = session.generation;
      const sessionLookup = inspectorSessionFileLookup(session);
      const sessionFile = sessionLookup.path;
      const agent = inspectorAgentForSession(session, msg.agentId);
      setLatestInspectorRequest(sender, session.tabId, msg.requestId);
      if (!sessionFile) {
        const reason: AgentInspectorErrorReason =
          sessionLookup.reason === "scan_failed" ? "session-scan-failed" : "session-unavailable";
        output.appendLine(
          `[${session.title}] Inspector: ${reason} session=${sessionIdForOutput(session)} agent=${msg.agentId}` +
            (sessionLookup.reason === "scan_failed" ? ` — ${sessionLookup.detail}` : "")
        );
        await postInspectorError(st, sender, session, msg.agentId, msg.requestId, reason);
        break;
      }
      if (!agent) {
        await postInspectorError(st, sender, session, msg.agentId, msg.requestId, "agent-unavailable");
        break;
      }
      const toolUseId = agent.toolUseId;
      const requestStillValid = (): boolean => {
        const current = st.sessions.get(session.tabId);
        const currentAgent = current ? inspectorAgentForSession(current, msg.agentId) : undefined;
        return current === session && !session.closed && session.generation === generation &&
          isLatestInspectorRequest(sender, session.tabId, msg.requestId) &&
          currentAgent?.toolUseId === toolUseId && inspectorSessionFile(current) === sessionFile;
      };
      try {
        const result = await readAgentInspectorPage({
          sessionFilePath: sessionFile,
          toolUseId,
          agentTranscriptId: agent.origin === "restored" ? agent.agentId : undefined,
          section: msg.section,
          cursor: msg.cursor,
          scopeKey: `${inspectorSurfaceId(sender)}:${session.tabId}:${generation}`,
        });
        if (!requestStillValid()) {
          output.appendLine(`[${session.title}] Inspector応答を破棄: stale request ${msg.requestId}`);
          if (result.page.nextCursor !== undefined) releaseInspectorCursor(result.page.nextCursor);
          await postInspectorError(st, sender, session, msg.agentId, msg.requestId, "stale-request");
          break;
        }
        const response = {
          type: "agentInspectorResult" as const,
          tabId: session.tabId,
          agentId: msg.agentId,
          requestId: msg.requestId,
          generation,
          fingerprint: result.fingerprint,
          page: result.page,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > INSPECTOR_RESPONSE_BYTES) {
          if (result.page.nextCursor !== undefined) releaseInspectorCursor(result.page.nextCursor);
          await postInspectorError(st, sender, session, msg.agentId, msg.requestId, "response-too-large");
          break;
        }
        await st.postTo(sender, response);
      } catch (error) {
        const reason = error instanceof AgentInspectorReadError ? error.reason : "read-failed";
        const detail =
          error instanceof AgentInspectorReadError ? error.detail : String(error);
        output.appendLine(
          `[${session.title}] Inspector失敗: ${reason} session=${sessionIdForOutput(session)} agent=${msg.agentId}` +
            (detail === undefined ? "" : ` — ${detail}`)
        );
        if (requestStillValid()) {
          await postInspectorError(st, sender, session, msg.agentId, msg.requestId, reason);
        } else if (isLatestInspectorRequest(sender, session.tabId, msg.requestId)) {
          await postInspectorError(st, sender, session, msg.agentId, msg.requestId, "stale-request");
        }
      }
      break;
    }
  }
}
