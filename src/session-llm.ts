import { getLaisoraConfiguration } from "./claude-settings";
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";

import type * as ClaudeCodeSdk from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { sdkClaudeCodeVersion } from "./claudeHost";
import { configuredClaudeExecutablePath, resolveSessionCwd } from "./claude-settings";
import { output } from "./host-context";
import {
  runLlmAnalysis,
  type LlmAnalysisClient,
  type LlmAnalysisOutcome,
  type LlmAnalysisProgress,
} from "./llm-analysis-client";
import {
  buildLlmAnalysisInput,
  formatInputCoverageLabel,
  LLM_PER_CALL_TIMEOUT_MS,
  type LlmAnalysisInputEvent,
  type TranscriptGapSummary,
} from "./llm-analysis-input";
import { LLM_ANALYSIS_PROMPT_VERSION, llmAnalysisOutputLanguage } from "./llm-analysis-prompt";
import { createSdkLlmAnalysisClient } from "./llm-analysis-sdk-client";
import { normalizeApiKeyPolicy } from "./protocol";
import { asFindingVerificationModelFromPayload } from "./llm-finding-verify";
import { loadContextFiles } from "./llm-context-files";
import {
  projectLlmFindingDiagnostics,
  projectPersistedActionFindings,
  unavailableCode,
} from "./llm-report";
import type { EffortLevel, PersistedAnalysisArtifact } from "./analysis-persistence";
import { formatPersistenceLabel } from "./analysis-persistence";
import { derivationFailureLabel, llmAnalysisEnabled, llmDiagnosticsAudience, semanticViewEnabled } from "./session-semantic";
import { isInSessionStore, inspectorSessionFile } from "./session-files";
import { readSessionHistory } from "./session-transcript";
import type { Session } from "./extension";
import type { SessionStore } from "./store-surfaces";

interface AnalysisExecutionProfile {
  requestedModel: { kind: "explicit"; value: string } | { kind: "unresolved" };
  requestedEffort: { kind: "explicit"; value: EffortLevel } | { kind: "unresolved" };
  effectiveModelId?: string;
  effectiveEffort?: string;
}

interface AnalysisHistoryRead {
  readFailed: boolean;
  malformedLineCount: number;
}

function createLlmClientForSession(
  s: Session,
  profile: { effectiveModelId?: string; effectiveEffort?: string }
): LlmAnalysisClient | undefined {
  const cwd = resolveSessionCwd(s);
  if (cwd === undefined || cwd === "") return undefined;
  if (!profile.effectiveModelId || profile.effectiveModelId.trim() === "") return undefined;
  const cfg = getLaisoraConfiguration();
  return createSdkLlmAnalysisClient({
    modelId: profile.effectiveModelId,
    effort: profile.effectiveEffort,
    cwd,
    claudeCodeExecutablePath: configuredClaudeExecutablePath(cfg),
    sdkClaudeCodeVersion: sdkClaudeCodeVersion(),
    apiKeyPolicy: normalizeApiKeyPolicy(cfg.get("claude.apiKeyPolicy", "inherit")),
  });
}

export class SessionLlm {
  constructor(
    private readonly host: Session,
    private readonly store: SessionStore
  ) {}

  private async resolveAnalysisExecutionProfile(): Promise<AnalysisExecutionProfile | "model_unresolved" | null> {
    const cwd = resolveSessionCwd(this.host) ?? process.cwd();
    const modelOverrideVal = this.host.modelOverride ?? this.host.effectiveModel ?? this.host.appliedModel ?? undefined;
    const effortOverrideVal = this.host.effortOverride ?? this.host.effectiveEffort ?? this.host.appliedEffort ?? undefined;
    try {
      let modelVal = modelOverrideVal;
      const effortVal = effortOverrideVal;
      if (!modelVal) {
        const sdk = require("@anthropic-ai/claude-agent-sdk") as typeof ClaudeCodeSdk;
        if (typeof sdk.resolveSettings === "function") {
          let timeoutHandle: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("resolveSettings timeout")), 3000);
          });
          const cfg = getLaisoraConfiguration();
          try {
            const settings = await Promise.race([
              sdk.resolveSettings({
                cwd,
                settingSources: cfg.get("claude.settingSources", ["user", "project", "local"]),
              }),
              timeoutPromise,
            ]);
            if (settings.effective) {
              if (!modelVal) modelVal = settings.effective.model ?? undefined;
            }
          } catch {
          } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          }
        }
      }

      const requestedModel =
        typeof modelVal === "string" && modelVal.trim().length > 0
          ? ({ kind: "explicit", value: modelVal.trim() } as const)
          : ({ kind: "unresolved" } as const);
      if (requestedModel.kind === "unresolved") {
        output.appendLine(
          `[${this.host.title}] resolveAnalysisExecutionProfile: model を解決できませんでした（override・実測・CLI の applied・resolveSettings のいずれからも取得できない）`
        );
        return "model_unresolved";
      }
      const validEfforts: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
      const requestedEffort =
        typeof effortVal === "string" && validEfforts.includes(effortVal as EffortLevel)
          ? ({ kind: "explicit", value: effortVal as EffortLevel } as const)
          : ({ kind: "unresolved" } as const);
      return {
        requestedModel,
        requestedEffort,
        effectiveModelId: requestedModel.kind === "explicit" ? requestedModel.value : undefined,
        effectiveEffort: requestedEffort.kind === "explicit" ? requestedEffort.value : undefined,
      };
    } catch (err) {
      output.appendLine(`[${this.host.title}] resolveAnalysisExecutionProfile failed: ${String(err)}`);
      return null;
    }
  }

  private transcriptGapSummary(historyRead: AnalysisHistoryRead): TranscriptGapSummary | undefined {
    const c = this.host.workModel.coverage;
    const gaps: TranscriptGapSummary = {
      ...(c.unreadableAgentCount ? { unreadableAgentCount: c.unreadableAgentCount } : {}),
      ...(c.omittedTranscriptCount ? { omittedTranscriptCount: c.omittedTranscriptCount } : {}),
      ...(c.hierarchyIncomplete ? { hierarchyIncomplete: true as const } : {}),
      ...(historyRead.readFailed ? { historyReadFailed: true as const } : {}),
      ...(historyRead.malformedLineCount ? { historyMalformedLineCount: historyRead.malformedLineCount } : {}),
      ...(c.evidenceFoldErrorCount ? { evidenceFoldErrorCount: c.evidenceFoldErrorCount } : {}),
    };
    return Object.keys(gaps).length > 0 ? gaps : undefined;
  }

  private async collectAnalysisEvents(): Promise<{
    events: readonly LlmAnalysisInputEvent[];
    sessionHeadMissing: boolean;
    historyRead: AnalysisHistoryRead;
  }> {
    const c = this.host.workModel.coverage;
    const heldRead: AnalysisHistoryRead = {
      readFailed: c.historyReadError !== undefined,
      malformedLineCount: c.historyMalformedLineCount ?? 0,
    };
    if ((c.droppedEventCount ?? 0) === 0) {
      return { events: this.host.events, sessionHeadMissing: false, historyRead: heldRead };
    }
    const file = inspectorSessionFile(this.host);
    let failure = "セッションの記録ファイルを特定できません";
    if (file !== null) {
      try {
        const history = await readSessionHistory(file, isInSessionStore);
        const readError = history.readError ?? history.subagentsReadError;
        if (readError === undefined && history.events.length > 0) {
          return {
            events: history.events.map((h) => ({ ...h.body, timestamp: h.timestamp })),
            sessionHeadMissing: false,
            historyRead: { readFailed: false, malformedLineCount: history.malformedLineCount },
          };
        }
        failure = readError ?? "記録が空";
      } catch (error) {
        failure = String(error);
      }
    }
    output.appendLine(`[${this.host.title}] LLM分析: JSONL を読めないため、保持中のイベント列（先頭切り詰めあり）で代用します: ${failure}`);
    return { events: this.host.events, sessionHeadMissing: true, historyRead: heldRead };
  }

  private reportLlmProgress(
    run: NonNullable<Session["llmRun"]>,
    info: LlmAnalysisProgress
  ): void {
    if (this.host.llmRun !== run) return;
    const progress = {
      stage: info.stage,
      sliceIndex: info.sliceIndex,
      sliceCount: info.sliceCount,
      callIndex: info.callIndex,
      plannedCalls: info.plannedCalls,
      elapsedMs: info.elapsedMs,
    };
    run.progress = { value: progress, observedAtMs: Date.now() };
    this.store.post({
      type: "llmAnalysisRunState",
      tabId: this.host.tabId,
      running: true,
      progress,
    });
    output.appendLine(
      `[${this.host.title}] LLM analysis: call ${info.callIndex}/${info.plannedCalls}` +
        ` ${info.event === "call_started" ? "started" : "finished"}` +
        ` stage=${info.stage} slice=${info.sliceIndex}/${info.sliceCount}` +
        ` max=${info.maxCalls} elapsed=${Math.round(info.elapsedMs / 1000)}s`
    );
  }

  async requestLlmAnalysis(): Promise<void> {
    const refusal = this.llmAnalysisRefusal();
    if (refusal !== null) {
      output.appendLine(`[${this.host.title}] LLM分析を実行しませんでした: ${refusal}`);
      this.store.post({ type: "llmAnalysisRunState", tabId: this.host.tabId, running: false, refusal });
      return;
    }
    const base = this.host.semantic.semanticBasePayload();
    const l3 = base?.l3;
    if (base === undefined || l3 === undefined) {
      const failure = this.host.semantic.semanticDerivationFailure();
      const reason =
        failure === null
          ? l10n.t("LAISORA: There is no record to analyze yet.")
          : l10n.t(
              "LAISORA: {0} (This does not mean there is no record. See the LAISORA output panel for details.)",
              derivationFailureLabel(failure.stage)
            );
      output.appendLine(
        `[${this.host.title}] LLM分析を実行しませんでした: ${reason}${failure === null ? "" : ` / ${failure.detail}`}`
      );
      this.store.post({ type: "llmAnalysisRunState", tabId: this.host.tabId, running: false, refusal: reason });
      return;
    }

    const abort = new AbortController();
    const activeRun: NonNullable<Session["llmRun"]> = { base, abort };
    this.host.llmRun = activeRun;
    this.store.post({ type: "llmAnalysisRunState", tabId: this.host.tabId, running: true });

    let profile: AnalysisExecutionProfile | "model_unresolved" | null;
    try {
      profile = await this.resolveAnalysisExecutionProfile();
    } catch (error) {
      output.appendLine(`[${this.host.title}] resolveAnalysisExecutionProfile threw: ${String(error)}`);
      profile = null;
    }
    if (profile === null || profile === "model_unresolved") {
      this.host.llmRun = null;
      this.store.post({ type: "llmAnalysisRunState", tabId: this.host.tabId, running: false });
      this.host.lastAttemptFailedReason = profile === null ? "not_configured" : "model_unresolved";
      const reason = profile === null
        ? l10n.t(
          "LAISORA: Analysis was cancelled because the settings could not be resolved (model/effort inheritance cannot be guaranteed)."
        )
        : l10n.t(
          "LAISORA: Analysis was cancelled because the model of this conversation could not be determined (the analysis must run on the same model as the conversation)."
        );
      output.appendLine(`[${this.host.title}] LLM分析を実行しませんでした: ${reason}`);
      this.host.semantic.scheduleSemanticModelPost();
      return;
    }

    this.host.lastAttemptFailedReason = null;
    this.host.semantic.scheduleSemanticModelPost();
    output.appendLine(`[${this.host.title}] LLM分析を開始します（トークンを消費します）`);
    let outcome: LlmAnalysisOutcome;
    let analysisInput: ReturnType<typeof buildLlmAnalysisInput> | undefined;
    try {
      const cwd = resolveSessionCwd(this.host) ?? process.cwd();
      const contextFiles = loadContextFiles(cwd);
      const guardrailSignals = this.host.guardrail.signals.map((s) => ({
        id: s.signalId,
        kind: s.kind,
        subjectId: s.subjectId,
        firstAt: s.firstAt,
        lastAt: s.lastAt,
        count: s.count,
      }));
      let input: ReturnType<typeof buildLlmAnalysisInput> | undefined;
      try {
        const analysisEvents = await this.collectAnalysisEvents();
        input = analysisInput = buildLlmAnalysisInput({
          events: analysisEvents.events,
          model: base,
          l3,
          guardrailSignals,
          contextFiles,
          sessionHeadMissing: analysisEvents.sessionHeadMissing,
          transcriptGaps: this.transcriptGapSummary(analysisEvents.historyRead),
        });
      } catch (error) {
        output.appendLine(`[${this.host.title}] LLM分析: 入力の構築に失敗しました: ${String(error)}`);
      }

      if (input === undefined) {
        outcome = { state: "unavailable", reason: "prompt_render_error", cacheState: "not_attempted" };
      } else {
        outcome = await runLlmAnalysis({
          enabled: true,
          learningEnabled: getLaisoraConfiguration().get<boolean>("learning.enabled", false) === true,
          client: createLlmClientForSession(this.host, profile),
          cache: this.host.llmCache,
          input,
          promptVersion: LLM_ANALYSIS_PROMPT_VERSION,
          outputLanguage: llmAnalysisOutputLanguage(vscode.env?.language),
          requestedModel: profile.requestedModel,
          requestedEffort: profile.requestedEffort,
          model: asFindingVerificationModelFromPayload(base),
          analysis: l3.analysis,
          provenance: {
            semanticRevision: base.revision,
            semanticHash: base.semanticHash,
            analysisGeneratedAt: Date.now(),
          },
          signal: abort.signal,
          perCallTimeoutMs: LLM_PER_CALL_TIMEOUT_MS,
          onProgress: (info) => this.reportLlmProgress(activeRun, info),
        });
      }
    } finally {
      this.host.llmRun = null;
      this.store.post({ type: "llmAnalysisRunState", tabId: this.host.tabId, running: false });
    }

    if (this.host.closed) return;
    if (!llmAnalysisEnabled()) return;
    if (abort.signal.aborted) return;

    if (outcome.state !== "ready") {
      this.host.lastAttemptFailedReason =
        outcome.state === "unavailable" ? unavailableCode(outcome.reason) : "not_configured";
      const audience = llmDiagnosticsAudience();
      const diagnosticsPayload = projectLlmFindingDiagnostics(outcome, audience);
      if (diagnosticsPayload !== undefined) {
        this.store.post({
          type: "llmFindingDiagnostics",
          tabId: this.host.tabId,
          payload: diagnosticsPayload,
        });
      }
      const run = outcome.state === "unavailable" ? outcome.run : undefined;
      if (run?.mergeInputBudget !== undefined) {
        output.appendLine(`[${this.host.title}] LLM merge input budget: ${JSON.stringify(run.mergeInputBudget)}`);
      }
      if (outcome.state === "unavailable" && run !== undefined) {
        this.store.post({
          type: "llmAnalysisRunState",
          tabId: this.host.tabId,
          running: false,
          failure: {
            reason: outcome.reason,
            ...(run.limit === undefined ? {} : { limit: run.limit }),
            elapsedMs: run.elapsedMs,
            attemptedCalls: run.attemptedCalls,
            completedCalls: run.completedCalls,
            plannedCalls: run.plannedCalls,
          },
        });
      }
      this.host.semantic.scheduleSemanticModelPost();
      output.appendLine(
        `[${this.host.title}] LLM分析: 状態=${outcome.state}` +
          ` 要求モデル=${profile.effectiveModelId ?? "(未解決)"}` +
          ` cache=${outcome.state === "disabled" ? "n/a" : outcome.cacheState}` +
          (outcome.state === "unavailable" ? ` reason=${outcome.reason}` : "") +
          (run === undefined
            ? ""
            : ` limit=${run.limit ?? "none"} calls=${run.attemptedCalls}/${run.plannedCalls}` +
              ` done=${run.completedCalls} stage=${run.stage} slices=${run.sliceCount}` +
              ` elapsed=${Math.round(run.elapsedMs / 1000)}s`)
      );
      return;
    }

    this.host.lastAttemptFailedReason = null;
    const candidate: PersistedAnalysisArtifact = {
      artifactId: outcome.analysisRunId,
      generatedAt: outcome.result.provenance.analysisGeneratedAt,
      analyzedRevision: base.revision,
      analyzedSemanticHash: base.semanticHash,
      analysisSdk: "claude",
      requestedModel: profile.requestedModel,
      requestedEffort: profile.requestedEffort,
      executedModels: outcome.models,
      report: {
        specVersion: outcome.result.specVersion,
        rejectedCount: outcome.result.counts.rejected,
        slices: outcome.slices,
        usage: outcome.usage,
        findings: projectPersistedActionFindings(
          outcome.result.accepted,
          analysisInput?.aliases,
          analysisInput?.facts
        ),
      },
    };

    this.host.baseRefByArtifactId.set(candidate.artifactId, base);
    if (analysisInput !== undefined) {
      this.host.inputCoverageLabelByArtifactId.set(candidate.artifactId, formatInputCoverageLabel(analysisInput.stats));

    }

    this.host.persistedArtifacts = this.host.persistedArtifacts.filter((a) => a.artifactId !== candidate.artifactId);
    this.host.persistedArtifacts.push(candidate);
    this.host.persistedArtifacts.sort((a, b) => a.generatedAt - b.generatedAt || a.artifactId.localeCompare(b.artifactId));
    this.host.selectedArtifactId = candidate.artifactId;
    const tokStr = outcome.usage
      ? `${((outcome.usage.inputTokens + outcome.usage.outputTokens) / 1000).toFixed(1)}k tok`
      : "0k tok";
    const modelsStr = outcome.models ? outcome.models.join("+") : "(モデル情報なし)";
    this.host.llmResult = {
      base,
      view: {
        analysisRunId: candidate.artifactId,
      },
      generatedAt: candidate.generatedAt,
    };

    if (this.host.ownerState.kind === "pinned") {
      this.host.persistenceStateByArtifactId.set(candidate.artifactId, { state: "pending" });
      this.host.analysisStore.postPersistenceState({
        type: "analysisPersistenceState",
        tabId: this.host.tabId,
        artifactId: candidate.artifactId,
        persistence: "pending",
        persistenceLabel: formatPersistenceLabel("pending"),
      });
      void this.host.analysisStore.persistArtifact(candidate, this.host.ownerState.ownerId, this.host.logicalGeneration);
    } else if (this.host.ownerState.kind === "unresolved") {
      this.host.persistenceStateByArtifactId.set(candidate.artifactId, { state: "pending" });
      this.host.analysisStore.postPersistenceState({
        type: "analysisPersistenceState",
        tabId: this.host.tabId,
        artifactId: candidate.artifactId,
        persistence: "pending",
        persistenceLabel: formatPersistenceLabel("pending"),
      });
      this.host.pendingPersistence.push({
        artifact: candidate,
        logicalGeneration: this.host.logicalGeneration,
        seq: ++this.host.pendingSeqCounter,
      });
    } else if (this.host.ownerState.kind === "conflicted") {
      this.host.persistenceStateByArtifactId.set(candidate.artifactId, {
        state: "failed",
        reason: "conflicted",
      });
      this.host.analysisStore.postPersistenceState({
        type: "analysisPersistenceState",
        tabId: this.host.tabId,
        artifactId: candidate.artifactId,
        persistence: "failed",
        persistenceLabel: formatPersistenceLabel("failed", "conflicted"),
      });
    }

    this.host.semantic.scheduleSemanticModelPost();
    const audience = llmDiagnosticsAudience();
    const diagnosticsPayload = projectLlmFindingDiagnostics(outcome, audience);
    if (diagnosticsPayload !== undefined) {
      this.store.post({
        type: "llmFindingDiagnostics",
        tabId: this.host.tabId,
        payload: diagnosticsPayload,
      });
    }
    output.appendLine(
      `[${this.host.title}] LLM分析: 完了: 所見 ${outcome.result.accepted.length} 件 / 棄却 ${outcome.result.counts.rejected} 件 / ${modelsStr} / ${tokStr} / スライス ${outcome.slices}`
    );
  }

  private llmAnalysisRefusal(): string | null {
    if (!semanticViewEnabled()) return l10n.t("LAISORA: The semantic model is disabled (setting laisora.workLog.semanticView).");
    if (!llmAnalysisEnabled()) return l10n.t("LAISORA: LLM analysis is disabled (setting laisora.workLog.llmAnalysis).");
    if (this.host.starting !== null || (this.host.conversation !== null && !this.host.conversation.isClosed && this.host.conversation.state !== "idle")) {
      return l10n.t("LAISORA: LLM analysis cannot start while a turn is running (wait for it to finish and try again).");
    }
    if (this.host.llmRun !== null) return l10n.t("LAISORA: LLM analysis is already running in this tab.");
    if (this.store.llmAnalysisInFlightCount() > 0) return l10n.t("LAISORA: LLM analysis is running in another tab.");
    return null;
  }
}
