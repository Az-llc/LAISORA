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
import { TAB_LIMIT_DEFAULT, resolveTabLimit, scopeMaxForTabs } from "./tab-limits";

// 復帰の init が見ているタブへ積む events の上限。落とした先頭側は履歴窓に残り、webview が
// 遡って埋める。REPLAY_MAX(1500) を下回っていることがこの経路の存在理由で、上げて並ぶと
// 復帰は再び全件を同期再生する
export const RESTORE_TAIL_EVENT_MAX = 150;

// Webview の bundle が未ロード・CSP 拒否・評価時例外のどこで止まっても、Host 側には
// ready が来ないという共通の観測点が残る。無言停止に戻さないための上限。
const WEBVIEW_BOOTSTRAP_TIMEOUT_MS = 5000;
// sol-10: ready 由来 init を束ねる窓。src/webview/main.ts の INIT_RETRY_DELAY_MS（1000ms）
// より必ず短く保つこと。この関係が崩れると、束ねられる再送が 2 通以上に増え、
// 本当に失われた init が回復しなくなる（再送間隔は extension.ts からは観測できない）
const INIT_COALESCE_WINDOW_MS = 300;
// sol-12: 可視化で送った init が配送された直後、その面へ届く ready 由来 init を抑止する窓。
// VS Code は webview→Host のメッセージを面が可視になるまで保留して一括で流すので、可視化の
// 直後に届く ready は「可視化前から生きている document」のもので、可視化で送った init が既に
// 応えている。
// 下限: 可視化→ready の到達は 4ms / 153ms / 383ms と観測されている（VS Code webview）。
// 383ms を下回る窓では抑止が外れて init が二重に出る。
// 上限: src/webview/main.ts の INIT_RETRY_DELAY_MS（1000ms）より必ず短く保つこと。越えると
// document 時計で 1000ms 間隔の再送 ready が 2 通続けて窓へ入りうるので、失われた init が
// 回復しなくなる（webview の再送時計は document age で、Host からは観測できない）
const RESTORE_INIT_SUPPRESS_MS = 800;

interface WebviewSurface {
  sub: vscode.Disposable;
  visible: boolean;
  bootstrapTimer?: ReturnType<typeof setTimeout>;
  initInFlight: boolean;
  readyInitAt?: number;
  restoreInitAt?: number;
  // sol-16: この面へ復帰形の init を出したか。ready 由来の init の「形」はこれで決まる。
  // restoreInitAt（抑止の時計）で代用してはならない — あれは配送に失敗した init で
  // undefined へ戻る（sol-11b の回復経路）ので、回復のときだけ全件再生へ落ちる
  restoredInitPosted?: boolean;
  // この面で利用者が最後に見ていたタブ（webview から activeTab で届く）。
  // 復帰の init をこれで並べ替える
  activeTabId?: string;
  // deferred で送ったタブの中身を送る待ち行列と、その送出タイマ
  fillQueue?: string[];
  fillTimer?: ReturnType<typeof setTimeout>;
}

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  readonly analysisStorage: AnalysisStorage;
  // ROLES の根拠の保存先（src/roster-evidence.ts）。undefined = 保存しない（検証ハーネス等）
  readonly rosterEvidenceDirectory: string | undefined;
  // 外部実行の記録（runs.jsonl）の保存先。ROLES が再開後に読み戻す（R-ANL-24）。undefined = 読まない
  readonly orchestrationRunsDirectory: string | undefined;
  // 最後に接続したUI面。previousWebview の決定にだけ使う。イベントの配信先ではない
  // （どの面からでも操作できる以上、結果を1面だけへ返すと操作元に何も返らない面ができる）。
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
  // パネルを開く前に繋がっていた面。パネルを閉じたらここへ戻す。
  private previousWebview: vscode.Webview | null = null;

  post(msg: HostToWebview): void {
    for (const webview of this.surfaces.keys()) void this.postTo(webview, msg);
  }

  postTo(webview: vscode.Webview | null, msg: HostToWebview): Promise<boolean> {
    if (!webview) return Promise.resolve(false);
    // 非表示の面へ送っても VS Code は false を返して捨てる。可視化時に restoreVisible が
    // snapshot を丸ごと送り直すので、ここで送らなくても表示は復帰する。
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

  // sol-10: ready 由来の init だけを束ねる。sol-12 の可視化由来を同じ窓に入れてはならない
  // （抑止の根拠が別で、期限も別に決まる）
  async initForReady(webview: vscode.Webview): Promise<void> {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    // sol-12: 可視化で送った init が配送済みなら、その直後に保留解除で流れてくる ready は
    // 同じ document のもので既に応えている。配送に失敗した init は restoreInitAt を残さないので
    // ここは通り、初期化されない面が残らない
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
      // sol-16: 復帰形の init を出した面へ ready 由来を送り直すときは、同じ形で送る。
      // 抑止の窓（RESTORE_INIT_SUPPRESS_MS）は「送るかどうか」だけを決め、「何を送るか」は
      // 決めない。窓は時間のヒューリスティックなので必ず外れる場面があり、そこで
      // snapshotAll() へ落ちると全 tab 全イベントの同期再生が起きる。復帰していない面（最初の ready）は全件を積む
      const plan = surface.restoredInitPosted === true ? this.restoreInitPlan(surface) : undefined;
      // 配送結果を待ってから記録する。待たずに書くとログが「sent」→「dropped」の順になり、
      // 失敗が成功記録に見える
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
      // deferred で積んだタブの中身は必ず後から送る。送らないとそのタブは読込中で固まる
      // （R-TAB-08 のインジケーターが消えない）
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
      // sol-12: 最初の描画を可視化イベントより後ろへ回さない。ready を待ってから送ると
      // init は 1 通に減るが、全 tab の再構成がその分遅れる
      this.restoreVisible(webview, true);
    } else {
      // 非表示の間に document は作り直される。次の ready は別 document のものなので、
      // 前の document 宛の配送実績で束ねても抑止してもいけない
      surface.readyInitAt = undefined;
      surface.restoreInitAt = undefined;
      // sol-16: 次の document は復帰形の init をまだ受け取っていない。可視化で
      // restoreVisible が張り直すまでの間に届く ready は「最初の ready」として扱う
      surface.restoredInitPosted = undefined;
      this.cancelRestoreFill(webview);
    }
  }

  // armSuppression は可視化由来のときだけ true。VS Code が可視化まで webview→Host を保留する
  // という前提が成り立つのはその経路だけで、パネル閉鎖の配信戻し（detach）は面の document
  // 再作成と無関係なため、そこで抑止を張るとその面が別の理由で送った ready まで飲む
  restoreVisible(webview: vscode.Webview, armSuppression = false): void {
    const surface = this.surfaces.get(webview);
    // sol-12: 抑止は配送完了（.then）ではなく post の時点で張る。可視化で保留解除された
    // ready の burst は同じ tick で届くので、配送結果を待つと抑止が間に合わない
    const postedAt = Date.now();
    if (armSuppression && surface) surface.restoreInitAt = postedAt;
    // sol-16: 形の判定は配送結果に依らず post の時点で立てる。detach の配信戻しでも立てるのは、
    // そちらも復帰形の init を送るため（抑止は張らないが形は同じ）
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
      // 配送できなかった init で ready 由来を抑止すると、面が初期化されないまま残る
      if (!delivered && surface && surface.restoreInitAt === postedAt) surface.restoreInitAt = undefined;
      output.appendLine(
        `[webview] ${sinceActivation()} init posted (cause=restore, delivered=${delivered}, ` +
          `deferred=${plan.deferredTabIds.length}, omittedHead=${plan.omittedHeadCount})`
      );
    });
    if (plan.deferredTabIds.length > 0) this.scheduleRestoreFill(webview, plan.deferredTabIds);
  }

  // 復帰の init は見ているタブだけを中身ごと運び（それも events は末尾側だけ）、残りは
  // タブバーが出る分だけにする。見ているタブが決まらない面では従来どおり全件を積む
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
    // 並びはタブバーの順なので、deferred でも元の位置へ入れる
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

  // タブが 1 枚のときはそれが見ている面で確定する。activeTab が一度も届いていない面でも
  // 成立するので、利用者が 1 枚だけ開いているとき（impl13）に
  // 末尾送りが効く。2 枚以上のときは面の記憶が要る（覚えていない・そのタブが既に無いなら
  // 分ける根拠が無いので全件へ縮退する）
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

  // 中身は 1 tick に 1 タブずつ送る。同じ tick で全部送ると snapshot の導出で Host が
  // ブロックし、init の配送自体が後ろへ回る（分けた意味が消える）
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
    // 途中で閉じられたタブは飛ばす。tabClosed が別途届く
    if (s) void this.postTo(webview, { type: "tabRestored", tab: s.snapshotForSurface() });
    surface.fillTimer = setTimeout(() => this.drainRestoreFill(webview), 0);
  }

  // init を送り直した面へ古い待ち行列を流すと、完全な snapshot で作ったタブを
  // さらに作り直してスクロール位置を落とす。init を出す全経路で消す
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
    return s;
  }

  snapshotAll(): TabSnapshot[] {
    // hydration 中は履歴窓を登録しない表示専用 snapshot を返す
    return [...this.sessions.values()].map((s) => s.snapshotForSurface());
  }

  // 拡張全体の single flight。タブ単位のガードだけだと、タブを開いて押すだけで
  // 同時実行数が上限なく増える
  llmAnalysisInFlightCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) if (s.llmRun !== null) count++;
    return count;
  }
}

// 消費点で毎回読む。設定変更リスナは置かない（同期対象の状態を作ると、同期漏れが
// 「上限を上げると古いタブだけ遡れない」欠陥に戻る）。
// 偽 vscode のハーネスは workspace.getConfiguration を持たないので try/catch が要る
// （guardrailPolicy() が包んでいるのと同じ理由）
// タブ上限は設定値。既定 20（R-SES-03）
export function warnTabLimit(): void {
  void vscode.window.showWarningMessage(l10n.t("LAISORA: The tab limit ({0}) has been reached.", tabLimit()));
}

export function tabLimit(): number {
  let raw: unknown = TAB_LIMIT_DEFAULT;
  try {
    raw = getLaisoraConfiguration().get<unknown>("tabLimit", TAB_LIMIT_DEFAULT);
  } catch {
    // 設定を読めない環境でも既定 20 で成立させる（R-SES-03）
    raw = TAB_LIMIT_DEFAULT;
  }
  return resolveTabLimit(raw);
}

export function currentScopeMax(): number {
  return scopeMaxForTabs(tabLimit(), store?.sessions.size ?? 0);
}

// 検証スクリプトが Host 内部の WorkModel（webview へは出さない）を観測するための口。
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
      // 束ねる前に markReady する。後ろに置くと、束ねた ready で bootstrap timer が
      // 張られたままになり偽の timeout が記録される
      st.markReady(sender);
      output.appendLine(`[webview] ${sinceActivation()} ready received`);
      await st.initForReady(sender);
      // 添付の実体は webview の外（Host の tabId 別スロット）にあり、iframe が捨てられても
      // 残る。ここで作り直された画面へ積み直さないと、拡張タブを移動しただけで消える
      // （R-CNV-11）。R-OPS-10: 掃除は生きていないタブのスロットだけを落とす。
      // 無条件に空にすると、この復元自体が症状を再現させる
      const dropped = pendingAttachments.sweep(new Set(st.sessions.keys()));
      if (dropped.length > 0) {
        output.appendLine(`[attachment] released ${dropped.length} orphan slot(s)`);
      }
      for (const tabId of pendingAttachments.tabIdsWithAttachments()) {
        postAttachments(st, tabId);
      }
      // warmup は init を束ねても必ず通す（多重呼び出しは warmup 自身が弾く独立経路）。
      // Claude拡張と同様、開いた時点でCLIセッションを事前起動する
      // （初回送信前から /コマンドサジェスト・認証実測を有効にするため）
      // hydration 設置前の resuming セッションは起こさない（復元経路が自分で warmup する）。
      // ここで起こすと、起動 cwd の確定（AUDIT-02）と観測時刻の種の確定より前に会話が作られる
      for (const s of st.sessions.values()) {
        if (s.resuming && s.hydration === null) continue;
        warmup(s);
      }
      break;
    }
    case "webviewDiagnostic":
      output.appendLine(`[webview] ${msg.kind}: ${msg.message}`);
      break;
    // 面ごとに覚える。復帰の init は可視化の時点で飛ぶので、その時に既に
    // 知っていないと「見ているタブを先に積む」が成立しない
    case "activeTab":
      st.noteActiveTab(sender, msg.tabId);
      break;
    case "newTab": {
      if (st.sessions.size >= tabLimit()) {
        warnTabLimit();
        break;
      }
      const s = st.createSession();
      st.post({ type: "tabCreated", tab: s.snapshot(), activate: true });
      warmup(s);
      break;
    }
    case "closeTab": {
      target!.closed = true;
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
      // R-SES-07: 置き換えの tabCreated は tabClosed より先に送る。逆順だと webview がタブ 0 枚の画面を挟む
      const replacement = st.sessions.size === 0 ? st.createSession() : null;
      if (replacement) st.post({ type: "tabCreated", tab: replacement.snapshot(), activate: true });
      st.post({ type: "tabClosed", tabId: msg.tabId });
      // dispose の完了/失敗は Output に残す（閉鎖後イベントはUIに届かないため）
      void target!
        .disposeConversation()
        .then(() => output.appendLine(`[${target!.title}] タブ閉鎖: dispose 完了`))
        .catch((e) => output.appendLine(`[${target!.title}] タブ閉鎖: dispose 失敗 ${String(e)}`));
      if (replacement) warmup(replacement);
      break;
    }
    case "clearTab": {
      // /clear: 会話履歴とCLIセッションを破棄し、同タブで新規セッションを開始する。
      // 実行中・起動中は不可（現在ターンの帰属が曖昧になるため。R-SES-08:
      // starting 中は send が直後にターンを開始しうるので「実行中」と同等に扱う）
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
        // dispose 待ちの間に閉じられていたら何もしない
        if (s.closed) break;
        // dispose 待機中に並行 send の ensureConversation が新会話を
        // 生成していた場合、参照切りだけだとCLIプロセスがリークする。ここで破棄する。
        if (s.conversation) {
          const orphan: ClaudeConversation = s.conversation;
          s.conversation = null;
          void orphan.dispose();
        }
        s.resetLogicalSession();
        s.resumeSessionId = undefined;
        void persistOpenTabs();
        // 次の最初の発言でタブ名を付け直せるようにする
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
