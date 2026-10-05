import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { HandoffRunner } from "./handoff-runner";
import { claudeProjectsDir } from "./claude-env";
export { handleAnalysisMessage } from "./analysis-messages";
export { handleConversationMessage } from "./conversation-lifecycle";
export { handleHandoffMessage } from "./handoff-wiring";
export { handleSurfaceMessage } from "./store-surfaces";
export { readSessionTranscript } from "./session-transcript";
export { normalizeDriveLetter } from "./claude-settings";
export { reduceWorkModelSafely, trimEventLog } from "./event-fold";
export type { EventFoldDraft, FoldEffect, FoldEventResult } from "./event-fold";
import {
  artifactServer,
  disposeHooked,
  output,
  setActivationT0,
  setArtifactServer,
  setExtensionContext,
  setOutput,
  setStore,
  sinceActivation,
  store,
} from "./host-context";
import { initHostL10n } from "./l10n";
import { deleteOldLearningStore } from "./learning-startup";
import {
  llmAnalysisEnabled,
  llmDiagnosticsAudience,
  semanticViewEnabled,
} from "./session-semantic";
import { SessionStore, tabLimit } from "./store-surfaces";
import { handoffFs, handoffPersist, readHandoffRecords } from "./handoff-wiring";
import { personalBaseline, setPersonalBaselineListener } from "./personal-baseline";
import { PROTOCOL_VERSION } from "./protocol";
import { openResumedSession as resumePersistedTab } from "./resume-hydration";
import { lookupSessionFile } from "./session-files";
import {
  disposeAccountUsage,
  persistOpenTabs,
  readPersistedOpenTabs,
  releaseAccountUsageWaiter,
  restoreTabsOnStartupEnabled,
  type PersistedOpenTab,
} from "./session-list-wiring";
import { configuredSystemAppExtensions, userSettingsMessage } from "./gateway-host-actions";
export { settingsStateMessage, setExternalDetectorForTest } from "./gateway-host-actions";
import { openSettingsPanel, postSettingsState } from "./settings-panel";
import { postOrchestrationView } from "./conversation-lifecycle";
import { registerReadOnlyFileProvider } from "./composer-io";
export { Session, historyScopeKey, historyTranscriptScopeKey, isUnusedSession } from "./session";
export {
  createHydrationDraft,
  foldHistoryEvents,
  handleResumeMessage,
  openResumedSession,
} from "./resume-hydration";

export { modelRowsForSession } from "./gateway-models";

function affectsProductConfiguration(e: vscode.ConfigurationChangeEvent, key: string): boolean {
  return e.affectsConfiguration(`laisora.${key}`);
}

function ensureInitialTabs(st: SessionStore): void {
  if (st.sessions.size > 0) return;
  const entries = restoreTabsOnStartupEnabled() ? readPersistedOpenTabs() : [];
  if (entries.length === 0) {
    st.createSession();
    return;
  }
  void restorePersistedTabs(st, entries);
}

async function restorePersistedTabs(st: SessionStore, entries: PersistedOpenTab[]): Promise<void> {
  const notices: string[] = [];
  const started: Array<{ label: string; sessionId: string; outcome: ReturnType<typeof resumePersistedTab> }> = [];
  let skippedByLimit = 0;
  for (const entry of entries) {
    const label = entry.title ?? entry.sessionId;
    if (st.sessions.size >= tabLimit()) {
      skippedByLimit++;
      continue;
    }
    const lookup = lookupSessionFile(entry.sessionId);
    if (lookup.path === null) {
      if (lookup.reason === "scan_failed") {
        output.appendLine(`[restore] session lookup failed: ${entry.sessionId}: ${lookup.detail}`);
        notices.push(l10n.t(
          "Could not restore the tab \"{0}\": the record for session {1} could not be checked. Reopen it from the history list.",
          label,
          entry.sessionId
        ));
      } else {
        notices.push(l10n.t("Could not restore the tab \"{0}\": no record was found for session {1}.", label, entry.sessionId));
      }
      continue;
    }
    started.push({
      label,
      sessionId: entry.sessionId,
      outcome: resumePersistedTab(st, {
        sessionId: entry.sessionId,
        filePath: lookup.path,
        activate: started.length === 0,
        knownCwd: entry.cwd,
      }),
    });
  }
  if (skippedByLimit > 0) {
    notices.push(l10n.t("{0} tab(s) were not restored because the tab limit ({1}) was reached.", skippedByLimit, tabLimit()));
  }
  let restored = 0;
  for (const item of started) {
    const opened = await item.outcome;
    if (opened.session === undefined) {
      notices.push(l10n.t("Could not restore the tab \"{0}\" (session {1}).", item.label, item.sessionId));
    } else {
      restored++;
    }
  }
  if (st.sessions.size === 0) st.createSession();
  const first = st.sessions.values().next().value;
  if (first) {
    for (const message of notices) first.pushEvent({ kind: "error", message, fatal: false });
  }
  output.appendLine(`[restore] ${sinceActivation()} restored ${restored}/${entries.length} tab(s)`);
  void persistOpenTabs();
}

export function activate(context: vscode.ExtensionContext): void {
  activateReady(context);
}

function activateReady(context: vscode.ExtensionContext): void {
  initHostL10n();
  setActivationT0(Date.now());
  setExtensionContext(context);
  setPersonalBaselineListener(() => {
    if (!semanticViewEnabled()) return;
    for (const s of store?.sessions.values() ?? []) s.semantic.scheduleSemanticModelPost();
  });
  void personalBaseline();
  setOutput(vscode.window.createOutputChannel("LAISORA"));
  context.subscriptions.push(output);
  output.appendLine(`[startup] ${sinceActivation()} activate`);
  if (context.globalStorageUri?.fsPath) {
    void deleteOldLearningStore(context.globalStorageUri.fsPath, (line) => output.appendLine(line));
  }
  void HandoffRunner.sweepOrphans(
    { fs: handoffFs, persist: handoffPersist(), readRecords: readHandoffRecords, log: (line) => output.appendLine(line) },
    claudeProjectsDir()
  ).catch((e) => output.appendLine(`[startup] handoff の孤児回収に失敗: ${String(e)}`));
  context.subscriptions.push({
    dispose: () => {
      void artifactServer?.dispose();
      setArtifactServer(null);
    },
  });
  const readOnlyFiles = registerReadOnlyFileProvider();
  if (readOnlyFiles) context.subscriptions.push(readOnlyFiles);
  context.subscriptions.push(
    vscode.commands.registerCommand("laisora.open", () => openPanel(context)),
    vscode.commands.registerCommand("laisora.openSettings", () => openSettingsPanel(context))
  );
  const displayConfigSub = vscode.workspace.onDidChangeConfiguration?.((e) => {
    if (["enabled", "agents", "externalTimeoutMinutes", "conductorPolicy"]
      .some((key) => affectsProductConfiguration(e, `orchestration.${key}`))) {
      for (const session of store?.sessions.values() ?? []) postOrchestrationView(session);
    }
    if (affectsProductConfiguration(e, "composer.sendKey") || affectsProductConfiguration(e, "appearance")) store?.post(userSettingsMessage());
    if (
      affectsProductConfiguration(e, "appearance") ||
      affectsProductConfiguration(e, "composer.sendKey") ||
      affectsProductConfiguration(e, "claude.apiKeyPolicy") ||
      affectsProductConfiguration(e, "claude.initialModel") ||
      affectsProductConfiguration(e, "restoreTabsOnStartup") ||
      affectsProductConfiguration(e, "learning.profileSources") ||
      affectsProductConfiguration(e, "claude.fileLinkInstruction") ||
      affectsProductConfiguration(e, "claude.planInstruction") ||
      affectsProductConfiguration(e, "fileLinks.openWithSystemApp") ||
      affectsProductConfiguration(e, "fileLinks.revealInExplorer") ||
      affectsProductConfiguration(e, "fileLinks.allowOutsideWorkspace") ||
      affectsProductConfiguration(e, "fileLinks.confirmOutsideWorkspace") ||
      affectsProductConfiguration(e, "fileLinks.openOutsideReadOnly") ||
      affectsProductConfiguration(e, "orchestration.enabled") ||
      affectsProductConfiguration(e, "orchestration.agents") ||
      affectsProductConfiguration(e, "orchestration.externalTimeoutMinutes") ||
      affectsProductConfiguration(e, "orchestration.conductorPolicy")
    ) {
      postSettingsState();
    }
    const llmAnalysis = affectsProductConfiguration(e, "workLog.llmAnalysis");
    const semanticView = affectsProductConfiguration(e, "workLog.semanticView");
    const llmDiagnostics = affectsProductConfiguration(e, "workLog.llmAnalysisDiagnostics");
    const affects = llmAnalysis || semanticView || llmDiagnostics;
    if (!affects) return;
    if (!store) return;
    if (llmAnalysis && !llmAnalysisEnabled()) {
      for (const s of store.sessions.values()) s.abortLlmAnalysisRun();
    }
    if (llmAnalysis && !semanticView && !llmDiagnostics && llmDiagnosticsAudience() === "off") {
      const enabled = llmAnalysisEnabled();
      store.post({ type: "llmAnalysisSetting", enabled });
      for (const s of store.sessions.values()) {
        if (semanticViewEnabled()) {
          s.semantic.scheduleSemanticModelPost();
        }
      }
      return;
    }
    store.post({ type: "init", protocolVersion: PROTOCOL_VERSION, tabs: store.snapshotAll(), hostWindows: process.platform === "win32", systemAppExtensions: configuredSystemAppExtensions() });
  });
  if (displayConfigSub) context.subscriptions.push(displayConfigSub);
  let selTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.uri.scheme !== "file") return;
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = e.selections[0];
        if (!sel) return;
        store?.post({
          type: "editorContext",
          path: vscode.workspace.asRelativePath(e.textEditor.document.uri),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
        });
      }, 300);
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "laisora.home",
      {
        resolveWebviewView(view: vscode.WebviewView): void {
          const guard = guardMessage();
          if (guard) {
            const tokensUri = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "tokens.css"));
            view.webview.html = `<html><head><link rel="stylesheet" href="${tokensUri}"></head><body class="l-surface"><p>${guard}</p></body></html>`;
            return;
          }
          const st = store ?? new SessionStore();
          setStore(st);
          ensureInitialTabs(st);
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
              vscode.Uri.joinPath(context.extensionUri, "dist"),
              vscode.Uri.joinPath(context.extensionUri, "media"),
            ],
          };
          st.attach(view.webview);
          view.webview.html = buildHtml(context, view.webview);
          view.onDidChangeVisibility(() => st.setVisible(view.webview, view.visible));
          if (!disposeHooked.has(view)) {
            disposeHooked.add(view);
            view.onDidDispose(() => {
              releaseAccountUsageWaiter(view.webview);
              store?.detach(view.webview);
            });
          }
        },
      },
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  );
}

export type { SessionStore } from "./store-surfaces";

export { sessionsForTest } from "./store-surfaces";
export { appendSessionRecordOnFreshLine as appendSessionRecordForTest } from "./session-files";
export { persistInitialTabTitle as persistInitialTabTitleForTest, setInitialTabTitle as setInitialTabTitleForTest } from "./session-list-wiring";

function guardMessage(): string | null {
  if (vscode.env.remoteName) {
    return l10n.t(
      "LAISORA is for local desktop use only (current: {0}). Remote / WSL / Dev Container are not supported. Reopen it in a local window.",
      vscode.env.remoteName
    );
  }
  if (!vscode.workspace.isTrusted) {
    return l10n.t(
      "LAISORA: This workspace is not trusted, so LAISORA cannot start. Grant trust with \"Workspaces: Manage Workspace Trust\" from the Command Palette, then reload the window."
    );
  }
  return null;
}

function openPanel(context: vscode.ExtensionContext): void {
  const guard = guardMessage();
  if (guard) {
    void vscode.window.showErrorMessage(guard);
    return;
  }

  if (store?.panel) {
    store.panel.reveal();
    return;
  }

  const st = store ?? new SessionStore();
  setStore(st);
  ensureInitialTabs(st);

  const panel = vscode.window.createWebviewPanel("laisora", "LAISORA", vscode.ViewColumn.One, {
    enableScripts: true,
    enableFindWidget: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "dist"),
      vscode.Uri.joinPath(context.extensionUri, "media"),
    ],
  });
  st.panel = panel;
  st.attach(panel.webview);
  panel.webview.html = buildHtml(context, panel.webview);
  panel.onDidChangeViewState(() => st.setVisible(panel.webview, panel.visible));

  panel.onDidDispose(() => {
    releaseAccountUsageWaiter(panel.webview);
    if (store) {
      store.detach(panel.webview);
      store.panel = null;
    }
  });

  context.subscriptions.push(panel);
}

function buildHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js")
  );
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "main.css")
  );
  const bootstrapScript = `
(() => {
  const state = {
    completed: false,
    failed: false,
    timer: undefined,
    complete() {
      this.completed = true;
      if (this.timer !== undefined) window.clearTimeout(this.timer);
      this.timer = undefined;
    },
  };
  window.__laisoraBootstrap = state;

  const describe = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    return String(value || "unknown");
  };
  const renderFailure = (message) => {
    const app = document.getElementById("app");
    if (!app) return;
    app.textContent = "";
    const panel = document.createElement("section");
    panel.className = "bootstrap-failure";
    panel.setAttribute("role", "alert");
    panel.setAttribute("aria-labelledby", "bootstrap-failure-title");
    const title = document.createElement("h2");
    title.id = "bootstrap-failure-title";
    title.textContent = ${JSON.stringify(l10n.t("Could not initialize LAISORA"))};
    const guidance = document.createElement("p");
    guidance.textContent = ${JSON.stringify(l10n.t("Reload the window. If the problem persists, check LAISORA in the Output panel."))};
    const detail = document.createElement("p");
    detail.className = "bootstrap-failure-detail";
    detail.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "primary";
    retry.textContent = ${JSON.stringify(l10n.t("Reload"))};
    retry.addEventListener("click", () => window.location.reload());
    panel.append(title, guidance, detail, retry);
    app.appendChild(panel);
    retry.focus();
  };
  const fail = (message) => {
    if (state.completed || state.failed) return;
    state.failed = true;
    const detail = String(message || "Webview bootstrap failed").slice(0, 2000);
    try {
      // acquireVsCodeApi() は Webview ごとに1回しか呼べない。先行 bootstrap 自身は取得せず、
      // main bundle が取得済みならそのハンドルだけを使う。bundle 未ロード時は Host timeout が記録する。
      window.__laisoraVscodeApi?.postMessage({ type: "webviewDiagnostic", kind: "error", message: detail });
    } catch {
      // Host 側の timeout が、postMessage 自体を使えない故障を記録する。
    }
    renderFailure(detail);
  };

  window.addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) {
      fail("Webview bootstrap error: " + describe(event.error || event.message));
      return;
    }
    const target = event.target;
    if (target instanceof HTMLScriptElement && target.id === "laisora-main-script") {
      fail("Webview bundle load failed: " + target.src);
    }
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    fail("Webview bootstrap rejection: " + describe(event.reason));
  });

  state.timer = window.setTimeout(() => {
    fail("Webview bootstrap timeout: bundle did not reach ready");
  }, 4000);
})();`;
  const htmlLang = String(vscode.env.language ?? "").toLowerCase().startsWith("ja") ? "ja" : "en";
  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src data:; form-action 'none'; base-uri 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>LAISORA</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" data-laisora-bootstrap>${bootstrapScript}</script>
<script id="laisora-main-script" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export async function deactivate(): Promise<void> {
  disposeAccountUsage();
  if (store) {
    for (const s of store.sessions.values()) {
      s.semantic.clearSemanticModelPostTimer();
      s.guardrailRunner.clearGuardrailRefreshTimer();
      s.guardrailRunner.clearGuardrailTickTimer();
      s.discardLlmAnalysis();
    }
  }
  await Promise.all([
    ...(store ? [...store.sessions.values()].map((s) => s.disposeConversation()) : []),
    artifactServer?.dispose(),
    persistOpenTabs(),
  ]);
  setArtifactServer(null);
}

export { buildFindingSessionPrompt } from "./llm-report";
