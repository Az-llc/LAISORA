import { getLaisoraConfiguration } from "./claude-settings";

import {
  PERMISSION_MODE_KEY,
  canonicalEffortModel,
  configuredEffortFromSnapshot,
  configuredClaudeExecutablePath,
  defaultEffortFromSnapshot,
  invalidateClaudeCodeSettingsCache,
  resolveSessionCwd,
  resolveConfiguredEffortSnapshot,
  saveClaudeModelEffort,
  updateClaudeCodeSettings,
  type SettingsWriteResult,
} from "./claude-settings";
import { createBackgroundActivityState } from "./background-activity";
import { ClaudeConversation } from "./claudeHost";
import { postAttachments } from "./composer-io";
import { pendingAttachments } from "./pending-attachments";
import * as l10n from "@vscode/l10n";
import { isUnusedSession, type Session } from "./session";
import { modelsMessage, recomputeModelRows } from "./gateway-models";
import { clearProcessEphemeral } from "./guardrail";
import { extensionContext, output, sinceActivation, store } from "./host-context";
import { INJECTED_TAG_RE as HUMAN_INPUT_INJECTED_TAG_RE, isNonHumanCommandInput } from "./human-input-vocabulary";
import { observedTimestampSeed } from "./observed-timestamp-seed";
import { normalizeProgressTracking } from "./progress-protocol";
import { normalizeApiKeyPolicy, type WebviewToHost } from "./protocol";
import { displayTitleFromSummary } from "./session-list";
import type { SessionStore } from "./store-surfaces";

function publishConfiguredEffort(
  st: SessionStore | null | undefined,
  s: Session,
  effort: Session["configuredEffort"],
  force = false
): void {
  void force; // Model resolution must also be published when effort is unchanged.
  s.configuredEffort = effort;
  s.defaultEffort = defaultEffortFromSnapshot(
    s.configuredEffortSnapshot,
    s.effectiveModel ?? s.modelOverride,
    s.discoveredModels,
    s.effortOverride === undefined ? s.appliedEffort : undefined
  );
  st?.post({
    type: "configuredEffortChanged",
    tabId: s.tabId,
    effort: effort ?? null,
    model: s.configuredEffortSnapshot?.resolvedModel ?? null,
    defaultEffort: s.defaultEffort ?? null,
    appliedModel: s.appliedModel ?? null,
  });
}

function rederiveConfiguredEffort(st: SessionStore | null | undefined, s: Session): void {
  const snapshot = s.configuredEffortSnapshot;
  if (snapshot === undefined) return;
  publishConfiguredEffort(
    st,
    s,
    configuredEffortFromSnapshot(snapshot, s.effectiveModel ?? s.modelOverride, s.discoveredModels)
  );
}

function refreshConfiguredEffort(
  st: SessionStore | null | undefined,
  s: Session,
  cwd: string,
  settingSources: Array<"user" | "project" | "local">,
  conv: ClaudeConversation
): void {
  const refreshGeneration = ++s.configuredEffortGeneration;
  const logicalGeneration = s.logicalGeneration;
  const processGeneration = s.generation;
  s.configuredEffortSnapshot = undefined;
  s.appliedEffort = undefined;
  s.appliedModel = undefined;
  publishConfiguredEffort(st, s, undefined, true);
  const current = (): boolean =>
    !s.closed &&
    s.configuredEffortGeneration === refreshGeneration &&
    s.logicalGeneration === logicalGeneration &&
    s.generation === processGeneration &&
    s.conversation === conv;
  void resolveConfiguredEffortSnapshot(cwd, settingSources).then((snapshot) => {
    if (snapshot === undefined || !current()) return;
    s.configuredEffortSnapshot = snapshot;
    rederiveConfiguredEffort(st, s);
  });
  void conv.appliedSettings().then((applied) => {
    if (applied === undefined || !current()) return;
    s.appliedEffort = applied.effort;
    s.appliedModel = applied.model;
    // 設定の解決（resolveSettings）が失敗・未着でも applied model は届ける
    if (s.configuredEffortSnapshot === undefined) publishConfiguredEffort(st, s, undefined);
    else rederiveConfiguredEffort(st, s);
  });
}

function clearObservedEffort(s: Session): void {
  s.effectiveEffort = undefined;
  if (s.auth !== null) {
    const { effort: _discarded, ...auth } = s.auth;
    s.auth = auth;
  }
}

function profileTargetState(
  s: Session,
  logicalGeneration: number,
  processGeneration: number,
  conv: ClaudeConversation
): "current" | "discard" | "restarted" {
  if (s.closed || s.logicalGeneration !== logicalGeneration) return "discard";
  return s.generation === processGeneration && s.conversation === conv ? "current" : "restarted";
}

// settings.json への保存失敗を会話内の確認文へ載せる理由文。保存の成否は共通関数が返し、
// 通知は操作したタブの会話に出す（R-DSP-01 / R-CMD-02）
function settingsWriteFailureText(result: Extract<SettingsWriteResult, { ok: false }>): string {
  return result.reason === "read_failed"
    ? l10n.t("could not read ~/.claude/settings.json (existing settings were not changed)")
    : l10n.t("could not save ~/.claude/settings.json ({0}); the previous value will return the next time LAISORA starts", result.detail);
}

function reportProfileRestart(s: Session, kind: "model" | "effort"): void {
  const message = kind === "model"
    ? l10n.t("LAISORA: The model change could not be confirmed because the conversation restarted. Try again.")
    : l10n.t("LAISORA: The effort change could not be confirmed because the conversation restarted. Try again.");
  output.appendLine(`[${s.title}] set${kind === "model" ? "Model" : "Effort"}: process changed before confirmation`);
  s.pushEvent({ kind: "error", message, fatal: false });
}

async function applyEffortChange(
  st: SessionStore,
  s: Session,
  requested: NonNullable<Session["effortOverride"]> | null
): Promise<void> {
  const logicalGeneration = s.logicalGeneration;
  const run = async (): Promise<void> => {
    if (s.closed || s.logicalGeneration !== logicalGeneration) return;
    // queue 待機中の通常再起動は要求を失効させない。実際に操作を始める時点を基準にする。
    const processGeneration = s.generation;
    // model change が applyFlagSettings の待機中に割り込んでも、クリック時点と別modelへ
    // 永続化しない。実行への適用先と保存先を同じ観測点で固定する。
    const canonicalModel = canonicalEffortModel(s);
    const conv = s.conversation;
    if (conv !== null && !conv.isClosed) {
      try {
        // applyFlagSettings は idle/running の両方で使える。会話入力の /effort は送らない。
        await conv.setEffort(requested);
      } catch (error) {
        const targetState = profileTargetState(s, logicalGeneration, processGeneration, conv);
        if (targetState === "restarted") {
          reportProfileRestart(s, "effort");
        } else if (targetState === "current") {
          output.appendLine(`[${s.title}] setEffort 失敗: ${String(error)}`);
          s.pushEvent({
            kind: "error",
            message: l10n.t(
              "LAISORA: Could not apply the effort setting ({0}). The previous setting is still in use.",
              String(error)
            ),
            fatal: false,
          });
          // Webview は楽観更新しないため、失敗時は ack を送らず現在の表示を保つ。
        }
        return;
      }
      const targetState = profileTargetState(s, logicalGeneration, processGeneration, conv);
      if (targetState === "discard") return;
      if (targetState === "restarted") {
        reportProfileRestart(s, "effort");
        return;
      }
    }

    s.effortOverride = requested ?? undefined;
    clearObservedEffort(s);
    let saved: SettingsWriteResult | null = null;
    if (requested !== "max" && canonicalModel !== undefined) {
      saved = saveClaudeModelEffort(canonicalModel, requested);
    }
    const notice = canonicalModel === undefined
      ? requested === null
        ? l10n.t("LAISORA: Requested the default effort for this session; no saved model setting was changed.")
        : l10n.t("LAISORA: Requested effort {0} for this session; no saved model setting was changed.", requested)
      : requested === "max"
        ? l10n.t("LAISORA: Requested effort {0} for this session.", requested)
        : saved !== null && !saved.ok
          ? requested === null
            ? l10n.t("LAISORA: Requested the default effort for this session, but the saved effort was not cleared: {0}.", settingsWriteFailureText(saved))
            : l10n.t("LAISORA: Requested effort {0} for this session, but it was not saved: {1}.", requested, settingsWriteFailureText(saved))
          : requested === null
            ? l10n.t("LAISORA: Cleared the saved effort for {0}.", canonicalModel)
            : l10n.t("LAISORA: Saved effort {0} for {1}.", requested, canonicalModel);
    st.post({ type: "effortChanged", tabId: s.tabId, effort: requested, notice });
    s.configuredEffortSnapshot = undefined;
    s.configuredEffortGeneration += 1;
    publishConfiguredEffort(st, s, undefined, true);
    if (conv !== null && !conv.isClosed && s.conversation === conv) {
      const cfg = getLaisoraConfiguration();
      const cwd = s.cwd ?? resolveSessionCwd(s);
      if (cwd !== undefined) {
        refreshConfiguredEffort(
          st,
          s,
          cwd,
          cfg.get<Array<"user" | "project" | "local">>("claude.settingSources", ["user", "project", "local"]),
          conv
        );
      }
    }
  };
  const queued = s.profileChangeTail.then(run, run);
  s.profileChangeTail = queued.catch(() => {});
  await queued;
}

async function applyModelChange(
  st: SessionStore,
  s: Session,
  requested: string | null
): Promise<void> {
  const logicalGeneration = s.logicalGeneration;
  const run = async (): Promise<void> => {
    if (s.closed || s.logicalGeneration !== logicalGeneration) return;
    const processGeneration = s.generation;
    const previous = s.modelOverride;
    const conv = s.conversation;
    if (conv !== null && !conv.isClosed) {
      try {
        await conv.setModel(requested ?? undefined);
      } catch (error) {
        const targetState = profileTargetState(s, logicalGeneration, processGeneration, conv);
        if (targetState === "restarted") {
          reportProfileRestart(s, "model");
        } else if (targetState === "current") {
          output.appendLine(`[${s.title}] setModel 失敗: ${String(error)}`);
          s.pushEvent({
            kind: "error",
            message: l10n.t(
              "Could not switch the model immediately ({0}). The selection will apply after you /clear this conversation or open a new tab.",
              String(error)
            ),
            fatal: false,
          });
          if (previous !== undefined) st.post({ type: "modelChanged", tabId: s.tabId, model: previous });
        }
        return;
      }
      const targetState = profileTargetState(s, logicalGeneration, processGeneration, conv);
      if (targetState === "discard") return;
      if (targetState === "restarted") {
        reportProfileRestart(s, "model");
        return;
      }
    }

    s.modelOverride = requested;
    clearObservedEffort(s);
    const knownRow = requested === null || s.models.length === 0 || s.models.some((m) => m.id === requested);
    const saved: SettingsWriteResult | null = knownRow ? updateClaudeCodeSettings({ model: requested }) : null;
    // SDK setModel 成功時は新しい auth_status が来ないため、明示指定を分析・要約の選択値にする。
    if (conv !== null && s.conversation === conv) s.effectiveModel = requested;
    // 確認文は適用と保存が終わったここで組む。webview が選択直後に出す形へ戻すと、SDK 失敗・
    // 保存失敗のときに「保存しました」と失敗通知が同じ会話に並ぶ（R-DSP-01 / R-CMD-02）
    const label = requested === null ? null : s.models.find((m) => m.id === requested)?.label ?? requested;
    const notice = saved === null
      ? l10n.t("LAISORA: Changed model to {0} for this session; it was not saved to settings.json because the model is not in the model list.", label ?? "")
      : !saved.ok
        ? label === null
          ? l10n.t("LAISORA: Reset the model to the default for this session, but the change was not saved: {0}.", settingsWriteFailureText(saved))
          : l10n.t("LAISORA: Changed model to {0} for this session, but it was not saved: {1}.", label, settingsWriteFailureText(saved))
        : label === null
          ? l10n.t("LAISORA: Reset the model to the default (removed model from settings.json).")
          : l10n.t("LAISORA: Changed model to {0} (saved to settings.json).", label);
    st.post({ type: "modelChanged", tabId: s.tabId, model: requested, notice });
    s.configuredEffortSnapshot = undefined;
    // 切替前の applied 値を残すと、既定へ戻した（modelOverride === null）タブの表示・分析が旧 model を使う
    s.appliedModel = undefined;
    s.appliedEffort = undefined;
    s.configuredEffortGeneration += 1;
    publishConfiguredEffort(st, s, undefined, true);
    output.appendLine(`[${s.title}] setModel: ${requested ?? "(既定)"} を適用`);
    if (conv === null || conv.isClosed) warmup(s);
    else {
      const cfg = getLaisoraConfiguration();
      const cwd = s.cwd ?? resolveSessionCwd(s);
      if (cwd !== undefined) {
        refreshConfiguredEffort(
          st,
          s,
          cwd,
          cfg.get<Array<"user" | "project" | "local">>("claude.settingSources", ["user", "project", "local"]),
          conv
        );
      }
    }
  };
  const queued = s.profileChangeTail.then(run, run);
  s.profileChangeTail = queued.catch(() => {});
  await queued;
}

export async function handleConversationMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "send" | "interrupt" | "approvalDecision" | "setMode" | "setEffort" | "setModel" }>,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "send": {
      // Webview は hydration 中だけ clientToken 付きで送る。Host は受理結果を
      // 同じ token で返し、楽観バブルの確定・撤去を決める
      const clientToken = msg.clientToken;
      const disposition = (
        value: "accepted-human" | "accepted-nonhuman" | "rejected"
      ): void => {
        if (clientToken === undefined) return;
        st.post({
          type: "resumeHydrationState",
          tabId: target!.tabId,
          sendDisposition: { clientToken, disposition: value },
        });
      };
      // /clear 処理中は受け付けない（レビューAR-C1: クリア対象の会話へ投入・再生成しない）
      if (target!.clearing) {
        target!.pushEvent({
          kind: "error",
          message: l10n.t("Cannot send while the conversation is being cleared (wait a moment and resend)."),
          fatal: false,
        });
        disposition("rejected");
        break;
      }
      // 予約タグ（非人間 allowlist）で始まる人間入力は拒否する。
      // history 側は同じ本文を非人間として落とすため、live で通すと経路が割れる
      if (HUMAN_INPUT_INJECTED_TAG_RE.test(msg.text.trimStart())) {
        target!.pushEvent({
          kind: "error",
          message: l10n.t(
            "Input that starts with a reserved tag (<laisora-…>, <system-reminder>, etc.) cannot be sent. Add text before it or wrap the tag in a code block."
          ),
          fatal: false,
        });
        disposition("rejected");
        break;
      }
      try {
        await ensureConversation(target!);
      } catch (e) {
        disposition("rejected");
        throw e;
      }
      // 起動待ちの間にタブが閉じられていたら投入しない（codexレビューC1-2）
      // /clear が割り込んだ場合も投入しない（レビューAR-C1）
      if (target!.closed || target!.clearing) {
        disposition("rejected");
        break;
      }
      // 実行中の送信も受理する（steering: ホストが新ターンを作らず現在ターンへ直接投入する）。
      // user_message はここで一度だけ記録し、ホスト側の投入時は再emitしない
      // 初回発言でタブを自動命名（先頭行の抜粋。LLM不使用）
      if (!target!.autoTitled) {
        const firstLine = msg.text.trim().split("\n")[0];
        if (firstLine) {
          const hydrating = target!.hydration;
          if (hydrating !== null && hydrating.buffering) {
            // hydration 中は付け直さず候補だけ持つ。Phase 3 で履歴側 resolver を
            // 先に適用するので、ここで名付けると同じタブ名が二度変わる（R-SES-05）
            hydrating.liveTitleCandidate = firstLine;
          } else {
            target!.title = displayTitleFromSummary(firstLine, target!.tabId);
            target!.autoTitled = true;
            st.post({ type: "tabRenamed", tabId: target!.tabId, title: target!.title });
          }
        }
      }
      // history 側の正規化境界（session-transcript.extractHumanUserText）は
      // `/rename <引数>` からイベントを作らない。live だけ user_message を作ると
      // work-model が segment を余分に閉じ、同じセッションでも live/history で採番が割れる。
      // 投入自体（下の send）は止めないこと — 止めるとコマンドが CLI へ届かない
      // 添付は「送信メッセージが運んできたもの」ではなく「この tabId のスロットにあるもの」。
      // webview の手持ちを載せる形へ戻すと、押した瞬間の activeTabId が別タブへ動いていたときに
      // 添付だけが別の会話へ入る（R-CNV-11）。取り出しは投入が確定するこの位置でだけ行う
      // ——上の拒否分岐より前で取ると、拒否された送信で添付が黙って消える
      msg.images = pendingAttachments.take(target!.tabId);
      postAttachments(st, target!.tabId);
      if (!isNonHumanCommandInput(msg.text)) {
        // hydration 中は token を journal entry へ載せる。失敗確定時に確定
        // user_message を配送する前に、同じ token の楽観バブルを撤去して二重表示を防ぐ
        target!.pushEvent(
          { kind: "user_message", turnId: null, text: msg.text, images: msg.images },
          undefined,
          undefined,
          clientToken
        );
        disposition("accepted-human");
      } else {
        disposition("accepted-nonhuman");
      }
      target!.conversation!.send(msg.text, msg.images);
      break;
    }
    case "interrupt":
      await target!.conversation?.interrupt();
      break;
    case "approvalDecision":
      target!.conversation?.resolveApproval(msg.requestId, msg.behavior, msg.answers);
      break;
    case "setMode":
      target!.permissionMode = msg.mode;
      // 実行中の会話にも即時適用（SDK setPermissionMode。未接続なら次回起動時に反映）
      await target!.conversation?.setPermissionMode(msg.mode);
      // 選択は LAISORA 内部へ保存する（保存先の根拠は resolveInitialMode 上のコメント）。
      // bypassPermissions（危険モード）だけは保存しない: 永続化すると次回起動から
      // 全セッションが確認なしで走る。危険モードはセッション限りに留める
      if (msg.mode !== "bypassPermissions") {
        void extensionContext?.globalState?.update(PERMISSION_MODE_KEY, msg.mode);
      }
      st.post({ type: "modeChanged", tabId: target!.tabId, mode: msg.mode });
      break;
    case "setEffort": {
      await applyEffortChange(st, target!, msg.effort as NonNullable<Session["effortOverride"]> | null);
      break;
    }
    case "setModel": {
      const s = target!;
      await applyModelChange(st, s, msg.model);
      break;
    }
  }
}

// CLIセッションの事前起動（Claude拡張と同じ体験）。失敗は致命ではないためログのみ。
// 送信時の ensureConversation と同じ直列化ガードを通るので二重起動しない。
export function warmup(s: Session): void {
  // 死んだ会話が残っている場合も事前起動の対象にする。isClosed を見ないと、バックエンドが
  // 落ちたあと s.conversation が非nullのまま残るため二度と warmup されず、コマンド候補・
  // モデル一覧・認証実測が送信するまで復旧しない（再生成は ensureConversationInner が行う）。
  if ((s.conversation && !s.conversation.isClosed) || s.closed || s.clearing) return;
  void ensureConversation(s).catch((e: unknown) =>
    output.appendLine(`[${s.title}] ${sinceActivation()} warmup失敗: ${String(e)}`)
  );
}

async function ensureConversation(s: Session): Promise<void> {
  // 並行 send による二重生成防止（レビューP2-1: 後勝ち上書きで孤児CLIプロセスが残留する）
  while (s.starting) await s.starting;
  const p = ensureConversationInner(s);
  s.starting = p.catch(() => {}).then(() => {
    s.starting = null;
  });
  return p;
}

async function ensureConversationInner(s: Session): Promise<void> {
  const logicalGenerationAtStart = s.logicalGeneration;
  // クラッシュ復帰の継続 ID（AUDIT-01）。live で始めたタブは resumeSessionId がどの経路でも
  // 埋まらないので、確定 ID は auth 側にしかない。フィールドへ書き戻さないのは、CLI が resume で
  // 同じ session ID を保つのか新しい ID へ fork するのかが未確定なため。書くと fork 側の挙動では
  // 古い ID に固着し、2 回目以降の復帰で新しい ID に積まれた会話を黙って捨てる
  let crashResumeSessionId: string | undefined;
  // 死んだ Conversation は捨てて再生成する（abort/クラッシュ後の恒久沈黙防止 — レビューR1-2）
  if (s.conversation?.isClosed) {
    s.guardrailRunner.settleConversationLost();
    void s.conversation.dispose();
    s.conversation = null;
    s.generation += 1; // generation はプロセス再起動ごとに増える
    // 旧プロセスの async 委任は新プロセスへ引き継がれない。残すと再ACKなしで running へ戻る
    s.clearLiveDelegations();
    s.backgroundActivity = createBackgroundActivityState();
    s.guardrail = clearProcessEphemeral(s.guardrail);
    s.lastContextTotalTokens = null;
    // 未使用タブ（warmup だけで送信していない）は resume 先の JSONL がまだ無い。
    // 判定は s.conversation = null の後で行う。前に置くと、閉じた Conversation の state が
    // idle とは限らないため未使用タブを使用済みと誤判定する
    crashResumeSessionId = isUnusedSession(s) ? undefined : s.auth?.sessionId;
  }
  if (s.conversation) return;

  const cfg = getLaisoraConfiguration();
  const settingSources = cfg.get<Array<"user" | "project" | "local">>(
    "claude.settingSources",
    ["user", "project", "local"]
  );
  const cwd = resolveSessionCwd(s);
  if (!cwd) {
    throw new Error(l10n.t("The working directory could not be determined (open a workspace or set laisora.defaultCwd)."));
  }
  s.cwd = cwd;

  // 通常起動の model は settingSources と CLI の環境・project 設定に解決を任せる。
  // LAISORA で明示選択した値だけを modelOverride として固定する。
  // 既存の設定キャッシュ更新境界は、model 以外の設定表示・権限初期値のため維持する。
  invalidateClaudeCodeSettingsCache();
  s.effectiveModel = s.modelOverride;
  // effortOverride は要求値であって適用観測ではない。実効値は init の auth_status だけが確定する。
  s.effectiveEffort = undefined;

  // hydration 中は捕捉した read-set の境界時刻（journal の到着 gate が使う値と同一）
  // を渡す。ここがずれると live の timestamp 継承と Host の gate が食い違い、境界を決めない
  // イベントが到着時に落ちる。種の合成規則は observed-timestamp-seed.ts
  const hydrating = s.hydration !== null && s.hydration.buffering ? s.hydration : null;
  const initialObservedTimestamp = observedTimestampSeed(
    hydrating?.arrivalTimestamp,
    s.lastRecordedEventTimestamp
  );

  // 既定値は CLI 本体の設定解決（settingSources=user）に任せ、独自設定は作らない
  // （ユーザー方針: Claude Code と常に同期）。ただしユーザーがこのタブで明示的に選んだ
  // モデル/effort は、会話プロセスを作り直しても引き継ぐ。
  // モデルと effort の両方を渡す。effort だけだと、/clear・effort 変更による再起動・クラッシュ復帰のたびに
  // モデルだけ既定へ戻り、チップの表示と実体が食い違う。
  const conv = new ClaudeConversation({
    cwd,
    initialObservedTimestamp,
    resumeSessionId: s.resumeSessionId ?? crashResumeSessionId,
    model: s.modelOverride ?? undefined,
    effort: s.effortOverride ?? undefined,
    permissionMode: s.permissionMode,
    settingSources,
    remoteControlAtStartup: cfg.get("claude.remoteControlAtStartup", false),
    progressTracking: normalizeProgressTracking(cfg.get("progressTracking", "observe")),
    claudeCodeExecutablePath: configuredClaudeExecutablePath(cfg),
    apiKeyPolicy: normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit")),
    fileLinkInstruction: cfg.get<boolean>("claude.fileLinkInstruction", true) !== false,
    interruptForceKillTimeoutMs: cfg.get("interruptForceKillTimeoutMs", 5000),
    onEvent: (ev, conversationId, meta) => {
      // CLI 既定の model は設定からは見えない。init が申告した実値を継承元にする
      if (
        ev.kind === "auth_status" &&
        conversationId === s.expectedConversationId
      ) {
        if (typeof ev.auth?.model === "string" && ev.auth.model.length > 0) {
          s.effectiveModel = ev.auth.model;
        }
        s.effectiveEffort = ev.auth?.effort ?? undefined;
        rederiveConfiguredEffort(store, s);
      }
      s.pushEvent(ev, conversationId, meta);
      if (ev.kind === "auth_status" && conversationId === s.expectedConversationId && ev.auth?.billingRealm === "api") {
        store?.post({
          type: "tabNotice",
          tabId: s.tabId,
          text: l10n.t(
            "Authenticated with an API key (billed to the API, not your subscription). To use your subscription, remove ANTHROPIC_API_KEY or set the API key policy to subscription only."
          ),
        });
      }
    },
    onApprovalRequest: (req) =>
      new Promise((resolve) => {
        conv.registerPendingApproval(req.requestId, req.toolName, resolve);
      }),
    log: (m) => output.appendLine(`[${s.title}] ${m}`),
  });
  // start 成功後に公開する（失敗時に壊れた Conversation が残留しないように — レビューR1-8）
  try {
    // ここで expected を切り替える（旧世代の遅延イベントは以後 pushEvent で落ちる）
    s.expectedConversationId = conv.conversationId;
    await conv.start();
    // start 中に論理セッションが入れ替わった場合は掴ませない（FP-1 の並べ替えで
    // detachConversation は start の完了を待たない）。掴ませると warmup が
    // 「会話がある」と見て resume 用の CLI を作らず、しかも切り離し済み ID なので
    // このプロセスのイベントは全て落ち、無言のタブになる。
    // return ではなく throw なのは、呼び出し側（send / handoff）が「解決したら
    // s.conversation は非 null」を前提に conversation! を叩くため。失敗として返せば
    // 既存の起動失敗経路（v4 F-5 の rejected / warmup の catch）へ入る
    if (s.logicalGeneration !== logicalGenerationAtStart) {
      void conv.dispose();
      throw new Error(l10n.t("The logical session of this tab changed while the conversation was starting (restore or clear)."));
    }
    s.conversation = conv;
    refreshConfiguredEffort(store, s, cwd, settingSources, conv);
    // スラッシュコマンド/モデル一覧をサジェスト・ピッカー用にWebviewへ供給（非同期・失敗しても無視）
    void conv.supportedCommands().then((cmds) => {
      if (s.conversation !== conv || cmds.length === 0) return;
      s.applyCommandList(cmds);
    });
    void conv.supportedModels().then((models) => {
      if (s.conversation !== conv) return;
      s.discoveredModels = models;
      recomputeModelRows(s);
      rederiveConfiguredEffort(store, s);
      if (s.models.length > 0) store?.post(modelsMessage(s));
    });
  } catch (e) {
    void conv.dispose();
    throw e;
  }
}
