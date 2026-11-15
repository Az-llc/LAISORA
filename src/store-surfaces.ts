import { getLaisoraConfiguration } from "./claude-settings";
import { HOST_FILE_LINK_PLATFORM } from "./host-platform";
import { configuredSystemAppExtensions, openWelcome } from "./gateway-host-actions";
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

import { ClaudeConversation } from "./claudeHost";
import { postAttachments } from "./composer-io";
import { releaseConversationHistory } from "./conversation-history";
import { postOrchestrationView, rejudgeTranscriptWriteLock, warmup } from "./conversation-lifecycle";
import { clearAutoHandoff, handoffDetailSources, noteComposerDrafts } from "./handoff-wiring";
import { handoffInProgress } from "./handoff-runs";
import { clearWaitNotify } from "./wait-notify-wiring";
import { orchestrationRunsDirectoryOf } from "./orchestration-external";
import { releaseHistoryWindow } from "./history-window";
import { extensionContext, output, sinceActivation, store } from "./host-context";
import { handleWebviewMessage } from "./message-router";
import { seedLastDiscoveredModels } from "./gateway-models";
import { pendingAttachments } from "./pending-attachments";
import { clearDuringTurnText, PROTOCOL_VERSION, type HostToWebview, type TabSnapshot, type WebviewToHost } from "./protocol";
import { historyScopeKey, historyTranscriptScopeKey, launchingOrTurnRunning, Session } from "./session";
import { noteHandoffForkTab, persistOpenTabs } from "./session-list-wiring";
import { sessionRecordId } from "./session-record";
import { normalizeTitleValue } from "./session-display-title";
import { displayTitleFromSummary } from "./session-list";
import { postSettingsState } from "./settings-panel";
import { savedAskMarks } from "./ask-marks";
import { TAB_LIMIT_DEFAULT, resolveTabLimit, scopeMaxForTabs } from "./tab-limits";
import { noteTodoSessionEnded, offerTodoReopen, postTodoSnapshot, setTodoDrawerFocus } from "./todo-surface";

export const RESTORE_TAIL_EVENT_MAX = 150;

const WEBVIEW_BOOTSTRAP_TIMEOUT_MS = 5000;
const INIT_COALESCE_WINDOW_MS = 300;
const RESTORE_INIT_SUPPRESS_MS = 800;

export type ActivationRequest = vscode.Webview | null | undefined | (() => readonly vscode.Webview[]);

interface WebviewSurface {
  sub: vscode.Disposable;
  visible: boolean;
  bootstrapTimer?: ReturnType<typeof setTimeout>;
  initInFlight: boolean;
  readyInitAt?: number;
  restoreInitAt?: number;
  restoredInitPosted?: boolean;
  activeTabId?: string;
  conversationHidden?: boolean;
  hostActiveTabId?: string;
  fillQueue?: string[];
  fillTimer?: ReturnType<typeof setTimeout>;
}

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  readonly rosterEvidenceDirectory: string | undefined;
  readonly orchestrationRunsDirectory: string | undefined;
  activeWebview: vscode.Webview | null = null;
  panel: vscode.WebviewPanel | null = null;
  private tabCounter = 0;

  constructor() {
    this.rosterEvidenceDirectory = extensionContext?.globalStorageUri?.fsPath
      ? vscode.Uri.joinPath(extensionContext.globalStorageUri, "roster-evidence").fsPath
      : undefined;
    this.orchestrationRunsDirectory = orchestrationRunsDirectoryOf(extensionContext?.globalStorageUri?.fsPath);
  }

  private readonly surfaces = new Map<vscode.Webview, WebviewSurface>();
  private previousWebview: vscode.Webview | null = null;

  post(msg: HostToWebview, except?: vscode.Webview): void {
    for (const webview of this.surfaces.keys()) if (webview !== except) void this.postTo(webview, msg);
  }

  postTo(webview: vscode.Webview | null, msg: HostToWebview): Promise<boolean> {
    if (!webview) return Promise.resolve(false);
    if (this.surfaces.get(webview)?.visible === false) return Promise.resolve(false);
    return Promise.resolve(webview.postMessage(msg)).then((delivered) => {
      if (delivered && (msg.type === "init" || msg.type === "tabRestored" || msg.type === "tabCleared" || msg.type === "tabCreated")) {
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
    if (this.activeWebview === null || !this.surfaces.has(this.activeWebview)) this.activeWebview = webview;
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
      const hostChosen = this.hostChosenTab(surface);
      const plan = surface.restoredInitPosted === true || hostChosen !== undefined ? this.restoreInitPlan(surface) : undefined;
      const delivered = await this.postTo(webview, {
        type: "init",
        protocolVersion: PROTOCOL_VERSION,
        hostWindows: HOST_FILE_LINK_PLATFORM.windows,
        systemAppExtensions: configuredSystemAppExtensions(),
        askMarks: savedAskMarks(),
        tabs: plan?.tabs ?? this.snapshotAll(),
        ...(hostChosen !== undefined ? { activeTabId: hostChosen } : {}),
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
    if (surface) surface.restoredInitPosted = true;
    const plan = this.restoreInitPlan(surface);
    const hostChosen = this.hostChosenTab(surface);
    this.cancelRestoreFill(webview);
    const postedAt = Date.now();
    if (armSuppression && surface) surface.restoreInitAt = postedAt;
    void this.postTo(webview, {
      type: "init",
      protocolVersion: PROTOCOL_VERSION,
      hostWindows: HOST_FILE_LINK_PLATFORM.windows,
      systemAppExtensions: configuredSystemAppExtensions(),
      askMarks: savedAskMarks(),
      tabs: plan.tabs,
      ...(hostChosen !== undefined ? { activeTabId: hostChosen } : {}),
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
    const hostChosen = this.hostChosenTab(surface);
    if (hostChosen !== undefined) return hostChosen;
    const activeTabId = surface?.activeTabId;
    if (activeTabId === undefined || !this.sessions.has(activeTabId)) return undefined;
    return activeTabId;
  }

  noteActiveTab(webview: vscode.Webview, tabId: string, user = false): void {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    surface.activeTabId = tabId;
    surface.conversationHidden = undefined;
    if (user || surface.hostActiveTabId === tabId) surface.hostActiveTabId = undefined;
  }

  noteInteraction(webview: vscode.Webview): void {
    if (!this.surfaces.has(webview) || this.activeWebview === webview) return;
    this.previousWebview = this.activeWebview;
    this.activeWebview = webview;
  }

  settingsOpener: vscode.Webview | null = null;
  private settingsOpenRequest: vscode.Webview | null = null;

  requestSettingsFrom(webview: vscode.Webview): void {
    this.settingsOpenRequest = webview;
  }

  noteSettingsOpened(): void {
    const from = this.settingsOpenRequest;
    this.settingsOpenRequest = null;
    this.settingsOpener = from && this.surfaces.has(from) ? from : null;
  }

  settingsStartTarget(): vscode.Webview | null {
    return this.activationTarget(this.settingsOpener);
  }

  activationTarget(requested?: vscode.Webview | null): vscode.Webview | null {
    return requested && this.surfaces.has(requested) ? requested : this.activeWebview;
  }

  postActivating(requested: ActivationRequest, tabId: string, message: (activate: boolean) => HostToWebview): void {
    const targets = typeof requested === "function"
      ? requested().filter((webview) => this.surfaces.has(webview))
      : [this.activationTarget(requested)].filter((webview): webview is vscode.Webview => webview !== null);
    if (targets.length === 0) { this.post(message(false)); return; }
    for (const target of targets) this.deliverActivation(target, tabId, message(true));
    for (const webview of this.surfaces.keys()) if (!targets.includes(webview)) void this.postTo(webview, message(false));
  }

  attachedWebviews(): vscode.Webview[] {
    return [...this.surfaces.keys()];
  }

  activateExisting(requested: vscode.Webview | null | undefined, tabId: string): void {
    const target = this.activationTarget(requested);
    if (!target) return;
    this.deliverActivation(target, tabId, { type: "activateTab", tabId });
  }

  private deliverActivation(target: vscode.Webview, tabId: string, message: HostToWebview): void {
    const surface = this.surfaces.get(target);
    if (!surface) return;
    const record = () => { if (this.surfaces.get(target) === surface) surface.hostActiveTabId = tabId; };
    if (!surface.visible || surface.readyInitAt === undefined && surface.restoredInitPosted !== true) record();
    void this.postTo(target, message).then((delivered) => { if (!delivered) record(); });
  }

  private hostChosenTab(surface: WebviewSurface | undefined): string | undefined {
    const tabId = surface?.hostActiveTabId;
    return tabId !== undefined && this.sessions.has(tabId) ? tabId : undefined;
  }

  noteConversationHidden(webview: vscode.Webview): void {
    const surface = this.surfaces.get(webview);
    if (surface) surface.conversationHidden = true;
  }

  shownTabIdOf(webview: vscode.Webview): string | undefined {
    const surface = this.surfaces.get(webview);
    return surface?.conversationHidden === true ? undefined : surface?.activeTabId;
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
    noteComposerDrafts(webview, null);
    setTodoDrawerFocus(webview, false);
    if (this.previousWebview === webview) this.previousWebview = null;
    if (this.settingsOpener === webview) this.settingsOpener = null;
    if (this.activeWebview !== webview) return;
    const fallback = this.previousWebview && this.surfaces.has(this.previousWebview)
      ? this.previousWebview : this.surfaces.keys().next().value ?? null;
    this.previousWebview = null;
    this.activeWebview = fallback;
    if (fallback) this.restoreVisible(fallback);
  }
  createSession(): Session {
    const s = new Session(this, ++this.tabCounter);
    seedLastDiscoveredModels(s);
    this.sessions.set(s.tabId, s);
    postSettingsState();
    return s;
  }

  snapshotAll(): TabSnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshotForSurface());
  }

}

export function warnTabLimit(): void {
  void vscode.window.showWarningMessage(l10n.t("LAISORA: The tab limit ({0}) has been reached.", tabLimit()));
}

export function tabLimit(): number {
  let raw: unknown = TAB_LIMIT_DEFAULT;
  try {
    raw = getLaisoraConfiguration().get<unknown>("tabLimit");
  } catch {
    raw = TAB_LIMIT_DEFAULT;
  }
  return resolveTabLimit(raw);
}

export function currentScopeMax(): number {
  return scopeMaxForTabs(tabLimit(), store?.sessions.size ?? 0);
}

export function openNewConversationTab(st: SessionStore, initialize?: (session: Session) => void, activateIn?: vscode.Webview | null): Session | undefined {
  if (st.sessions.size >= tabLimit()) {
    warnTabLimit();
    return undefined;
  }
  const session = st.createSession();
  if (initialize) initialize(session);
  else session.welcome = openWelcome();
  const tab = session.snapshot();
  st.postActivating(activateIn, session.tabId, activate => ({ type: "tabCreated", tab, activate }));
  warmup(session);
  return session;
}

export function openTitledConversationTab(st: SessionStore, title: string, activateIn?: vscode.Webview | null): Session | undefined {
  return openNewConversationTab(st, (s) => {
    s.title = displayTitleFromSummary(title, s.tabId);
    s.autoTitled = true;
    s.laisoraPurpose = true;
    const chosen = normalizeTitleValue(title);
    s.unpersistedChosenTitle = chosen === null ? null : { title: chosen, failedAttempts: 0 };
  }, activateIn);
}

export function reorderSessionTabs(st: SessionStore, order: readonly string[], sender?: vscode.Webview): void {
  const known = order.filter(tabId => st.sessions.has(tabId));
  const rest = [...st.sessions.keys()].filter(tabId => !known.includes(tabId));
  const sessions = [...known, ...rest].map(tabId => st.sessions.get(tabId)!);
  if (sessions.every((s, index) => [...st.sessions.values()][index] === s)) return;
  st.sessions.clear();
  for (const s of sessions) st.sessions.set(s.tabId, s);
  st.post({ type: "tabOrder", order: sessions.map(s => s.tabId) }, sender);
  void persistOpenTabs();
}

function runCloseSteps(closing: Session, steps: ReadonlyArray<() => void>): void {
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      output.appendLine(`[${closing.title}] タブ閉鎖: 後始末の失敗 ${String(error)}`);
    }
  }
}

export function closeConversationTab(st: SessionStore, closing: Session, sender: vscode.Webview | null, opts: { offerReopen: boolean } = { offerReopen: true }): void {
  closing.closed = true;
  runCloseSteps(closing, [
    () => closing.startMeasurement?.abandon(),
    () => { if (opts.offerReopen && sender !== null) offerTodoReopen(st, closing, sender); },
    () => noteTodoSessionEnded(closing),
    () => closing.cancelResumePreparation(),
    () => pendingAttachments.release(closing.tabId),
    () => handoffDetailSources.delete(closing.tabId),
    () => clearAutoHandoff(closing),
    () => clearWaitNotify(closing),
    () => closing.semantic.clearSemanticModelPostTimer(),
    () => closing.guardrailRunner.clearGuardrailRefreshTimer(),
    () => releaseHistoryWindow(historyScopeKey(closing)),
    () => releaseHistoryWindow(historyTranscriptScopeKey(closing)),
    () => releaseConversationHistory(historyScopeKey(closing)),
  ]);
  st.sessions.delete(closing.tabId);
  let replacement: Session | null = null;
  try {
    const closedSessionId = sessionRecordId(closing);
    if (closedSessionId !== undefined) noteHandoffForkTab({ kind: "closed", sessionId: closedSessionId });
    void persistOpenTabs();
    const created = st.sessions.size === 0 ? st.createSession() : null;
    replacement = created;
    if (created) {
      created.welcome = openWelcome();
      const tab = created.snapshot();
      st.postActivating(sender, created.tabId, activate => ({ type: "tabCreated", tab, activate, replacement: true }));
    }
    st.post({ type: "tabClosed", tabId: closing.tabId });
    postSettingsState();
  } finally {
    void closing
      .disposeConversation()
      .then(() => output.appendLine(`[${closing.title}] タブ閉鎖: dispose 完了`))
      .catch((e) => output.appendLine(`[${closing.title}] タブ閉鎖: dispose 失敗 ${String(e)}`));
  }
  if (replacement) warmup(replacement);
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
      postTodoSnapshot(sender);
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
      st.noteActiveTab(sender, msg.tabId, msg.user === true);
      if (target) rejudgeTranscriptWriteLock(target);
      break;
    case "newTab": {
      openNewConversationTab(st, undefined, sender);
      break;
    }
    case "closeTab":
      closeConversationTab(st, target!, sender);
      break;
    case "clearTab": {
      const s = target!;
      if (handoffInProgress(s.tabId)) {
        s.pushEvent({ kind: "error", message: l10n.t("Cannot use /clear while this conversation is being handed off."), fatal: false });
        break;
      }
      if (s.transcriptWriteLocked) {
        output.appendLine(`[${s.title}] /clear refused: the conversation record is not written`);
        break;
      }
      if (launchingOrTurnRunning(s)) {
        s.pushEvent({
          kind: "error",
          message: clearDuringTurnText(),
          fatal: false,
        });
        break;
      }
      s.clearing = true;
      try {
        await s.disposeConversation();
        if (s.closed) break;
        noteTodoSessionEnded(s);
        if (s.conversation) {
          const orphan: ClaudeConversation = s.conversation;
          s.conversation = null;
          void orphan.dispose();
        }
        s.resetLogicalSession();
        s.resumeSessionId = undefined;
        void persistOpenTabs();
        st.post({ type: "tabCleared", tab: s.snapshot(), replaced: true });
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
