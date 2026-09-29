import { applyFallbackModel, fallbackOriginalModel, resolveFallbackByChoice, type EventProvenance, type FallbackRevertOutcome, type NormalizedEventBody } from "./protocol";
import { join } from "node:path";
import * as vscode from "vscode";
import { getLaisoraConfiguration } from "./claude-settings";
import { cancelPendingModelProfileResearch, finishModelProfileResearch, flushModelProfileResearch } from "./learning-research";
import { postSettingsState } from "./settings-panel";
import { persistInitialTabTitle } from "./session-list-wiring";
import { cachedExternalModels, configuredProfileRoster } from "./gateway-host-actions";

import {
  PERMISSION_MODE_KEY,
  canonicalEffortModel,
  configuredClaudeExecutablePath,
  effortDisplayFromSnapshot,
  invalidateClaudeCodeSettingsCache,
  resolveSessionCwd,
  resolveConfiguredEffortSnapshot,
  saveClaudeModelEffort,
  updateClaudeCodeSettings,
  type SettingsWriteResult,
} from "./claude-settings";
import { createBackgroundActivityState } from "./background-activity";
import { ClaudeConversation } from "./claudeHost";
import { OrchestrationViewPublisher, orchestrationViewForConversation } from "./orchestration-view";
import { orchestrationRunsDirectoryOf } from "./orchestration-external";
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

const orchestrationPublishers = new WeakMap<ClaudeConversation, OrchestrationViewPublisher>();

export function postOrchestrationView(s: Session): void {
  const conv = s.conversation;
  if (!conv?.orchestrationActive || s.closed) return; // R-ORC-38
  let publisher = orchestrationPublishers.get(conv);
  if (publisher === undefined) {
    publisher = new OrchestrationViewPublisher(() => {
      if (s.closed || s.conversation !== conv) return undefined; // R-ORC-21
      const current = getLaisoraConfiguration();
      return orchestrationViewForConversation(conv, {
        orchestrationEnabled: current.get<boolean>("orchestration.enabled", false),
        learningEnabled: current.get<boolean>("learning.enabled", false),
        orchestrationAgents: current.get<unknown>("orchestration.agents", []),
        externalTimeoutMinutes: current.get<number>("orchestration.externalTimeoutMinutes", 10),
        conductorPolicy: current.get<string>("orchestration.conductorPolicy", ""),
      });
    }, (state) => store?.post({ type: "orchestrationView", tabId: s.tabId, state }));
    orchestrationPublishers.set(conv, publisher);
  }
  publisher.schedule();
}

// publishConfiguredEffort must also publish model resolution when effort is unchanged.
function publishConfiguredEffort(st: SessionStore | null | undefined, s: Session): void {
  const shown = effortDisplayFromSnapshot(
    s.configuredEffortSnapshot,
    s.effectiveModel ?? s.modelOverride,
    s.discoveredModels,
    s.effortOverride === undefined ? s.appliedEffort : undefined
  );
  s.configuredEffort = shown.configured;
  s.defaultEffort = shown.default;
  st?.post({
    type: "configuredEffortChanged",
    tabId: s.tabId,
    effort: shown.configured ?? null,
    model: s.configuredEffortSnapshot?.resolvedModel ?? null,
    defaultEffort: shown.default ?? null,
    appliedModel: s.appliedModel ?? null,
    ...(s.appliedEffort === undefined ? {} : { appliedEffort: s.appliedEffort }),
  });
}

function rederiveConfiguredEffort(st: SessionStore | null | undefined, s: Session): void {
  if (s.configuredEffortSnapshot === undefined) return;
  publishConfiguredEffort(st, s);
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
  publishConfiguredEffort(st, s);
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
  const fallbackAtRequest = fallbackReadingMark(s);
  void conv.appliedSettings().then((applied) => {
    if (applied === undefined || !current() || fallbackReadingStale(s, fallbackAtRequest)) return;
    s.appliedEffort = applied.effort;
    s.appliedModel = applied.model;
    s.modelFallback = applyFallbackModel(s.modelFallback, applied.model, Date.now(), s.models);
    // 設定解決を待たずに適用観測を届ける（publishConfiguredEffort）。
    publishConfiguredEffort(st, s);
  });
}

// R-GW-07: a reading requested before a newer fallback notice or model observation is stale; a restore record alone
// does not outdate it (verify-gateway-wiring#GW-RFm12).
function fallbackReadingMark(s: Session): { notice?: object; model?: string } {
  return { notice: s.modelFallback?.notice, model: s.modelFallback?.appliedModel };
}

function fallbackReadingStale(s: Session, mark: { notice?: object; model?: string }): boolean {
  return s.modelFallback?.notice !== mark.notice || s.modelFallback?.appliedModel !== mark.model;
}

export function refreshFallbackAppliedModel(st: SessionStore, s: Session): void {
  const conv = s.conversation;
  const generation = s.generation;
  if (!s.modelFallback || !conv || conv.isClosed) return;
  const mark = fallbackReadingMark(s);
  void conv.appliedSettings().then(applied => {
    if (!applied || s.closed || s.conversation !== conv || s.generation !== generation || fallbackReadingStale(s, mark)) return;
    s.modelFallback = applyFallbackModel(s.modelFallback, applied.model, Date.now(), s.models);
    s.appliedModel = applied.model;
    s.effectiveModel = applied.model;
    s.appliedEffort = applied.effort;
    publishConfiguredEffort(st, s);
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

// 保存失敗の通知先は操作した会話に揃える（applyModelChange / applyEffortChange、R-DSP-01 / R-CMD-02）。
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
    // 待機中の再起動で要求を失効させないため、世代は profileChangeTail の待機後に捕捉する。
    const processGeneration = s.generation;
    // 適用先と保存先を同じ観測点で固定する（verify-gateway-wiring#MC-3）。
    const canonicalModel = canonicalEffortModel(s);
    const conv = s.conversation;
    if (conv !== null && !conv.isClosed) {
      try {
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
    publishConfiguredEffort(st, s);
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

// R-GW-09: the automatic restore sends the fallback's original model to the CLI but keeps the tab's own selection (verify-gateway-wiring#GW-RFm16).
interface FallbackRestore {
  override: string | null | undefined;
  stillWanted: () => boolean;
}

async function applyModelChange(
  st: SessionStore,
  s: Session,
  requested: string | null,
  sessionOnly = false,
  restore?: FallbackRestore
): Promise<FallbackRevertOutcome | "discarded" | "unwanted"> {
  const logicalGeneration = s.logicalGeneration;
  const run = async (): Promise<FallbackRevertOutcome | "discarded" | "unwanted"> => {
    if (s.closed || s.logicalGeneration !== logicalGeneration) return "discarded";
    // R-GW-09: a choice applied while the restore waited in profileChangeTail wins (verify-gateway-wiring#GW-RFm9).
    if (restore !== undefined && !restore.stillWanted()) return "unwanted";
    const processGeneration = s.generation;
    const previous = s.modelOverride;
    const conv = s.conversation;
    if (conv !== null && !conv.isClosed) {
      try {
        await conv.setModel(requested ?? undefined);
      } catch (error) {
        const targetState = profileTargetState(s, logicalGeneration, processGeneration, conv);
        if (targetState === "restarted") {
          // R-GW-09: the restore's recorded "failed" outcome is its only notice (verify-gateway-wiring#GW-RFm23).
          if (restore === undefined) reportProfileRestart(s, "model");
        } else if (targetState === "current") {
          output.appendLine(`[${s.title}] setModel 失敗: ${String(error)}`);
          // R-GW-09: nothing was selected on the restore path; its recorded "failed" outcome is the notice (verify-gateway-wiring#GW-RFm22).
          if (restore !== undefined) return "failed";
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
        return targetState === "discard" ? "discarded" : "failed";
      }
      const targetState = profileTargetState(s, logicalGeneration, processGeneration, conv);
      if (targetState === "discard") return "discarded";
      if (targetState === "restarted") {
        // R-GW-09: the restore's recorded "failed" outcome is its only notice (verify-gateway-wiring#GW-RFm24).
        if (restore === undefined) reportProfileRestart(s, "model");
        return "failed";
      }
    }

    s.modelOverride = restore === undefined ? requested : restore.override;
    clearObservedEffort(s);
    const knownRow = requested === null || s.models.length === 0 || s.models.some((m) => m.id === requested);
    const saved: SettingsWriteResult | null = knownRow && !sessionOnly ? updateClaudeCodeSettings({ model: requested }) : null;
    // src/claudeHost.ts#setModel は認証観測を更新しないため、明示指定を分析・要約へ渡す。
    if (conv !== null && s.conversation === conv) s.effectiveModel = requested;
    // 適用・保存の結果を確認してから通知文を組む（verify-gateway-wiring#NL-MODEL-1、R-DSP-01 / R-CMD-02）。
    const label = requested === null ? null : s.models.find((m) => m.id === requested)?.label ?? requested;
    const notice = sessionOnly
      ? l10n.t("Changed model to {0} for this conversation.", label ?? "")
      : saved === null
      ? l10n.t("LAISORA: Changed model to {0} for this session; it was not saved to settings.json because the model is not in the model list.", label ?? "")
      : !saved.ok
        ? label === null
          ? l10n.t("LAISORA: Reset the model to the default for this session, but the change was not saved: {0}.", settingsWriteFailureText(saved))
          : l10n.t("LAISORA: Changed model to {0} for this session, but it was not saved: {1}.", label, settingsWriteFailureText(saved))
        : label === null
          ? l10n.t("LAISORA: Reset the model to the default (removed model from settings.json).")
          : l10n.t("LAISORA: Changed model to {0} (saved to settings.json).", label);
    const openFallback = s.modelFallback?.resolvedAt === undefined ? s.modelFallback : undefined;
    s.modelFallback = resolveFallbackByChoice(s.modelFallback, requested, Date.now());
    // R-GW-09: the recorded restore outcome is the notice for the automatic restore (verify-gateway-wiring#GW-RFm17).
    if (restore === undefined) st.post({ type: "modelChanged", tabId: s.tabId, model: requested, notice, applied: true });
    // R-CNV-43: the explicit choice is recorded so a replay does not reopen the confirmation (verify-gateway-wiring#GW-RFm15).
    if (restore === undefined && openFallback !== undefined) {
      s.pushEvent({ kind: "model_fallback_revert", turnId: openFallback.notice.turnId,
        originalModel: fallbackOriginalModel(openFallback), outcome: "chosen" });
    }
    s.configuredEffortSnapshot = undefined;
    // 切替前の適用観測を次の表示・分析へ持ち越さない（verify-gateway-wiring#MC-4）。
    s.appliedModel = undefined;
    s.appliedEffort = undefined;
    s.configuredEffortGeneration += 1;
    publishConfiguredEffort(st, s);
    output.appendLine(`[${s.title}] setModel: ${requested ?? "(既定)"} を適用`);
    if (conv === null || conv.isClosed) {
      // R-GW-09: the restore never starts a process; the next send launches on launchModel (verify-gateway-wiring#GW-RFm18).
      if (restore !== undefined) return "deferred";
      warmup(s);
    } else {
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
    return "applied";
  };
  const queued = s.profileChangeTail.then(run, run);
  s.profileChangeTail = queued.then(() => {}, () => {});
  return await queued;
}

export const FALLBACK_REVERT_SETTING = "claude.restoreModelAfterRefusalFallback";
const FALLBACK_REVERT_TURN_END_KINDS: ReadonlySet<NormalizedEventBody["kind"]> =
  new Set(["turn_completed", "turn_failed", "turn_interrupted", "conversation_closed"]);
type LiveEventBody = NormalizedEventBody & { provenance?: EventProvenance };

function noteFallbackRevert(s: Session, conv: ClaudeConversation, ev: LiveEventBody): LiveEventBody {
  if (ev.kind !== "model_refusal_fallback" || ev.scope !== "session") return ev;
  if (getLaisoraConfiguration().get<boolean>(FALLBACK_REVERT_SETTING, true) === false) return { ...ev, autoRevert: "off" };
  const pending = s.fallbackRevert;
  // R-GW-09: a second fallback in the same turn restores the model the turn started with (verify-gateway-wiring#GW-RFm21).
  if (pending?.conversation !== conv || pending.turnId !== ev.turnId || s.modelFallback?.resolvedAt !== undefined) {
    s.fallbackRevert = { conversation: conv, turnId: ev.turnId, originalModel: ev.originalModel, priorOverride: s.modelOverride };
  }
  return { ...ev, autoRevert: "pending" };
}

// R-GW-09: one attempt per pending fallback (verify-gateway-wiring#GW-RFm4).
function settleFallbackRevert(st: SessionStore | null | undefined, s: Session, conv: ClaudeConversation, ev: LiveEventBody): void {
  const pending = s.fallbackRevert;
  if (pending === undefined || pending.conversation !== conv) return;
  // R-GW-09: a notice that arrives outside a turn is settled at once (verify-gateway-wiring#GW-RFm13).
  if (!FALLBACK_REVERT_TURN_END_KINDS.has(ev.kind) && !(ev.kind === "model_refusal_fallback" && conv.state === "idle")) return;
  s.fallbackRevert = undefined;
  const notice = s.modelFallback?.notice;
  const stillWanted = (): boolean => s.modelFallback !== undefined && s.modelFallback.notice === notice &&
    s.modelFallback.resolvedAt === undefined;
  if (!stillWanted()) return;
  const record = (outcome: FallbackRevertOutcome): void =>
    s.pushEvent({ kind: "model_fallback_revert", turnId: pending.turnId, originalModel: pending.originalModel, outcome });
  if (!st) {
    record("failed");
    return;
  }
  // R-GW-09: the next root model is observed even when it is the fallback model again (verify-gateway-wiring#GW-RFm14).
  if (!conv.isClosed) conv.rearmRootModelObservation();
  const logicalGeneration = s.logicalGeneration;
  void applyModelChange(st, s, pending.originalModel, true, { override: pending.priorOverride, stillWanted }).then((result) => {
    if (result !== "discarded" && result !== "unwanted" && !s.closed && s.logicalGeneration === logicalGeneration) record(result);
  });
}

// R-GW-09: a resumed CLI keeps the transcript's model unless one is passed,
// so a fallback restored by LAISORA is pinned for the next launch (verify-gateway-wiring#GW-RFm19).
function launchModel(s: Session): string | null | undefined {
  const fallback = s.modelFallback;
  if (fallback !== undefined && fallback.resolvedAt === undefined) return fallback.appliedModel;
  if (s.modelOverride !== undefined || fallback === undefined) return s.modelOverride;
  return fallback.autoRevert === "applied" || fallback.autoRevert === "deferred" ? fallback.appliedModel : undefined;
}

export async function handleConversationMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "send" | "cancelAutoResume" | "interrupt" | "approvalDecision" | "setMode" | "setEffort" | "setModel" }>,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "send": {
      target!.conversation?.cancelAutoResume();
      // 楽観表示の確定・撤去は送信時のトークンで対応付ける（src/protocol.ts#ResumeHydrationSendDisposition）。
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
      // R-SES-08: クリア対象へ投入しない（verify-tab-restore#TR-CLR）。
      if (target!.clearing) {
        target!.pushEvent({
          kind: "error",
          message: l10n.t("Cannot send while the conversation is being cleared (wait a moment and resend)."),
          fatal: false,
        });
        disposition("rejected");
        break;
      }
      // src/session-transcript.ts#extractHumanUserText と非人間入力の扱いを揃える（R-HND-05）。
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
      // 起動待ちの後にも投入先を検証する（R-SES-08、verify-tab-restore#TR-CLR）。
      if (target!.closed || target!.clearing) {
        disposition("rejected");
        break;
      }
      if (!target!.autoTitled) {
        const firstLine = msg.text.trim().split("\n")[0];
        if (firstLine) {
          const hydrating = target!.hydration;
          if (hydrating !== null && hydrating.buffering) {
            // 履歴側の命名を先に適用する（src/resume-hydration.ts#runResumeHydration、R-SES-05）。
            hydrating.liveTitleCandidate = firstLine;
          } else {
            target!.title = displayTitleFromSummary(firstLine, target!.tabId);
            target!.autoTitled = true;
            st.post({ type: "tabRenamed", tabId: target!.tabId, title: target!.title });
          }
        }
      }
      // 非人間コマンドも送信自体は止めない（src/human-input-vocabulary.ts#isNonHumanCommandInput）。
      // 拒否した送信の添付を保持するための取得境界（src/pending-attachments.ts#pendingAttachments、R-CNV-11）。
      msg.images = pendingAttachments.take(target!.tabId);
      postAttachments(st, target!.tabId);
      if (!isNonHumanCommandInput(msg.text)) {
        // 確定配送との重複を避けるため、楽観表示と照合できるトークンを渡す（src/protocol.ts#ResumeHydrationSendDisposition）。
        target!.pushEvent(
          { kind: "user_message", turnId: null, text: msg.text, images: msg.images, sentAt: Date.now() },
          undefined,
          undefined,
          clientToken
        );
        disposition("accepted-human");
      } else {
        disposition("accepted-nonhuman");
      }
      // 復元後の送信にも観測済み時刻を引き継ぐ（sessionObservedTimestampSeed）。
      target!.conversation!.send(msg.text, msg.images, sessionObservedTimestampSeed(target!));
      break;
    }
    case "cancelAutoResume":
      target!.conversation?.cancelAutoResume();
      break;
    case "interrupt":
      await target!.conversation?.interrupt();
      break;
    case "approvalDecision":
      target!.conversation?.resolveApproval(msg.requestId, msg.behavior, msg.answers);
      break;
    case "setMode":
      target!.permissionMode = msg.mode;
      await target!.conversation?.setPermissionMode(msg.mode);
      // 永続化の根拠は src/claude-settings.ts#resolveInitialMode。
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
      await applyModelChange(st, s, msg.model, msg.sessionOnly);
      break;
    }
  }
}

export function warmup(s: Session): void {
  if ((s.conversation && !s.conversation.isClosed) || s.closed || s.clearing) return;
  void ensureConversation(s).catch((e: unknown) =>
    output.appendLine(`[${s.title}] ${sinceActivation()} warmup失敗: ${String(e)}`)
  );
}

// 到着判定と同じ境界時刻を渡す（src/observed-timestamp-seed.ts#observedTimestampSeed）。
function sessionObservedTimestampSeed(s: Session): number | undefined {
  const hydrating = s.hydration !== null && s.hydration.buffering ? s.hydration : null;
  return observedTimestampSeed(hydrating?.arrivalTimestamp, s.lastRecordedEventTimestamp);
}

async function ensureConversation(s: Session): Promise<void> {
  while (s.starting) await s.starting;
  const generation = s.logicalGeneration;
  const p = ensureConversationInner(s);
  s.starting = p.catch(() => {
    cancelPendingModelProfileResearch(s, generation);
  }).then(() => {
    s.starting = null;
  });
  return p;
}

async function ensureConversationInner(s: Session): Promise<void> {
  const logicalGenerationAtStart = s.logicalGeneration;
  // 継続先を固定せず、終了した会話の認証観測から取得する（verify-gateway-wiring#GW-CR-02）。
  let crashResumeSessionId: string | undefined;
  if (s.conversation?.isClosed) {
    s.guardrailRunner.settleConversationLost();
    void s.conversation.dispose();
    s.conversation = null;
    s.generation += 1;
    s.clearLiveDelegations();
    s.backgroundActivity = createBackgroundActivityState();
    s.guardrail = clearProcessEphemeral(s.guardrail);
    s.lastContextTotalTokens = null;
    // 未使用判定は会話を切り離してから行う（src/session.ts#isUnusedSession、verify-gateway-wiring#GW-CR-01）。
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

  // 設定の予測を起動時の明示指定へ昇格させない（verify-gateway-wiring#MC-1）。
  invalidateClaudeCodeSettingsCache();
  s.effectiveModel = launchModel(s);
  // 要求値を適用観測として扱わない（clearObservedEffort）。
  s.effectiveEffort = undefined;

  const initialObservedTimestamp = sessionObservedTimestampSeed(s);

  const learningEnabled = cfg.get<boolean>("learning.enabled", false) === true;
  const learningConfiguredSnapshot = learningEnabled ? await resolveConfiguredEffortSnapshot(cwd, settingSources) : undefined;
  const conv = new ClaudeConversation({
    cwd,
    initialObservedTimestamp,
    resumeSessionId: s.resumeSessionId ?? crashResumeSessionId,
    model: s.effectiveModel ?? undefined,
    effort: s.effortOverride ?? undefined,
    permissionMode: s.permissionMode,
    settingSources,
    remoteControlAtStartup: cfg.get("claude.remoteControlAtStartup", false),
    progressTracking: normalizeProgressTracking(cfg.get("progressTracking", "observe")),
    claudeCodeExecutablePath: configuredClaudeExecutablePath(cfg),
    apiKeyPolicy: normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit")),
    fileLinkInstruction: cfg.get<boolean>("claude.fileLinkInstruction", true) !== false,
    planInstruction: cfg.get<boolean>("claude.planInstruction", true) !== false,
    orchestrationEnabled: cfg.get<boolean>("orchestration.enabled", false) === true,
    learningEnabled,
    learningDirectory: extensionContext?.globalStorageUri?.fsPath ? join(extensionContext.globalStorageUri.fsPath, "laisora-learning") : undefined,
    learningScope: vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(cwd))?.name ?? "global",
    configuredResolvedModel: learningConfiguredSnapshot?.resolvedModel,
    orchestrationAgents: cfg.get<unknown>("orchestration.agents", []),
    externalModels: cachedExternalModels(),
    externalTimeoutMinutes: cfg.get<number>("orchestration.externalTimeoutMinutes", 10),
    orchestrationRunsDirectory: orchestrationRunsDirectoryOf(extensionContext?.globalStorageUri?.fsPath),
    conductorPolicy: cfg.get<string>("orchestration.conductorPolicy", ""),
    onLearningRecorded: postSettingsState,
    onOrchestrationChanged: () => {
      if (s.conversation === conv) postOrchestrationView(s); // R-ORC-21
    },
    interruptForceKillTimeoutMs: cfg.get("interruptForceKillTimeoutMs", 5000),
    onEvent: (raw, conversationId, meta) => {
      const own = conversationId === s.expectedConversationId && !s.closed;
      const ev = own ? noteFallbackRevert(s, conv, raw) : raw;
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
      if (conversationId === s.expectedConversationId &&
        ["auth_status", "turn_completed", "turn_failed", "turn_interrupted"].includes(ev.kind)) {
        persistInitialTabTitle(s);
      }
      if (["turn_completed", "turn_failed", "turn_interrupted"].includes(ev.kind)) {
        finishModelProfileResearch(s, conv);
        setTimeout(() => flushModelProfileResearch(s, getLaisoraConfiguration().get<boolean>("learning.enabled", false), cachedExternalModels(), configuredProfileRoster()), 0);
      }
      if (own) settleFallbackRevert(store, s, conv, ev);
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
  try {
    s.expectedConversationId = conv.conversationId;
    await conv.start();
    // 失効時も起動失敗として返す。ensureConversation の呼び出し側は成功後に会話の存在を前提とする。
    if (s.logicalGeneration !== logicalGenerationAtStart) {
      void conv.dispose();
      throw new Error(l10n.t("The logical session of this tab changed while the conversation was starting (restore or clear)."));
    }
    s.conversation = conv;
    flushModelProfileResearch(s, getLaisoraConfiguration().get<boolean>("learning.enabled", false), cachedExternalModels(), configuredProfileRoster());
    postOrchestrationView(s);
    refreshConfiguredEffort(store, s, cwd, settingSources, conv);
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
