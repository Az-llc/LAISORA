import {
  type PersistedAnalysisArtifact,
  type PersistenceState,
  formatGeneratedAtLabel,
  formatPersistenceLabel,
  loadArtifacts,
  saveArtifact,
} from "./analysis-persistence";
import * as l10n from "@vscode/l10n";
import { actionDestinationLabel } from "./llm-action-policy";
import { output } from "./host-context";
import type {
  AttachedAnalysisView,
  AttachedEvidenceChip,
  AttachedFindingView,
  FindingAction,
  HistoryOption,
  HostToWebview,
  SemanticModelPayload,
} from "./protocol";
import type { Session } from "./extension";
import type { SessionStore } from "./store-surfaces";

export function artifactModelLabels(
  art: PersistedAnalysisArtifact
): { requestedModel: string; requestedEffort: string; executedModels: string } {
  return {
    requestedModel: art.requestedModel.kind === "explicit" ? art.requestedModel.value : l10n.t("Default"),
    requestedEffort: art.requestedEffort.kind === "explicit" ? art.requestedEffort.value : l10n.t("Default"),
    executedModels:
      art.executedModels === null
        ? l10n.t("Not observable")
        : art.executedModels.length > 0
        ? art.executedModels.join("+")
        : l10n.t("none"),
  };
}

// 保存の状態フィールド（persistedArtifacts / baseRefByArtifactId / ownerState 等）は Session に残す。
// ここは関数だけを持ち、状態は host 経由で読む
export class SessionAnalysisStore {
  constructor(
    private readonly host: Session,
    private readonly store: SessionStore
  ) {}

  // hydration 中は永続化処理と内部状態更新を続けたまま UI post だけを
  // artifact ごとの最終状態へ畳む。Phase 3 / 失敗確定の後に一度だけ流す
  postPersistenceState(
    msg: Extract<HostToWebview, { type: "analysisPersistenceState" }>
  ): void {
    if (this.host.resuming && this.host.hydration !== null) {
      this.host.hydration.persistencePosts.set(msg.artifactId, msg);
      return;
    }
    this.store.post(msg);
  }


  resolveOwnerFromAuthStatus(sessionId: string, generation: number): void {
    if (generation !== this.host.logicalGeneration) return;
    if (this.host.ownerState.kind === "unresolved") {
      this.host.ownerState = {
        kind: "pinned",
        ownerId: sessionId,
        logicalGeneration: this.host.logicalGeneration,
        source: "auth",
      };
      this.loadPersistedArtifactsFromStore();
      this.flushPendingPersistence();
    } else if (this.host.ownerState.kind === "pinned") {
      if (this.host.ownerState.ownerId !== sessionId) {
        output.appendLine(
          `[${this.host.title}] [analysis-store] owner 不一致のため保存を停止した（pinned=${this.host.ownerState.ownerId} 受信=${sessionId}）`
        );
        this.host.ownerState = {
          kind: "conflicted",
          ownerId: this.host.ownerState.ownerId,
          logicalGeneration: this.host.logicalGeneration,
          reason: "owner mismatch",
        };
        for (const item of this.host.pendingPersistence) {
          this.host.persistenceStateByArtifactId.set(item.artifact.artifactId, {
            state: "failed",
            reason: "conflicted",
          });
          this.postPersistenceState({
            type: "analysisPersistenceState",
            tabId: this.host.tabId,
            artifactId: item.artifact.artifactId,
            persistence: "failed",
            persistenceLabel: l10n.t("This analysis will not be saved — the session identity could not be verified"),
          });
        }
        this.host.pendingPersistence = [];
      }
    }
  }

  loadPersistedArtifactsFromStore(): void {
    if (this.host.ownerState.kind !== "pinned") return;
    const ownerId = this.host.ownerState.ownerId;
    const loaded = loadArtifacts(this.store.analysisStorage, ownerId, (line) => output.appendLine(line));
    for (const art of loaded) {
      if (!this.host.persistedArtifacts.some((a) => a.artifactId === art.artifactId)) {
        this.host.persistedArtifacts.push(art);
        this.host.persistenceStateByArtifactId.set(art.artifactId, { state: "saved" });
      }
    }
    this.host.persistedArtifacts.sort((a, b) => a.generatedAt - b.generatedAt || a.artifactId.localeCompare(b.artifactId));
    if (this.host.selectedArtifactId === null && this.host.persistedArtifacts.length > 0) {
      this.host.selectedArtifactId = this.host.persistedArtifacts[this.host.persistedArtifacts.length - 1].artifactId;
    }
    this.host.semantic.scheduleSemanticModelPost();
  }

  flushPendingPersistence(): void {
    if (this.host.ownerState.kind !== "pinned") return;
    const ownerId = this.host.ownerState.ownerId;
    const logicalGeneration = this.host.logicalGeneration;
    const pending = [...this.host.pendingPersistence];
    this.host.pendingPersistence = [];
    for (const item of pending) {
      if (item.logicalGeneration === logicalGeneration) {
        void this.persistArtifact(item.artifact, ownerId, logicalGeneration);
      }
    }
  }

  async persistArtifact(
    candidate: PersistedAnalysisArtifact,
    ownerId: string,
    logicalGeneration: number
  ): Promise<void> {
    try {
      if (
        this.host.closed ||
        this.store.sessions.get(this.host.tabId) !== this.host ||
        this.host.logicalGeneration !== logicalGeneration ||
        this.host.ownerState.kind !== "pinned" ||
        this.host.ownerState.ownerId !== ownerId
      ) {
        output.appendLine(
          `[${this.host.title}] [analysis-store] persistArtifact dropped before write: state mismatch or session closed`
        );
        return;
      }

      const result = await saveArtifact(
        this.store.analysisStorage,
        candidate,
        ownerId,
        (line) => output.appendLine(line)
      );

      if (
        this.host.closed ||
        this.store.sessions.get(this.host.tabId) !== this.host ||
        this.host.logicalGeneration !== logicalGeneration ||
        this.host.ownerState.kind !== "pinned" ||
        this.host.ownerState.ownerId !== ownerId
      ) {
        output.appendLine(
          `[${this.host.title}] [analysis-store] persistArtifact finished but owner changed; suppressing saved notification to UI`
        );
        return;
      }

      if (result.kind === "saved") {
        this.host.persistenceStateByArtifactId.set(candidate.artifactId, { state: "saved" });
        this.postPersistenceState({
          type: "analysisPersistenceState",
          tabId: this.host.tabId,
          artifactId: candidate.artifactId,
          persistence: "saved",
          persistenceLabel: l10n.t("Saved"),
        });
      } else if (result.kind === "rejected") {
        this.host.persistenceStateByArtifactId.set(candidate.artifactId, {
          state: "rejected",
          reason: result.reason,
        });
        this.postPersistenceState({
          type: "analysisPersistenceState",
          tabId: this.host.tabId,
          artifactId: candidate.artifactId,
          persistence: "rejected",
          persistenceLabel: formatPersistenceLabel("rejected", result.reason),
        });
      } else {
        this.host.persistenceStateByArtifactId.set(candidate.artifactId, {
          state: "failed",
          reason: result.reason,
        });
        this.postPersistenceState({
          type: "analysisPersistenceState",
          tabId: this.host.tabId,
          artifactId: candidate.artifactId,
          persistence: "failed",
          persistenceLabel: formatPersistenceLabel("failed", result.reason),
        });
      }
    } catch (error) {
      this.host.persistenceStateByArtifactId.set(candidate.artifactId, {
        state: "failed",
        reason: "update_error",
      });
      this.postPersistenceState({
        type: "analysisPersistenceState",
        tabId: this.host.tabId,
        artifactId: candidate.artifactId,
        persistence: "failed",
        persistenceLabel: formatPersistenceLabel("failed", "update_error"),
      });
      output.appendLine(`[${this.host.title}] [analysis-store] persistArtifact exception: ${String(error)}`);
    }
    this.host.semantic.scheduleSemanticModelPost();
  }

  buildAttachedAnalysisView(base: SemanticModelPayload): AttachedAnalysisView | undefined {
    if (this.host.persistedArtifacts.length === 0) return undefined;
    const selectedArt =
      (this.host.selectedArtifactId ? this.host.persistedArtifacts.find((a) => a.artifactId === this.host.selectedArtifactId) : undefined) ??
      this.host.persistedArtifacts[this.host.persistedArtifacts.length - 1];
    if (!selectedArt) return undefined;

    let freshness: "current" | "stale" | "restored-unverifiable";
    let freshnessLabel: string;
    if (this.host.baseRefByArtifactId.get(selectedArt.artifactId) === base) {
      freshness = "current";
      freshnessLabel = l10n.t("Analysis of the current record");
    } else if (this.host.baseRefByArtifactId.has(selectedArt.artifactId)) {
      freshness = "stale";
      freshnessLabel = l10n.t("The record was updated after the analysis (analyzed at revision {0})", selectedArt.analyzedRevision);
    } else {
      freshness = "restored-unverifiable";
      freshnessLabel = l10n.t("Analysis from before the restart (currency cannot be verified)");
    }

    const generatedAtLabel = formatGeneratedAtLabel(selectedArt.generatedAt);
    const { requestedModel: reqModel, requestedEffort: reqEffort, executedModels: modelsLabel } = artifactModelLabels(selectedArt);
    const requestedModelLabel = l10n.t("Requested: {0} / effort: {1}", reqModel, reqEffort);

    let executedModelsLabel: string;
    if (selectedArt.executedModels === null) {
      executedModelsLabel = l10n.t("Executed: not observable");
    } else if (selectedArt.executedModels.length === 0) {
      executedModelsLabel = l10n.t("Executed: none");
    } else {
      executedModelsLabel = l10n.t("Executed: {0}", selectedArt.executedModels.join(", "));
    }

    const persistenceInfo = this.host.persistenceStateByArtifactId.get(selectedArt.artifactId);
    const persistence: PersistenceState = persistenceInfo?.state ?? "saved";
    const persistenceLabel = formatPersistenceLabel(persistence, persistenceInfo?.reason);

    const findingsCount = selectedArt.report.findings.length;
    const rejectedCount = selectedArt.report.rejectedCount;
    const slicesCount = selectedArt.report.slices;
    // usage の無い結果を 0 tok と書かない（R-DSP-11）
    const tokLabel = selectedArt.report.usage
      ? `${((selectedArt.report.usage.inputTokens + selectedArt.report.usage.outputTokens) / 1000).toFixed(1)}k tok`
      : null;

    const summaryLabel = l10n.t("Completed: {0} findings / {1} rejected / {2} / {3} / {4} slices", findingsCount, rejectedCount, modelsLabel, tokLabel ?? l10n.t("Tokens not observed"), slicesCount);
    const emptyStateLabel = findingsCount === 0 ? l10n.t("0 verified findings") : undefined;
    const inputCoverageLabel = this.host.inputCoverageLabelByArtifactId.get(selectedArt.artifactId);

    const sortedForHistory = [...this.host.persistedArtifacts].sort((a, b) => {
      if (a.generatedAt !== b.generatedAt) {
        return b.generatedAt - a.generatedAt;
      }
      return b.artifactId.localeCompare(a.artifactId);
    });

    const historyOptions: HistoryOption[] = sortedForHistory.map((a) => {
      let shortFreshness: string;
      if (this.host.baseRefByArtifactId.get(a.artifactId) === base) {
        shortFreshness = l10n.t("Current");
      } else if (this.host.baseRefByArtifactId.has(a.artifactId)) {
        shortFreshness = l10n.t("Updated since");
      } else {
        shortFreshness = l10n.t("Restored");
      }
      const genLabel = formatGeneratedAtLabel(a.generatedAt);
      return {
        artifactId: a.artifactId,
        label: l10n.t("{0} / {1} findings / {2}", genLabel, a.report.findings.length, shortFreshness),
        generatedAtLabel: genLabel,
        freshnessLabel: shortFreshness,
        findingsCount: a.report.findings.length,
        ...artifactModelLabels(a),
      };
    });

    const isCurrent = freshness === "current";
    const currentToolUseIds = new Set<string>();
    for (const ev of this.host.events) {
      if (ev.kind === "tool_call_started" || ev.kind === "tool_call_finished") {
        if ("toolUseId" in ev && typeof ev.toolUseId === "string") {
          currentToolUseIds.add(ev.toolUseId);
        }
      }
    }

    const findings: AttachedFindingView[] = selectedArt.report.findings.map((f, index) => {
      let action: FindingAction;
      if (isCurrent) {
        action = { kind: "startCurrentFinding", label: l10n.t("Start working on this fix") };
      } else {
        action = { kind: "prepareHistoricalDraft", label: l10n.t("Create a draft from the past analysis") };
      }

      const evidence: AttachedEvidenceChip[] = f.evidence.map((e) => {
        let navigateToolUseId: string | undefined = undefined;
        if (isCurrent && e.kind === "event" && e.toolUseId && currentToolUseIds.has(e.toolUseId)) {
          navigateToolUseId = e.toolUseId;
        }
        return {
          alias: e.alias,
          kind: e.kind,
          label: e.label,
          ...(navigateToolUseId ? { navigateToolUseId } : {}),
        };
      });

      return {
        findingId: f.findingId,
        numberLabel: f.numberLabel,
        numberDigits: String(index + 1).padStart(2, "0"),
        title: f.title,
        observed: f.observed,
        impactLabel: f.impactLabel,
        destinationLabel: actionDestinationLabel(f.destination, selectedArt.analysisSdk),
        actionKindLabel: f.actionKindLabel,
        actionLine: f.actionLine,
        steps: [...f.steps],
        target: f.target,
        confidence: f.confidence,
        action,
        evidence,
      };
    });

    return {
      artifactId: selectedArt.artifactId,
      freshness,
      freshnessLabel,
      generatedAtLabel,
      requestedModelLabel,
      executedModelsLabel,
      persistence,
      persistenceLabel,
      summaryLabel,
      findingsCount,
      rejectedCount,
      modelsLabel,
      tokensLabel: tokLabel,
      slicesCount,
      emptyStateLabel,
      ...(inputCoverageLabel !== undefined ? { inputCoverageLabel } : {}),
      historyOptions,
      selectedArtifactId: selectedArt.artifactId,
      findings,
    };
  }
}
