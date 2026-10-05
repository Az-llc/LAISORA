import { applyFallbackModel, fallbackOriginalModel, resolveFallbackByChoice, type EventProvenance, type FallbackRevertOutcome, type NormalizedEventBody } from "./protocol";
import { join } from "node:path";
import { getLaisoraConfiguration } from "./claude-settings";
import { EXPERIMENT_HOLDOUT_PERCENT } from "./learning-experiment";
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
import { applyLiveDiscoveredModels, modelsMessage } from "./gateway-models";
import { resolveModelDisplayName } from "./model-display-name";
import { clearProcessEphemeral } from "./guardrail";
import { extensionContext, output, sinceActivation, store } from "./host-context";
import { INJECTED_TAG_RE as HUMAN_INPUT_INJECTED_TAG_RE, isNonHumanCommandInput } from "./human-input-vocabulary";
import { observedTimestampSeed } from "./observed-timestamp-seed";
import { normalizeProgressTracking } from "./progress-protocol";
import { normalizeApiKeyPolicy, type ModelInfo, type WebviewToHost } from "./protocol";
import { displayTitleFromSummary } from "./session-list";
import type { SessionStore } from "./store-surfaces";

const orchestrationPublishers = new WeakMap<ClaudeConversation, OrchestrationViewPublisher>();

export function postOrchestrationView(s: Session): void {
  const conv = s.conversation;
  if (!conv?.orchestrationActive || s.closed) return;
  let publisher = orchestrationPublishers.get(conv);
  if (publisher === undefined) {
    publisher = new OrchestrationViewPublisher(() => {
      if (s.closed || s.conversation !== conv) return undefined;
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

function publishConfiguredEffort(st: SessionStore | null | undefined, s: Session): void {
  const shown = effortDisplayFromSnapshot(
    s.configuredEffortSnapshot,
    s.effectiveModel ?? s.modelOverride,
    s.modelsFromLastRun ? [] : s.discoveredModels,
    s.effortOverride === undefined ? s.appliedEffort : undefined
  );
  s.configuredEffort = shown.configured;
  s.defaultEffort = shown.default;
  st?.post({
    type: "configuredEffortChanged",
    tabId: s.tabId,
    effort: shown.configured ?? null,
    model: s.initialModel ? null : s.configuredEffortSnapshot?.resolvedModel ?? null,
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
    if (s.initialModel && s.modelOverride === undefined && !s.auth?.model) s.effectiveModel = applied.model;
    s.modelFallback = applyFallbackModel(s.modelFallback, applied.model, Date.now(), s.models);
    publishConfiguredEffort(st, s);
    observeLaunchModel(st, s, conv, applied.model);
  });
}

function launchModelResolved(id: string, rows: readonly ModelInfo[]): string | undefined {
  const trimmed = id.trim();
  const exact = rows.find((m) => m.id === trimmed && m.id !== "default");
  if (exact !== undefined) return exact.resolvedModel ?? (trimmed.startsWith("claude-") ? trimmed : undefined);
  const extended = /\[1m\]$/i.test(trimmed);
  const base = trimmed.replace(/\[1m\]$/i, "");
  const row = rows.find((m) => m.id === base && m.id !== "default");
  const resolved = row?.resolvedModel ?? (base.startsWith("claude-") ? base : undefined);
  if (resolved === undefined) return undefined;
  return extended && !/\[1m\]$/i.test(resolved) ? `${resolved}[1m]` : resolved;
}

function observeLaunchModel(st: SessionStore | null | undefined, s: Session, conv: ClaudeConversation, model: string | undefined, listSettled = false): void {
  const check = s.launchModelCheck;
  if (check === undefined || check.conversation !== conv || s.closed) return;
  if (model !== undefined && check.observed === undefined) check.observed = model;
  if (listSettled) check.listSettled = true;
  if (check.observed === undefined || !check.listSettled || s.conversation !== conv) return;
  s.launchModelCheck = undefined;
  if (s.modelFallback !== undefined && s.modelFallback.resolvedAt === undefined) return;
  const requested = launchModelResolved(check.requested, s.models);
  const observed = launchModelResolved(check.observed, s.models);
  if (requested === undefined || observed === undefined || requested === observed) return;
  output.appendLine(`[${s.title}] launch model: requested=${check.requested} applied=${check.observed}`);
  st?.post({
    type: "tabNotice",
    tabId: s.tabId,
    text: l10n.t(
      "The Claude CLI is using {0} instead of {1}, which LAISORA passed for this conversation. A managed policy or an ANTHROPIC_* model setting may be overriding it.",
      resolveModelDisplayName(s.models, check.observed) ?? check.observed,
      resolveModelDisplayName(s.models, check.requested) ?? check.requested
    ),
  });
}

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
  const persistable = !s.modelsFromLastRun;
  const run = async (): Promise<void> => {
    if (s.closed || s.logicalGeneration !== logicalGeneration) return;
    const processGeneration = s.generation;
    const canonicalModel = persistable ? canonicalEffortModel(s) : undefined;
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

interface FallbackRestore {
  override: string | null | undefined;
  stillWanted: () => boolean;
}

async function applyModelChange(
  st: SessionStore,
  s: Session,
  requestedRaw: string | null,
  sessionOnly = false,
  restore?: FallbackRestore
): Promise<FallbackRevertOutcome | "discarded" | "unwanted"> {
  const persistable = !s.modelsFromLastRun;
  const requested =
    requestedRaw === "default" && !sessionOnly && s.models.some((m) => m.id === "default") ? null : requestedRaw;
  const logicalGeneration = s.logicalGeneration;
  const run = async (): Promise<FallbackRevertOutcome | "discarded" | "unwanted"> => {
    if (s.closed || s.logicalGeneration !== logicalGeneration) return "discarded";
    while (s.starting) await s.starting;
    if (s.closed || s.logicalGeneration !== logicalGeneration) return "discarded";
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
          if (restore === undefined) reportProfileRestart(s, "model");
        } else if (targetState === "current") {
          output.appendLine(`[${s.title}] setModel 失敗: ${String(error)}`);
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
        if (restore === undefined) reportProfileRestart(s, "model");
        return "failed";
      }
    }

    s.modelOverride = restore === undefined ? requested : restore.override;
    s.launchModelCheck = undefined;
    clearObservedEffort(s);
    const knownRow = persistable && (requested === null || s.models.some((m) => m.id === requested));
    const saved: SettingsWriteResult | null = knownRow && !sessionOnly ? updateClaudeCodeSettings({ model: requested }) : null;
    if (conv !== null && s.conversation === conv) s.effectiveModel = requested;
    const label = requested === null ? null : s.models.find((m) => m.id === requested)?.label ?? requested;
    const notice = sessionOnly
      ? l10n.t("Changed model to {0} for this conversation.", label ?? "")
      : saved === null
      ? s.models.length === 0 || !persistable
        ? l10n.t("LAISORA: Changed model to {0} for this session; it was not saved to settings.json because the model list has not loaded yet.", label ?? s.models.find((m) => m.id === "default")?.label ?? "default")
        : l10n.t("LAISORA: Changed model to {0} for this session; it was not saved to settings.json because the model is not in the model list.", label ?? "")
      : !saved.ok
        ? label === null
          ? l10n.t("LAISORA: Reset the model to the default for this session, but the change was not saved: {0}.", settingsWriteFailureText(saved))
          : l10n.t("LAISORA: Changed model to {0} for this session, but it was not saved: {1}.", label, settingsWriteFailureText(saved))
        : label === null
          ? l10n.t("LAISORA: Reset the model to the default (removed model from settings.json).")
          : l10n.t("LAISORA: Changed model to {0} (saved to settings.json).", label);
    const openFallback = s.modelFallback?.resolvedAt === undefined ? s.modelFallback : undefined;
    s.modelFallback = resolveFallbackByChoice(s.modelFallback, requested, Date.now(), s.models);
    if (restore === undefined && (s.modelFallback?.autoRevert === "applied" || s.modelFallback?.autoRevert === "deferred")) {
      s.modelFallback = { ...s.modelFallback, autoRevert: "chosen" };
    }
    if (restore === undefined) st.post({ type: "modelChanged", tabId: s.tabId, model: requested, notice, applied: true });
    if (restore === undefined && openFallback !== undefined) {
      s.pushEvent({ kind: "model_fallback_revert", turnId: openFallback.notice.turnId,
        originalModel: fallbackOriginalModel(openFallback), outcome: "chosen" });
    }
    s.configuredEffortSnapshot = undefined;
    s.appliedModel = undefined;
    s.appliedEffort = undefined;
    s.configuredEffortGeneration += 1;
    publishConfiguredEffort(st, s);
    output.appendLine(`[${s.title}] setModel: ${requested ?? "(既定)"} を適用`);
    if (conv === null || conv.isClosed) {
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
  if (pending?.conversation !== conv || pending.turnId !== ev.turnId || s.modelFallback?.resolvedAt !== undefined) {
    s.fallbackRevert = { conversation: conv, turnId: ev.turnId, originalModel: ev.originalModel, priorOverride: s.modelOverride };
  }
  return { ...ev, autoRevert: "pending" };
}

function settleFallbackRevert(st: SessionStore | null | undefined, s: Session, conv: ClaudeConversation, ev: LiveEventBody): void {
  const pending = s.fallbackRevert;
  if (pending === undefined || pending.conversation !== conv) return;
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
  if (!conv.isClosed) conv.rearmRootModelObservation();
  const logicalGeneration = s.logicalGeneration;
  void applyModelChange(st, s, pending.originalModel, true, { override: pending.priorOverride, stillWanted }).then((result) => {
    if (result !== "discarded" && result !== "unwanted" && !s.closed && s.logicalGeneration === logicalGeneration) record(result);
  });
}

function launchModel(s: Session): string | null | undefined {
  const fallback = s.modelFallback;
  if (fallback !== undefined && fallback.resolvedAt === undefined) return fallback.appliedModel;
  if (typeof s.modelOverride === "string") return s.modelOverride;
  if (fallback !== undefined && (fallback.autoRevert === "applied" || fallback.autoRevert === "deferred")) return fallback.appliedModel;
  return s.initialModel ?? undefined;
}

export async function handleConversationMessage(
  st: SessionStore,
  msg: Extract<WebviewToHost, { type: "send" | "cancelAutoResume" | "interrupt" | "approvalDecision" | "setMode" | "setEffort" | "setModel" }>,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "send": {
      target!.conversation?.cancelAutoResume();
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
      if (target!.clearing) {
        target!.pushEvent({
          kind: "error",
          message: l10n.t("Cannot send while the conversation is being cleared (wait a moment and resend)."),
          fatal: false,
        });
        disposition("rejected");
        break;
      }
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
      if (target!.closed || target!.clearing) {
        disposition("rejected");
        break;
      }
      if (!target!.autoTitled) {
        const firstLine = msg.text.trim().split("\n")[0];
        if (firstLine) {
          const hydrating = target!.hydration;
          if (hydrating !== null && hydrating.buffering) {
            hydrating.liveTitleCandidate = firstLine;
          } else {
            target!.title = displayTitleFromSummary(firstLine, target!.tabId);
            target!.autoTitled = true;
            st.post({ type: "tabRenamed", tabId: target!.tabId, title: target!.title });
          }
        }
      }
      msg.images = pendingAttachments.take(target!.tabId);
      postAttachments(st, target!.tabId);
      if (!isNonHumanCommandInput(msg.text)) {
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

function sessionObservedTimestampSeed(s: Session): number | undefined {
  const hydrating = s.hydration !== null && s.hydration.buffering ? s.hydration : null;
  return observedTimestampSeed(hydrating?.arrivalTimestamp, s.lastRecordedEventTimestamp);
}

async function ensureConversation(s: Session): Promise<void> {
  const logicalGeneration = s.logicalGeneration;
  const requestedAt = Date.now();
  if (s.resumePreparation !== null) await s.resumePreparation.ready;
  while (s.starting) await s.starting;
  if (s.closed || s.logicalGeneration !== logicalGeneration) {
    throw new Error(l10n.t("The logical session of this tab changed while the conversation was starting (restore or clear)."));
  }
  const generation = s.logicalGeneration;
  const p = ensureConversationInner(s, requestedAt);
  s.starting = p.catch(() => {
    cancelPendingModelProfileResearch(s, generation);
  }).then(() => {
    s.starting = null;
  });
  return p;
}

async function ensureConversationInner(s: Session, requestedAt: number): Promise<void> {
  const innerT0 = Date.now();
  const logicalGenerationAtStart = s.logicalGeneration;
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

  invalidateClaudeCodeSettingsCache();
  if (s.initialModel === undefined) {
    s.initialModel = cfg.get<string>("claude.initialModel", "").trim() || null;
  }
  s.effectiveModel = launchModel(s);
  s.effectiveEffort = undefined;

  const initialObservedTimestamp = sessionObservedTimestampSeed(s);

  const learningEnabled = cfg.get<boolean>("learning.enabled", false) === true;
  const learningConfiguredSnapshot = learningEnabled ? await resolveConfiguredEffortSnapshot(cwd, settingSources) : undefined;
  if (s.closed || s.logicalGeneration !== logicalGenerationAtStart) {
    throw new Error(l10n.t("The logical session of this tab changed while the conversation was starting (restore or clear)."));
  }
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
    learningEvidenceSource: s.learningEvidenceSource,
    learningDedicated: s.learningDedicated,
    learningSwitches: () => {
      const current = getLaisoraConfiguration();
      return { enabled: current.get<boolean>("learning.enabled", false), automaticAdoption: current.get<boolean>("learning.automaticAdoption", true),
        targetInjection: current.get<boolean>("learning.targetInjection", true), observationDelivery: current.get<boolean>("learning.observationDelivery", true),
        publicDelivery: current.get<boolean>("learning.publicDelivery", true), experiment: current.get<boolean>("learning.experiment", true),
        guard: current.get<boolean>("learning.guard", true) };
    },
    learningHoldoutPercent: () => getLaisoraConfiguration().get<number>("learning.holdoutPercent", EXPERIMENT_HOLDOUT_PERCENT),
    learningDirectory: extensionContext?.globalStorageUri?.fsPath ? join(extensionContext.globalStorageUri.fsPath, "laisora-learning") : undefined,
    configuredResolvedModel: learningConfiguredSnapshot?.resolvedModel,
    orchestrationAgents: cfg.get<unknown>("orchestration.agents", []),
    externalModels: cachedExternalModels(),
    externalTimeoutMinutes: cfg.get<number>("orchestration.externalTimeoutMinutes", 10),
    orchestrationRunsDirectory: orchestrationRunsDirectoryOf(extensionContext?.globalStorageUri?.fsPath),
    conductorPolicy: cfg.get<string>("orchestration.conductorPolicy", ""),
    onLearningRecorded: postSettingsState,
    onOrchestrationChanged: () => {
      if (s.conversation === conv) postOrchestrationView(s);
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
          observeLaunchModel(store, s, conv, ev.auth.model);
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
        conv.registerPendingApproval(req.requestId, req.toolName, resolve, req.toolUseId);
      }),
    log: (m) => output.appendLine(`[${s.title}] ${m}`),
  });
  try {
    s.expectedConversationId = conv.conversationId;
    s.launchModelCheck = typeof s.effectiveModel === "string" && s.effectiveModel !== "default"
      ? { conversation: conv, requested: s.effectiveModel, listSettled: false }
      : undefined;
    const convStartT0 = Date.now();
    await conv.start();
    const startedAt = Date.now();
    output.appendLine(
      `[${s.title}] ${sinceActivation()} CLI 起動: ${startedAt - requestedAt}ms` +
        `（待ち ${innerT0 - requestedAt}ms / 設定 ${convStartT0 - innerT0}ms / start ${startedAt - convStartT0}ms）`
    );
    if (s.closed || s.logicalGeneration !== logicalGenerationAtStart) {
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
      if (s.closed || s.conversation !== conv) return;
      applyLiveDiscoveredModels(s, models);
      rederiveConfiguredEffort(store, s);
      if (s.models.length > 0) store?.post(modelsMessage(s));
      output.appendLine(
        `[${s.title}] ${sinceActivation()} モデル一覧: ${s.models.length}件（起動要求から ${Date.now() - requestedAt}ms / start 後 ${Date.now() - startedAt}ms）`
      );
      observeLaunchModel(store, s, conv, undefined, models.length > 0);
    });
  } catch (e) {
    void conv.dispose();
    throw e;
  }
}
