import { getLaisoraConfiguration } from "./claude-settings";
import { configuredSystemAppExtensions } from "./gateway-host-actions";
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

import { createAnalysisFileStorage } from "./analysis-file-storage";
import type { AnalysisStorage } from "./analysis-persistence";
import { ClaudeConversation } from "./claudeHost";
import { postAttachments } from "./composer-io";
import { releaseConversationHistory } from "./conversation-history";
import { postOrchestrationView, warmup } from "./conversation-lifecycle";
import { handoffDetailSources } from "./handoff-wiring";
import { orchestrationRunsDirectoryOf } from "./orchestration-external";
import { releaseHistoryWindow } from "./history-window";
import { extensionContext, output, sinceActivation, store } from "./host-context";
import { handleWebviewMessage } from "./message-router";
import { pendingAttachments } from "./pending-attachments";
import { PROTOCOL_VERSION, type HostToWebview, type TabSnapshot, type WebviewToHost } from "./protocol";
import { historyScopeKey, historyTranscriptScopeKey, Session } from "./session";
import { persistOpenTabs } from "./session-list-wiring";
import { postSettingsState } from "./settings-panel";
import { TAB_LIMIT_DEFAULT, resolveTabLimit, scopeMaxForTabs } from "./tab-limits";

export const RESTORE_TAIL_EVENT_MAX = 150;

const WEBVIEW_BOOTSTRAP_TIMEOUT_MS = 5000;
const INIT_COALESCE_WINDOW_MS = 300;
const RESTORE_INIT_SUPPRESS_MS = 800;

interface WebviewSurface {
  sub: vscode.Disposable;
  visible: boolean;
  bootstrapTimer?: ReturnType<typeof setTimeout>;
  initInFlight: boolean;
  readyInitAt?: number;
  restoreInitAt?: number;
  restoredInitPosted?: boolean;
  activeTabId?: string;
  fillQueue?: string[];
  fillTimer?: ReturnType<typeof setTimeout>;
}

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  readonly analysisStorage: AnalysisStorage;
  readonly rosterEvidenceDirectory: string | undefined;
  readonly orchestrationRunsDirectory: string | undefined;
  activeWebview: vscode.Webview | null = null;
  panel: vscode.WebviewPanel | null = null;
  private tabCounter = 0;

  constructor(storage?: AnalysisStorage) {
    const inMemory = new Map<string, unknown>();
    const fallback: AnalysisStorage =
      storage ??
      (extensionContext?.globalState
        ? {
            get: (k) => extensionContext!.globalState.get(k),
            update: async (k, v) => {
              await extensionContext!.globalState.update(k, v);
            },
          }
        : {
            get: (k) => inMemory.get(k),
            update: async (k, v) => {
              if (v === undefined) inMemory.delete(k);
              else inMemory.set(k, v);
            },
          });
    this.analysisStorage = !storage && extensionContext?.globalStorageUri?.fsPath
      ? createAnalysisFileStorage(vscode.Uri.joinPath(extensionContext.globalStorageUri, "analysis-results").fsPath, (line) => output.appendLine(line))
      : fallback;
    this.rosterEvidenceDirectory = !storage && extensionContext?.globalStorageUri?.fsPath
      ? vscode.Uri.joinPath(extensionContext.globalStorageUri, "roster-evidence").fsPath
      : undefined;
    this.orchestrationRunsDirectory = !storage ? orchestrationRunsDirectoryOf(extensionContext?.globalStorageUri?.fsPath) : undefined;
  }

  private readonly surfaces = new Map<vscode.Webview, WebviewSurface>();
  private previousWebview: vscode.Webview | null = null;

  post(msg: HostToWebview): void {
    for (const webview of this.surfaces.keys()) void this.postTo(webview, msg);
  }

  postTo(webview: vscode.Webview | null, msg: HostToWebview): Promise<boolean> {
    if (!webview) return Promise.resolve(false);
    if (this.surfaces.get(webview)?.visible === false) return Promise.resolve(false);
    return Promise.resolve(webview.postMessage(msg)).then((delivered) => {
      if (delivered && (msg.type === "init" || msg.type === "tabRestored")) {
        const tabIds = msg.type === "init" ? msg.tabs.map((tab) => tab.tabId) : [msg.tab.tabId];
        for (const tabId of tabIds) {
          const session = this.sessions.get(tabId);
          if (session) postOrchestrationView(session);
        }
      }
      if (!delivered) output.appendLine(`[webview] postMessage dropped: ${msg.type}`);
      return delivered === true;
    }, (error: unknown) => {
      output.appendLine(`[webview] postMessage failed: ${String(error)}`);
      return false;
    });
  }

  attach(webview: vscode.Webview): void {
    if (this.activeWebview && this.activeWebview !== webview) {
      this.previousWebview = this.activeWebview;
    }
    this.activeWebview = webview;
    if (this.surfaces.has(webview)) return;
    const surface: WebviewSurface = {
      sub: webview.onDidReceiveMessage((raw: unknown) => {
        void handleWebviewMessage(this, raw, webview);
      }),
      visible: true,
      initInFlight: false,
    };
    this.surfaces.set(webview, surface);
    this.armBootstrapTimeout(webview);
  }

  private armBootstrapTimeout(webview: vscode.Webview): void {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    if (surface.bootstrapTimer !== undefined) clearTimeout(surface.bootstrapTimer);
    surface.bootstrapTimer = setTimeout(() => {
      surface.bootstrapTimer = undefined;
      if (!this.surfaces.has(webview)) return;
      output.appendLine(
        `[webview] Webview bootstrap timeout: ready not received within ${WEBVIEW_BOOTSTRAP_TIMEOUT_MS}ms`
      );
    }, WEBVIEW_BOOTSTRAP_TIMEOUT_MS);
  }

  markReady(webview: vscode.Webview): void {
    const surface = this.surfaces.get(webview);
    if (surface?.bootstrapTimer === undefined) return;
    clearTimeout(surface.bootstrapTimer);
    surface.bootstrapTimer = undefined;
  }

  async initForReady(webview: vscode.Webview): Promise<void> {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    const sinceRestore = surface.restoreInitAt === undefined ? undefined : Date.now() - surface.restoreInitAt;
    if (sinceRestore !== undefined && sinceRestore < RESTORE_INIT_SUPPRESS_MS) {
      output.appendLine(
        `[webview] ${sinceActivation()} init suppressed (cause=ready, sinceRestore=${sinceRestore}ms)`
      );
      return;
    }
    const sinceDelivered = surface.readyInitAt === undefined ? undefined : Date.now() - surface.readyInitAt;
    if (surface.initInFlight || (sinceDelivered !== undefined && sinceDelivered < INIT_COALESCE_WINDOW_MS)) {
      output.appendLine(
        `[webview] ${sinceActivation()} init coalesced (cause=ready, inFlight=${surface.initInFlight})`
      );
      return;
    }
    surface.initInFlight = true;
    this.cancelRestoreFill(webview);
    try {
      const plan = surface.restoredInitPosted === true ? this.restoreInitPlan(surface) : undefined;
      const delivered = await this.postTo(webview, {
        type: "init",
        protocolVersion: PROTOCOL_VERSION,
        hostWindows: process.platform === "win32",
        systemAppExtensions: configuredSystemAppExtensions(),
        tabs: plan?.tabs ?? this.snapshotAll(),
      });
      if (delivered) surface.readyInitAt = Date.now();
      output.appendLine(
        `[webview] ${sinceActivation()} ${delivered ? "init sent" : "init not delivered"} (cause=ready, ` +
          `deferred=${plan?.deferredTabIds.length ?? 0}, omittedHead=${plan?.omittedHeadCount ?? 0})`
      );
      if (plan !== undefined && plan.deferredTabIds.length > 0) {
        this.scheduleRestoreFill(webview, plan.deferredTabIds);
      }
    } finally {
      surface.initInFlight = false;
    }
  }

  setVisible(webview: vscode.Webview, visible: boolean): void {
    const surface = this.surfaces.get(webview);
    if (!surface || surface.visible === visible) return;
    surface.visible = visible;
    output.appendLine(`[webview] ${sinceActivation()} visibility=${visible}`);
    if (visible) {
      this.armBootstrapTimeout(webview);
      this.restoreVisible(webview, true);
    } else {
      surface.readyInitAt = undefined;
      surface.restoreInitAt = undefined;
      surface.restoredInitPosted = undefined;
      this.cancelRestoreFill(webview);
    }
  }

  restoreVisible(webview: vscode.Webview, armSuppression = false): void {
    const surface = this.surfaces.get(webview);
    const postedAt = Date.now();
    if (armSuppression && surface) surface.restoreInitAt = postedAt;
    if (surface) surface.restoredInitPosted = true;
    const plan = this.restoreInitPlan(surface);
    this.cancelRestoreFill(webview);
    void this.postTo(webview, {
      type: "init",
      protocolVersion: PROTOCOL_VERSION,
      hostWindows: process.platform === "win32",
      systemAppExtensions: configuredSystemAppExtensions(),
      tabs: plan.tabs,
    }).then((delivered) => {
      if (!delivered && surface && surface.restoreInitAt === postedAt) surface.restoreInitAt = undefined;
      output.appendLine(
        `[webview] ${sinceActivation()} init posted (cause=restore, delivered=${delivered}, ` +
          `deferred=${plan.deferredTabIds.length}, omittedHead=${plan.omittedHeadCount})`
      );
    });
    if (plan.deferredTabIds.length > 0) this.scheduleRestoreFill(webview, plan.deferredTabIds);
  }

  private restoreInitPlan(
    surface: WebviewSurface | undefined
  ): { tabs: TabSnapshot[]; deferredTabIds: string[]; omittedHeadCount: number } {
    const all = [...this.sessions.values()];
    const activeTabId = this.restoreActiveTabId(surface, all);
    if (activeTabId === undefined) {
      return { tabs: this.snapshotAll(), deferredTabIds: [], omittedHeadCount: 0 };
    }
    const tabs: TabSnapshot[] = [];
    const deferredTabIds: string[] = [];
    let omittedHeadCount = 0;
    for (const s of all) {
      if (s.tabId === activeTabId) {
        const snap = s.restoreSnapshot();
        omittedHeadCount = snap.state.headOmitted?.count ?? 0;
        tabs.push(snap);
        continue;
      }
      tabs.push(s.deferredSnapshot());
      deferredTabIds.push(s.tabId);
    }
    return { tabs, deferredTabIds, omittedHeadCount };
  }

  private restoreActiveTabId(
    surface: WebviewSurface | undefined,
    all: readonly Session[]
  ): string | undefined {
    if (all.length === 1) return all[0].tabId;
    const activeTabId = surface?.activeTabId;
    if (activeTabId === undefined || !this.sessions.has(activeTabId)) return undefined;
    return activeTabId;
  }

  noteActiveTab(webview: vscode.Webview, tabId: string): void {
    const surface = this.surfaces.get(webview);
    if (surface) surface.activeTabId = tabId;
  }

  activeTabIdOf(webview: vscode.Webview): string | undefined {
    return this.surfaces.get(webview)?.activeTabId;
  }

  private scheduleRestoreFill(webview: vscode.Webview, tabIds: string[]): void {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    surface.fillQueue = [...tabIds];
    surface.fillTimer = setTimeout(() => this.drainRestoreFill(webview), 0);
  }

  private drainRestoreFill(webview: vscode.Webview): void {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    surface.fillTimer = undefined;
    const tabId = surface.fillQueue?.shift();
    if (tabId === undefined) return;
    const s = this.sessions.get(tabId);
    if (s) void this.postTo(webview, { type: "tabRestored", tab: s.snapshotForSurface() });
    surface.fillTimer = setTimeout(() => this.drainRestoreFill(webview), 0);
  }

  private cancelRestoreFill(webview: vscode.Webview): void {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    if (surface.fillTimer !== undefined) clearTimeout(surface.fillTimer);
    surface.fillTimer = undefined;
    surface.fillQueue = undefined;
  }
  detach(webview: vscode.Webview): void {
    const surface = this.surfaces.get(webview);
    if (surface?.bootstrapTimer !== undefined) clearTimeout(surface.bootstrapTimer);
    this.cancelRestoreFill(webview);
    surface?.sub.dispose();
    this.surfaces.delete(webview);
    if (this.previousWebview === webview) this.previousWebview = null;
    if (this.activeWebview !== webview) return;
    const fallback = this.previousWebview && this.surfaces.has(this.previousWebview)
      ? this.previousWebview : this.surfaces.keys().next().value ?? null;
    this.previousWebview = null;
    this.activeWebview = fallback;
    if (fallback) this.restoreVisible(fallback);
  }
  createSession(): Session {
    const s = new Session(this, ++this.tabCounter);
    this.sessions.set(s.tabId, s);
    postSettingsState();
    return s;
  }

  snapshotAll(): TabSnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshotForSurface());
  }

  llmAnalysisInFlightCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) if (s.llmRun !== null) count++;
    return count;
  }
}

export function warnTabLimit(): void {
  void vscode.window.showWarningMessage(l10n.t("LAISORA: The tab limit ({0}) has been reached.", tabLimit()));
}

export function tabLimit(): number {
  let raw: unknown = TAB_LIMIT_DEFAULT;
  try {
    raw = getLaisoraConfiguration().get<unknown>("tabLimit", TAB_LIMIT_DEFAULT);
  } catch {
    raw = TAB_LIMIT_DEFAULT;
  }
  return resolveTabLimit(raw);
}

export function currentScopeMax(): number {
  return scopeMaxForTabs(tabLimit(), store?.sessions.size ?? 0);
}

export function openNewConversationTab(st: SessionStore, initialize?: (session: Session) => void): Session | undefined {
  if (st.sessions.size >= tabLimit()) {
    warnTabLimit();
    return undefined;
  }
  const session = st.createSession();
  initialize?.(session);
  st.post({ type: "tabCreated", tab: session.snapshot(), activate: true });
  warmup(session);
  return session;
}

export function sessionsForTest(): Session[] {
  return store ? [...store.sessions.values()] : [];
}

export async function handleSurfaceMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "ready" | "webviewDiagnostic" | "activeTab" | "newTab" | "closeTab" | "clearTab" }>,
  sender: vscode.Webview,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "ready": {
      st.markReady(sender);
      output.appendLine(`[webview] ${sinceActivation()} ready received`);
      await st.initForReady(sender);
      const dropped = pendingAttachments.sweep(new Set(st.sessions.keys()));
      if (dropped.length > 0) {
        output.appendLine(`[attachment] released ${dropped.length} orphan slot(s)`);
      }
      for (const tabId of pendingAttachments.tabIdsWithAttachments()) {
        postAttachments(st, tabId);
      }
      for (const s of st.sessions.values()) {
        if (s.resuming && s.hydration === null) continue;
        warmup(s);
      }
      break;
    }
    case "webviewDiagnostic":
      output.appendLine(`[webview] ${msg.kind}: ${msg.message}`);
      break;
    case "activeTab":
      st.noteActiveTab(sender, msg.tabId);
      break;
    case "newTab": {
      openNewConversationTab(st);
      break;
    }
    case "closeTab": {
      target!.closed = true;
      target!.cancelResumePreparation();
      pendingAttachments.release(msg.tabId);
      handoffDetailSources.delete(target!.tabId);
      target!.semantic.clearSemanticModelPostTimer();
      target!.guardrailRunner.clearGuardrailRefreshTimer();
      target!.discardLlmAnalysis();
      releaseHistoryWindow(historyScopeKey(target!));
      releaseHistoryWindow(historyTranscriptScopeKey(target!));
      releaseConversationHistory(historyScopeKey(target!));
      st.sessions.delete(msg.tabId);
      void persistOpenTabs();
      const replacement = st.sessions.size === 0 ? st.createSession() : null;
      if (replacement) st.post({ type: "tabCreated", tab: replacement.snapshot(), activate: true });
      st.post({ type: "tabClosed", tabId: msg.tabId });
      postSettingsState();
      void target!
        .disposeConversation()
        .then(() => output.appendLine(`[${target!.title}] タブ閉鎖: dispose 完了`))
        .catch((e) => output.appendLine(`[${target!.title}] タブ閉鎖: dispose 失敗 ${String(e)}`));
      if (replacement) warmup(replacement);
      break;
    }
    case "clearTab": {
      const s = target!;
      if (s.starting || (s.conversation && s.conversation.state !== "idle")) {
        s.pushEvent({
          kind: "error",
          message: l10n.t("Cannot use /clear during a turn. Wait for completion or interrupt, then try again."),
          fatal: false,
        });
        break;
      }
      s.clearing = true;
      try {
        await s.disposeConversation();
        if (s.closed) break;
        if (s.conversation) {
          const orphan: ClaudeConversation = s.conversation;
          s.conversation = null;
          void orphan.dispose();
        }
        s.resetLogicalSession();
        s.resumeSessionId = undefined;
        void persistOpenTabs();
        s.autoTitled = false;
        st.post({ type: "tabCleared", tab: s.snapshot() });
        s.pushEvent({
          kind: "conversation_closed",
          reason: l10n.t("Context cleared by /clear (a new session will start)"),
        });
      } finally {
        s.clearing = false;
      }
      warmup(s);
      break;
    }
  }
}
