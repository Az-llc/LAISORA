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
  persistOpenTabs,
  readPersistedOpenTabs,
  restoreTabsOnStartupEnabled,
  type PersistedOpenTab,
} from "./session-list-wiring";
import { configuredSystemAppExtensions, userSettingsMessage } from "./gateway-host-actions";
export { settingsStateMessage, setExternalDetectorForTest } from "./gateway-host-actions";
import { openSettingsPanel, postSettingsState } from "./settings-panel";
import { postOrchestrationView } from "./conversation-lifecycle";
import { registerReadOnlyFileProvider } from "./composer-io";
// 公開面と検証ハーネスの互換性を保つ再 export。Host 内部は各所有モジュールを直接参照する。
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

// 最初のタブを用意する。activity bar の view と panel コマンドは同じ activation で両方通るので、
// 既にタブがあれば何もしない（復元の二重実行でタブが重複する。R-SES-01）
function ensureInitialTabs(st: SessionStore): void {
  if (st.sessions.size > 0) return;
  const entries = restoreTabsOnStartupEnabled() ? readPersistedOpenTabs() : [];
  if (entries.length === 0) {
    st.createSession();
    return;
  }
  void restorePersistedTabs(st, entries);
}

// 前回開いていたタブを履歴からの再開と同じ経路（openResumedSession）で開き直す。
// 記録の位置は lookupSessionFile だけで解き、「無い」と「確かめられなかった」を別の文で出す（R-37 / R-DSP-01）。
// 復元できなかった分は黙って落とさず、先頭のタブへ 1 行ずつ残す
async function restorePersistedTabs(st: SessionStore, entries: PersistedOpenTab[]): Promise<void> {
  const notices: string[] = [];
  const started: Array<{ label: string; sessionId: string; outcome: ReturnType<typeof resumePersistedTab> }> = [];
  let skippedByLimit = 0;
  for (const entry of entries) {
    const label = entry.title ?? entry.sessionId;
    // タブ上限は履歴からの再開と同じ値（R-SES-03）。scope 上限はタブ数から導出される（R-SES-04）
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
    // openResumedSession は最初の await より前にタブを作るので、保存順がそのままタブ順になる
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
  // 前回の異常終了で残った引き継ぎ用 fork を回収する（完成品は残す）
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
  // semanticView / llmAnalysisDiagnostics の「明示off」は snapshot でしか運べない。
  // ?. は検証ハーネスの偽 vscode が onDidChangeConfiguration を持たないため
  const displayConfigSub = vscode.workspace.onDidChangeConfiguration?.((e) => {
    if (["enabled", "agents", "externalTimeoutMinutes", "conductorPolicy"]
      .some((key) => affectsProductConfiguration(e, `orchestration.${key}`))) {
      for (const session of store?.sessions.values() ?? []) postOrchestrationView(session);
    }
    // settings.json を直接編集した変更も設定画面と入力欄へ届ける（R-DSP-01）
    if (affectsProductConfiguration(e, "composer.sendKey") || affectsProductConfiguration(e, "appearance")) store?.post(userSettingsMessage());
    if (
      affectsProductConfiguration(e, "appearance") ||
      affectsProductConfiguration(e, "composer.sendKey") ||
      affectsProductConfiguration(e, "claude.apiKeyPolicy") ||
      affectsProductConfiguration(e, "restoreTabsOnStartup") ||
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
    // off にした時点で進行中の生成を止める。attach 済みの結果は落とさない（裁定: 支払い済みの
    // 結果は on へ戻したときに再利用できる）。診断表示のキーをこの条件へ混ぜると、表示を
    // 切り替えただけで飛行中の分析が中断される
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
  // エディタの選択をWebviewへ通知（Claude拡張のファイル/行コンテキスト相当。300msデバウンス）
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

  // アクティビティバーのアイコン → サイドバーに直接チャットUIを出す（WebviewView。
  // ランチャーのワンクッションは置かない）
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
          // HTML 設定直後に Webview が ready を送れるため、受信口を必ず先に開く。
          // 逆順だと高速な初期化時に最初の ready を取りこぼす。
          st.attach(view.webview);
          view.webview.html = buildHtml(context, view.webview);
          view.onDidChangeVisibility(() => st.setVisible(view.webview, view.visible));
          // タブ切替では resolveWebviewView は再実行されず iframe だけが作り直される（VS Code 1.133.0 実測）。
          // 復帰の init は上の onDidChangeVisibility が即時に送り、作り直された document 発の
          // ready 由来は短い窓の間だけ抑止される（sol-12。契約は SessionStore.restoreVisible /
          // initForReady 側）。onDidDispose はビュー自体が破棄されるときの契約なので、
          // ここでの登録は1ビュー1回で足りる。
          if (!disposeHooked.has(view)) {
            disposeHooked.add(view);
            view.onDidDispose(() => {
              store?.detach(view.webview);
            });
          }
        },
      },
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  );
}

// host-context.ts が store の型として使う。値として export すると束ね後の export 面が増える
export type { SessionStore } from "./store-surfaces";

// ハーネスが mod.sessionsForTest() で観測する口。移動先ではなく extension.ts の export 面に
// 居ることが前提なので、束ねの入口が変わっても再 export を外さない
export { sessionsForTest } from "./store-surfaces";

// Remote / workspace trust ゲート。問題があれば理由文字列を返す。
function guardMessage(): string | null {
  // 拒否理由だけでなく、利用者が次に取るべき操作まで文面に含める。
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
    // U-32: Ctrl+F を VS Code 標準の検索ウィジェットに任せる（WebviewPanel でのみ使える）
    enableFindWidget: true,
    // retainContextWhenHidden は使わない。復元は snapshot 再送で行う。
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "dist"),
      vscode.Uri.joinPath(context.extensionUri, "media"),
    ],
  });
  st.panel = panel;
  // Sidebar と同じく、HTML を評価可能にする前に ready の受信口を開く。
  st.attach(panel.webview);
  panel.webview.html = buildHtml(context, panel.webview);
  // パネルは onDidChangeVisibility を持たない（可視性は onDidChangeViewState 側）
  panel.onDidChangeViewState(() => st.setVisible(panel.webview, panel.visible));

  panel.onDidDispose(() => {
    if (store) {
      // パネルを閉じたら、パネルを開く前に繋がっていたサイドバーへ配信を戻す
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
  // webview の表示言語の正本は documentElement.lang。判定は src/webview/l10n-boot.ts
  // #selectWebviewL10nBundle と同一（ja 前方一致だけが ja、他は既定の英語）
  const htmlLang = String(vscode.env.language ?? "").toLowerCase().startsWith("ja") ? "ja" : "en";
  // CSP: nonce 必須・外部接続なし
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
